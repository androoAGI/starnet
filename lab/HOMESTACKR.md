# HomeStackR im StarNet-Lab

Ein eigener, direkt angeschlossener Raum mit neun eigenen Profilen und drei getrennten Linien:

- **Wissen:** Thema/Primärquellen → Artikelentwurf → Fakten-/Lesbarkeitsprüfung → Outbox.
- **Pinterest:** Artikel/optionale Pin-Zahlen → Pin-Entwürfe → Aussagen-/Link-/Bildrechteprüfung → Outbox.
- **Pflege & Affiliate:** Bestandsanalyse → gezielte Änderungsvorschläge → Qualitäts-/Datenschutzprüfung → Outbox.

Alle Linien werden einzeln manuell über ihre INBOX beauftragt. Die Outbox ist nur ein
Ergebnisablageort: Das Prüfurteil eines Agenten ersetzt keine Betreiberfreigabe. Die Linien
starten sich nicht gegenseitig; es gibt keine eingerichteten Zeitpläne, Uploads oder Webhooks.
Ein fehlgeschlagener Review führt in diesem linearen Entwurf noch nicht technisch zurück zum
Autor. Der Status NACHARBEIT/BLOCKIERT muss vom Betreiber aufgegriffen werden.

## Benötigte Eingaben

- **Wissen:** Thema/Leserproblem, Zielgruppe, vorhandene Artikel und Primärquellen bzw. ein
  ausdrücklich freigegebener Rechercheauftrag.
- **Pinterest:** bestätigter Artikeltext und echte Artikel-URL, gewünschte Menge (sonst drei),
  Bild-/Markenvorgaben, Bildrechte und Board-Liste. Pin-Export mit Zeitraum/Impressionen/Klicks
  optional; ohne Export keine Performance-Auswertung.
- **Pflege:** vorhandener Artikel, aktuelle Primärquellen; für Empfehlungen ein freigegebener
  Affiliate-Katalog. Umami-/Search-Console-Exporte optional. Keine personenbezogenen Daten.

Quellgrundlage für die Rollen: lokal gelesene HomeStackR `README.md`, `CONTENT.md` und
`AGENTS.md` (18.10.2026). Alte Roadmaps oder Routinen wurden nicht als neuer Auftrag aktiviert.
Die HomeStackR-Regeln zu Einsteigerverständlichkeit, lokal-first, cookie-freiem Datenschutz,
belegten Aussagen und kontextuellen/gegebenenfalls werbefreien Empfehlungen sind in den
Schrittanweisungen zusammengefasst.

## Bewusste Grenzen

- Nur Konfiguration erstellt, keine Modelle ausgeführt. Modell-Pin für die neuen Profile:
  `custom` / `deepseek-v4.1-flash-free`. Die OpenCode-Anbindung ist noch nicht als funktionierend
  bestätigt; das bloße Auswählen dieses Modells ist kein Inference-Nachweis.
- Kein automatischer Daten-/Dateiimport, keine Bilderzeugung, keine CSV-/Pinterest-Anbindung.
- Kein Projektordner an die Linien gebunden, keine Änderung der echten HomeStackR-Webseite,
  keine Anbindung ihrer bestehenden Kanban-/Routines-/GitHub-Workflows.
- `approvalMode=ask`, `workshop=false` sind Profilvorgaben, **keine harte Sandbox**.
  Die Anweisungen gegen Publizieren/Repo-Änderungen sind keine technische Netzsperre.
- Lifestruct-Profile, Räume, Props, Links, Belts, Sessions und Provider-Einstellungen werden
  nicht überschrieben. Der Browser muss nach einer externen Änderung neu geladen werden.
- Speichern und Routing-Publizieren sind weiterhin nicht atomar. Die native Oberfläche
  synchronisiert nach dem Neuladen den vollständigen Crew-Roster.

## Reproduzierbare Einrichtung

```sh
node --test lab/workflow.test.cjs lab/homestackr.test.cjs
node lab/homestackr.cjs --live-authoring           # nur Vorschau
node lab/homestackr.cjs --live-authoring --apply   # einmalig speichern
```

Vor einem zweiten Anlegen wird abgebrochen. Save-Revisionen werden erhalten, sodass die
native API parallele/veraltete Speicherungen ablehnen kann. Vor `--apply` wird eine private
Sicherung in `.lab-state/authoring-backups/` erzeugt. Keine Schlüssel werden gelesen.
Der ausdrückliche Live-Opt-in erlaubt im CLI ausschließlich GET `/api/save` und POST
`/api/save`/`/api/routing`; Ausführungs- und Schlüsselrouten bleiben für dieses CLI gesperrt.

## Nachweise der Einrichtung (18.10.2026)

- 13 Lab-Tests erfolgreich (Workflow, HomeStackR, Offline-Guard und Proxy). Nicht als
  umfassender Sicherheitstest des Live-Modus zu verstehen.
- `evidence/homestackr-browser.json`: Desktop und emuliertes Smartphone bereit, drei
  HomeStackR-Linien mit je drei besetzten Schritten, neun Profile, native Roster-Synchronisation
  erfolgreich, keine JavaScript-Seitenfehler und keine Modellaufrufe im UI-Zähler.
  Der Browsercheck sperrt alle nicht benötigten Schreib-/externen Zugriffe zusätzlich.
- `evidence/homestackr-preservation.json`: gespeicherte Lifestruct-Räume, Props, Links,
  Belts und bisherige Agenten-Einstellungen nach dem UI-Reload unverändert geprüft.
- Screenshots: `/tmp/opencode/starnet-homestackr/` (nur Hostprüfung, kein Nachweis
  für den Zugriff von einem fremden Smartphone über Tailscale).
