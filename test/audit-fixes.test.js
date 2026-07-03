'use strict';

/**
 * test/audit-fixes.test.js — Regressionstests fuer die im adversarialen Audit
 * bestaetigten und anschliessend behobenen Findings:
 *   A  include_usage-Injektion nur bei Chat-Completions (nicht /v1/responses)
 *   B  accept-encoding: identity zum Upstream erzwingen (Tracking bei Kompression)
 *   C  CSRF-Schutz auf POST /api/bypass (Origin/Referer-Pruefung)
 *   D  Praefix-Fallback im Preis-Lookup fuer datierte Modell-Snapshots
 *   E  detectProvider erkennt Anthropic-OAuth-Bearer (sk-ant / anthropic-version)
 *   F  Host-Header-Pruefung gegen DNS-Rebinding
 *
 * Datenverzeichnis wird isoliert; ausschliesslich Node-stdlib.
 */

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cclt-auditfix-'));
process.env.CCLT_DATA_DIR = DATA_DIR;

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const providers = require('../src/providers');
const pricing = require('../src/pricing');
const proxy = require('../src/proxy');

after(() => {
  delete process.env.CCLT_DATA_DIR;
  fs.rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 3 });
  // Sicherheitsnetz: eine evtl. im cwd erzeugte Bypass-Datei entfernen.
  fs.rmSync(path.join(process.cwd(), '.budget-bypass'), { force: true });
});

// --- Test-Helfer ------------------------------------------------------------

function httpReq({ port, method, path: p, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (body != null) h['content-length'] = Buffer.byteLength(body);
    const req = http.request(
      { host: '127.0.0.1', port, method, path: p, headers: h, agent: false },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })
        );
      }
    );
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server) return resolve();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close(() => resolve());
  });
}

function usageOf(model, inputTokens) {
  return { model, inputTokens, outputTokens: 0, cacheCreation5mTokens: 0, cacheCreation1hTokens: 0, cacheReadTokens: 0 };
}

// --- Fix A: include_usage nur bei Chat-Completions --------------------------

test('A: maybeInjectIncludeUsage injiziert bei Chat-Completions (messages)', () => {
  const body = Buffer.from(JSON.stringify({ model: 'gpt-4o', stream: true, messages: [{ role: 'user', content: 'hi' }] }));
  const out = providers.maybeInjectIncludeUsage('openai', body, { injectOpenAIUsage: true });
  assert.equal(JSON.parse(out.toString('utf8')).stream_options.include_usage, true);
});

test('A: maybeInjectIncludeUsage laesst Responses-API (input) UNVERAENDERT', () => {
  const body = Buffer.from(JSON.stringify({ model: 'gpt-5', stream: true, input: 'hallo' }));
  const out = providers.maybeInjectIncludeUsage('openai', body, { injectOpenAIUsage: true });
  assert.ok(body.equals(out), 'Responses-Body darf nicht veraendert werden');
  assert.equal(JSON.parse(out.toString('utf8')).stream_options, undefined);
});

// --- Fix E: detectProvider OAuth-Bearer -------------------------------------

test('E: anthropic-version + Bearer -> anthropic', () => {
  assert.equal(
    providers.detectProvider('/v1/foo', { 'anthropic-version': '2023-06-01', authorization: 'Bearer sk-ant-oat-x' }),
    'anthropic'
  );
});

test('E: Bearer sk-ant ohne messages-Pfad -> anthropic', () => {
  assert.equal(providers.detectProvider('/v1/models', { authorization: 'Bearer sk-ant-oat-x' }), 'anthropic');
});

test('E: gewoehnlicher Bearer -> openai', () => {
  assert.equal(providers.detectProvider('/v1/models', { authorization: 'Bearer sk-proj-abc' }), 'openai');
});

test('E: /v1/messages behaelt Vorrang trotz Nicht-Anthropic-Bearer', () => {
  assert.equal(providers.detectProvider('/v1/messages', { authorization: 'Bearer sk-proj-abc' }), 'anthropic');
});

// --- Fix D: Praefix-Fallback bei datierten Snapshots ------------------------

test('D: datierter OpenAI-Snapshot faellt auf Basis-Key (gpt-4o)', () => {
  pricing.loadPricing();
  const c = pricing.computeCost(usageOf('gpt-4o-2024-08-06', 1e6));
  assert.equal(c.warning, null, 'Snapshot muss auf gpt-4o aufgeloest werden');
  assert.ok(Math.abs(c.costUSD - 2.5) < 1e-9, `gpt-4o input=2.5/1M, war ${c.costUSD}`);
});

test('D: gpt-4o-mini-Snapshot nimmt LAENGSTEN Praefix (nicht gpt-4o)', () => {
  const c = pricing.computeCost(usageOf('gpt-4o-mini-2024-07-18', 1e6));
  assert.ok(Math.abs(c.costUSD - 0.15) < 1e-9, `gpt-4o-mini input=0.15/1M, war ${c.costUSD}`);
});

test('D: datierter Anthropic-Snapshot faellt auf Basis-Key', () => {
  const c = pricing.computeCost(usageOf('claude-opus-4-8-20260101', 1e6));
  assert.ok(Math.abs(c.costUSD - 5) < 1e-9, `claude-opus-4-8 input=5/1M, war ${c.costUSD}`);
});

test('D: voellig unbekanntes Modell bleibt 0 + Warnung', () => {
  const c = pricing.computeCost(usageOf('vollkommen-erfundenes-modell', 1e6));
  assert.equal(c.costUSD, 0);
  assert.ok(c.warning, 'Warnung muss gesetzt sein');
});

// --- Fix B: accept-encoding: identity zum Upstream --------------------------

test('B: Proxy erzwingt accept-encoding: identity zum Upstream', async () => {
  let receivedAE = 'NICHT_GESETZT';
  const mock = http.createServer((req, res) => {
    receivedAE = req.headers['accept-encoding'];
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: 'claude-opus-4-8', usage: { input_tokens: 10, output_tokens: 5 } }));
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const mockPort = mock.address().port;

  const server = proxy.startServer({
    port: 0, dailyLimitUSD: 1e9, injectOpenAIUsage: false,
    upstreams: { anthropic: `http://127.0.0.1:${mockPort}`, openai: `http://127.0.0.1:${mockPort}` },
  });
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;

  try {
    await httpReq({ port, method: 'POST', path: '/v1/messages', headers: { 'x-api-key': 'k', 'accept-encoding': 'gzip, br' }, body: '{}' });
    assert.equal(receivedAE, 'identity', 'Upstream muss accept-encoding: identity erhalten (Client sendete gzip, br)');
  } finally {
    await closeServer(server);
    await closeServer(mock);
  }
});

// --- Fix C: CSRF-Schutz auf /api/bypass -------------------------------------

test('C: /api/bypass lehnt fremde Origin mit 403 ab, erlaubt lokale', async () => {
  const server = proxy.startServer({ port: 0, dailyLimitUSD: 25, upstreams: {} });
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  try {
    // {active:false} erzeugt keine .budget-bypass-Datei (idempotentes Loeschen).
    const foreign = await httpReq({
      port, method: 'POST', path: '/api/bypass',
      headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
      body: JSON.stringify({ active: false }),
    });
    assert.equal(foreign.status, 403, 'fremde Origin -> 403');

    const local = await httpReq({
      port, method: 'POST', path: '/api/bypass',
      headers: { 'content-type': 'application/json', origin: `http://localhost:${port}` },
      body: JSON.stringify({ active: false }),
    });
    assert.equal(local.status, 200, 'lokale Origin -> 200');
  } finally {
    await closeServer(server);
    fs.rmSync(path.join(process.cwd(), '.budget-bypass'), { force: true });
  }
});

// --- Fix F: Host-Header-Pruefung (DNS-Rebinding) ----------------------------

test('F: fremder Host-Header wird mit 403 abgewiesen, lokaler durchgelassen', async () => {
  const server = proxy.startServer({ port: 0, dailyLimitUSD: 25, upstreams: {} });
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  try {
    const bad = await httpReq({ port, method: 'GET', path: '/dashboard', headers: { host: 'evil.example' } });
    assert.equal(bad.status, 403, 'fremder Host -> 403');

    const good = await httpReq({ port, method: 'GET', path: '/dashboard', headers: { host: `localhost:${port}` } });
    assert.equal(good.status, 200, 'lokaler Host -> 200 (Dashboard)');
  } finally {
    await closeServer(server);
  }
});
