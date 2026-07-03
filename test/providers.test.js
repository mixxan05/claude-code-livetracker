'use strict';

/**
 * test/providers.test.js — Tests für die Provider-Schicht (src/providers.js).
 *
 * Abgedeckt:
 *   - detectProvider: Pfad-Erkennung (Anthropic/OpenAI) + Header-Rückfall + null-Fall.
 *   - resolveUpstream: Default- und Custom-Upstreams, Port-Defaults, Protokoll ohne Doppelpunkt.
 *   - maybeInjectIncludeUsage: Flag-Injektion bei stream:true; Non-Stream/Nicht-JSON/anderer
 *     Provider/Flag-aus bleiben BYTE-IDENTISCH; vorhandene stream_options bleiben erhalten.
 *   - createUsageExtractor: Anthropic-SSE (mit/ohne cache_creation-Objekt, auch an
 *     Zeilen- und Byte-Grenzen zerteilt), OpenAI-Streaming mit include_usage,
 *     Non-Streaming-JSON beider Provider, Responses-API-Form, "keine usage" → null.
 *
 * Ausschließlich Node-stdlib (node:test + node:assert), keine Test-Dependencies.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  detectProvider,
  resolveUpstream,
  maybeInjectIncludeUsage,
  createUsageExtractor,
} = require('../src/providers');

// Standard-Config wie in config.json.
const CONFIG = {
  port: 9000,
  dailyLimitUSD: 25.0,
  injectOpenAIUsage: true,
  upstreams: {
    anthropic: 'https://api.anthropic.com',
    openai: 'https://api.openai.com',
  },
};

/**
 * Füttert einen Extraktor mit einem Buffer, zerteilt in Chunks fester Größe,
 * und liefert das finalize()-Ergebnis. Dient zum Testen von Chunk-Grenzen.
 * @param {{feed: Function, finalize: Function}} extractor
 * @param {Buffer} buf
 * @param {number} size  Chunk-Größe in Bytes.
 */
function feedInChunks(extractor, buf, size) {
  for (let i = 0; i < buf.length; i += size) {
    extractor.feed(buf.subarray(i, Math.min(i + size, buf.length)));
  }
  return extractor.finalize();
}

// ==============================================================================
// detectProvider
// ==============================================================================

describe('detectProvider', () => {
  test('Pfad /v1/messages → anthropic (auch ohne Header)', () => {
    assert.equal(detectProvider('/v1/messages', {}), 'anthropic');
    assert.equal(detectProvider('/v1/messages?beta=true', {}), 'anthropic');
  });

  test('Pfad /v1/chat/completions → openai', () => {
    assert.equal(detectProvider('/v1/chat/completions', {}), 'openai');
  });

  test('Pfad /v1/responses → openai', () => {
    assert.equal(detectProvider('/v1/responses', {}), 'openai');
  });

  test('Pfad hat Vorrang vor Header (messages + Bearer bleibt anthropic)', () => {
    assert.equal(
      detectProvider('/v1/messages', { authorization: 'Bearer sk-openai' }),
      'anthropic',
    );
  });

  test('Header-Rückfall: x-api-key → anthropic', () => {
    assert.equal(detectProvider('/unbekannt', { 'x-api-key': 'sk-ant-123' }), 'anthropic');
  });

  test('Header-Rückfall: Authorization Bearer → openai', () => {
    assert.equal(
      detectProvider('/irgendwas', { authorization: 'Bearer sk-proj-abc' }),
      'openai',
    );
  });

  test('Header-Rückfall ist case-insensitiv bei Schlüssel und Bearer-Schema', () => {
    assert.equal(detectProvider('/x', { 'X-Api-Key': 'k' }), 'anthropic');
    assert.equal(detectProvider('/x', { Authorization: 'bearer TOKEN' }), 'openai');
  });

  test('x-api-key gewinnt gegen gleichzeitig vorhandenen Bearer-Header', () => {
    assert.equal(
      detectProvider('/x', { 'x-api-key': 'k', authorization: 'Bearer t' }),
      'anthropic',
    );
  });

  test('kein Signal → null', () => {
    assert.equal(detectProvider('/health', {}), null);
    assert.equal(detectProvider('/health', { authorization: 'Basic abc' }), null);
    assert.equal(detectProvider(undefined, undefined), null);
  });
});

// ==============================================================================
// resolveUpstream
// ==============================================================================

describe('resolveUpstream', () => {
  test('anthropic-Default → https/api.anthropic.com/443', () => {
    assert.deepEqual(resolveUpstream('anthropic', CONFIG), {
      protocol: 'https',
      host: 'api.anthropic.com',
      port: 443,
    });
  });

  test('openai-Default → https/api.openai.com/443', () => {
    assert.deepEqual(resolveUpstream('openai', CONFIG), {
      protocol: 'https',
      host: 'api.openai.com',
      port: 443,
    });
  });

  test('protocol wird OHNE Doppelpunkt geliefert', () => {
    assert.equal(resolveUpstream('anthropic', CONFIG).protocol, 'https');
  });

  test('Custom-Upstream mit explizitem Port und http', () => {
    const cfg = { upstreams: { openai: 'http://localhost:8080' } };
    assert.deepEqual(resolveUpstream('openai', cfg), {
      protocol: 'http',
      host: 'localhost',
      port: 8080,
    });
  });

  test('http ohne Port → Port 80', () => {
    const cfg = { upstreams: { anthropic: 'http://proxy.intern' } };
    assert.deepEqual(resolveUpstream('anthropic', cfg), {
      protocol: 'http',
      host: 'proxy.intern',
      port: 80,
    });
  });

  test('fehlende/leere Config → eingebauter Default', () => {
    assert.deepEqual(resolveUpstream('anthropic', {}), {
      protocol: 'https',
      host: 'api.anthropic.com',
      port: 443,
    });
    assert.deepEqual(resolveUpstream('openai', undefined), {
      protocol: 'https',
      host: 'api.openai.com',
      port: 443,
    });
  });

  test('unbrauchbare Custom-URL → Fallback auf Default', () => {
    const cfg = { upstreams: { openai: 'kein-gueltiger-url-string' } };
    assert.deepEqual(resolveUpstream('openai', cfg), {
      protocol: 'https',
      host: 'api.openai.com',
      port: 443,
    });
  });

  test('unbekannter Provider → null', () => {
    assert.equal(resolveUpstream(null, CONFIG), null);
    assert.equal(resolveUpstream('gemini', CONFIG), null);
  });
});

// ==============================================================================
// maybeInjectIncludeUsage
// ==============================================================================

describe('maybeInjectIncludeUsage', () => {
  test('OpenAI + stream:true + Flag an → include_usage gesetzt, stream bleibt', () => {
    const body = Buffer.from(JSON.stringify({ model: 'gpt-4o', stream: true }), 'utf8');
    const out = maybeInjectIncludeUsage('openai', body, CONFIG);
    const parsed = JSON.parse(out.toString('utf8'));
    assert.equal(parsed.stream, true);
    assert.equal(parsed.stream_options.include_usage, true);
    assert.equal(parsed.model, 'gpt-4o');
  });

  test('vorhandene stream_options-Felder bleiben erhalten', () => {
    const body = Buffer.from(
      JSON.stringify({ stream: true, stream_options: { chunk_size: 5 } }),
      'utf8',
    );
    const out = maybeInjectIncludeUsage('openai', body, CONFIG);
    const parsed = JSON.parse(out.toString('utf8'));
    assert.equal(parsed.stream_options.chunk_size, 5);
    assert.equal(parsed.stream_options.include_usage, true);
  });

  test('bereits gesetztes include_usage → Buffer unverändert (identische Referenz)', () => {
    const body = Buffer.from(
      JSON.stringify({ stream: true, stream_options: { include_usage: true } }),
      'utf8',
    );
    const out = maybeInjectIncludeUsage('openai', body, CONFIG);
    assert.equal(out, body); // gleiche Referenz → nicht neu serialisiert
  });

  test('stream:false → unverändert (identische Referenz)', () => {
    const body = Buffer.from(JSON.stringify({ model: 'gpt-4o', stream: false }), 'utf8');
    const out = maybeInjectIncludeUsage('openai', body, CONFIG);
    assert.equal(out, body);
  });

  test('kein stream-Feld → unverändert', () => {
    const body = Buffer.from(JSON.stringify({ model: 'gpt-4o' }), 'utf8');
    assert.equal(maybeInjectIncludeUsage('openai', body, CONFIG), body);
  });

  test('Nicht-JSON-Body → unverändert (identische Referenz)', () => {
    const body = Buffer.from('das ist kein json', 'utf8');
    assert.equal(maybeInjectIncludeUsage('openai', body, CONFIG), body);
  });

  test('provider !== openai → unverändert', () => {
    const body = Buffer.from(JSON.stringify({ stream: true }), 'utf8');
    assert.equal(maybeInjectIncludeUsage('anthropic', body, CONFIG), body);
    assert.equal(maybeInjectIncludeUsage(null, body, CONFIG), body);
  });

  test('injectOpenAIUsage aus → unverändert', () => {
    const body = Buffer.from(JSON.stringify({ stream: true }), 'utf8');
    const cfg = { injectOpenAIUsage: false };
    assert.equal(maybeInjectIncludeUsage('openai', body, cfg), body);
  });

  test('leerer Body → unverändert', () => {
    const body = Buffer.alloc(0);
    assert.equal(maybeInjectIncludeUsage('openai', body, CONFIG), body);
  });

  test('JSON-Array (kein Objekt) → unverändert', () => {
    const body = Buffer.from(JSON.stringify([1, 2, 3]), 'utf8');
    assert.equal(maybeInjectIncludeUsage('openai', body, CONFIG), body);
  });

  test('Content-Length wächst nachvollziehbar (Aufrufer kann neu berechnen)', () => {
    const body = Buffer.from(JSON.stringify({ stream: true }), 'utf8');
    const out = maybeInjectIncludeUsage('openai', body, CONFIG);
    assert.ok(out.length > body.length);
    // Der neue Buffer ist gültiges JSON mit dem Flag.
    assert.equal(JSON.parse(out.toString('utf8')).stream_options.include_usage, true);
  });
});

// ==============================================================================
// createUsageExtractor — Anthropic Streaming (SSE)
// ==============================================================================

// Aufgezeichnetes Anthropic-SSE MIT cache_creation-Objekt (5m/1h getrennt).
const ANTHROPIC_SSE_SPLIT_CACHE =
  'event: message_start\n' +
  'data: {"type":"message_start","message":{"id":"msg_01","type":"message","role":"assistant",' +
  '"model":"claude-opus-4-8","usage":{"input_tokens":1200,"cache_creation_input_tokens":300,' +
  '"cache_read_input_tokens":4500,"cache_creation":{"ephemeral_5m_input_tokens":200,' +
  '"ephemeral_1h_input_tokens":100},"output_tokens":2}}}\n' +
  '\n' +
  'event: content_block_start\n' +
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n' +
  '\n' +
  'event: content_block_delta\n' +
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Grüße"}}\n' +
  '\n' +
  'event: message_delta\n' +
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":350}}\n' +
  '\n' +
  'event: message_stop\n' +
  'data: {"type":"message_stop"}\n' +
  '\n';

const ANTHROPIC_SSE_SPLIT_CACHE_EXPECTED = {
  model: 'claude-opus-4-8',
  inputTokens: 1200,
  outputTokens: 350,
  cacheCreation5mTokens: 200,
  cacheCreation1hTokens: 100,
  cacheReadTokens: 4500,
};

// Aufgezeichnetes Anthropic-SSE OHNE cache_creation-Objekt → alles als 5m.
const ANTHROPIC_SSE_FLAT_CACHE =
  'event: message_start\n' +
  'data: {"type":"message_start","message":{"id":"msg_02","model":"claude-sonnet-5",' +
  '"usage":{"input_tokens":800,"cache_creation_input_tokens":500,"cache_read_input_tokens":0,' +
  '"output_tokens":1}}}\n' +
  '\n' +
  'event: message_delta\n' +
  'data: {"type":"message_delta","usage":{"output_tokens":120}}\n' +
  '\n';

const ANTHROPIC_SSE_FLAT_CACHE_EXPECTED = {
  model: 'claude-sonnet-5',
  inputTokens: 800,
  outputTokens: 120,
  cacheCreation5mTokens: 500,
  cacheCreation1hTokens: 0,
  cacheReadTokens: 0,
};

describe('createUsageExtractor — Anthropic Streaming', () => {
  test('cache_creation-Objekt → 5m/1h getrennt (ein Chunk)', () => {
    const ex = createUsageExtractor('anthropic', true);
    ex.feed(Buffer.from(ANTHROPIC_SSE_SPLIT_CACHE, 'utf8'));
    assert.deepEqual(ex.finalize(), ANTHROPIC_SSE_SPLIT_CACHE_EXPECTED);
  });

  test('ohne cache_creation-Objekt → cache_creation_input_tokens komplett als 5m', () => {
    const ex = createUsageExtractor('anthropic', true);
    ex.feed(Buffer.from(ANTHROPIC_SSE_FLAT_CACHE, 'utf8'));
    assert.deepEqual(ex.finalize(), ANTHROPIC_SSE_FLAT_CACHE_EXPECTED);
  });

  test('an Zeilengrenzen zerteilt (chunkweise pro Zeile) → identisches Ergebnis', () => {
    const ex = createUsageExtractor('anthropic', true);
    for (const line of ANTHROPIC_SSE_SPLIT_CACHE.split('\n')) {
      // Zeile + Zeilenumbruch einzeln einspeisen, dabei den Umbruch wieder anhängen.
      ex.feed(Buffer.from(line + '\n', 'utf8'));
    }
    assert.deepEqual(ex.finalize(), ANTHROPIC_SSE_SPLIT_CACHE_EXPECTED);
  });

  test('byteweise zerteilt (1-Byte-Chunks, mit Umlaut im Content) → identisches Ergebnis', () => {
    const buf = Buffer.from(ANTHROPIC_SSE_SPLIT_CACHE, 'utf8');
    const ex = createUsageExtractor('anthropic', true);
    const result = feedInChunks(ex, buf, 1);
    assert.deepEqual(result, ANTHROPIC_SSE_SPLIT_CACHE_EXPECTED);
  });

  test('in 7-Byte-Chunks zerteilt → identisches Ergebnis', () => {
    const buf = Buffer.from(ANTHROPIC_SSE_FLAT_CACHE, 'utf8');
    const ex = createUsageExtractor('anthropic', true);
    assert.deepEqual(feedInChunks(ex, buf, 7), ANTHROPIC_SSE_FLAT_CACHE_EXPECTED);
  });

  test('CRLF-Zeilenenden werden korrekt behandelt', () => {
    const crlf = ANTHROPIC_SSE_FLAT_CACHE.replace(/\n/g, '\r\n');
    const ex = createUsageExtractor('anthropic', true);
    ex.feed(Buffer.from(crlf, 'utf8'));
    assert.deepEqual(ex.finalize(), ANTHROPIC_SSE_FLAT_CACHE_EXPECTED);
  });

  test('Chunk-Grenze mitten im JSON eines data:-Feldes → identisches Ergebnis', () => {
    const buf = Buffer.from(ANTHROPIC_SSE_SPLIT_CACHE, 'utf8');
    // Grenze bewusst mitten in die erste (lange) data:-Zeile legen.
    const cut = 60;
    const ex = createUsageExtractor('anthropic', true);
    ex.feed(buf.subarray(0, cut));
    ex.feed(buf.subarray(cut));
    assert.deepEqual(ex.finalize(), ANTHROPIC_SSE_SPLIT_CACHE_EXPECTED);
  });
});

// ==============================================================================
// createUsageExtractor — OpenAI Streaming (SSE, include_usage)
// ==============================================================================

const OPENAI_SSE =
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"gpt-4o",' +
  '"choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}],"usage":null}\n' +
  '\n' +
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"gpt-4o",' +
  '"choices":[{"index":0,"delta":{"content":"Hallo"},"finish_reason":null}],"usage":null}\n' +
  '\n' +
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"gpt-4o",' +
  '"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":null}\n' +
  '\n' +
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"gpt-4o",' +
  '"choices":[],"usage":{"prompt_tokens":1500,"completion_tokens":200,"total_tokens":1700,' +
  '"prompt_tokens_details":{"cached_tokens":1000}}}\n' +
  '\n' +
  'data: [DONE]\n' +
  '\n';

const OPENAI_SSE_EXPECTED = {
  model: 'gpt-4o',
  inputTokens: 500, // prompt_tokens(1500) − cached(1000)
  outputTokens: 200,
  cacheCreation5mTokens: 0,
  cacheCreation1hTokens: 0,
  cacheReadTokens: 1000,
};

describe('createUsageExtractor — OpenAI Streaming', () => {
  test('include_usage im letzten Chunk → korrekte NormalizedUsage', () => {
    const ex = createUsageExtractor('openai', true);
    ex.feed(Buffer.from(OPENAI_SSE, 'utf8'));
    assert.deepEqual(ex.finalize(), OPENAI_SSE_EXPECTED);
  });

  test('byteweise zerteilt → identisches Ergebnis', () => {
    const buf = Buffer.from(OPENAI_SSE, 'utf8');
    const ex = createUsageExtractor('openai', true);
    assert.deepEqual(feedInChunks(ex, buf, 1), OPENAI_SSE_EXPECTED);
  });

  test('in 13-Byte-Chunks zerteilt → identisches Ergebnis', () => {
    const buf = Buffer.from(OPENAI_SSE, 'utf8');
    const ex = createUsageExtractor('openai', true);
    assert.deepEqual(feedInChunks(ex, buf, 13), OPENAI_SSE_EXPECTED);
  });

  test('ohne cached_tokens → inputTokens = prompt_tokens', () => {
    const sse =
      'data: {"model":"gpt-4o-mini","choices":[],"usage":{"prompt_tokens":300,' +
      '"completion_tokens":80}}\n\ndata: [DONE]\n\n';
    const ex = createUsageExtractor('openai', true);
    ex.feed(Buffer.from(sse, 'utf8'));
    assert.deepEqual(ex.finalize(), {
      model: 'gpt-4o-mini',
      inputTokens: 300,
      outputTokens: 80,
      cacheCreation5mTokens: 0,
      cacheCreation1hTokens: 0,
      cacheReadTokens: 0,
    });
  });

  test('Responses-API-Streaming: usage unter response.usage im response.completed-Event', () => {
    const sse =
      'event: response.created\n' +
      'data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5"}}\n' +
      '\n' +
      'event: response.completed\n' +
      'data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5",' +
      '"usage":{"input_tokens":400,"output_tokens":120,"input_tokens_details":{"cached_tokens":100}}}}\n' +
      '\n';
    const ex = createUsageExtractor('openai', true);
    ex.feed(Buffer.from(sse, 'utf8'));
    assert.deepEqual(ex.finalize(), {
      model: 'gpt-5',
      inputTokens: 300, // input_tokens(400) − cached(100)
      outputTokens: 120,
      cacheCreation5mTokens: 0,
      cacheCreation1hTokens: 0,
      cacheReadTokens: 100,
    });
  });
});

// ==============================================================================
// createUsageExtractor — Non-Streaming (JSON)
// ==============================================================================

describe('createUsageExtractor — Non-Streaming JSON', () => {
  test('Anthropic JSON: .usage inkl. cache-Aufschlüsselung fehlt → als 5m', () => {
    const json = JSON.stringify({
      id: 'msg_2',
      type: 'message',
      model: 'claude-sonnet-5',
      usage: {
        input_tokens: 600,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 200,
        output_tokens: 90,
      },
    });
    const ex = createUsageExtractor('anthropic', false);
    ex.feed(Buffer.from(json, 'utf8'));
    assert.deepEqual(ex.finalize(), {
      model: 'claude-sonnet-5',
      inputTokens: 600,
      outputTokens: 90,
      cacheCreation5mTokens: 100,
      cacheCreation1hTokens: 0,
      cacheReadTokens: 200,
    });
  });

  test('Anthropic JSON: cache_creation-Objekt → 5m/1h getrennt', () => {
    const json = JSON.stringify({
      model: 'claude-opus-4-8',
      usage: {
        input_tokens: 1000,
        cache_read_input_tokens: 50,
        cache_creation: { ephemeral_5m_input_tokens: 30, ephemeral_1h_input_tokens: 70 },
        output_tokens: 42,
      },
    });
    const ex = createUsageExtractor('anthropic', false);
    ex.feed(Buffer.from(json, 'utf8'));
    assert.deepEqual(ex.finalize(), {
      model: 'claude-opus-4-8',
      inputTokens: 1000,
      outputTokens: 42,
      cacheCreation5mTokens: 30,
      cacheCreation1hTokens: 70,
      cacheReadTokens: 50,
    });
  });

  test('OpenAI JSON (chat.completions): prompt−cached → input', () => {
    const json = JSON.stringify({
      id: 'chatcmpl-2',
      object: 'chat.completion',
      model: 'gpt-4o-mini',
      usage: {
        prompt_tokens: 300,
        completion_tokens: 80,
        prompt_tokens_details: { cached_tokens: 50 },
      },
    });
    const ex = createUsageExtractor('openai', false);
    ex.feed(Buffer.from(json, 'utf8'));
    assert.deepEqual(ex.finalize(), {
      model: 'gpt-4o-mini',
      inputTokens: 250,
      outputTokens: 80,
      cacheCreation5mTokens: 0,
      cacheCreation1hTokens: 0,
      cacheReadTokens: 50,
    });
  });

  test('OpenAI JSON (Responses-API-Form): input−cached → input', () => {
    const json = JSON.stringify({
      id: 'resp_1',
      object: 'response',
      model: 'gpt-5',
      usage: {
        input_tokens: 400,
        output_tokens: 120,
        input_tokens_details: { cached_tokens: 100 },
      },
    });
    const ex = createUsageExtractor('openai', false);
    ex.feed(Buffer.from(json, 'utf8'));
    assert.deepEqual(ex.finalize(), {
      model: 'gpt-5',
      inputTokens: 300,
      outputTokens: 120,
      cacheCreation5mTokens: 0,
      cacheCreation1hTokens: 0,
      cacheReadTokens: 100,
    });
  });

  test('JSON über mehrere Chunks gefüttert → korrekt zusammengesetzt', () => {
    const json = JSON.stringify({
      model: 'gpt-4o',
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    const buf = Buffer.from(json, 'utf8');
    const ex = createUsageExtractor('openai', false);
    assert.deepEqual(feedInChunks(ex, buf, 4), {
      model: 'gpt-4o',
      inputTokens: 10,
      outputTokens: 5,
      cacheCreation5mTokens: 0,
      cacheCreation1hTokens: 0,
      cacheReadTokens: 0,
    });
  });
});

// ==============================================================================
// createUsageExtractor — Randfälle / "niemals brechen"
// ==============================================================================

describe('createUsageExtractor — Randfälle', () => {
  test('keine usage im Stream → finalize() = null', () => {
    const sse =
      'data: {"type":"content_block_delta","delta":{"text":"hi"}}\n\ndata: [DONE]\n\n';
    const ex = createUsageExtractor('openai', true);
    ex.feed(Buffer.from(sse, 'utf8'));
    assert.equal(ex.finalize(), null);
  });

  test('leerer Stream → null', () => {
    const ex = createUsageExtractor('anthropic', true);
    assert.equal(ex.finalize(), null);
  });

  test('defektes JSON in Non-Streaming → null (kein Absturz)', () => {
    const ex = createUsageExtractor('openai', false);
    ex.feed(Buffer.from('{ kaputt', 'utf8'));
    assert.equal(ex.finalize(), null);
  });

  test('JSON ohne .usage-Feld → null', () => {
    const ex = createUsageExtractor('anthropic', false);
    ex.feed(Buffer.from(JSON.stringify({ model: 'x', content: [] }), 'utf8'));
    assert.equal(ex.finalize(), null);
  });

  test('defekte data:-Zeile mitten im Stream wird übersprungen, gültige usage zählt', () => {
    const sse =
      'data: {kaputtes json\n' +
      '\n' +
      'data: {"model":"gpt-4o","usage":{"prompt_tokens":7,"completion_tokens":3}}\n' +
      '\n';
    const ex = createUsageExtractor('openai', true);
    ex.feed(Buffer.from(sse, 'utf8'));
    assert.deepEqual(ex.finalize(), {
      model: 'gpt-4o',
      inputTokens: 7,
      outputTokens: 3,
      cacheCreation5mTokens: 0,
      cacheCreation1hTokens: 0,
      cacheReadTokens: 0,
    });
  });

  test('unbekannter Provider → No-Op-Extraktor liefert null', () => {
    const ex = createUsageExtractor(null, true);
    ex.feed(Buffer.from('data: {"usage":{"prompt_tokens":1}}\n\n', 'utf8'));
    assert.equal(ex.finalize(), null);
  });

  test('Stream ohne abschließenden Zeilenumbruch → flush verarbeitet Restzeile', () => {
    const sse =
      'data: {"model":"gpt-4o","usage":{"prompt_tokens":9,"completion_tokens":4}}'; // kein \n am Ende
    const ex = createUsageExtractor('openai', true);
    ex.feed(Buffer.from(sse, 'utf8'));
    assert.deepEqual(ex.finalize(), {
      model: 'gpt-4o',
      inputTokens: 9,
      outputTokens: 4,
      cacheCreation5mTokens: 0,
      cacheCreation1hTokens: 0,
      cacheReadTokens: 0,
    });
  });
});
