'use strict';

/**
 * Tests für src/budget.js (Node-eigener Runner `node --test`, keine externen Deps).
 *
 * Strategie — hermetische Sandbox:
 *  budget.js hängt laut Contract von spend.js#getTodayTotalUSD() ab. Damit die Tests
 *  eine STEUERBARE Tagessumme setzen können, OHNE die echte (parallel entstehende)
 *  spend.js anzufassen, wird budget.js in ein temporäres Verzeichnis kopiert und dort
 *  ein steuerbarer spend.js-Stub daneben gelegt. budget.js' `require('./spend')` löst
 *  dann relativ auf diesen Stub auf — so testen wir die echte Verdrahtung.
 *
 *  Die Marker-Datei `.budget-bypass` liegt laut Spec "im Arbeitsverzeichnis"
 *  (process.cwd()). Daher wechselt der Test per process.chdir() in die Sandbox — so
 *  wird das Projekt-Root NICHT verschmutzt und das Aufräumen ist trivial (Sandbox weg).
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Pfad zur echten, zu testenden budget.js (Quelle bleibt unberührt).
const PROJEKT_BUDGET = path.join(__dirname, '..', 'src', 'budget.js');

// Steuerbarer spend.js-Stub: einstellbare Tagessumme + optionaler Fehlerfall.
const SPEND_STUB_QUELLE = `
'use strict';
let total = 0;
let sollWerfen = false;
module.exports = {
  getTodayTotalUSD() {
    if (sollWerfen) throw new Error('simulierter spend-Lesefehler');
    return total;
  },
  __setTotal(v) { total = v; },
  __setThrow(v) { sollWerfen = v; },
};
`;

let sandbox;       // temporäres Verzeichnis
let budget;        // in der Sandbox geladenes Modul unter Test
let spendStub;     // Referenz auf den geladenen spend.js-Stub
let originalCwd;   // Arbeitsverzeichnis vor dem Test

before(() => {
  originalCwd = process.cwd();
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cclt-budget-'));
  // budget.js unverändert in die Sandbox kopieren.
  fs.copyFileSync(PROJEKT_BUDGET, path.join(sandbox, 'budget.js'));
  // Steuerbaren spend.js-Stub daneben legen, damit require('./spend') ihn findet.
  fs.writeFileSync(path.join(sandbox, 'spend.js'), SPEND_STUB_QUELLE, 'utf8');
  // In die Sandbox wechseln => .budget-bypass landet hier, nicht im Projekt-Root.
  process.chdir(sandbox);
  budget = require(path.join(sandbox, 'budget.js'));
  spendStub = require(path.join(sandbox, 'spend.js'));
});

after(() => {
  // Erst zurückwechseln (Windows kann das aktuelle Verzeichnis nicht löschen),
  // dann die komplette Sandbox entfernen.
  process.chdir(originalCwd);
  fs.rmSync(sandbox, { recursive: true, force: true });
});

beforeEach(() => {
  // Sauberer Ausgangszustand vor jedem Test — bewusst unabhängig vom Code unter Test:
  fs.rmSync(path.join(sandbox, '.budget-bypass'), { force: true });
  spendStub.__setTotal(0);
  spendStub.__setThrow(false);
});

// --- Contract-Oberfläche --------------------------------------------------

test('Contract: exportiert genau isBypassActive, setBypass, isBlocked', () => {
  assert.deepEqual(Object.keys(budget).sort(), ['isBlocked', 'isBypassActive', 'setBypass']);
  assert.equal(typeof budget.isBypassActive, 'function');
  assert.equal(typeof budget.setBypass, 'function');
  assert.equal(typeof budget.isBlocked, 'function');
});

// --- Bypass-Lebenszyklus --------------------------------------------------

test('isBypassActive ist ohne Marker-Datei false', () => {
  assert.equal(budget.isBypassActive(), false);
});

test('setBypass(true) legt .budget-bypass an und aktiviert den Bypass', () => {
  budget.setBypass(true);
  assert.equal(fs.existsSync(path.join(sandbox, '.budget-bypass')), true);
  assert.equal(budget.isBypassActive(), true);
});

test('setBypass(false) entfernt .budget-bypass und deaktiviert den Bypass', () => {
  budget.setBypass(true);
  budget.setBypass(false);
  assert.equal(fs.existsSync(path.join(sandbox, '.budget-bypass')), false);
  assert.equal(budget.isBypassActive(), false);
});

test('setBypass ist idempotent (mehrfaches An/Aus wirft nicht)', () => {
  assert.doesNotThrow(() => {
    budget.setBypass(true);
    budget.setBypass(true);
  });
  assert.equal(budget.isBypassActive(), true);
  assert.doesNotThrow(() => {
    budget.setBypass(false);
    budget.setBypass(false);
  });
  assert.equal(budget.isBypassActive(), false);
});

// --- isBlocked-Logik ------------------------------------------------------

test('isBlocked: Tagessumme über dem Limit und kein Bypass => true', () => {
  spendStub.__setTotal(30);
  assert.equal(budget.isBlocked({ dailyLimitUSD: 25 }), true);
});

test('isBlocked: Tagessumme exakt am Limit => true (Grenzfall >=)', () => {
  spendStub.__setTotal(25);
  assert.equal(budget.isBlocked({ dailyLimitUSD: 25 }), true);
});

test('isBlocked: Tagessumme unter dem Limit => false', () => {
  spendStub.__setTotal(10);
  assert.equal(budget.isBlocked({ dailyLimitUSD: 25 }), false);
});

test('isBlocked: aktiver Bypass hebt die Blockade auf (auch über Limit)', () => {
  spendStub.__setTotal(30);
  budget.setBypass(true);
  assert.equal(budget.isBlocked({ dailyLimitUSD: 25 }), false);
  // Nach Entfernen des Bypass blockiert es wieder:
  budget.setBypass(false);
  assert.equal(budget.isBlocked({ dailyLimitUSD: 25 }), true);
});

test('isBlocked: Fehler beim Ermitteln der Tagessumme => fail-open (nicht blockiert)', () => {
  spendStub.__setTotal(9999);
  spendStub.__setThrow(true); // getTodayTotalUSD wirft
  assert.equal(budget.isBlocked({ dailyLimitUSD: 25 }), false);
});

test('isBlocked: fehlendes/ungültiges Limit => fail-open (nicht blockiert)', () => {
  spendStub.__setTotal(9999);
  assert.equal(budget.isBlocked({}), false);                       // dailyLimitUSD fehlt
  assert.equal(budget.isBlocked(null), false);                     // config fehlt ganz
  assert.equal(budget.isBlocked({ dailyLimitUSD: '25' }), false);  // kein number
});
