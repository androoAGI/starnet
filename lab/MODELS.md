# OpenCode-Anbindung und Modelle

Stand: 20. Oktober 2026. Befund aus dem Fehlerbild der Agenten („der OpenCode-Key wird
nicht akzeptiert") – nachgemessen am laufenden System, nicht vermutet.

## Wie OpenCode hier angebunden ist

In der Oberfläche heißt der Anbieter **CUSTOM** – das ist StarNets Karte für jeden
OpenAI-kompatiblen Endpunkt. Der Endpunkt dahinter ist OpenCode:

| Einstellung | Wert |
|---|---|
| Basis-URL (Chat) | `https://opencode.ai/inference/openai/v1` |
| Chat-Endpunkt | `…/inference/openai/v1/chat/completions` |
| Modellkatalog | `…/inference/v1/models` (der Server liest ihn automatisch mit) |
| Standardmodell | `deepseek-v4.1-flash` (Go-Modell) |
| Alle Agenten | derselbe Anbieter und dasselbe Modell |

OpenCode nutzt für Chat und Modellliste **verschiedene Pfade**. Genau daran scheiterte
die frühere Einrichtung: Die Modellliste lag unter `/inference/v1`, der Chat unter
`/inference/openai/v1`. Der Server liest den Katalog jetzt über den dokumentierten
Pfad, auch wenn die Basis-URL auf den Chat zeigt (`sidecar/index.js`, Abschnitt
`listModelsForProvider`).

## Was der gemeldete Fehler wirklich war

Die Agenten meldeten „der Key wird nicht akzeptiert". Gemessen wurde:

| Aufruf (live gegen opencode.ai) | Antwort |
|---|---|
| freies Modell, **ohne** Key | 403 `FreeTierError` – „free tier can only be used from within OpenCode" |
| freies Modell, **falscher** Key | 403 `FreeTierError` (wortgleich) |
| bezahltes Modell, ohne Key | 401 „Missing API key" |
| bezahltes Modell, falscher Key | 401 „Invalid credential" |

Der 403 entsteht **vor** der Schlüsselprüfung. Er sagt also nichts über den Key aus –
er sagt: OpenCodes kostenlose Chat-Modelle sind **nur in der OpenCode-App** nutzbar.
Die Agenten liefen zum Fehlerzeitpunkt auf `deepseek-v4.1-flash-free` (so stand es in
den State-Backups vom 18./19.10.) und meldeten deshalb einen Schlüssel-Schaden, den
es nicht gab.

Der Schlüssel selbst wurde am 18.10. 23:09 beim Speichern mit **401 „Invalid
credential"** abgelehnt (wortgleich zu einem Testkey) – das war ein echter
Schlüssel-Fehler, unabhängig vom Modell. Seitdem lag **kein** Schlüssel auf der
Station; die Läufe endeten mit 401 „Missing API key".

## Regeln für OpenCode (aus der OpenCode-Doku, 20.10.2026)

1. **Schlüssel = Service-Account-Key** aus der Console (`oc_sk_…`), Permission
   mindestens *Inference*. Ein Member- oder Session-Token wird mit „Invalid
   credential" abgelehnt. Anlegen: opencode.ai/console → *Keys* → *Add Service Account*
   → *Add API Key* (wird nur einmal angezeigt).
2. **Freie Chat-Modelle** (Katalog-IDs mit `-free`) sind der OpenCode-App vorbehalten.
   Ein Fremd-Client bekommt dort immer 403. Sie stehen deshalb nicht mehr im
   Modell-Picker (gefiltert in `listModelsForProvider`).
3. **Fremd-Clients melden sich**: eigener User-Agent (`starnet/<Version>`) und eine
   stabile Session-ID in `x-opencode-session` (die Chat-Stream-ID). Das verlangt
   OpenCode für das **Go-Abo** ausdrücklich. Umgesetzt in
   `sidecar/providers/opencode-identity.js`; der Adapter hängt die Kopfzeilen an
   jeden OpenCode-Aufruf.
4. **Go-Abo**: deckt u. a. `deepseek-v4.1-flash` ab (0,15 $/0,60 $ pro 1 M Token
   außerhalb, 0,30 $/1,20 $ in der Spitzenlast; Monatslimit 80 $ laut Preisliste vom
   20.10.2026). Verbrauch: 5 h 20 %, Woche 50 %, Monat 100 % des Monatslimits.

## Modell wählen

- In der Oberfläche: **SETTINGS → AI & MODELS** oder das Modellfeld unten in COMMS.
  Die Liste zeigt die Go-/Bezahl-Modelle; `DEEPSEEK V4.1 FLASH` ist vorausgewählt.
- Für alle Agenten gleichzeitig (ohne UI):

```sh
node lab/set-model.cjs                       # Vorschau
node lab/set-model.cjs --apply               # Standard + alle anwesenden Agenten
```

Das Skript ändert nur Modell/Anbieter, liest keine Schlüssel und startet nichts.
Eine private Sicherung liegt unter `.lab-state/authoring-backups/`. Danach die Seite
neu laden; der native Roster wird dabei synchronisiert.

**Keine `-free`-Modelle mehr**: `LAB_MODEL=…-free` würde jeden Lauf in einen 403
laufen lassen. Nicht mehr verwenden.

## Kosten und Grenzen

- `deepseek-v4.1-flash` läuft über das **Go-Abo** des Kontos; der Verbrauch zählt
  gegen das Monatslimit des Workspaces.
- Kein Kostenlimit pro Tag im Lab abgestimmt oder eingerichtet.
- Der Schlüssel liegt unter dem Anbieter CUSTOM; ein Wechsel auf eine andere
  Anbieterkarte würde ihn nicht mitnehmen. Nicht nötig – CUSTOM ist der OpenCode-Platz.
- **Der Schlüssel muss einmal gespeichert sein.** Die Oberfläche:
  `SETTINGS → PROVIDERS → CUSTOM` – Basis-URL stehen lassen – Schlüssel einfügen – SAVE.
  Beim Speichern prüft der Server den Schlüssel: Er listet zuerst den öffentlichen
  Katalog und schickt danach eine winzige echte Anfrage („Reply with OK."). Erst wenn
  die antwortet, gilt der Schlüssel als bestätigt. **Diese Mini-Anfrage beweist den
  Schlüssel, nicht das gerade gewählte Modell** – ein freies Modell wird dafür
  automatisch übersprungen.
- Die Anbieter-Prüfung (`/api/providers/probe`) ist jetzt ehrlich: Für einen
  entfernten Custom-Endpunkt zählt ein **echter** Aufruf als Beweis, nicht die
  öffentliche Modellliste. Vorher meldete sie „credentials verified" für eine Station
  ganz ohne Schlüssel.
- Der Live-Modus erlaubt echte Aufrufe zu `opencode.ai` und `openrouter.ai`. Das ist
  keine harte Sandbox und keine Kostenbremse.
