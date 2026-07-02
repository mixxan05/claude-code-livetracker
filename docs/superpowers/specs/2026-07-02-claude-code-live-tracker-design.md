# Claude Code Live Tracker — Design-Spezifikation

**Datum:** 2026-07-02
**Status:** Freigegeben (Brainstorming abgeschlossen)
**Stack:** Node.js (zero-dependency, nur stdlib), Multi-Provider, persistente Tagesdatei

---

## 1. Ziel & Motivation

Ein lokaler Reverse-Proxy, der den API-Verkehr autonomer Coding-Agenten (Claude Code, Aider,
Cursor, VS Code) abfängt, das `usage`-Feld der Antwort parst, in Millisekunden die echten
Cent-Beträge berechnet und live in ein minimalistisches Web-Dashboard streamt. Integriert ist
ein per Mausklick schaltbarer Budget-Schutz mit Tageslimit.

**Kernversprechen:** Keine Cloud liest mit (API-Keys werden nur durchgereicht, nie gespeichert),
kein komplexes Setup (ein `node`-Befehl, kein TLS-Zertifikat), volle Kontrolle über die IDE.

---

## 2. Architektur & Abfang-Methode

### Gewählter Ansatz: Reverse-Proxy via `BASE_URL`

Die IDE/CLI zeigt per Umgebungsvariable auf `localhost:9000`. Der Proxy spricht **HTTP** mit der
IDE (localhost, kein TLS nötig) und **HTTPS** mit dem echten Upstream. Damit ist **kein
TLS-MITM und kein CA-Zertifikat** erforderlich.

Einbindung je Client:
- **Claude Code / Aider (Anthropic):** `ANTHROPIC_BASE_URL=http://localhost:9000`
- **Aider / Cursor (OpenAI-kompatibel):** `OPENAI_API_BASE=http://localhost:9000/v1`
- **VS Code Extensions:** jeweiliges Custom-Base-URL-Feld

### Datenfluss pro Anfrage

```
IDE/CLI ──HTTP──▶ [ Proxy :9000 ] ──HTTPS──▶ api.anthropic.com / api.openai.com
                      │  ▲                          │
                 Budget-Guard  └── SSE/JSON transparent durchgereicht ◀──┘
                      │              (gleichzeitig "getappt" → usage geparst)
                      ▼
             spend.js ──▶ session-spend.json + spend-YYYY-MM-DD.json
                      │
                      ▼ (SSE-Broadcast)
             Browser-Dashboard :9000/dashboard  ← Live-$-Anzeige
```

1. **Budget-Guard:** Tagessumme aus `spend-YYYY-MM-DD.json` lesen. Limit erreicht **und** keine
   `.budget-bypass`-Datei? → sofort `429` mit klarer JSON-Fehlermeldung, Ende.
2. Sonst: Request **unverändert** (inkl. `x-api-key`/`Authorization`) an den echten Upstream.
   Einzige Ausnahme: optionale `stream_options.include_usage`-Injektion bei OpenAI (s. §4).
3. Antwort-Stream wird **Chunk-für-Chunk transparent** an die IDE gepiped **und** parallel
   getappt, um SSE-Events mitzulesen → **keine spürbare Verzögerung**.
4. Am Stream-Ende: `usage` extrahiert → Kosten berechnet → `spend.js` aktualisiert
   (Session + Tag) → SSE-Broadcast ans Dashboard.

### Transparentes Streaming ohne Verzögerung

Der Proxy pipe't den Upstream-Response-Stream direkt zum Client (`upstream.pipe(clientRes)`) und
tap't gleichzeitig über einen `PassThrough`/Tee-Mechanismus, um die SSE-Events zu parsen. Die
Kostenberechnung passiert **nach** dem letzten durchgereichten Chunk — der Client wartet nie auf
den Tracker.

---

## 3. Komponenten (je eine Datei, klar abgegrenzt)

| Datei | Zweck | Abhängigkeiten |
|---|---|---|
| `src/proxy.js` | HTTP-Server, Routing, transparentes Streaming + Tap, Server-Start | providers, pricing, spend, budget, dashboard, config |
| `src/providers.js` | Provider-Erkennung (Anthropic vs. OpenAI), Upstream-URL, usage-Parsing pro Provider, optionale include_usage-Injektion | — |
| `src/pricing.js` | usage → Kosten (inkl. Cache-Read/-Write-Tokens); lädt `pricing.json` | pricing.json |
| `src/spend.js` | Persistenz: `session-spend.json` + `spend-YYYY-MM-DD.json`, Aggregation, Tageswechsel | — |
| `src/budget.js` | Limit-Prüfung, `.budget-bypass`-Handling (Datei erzeugen/löschen/prüfen) | config, spend |
| `src/dashboard.js` | SSE-Broadcast (`/events`), Auslieferung statische Seite, Bypass-Endpoint (`/api/bypass`) | budget |
| `public/dashboard.html` | Minimalistisches Live-Dashboard, **inline** CSS/JS, keine externen Deps | — |
| `config.json` | Port, Tageslimit, Upstream-URLs, Provider-Routing | — |
| `pricing.json` | Modell-Preise pro 1M Tokens, **editierbar** | — |
| `package.json` | Start-Script, `node --test`, keine Runtime-Deps | — |

**Zero-Dependency-Prinzip:** ausschließlich Node-stdlib (`http`, `https`, `fs`, `events`,
`stream`). Kein Express, kein node-fetch.

**Laufzeit-Artefakte** (nicht eingecheckt, via `.gitignore`): `session-spend.json`,
`spend-YYYY-MM-DD.json`, `.budget-bypass`.

---

## 4. Multi-Provider-Handling

Provider-Erkennung am **Request-Pfad** (primär) und **Auth-Header** (sekundär):

| Provider | Pfad | Auth-Header | Upstream (Default) |
|---|---|---|---|
| Anthropic | `/v1/messages` | `x-api-key` | `https://api.anthropic.com` |
| OpenAI | `/v1/chat/completions`, `/v1/responses` | `Authorization: Bearer` | `https://api.openai.com` |

Unbekannte Pfade werden anhand des vorhandenen Auth-Headers dem passenden Default-Upstream
zugeordnet und transparent durchgereicht (Tracking = 0, keine Blockade).

### usage-Parsing

**Anthropic** (immer vorhanden):
- Streaming: `message_start` → `message.usage` mit `input_tokens`, `cache_creation_input_tokens`,
  `cache_read_input_tokens`; `message_delta` → `usage.output_tokens` (kumulativ, final).
- Non-Streaming: JSON `.usage` mit denselben Feldern.
- **Cache-Aufschlüsselung:** Ist zusätzlich ein `usage.cache_creation`-Objekt vorhanden
  (`{ ephemeral_5m_input_tokens, ephemeral_1h_input_tokens }`), werden 5m- und 1h-Anteile
  getrennt mit `cacheWrite5m` bzw. `cacheWrite1h` bepreist. Fehlt das Objekt, wird
  `cache_creation_input_tokens` komplett als 5m-Cache (`cacheWrite5m`) behandelt.

**OpenAI:**
- Streaming: `usage` nur im letzten Chunk, **wenn** `stream_options.include_usage=true` gesetzt
  ist. Felder: `prompt_tokens`, `completion_tokens`, `prompt_tokens_details.cached_tokens`.
- Non-Streaming: `.usage` mit denselben Feldern.

### include_usage-Injektion (bewusster, einziger Eingriff)

Bei OpenAI-Streaming-Requests (`"stream": true`) injiziert der Proxy
`stream_options.include_usage=true` in den JSON-Request-Body, damit verlässliche Token-Zahlen
zurückkommen. Der Content-Length-Header wird entsprechend neu berechnet. Schlägt das
Body-Parsing fehl (kein JSON o.ä.), wird der Body **unverändert** durchgereicht (nie blockieren).

Konfigurierbar über `config.json` → `injectOpenAIUsage` (Default `true`).

---

## 5. Pricing-Engine

`pricing.json` mappt Modell-ID → Preise **pro 1 Mio. Tokens (USD)**. Felder je Modell:
`input`, `output`, `cacheWrite5m`, `cacheWrite1h`, `cacheRead`.

Berechnung (USD):
```
kosten =  input_tokens               / 1e6 * preis.input
        + output_tokens              / 1e6 * preis.output
        + cache_creation_input_tokens/ 1e6 * preis.cacheWrite5m
        + cache_read_input_tokens    / 1e6 * preis.cacheRead
```
(OpenAI: `cached_tokens` → `cacheRead`, restliche `prompt_tokens` → `input`.)

### Preis-Defaults (Anthropic, verifiziert 2026-07-02; pro 1M Tokens USD)

| Modell-ID | input | output | cacheWrite5m (×1,25) | cacheWrite1h (×2) | cacheRead (×0,1) |
|---|---|---|---|---|---|
| `claude-fable-5` | 10,00 | 50,00 | 12,50 | 20,00 | 1,00 |
| `claude-opus-4-8` | 5,00 | 25,00 | 6,25 | 10,00 | 0,50 |
| `claude-opus-4-7` | 5,00 | 25,00 | 6,25 | 10,00 | 0,50 |
| `claude-opus-4-6` | 5,00 | 25,00 | 6,25 | 10,00 | 0,50 |
| `claude-opus-4-5` | 5,00 | 25,00 | 6,25 | 10,00 | 0,50 |
| `claude-sonnet-5` | 3,00 | 15,00 | 3,75 | 6,00 | 0,30 |
| `claude-sonnet-4-6` | 3,00 | 15,00 | 3,75 | 6,00 | 0,30 |
| `claude-sonnet-4-5` | 3,00 | 15,00 | 3,75 | 6,00 | 0,30 |
| `claude-haiku-4-5` | 1,00 | 5,00 | 1,25 | 2,00 | 0,10 |

> Hinweis: Claude Sonnet 5 hat Einführungspreise ($2/$10) bis 2026-08-31 — als Kommentar in
> `README`/Spec dokumentiert; die `pricing.json` nutzt reguläre Preise, damit sie nach Ablauf
> korrekt bleibt. Der Nutzer kann jederzeit anpassen.

### Preis-Defaults (OpenAI, Startwerte — vom Nutzer zu verifizieren)

Der Implementierungs-Agent recherchiert aktuelle OpenAI-Preise (z. B. `gpt-4o`, `gpt-4o-mini`,
`o1`, `o3-mini`) per WebSearch und trägt sie ein. Da sich Preise ändern, ist die Datei
editierbar und im README als "bitte prüfen" markiert.

### Unbekannte Modelle

Modell nicht in `pricing.json` → Kosten = 0 **+ Warnung** ans Dashboard
(`{warning: "Preis für Modell X unbekannt"}`). Request wird nie blockiert.

---

## 6. Budget-Schutz

- `config.json` → `dailyLimitUSD` (Default **25**).
- Vor jedem Request liest `budget.js` die kumulierte Tagessumme aus `spend-YYYY-MM-DD.json`.
- **Limit erreicht UND keine `.budget-bypass`-Datei im Arbeitsverzeichnis** → HTTP `429` mit
  Body `{error: "Tageslimit erreicht (X/Y USD). Bypass über Dashboard-Button oder .budget-bypass."}`.
- **`.budget-bypass` existiert** → alle Limits ignoriert, Datenstrom fließt ungehindert.
- Dashboard-Button "Budget-Sperre aufheben/aktivieren" erzeugt/löscht die Datei via
  `POST /api/bypass` (Body `{active: true|false}`). Genau das Per-Mausklick-Feature.

---

## 7. Dashboard (`localhost:9000/dashboard`)

```
┌─────────────────────────────────────────────┐
│  CLAUDE CODE LIVE TRACKER          ● live     │
│                                               │
│         HEUTE:  $ 3.47                         │
│   ▓▓▓▓▓▓▓▓░░░░░░░░░░  3.47 / 25.00  (14%)      │
│                                               │
│  Session: $1.12   ·   1.2M in / 84k out       │
│                                               │
│  Letzte Anfrage:                              │
│   claude-opus-4-8 · 12.3k in · 1.8k out       │
│   cache: 40k read · $0.081                    │
│                                               │
│  [ 🔓 Budget-Sperre aufheben ]                │
└─────────────────────────────────────────────┘
```

- `GET /dashboard` → statische HTML (inline CSS/JS, keine externen Requests — CSP-freundlich).
- `GET /events` → **SSE-Strom**. Beim Verbinden zuerst der aktuelle Stand (State-Replay), dann
  Live-Deltas. Event-Payload (JSON):
  ```json
  {
    "sessionCostUSD": 1.12, "sessionInputTokens": 1200000, "sessionOutputTokens": 84000,
    "todayCostUSD": 3.47, "dailyLimitUSD": 25.0, "bypassActive": false,
    "lastRequest": { "model": "claude-opus-4-8", "inputTokens": 12300,
                     "outputTokens": 1800, "cacheReadTokens": 40000, "costUSD": 0.081 },
    "warning": null
  }
  ```
- `POST /api/bypass` → erzeugt/löscht `.budget-bypass`, broadcastet neuen Stand.

---

## 8. Fehlerbehandlung (Grundsatz: Tracking bricht den Traffic nie)

- **Upstream nicht erreichbar** → `502` an Client + Fehler-Event ans Dashboard-Log.
- **usage nicht parsbar / Modell unbekannt** → Request trotzdem durchgereicht, Kosten = 0,
  Warnung ans Dashboard.
- **Body-Parsing für include_usage-Injektion schlägt fehl** → Body unverändert durchreichen.
- **API-Keys** werden nur durchgereicht, **nie** gespeichert/geloggt.
- **Dashboard-Client trennt** → SSE-Verbindung sauber schließen, aus Broadcast-Liste entfernen.
- **Korrupte/fehlende Spend-Dateien** → als leer behandeln, neu anlegen.

---

## 9. Konfiguration (`config.json`, Defaults)

```json
{
  "port": 9000,
  "dailyLimitUSD": 25.0,
  "injectOpenAIUsage": true,
  "upstreams": {
    "anthropic": "https://api.anthropic.com",
    "openai": "https://api.openai.com"
  }
}
```

---

## 10. Test-Strategie (Node-eigener Runner `node --test`, keine Test-Deps)

- **pricing:** usage → Kosten inkl. Cache-Tokens; unbekanntes Modell → 0 + Warnung.
- **spend:** Aggregation Session + Tag; Tageswechsel (Datei-Rollover); korrupte Datei → leer.
- **providers:** Erkennung Anthropic/OpenAI; usage-Parsing gegen aufgezeichnete SSE-Fixtures
  (Anthropic `message_start`/`message_delta`, OpenAI letzter Chunk); include_usage-Injektion
  (JSON-Body → Flag gesetzt, Content-Length korrekt; Nicht-JSON → unverändert).
- **budget:** Limit erreicht → 429; `.budget-bypass` vorhanden → durch.
- **Integration:** Mock-Upstream (lokaler http-Server), der SSE streamt → Proxy → Client bekommt
  **byte-identischen** Stream, und Spend wird korrekt aktualisiert.

---

## 11. Projekt-Struktur

```
Claude Code Live Tracker/
├── src/
│   ├── proxy.js
│   ├── providers.js
│   ├── pricing.js
│   ├── spend.js
│   ├── budget.js
│   └── dashboard.js
├── public/
│   └── dashboard.html
├── test/
│   ├── pricing.test.js
│   ├── spend.test.js
│   ├── providers.test.js
│   ├── budget.test.js
│   └── integration.test.js
├── config.json
├── pricing.json
├── package.json
├── .gitignore
├── README.md
└── (Laufzeit) session-spend.json, spend-YYYY-MM-DD.json, .budget-bypass
```

---

## 12. Nicht-Ziele (YAGNI)

- Kein TLS-MITM / kein CA-Zertifikat.
- Keine Datenbank — flache JSON-Dateien genügen.
- Keine Authentifizierung am Dashboard (nur localhost).
- Keine historische Langzeit-Auswertung über den Tag hinaus (Tagesdateien bleiben aber liegen).
- Keine externen Frontend-Frameworks.
