# Claude Code Live Tracker

[![CI](https://github.com/mixxan05/claude-code-livetracker/actions/workflows/ci.yml/badge.svg)](https://github.com/mixxan05/claude-code-livetracker/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](package.json)

Ein **lokaler Reverse-Proxy** als Echtzeit-Kostenwächter für den API-Verkehr autonomer
Coding-Agenten (Claude Code, Aider, Cursor, VS Code). Der Proxy fängt den Verkehr ab, parst das
`usage`-Feld der Antworten, berechnet in Millisekunden die echten Kosten und streamt sie live in
ein minimalistisches Web-Dashboard. Integriert ist ein per Mausklick schaltbarer **Budget-Schutz**
mit Tageslimit.

**Kernversprechen:**
- Keine Cloud liest mit — API-Keys werden nur **durchgereicht**, nie gespeichert oder geloggt.
- Kein komplexes Setup — **ein** `node`-Befehl, **kein** TLS-Zertifikat, **kein** CA-Import.
- Zero-Dependency — ausschließlich Node-stdlib, keine npm-Pakete.

Der Proxy spricht **HTTP** mit der IDE (localhost, kein TLS nötig) und **HTTPS** mit dem echten
Upstream. Das Tracking läuft parallel zum durchgereichten Stream und verzögert den Verkehr **nie**.

---

## Voraussetzungen

- **Node.js ≥ 18** (getestet mit v22). Keine weiteren Abhängigkeiten.

## Setup & Start

```bash
git clone https://github.com/mixxan05/claude-code-livetracker.git
cd claude-code-livetracker
node src/proxy.js
```

Der Proxy lauscht standardmäßig auf **Port 9000** (konfigurierbar in `config.json`). Nach dem
Start wird die Dashboard-URL in der Konsole ausgegeben.

Alternativ per npm-Script:

```bash
npm start
```

---

## Einbindung der IDEs / CLIs

Setze die jeweilige Base-URL-Umgebungsvariable so, dass sie auf den lokalen Proxy zeigt:

| Client | Umgebungsvariable | Wert |
|---|---|---|
| **Claude Code / Aider (Anthropic)** | `ANTHROPIC_BASE_URL` | `http://localhost:9000` |
| **Aider / Cursor (OpenAI-kompatibel)** | `OPENAI_API_BASE` | `http://localhost:9000/v1` |
| **VS Code Extensions** | jeweiliges Custom-Base-URL-Feld | `http://localhost:9000` |

Beispiel (PowerShell):

```powershell
$env:ANTHROPIC_BASE_URL = "http://localhost:9000"
```

Beispiel (Bash):

```bash
export ANTHROPIC_BASE_URL="http://localhost:9000"
export OPENAI_API_BASE="http://localhost:9000/v1"
```

Dein API-Key wird wie gewohnt über `x-api-key` (Anthropic) bzw. `Authorization: Bearer …`
(OpenAI) gesetzt und vom Proxy unverändert an den echten Upstream durchgereicht.

---

## Dashboard

Öffne im Browser:

```
http://localhost:9000/dashboard
```

Das Dashboard zeigt live: heutige Gesamtkosten samt Tageslimit-Balken, Session-Kosten,
Token-Zähler (in/out) sowie die zuletzt verarbeitete Anfrage (Modell, Tokens, Cache-Reads,
Kosten). Die Aktualisierung erfolgt über **Server-Sent Events** (`/events`) — beim Verbinden wird
zunächst der aktuelle Stand nachgeliefert, danach kommen Live-Updates.

---

## Budget-Schutz & Bypass

- Das Tageslimit steht in `config.json` unter `dailyLimitUSD` (Default **25 USD**).
- Ist das Limit erreicht **und** kein Bypass aktiv, antwortet der Proxy mit **HTTP 429** und einer
  klaren Fehlermeldung — der Upstream wird nicht mehr kontaktiert.
- **Bypass aufheben/aktivieren** geht auf zwei Wegen:
  - **Per Mausklick** über den Button im Dashboard (`POST /api/bypass`).
  - **Manuell** durch Anlegen/Löschen der Datei `.budget-bypass` im Projektverzeichnis.
- Solange `.budget-bypass` existiert, werden alle Limits ignoriert und der Verkehr fließt
  ungehindert.

---

## Preise anpassen (`pricing.json`)

`pricing.json` mappt jede Modell-ID auf Preise **pro 1 Mio. Tokens (USD)** mit den Feldern
`input`, `output`, `cacheWrite5m`, `cacheWrite1h`, `cacheRead`. Die Datei ist **frei editierbar** —
nach Änderungen den Proxy neu starten.

Unbekannte Modelle (nicht in `pricing.json`) werden mit **Kosten = 0** und einer Warnung im
Dashboard behandelt; der Request wird nie blockiert.

### Anthropic-Preise

Verbindlich hinterlegt (Stand 2026-07-02). **Hinweis:** Claude **Sonnet 5** hat
**Einführungspreise von $2 / $10** (input/output pro 1M Tokens) **bis 2026-08-31**. Die
`pricing.json` verwendet bewusst die **regulären** Preise ($3 / $15), damit sie nach Ablauf der
Aktion korrekt bleibt. Wer die Einführungspreise abbilden will, passt `claude-sonnet-5`
vorübergehend an (`input: 2`, `output: 10`, `cacheWrite5m: 2.5`, `cacheWrite1h: 4`,
`cacheRead: 0.2`).

### OpenAI-Preise — **bitte prüfen**

> **⚠️ Bitte prüfen:** Die OpenAI-Preise wurden per Websuche (Juli 2026) recherchiert und als
> Startwerte eingetragen. OpenAI-Preise ändern sich häufig — bitte gegen die offizielle
> [OpenAI-API-Preisseite](https://developers.openai.com/api/docs/pricing) abgleichen und bei Bedarf
> in `pricing.json` korrigieren. Für OpenAI-Modelle sind `cacheWrite5m`/`cacheWrite1h` gleich
> `input` gesetzt, da OpenAI Cache-Schreibvorgänge nicht separat berechnet.

Eingetragene Startwerte (input / output / cacheRead, pro 1M Tokens USD):

| Modell | input | output | cacheRead |
|---|---|---|---|
| `gpt-4o` | 2.50 | 10.00 | 1.25 |
| `gpt-4o-mini` | 0.15 | 0.60 | 0.075 |
| `gpt-4.1` | 2.00 | 8.00 | 0.50 |
| `gpt-4.1-mini` | 0.40 | 1.60 | 0.10 |
| `gpt-4.1-nano` | 0.10 | 0.40 | 0.025 |
| `o1` | 15.00 | 60.00 | 7.50 |
| `o3` | 2.00 | 8.00 | 0.50 |
| `o3-mini` | 1.10 | 4.40 | 0.55 |
| `o4-mini` | 1.10 | 4.40 | 0.275 |
| `gpt-5` | 1.25 | 10.00 | 0.125 |
| `gpt-5-mini` | 0.25 | 2.00 | 0.025 |
| `gpt-5-nano` | 0.05 | 0.40 | 0.005 |

---

## Konfiguration (`config.json`)

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

- `injectOpenAIUsage` (Default `true`): Bei OpenAI-Streaming-Requests wird
  `stream_options.include_usage=true` in den Request-Body injiziert, damit verlässliche
  Token-Zahlen zurückkommen. Schlägt das Body-Parsing fehl, wird der Body unverändert
  durchgereicht.

---

## Tests

```bash
node --test
```

Nutzt den in Node integrierten Test-Runner (keine Test-Dependencies).

---

## Laufzeit-Artefakte

Folgende Dateien werden zur Laufzeit erzeugt und sind per `.gitignore` ausgenommen (sie enthalten
lokale Verbrauchsdaten):

- `session-spend.json` — Kosten/Tokens der laufenden Session.
- `spend-YYYY-MM-DD.json` — Tagesaggregat (lokales Datum).
- `.budget-bypass` — Marker-Datei; existiert = Budget-Sperre aufgehoben.

---

## Projektstruktur

```
Claude Code Live Tracker/
├── src/
│   ├── proxy.js        # HTTP-Server, Routing, transparentes Streaming + Tap
│   ├── providers.js    # Provider-Erkennung, Upstream-Auflösung, usage-Parsing
│   ├── pricing.js      # usage → Kosten (lädt pricing.json)
│   ├── spend.js        # Persistenz Session + Tag, Aggregation
│   ├── budget.js       # Limit-Prüfung, .budget-bypass-Handling
│   └── dashboard.js    # SSE-Broadcast, statische Seite, Bypass-Endpoint
├── public/
│   └── dashboard.html  # Live-Dashboard (inline CSS/JS, keine externen Deps)
├── test/               # Tests via `node --test`
├── config.json         # Port, Tageslimit, Upstreams
├── pricing.json        # Modell-Preise pro 1M Tokens (editierbar)
├── package.json
└── docs/
    ├── contracts.md    # Verbindliche Modul-Schnittstellen
    └── superpowers/specs/2026-07-02-claude-code-live-tracker-design.md
```

---

## Mitwirken

Beiträge sind willkommen! Das Projekt ist bewusst **zero-dependency** (ausschließlich
Node-stdlib) — bitte diesen Grundsatz beibehalten. Vor einem Pull Request `node --test`
ausführen; alle Tests müssen grün sein. Neue Funktionen möglichst mit Tests abdecken.

## Lizenz

[MIT](LICENSE) © Michael Kaiser
