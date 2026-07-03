'use strict';

/**
 * src/pricing.js — Preis-Engine des Claude Code Live Trackers.
 *
 * Aufgabe: Wandelt eine provider-unabhängige {@link NormalizedUsage} in einen
 * {@link CostBreakdown} um. Die Modell-Preise stammen aus `pricing.json`
 * (Preis pro 1 Mio. Tokens in USD).
 *
 * Oberstes Prinzip (siehe docs/contracts.md): Das Tracking darf den
 * durchgereichten API-Verkehr NIEMALS brechen oder verzögern. Dieses Modul ist
 * deshalb bewusst fehlertolerant:
 *   - fehlende/korrupte pricing.json   → leeres Mapping statt Absturz
 *   - unbekanntes Modell               → Kosten 0 + aussagekräftige Warnung
 *   - fehlende/ungültige Token-Werte   → als 0 behandelt (nie NaN in den Kosten)
 *
 * Ausschließlich Node-stdlib (fs, path). Keine externen Dependencies.
 */

const fs = require('fs');
const path = require('path');

/**
 * Normalisierte, provider-unabhängige Token-Nutzung einer einzelnen Anfrage.
 * Alle Felder sind Zahlen ≥ 0. Fehlende Werte gelten als 0.
 *
 * @typedef {Object} NormalizedUsage
 * @property {string} model                  Modell-ID, z. B. "claude-opus-4-8" oder "gpt-4o".
 * @property {number} inputTokens            Reine Eingabe-Tokens (ohne Cache-Anteile).
 * @property {number} outputTokens           Ausgabe-Tokens (bei Streaming der finale, kumulative Wert).
 * @property {number} cacheCreation5mTokens  In den 5-Minuten-Cache geschriebene Tokens.
 * @property {number} cacheCreation1hTokens  In den 1-Stunden-Cache geschriebene Tokens.
 * @property {number} cacheReadTokens        Aus dem Cache gelesene Tokens.
 */

/**
 * Ergebnis der Kostenberechnung. `costUSD` enthält die Summe ALLER
 * Kostenkomponenten (input, output, cacheWrite5m, cacheWrite1h, cacheRead);
 * die einzeln ausgewiesenen Token-Felder dienen der Anzeige im Dashboard.
 *
 * @typedef {Object} CostBreakdown
 * @property {string}      model            Modell-ID.
 * @property {number}      inputTokens      Eingabe-Tokens (zur Anzeige).
 * @property {number}      outputTokens     Ausgabe-Tokens (zur Anzeige).
 * @property {number}      cacheReadTokens  Cache-Read-Tokens (zur Anzeige).
 * @property {number}      costUSD          Gesamtkosten in USD (0 bei unbekanntem Modell).
 * @property {string|null} warning          Warnhinweis (z. B. unbekanntes Modell) oder null.
 */

/**
 * Preis-Eintrag eines Modells in pricing.json — USD pro 1 Mio. Tokens.
 *
 * @typedef {Object} ModelPrice
 * @property {number} input         Preis je 1M Eingabe-Tokens.
 * @property {number} output        Preis je 1M Ausgabe-Tokens.
 * @property {number} cacheWrite5m  Preis je 1M in den 5m-Cache geschriebene Tokens.
 * @property {number} cacheWrite1h  Preis je 1M in den 1h-Cache geschriebene Tokens.
 * @property {number} cacheRead     Preis je 1M aus dem Cache gelesene Tokens.
 */

// Eine Million — Preise sind pro 1 Mio. Tokens angegeben.
const TOKENS_PER_MILLION = 1e6;

// Standard-Pfad zur pricing.json (Projekt-Root, eine Ebene über src/).
// Über __dirname aufgelöst und damit unabhängig vom Arbeitsverzeichnis.
const DEFAULT_PRICING_PATH = path.join(__dirname, '..', 'pricing.json');

// Cache je absolutem Pfad → geparstes Preis-Mapping. Verhindert wiederholtes
// Einlesen derselben Datei (Contract: "lädt + cached").
const pricingCacheByPath = new Map();

// Zuletzt geladenes Preis-Mapping. computeCost() nutzt genau dieses Mapping,
// damit die Contract-Signatur `computeCost(normalizedUsage)` ohne zusätzlichen
// Preis-Parameter auskommt.
let activePricing = null;

/**
 * Wandelt einen beliebigen Wert defensiv in eine nicht-negative, endliche Zahl.
 * Ungültige Werte (undefined, null, NaN, negativ, ±Infinity) werden zu 0 — so
 * entstehen niemals NaN-Kosten, die Spend-Persistenz und Dashboard vergiften
 * würden.
 *
 * @param {*} value
 * @returns {number} Zahl ≥ 0 (0 als sicherer Ersatz für ungültige Eingaben).
 */
function toNonNegativeNumber(value) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Lädt die pricing.json und cached das Ergebnis pro Pfad.
 *
 * Verhalten:
 *   - Erster Aufruf für einen Pfad: Datei lesen + JSON parsen, Ergebnis cachen.
 *   - Weitere Aufrufe mit demselben Pfad: liefern das gecachte Objekt (selbe
 *     Referenz), ohne die Datei erneut zu lesen.
 *   - Fehlende oder korrupte Datei: liefert ein leeres Mapping `{}` (nie Absturz).
 *     Jedes Modell gilt dann als "unbekannt" → computeCost gibt 0 + Warnung.
 *
 * Der geladene Stand wird zusätzlich als "aktives" Mapping gesetzt, das
 * computeCost() ohne Preis-Parameter verwendet.
 *
 * @param {string} [pricingPath] Pfad zur pricing.json. Fehlt er, wird die
 *                               Standard-Datei im Projekt-Root verwendet.
 * @returns {Object<string, ModelPrice>} Modell-ID → Preis-Eintrag.
 */
function loadPricing(pricingPath) {
  const absPath = path.resolve(pricingPath || DEFAULT_PRICING_PATH);

  // Cache-Treffer: bereits geladen → als aktives Mapping setzen und zurückgeben.
  if (pricingCacheByPath.has(absPath)) {
    activePricing = pricingCacheByPath.get(absPath);
    return activePricing;
  }

  let pricing;
  try {
    const raw = fs.readFileSync(absPath, 'utf8');
    const parsed = JSON.parse(raw);
    // Nur ein echtes Objekt akzeptieren (kein Array, kein null, kein Skalar).
    pricing =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed
        : {};
  } catch (err) {
    // Datei fehlt oder ist kein gültiges JSON → leeres Mapping, damit das
    // Tracking robust weiterläuft (Kosten 0 + Warnung statt Absturz).
    pricing = {};
  }

  pricingCacheByPath.set(absPath, pricing);
  activePricing = pricing;
  return pricing;
}

/**
 * Berechnet die Kosten einer Anfrage aus ihrer normalisierten Nutzung.
 *
 * Formel (USD):
 *   costUSD = inputTokens           / 1e6 * preis.input
 *           + outputTokens          / 1e6 * preis.output
 *           + cacheCreation5mTokens / 1e6 * preis.cacheWrite5m
 *           + cacheCreation1hTokens / 1e6 * preis.cacheWrite1h
 *           + cacheReadTokens       / 1e6 * preis.cacheRead
 *
 * Ist noch kein Preis-Mapping geladen, wird die Standard-pricing.json lazy
 * nachgeladen. Unbekanntes (oder fehlendes) Modell → costUSD 0 + Warnung; die
 * Anzeige-Tokenzahlen werden dennoch durchgereicht. Diese Funktion wirft nie.
 *
 * @param {NormalizedUsage} normalizedUsage
 * @returns {CostBreakdown}
 */
function computeCost(normalizedUsage) {
  // Defensive Absicherung: computeCost darf unter keinen Umständen werfen,
  // damit der durchgereichte Traffic nie durch die Kostenberechnung bricht.
  const usage =
    normalizedUsage && typeof normalizedUsage === 'object'
      ? normalizedUsage
      : {};

  // Falls noch nie Preise geladen wurden: Standard-Datei lazy nachladen.
  if (activePricing === null) {
    loadPricing();
  }

  const model = usage.model != null ? String(usage.model) : '';

  // Anzeige-Tokens defensiv als nicht-negative Zahlen aufbereiten.
  const inputTokens = toNonNegativeNumber(usage.inputTokens);
  const outputTokens = toNonNegativeNumber(usage.outputTokens);
  const cacheReadTokens = toNonNegativeNumber(usage.cacheReadTokens);
  const cacheCreation5mTokens = toNonNegativeNumber(usage.cacheCreation5mTokens);
  const cacheCreation1hTokens = toNonNegativeNumber(usage.cacheCreation1hTokens);

  const price = model ? activePricing[model] : undefined;

  // --- Unbekanntes oder fehlendes Modell -----------------------------------
  // Kosten 0 + Warnung; Anzeige-Tokens trotzdem durchreichen (Contract).
  if (!price || typeof price !== 'object') {
    const warning = model
      ? `Preis für Modell "${model}" unbekannt – Kosten als 0 USD verbucht. Bitte pricing.json ergänzen.`
      : 'Kein Modell in der Nutzungsangabe – Kosten als 0 USD verbucht.';
    return {
      model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      costUSD: 0,
      warning,
    };
  }

  // --- Bekanntes Modell: Kosten je Komponente (Tokens / 1e6 * Preis) --------
  // Preis-Felder ebenfalls defensiv coercen: ein fehlerhaft gepflegtes Feld in
  // pricing.json führt dann zu 0-Kosten für diese Komponente statt zu NaN.
  const costUSD =
    (inputTokens / TOKENS_PER_MILLION) * toNonNegativeNumber(price.input) +
    (outputTokens / TOKENS_PER_MILLION) * toNonNegativeNumber(price.output) +
    (cacheCreation5mTokens / TOKENS_PER_MILLION) *
      toNonNegativeNumber(price.cacheWrite5m) +
    (cacheCreation1hTokens / TOKENS_PER_MILLION) *
      toNonNegativeNumber(price.cacheWrite1h) +
    (cacheReadTokens / TOKENS_PER_MILLION) * toNonNegativeNumber(price.cacheRead);

  return {
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    costUSD,
    warning: null,
  };
}

module.exports = { loadPricing, computeCost };
