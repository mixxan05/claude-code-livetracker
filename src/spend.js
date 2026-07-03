'use strict';

/**
 * src/spend.js — Persistenz & Aggregation der Verbrauchsdaten.
 *
 * Zwei getrennte Ebenen der Buchführung:
 *   1. Session → laufende Proxy-Session. Wird In-Memory gehalten UND nach
 *      `session-spend.json` gespiegelt. Überlebt einen Neustart (Resume aus der
 *      Datei); die Session-Datei läuft unabhängig vom Kalendertag weiter.
 *   2. Tag → Tagesaggregat je Kalendertag in `spend-YYYY-MM-DD.json`
 *      (Datum LOKAL, nicht UTC). Neuer Tag ⇒ neuer Dateiname (Rollover), die
 *      heutige Summe beginnt dadurch automatisch wieder bei 0.
 *
 * Oberstes Prinzip: Die Buchhaltung darf den durchgereichten API-Verkehr niemals
 * brechen. Korrupte oder fehlende Dateien werden als leer behandelt und beim
 * nächsten Schreiben neu angelegt — es wird nie geworfen. API-Keys o. Ä. werden
 * NIE persistiert: gespeichert werden ausschließlich die bekannten Felder eines
 * CostBreakdown (Whitelist in `sanitizeBreakdown`).
 *
 * Datenverzeichnis: Standard ist `process.cwd()`. Über die Umgebungsvariable
 * `CCLT_DATA_DIR` lässt es sich umlenken — v. a. für Tests, damit das Projekt-Root
 * nicht verschmutzt wird. Die exportierten Signaturen bleiben unverändert.
 * Siehe docs/contracts.md (§3, `src/spend.js`).
 *
 * Typen (@typedef in docs/contracts.md §1): {NormalizedUsage}, {CostBreakdown},
 * {DashboardState}.
 */

const fs = require('fs');
const path = require('path');

/** Name der Umgebungsvariable, mit der das Datenverzeichnis umgelenkt wird. */
const DATA_DIR_ENV = 'CCLT_DATA_DIR';

/** Dateiname der Session-Buchhaltung (im Datenverzeichnis). */
const SESSION_FILE = 'session-spend.json';

/**
 * In-Memory-Spiegel der laufenden Session. Wird lazy aus `session-spend.json`
 * geladen. Merkt sich das Verzeichnis, aus dem geladen wurde: wechselt das
 * Datenverzeichnis (z. B. zwischen zwei Tests), wird automatisch neu eingelesen.
 * @type {{dir:string, costUSD:number, inputTokens:number, outputTokens:number, lastRequest:(object|null)}|null}
 */
let _session = null;

/**
 * Liefert das aktuelle Datenverzeichnis. Bewusst lazy (pro Aufruf ausgewertet),
 * damit Tests die Umgebungsvariable jederzeit setzen bzw. entfernen können.
 * @returns {string}
 */
function dataDir() {
  const fromEnv = process.env[DATA_DIR_ENV];
  return fromEnv && fromEnv.length > 0 ? fromEnv : process.cwd();
}

/**
 * Lokales Datum als "YYYY-MM-DD" (LOKALE Zeitzone, nicht UTC!). Grundlage für den
 * Namen der Tagesdatei — dadurch erfolgt der Tageswechsel zum lokalen Mitternacht.
 * @param {Date} [d=new Date()]
 * @returns {string}
 */
function localDateStr(d = new Date()) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Voller Pfad der Tagesdatei für ein bestimmtes lokales Datum im Datenverzeichnis.
 * @param {string} [dir=dataDir()]
 * @param {string} [dateStr=localDateStr()]
 * @returns {string}
 */
function dailyFilePath(dir = dataDir(), dateStr = localDateStr()) {
  return path.join(dir, `spend-${dateStr}.json`);
}

/**
 * Wandelt einen beliebigen Wert robust in eine endliche Zahl ≥ 0 um.
 * Ungültige/negative/NaN-/Infinity-Werte ⇒ 0. Schützt die Aggregation vor
 * kaputten Eingaben (Kosten und Tokens sind immer nicht-negativ).
 * @param {*} v
 * @returns {number}
 */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Liest eine JSON-Datei und liefert das geparste Objekt — oder `null` bei
 * fehlender, korrupter oder nicht-objektartiger Datei. Wirft nie.
 * @param {string} file
 * @returns {object|null}
 */
function readJsonSafe(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    // Nur echte Objekte akzeptieren (kein Array, kein null, kein Skalar).
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
    return null;
  } catch {
    // Datei fehlt oder JSON ist kaputt ⇒ als leer behandeln.
    return null;
  }
}

/**
 * Schreibt ein Objekt als formatiertes JSON (UTF-8) und legt das Datenverzeichnis
 * bei Bedarf an. Schreibfehler werden bewusst verschluckt — die Buchhaltung darf
 * den durchgereichten Verkehr niemals stören.
 * @param {string} file
 * @param {object} obj
 */
function writeJsonSafe(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
  } catch {
    // Absichtlich geschluckt: ein Schreibfehler darf nichts brechen.
  }
}

/**
 * Ein CostBreakdown mit Nullwerten (neutrales Standard-Objekt).
 * @returns {CostBreakdown}
 */
function emptyBreakdown() {
  return { model: '', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUSD: 0, warning: null };
}

/**
 * Reduziert einen (evtl. fremden) CostBreakdown auf die bekannten, sicheren
 * Felder — eine Whitelist. Verhindert, dass versehentlich zusätzliche Daten
 * (z. B. API-Keys oder Header) persistiert werden. Zahlenfelder werden robust
 * normalisiert.
 * @param {*} cb
 * @param {boolean} [allowNull=false]  Wenn true und `cb` leer/ungültig ⇒ `null`.
 * @returns {CostBreakdown|null}
 */
function sanitizeBreakdown(cb, allowNull = false) {
  if (!cb || typeof cb !== 'object') {
    return allowNull ? null : emptyBreakdown();
  }
  return {
    model: typeof cb.model === 'string' ? cb.model : '',
    inputTokens: num(cb.inputTokens),
    outputTokens: num(cb.outputTokens),
    cacheReadTokens: num(cb.cacheReadTokens),
    costUSD: num(cb.costUSD),
    warning: typeof cb.warning === 'string' ? cb.warning : null,
  };
}

/**
 * Lädt die Session-Werte aus `session-spend.json` des angegebenen Verzeichnisses.
 * Fehlt/korrupt ⇒ leere Session (alle Werte 0, lastRequest null).
 * @param {string} dir
 * @returns {{costUSD:number, inputTokens:number, outputTokens:number, lastRequest:(object|null)}}
 */
function loadSession(dir) {
  const data = readJsonSafe(path.join(dir, SESSION_FILE));
  if (!data) {
    return { costUSD: 0, inputTokens: 0, outputTokens: 0, lastRequest: null };
  }
  return {
    costUSD: num(data.costUSD),
    inputTokens: num(data.inputTokens),
    outputTokens: num(data.outputTokens),
    lastRequest: sanitizeBreakdown(data.lastRequest, /* allowNull = */ true),
  };
}

/**
 * Stellt sicher, dass der In-Memory-Session-Spiegel zum aktuellen Datenverzeichnis
 * passt. Beim ersten Zugriff oder nach einem Verzeichniswechsel wird aus der Datei
 * geladen (Resume bei Neustart; Isolation zwischen Tests).
 * @returns {{dir:string, costUSD:number, inputTokens:number, outputTokens:number, lastRequest:(object|null)}}
 */
function ensureSession() {
  const dir = dataDir();
  if (!_session || _session.dir !== dir) {
    _session = Object.assign({ dir }, loadSession(dir));
  }
  return _session;
}

/**
 * Baut aus Session-Spiegel und heutiger Tagessumme einen DashboardState.
 *
 * Hinweis: `dailyLimitUSD` (aus config.json) und `bypassActive` (aus der
 * `.budget-bypass`-Datei) sind spend.js NICHT bekannt. Sie werden mit neutralen
 * Defaults belegt (`0` bzw. `false`) und von der Budget-/Dashboard-Schicht
 * ergänzt. Siehe docs/contracts.md §1/§3.
 *
 * @param {{costUSD:number, inputTokens:number, outputTokens:number, lastRequest:(object|null)}} s
 * @param {number} todayCostUSD
 * @returns {DashboardState}
 */
function buildState(s, todayCostUSD) {
  const last = s.lastRequest;
  return {
    sessionCostUSD: s.costUSD,
    sessionInputTokens: s.inputTokens,
    sessionOutputTokens: s.outputTokens,
    todayCostUSD: num(todayCostUSD),
    dailyLimitUSD: 0,          // wird von der Budget-/Dashboard-Schicht aus config ergänzt
    bypassActive: false,       // wird von der Budget-Schicht (isBypassActive) ergänzt
    lastRequest: last,
    warning: last && typeof last.warning === 'string' ? last.warning : null,
  };
}

// --- Öffentliche API (Contract-Signaturen, exakt) --------------------------

/**
 * Verbucht eine abgeschlossene Anfrage: addiert Kosten/Tokens sowohl auf die
 * Session (In-Memory-Spiegel + `session-spend.json`) als auch auf das heutige
 * Tagesaggregat (`spend-YYYY-MM-DD.json`, lokales Datum). Liefert den neuen
 * DashboardState inkl. `lastRequest` (= der übergebene CostBreakdown, auf die
 * sicheren Felder reduziert).
 *
 * @param {CostBreakdown} costBreakdown
 * @returns {DashboardState}
 */
function recordSpend(costBreakdown) {
  // Niemals fremde Felder übernehmen (kein API-Key gelangt je in eine Datei).
  const cb = sanitizeBreakdown(costBreakdown);

  // 1) Session aktualisieren: In-Memory-Spiegel + Datei schreiben.
  const s = ensureSession();
  const dir = s.dir; // identisch zu dataDir(); garantiert dieselbe Ablage für Tag & Session
  s.costUSD += cb.costUSD;
  s.inputTokens += cb.inputTokens;
  s.outputTokens += cb.outputTokens;
  s.lastRequest = cb;
  writeJsonSafe(path.join(dir, SESSION_FILE), {
    costUSD: s.costUSD,
    inputTokens: s.inputTokens,
    outputTokens: s.outputTokens,
    lastRequest: s.lastRequest,
  });

  // 2) Heutiges Tagesaggregat aktualisieren. Die Datei ist die Quelle der Wahrheit
  //    (cross-process-fest für den Budget-Guard). Korrupt/fehlend ⇒ frisch bei 0.
  const dateStr = localDateStr();
  const dailyPath = dailyFilePath(dir, dateStr);
  const prev = readJsonSafe(dailyPath) || {};
  const daily = {
    date: dateStr,
    costUSD: num(prev.costUSD) + cb.costUSD,
    inputTokens: num(prev.inputTokens) + cb.inputTokens,
    outputTokens: num(prev.outputTokens) + cb.outputTokens,
    cacheReadTokens: num(prev.cacheReadTokens) + cb.cacheReadTokens,
    requestCount: num(prev.requestCount) + 1,
  };
  writeJsonSafe(dailyPath, daily);

  return buildState(s, daily.costUSD);
}

/**
 * Aktueller Stand als DashboardState: Session-Werte (In-Memory-Spiegel) plus
 * heutige Tagessumme (aus der Tagesdatei). `bypassActive` bleibt `false` und
 * `dailyLimitUSD` bleibt `0` (siehe buildState / docs/contracts.md).
 * @returns {DashboardState}
 */
function getState() {
  const s = ensureSession();
  return buildState(s, getTodayTotalUSD());
}

/**
 * Kumulierte Kosten des HEUTIGEN Tages (USD, lokales Datum) aus der Tagesdatei.
 * Fehlt/korrupt ⇒ 0. Wird u. a. vom Budget-Guard (`budget.isBlocked`) genutzt.
 * @returns {number}
 */
function getTodayTotalUSD() {
  const data = readJsonSafe(dailyFilePath());
  return data ? num(data.costUSD) : 0;
}

module.exports = { recordSpend, getState, getTodayTotalUSD };
