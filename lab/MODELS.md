# OpenCode-Anbindung und Modelle

Stand: 20. Oktober 2026. Befund aus dem Fehlerbild der Agenten („der OpenCode-Key wird
nicht akzeptiert") – nachgemessen am laufenden System, nicht vermutet.

## Wie OpenCode hier angebunden ist

In der Oberfläche heißt der Anbieter **CUSTOM** – das ist StarNets Karte für jeden
OpenAI-kompatiblen Endpunkt. Der Endpunkt dahinter ist OpenCode:

| Einstellung | Wert |
|---|---|
| Basis-URL (Chat **und** Katalog) | `https://opencode.ai/zen/go/v1` |
| Chat-Endpunkt | `…/zen/go/v1/chat/completions` |
| Modellkatalog | `…/zen/go/v1/models` (34 Go-Modelle) |
| Standardmodell | `deepseek-v4.1-flash` |
| Alle Agenten | derselbe Anbieter und dasselbe Modell |

## Die zwei OpenCode-Endpunkte (der Knackpunkt)

OpenCode hat **zwei** Endpunkte, und sie sind **nicht austauschbar**:

| Zweck | Basis-URL | Katalog | Wer darf dort ran? |
|---|---|---|---|
| **Go-Abo** | `https://opencode.ai/zen/go/v1` | `…/zen/go/v1/models` | Go-Keys (Abo) |
| Pay-as-you-go | `https://opencode.ai/inference/openai/v1` | `…/inference/v1/models` | Keys mit Guthaben |

Gemessen am 20.10.2026:

- Ein **Go-Key auf dem Pay-as-you-go-Pfad** antwortet mit
  **403 „Model access is disabled"** – der Key ist gültig, hat dort aber keinen
  Modellzugriff. Genau das war der letzte gemeldete Fehler.
- Der **Go-Pfad verlangt** `x-opencode-session` (eine Gesprächs-ID). Ohne sie:
  **400 „MissingSessionID"**. StarNet sendet die Chat-Stream-ID pro Lauf.
- Der Go-Pfad kennt **34 Modelle** (u. a. `deepseek-v4.1-flash`, `deepseek-v4-pro`,
  `glm-5.1`, `grok-4.6`). Die `…-free`-Modelle des Free Tiers gibt es dort nicht.

Deshalb steht das Labor jetzt auf `https://opencode.ai/zen/go/v1` (`lab/start.cjs`
und `frontend/js/lab-theme.js`). Der alte Pay-as-you-go-Pfad bleibt als Fallback
im Code (Katalog-Fallback `listModelsForProvider`), wird aber nicht mehr benutzt.

**Antwort auf „brauche ich einen neuen Key?": Kommt darauf an.** Ein **403**
(freies Modell im Free-Tier) ist kein Key-Problem – derselbe Key gehört auf den
Go-Pfad. Ein **401 „Invalid credential"** dagegen heißt: OpenCode erkennt diesen
Key nicht. Dann hilft nur ein anderer Key (Service-Account-Key `oc_sk_…` aus der
Console, Permission *Inference*, aus dem Workspace mit dem Go-Abo).

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

## Was am 20.10.2026 Vormittag noch dazukam (gemessen, nicht vermutet)

Zwei Meldungen kamen gleichzeitig: „andere Anbieter lassen sich nicht hinzufügen"
und „der Custom-Provider sagt, der Key wird abgelehnt". Beides war gemessen:

| Beobachtung | Messung | Ursache |
|---|---|---|
| ChatGPT/Grok/Kimi: **Anmeldung startet nicht** | `LAB_BLOCKED: auth.openai.com is not on the allowed host list` | Die Anbieter-Karte nennt den **Inferenz**-Host; die **Anmeldung** (Device-Code) läuft über den Auth-Host. Der Guard kannte nur die Inferenz-Hosts. |
| OpenCode-Key: **401 „Invalid credential"** | Wortgleich mit einem **erfundenen** Key (`oc_sk_6aFAKE…`) | Der Key selbst wird von OpenCode nicht erkannt – abgelaufen, widerrufen, aus einem anderen Workspace oder unvollständig kopiert. **Nicht** StarNets Fehler. |
| Lauf antwortet **„Go requires a credential"** | Der Key kam **gar nicht** an | Das Labor startet im Dev-Schnellpfad (`STARNET_DEV=1`). Der nimmt an, der Server halte den Key – im Labor tut er das nicht. Die Seite schickte den eingefuegten Key deshalb **weder** mit dem Lauf **noch** an die Station. |
| **Anderer** Anbieter (OpenRouter) | Key geprueft, **verifiziert** | Das Hinzufuegen geht. Nur der OpenCode-Key passt dort natuerlich nicht – das sagt die Oberflaeche jetzt auch. |

Gemessen am 20.10.2026 mit dem OpenCode-CLI-Key dieses Rechners (`~/.local/share/opencode/auth.json`):

| Aufruf | Antwort |
|---|---|
| Go-Pfad, **gültiger** Key, mit `x-opencode-session` | **200** – das Modell antwortet (`LAB-OK`) |
| Go-Pfad, gültiger Key, **ohne** Session-ID | 400 `MissingSessionID` |
| Go-Pfad, **erfundener** Key | 401 `Invalid credential` |
| Go-Pfad, **kein** Key | 401 `Go requires a credential` |
| Pay-as-you-go-Pfad, Go-Key | 402 `Insufficient account funds` |

Damit ist klar: **StarNets Weg ist richtig** (Modell antwortet), der eingefuegte Key
war es nicht. Und: der eingefuegte Key muss **verwendet** werden – der
Dev-Schnellpfad liess ihn frueher fallen.

## Was daraus gefixt wurde (20.10.2026)

1. **Die Auth-Hosts sind erlaubt** (Anbieter-Registry `authHosts` → Guard-Liste):
   `auth.openai.com`, `auth.x.ai`, `auth.kimi.com`, `auth.kimi.ai`, `api.kimi.ai`.
   ChatGPT, Grok und Kimi koennen sich anmelden.
2. **Der eingefuegte Key wird benutzt.** Der Dev-Schnellpfad unterschied jetzt
   „der Server haelt den Key" (nur wenn er wirklich einen haelt – `DEV.hasKey`) von
   „hier laeuft ein Dev-Host". Im Labor gilt die zweite Variante: die Seite schickt
   den Key mit jedem Lauf und uebergibt der Station eine Kopie.
3. **Der Retext wird nicht mehr abgeschnitten.** Vorher endete die Meldung genau
   dort, wo der Retext begann („…is refused with exactly this me"), also ohne
   Handlungsanweisung. Jetzt bleibt der Rat vollständig: welche Art von Key, wo
   er herkommt, was zu tun ist.

## Regeln für OpenCode (aus der OpenCode-Doku, 20.10.2026)

1. **Schlüssel = Service-Account-Key** aus der Console (`oc_sk_…`), Permission
   mindestens *Inference*. Ein Member- oder Session-Token wird mit „Invalid
   credential" abgelehnt. Anlegen: opencode.ai/console → *Keys* → *Add Service Account*
   → *Add API Key* (wird nur einmal angezeigt). **Das Go-Abo selbst ist kein Key** –
   der Key gehört zum Workspace, der das Abo trägt.
2. **Freie Chat-Modelle** (Katalog-IDs mit `-free`) sind der OpenCode-App vorbehalten.
   Ein Fremd-Client bekommt dort immer 403. Sie stehen deshalb nicht mehr im
   Modell-Picker (gefiltert in `listModelsForProvider`).
3. **Fremd-Clients melden sich**: eigener User-Agent (`starnet/<Version>`) und eine
   stabile Session-ID in `x-opencode-session` (die Chat-Stream-ID). Das verlangt
   OpenCode für das **Go-Abo** ausdrücklich – ohne Session-ID antwortet der
   Go-Pfad mit 400 `MissingSessionID`. Umgesetzt in
   `sidecar/providers/opencode-identity.js`; der Adapter hängt die Kopfzeilen an
   jeden OpenCode-Aufruf.
4. **Go-Abo**: deckt u. a. `deepseek-v4.1-flash` ab (0,15 $/0,60 $ pro 1 M Token
   außerhalb, 0,30 $/1,20 $ in der Spitzenlast; Monatslimit 80 $ laut Preisliste vom
   20.10.2026). Verbrauch: 5 h 20 %, Woche 50 %, Monat 100 % des Monatslimits.

## Modell wählen

- In der Oberfläche: **SETTINGS → AI & MODELS** oder das Modellfeld unten in COMMS.
  Die Liste zeigt die 34 Go-Modelle; `DEEPSEEK V4.1 FLASH` ist vorausgewählt.
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
