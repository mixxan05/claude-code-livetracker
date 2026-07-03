'use strict';

/**
 * test/pricing.test.js — Tests für die Preis-Engine (src/pricing.js).
 *
 * Ausgeführt mit Node's eigenem Runner: `node --test test/pricing.test.js`.
 * Keine Test-Dependencies (nur node:test + node:assert).
 *
 * Abgedeckt:
 *   - loadPricing: Caching (selbe Referenz + veralteter Wert), korrupte Datei,
 *     fehlende Datei → leeres Mapping.
 *   - computeCost: bekanntes Modell mit Cache-Tokens (Kosten exakt geprüft),
 *     reine Input/Output-Tokens, OpenAI-Modell, unbekanntes Modell → 0 + Warnung,
 *     sowie defensives Verhalten (fehlende Felder / null-Eingabe → kein NaN).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadPricing, computeCost } = require('../src/pricing.js');

// Echte, im Repo gepflegte pricing.json (Projekt-Root, eine Ebene über test/).
const REAL_PRICING_PATH = path.join(__dirname, '..', 'pricing.json');

/** Legt eine temporäre Datei mit gegebenem Inhalt an und liefert ihren Pfad. */
function writeTempFile(contents, suffix = '.json') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cclt-pricing-'));
  const file = path.join(dir, `pricing${suffix}`);
  fs.writeFileSync(file, contents, 'utf8');
  return file;
}

// --------------------------------------------------------------------------
// loadPricing
// --------------------------------------------------------------------------

test('loadPricing cached: selbe Referenz und liest die Datei nur einmal', () => {
  const file = writeTempFile(
    JSON.stringify({
      'test-model': {
        input: 1,
        output: 2,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        cacheRead: 0,
      },
    }),
  );

  const first = loadPricing(file);
  assert.equal(first['test-model'].input, 1);

  // Datei nach dem ersten Laden auf der Platte verändern …
  fs.writeFileSync(
    file,
    JSON.stringify({
      'test-model': {
        input: 999,
        output: 999,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        cacheRead: 0,
      },
    }),
    'utf8',
  );

  const second = loadPricing(file);
  // … der Cache-Treffer liefert dieselbe Objekt-Referenz …
  assert.equal(first === second, true, 'Cache-Treffer: identische Referenz');
  // … und damit den alten (gecachten) Wert, nicht den neuen von der Platte.
  assert.equal(second['test-model'].input, 1, 'gecachter Wert, nicht 999');
});

test('loadPricing bei korrupter Datei → leeres Mapping (kein Absturz)', () => {
  const file = writeTempFile('{ das ist kein gültiges JSON ', '.broken.json');
  const pricing = loadPricing(file);
  assert.deepEqual(pricing, {});

  // Das leere Mapping ist jetzt aktiv → jedes Modell gilt als unbekannt.
  const cost = computeCost({
    model: 'claude-opus-4-8',
    inputTokens: 1000,
    outputTokens: 0,
    cacheCreation5mTokens: 0,
    cacheCreation1hTokens: 0,
    cacheReadTokens: 0,
  });
  assert.equal(cost.costUSD, 0);
  assert.equal(typeof cost.warning, 'string');
  assert.equal(cost.warning.includes('claude-opus-4-8'), true);
});

test('loadPricing bei fehlender Datei → leeres Mapping', () => {
  const missing = path.join(
    os.tmpdir(),
    `cclt-nicht-vorhanden-${Date.now()}.json`,
  );
  const pricing = loadPricing(missing);
  assert.deepEqual(pricing, {});
});

// --------------------------------------------------------------------------
// computeCost — bekannte Modelle
// --------------------------------------------------------------------------

test('computeCost: bekanntes Modell mit Cache-Tokens → exakte Kosten', () => {
  loadPricing(REAL_PRICING_PATH);

  // claude-opus-4-8: input 5, output 25, cacheWrite5m 6.25, cacheWrite1h 10, cacheRead 0.5
  //   1.0M in     /1e6 * 5    = 5.00
  //   0.2M out    /1e6 * 25   = 5.00
  //   0.4M 5m     /1e6 * 6.25 = 2.50
  //   0.1M 1h     /1e6 * 10   = 1.00
  //   2.0M read   /1e6 * 0.5  = 1.00
  //   Summe                   = 14.50
  const usage = {
    model: 'claude-opus-4-8',
    inputTokens: 1_000_000,
    outputTokens: 200_000,
    cacheCreation5mTokens: 400_000,
    cacheCreation1hTokens: 100_000,
    cacheReadTokens: 2_000_000,
  };

  const cost = computeCost(usage);

  assert.equal(cost.model, 'claude-opus-4-8');
  assert.equal(cost.costUSD, 14.5); // exakt
  assert.equal(cost.warning, null);

  // Anzeige-Tokens werden unverändert durchgereicht.
  assert.equal(cost.inputTokens, 1_000_000);
  assert.equal(cost.outputTokens, 200_000);
  assert.equal(cost.cacheReadTokens, 2_000_000);
});

test('computeCost: reine Input/Output-Tokens ohne Cache', () => {
  loadPricing(REAL_PRICING_PATH);

  // claude-sonnet-4-5: input 3, output 15
  //   1.0M in  /1e6 * 3  = 3.0
  //   0.5M out /1e6 * 15 = 7.5
  //   Summe             = 10.5
  const usage = {
    model: 'claude-sonnet-4-5',
    inputTokens: 1_000_000,
    outputTokens: 500_000,
    cacheCreation5mTokens: 0,
    cacheCreation1hTokens: 0,
    cacheReadTokens: 0,
  };

  const cost = computeCost(usage);

  assert.equal(cost.costUSD, 10.5); // exakt
  assert.equal(cost.warning, null);
  assert.equal(cost.cacheReadTokens, 0);
});

test('computeCost: OpenAI-Modell (cacheRead separat, cacheWrite = input)', () => {
  loadPricing(REAL_PRICING_PATH);

  // gpt-4o: input 2.5, output 10, cacheRead 1.25
  //   1M in   /1e6 * 2.5  = 2.50
  //   1M out  /1e6 * 10   = 10.00
  //   1M read /1e6 * 1.25 = 1.25
  //   Summe               = 13.75
  const usage = {
    model: 'gpt-4o',
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheCreation5mTokens: 0,
    cacheCreation1hTokens: 0,
    cacheReadTokens: 1_000_000,
  };

  const cost = computeCost(usage);
  assert.equal(cost.costUSD, 13.75); // exakt
  assert.equal(cost.warning, null);
});

// --------------------------------------------------------------------------
// computeCost — unbekanntes Modell & Robustheit
// --------------------------------------------------------------------------

test('computeCost: unbekanntes Modell → Kosten 0 + Warnung', () => {
  loadPricing(REAL_PRICING_PATH);

  const usage = {
    model: 'gpt-4o-vision-mega-9000', // bewusst nicht in pricing.json
    inputTokens: 12_345,
    outputTokens: 6_789,
    cacheCreation5mTokens: 100,
    cacheCreation1hTokens: 50,
    cacheReadTokens: 4_000,
  };

  const cost = computeCost(usage);

  assert.equal(cost.costUSD, 0);
  assert.notEqual(cost.warning, null);
  assert.equal(
    cost.warning.includes('gpt-4o-vision-mega-9000'),
    true,
    'Warnung benennt das unbekannte Modell',
  );

  // Anzeige-Tokens werden trotz unbekanntem Modell durchgereicht.
  assert.equal(cost.model, 'gpt-4o-vision-mega-9000');
  assert.equal(cost.inputTokens, 12_345);
  assert.equal(cost.outputTokens, 6_789);
  assert.equal(cost.cacheReadTokens, 4_000);
});

test('computeCost: fehlende Token-Felder → als 0, kein NaN, keine Warnung bei bekanntem Modell', () => {
  loadPricing(REAL_PRICING_PATH);

  // Bekanntes Modell, aber ganz ohne Token-Felder.
  const cost = computeCost({ model: 'claude-haiku-4-5' });

  assert.equal(cost.costUSD, 0);
  assert.equal(Number.isFinite(cost.costUSD), true, 'kein NaN/Infinity');
  assert.equal(cost.warning, null, 'Modell bekannt → keine Warnung');
  assert.equal(cost.inputTokens, 0);
  assert.equal(cost.outputTokens, 0);
  assert.equal(cost.cacheReadTokens, 0);
});

test('computeCost: null-Eingabe bricht nicht (defensiv)', () => {
  loadPricing(REAL_PRICING_PATH);

  const cost = computeCost(null);

  assert.equal(cost.costUSD, 0);
  assert.equal(Number.isFinite(cost.costUSD), true);
  assert.equal(cost.model, '');
  assert.equal(typeof cost.warning, 'string'); // kein Modell → Warnung
});

test('computeCost: ungültige (negative/NaN) Token-Werte werden zu 0', () => {
  loadPricing(REAL_PRICING_PATH);

  const cost = computeCost({
    model: 'claude-opus-4-8',
    inputTokens: -5000, // negativ → 0
    outputTokens: Number.NaN, // NaN → 0
    cacheCreation5mTokens: undefined, // fehlt → 0
    cacheCreation1hTokens: 0,
    cacheReadTokens: 1_000_000, // 1M * 0.5 = 0.5
  });

  // Nur der gültige Cache-Read-Anteil zählt: 1.0M /1e6 * 0.5 = 0.5
  assert.equal(cost.costUSD, 0.5);
  assert.equal(cost.warning, null);
  assert.equal(cost.inputTokens, 0, 'negativer Wert auf 0 normalisiert');
  assert.equal(cost.outputTokens, 0, 'NaN auf 0 normalisiert');
});
