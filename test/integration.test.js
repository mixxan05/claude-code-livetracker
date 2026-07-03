'use strict';

/**
 * test/integration.test.js — Ende-zu-Ende-Test des Proxy-Pfads.
 *
 * Aufbau:
 *   1. Ein lokaler Mock-Upstream (http-Server) streamt eine aufgezeichnete
 *      Anthropic-SSE-Antwort (message_start … message_delta … message_stop),
 *      bewusst in NICHT zeilen-orientierten Chunks (testet den Byte-Tap an
 *      Chunk-Grenzen).
 *   2. Der Proxy wird mit auf den Mock gebogenen `upstreams` gestartet.
 *   3. Ein Request wird DURCH den Proxy geschickt.
 *
 * Geprüft wird:
 *   (a) Der beim Client ankommende Stream ist BYTE-IDENTISCH zur Mock-Antwort
 *       (transparentes Durchreichen, kein Verändern/Verschlucken von Bytes).
 *   (b) Die Kosten wurden via spend korrekt verbucht (Extraktor → computeCost →
 *       recordSpend), passend zur unabhängig konstruierten Erwartung.
 *
 * WICHTIG: Das Datenverzeichnis (CCLT_DATA_DIR) wird VOR dem Laden der src-Module
 * auf ein frisches Temp-Verzeichnis gelenkt und danach wieder aufgeräumt — das
 * Projekt-Root bleibt sauber. Ausschließlich Node-stdlib, keine Test-Deps.
 */

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

// Datenverzeichnis isolieren, BEVOR spend.js (über proxy.js) geladen wird.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cclt-integration-'));
process.env.CCLT_DATA_DIR = DATA_DIR;

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const proxy = require('../src/proxy');
const spend = require('../src/spend');
const pricing = require('../src/pricing');

// --- Aufgezeichnete Anthropic-SSE-Antwort ----------------------------------
// input 1000, cache_creation 2000 (⇒ 5m), cache_read 500, output final 50.
const SSE_TEXT = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_int_01","type":"message","role":"assistant","model":"claude-opus-4-8","usage":{"input_tokens":1000,"cache_creation_input_tokens":2000,"cache_read_input_tokens":500,"output_tokens":1}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hallo Welt"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":50}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
].join('\n');
const SSE_BUFFER = Buffer.from(SSE_TEXT, 'utf8');

// Die vom Stream implizierte, provider-unabhängige Nutzung (unabhängig konstruiert).
const EXPECTED_USAGE = {
  model: 'claude-opus-4-8',
  inputTokens: 1000,
  outputTokens: 50,
  cacheCreation5mTokens: 2000,
  cacheCreation1hTokens: 0,
  cacheReadTokens: 500,
};

// --- Test-Helfer ------------------------------------------------------------

/** Startet den Mock-Upstream und liefert den lauschenden Server. */
function startMockUpstream() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      // Request-Body vollständig konsumieren, dann die SSE-Antwort streamen.
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
        });

        // In festen Byte-Blöcken senden, die NICHT an SSE-Zeilen ausgerichtet sind.
        const CHUNK = 137;
        const parts = [];
        for (let i = 0; i < SSE_BUFFER.length; i += CHUNK) {
          parts.push(SSE_BUFFER.subarray(i, Math.min(i + CHUNK, SSE_BUFFER.length)));
        }

        let i = 0;
        (function writeNext() {
          if (i < parts.length) {
            res.write(parts[i++]);
            setImmediate(writeNext);
          } else {
            res.end();
          }
        })();
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/** Wartet, bis `cond()` truthy ist (oder wirft nach timeoutMs). */
function waitFor(cond, timeoutMs) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (function tick() {
      let ok = false;
      try {
        ok = cond();
      } catch {
        ok = false;
      }
      if (ok) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor: Bedingung nicht erfüllt'));
      setTimeout(tick, 10);
    })();
  });
}

/** Schickt einen Streaming-Request durch den Proxy und sammelt die Antwort. */
function requestThroughProxy(proxyPort) {
  const requestBody = JSON.stringify({
    model: 'claude-opus-4-8',
    max_tokens: 100,
    stream: true,
    messages: [{ role: 'user', content: 'Hallo' }],
  });

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: proxyPort,
        method: 'POST',
        path: '/v1/messages',
        // agent:false ⇒ Einzelverbindung, die nach der Antwort schließt (kein Keep-Alive-Hänger).
        agent: false,
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'test-key-DUMMY-NICHT-ECHT',
          'anthropic-version': '2023-06-01',
          accept: 'text/event-stream',
          'content-length': Buffer.byteLength(requestBody),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
        );
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.write(requestBody);
    req.end();
  });
}

/** Schließt einen Server inkl. offener Keep-Alive-Verbindungen. */
function closeServer(server) {
  return new Promise((resolve) => {
    if (!server) return resolve();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close(() => resolve());
  });
}

// --- Test -------------------------------------------------------------------

test('Integration: Proxy reicht Anthropic-SSE byte-identisch durch und verbucht Kosten', { timeout: 20000 }, async () => {
  const mock = await startMockUpstream();
  const mockPort = mock.address().port;

  const config = {
    port: 0, // freien Port vom OS zuweisen lassen
    dailyLimitUSD: 1000000, // absichtlich hoch ⇒ Budget blockiert nie
    injectOpenAIUsage: false,
    upstreams: {
      anthropic: `http://127.0.0.1:${mockPort}`,
      openai: `http://127.0.0.1:${mockPort}`,
    },
  };

  const server = proxy.startServer(config);
  await new Promise((resolve) => server.on('listening', resolve));
  const proxyPort = server.address().port;

  try {
    const received = await requestThroughProxy(proxyPort);

    // (a) Byte-identischer Durchfluss ---------------------------------------
    assert.equal(received.status, 200, 'Proxy muss die Upstream-Antwort (200) durchreichen');
    assert.ok(
      SSE_BUFFER.equals(received.body),
      'Der beim Client ankommende Stream muss BYTE-IDENTISCH zur Mock-Antwort sein'
    );
    // Der Content-Type wird transparent weitergereicht.
    assert.match(String(received.headers['content-type'] || ''), /text\/event-stream/);

    // (b) Kosten korrekt verbucht -------------------------------------------
    const expectedCost = pricing.computeCost(EXPECTED_USAGE).costUSD;
    assert.ok(expectedCost > 0, 'claude-opus-4-8 muss in pricing.json bepreist sein (Erwartung > 0)');

    // recordSpend läuft synchron im upstreamRes-'end'; kurzes Warten deckt Timing ab.
    await waitFor(() => spend.getTodayTotalUSD() > 0, 2000);

    const today = spend.getTodayTotalUSD();
    assert.ok(
      Math.abs(today - expectedCost) < 1e-9,
      `Tagessumme (${today}) muss den erwarteten Kosten (${expectedCost}) entsprechen`
    );

    const state = spend.getState();
    assert.ok(Math.abs(state.sessionCostUSD - expectedCost) < 1e-9, 'Session-Kosten müssen stimmen');
    assert.equal(state.sessionInputTokens, EXPECTED_USAGE.inputTokens);
    assert.equal(state.sessionOutputTokens, EXPECTED_USAGE.outputTokens);

    assert.ok(state.lastRequest, 'lastRequest muss gesetzt sein');
    assert.equal(state.lastRequest.model, 'claude-opus-4-8');
    assert.equal(state.lastRequest.inputTokens, EXPECTED_USAGE.inputTokens);
    assert.equal(state.lastRequest.outputTokens, EXPECTED_USAGE.outputTokens);
    assert.equal(state.lastRequest.cacheReadTokens, EXPECTED_USAGE.cacheReadTokens);
    assert.equal(state.lastRequest.warning, null, 'bekanntes Modell ⇒ keine Warnung');

    // Die persistierte Tagesdatei existiert und trägt dieselbe Summe.
    const dailyName = `spend-${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(new Date().getDate()).padStart(2, '0')}.json`;
    const dailyPath = path.join(DATA_DIR, dailyName);
    assert.ok(fs.existsSync(dailyPath), 'Tagesdatei muss geschrieben worden sein');
    const daily = JSON.parse(fs.readFileSync(dailyPath, 'utf8'));
    assert.ok(Math.abs(daily.costUSD - expectedCost) < 1e-9, 'Tagesdatei-Kosten müssen stimmen');
    assert.equal(daily.requestCount, 1);
  } finally {
    await closeServer(server);
    await closeServer(mock);
    delete process.env.CCLT_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 3 });
  }
});
