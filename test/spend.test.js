'use strict';

/**
 * Tests für src/spend.js — Persistenz & Aggregation.
 *
 * WICHTIG: Jeder Test schreibt in ein FRISCHES temporäres Verzeichnis
 * (`CCLT_DATA_DIR`) und räumt es danach auf. Das Projekt-Root wird nie
 * verschmutzt. Weil jedes Verzeichnis eindeutig ist, lädt spend.js seinen
 * In-Memory-Session-Spiegel automatisch neu ⇒ vollständige Test-Isolation.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const spend = require('../src/spend.js');

// --- Test-Helfer -----------------------------------------------------------

/** Legt ein frisches, isoliertes Datenverzeichnis an und lenkt spend.js dorthin. */
function freshDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cclt-spend-'));
  process.env.CCLT_DATA_DIR = dir;
  return dir;
}

/** Räumt ein Test-Datenverzeichnis wieder ab (Windows-robust mit Retries). */
function cleanup(dir) {
  delete process.env.CCLT_DATA_DIR;
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}

/** Lokales Datum "YYYY-MM-DD" — identisch zur Logik in spend.js. */
function localDateStr(d = new Date()) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** Lokales Datum vor `n` Tagen (Mittag ⇒ robust gegen Sommerzeit-Sprünge). */
function daysAgoDateStr(n) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return localDateStr(d);
}

/** Baut einen CostBreakdown mit sinnvollen Defaults; `over` überschreibt Felder. */
function breakdown(over = {}) {
  return Object.assign(
    {
      model: 'claude-opus-4-8',
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 0,
      costUSD: 0.01,
      warning: null,
    },
    over,
  );
}

/** Näherungsvergleich für Fließkommazahlen (Kosten-Summen driften minimal). */
function approx(actual, expected, eps = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= eps, `erwartet ~${expected}, war ${actual}`);
}

/** Liest die Session-Datei eines Verzeichnisses (oder null). */
function readSession(dir) {
  const p = path.join(dir, 'session-spend.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

/** Liest die heutige Tagesdatei eines Verzeichnisses (oder null). */
function readToday(dir) {
  const p = path.join(dir, `spend-${localDateStr()}.json`);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

// --- Tests -----------------------------------------------------------------

test('recordSpend summiert Session und Tagessumme über mehrere Aufrufe korrekt', () => {
  const dir = freshDataDir();
  try {
    const s1 = spend.recordSpend(breakdown({ costUSD: 0.10, inputTokens: 1000, outputTokens: 100 }));
    approx(s1.sessionCostUSD, 0.10);
    approx(s1.todayCostUSD, 0.10);
    assert.strictEqual(s1.sessionInputTokens, 1000);
    assert.strictEqual(s1.sessionOutputTokens, 100);

    const s2 = spend.recordSpend(breakdown({ costUSD: 0.05, inputTokens: 500, outputTokens: 40 }));
    approx(s2.sessionCostUSD, 0.15);
    approx(s2.todayCostUSD, 0.15);
    assert.strictEqual(s2.sessionInputTokens, 1500);
    assert.strictEqual(s2.sessionOutputTokens, 140);

    // getState / getTodayTotalUSD spiegeln denselben Stand.
    const st = spend.getState();
    approx(st.sessionCostUSD, 0.15);
    approx(st.todayCostUSD, 0.15);
    approx(spend.getTodayTotalUSD(), 0.15);

    // Session wurde auch persistiert (nicht nur In-Memory).
    const sessionFile = readSession(dir);
    approx(sessionFile.costUSD, 0.15);
    assert.strictEqual(sessionFile.inputTokens, 1500);
    assert.strictEqual(sessionFile.outputTokens, 140);
  } finally {
    cleanup(dir);
  }
});

test('recordSpend schreibt die Tagesdatei spend-YYYY-MM-DD.json mit korrektem Inhalt', () => {
  const dir = freshDataDir();
  try {
    spend.recordSpend(breakdown({ costUSD: 0.20, inputTokens: 2000, outputTokens: 300, cacheReadTokens: 4000 }));

    const dailyFile = path.join(dir, `spend-${localDateStr()}.json`);
    assert.ok(fs.existsSync(dailyFile), 'Tagesdatei muss existieren');

    const daily = JSON.parse(fs.readFileSync(dailyFile, 'utf8'));
    assert.strictEqual(daily.date, localDateStr());
    approx(daily.costUSD, 0.20);
    assert.strictEqual(daily.inputTokens, 2000);
    assert.strictEqual(daily.outputTokens, 300);
    assert.strictEqual(daily.cacheReadTokens, 4000);
    assert.strictEqual(daily.requestCount, 1);

    // Session-Datei existiert ebenfalls.
    assert.ok(fs.existsSync(path.join(dir, 'session-spend.json')), 'Session-Datei muss existieren');

    // Zweiter Aufruf erhöht requestCount und summiert.
    spend.recordSpend(breakdown({ costUSD: 0.05, inputTokens: 100, outputTokens: 10, cacheReadTokens: 0 }));
    const daily2 = readToday(dir);
    assert.strictEqual(daily2.requestCount, 2);
    approx(daily2.costUSD, 0.25);
    assert.strictEqual(daily2.inputTokens, 2100);
  } finally {
    cleanup(dir);
  }
});

test('korrupte Dateien werden als leer behandelt (kein Crash, Start bei 0)', () => {
  const dir = freshDataDir();
  try {
    // Vorsätzlich kaputte JSON-Dateien ablegen.
    fs.writeFileSync(path.join(dir, 'session-spend.json'), '{ das ist kein JSON', 'utf8');
    fs.writeFileSync(path.join(dir, `spend-${localDateStr()}.json`), 'völlig kaputt!!!', 'utf8');

    // Kein Absturz, Werte 0.
    assert.strictEqual(spend.getTodayTotalUSD(), 0);
    const st = spend.getState();
    approx(st.sessionCostUSD, 0);
    approx(st.todayCostUSD, 0);
    assert.strictEqual(st.lastRequest, null);
    assert.strictEqual(st.warning, null);

    // Danach normal weiterbuchen — beginnt sauber bei 0 und überschreibt den Müll.
    const after = spend.recordSpend(breakdown({ costUSD: 0.07 }));
    approx(after.sessionCostUSD, 0.07);
    approx(after.todayCostUSD, 0.07);

    // Die zuvor korrupten Dateien sind jetzt valides JSON.
    approx(readSession(dir).costUSD, 0.07);
    approx(readToday(dir).costUSD, 0.07);
  } finally {
    cleanup(dir);
  }
});

test('Tageswechsel: heutige Summe ignoriert die Datei eines anderen Tages (Rollover)', () => {
  const dir = freshDataDir();
  try {
    // "Gestern" mit Kosten vorbelegen.
    const yesterday = daysAgoDateStr(1);
    const yFile = path.join(dir, `spend-${yesterday}.json`);
    fs.writeFileSync(yFile, JSON.stringify({ date: yesterday, costUSD: 9.99, requestCount: 3 }), 'utf8');

    // Heute beginnt bei 0 (separate Datei, anderer Dateiname).
    approx(spend.getTodayTotalUSD(), 0);

    // Heute buchen ⇒ eigene Tagesdatei; Gestern bleibt unberührt.
    spend.recordSpend(breakdown({ costUSD: 0.30 }));
    approx(spend.getTodayTotalUSD(), 0.30);

    assert.ok(fs.existsSync(path.join(dir, `spend-${localDateStr()}.json`)), 'heutige Datei existiert');
    const yData = JSON.parse(fs.readFileSync(yFile, 'utf8'));
    approx(yData.costUSD, 9.99); // Gestern unverändert
    assert.strictEqual(yData.requestCount, 3);
  } finally {
    cleanup(dir);
  }
});

test('vorhandene session-spend.json wird beim ersten Zugriff übernommen (Resume nach Neustart)', () => {
  const dir = freshDataDir();
  try {
    fs.writeFileSync(
      path.join(dir, 'session-spend.json'),
      JSON.stringify({
        costUSD: 1.23,
        inputTokens: 5000,
        outputTokens: 700,
        lastRequest: breakdown({ costUSD: 0.5 }),
      }),
      'utf8',
    );

    const st = spend.getState();
    approx(st.sessionCostUSD, 1.23);
    assert.strictEqual(st.sessionInputTokens, 5000);
    assert.strictEqual(st.sessionOutputTokens, 700);
    assert.ok(st.lastRequest && st.lastRequest.model === 'claude-opus-4-8');

    // Weiter buchen addiert auf den resümierten Stand.
    const st2 = spend.recordSpend(breakdown({ costUSD: 0.27, inputTokens: 0, outputTokens: 0 }));
    approx(st2.sessionCostUSD, 1.50);
  } finally {
    cleanup(dir);
  }
});

test('recordSpend persistiert nur bekannte Felder — keine API-Keys o. Ä.', () => {
  const dir = freshDataDir();
  try {
    const st = spend.recordSpend(
      breakdown({ costUSD: 0.02, apiKey: 'sk-geheim-123', authorization: 'Bearer xyz', 'x-api-key': 'k' }),
    );

    // Rückgabe-lastRequest enthält keine Fremdfelder.
    assert.strictEqual(st.lastRequest.apiKey, undefined);
    assert.strictEqual(st.lastRequest.authorization, undefined);
    assert.strictEqual(st.lastRequest['x-api-key'], undefined);
    assert.strictEqual(st.lastRequest.model, 'claude-opus-4-8');

    // Auch in der persistierten Datei steht kein Geheimnis.
    const raw = fs.readFileSync(path.join(dir, 'session-spend.json'), 'utf8');
    assert.ok(!raw.includes('sk-geheim-123'), 'API-Key darf nicht persistiert werden');
    assert.ok(!raw.includes('Bearer xyz'), 'Authorization darf nicht persistiert werden');
  } finally {
    cleanup(dir);
  }
});

test('getState liefert vollständige Form mit neutralen Defaults (bypassActive=false, dailyLimitUSD=0)', () => {
  const dir = freshDataDir();
  try {
    const st = spend.getState();

    // Neutrale Defaults (werden von der Budget-/Dashboard-Schicht ergänzt).
    assert.strictEqual(st.bypassActive, false);
    assert.strictEqual(st.dailyLimitUSD, 0);
    assert.strictEqual(st.lastRequest, null);
    assert.strictEqual(st.warning, null);
    approx(st.sessionCostUSD, 0);
    approx(st.todayCostUSD, 0);

    // Vollständige DashboardState-Form.
    for (const k of [
      'sessionCostUSD', 'sessionInputTokens', 'sessionOutputTokens',
      'todayCostUSD', 'dailyLimitUSD', 'bypassActive', 'lastRequest', 'warning',
    ]) {
      assert.ok(k in st, `Feld ${k} fehlt im DashboardState`);
    }
  } finally {
    cleanup(dir);
  }
});

test('warning aus dem letzten CostBreakdown erscheint im DashboardState und wird wieder gelöscht', () => {
  const dir = freshDataDir();
  try {
    const st = spend.recordSpend(
      breakdown({ model: 'unbekannt-x', costUSD: 0, warning: 'Preis für Modell unbekannt-x unbekannt' }),
    );
    assert.strictEqual(st.warning, 'Preis für Modell unbekannt-x unbekannt');
    approx(st.sessionCostUSD, 0); // unbekanntes Modell ⇒ Kosten 0, aber verbucht

    // Eine nachfolgende saubere Anfrage löscht die Warnung wieder.
    const st2 = spend.recordSpend(breakdown({ costUSD: 0.01, warning: null }));
    assert.strictEqual(st2.warning, null);
  } finally {
    cleanup(dir);
  }
});

test('robuste Normalisierung: negative/kaputte Zahlen werden als 0 verbucht', () => {
  const dir = freshDataDir();
  try {
    const st = spend.recordSpend(
      breakdown({ costUSD: -5, inputTokens: NaN, outputTokens: Infinity, cacheReadTokens: 'abc' }),
    );
    approx(st.sessionCostUSD, 0);
    assert.strictEqual(st.sessionInputTokens, 0);
    assert.strictEqual(st.sessionOutputTokens, 0);
    approx(st.todayCostUSD, 0);

    const daily = readToday(dir);
    assert.strictEqual(daily.cacheReadTokens, 0);
    assert.strictEqual(daily.requestCount, 1); // Anfrage wurde trotzdem gezählt
  } finally {
    cleanup(dir);
  }
});
