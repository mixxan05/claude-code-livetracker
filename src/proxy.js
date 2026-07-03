'use strict';

/**
 * src/proxy.js — Kern des Claude Code Live Trackers: der HTTP-Reverse-Proxy.
 *
 * Er spricht HTTP mit der lokalen IDE/CLI und HTTPS mit dem echten Upstream
 * (api.anthropic.com / api.openai.com) — daher KEIN TLS-MITM, KEIN Zertifikat nötig.
 *
 * Routing (siehe docs/contracts.md §3, `src/proxy.js`):
 *   /dashboard   → dashboard.serveDashboard
 *   /events      → dashboard.serveEvents   (SSE)
 *   /api/bypass  → dashboard.handleBypass  (POST)
 *   sonst        → Proxy-Pfad
 *
 * Proxy-Pfad:
 *   1. detectProvider(reqPath, headers)
 *   2. budget.isBlocked(config) ⇒ 429 mit deutscher JSON-Fehlermeldung, Ende.
 *   3. Body sammeln, maybeInjectIncludeUsage (einziger bewusster Eingriff),
 *      per https an resolveUpstream weiterleiten (alle Header inkl. x-api-key /
 *      Authorization durchreichen, Host auf den Upstream setzen).
 *   4. Upstream-Antwort TRANSPARENT an den Client pipen UND parallel via
 *      createUsageExtractor tappen — der Client wartet NIE auf den Tracker.
 *   5. Am Stream-Ende: finalize → pricing.computeCost → spend.recordSpend →
 *      dashboard.broadcast.
 *
 * OBERSTES PRINZIP: Das Tracking darf den durchgereichten Verkehr niemals brechen
 * oder verzögern. Parsing-/Preis-/Buchungsfehler enden in "Kosten 0 + Warnung",
 * nie in einer Exception, die den Datenstrom stört. API-Schlüssel werden
 * ausschließlich durchgereicht — nie gespeichert, nie geloggt.
 *
 * Ausschließlich Node-stdlib (http, https, fs, path, url). Keine Dependencies.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const providers = require('./providers');
const pricing = require('./pricing');
const spend = require('./spend');
const budget = require('./budget');
const dashboard = require('./dashboard');

/** Standard-Pfad zur config.json (Projekt-Root, unabhängig vom Arbeitsverzeichnis). */
const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

/**
 * Hop-by-hop-Header, die NICHT an den Client weitergereicht werden dürfen: sie
 * gelten pro Verbindung, nicht Ende-zu-Ende. Node verwaltet Transfer-Encoding und
 * Verbindungsrahmen selbst; würden wir sie forwarden, käme es zu Doppel-Encoding.
 * (RFC 7230 §6.1)
 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Robuste Default-Konfiguration, falls config.json fehlt/korrupt ist. */
const DEFAULT_CONFIG = {
  port: 9000,
  dailyLimitUSD: 25,
  injectOpenAIUsage: true,
  upstreams: {
    anthropic: 'https://api.anthropic.com',
    openai: 'https://api.openai.com',
  },
};

/**
 * Lädt config.json und mischt sie über die Defaults (inkl. verschachtelter
 * `upstreams`). Fehlt/korrupt ⇒ reine Defaults. Wirft nie.
 * @returns {Object}
 */
function loadConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_CONFIG };
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      upstreams: { ...DEFAULT_CONFIG.upstreams, ...(parsed.upstreams || {}) },
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Ergänzt einen von spend.js gelieferten DashboardState um die Felder, die spend.js
 * nicht kennt: `dailyLimitUSD` (aus der laufenden config) und `bypassActive` (aus
 * budget.js). Mutiert und liefert denselben State. Wirft nie.
 * @param {import('./spend').DashboardState} state
 * @param {Object} config
 * @returns {import('./spend').DashboardState}
 */
function enrichState(state, config) {
  if (config && Number.isFinite(config.dailyLimitUSD)) {
    state.dailyLimitUSD = config.dailyLimitUSD;
  }
  try {
    state.bypassActive = budget.isBypassActive();
  } catch {
    /* im Zweifel false belassen */
  }
  return state;
}

/**
 * Ermittelt den Pfad (ohne Query) eines Request-URLs — für das Routing.
 * @param {string} rawUrl
 * @returns {string}
 */
function pathnameOf(rawUrl) {
  try {
    return new URL(rawUrl, 'http://localhost').pathname;
  } catch {
    const q = (rawUrl || '/').indexOf('?');
    return q === -1 ? rawUrl || '/' : rawUrl.slice(0, q);
  }
}

/**
 * Sammelt den kompletten Request-Body in einem Buffer. Der Body wird ohnehin
 * benötigt (mögliche include_usage-Injektion) und danach vollständig mit korrekter
 * Content-Length weitergesendet.
 * @param {import('http').IncomingMessage} req
 * @param {(err: Error|null, body: Buffer) => void} cb
 */
function collectBody(req, cb) {
  const chunks = [];
  let done = false;
  const finish = (err, buf) => {
    if (done) return;
    done = true;
    cb(err, buf);
  };
  req.on('data', (c) => chunks.push(c));
  req.once('end', () => finish(null, Buffer.concat(chunks)));
  req.once('error', (err) => finish(err, Buffer.concat(chunks)));
}

/**
 * Antwortet mit einem JSON-Objekt und korrektem Content-Length. Nur benutzt, solange
 * noch keine Header gesendet wurden.
 * @param {import('http').ServerResponse} res
 * @param {number} status
 * @param {Object} obj
 */
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Der Proxy-Pfad für jeden Nicht-Dashboard-Request.
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {Object} config
 */
function handleProxy(req, res, config) {
  const provider = providers.detectProvider(req.url, req.headers);

  // --- 2) Budget-Guard: Tageslimit erreicht und kein Bypass ⇒ 429 ----------
  if (budget.isBlocked(config)) {
    const today = spend.getTodayTotalUSD();
    const limit = Number.isFinite(config.dailyLimitUSD) ? config.dailyLimitUSD : 0;
    sendJson(res, 429, {
      error:
        `Tageslimit erreicht (${today.toFixed(2)}/${limit.toFixed(2)} USD). ` +
        'Bypass über Dashboard-Button oder .budget-bypass.',
    });
    return;
  }

  // Upstream auflösen. Kein erkennbarer Provider ⇒ es gibt kein sinnvolles Ziel.
  const upstream = providers.resolveUpstream(provider, config);
  if (!upstream) {
    sendJson(res, 404, {
      error:
        'Kein Upstream-Provider erkennbar. Bitte den Pfad (z. B. /v1/messages oder ' +
        '/v1/chat/completions) bzw. den Auth-Header prüfen.',
    });
    return;
  }

  // --- 3) Body sammeln, ggf. include_usage injizieren, dann weiterleiten ---
  collectBody(req, (bodyErr, rawBody) => {
    if (bodyErr) {
      if (!res.headersSent) sendJson(res, 400, { error: 'Anfrage-Body konnte nicht gelesen werden.' });
      else res.destroy();
      return;
    }

    // Einziger bewusster Eingriff (nur OpenAI-Streaming, wenn konfiguriert).
    let outBody = rawBody;
    try {
      outBody = providers.maybeInjectIncludeUsage(provider, rawBody, config);
    } catch {
      outBody = rawBody; // niemals blockieren
    }

    // Header 1:1 übernehmen, aber verbindungsspezifische Felder bereinigen und
    // Host + Content-Length passend zum Upstream/Body setzen. x-api-key /
    // Authorization bleiben unverändert (werden weder verändert noch geloggt).
    const headers = { ...req.headers };
    delete headers.connection;
    delete headers['proxy-connection'];
    delete headers['transfer-encoding'];

    const defaultPort = upstream.protocol === 'https' ? 443 : 80;
    headers.host =
      upstream.port === defaultPort ? upstream.host : `${upstream.host}:${upstream.port}`;

    if (outBody && outBody.length > 0) headers['content-length'] = String(outBody.length);
    else delete headers['content-length'];

    const client = upstream.protocol === 'https' ? https : http;
    const options = {
      host: upstream.host,
      port: upstream.port,
      method: req.method,
      path: req.url,
      headers,
    };

    let responseStarted = false;

    const upstreamReq = client.request(options, (upstreamRes) => {
      responseStarted = true;

      // Antwort-Header transparent weitergeben (hop-by-hop entfernen).
      const outHeaders = {};
      for (const [k, v] of Object.entries(upstreamRes.headers)) {
        if (!HOP_BY_HOP.has(k.toLowerCase())) outHeaders[k] = v;
      }
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.statusMessage, outHeaders);

      // Streaming zuverlässig am Response-Content-Type erkennen (SSE = event-stream).
      const contentType = String(upstreamRes.headers['content-type'] || '');
      const isStream = contentType.includes('text/event-stream');
      const extractor = providers.createUsageExtractor(provider, isStream);

      // Parallel-Tap: jeden Chunk in den Extraktor spiegeln. Das bremst den Fluss
      // nicht (feed ist billig) und pausiert mit der Pipe-Backpressure automatisch.
      upstreamRes.on('data', (chunk) => {
        try {
          extractor.feed(chunk);
        } catch {
          /* Tracking darf den Datenstrom nie stören */
        }
      });

      // Transparenter, byte-identischer Durchfluss zum Client (mit Backpressure).
      upstreamRes.pipe(res);

      // --- 5) Nach dem letzten Chunk: Kosten buchen und broadcasten ----------
      upstreamRes.on('end', () => {
        try {
          const usage = extractor.finalize();
          if (usage) {
            const cost = pricing.computeCost(usage);
            const state = spend.recordSpend(cost);
            enrichState(state, config);
            dashboard.broadcast(state);
          }
        } catch {
          /* Buchhaltung/Broadcast dürfen den Verkehr nie stören */
        }
      });

      upstreamRes.on('error', () => {
        // Fehler beim Lesen der Upstream-Antwort ⇒ Client-Verbindung beenden.
        res.destroy();
      });
    });

    // --- Fehlerfall: Upstream nicht erreichbar ⇒ 502 + Dashboard-Log --------
    upstreamReq.on('error', (err) => {
      const detail = err && (err.code || err.message) ? err.code || err.message : 'unbekannt';
      if (!responseStarted && !res.headersSent) {
        sendJson(res, 502, { error: `Upstream nicht erreichbar (${detail}).` });
      } else {
        res.destroy();
      }
      // Fehler-Event ans Dashboard-Log (rein informativ, best effort).
      try {
        const state = enrichState(spend.getState(), config);
        state.warning = `Upstream nicht erreichbar (${detail}).`;
        dashboard.broadcast(state);
      } catch {
        /* ignore */
      }
    });

    // Client bricht ab, bevor die Antwort fertig ist ⇒ Upstream-Anfrage aufräumen.
    res.on('close', () => {
      if (!res.writableFinished) upstreamReq.destroy();
    });
    res.on('error', () => {
      try {
        upstreamReq.destroy();
      } catch {
        /* ignore */
      }
    });

    if (outBody && outBody.length > 0) upstreamReq.write(outBody);
    upstreamReq.end();
  });
}

/**
 * Baut den Request-Listener mit gebundener Konfiguration.
 * @param {Object} config
 * @returns {(req: import('http').IncomingMessage, res: import('http').ServerResponse) => void}
 */
function makeListener(config) {
  return function listener(req, res) {
    // Verhindert unbehandelte 'error'-Events auf der Response (z. B. Client-Reset).
    res.on('error', () => {
      /* Verbindungsfehler werden pro Pfad behandelt; hier nur absichern */
    });

    const pathname = pathnameOf(req.url);

    switch (pathname) {
      case '/dashboard':
        return dashboard.serveDashboard(req, res);
      case '/events':
        return dashboard.serveEvents(req, res);
      case '/api/bypass':
        return dashboard.handleBypass(req, res, config);
      case '/':
        // Bequemer Einstieg: GET / leitet auf das Dashboard um.
        if (req.method === 'GET') {
          res.writeHead(302, { Location: '/dashboard' });
          res.end();
          return;
        }
        break;
      default:
        break;
    }

    return handleProxy(req, res, config);
  };
}

/**
 * Erstellt den HTTP-Server, seedet den Dashboard-Startzustand mit der LAUFENDEN
 * Konfiguration (damit ein früh verbundener Client sofort das echte Tageslimit
 * sieht) und startet ihn. Gebunden an 127.0.0.1 — der Proxy reicht API-Schlüssel
 * durch und soll daher nicht im Netzwerk exponiert sein.
 *
 * @param {Object} [config] Konfiguration; fehlt sie, wird config.json geladen.
 * @returns {import('http').Server}
 */
function startServer(config) {
  const cfg = config || loadConfig();

  // Preise vorwärmen (computeCost lädt sonst lazy nach; so wird die Datei früh gelesen).
  try {
    pricing.loadPricing();
  } catch {
    /* computeCost bleibt trotzdem funktionsfähig (leeres Mapping) */
  }

  const server = http.createServer(makeListener(cfg));

  // Dashboard-Startzustand seeden (noch keine Clients ⇒ setzt nur lastState).
  try {
    dashboard.broadcast(enrichState(spend.getState(), cfg));
  } catch {
    /* rein kosmetisch */
  }

  const port = cfg && Number.isFinite(cfg.port) ? cfg.port : DEFAULT_CONFIG.port;
  server.listen(port, '127.0.0.1');
  return server;
}

module.exports = { startServer, loadConfig };

// --- Direktstart (node src/proxy.js) ---------------------------------------
if (require.main === module) {
  const config = loadConfig();
  const server = startServer(config);

  server.on('listening', () => {
    const addr = server.address();
    const port = addr && typeof addr === 'object' ? addr.port : config.port;
    const limit = Number.isFinite(config.dailyLimitUSD) ? config.dailyLimitUSD.toFixed(2) : '∞';
    console.log('Claude Code Live Tracker läuft.');
    console.log(`  Dashboard:      http://localhost:${port}/dashboard`);
    console.log(`  Proxy-Endpunkt: http://localhost:${port}  (ANTHROPIC_BASE_URL / OPENAI_API_BASE hierauf zeigen)`);
    console.log(`  Tageslimit:     ${limit} USD`);
  });

  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error(`Port ${config.port} ist bereits belegt. Bitte in config.json einen freien Port setzen.`);
    } else {
      console.error(`Serverfehler: ${err && (err.code || err.message)}`);
    }
    process.exit(1);
  });
}
