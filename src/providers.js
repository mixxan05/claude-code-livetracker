'use strict';

/**
 * src/providers.js — Provider-Schicht des Live-Trackers.
 *
 * Verantwortlich für vier klar abgegrenzte Aufgaben (siehe docs/contracts.md §3):
 *   1. detectProvider          — erkennt anhand von Pfad bzw. Auth-Header, ob ein
 *                                Request an Anthropic oder OpenAI geht.
 *   2. resolveUpstream         — löst die konfigurierte Upstream-URL in Protokoll,
 *                                Host und Port auf.
 *   3. maybeInjectIncludeUsage — injiziert bei OpenAI-Streaming optional
 *                                `stream_options.include_usage = true`.
 *   4. createUsageExtractor    — zustandsbehafteter Extraktor, der die Antwort
 *                                (SSE-Stream bzw. JSON) mitliest und daraus eine
 *                                provider-unabhängige NormalizedUsage gewinnt.
 *
 * OBERSTES PRINZIP: Diese Schicht darf den durchgereichten Verkehr niemals brechen.
 * Jede Parsing-Unsicherheit endet in "unverändert durchreichen" bzw. "usage = null"
 * (dann verbucht der Aufrufer Kosten 0 samt Warnung) — niemals in einer Exception,
 * die den Proxy-Pfad stört.
 *
 * @typedef {Object} NormalizedUsage
 * @property {string} model
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} cacheCreation5mTokens
 * @property {number} cacheCreation1hTokens
 * @property {number} cacheReadTokens
 */

const { URL } = require('url');

// Eingebaute Standard-Upstreams als Rückfallebene, falls config.upstreams
// unvollständig ist. Halten die Erkennung auch ohne vollständige Konfiguration robust.
const DEFAULT_UPSTREAMS = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
};

// -------------------------------------------------------------------------------------
// Allgemeine Hilfsfunktionen
// -------------------------------------------------------------------------------------

/**
 * Wandelt einen beliebigen Wert defensiv in eine nicht-negative Zahl um.
 * Fehlende/ungültige Werte (undefined, null, NaN, String …) ergeben 0 —
 * so bleibt NormalizedUsage immer vollständig mit Zahlen belegt.
 * @param {*} v
 * @returns {number}
 */
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Normalisiert Header-Schlüssel auf Kleinschreibung. Node liefert `req.headers`
 * bereits klein, aber Aufrufer/Tests könnten gemischte Schreibweisen übergeben.
 * @param {Object|undefined|null} headers
 * @returns {Object}
 */
function lowerKeys(headers) {
  const out = {};
  if (headers && typeof headers === 'object') {
    for (const key of Object.keys(headers)) {
      out[key.toLowerCase()] = headers[key];
    }
  }
  return out;
}

// -------------------------------------------------------------------------------------
// 1. detectProvider
// -------------------------------------------------------------------------------------

/**
 * Erkennt den Ziel-Provider — primär am Request-Pfad, sekundär am Auth-Header.
 *
 * Pfad-Regeln (haben Vorrang):
 *   - enthält `/v1/messages`                              → 'anthropic'
 *   - enthält `/v1/chat/completions` oder `/v1/responses` → 'openai'
 * Header-Rückfall (wenn der Pfad nichts hergibt):
 *   - `x-api-key` vorhanden                → 'anthropic' (Anthropic-typischer Header)
 *   - `Authorization: Bearer …`            → 'openai'
 * Kein eindeutiges Signal → null. Der Aufrufer reicht den Request dann trotzdem
 * transparent durch (Tracking = 0), blockiert also nie.
 *
 * @param {string} reqPath  Request-Pfad inkl. Query (z. B. "/v1/messages?beta=1").
 * @param {Object} headers  Request-Header (Schlüssel beliebiger Groß-/Kleinschreibung).
 * @returns {'anthropic'|'openai'|null}
 */
function detectProvider(reqPath, headers) {
  const path = typeof reqPath === 'string' ? reqPath : '';

  // --- Primär: Pfad-basierte Erkennung ---
  if (path.includes('/v1/messages')) return 'anthropic';
  if (path.includes('/v1/chat/completions') || path.includes('/v1/responses')) return 'openai';

  // --- Sekundär: Auth-/Header-basierte Erkennung ---
  const h = lowerKeys(headers);
  // x-api-key ist der eindeutig Anthropic-typische Schlüssel und hat Vorrang.
  if (h['x-api-key']) return 'anthropic';
  // Anthropic-spezifische Header (auch im OAuth-/Abo-Modus gesendet) haben Vorrang
  // vor der groben Bearer-Heuristik.
  if (h['anthropic-version'] || h['anthropic-beta']) return 'anthropic';
  const auth = h['authorization'];
  if (typeof auth === 'string' && /^\s*bearer\s+/i.test(auth)) {
    // Anthropic-OAuth (Claude-Abo-Modus) nutzt ebenfalls "Authorization: Bearer",
    // aber mit einem sk-ant-Token. Nur echte Nicht-Anthropic-Bearer sind OpenAI.
    if (/bearer\s+sk-ant/i.test(auth)) return 'anthropic';
    return 'openai';
  }

  // Kein verlässliches Signal.
  return null;
}

// -------------------------------------------------------------------------------------
// 2. resolveUpstream
// -------------------------------------------------------------------------------------

/**
 * Löst die Upstream-URL des Providers aus `config.upstreams[provider]` (mit
 * eingebautem Default-Rückfall) in ihre Bestandteile auf.
 *
 * Rückgabe-Konvention:
 *   - `protocol`: Modul-/Schema-Name OHNE Doppelpunkt, also `'https'` oder `'http'`
 *                 (direkt verwendbar für die Wahl des https-/http-Moduls).
 *   - `host`:     reiner Hostname ohne Port.
 *   - `port`:     Zahl; fehlt sie in der URL, gilt der Protokoll-Default (https→443, http→80).
 *
 * Für einen unbekannten Provider (nicht 'anthropic'/'openai') gibt es keine sinnvolle
 * Upstream-Zuordnung → null. Der Aufrufer entscheidet dann selbst (z. B. 502).
 *
 * @param {'anthropic'|'openai'|string|null} provider
 * @param {Object} config
 * @returns {{ protocol: string, host: string, port: number }|null}
 */
function resolveUpstream(provider, config) {
  if (provider !== 'anthropic' && provider !== 'openai') return null;

  const configured =
    config && config.upstreams && typeof config.upstreams[provider] === 'string'
      ? config.upstreams[provider].trim()
      : '';
  const urlStr = configured || DEFAULT_UPSTREAMS[provider];

  let u;
  try {
    u = new URL(urlStr);
  } catch {
    // Konfigurierte URL unbrauchbar → auf eingebauten Default zurückfallen.
    try {
      u = new URL(DEFAULT_UPSTREAMS[provider]);
    } catch {
      return null;
    }
  }

  const protocol = u.protocol.replace(/:$/, ''); // "https:" → "https"
  const host = u.hostname;
  const port = u.port ? Number(u.port) : protocol === 'https' ? 443 : 80;
  return { protocol, host, port };
}

// -------------------------------------------------------------------------------------
// 3. maybeInjectIncludeUsage
// -------------------------------------------------------------------------------------

/**
 * Injiziert bei OpenAI-Streaming-Requests `stream_options.include_usage = true`,
 * damit verlässliche Token-Zahlen im letzten SSE-Chunk zurückkommen. Dies ist der
 * einzige bewusste Eingriff des Proxys in einen Request-Body.
 *
 * Der Body wird NUR verändert, wenn ALLE Bedingungen zutreffen:
 *   - provider === 'openai'
 *   - config.injectOpenAIUsage === true
 *   - der Body ist gültiges JSON-Objekt mit `stream: true`
 *   - der Body hat die Chat-Completions-Form (Feld `messages` als Array)
 *
 * Der letzte Punkt ist entscheidend: `stream_options` ist ausschließlich ein
 * Chat-Completions-Parameter. Die OpenAI Responses-API (`/v1/responses`, Body-Form
 * mit `input` statt `messages`) kennt ihn nicht und lehnt fremde Top-Level-Parameter
 * strikt mit HTTP 400 ab — dort darf also niemals injiziert werden (usage kommt bei
 * Responses ohnehin automatisch im `response.completed`-Event).
 *
 * In allen anderen Fällen (anderer Provider, Flag aus, Non-Stream, Nicht-JSON /
 * Parse-Fehler, leerer/kein Buffer, bereits gesetztes Flag) wird der EXAKT selbe
 * Buffer unverändert zurückgegeben — niemals blockieren, niemals unnötig neu serialisieren.
 * Der Aufrufer ist dafür verantwortlich, bei geändertem Body `Content-Length` neu zu setzen.
 *
 * @param {'anthropic'|'openai'|string|null} provider
 * @param {Buffer} bodyBuffer
 * @param {Object} config
 * @returns {Buffer}
 */
function maybeInjectIncludeUsage(provider, bodyBuffer, config) {
  if (provider !== 'openai') return bodyBuffer;
  if (!config || config.injectOpenAIUsage !== true) return bodyBuffer;
  if (!Buffer.isBuffer(bodyBuffer) || bodyBuffer.length === 0) return bodyBuffer;

  let obj;
  try {
    obj = JSON.parse(bodyBuffer.toString('utf8'));
  } catch {
    return bodyBuffer; // Nicht-JSON → unverändert durchreichen.
  }

  // Nur echte Objekte mit stream:true anfassen (Arrays/primitives ignorieren).
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || obj.stream !== true) {
    return bodyBuffer;
  }

  // Nur die Chat-Completions-Form (Feld `messages`) bekommt stream_options. Die
  // Responses-API (`input` statt `messages`) würde den fremden Parameter mit 400
  // ablehnen — dort niemals injizieren.
  if (!Array.isArray(obj.messages)) {
    return bodyBuffer;
  }

  // Bereits korrekt gesetzt → Body unverändert lassen (spart Re-Serialisierung).
  if (
    obj.stream_options &&
    typeof obj.stream_options === 'object' &&
    obj.stream_options.include_usage === true
  ) {
    return bodyBuffer;
  }

  // Vorhandene stream_options-Felder bewahren, nur das Flag ergänzen.
  const streamOptions =
    obj.stream_options && typeof obj.stream_options === 'object' && !Array.isArray(obj.stream_options)
      ? obj.stream_options
      : {};
  streamOptions.include_usage = true;
  obj.stream_options = streamOptions;

  return Buffer.from(JSON.stringify(obj), 'utf8');
}

// -------------------------------------------------------------------------------------
// 4. usage-Extraktion
// -------------------------------------------------------------------------------------

/**
 * Bildet ein Anthropic-usage-Objekt (aus `message_start.message.usage` bzw. dem
 * `.usage` einer Non-Streaming-Antwort) auf die Cache-/Input-Felder ab.
 *
 * Cache-Aufschlüsselung gemäß Contract:
 *   - Liegt `cache_creation = { ephemeral_5m_input_tokens, ephemeral_1h_input_tokens }`
 *     vor → 5m-/1h-Anteile getrennt übernehmen.
 *   - Fehlt das Objekt → `cache_creation_input_tokens` KOMPLETT als 5m-Cache werten.
 *
 * @param {Object} usage
 * @returns {{ inputTokens: number, cacheReadTokens: number, cache5m: number, cache1h: number }}
 */
function mapAnthropicUsage(usage) {
  const inputTokens = num(usage.input_tokens);
  const cacheReadTokens = num(usage.cache_read_input_tokens);
  let cache5m = 0;
  let cache1h = 0;
  if (usage.cache_creation && typeof usage.cache_creation === 'object') {
    cache5m = num(usage.cache_creation.ephemeral_5m_input_tokens);
    cache1h = num(usage.cache_creation.ephemeral_1h_input_tokens);
  } else {
    cache5m = num(usage.cache_creation_input_tokens);
  }
  return { inputTokens, cacheReadTokens, cache5m, cache1h };
}

/**
 * Bildet ein OpenAI-usage-Objekt auf Input-/Output-/Cache-Read-Tokens ab.
 * Unterstützt beide gebräuchlichen Formen:
 *   - Chat-Completions:  prompt_tokens / completion_tokens / prompt_tokens_details.cached_tokens
 *   - Responses-API:     input_tokens  / output_tokens     / input_tokens_details.cached_tokens
 * In beiden Fällen enthält der "Prompt-/Input"-Wert die Cache-Reads bereits; die reinen
 * Eingabe-Tokens ergeben sich daher als (prompt − cached) bzw. (input − cached).
 * Cache-WRITE-Tokens kennt OpenAIs usage nicht → immer 0 (5m/1h setzt der Aufrufer auf 0).
 *
 * @param {Object} usage
 * @returns {{ inputTokens: number, outputTokens: number, cacheReadTokens: number }}
 */
function mapOpenAIUsage(usage) {
  const hasChatShape = usage.prompt_tokens !== undefined || usage.completion_tokens !== undefined;
  if (hasChatShape) {
    const cached = num(usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens);
    const prompt = num(usage.prompt_tokens);
    return {
      inputTokens: Math.max(0, prompt - cached),
      outputTokens: num(usage.completion_tokens),
      cacheReadTokens: cached,
    };
  }
  // Responses-API-Form.
  const cached = num(usage.input_tokens_details && usage.input_tokens_details.cached_tokens);
  const input = num(usage.input_tokens);
  return {
    inputTokens: Math.max(0, input - cached),
    outputTokens: num(usage.output_tokens),
    cacheReadTokens: cached,
  };
}

/**
 * Byte-genauer Zeilen-Puffer für SSE-Streams. `push` nimmt beliebig zerteilte Chunks
 * entgegen (auch mitten in einer Zeile oder mitten in einem Mehrbyte-UTF-8-Zeichen) und
 * ruft `onLine` für jede VOLLSTÄNDIGE Zeile auf. Getrennt wird am Byte `0x0A` (\n); ein
 * evtl. vorangehendes `0x0D` (\r, also CRLF) wird entfernt. Da 0x0A nie innerhalb einer
 * Mehrbyte-UTF-8-Sequenz vorkommt, ist das Decodieren einer kompletten Zeile stets sicher.
 *
 * @param {(line: string) => void} onLine
 */
function createLineBuffer(onLine) {
  let pending = Buffer.alloc(0);

  function emit(lineBuf) {
    let line = lineBuf;
    if (line.length && line[line.length - 1] === 0x0d) {
      line = line.subarray(0, line.length - 1); // CR bei CRLF entfernen
    }
    onLine(line.toString('utf8'));
  }

  return {
    push(chunk) {
      if (!chunk || chunk.length === 0) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      pending = pending.length ? Buffer.concat([pending, buf]) : buf;
      let nl;
      while ((nl = pending.indexOf(0x0a)) !== -1) {
        emit(pending.subarray(0, nl));
        pending = pending.subarray(nl + 1);
      }
    },
    // Am Stream-Ende einen evtl. verbliebenen, nicht mit \n terminierten Rest verarbeiten.
    flush() {
      if (pending.length) {
        emit(pending);
        pending = Buffer.alloc(0);
      }
    },
  };
}

/**
 * Extrahiert aus einer einzelnen SSE-Zeile das JSON-Objekt des `data:`-Feldes.
 * Nicht-`data:`-Zeilen (z. B. `event:`, Kommentare, Leerzeilen), das `[DONE]`-Sentinel
 * sowie defektes JSON ergeben `null` und werden vom Aufrufer ignoriert.
 *
 * @param {string} line
 * @returns {Object|null}
 */
function parseSSEData(line) {
  if (!line.startsWith('data:')) return null;
  const payload = line.slice(5).trim(); // "data:" entfernen, optionales Leerzeichen inklusive
  if (payload === '' || payload === '[DONE]') return null;
  try {
    const obj = JSON.parse(payload);
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

/**
 * Zustandsbehafteter Extraktor für Anthropic-STREAMING (SSE).
 *   - input/cache/model aus `message_start.message` (+ initiale output_tokens)
 *   - finale, kumulative output_tokens aus `message_delta.usage`
 * @returns {{ feed(chunk: Buffer): void, finalize(): (NormalizedUsage|null) }}
 */
function anthropicStreamExtractor() {
  let model = '';
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let cache5m = 0;
  let cache1h = 0;
  let outputTokens = 0;
  let sawUsage = false;

  const lb = createLineBuffer((line) => {
    const obj = parseSSEData(line);
    if (!obj) return;

    if (obj.type === 'message_start' && obj.message && typeof obj.message === 'object') {
      const message = obj.message;
      if (typeof message.model === 'string' && message.model) model = message.model;
      if (message.usage && typeof message.usage === 'object') {
        const mapped = mapAnthropicUsage(message.usage);
        inputTokens = mapped.inputTokens;
        cacheReadTokens = mapped.cacheReadTokens;
        cache5m = mapped.cache5m;
        cache1h = mapped.cache1h;
        // message_start trägt bereits einen (kleinen) initialen output-Wert; als Startwert übernehmen.
        outputTokens = num(message.usage.output_tokens);
        sawUsage = true;
      }
    } else if (obj.type === 'message_delta' && obj.usage && typeof obj.usage === 'object') {
      // output_tokens im message_delta ist kumulativ — der jeweils letzte Wert gewinnt.
      if (typeof obj.usage.output_tokens === 'number') {
        outputTokens = obj.usage.output_tokens;
        sawUsage = true;
      }
    }
  });

  return {
    feed(chunk) {
      lb.push(chunk);
    },
    finalize() {
      lb.flush();
      if (!sawUsage) return null;
      return {
        model: model || '',
        inputTokens,
        outputTokens,
        cacheCreation5mTokens: cache5m,
        cacheCreation1hTokens: cache1h,
        cacheReadTokens,
      };
    },
  };
}

/**
 * Zustandsbehafteter Extraktor für OpenAI-STREAMING (SSE).
 * `usage` erscheint (nur bei aktivem include_usage) im letzten Chunk; das Modell steht
 * in den Chunks selbst. Zusätzlich wird die Responses-API-Form berücksichtigt, bei der
 * `usage` im `response.completed`-Event unter `response.usage` verschachtelt liegt.
 * @returns {{ feed(chunk: Buffer): void, finalize(): (NormalizedUsage|null) }}
 */
function openaiStreamExtractor() {
  let model = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let sawUsage = false;

  const lb = createLineBuffer((line) => {
    const obj = parseSSEData(line);
    if (!obj) return;

    if (!model && typeof obj.model === 'string' && obj.model) model = obj.model;

    // Chat-Completions: usage direkt am Chunk. In frühen Chunks ist usage null → ignoriert.
    let usage = obj.usage && typeof obj.usage === 'object' ? obj.usage : null;

    // Responses-API: usage unter response.usage (im response.completed-Event).
    if (!usage && obj.response && typeof obj.response === 'object') {
      if (!model && typeof obj.response.model === 'string' && obj.response.model) {
        model = obj.response.model;
      }
      if (obj.response.usage && typeof obj.response.usage === 'object') {
        usage = obj.response.usage;
      }
    }

    if (usage) {
      const mapped = mapOpenAIUsage(usage);
      inputTokens = mapped.inputTokens;
      outputTokens = mapped.outputTokens;
      cacheReadTokens = mapped.cacheReadTokens;
      sawUsage = true;
    }
  });

  return {
    feed(chunk) {
      lb.push(chunk);
    },
    finalize() {
      lb.flush();
      if (!sawUsage) return null;
      return {
        model: model || '',
        inputTokens,
        outputTokens,
        cacheCreation5mTokens: 0,
        cacheCreation1hTokens: 0,
        cacheReadTokens,
      };
    },
  };
}

/**
 * Zustandsbehafteter Extraktor für NON-STREAMING-Antworten (ganzer Body = ein JSON).
 * Sammelt alle Chunks und parst am Ende das komplette JSON.
 * @param {'anthropic'|'openai'} provider
 * @returns {{ feed(chunk: Buffer): void, finalize(): (NormalizedUsage|null) }}
 */
function jsonExtractor(provider) {
  const chunks = [];

  return {
    feed(chunk) {
      if (!chunk || chunk.length === 0) return;
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    },
    finalize() {
      if (chunks.length === 0) return null;
      let obj;
      try {
        obj = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return null; // Kein/defektes JSON → keine usage.
      }
      if (!obj || typeof obj !== 'object' || !obj.usage || typeof obj.usage !== 'object') {
        return null;
      }
      const model = typeof obj.model === 'string' ? obj.model : '';

      if (provider === 'anthropic') {
        const mapped = mapAnthropicUsage(obj.usage);
        return {
          model,
          inputTokens: mapped.inputTokens,
          outputTokens: num(obj.usage.output_tokens),
          cacheCreation5mTokens: mapped.cache5m,
          cacheCreation1hTokens: mapped.cache1h,
          cacheReadTokens: mapped.cacheReadTokens,
        };
      }

      // OpenAI (Chat-Completions ODER Responses-API — mapOpenAIUsage erkennt die Form selbst).
      const mapped = mapOpenAIUsage(obj.usage);
      return {
        model,
        inputTokens: mapped.inputTokens,
        outputTokens: mapped.outputTokens,
        cacheCreation5mTokens: 0,
        cacheCreation1hTokens: 0,
        cacheReadTokens: mapped.cacheReadTokens,
      };
    },
  };
}

/**
 * Fabrik für den passenden usage-Extraktor. Der zurückgegebene Extraktor ist
 * zustandsbehaftet: `feed(chunkBuffer)` füttert Antwort-Chunks (SSE-Zeilen bzw. JSON),
 * `finalize()` liefert am Ende die NormalizedUsage oder `null` (keine usage gefunden).
 *
 * Für einen unbekannten Provider wird ein No-Op-Extraktor geliefert (usage = null),
 * damit der Proxy-Pfad auch dann sauber weiterläuft.
 *
 * @param {'anthropic'|'openai'|string|null} provider
 * @param {boolean} isStream  true = SSE-Streaming, false = einzelne JSON-Antwort.
 * @returns {{ feed(chunk: Buffer): void, finalize(): (NormalizedUsage|null) }}
 */
function createUsageExtractor(provider, isStream) {
  if (provider === 'anthropic') {
    return isStream ? anthropicStreamExtractor() : jsonExtractor('anthropic');
  }
  if (provider === 'openai') {
    return isStream ? openaiStreamExtractor() : jsonExtractor('openai');
  }
  // Unbekannter Provider → nichts extrahieren, aber nie abstürzen.
  return {
    feed() {},
    finalize() {
      return null;
    },
  };
}

module.exports = {
  detectProvider,
  resolveUpstream,
  maybeInjectIncludeUsage,
  createUsageExtractor,
};
