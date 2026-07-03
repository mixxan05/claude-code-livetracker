'use strict';

/**
 * budget.js — Budget-Guard & Bypass-Handling für den Claude Code Live Tracker.
 *
 * Aufgabe: Vor jedem durchgereichten Request entscheidet der Proxy anhand von
 * {@link isBlocked}, ob das Tageslimit erreicht ist. Über eine simple Marker-Datei
 * (`.budget-bypass` im Arbeitsverzeichnis) lässt sich der Schutz per Mausklick
 * (Dashboard) oder manuell (Datei anlegen/löschen) aufheben.
 *
 * OBERSTES PRINZIP: Das Tracking darf den Traffic NIEMALS brechen. Kann die
 * Tagessumme nicht ermittelt werden (spend.js fehlt/liefert einen Fehler), wird sie
 * als 0 behandelt (fail-open) — im Zweifel wird NICHT blockiert.
 *
 * Contract (docs/contracts.md) — exakt diese drei Exporte:
 *   isBypassActive() -> boolean
 *   setBypass(active) -> void
 *   isBlocked(config) -> boolean
 */

const fs = require('fs');
const path = require('path');

/** Dateiname der Bypass-Marker-Datei (liegt im Arbeitsverzeichnis, process.cwd()). */
const BYPASS_DATEINAME = '.budget-bypass';

/** Menschenlesbarer Inhalt der Marker-Datei — erklärt einem Betrachter ihren Zweck. */
const BYPASS_INHALT =
  'Budget-Bypass aktiv.\n' +
  'Solange diese Datei existiert, ignoriert der Claude Code Live Tracker das Tageslimit.\n' +
  'Datei löschen (oder den Dashboard-Button erneut drücken), um die Sperre zu reaktivieren.\n';

/**
 * Absoluter Pfad der Bypass-Datei im aktuellen Arbeitsverzeichnis.
 * Bewusst pro Aufruf frisch berechnet, damit ein Wechsel des Arbeitsverzeichnisses
 * (z. B. in Tests via process.chdir) korrekt berücksichtigt wird.
 * @returns {string}
 */
function bypassPfad() {
  return path.join(process.cwd(), BYPASS_DATEINAME);
}

/**
 * Ermittelt die kumulierte Tagessumme (USD) aus spend.js — robust und fail-open.
 *
 * spend.js wird BEWUSST erst hier (lazy) geladen, nicht am Modulkopf. Das:
 *  - entkoppelt die Lade-Reihenfolge von budget.js und spend.js (die Module entstehen
 *    unabhängig/parallel),
 *  - verhindert, dass ein Fehler in spend.js schon das Laden von budget.js sprengt,
 *  - und stellt sicher, dass ein Tracking-Fehler NIE zu einer Blockade führt.
 *
 * @returns {number} Tagessumme in USD, oder 0 wenn nicht ermittelbar.
 */
function tagessummeUSD() {
  try {
    const spend = require('./spend');
    const wert = spend.getTodayTotalUSD();
    // Nur endliche Zahlen akzeptieren; alles andere defensiv als 0 werten.
    return Number.isFinite(wert) ? wert : 0;
  } catch (_) {
    // spend.js (noch) nicht vorhanden oder Lesefehler => wie "leer" behandeln.
    return 0;
  }
}

/**
 * Ist der Budget-Bypass aktiv? (Existiert die Marker-Datei `.budget-bypass`?)
 * @returns {boolean}
 */
function isBypassActive() {
  try {
    return fs.existsSync(bypassPfad());
  } catch (_) {
    // existsSync wirft praktisch nie; rein defensiv => im Zweifel "kein Bypass".
    return false;
  }
}

/**
 * Aktiviert bzw. deaktiviert den Bypass, indem die Marker-Datei angelegt oder
 * entfernt wird. Idempotent: doppeltes Aktivieren/Deaktivieren ist kein Fehler.
 *
 * Best effort: Ein fehlgeschlagener Datei-Zugriff darf das Dashboard nicht crashen —
 * daher wird ein Fehler nur als Warnung protokolliert, nicht geworfen.
 *
 * @param {boolean} active true => Bypass anlegen, false => Bypass entfernen.
 * @returns {void}
 */
function setBypass(active) {
  const pfad = bypassPfad();
  try {
    if (active) {
      // Erneutes Schreiben überschreibt nur den Inhalt — unkritisch (idempotent).
      fs.writeFileSync(pfad, BYPASS_INHALT, 'utf8');
    } else {
      // force:true ignoriert eine bereits fehlende Datei (idempotent, kein Wurf).
      fs.rmSync(pfad, { force: true });
    }
  } catch (err) {
    console.error(
      `[budget] Bypass-Datei konnte nicht ${active ? 'angelegt' : 'entfernt'} werden: ${err.message}`
    );
  }
}

/**
 * Ist der Traffic aktuell zu blockieren?
 *
 * Blockiert genau dann, wenn die Tagessumme das Limit erreicht/überschreitet UND
 * KEIN Bypass aktiv ist. In allen anderen Fällen (Bypass aktiv, unter Limit, Limit
 * unbekannt/ungültig, Tagessumme nicht ermittelbar) => false.
 *
 * @param {{dailyLimitUSD?: number}} config Konfiguration mit Tageslimit in USD.
 * @returns {boolean}
 */
function isBlocked(config) {
  // Bypass hat Vorrang: aktiv => niemals blockieren (spart zudem den spend-Zugriff).
  if (isBypassActive()) return false;

  // Nur ein endliches Limit kann blockieren; sonst fail-open (nie blockieren).
  const limit =
    config && Number.isFinite(config.dailyLimitUSD) ? config.dailyLimitUSD : Infinity;

  return tagessummeUSD() >= limit;
}

module.exports = { isBypassActive, setBypass, isBlocked };
