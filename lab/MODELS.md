# OpenCode-Anbindung und Modelle

Stand: 19. Oktober 2026. Keine Modellaufrufe Teil dieser Einrichtung; der Schlüssel
wurde weder gelesen noch ausgegeben.

## Wie OpenCode hier angebunden ist

In der Oberfläche heißt der Anbieter **CUSTOM** – das ist StarNets Karte für jeden
OpenAI-kompatiblen Endpunkt. Der Endpunkt dahinter ist OpenCode:

| Einstellung | Wert |
|---|---|
| Basis-URL (Chat) | `https://opencode.ai/inference/openai/v1` |
| Chat-Endpunkt | `…/inference/openai/v1/chat/completions` |
| Modellkatalog | `…/inference/v1/models` (der Server liest ihn automatisch mit) |
| Standardmodell | `deepseek-v4.1-flash` |
| Alle Agenten | derselbe Anbieter und dasselbe Modell |

OpenCode nutzt für Chat und Modellliste **verschiedene Pfade**. Genau daran scheiterte
die frühere Einrichtung: Die Modellliste lag unter `/inference/v1`, der Chat unter
`/inference/openai/v1`. Der Server liest den Katalog jetzt über den dokumentierten
Pfad, auch wenn die Basis-URL auf den Chat zeigt (`sidecar/index.js`, Abschnitt
`listModelsForProvider`).

## Modell wählen

- In der Oberfläche: **SETTINGS → AI & MODELS** oder das Modellfeld unten in COMMS.
  Die Liste zeigt jetzt die 85 OpenCode-Modelle; `DEEPSEEK V4.1 FLASH` ist vorausgewählt.
- Für alle Agenten gleichzeitig (ohne UI):

```sh
node lab/set-model.cjs                       # Vorschau
node lab/set-model.cjs --apply               # Standard + alle anwesenden Agenten
LAB_MODEL=deepseek-v4.1-flash-free node lab/set-model.cjs --apply   # kostenlose Variante
```

Das Skript ändert nur Modell/Anbieter, liest keine Schlüssel und startet nichts.
Eine private Sicherung liegt unter `.lab-state/authoring-backups/`. Danach die Seite
neu laden; der native Roster wird dabei synchronisiert.

## Kosten und Grenzen

- `deepseek-v4.1-flash` ist **kostenpflichtig** (OpenCode: 0,30 $ / 1,20 $ pro 1 M
  Token Ein-/Ausgabe, Stand 19.10.2026). Die kostenlose Variante heißt
  `deepseek-v4.1-flash-free`.
- Kein Kostenlimit pro Tag im Lab abgestimmt oder eingerichtet.
- Der Schlüssel liegt unter dem Anbieter CUSTOM; ein Wechsel auf eine andere
  Anbieterkarte würde ihn nicht mitnehmen. Nicht nötig – CUSTOM ist der OpenCode-Platz.
- **Der Schlüssel muss einmal gespeichert sein.** Die Oberfläche:
  `SETTINGS → PROVIDERS → CUSTOM` – Basis-URL stehen lassen – Schlüssel einfügen – SAVE.
  Beim Speichern prüft der Server den Schlüssel jetzt korrekt: Er listet zuerst den
  öffentlichen Katalog (85 Modelle) und schickt danach eine winzige echte Anfrage
  („Reply with OK.“) über den Chat-Pfad. Erst wenn die antwortet, gilt der Schlüssel
  als bestätigt. Diese eine Mini-Anfrage ist der einzige Modellaufruf des Speicherns.
  Vorher scheiterte genau hier jede Speicherung, weil der Server die Modellliste am
  falschen Pfad suchte (dieselbe Ursache wie die leere Modellwahl).
- Der Live-Modus erlaubt echte Aufrufe zu `opencode.ai` und `openrouter.ai`. Das ist
  keine harte Sandbox und keine Kostenbremse.
- Die Anbindung wurde per Anbieter-Prüfung (`/api/providers/probe`) bestätigt:
  erreichbar, Katalog vorhanden, Schlüssel akzeptiert. Ein echter Chat-Aufruf wurde
  bewusst nicht gestartet.
