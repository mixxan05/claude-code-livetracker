'use strict';

/**
 * src/dashboard.js — Dashboard-Schicht des Claude Code Live Trackers.
 *
 * Drei Aufgaben (siehe docs/contracts.md §3, `src/dashboard.js`):
 *   1. serveDashboard — liefert die statische Seite public/dashboard.html aus.
 *   2. serveEvents    — SSE-Endpunkt (/events): registriert den Client, sendet
 *                       SOFORT den aktuellen DashboardState (Replay) und deregistriert
 *                       ihn sauber, sobald die Verbindung schließt.
 *   3. handleBypass   — POST /api/bypass {active:boolean}: schaltet den Budget-Bypass
 *                       (budget.setBypass) und broadcastet den neuen Stand.
 *   4. broadcast      — schickt einen DashboardState als SSE-`data:`-Event an ALLE
 *                       registrierten Clients (getrennte werden entfernt).
 *
 * OBERSTES PRINZIP: Das Dashboard ist reine Beobachtung. Ein Fehler hier darf weder
 * den durchgereichten API-Verkehr noch den Proxy-Prozess stören — deshalb ist jede
 * I/O-Operation defensiv gekapselt.
 *
 * Zustandsbildung: spend.js kennt weder config.json noch die `.budget-bypass`-Datei
 * und liefert daher `dailyLimitUSD: 0` und `bypassActive: false`. Diese Schicht
 * ergänzt beide Felder — `dailyLimitUSD` aus der (laufenden) Konfiguration,
 * `bypassActive` aus budget.isBypassActive(). Siehe docs/contracts.md §1.
 *
 * Ausschließlich Node-stdlib (http via Aufrufer, fs, path). Keine Dependencies.
 */

const fs = require('fs');
const path = require('path');

const spend = require('./spend');
const budget = require('./budget');

/** Pfad zur statischen Dashboard-Seite (Projekt-Root/public, unabhängig vom cwd). */
const DASHBOARD_HTML_PATH = path.join(__dirname, '..', 'public', 'dashboard.html');

/** Pfad zur config.json — nur als Rückfall für das Tageslimit im Replay (s. u.). */
const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

/**
 * Registrierte SSE-Clients (jeweils die http.ServerResponse). Ein Set garantiert
 * Eindeutigkeit und erlaubt effizientes Hinzufügen/Entfernen bei Verbindungsende.
 * @type {Set<import('http').ServerResponse>}
 */
const clients = new Set();

/**
 * Zuletzt gebroadcasteter DashboardState. Dient zwei Zwecken:
 *   - schneller Replay-Wert für neu verbundene Clients,
 *   - Quelle für das aktuell gültige Tageslimit (aus der LAUFENDEN Konfiguration,
 *     die der Proxy beim Start einmalig seedet) und die letzte Warnung.
 * @type {import('./spend').DashboardState|null}
 */
let lastState = null;

/** Intervall (ms) für den SSE-Heartbeat — hält Verbindungen über Proxys/Timeouts wach. */
const HEARTBEAT_MS = 25000;

/** Maximale akzeptierte Body-Größe für /api/bypass (Schutz vor endlosem Puffern). */
const MAX_BYPASS_BODY = 64 * 1024;

/** Gecachte config.json (nur Rückfall). `undefined` = noch nicht versucht. */
let _configFallback;

/**
 * Liest die config.json einmalig als Rückfall ein (v. a. für das Tageslimit im
 * Replay, falls der Proxy noch keinen Startzustand geseedet hat). Fehlt/korrupt ⇒
 * leeres Objekt. Wirft nie.
 * @returns {Object}
 */
function loadConfigFallback() {
  if (_configFallback !== undefined) return _configFallback;
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    _configFallback = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    _configFallback = {};
  }
  return _configFallback;
}

/**
 * Baut einen vollständigen DashboardState: Session-/Tageswerte aus spend.js,
 * ergänzt um `dailyLimitUSD` (aus der übergebenen bzw. der Rückfall-Konfiguration)
 * und `bypassActive` (frisch aus budget.isBypassActive()). Wirft nie.
 *
 * @param {Object|null} [config] Laufende Konfiguration; fehlt sie, greift config.json.
 * @returns {import('./spend').DashboardState}
 */
function composeState(config) {
  let state;
  try {
    state = spend.getState();
  } catch {
    // spend darf zwar nie werfen; rein defensiv ein neutraler Zustand.
    state = {
      sessionCostUSD: 0, sessionInputTokens: 0, sessionOutputTokens: 0,
      todayCostUSD: 0, dailyLimitUSD: 0, bypassActive: false,
      lastRequest: null, warning: null,
    };
  }

  const cfg = config || loadConfigFallback();
  if (cfg && Number.isFinite(cfg.dailyLimitUSD)) {
    state.dailyLimitUSD = cfg.dailyLimitUSD;
  }
  try {
    state.bypassActive = budget.isBypassActive();
  } catch {
    state.bypassActive = false;
  }
  return state;
}

/**
 * Ermittelt den Zustand für den Replay an einen frisch verbundenen Client.
 * Session-/Tages-/Bypass-Werte werden IMMER frisch berechnet (spiegelt auch
 * manuelle Änderungen an der `.budget-bypass`-Datei wider); das Tageslimit wird
 * bevorzugt aus dem geseedeten `lastState` (= laufende Konfiguration) übernommen,
 * sonst aus der Rückfall-Konfiguration.
 * @returns {import('./spend').DashboardState}
 */
function buildReplayState() {
  const state = composeState(null);
  if (lastState && Number.isFinite(lastState.dailyLimitUSD)) {
    state.dailyLimitUSD = lastState.dailyLimitUSD;
  }
  // Die zuletzt gebroadcastete Warnung mitgeben, falls vorhanden.
  if (lastState && typeof lastState.warning === 'string' && !state.warning) {
    state.warning = lastState.warning;
  }
  return state;
}

/**
 * Serialisiert einen DashboardState als ein einzelnes SSE-`data:`-Event.
 * JSON.stringify erzeugt keine echten Zeilenumbrüche (Umbrüche in Strings werden
 * als `\n` escaped) — die Payload bleibt also garantiert einzeilig und SSE-sicher.
 * @param {Object} state
 * @returns {string}
 */
function toSseFrame(state) {
  return `data: ${JSON.stringify(state)}\n\n`;
}

/**
 * Schreibt einen Frame defensiv an einen Client. Liefert `false`, wenn der Client
 * offensichtlich tot ist (bereits beendet/zerstört oder Schreibfehler) — der
 * Aufrufer entfernt ihn dann aus der Client-Liste.
 * @param {import('http').ServerResponse} res
 * @param {string} frame
 * @returns {boolean}
 */
function safeWrite(res, frame) {
  try {
    if (res.writableEnded || res.destroyed) return false;
    res.write(frame);
    return true;
  } catch {
    return false;
  }
}

// --- Öffentliche API (Contract-Signaturen, exakt) --------------------------

/**
 * Liefert die statische Dashboard-Seite (public/dashboard.html) aus. Setzt eine
 * strenge, aber inline-freundliche Content-Security-Policy: keinerlei externe
 * Ressourcen, nur Inline-CSS/JS, EventSource/fetch ausschließlich zur eigenen
 * Herkunft (`connect-src 'self'`) und data:-Bilder. Fehlt die Datei ⇒ 500.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @returns {void}
 */
function serveDashboard(req, res) {
  fs.readFile(DASHBOARD_HTML_PATH, (err, data) => {
    if (err) {
      const msg = 'Dashboard-Seite konnte nicht geladen werden (public/dashboard.html fehlt).';
      res.writeHead(500, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': Buffer.byteLength(msg),
      });
      res.end(msg);
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
      'Content-Security-Policy':
        "default-src 'none'; " +
        "style-src 'unsafe-inline'; " +
        "script-src 'unsafe-inline'; " +
        "connect-src 'self'; " +
        "img-src data:; " +
        "base-uri 'none'; " +
        "form-action 'none'",
    });
    res.end(data);
  });
}

/**
 * SSE-Endpunkt (/events). Setzt die Event-Stream-Header, registriert den Client,
 * sendet SOFORT den aktuellen DashboardState (Replay) und hält die Verbindung mit
 * einem leichten Heartbeat wach. Bei Verbindungsende wird der Client sauber aus der
 * Broadcast-Liste entfernt und der Heartbeat gestoppt.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @returns {void}
 */
function serveEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Verhindert Zwischenpufferung durch (reverse) Proxys — SSE muss sofort fließen.
    'X-Accel-Buffering': 'no',
  });

  // Empfohlener Reconnect-Abstand für den Browser-EventSource.
  safeWrite(res, 'retry: 3000\n\n');

  clients.add(res);

  // Sofortiger Replay des aktuellen Standes.
  safeWrite(res, toSseFrame(buildReplayState()));

  // Heartbeat als SSE-Kommentarzeile (`:`) — vom Client ignoriert, hält die
  // Verbindung offen. `unref()` verhindert, dass der Timer den Prozess am Leben hält.
  const heartbeat = setInterval(() => {
    if (!safeWrite(res, ': ping\n\n')) cleanup();
  }, HEARTBEAT_MS);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  let cleanedUp = false;
  function cleanup() {
    if (cleanedUp) return;
    cleanedUp = true;
    clearInterval(heartbeat);
    clients.delete(res);
  }

  // Verbindungsende aus jeder Richtung sauber behandeln.
  res.on('close', cleanup);
  res.on('error', cleanup);
  req.on('close', cleanup);
  req.on('error', cleanup);
}

/**
 * POST /api/bypass — schaltet den Budget-Bypass per Mausklick.
 *
 * Erwartet den JSON-Body `{ "active": true|false }`. Bei true wird die
 * `.budget-bypass`-Datei angelegt (Tageslimit ignoriert), bei false entfernt.
 * Danach wird der neue DashboardState an alle SSE-Clients gebroadcastet.
 *
 * Fehlerfälle: falsche Methode ⇒ 405; ungültiger/zu großer Body ⇒ 400. Der
 * Kontroll-Endpunkt darf natürlich mit klaren Fehlern antworten — das betrifft
 * nicht den durchgereichten API-Verkehr.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {Object} config Laufende Konfiguration (liefert u. a. dailyLimitUSD).
 * @returns {void}
 */
function handleBypass(req, res, config) {
  if (req.method !== 'POST') {
    const body = JSON.stringify({ error: 'Nur POST wird für /api/bypass unterstützt.' });
    res.writeHead(405, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      Allow: 'POST',
    });
    res.end(body);
    return;
  }

  const chunks = [];
  let size = 0;
  let aborted = false;

  req.on('data', (chunk) => {
    if (aborted) return;
    size += chunk.length;
    if (size > MAX_BYPASS_BODY) {
      aborted = true;
      const body = JSON.stringify({ error: 'Body zu groß.' });
      res.writeHead(413, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
      });
      res.end(body);
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on('error', () => {
    aborted = true;
  });

  req.on('end', () => {
    if (aborted) return;

    let active;
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (parsed && typeof parsed.active === 'boolean') active = parsed.active;
    } catch {
      active = undefined;
    }

    if (typeof active !== 'boolean') {
      const body = JSON.stringify({
        error: 'Ungültiger Body. Erwartet wird {"active": true} oder {"active": false}.',
      });
      res.writeHead(400, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }

    // Bypass schalten (idempotent, wirft nie).
    budget.setBypass(active);

    // Neuen Stand ermitteln und an den POST-Aufrufer sowie alle SSE-Clients melden.
    const state = composeState(config);
    const body = JSON.stringify({ ok: true, bypassActive: state.bypassActive });
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);

    broadcast(state);
  });
}

/**
 * Broadcastet einen DashboardState als SSE-`data:`-Event an alle registrierten
 * Clients. Merkt sich den Zustand als `lastState` (Replay-Quelle) und entfernt
 * dabei tote Clients aus der Liste. Wirft nie.
 *
 * @param {import('./spend').DashboardState} state
 * @returns {void}
 */
function broadcast(state) {
  lastState = state;
  const frame = toSseFrame(state);
  for (const res of clients) {
    if (!safeWrite(res, frame)) {
      clients.delete(res);
    }
  }
}

module.exports = { serveDashboard, serveEvents, handleBypass, broadcast };
