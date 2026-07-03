# Contracts — Modul-Schnittstellen (verbindlich)

> **Status:** Vom Fundament-Agenten festgelegt. Diese Datei ist der **verbindliche Vertrag**
> für alle folgenden Implementierungs-Agenten. Signaturen, Datenstrukturen und Verhaltens-
> Kontrakte sind **exakt** einzuhalten. Bei Unklarheiten gilt zusätzlich die Design-Spec unter
> `docs/superpowers/specs/2026-07-02-claude-code-live-tracker-design.md`.

**Stack:** Node.js ≥ 18, ausschließlich stdlib (`http`, `https`, `fs`, `events`, `stream`,
`path`, `url`). **Keine** npm-Dependencies. Module als **CommonJS** (`module.exports`).

**Oberstes Prinzip:** Das Tracking darf den durchgereichten API-Verkehr **niemals** brechen oder
verzögern. Bei Parsing- oder Preisfehlern wird der Request **trotzdem** durchgereicht, die Kosten
werden als `0` verbucht und eine `warning` gesetzt.

---

## 1. Datenstrukturen (`@typedef`)

```js
/**
 * Normalisierte, provider-unabhängige Token-Nutzung einer einzelnen Anfrage.
 * Alle Felder sind Zahlen ≥ 0. Fehlende Werte sind 0 (nie undefined/null).
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
 * Ergebnis der Kostenberechnung für eine Anfrage. costUSD enthält die Summe ALLER
 * Kostenkomponenten (input, output, cacheWrite5m, cacheWrite1h, cacheRead); die einzeln
 * ausgewiesenen Token-Felder dienen der Anzeige im Dashboard.
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
 * Momentaufnahme für das Dashboard (SSE-Payload).
 *
 * @typedef {Object} DashboardState
 * @property {number}      sessionCostUSD       Kosten der laufenden Session (USD).
 * @property {number}      sessionInputTokens   Eingabe-Tokens der Session (Summe).
 * @property {number}      sessionOutputTokens  Ausgabe-Tokens der Session (Summe).
 * @property {number}      todayCostUSD         Kumulierte Kosten des heutigen Tages (USD, lokal).
 * @property {number}      dailyLimitUSD        Tageslimit aus config.json.
 * @property {boolean}     bypassActive         Ist der Budget-Bypass aktiv (.budget-bypass vorhanden)?
 * @property {Object|null} lastRequest          Zuletzt verarbeitete Anfrage (Form: CostBreakdown) oder null.
 * @property {string|null} warning              Aktueller Warnhinweis oder null.
 */
```

**Hinweis zu `bypassActive`:** `src/spend.js#getState()` liefert einen `DashboardState`, setzt
`bypassActive` dabei aber **nicht** (Default `false`). Der tatsächliche Bypass-Zustand wird erst
in der Dashboard-/Budget-Schicht (`src/budget.js#isBypassActive()`) ermittelt und dort ergänzt.

---

## 2. `pricing.json` — Preisformat

Mapping **Modell-ID → Preise pro 1 Mio. Tokens (USD)**. Felder je Modell:

```json
{ "input": 0, "output": 0, "cacheWrite5m": 0, "cacheWrite1h": 0, "cacheRead": 0 }
```

Bei OpenAI-Modellen sind `cacheWrite5m` und `cacheWrite1h` gleich `input` gesetzt (OpenAI
berechnet Cache-Schreibvorgänge nicht separat). Die Datei ist **reines JSON** (keine Kommentare)
und vom Nutzer editierbar.

---

## 3. Modul-Exporte & Verhaltens-Kontrakte

### `src/pricing.js`

```js
loadPricing(pricingPath) -> object            // lädt + cached pricing.json
computeCost(normalizedUsage) -> CostBreakdown // Kosten aus NormalizedUsage
```

**Verhalten:**
- `loadPricing` liest die JSON-Datei einmal ein und cached das Ergebnis (weitere Aufrufe treffen
  den Cache). Fehlt/korrupt → definiertes, robustes Verhalten (leeres Mapping statt Absturz).
- `computeCost` berechnet:
  ```
  costUSD = inputTokens           / 1e6 * preis.input
          + outputTokens          / 1e6 * preis.output
          + cacheCreation5mTokens / 1e6 * preis.cacheWrite5m
          + cacheCreation1hTokens / 1e6 * preis.cacheWrite1h
          + cacheReadTokens       / 1e6 * preis.cacheRead
  ```
- **Unbekanntes Modell** (nicht in `pricing.json`): `costUSD = 0` **und** `warning` gesetzt
  (z. B. `"Preis für Modell X unbekannt"`). Der zurückgegebene `CostBreakdown` enthält die
  Anzeige-Tokenzahlen aus der `NormalizedUsage`.

### `src/spend.js`

```js
recordSpend(costBreakdown) -> DashboardState  // aktualisiert Session + Tagesdatei
getState() -> DashboardState                  // aktueller Stand (Session + heute)
getTodayTotalUSD() -> number                  // kumulierte Tagessumme (USD)
```

**Persistenz & Verhalten:**
- Zwei Dateien: `session-spend.json` (laufende Session) und `spend-YYYY-MM-DD.json`
  (Tagesaggregat; Datum **lokal**, nicht UTC).
- `recordSpend` addiert Kosten/Tokens der Anfrage in **beide** Dateien und liefert den neuen
  `DashboardState` inkl. `lastRequest` (= übergebener `CostBreakdown`).
- `getState` liefert Session- und Tageswerte; `bypassActive` bleibt hier `false` (siehe §1).
- Tageswechsel: Bei neuem Datum wird automatisch eine neue `spend-YYYY-MM-DD.json` verwendet
  (Rollover); die Session-Datei läuft unabhängig weiter.
- **Korrupte/fehlende Datei** wird als **leer** behandelt und neu angelegt (nie Absturz).
- API-Keys o. Ä. werden **nie** persistiert (es werden ausschließlich die bekannten
  `CostBreakdown`-Felder gespeichert — Whitelist).

> **Datenverzeichnis (additive Klarstellung, `spend.js` — Signaturen unverändert):**
> Ablageort der Laufzeitdateien (`session-spend.json`, `spend-YYYY-MM-DD.json`) ist
> standardmäßig `process.cwd()`. Über die Umgebungsvariable **`CCLT_DATA_DIR`** lässt
> er sich umlenken (Default = `process.cwd()`), damit **Tests** in ein temporäres
> Verzeichnis schreiben, ohne das Projekt-Root zu verschmutzen. Die exportierten
> Funktions-Signaturen bleiben **exakt** wie oben. Andere Module (z. B. `budget.js`
> für `.budget-bypass`) sollten dieselbe Variable respektieren, damit alle Artefakte
> im selben Verzeichnis liegen.
>
> **Neutrale Defaults im `DashboardState`:** `getState()`/`recordSpend()` kennen weder
> `config.json` noch die `.budget-bypass`-Datei und liefern daher `dailyLimitUSD: 0`
> und `bypassActive: false`. Beide Felder werden von der Budget-/Dashboard-Schicht
> ergänzt (`dailyLimitUSD` aus `config`, `bypassActive` aus `budget.isBypassActive()`).

### `src/providers.js`

```js
detectProvider(reqPath, headers) -> 'anthropic'|'openai'|null
resolveUpstream(provider, config) -> { protocol, host, port }
maybeInjectIncludeUsage(provider, bodyBuffer, config) -> Buffer
createUsageExtractor(provider, isStream) -> { feed(chunkBuffer):void, finalize():(NormalizedUsage|null) }
```

**`detectProvider`** — Erkennung primär am Pfad, sekundär am Auth-Header:
- Pfad enthält `/v1/messages` → `'anthropic'`.
- Pfad enthält `/v1/chat/completions` oder `/v1/responses` → `'openai'`.
- Sonst: anhand vorhandenem Auth-Header (`x-api-key` → anthropic, `Authorization: Bearer` →
  openai). Kein eindeutiges Signal → `null` (Request wird dennoch transparent durchgereicht,
  Tracking = 0).

**`resolveUpstream`** — löst die Upstream-URL aus `config.upstreams[provider]` in
`{ protocol, host, port }` auf (Default-Port nach Protokoll: https→443).

**`maybeInjectIncludeUsage`** — nur bei `provider === 'openai'`, JSON-Body mit `stream: true`
**und** `config.injectOpenAIUsage === true`: setzt `stream_options.include_usage = true` und gibt
den neuen Body-Buffer zurück (Aufrufer berechnet `Content-Length` neu). In **allen** anderen
Fällen (kein OpenAI, kein Stream, Flag aus, **Nicht-JSON / Parse-Fehler**) wird der Buffer
**unverändert** zurückgegeben. Niemals blockieren.

**`createUsageExtractor`** — zustandsbehafteter Extraktor; `feed` erhält Antwort-Chunks
(SSE-Zeilen bzw. JSON), `finalize` liefert am Ende die `NormalizedUsage` oder `null`
(wenn keine `usage` gefunden wurde).
- **Anthropic (Streaming):** `input_tokens`, `cache_read_input_tokens` und Cache-Creation aus
  `message_start.message.usage`; `output_tokens` (kumulativ, final) aus `message_delta.usage`.
  Ist `usage.cache_creation = { ephemeral_5m_input_tokens, ephemeral_1h_input_tokens }`
  vorhanden → getrennt auf `cacheCreation5mTokens` / `cacheCreation1hTokens` abbilden. Fehlt das
  Objekt → `cache_creation_input_tokens` **komplett** als `cacheCreation5mTokens`.
- **Anthropic (Non-Streaming):** JSON `.usage` mit denselben Feldern.
- **OpenAI (Streaming):** `usage` im **letzten** Chunk (nur wenn `include_usage` aktiv);
  **(Non-Streaming):** `.usage` im JSON. Abbildung:
  `prompt_tokens_details.cached_tokens` → `cacheReadTokens`;
  `prompt_tokens − cached_tokens` → `inputTokens`;
  `completion_tokens` → `outputTokens`.

### `src/budget.js`

```js
isBypassActive() -> boolean       // existiert .budget-bypass ?
setBypass(active) -> void          // erzeugt (.budget-bypass) bzw. löscht die Datei
isBlocked(config) -> boolean       // getTodayTotalUSD() >= config.dailyLimitUSD UND !isBypassActive()
```

**Verhalten:**
- `isBlocked` blockiert nur, wenn Tageslimit **erreicht/überschritten** **und** **kein** Bypass
  aktiv ist. Sonst `false`.
- `setBypass(true)` legt die Datei `.budget-bypass` an, `setBypass(false)` entfernt sie
  (idempotent — kein Fehler, wenn Ziel-Zustand bereits gilt).

### `src/dashboard.js`

```js
serveDashboard(req, res) -> void          // liefert public/dashboard.html
serveEvents(req, res) -> void             // SSE: Client registrieren + sofort State-Replay senden
handleBypass(req, res, config) -> void    // POST /api/bypass {active:bool} -> setBypass + broadcast
broadcast(state) -> void                  // DashboardState an alle SSE-Clients senden
```

**Verhalten:**
- `serveEvents` setzt die SSE-Header, registriert den Client, sendet **sofort** den aktuellen
  `DashboardState` (Replay), und deregistriert den Client sauber bei `close`.
- `handleBypass` liest den JSON-Body `{active:boolean}`, ruft `budget.setBypass(active)` und
  broadcastet anschließend den aktualisierten `DashboardState`.
- `broadcast` serialisiert den `DashboardState` als SSE-`data:`-Event an alle registrierten
  Clients; getrennte Clients werden übersprungen/entfernt.

### `src/proxy.js`

```js
startServer(config) -> http.Server        // erstellt + startet den HTTP-Server
```

**Routing & Verhalten:**
- Routen `/dashboard`, `/events`, `/api/bypass` → an die Dashboard-Handler delegieren.
- Jeder andere Pfad → **Proxy-Pfad**:
  1. `detectProvider(reqPath, headers)`.
  2. `budget.isBlocked(config)` → **`429`** mit JSON-Fehlermeldung
     (`{error: "Tageslimit erreicht (X/Y USD). Bypass über Dashboard-Button oder .budget-bypass."}`),
     Ende.
  3. Sonst: `maybeInjectIncludeUsage`, dann Request per **https** an den Upstream weiterleiten —
     Header (inkl. `x-api-key` / `Authorization`) **durchreichen**, `Host`-Header auf den
     Upstream setzen.
  4. Antwort **transparent** an den Client pipen **und** parallel via `createUsageExtractor`
     tappen (kein Warten auf den Tracker).
  5. Am Stream-Ende: `finalize()` → `pricing.computeCost()` → `spend.recordSpend()` →
     `dashboard.broadcast()`.
- **Fehlerfälle:** Upstream nicht erreichbar → `502`; usage nicht parsbar / Modell unbekannt →
  Request trotzdem durch, Kosten = 0 + Warnung; Body-Parse-Fehler bei Injektion → Body
  unverändert.
- Bei direktem Aufruf (`require.main === module`): `config.json` laden, `startServer(config)`,
  Startmeldung inkl. Dashboard-URL (`http://localhost:<port>/dashboard`) loggen.

---

## 4. Audit-Fixes (2026-07-02) — Präzisierungen des Verhaltens

Signaturen bleiben unverändert; die folgenden Verhaltensdetails wurden nach dem
adversarialen Audit ergänzt (Regressionstests in `test/audit-fixes.test.js`):

- **`providers.detectProvider`** — Vorrang für Anthropic-Signale im Header-Rückfall:
  `x-api-key`, `anthropic-version`/`anthropic-beta` und `Authorization: Bearer sk-ant…`
  (Claude-OAuth/Abo) → `'anthropic'`. Nur ein *gewöhnlicher* Bearer → `'openai'`.
- **`providers.maybeInjectIncludeUsage`** — injiziert **nur** bei Chat-Completions-Form
  (Feld `messages` als Array). Die Responses-API (`/v1/responses`, Feld `input`) bleibt
  unverändert, da sie `stream_options` mit 400 ablehnen würde (usage kommt dort automatisch).
- **`pricing.computeCost`** — Modell-Auflösung mit Präfix-Fallback: exakter Match, sonst
  längster passender Präfix-Key an Bindestrich-Grenze (`gpt-4o-2024-08-06` → `gpt-4o`,
  `gpt-4o-mini-2024-07-18` → `gpt-4o-mini`). Erst wenn auch das scheitert: 0 + Warnung.
- **`proxy.js`** — erzwingt `accept-encoding: identity` zum Upstream (sonst könnte eine
  gzip/br-Antwort das Tracking und damit den Budget-Guard still aushebeln). Setzt bei
  erfolgreicher API-Antwort ohne extrahierbare usage eine dezente Dashboard-Warnung.
  Weist nicht-lokale `Host`-Header mit 403 ab (DNS-Rebinding-Schutz).
- **`dashboard.handleBypass`** — CSRF-Schutz: cross-origin Herkunft (Origin/Referer) wird
  mit 403 abgewiesen; CSP um `frame-ancestors 'none'` ergänzt (Clickjacking).
