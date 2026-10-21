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
Der ausdrückliche Live-Opt-in erlaubt im CLI ausschließlich GET `/api/save`/`/api/colony/installation`
und POST `/api/save`/`/api/routing`; Ausführungs- und Schlüsselrouten bleiben gesperrt.

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

## Lesbare und ausführbare Fachabläufe (20.–21.10.2026)

Im selben Raum stehen inzwischen zusätzlich **H01–H05**: Seiteninventar, Einnahmewege,
Pinterest, Affiliate-Pflege und Seitenqualität. Der Colony-Fachkern hat jetzt versionierte
Auftrags-/Ergebnisverträge für **alle 13 dokumentierten Business-Abläufe**.

- Alle 13 Abläufe erhalten eigene Eingabe-/Ergebnisschemata, Rollenverträge, Quellenprüfungen,
  stabile Objekt-IDs und formale Freigabegates. Kein gemeinsames „Pinterest“-Schema für Artikel,
  Katalogpflege, Newsletter oder Qualitätsprüfungen.
- Fehlen eine echte Quelldatei, Produkt-/Assetrechte, vollständige sieben Mailentwürfe oder
  mobile/linkbezogene Testbelege, wird der Auftrag abgewiesen oder blockiert – nichts wird erfunden.
- Nacharbeit erhält konkrete Prüfbefunde und eine begrenzte Revisions-/No-Progress-Schranke.
  Reviewer sehen den aktuellen vollständigen Paketstand; Freigabe/Actions sind weiter getrennt.
- PNG-Assets gehen über einen geprüften lokalen Uploadweg, werden gehasht, marken-/kontogebunden
  und nur nach ausdrücklicher Rechtebestätigung gespeichert. H05 kann ohne echte Screenshot- und
  Link-/Toolbelege nicht bestehen.
- Geldverbrauch kann bei Go nicht belegt sein; eigener Token-/Zeitmodus lässt den Dollarwert ehrlich
  offen und blockiert bei unbekanntem Token-/Zeitverbrauch.
- WORKFLOWS und der native Editor zeigen einen fachlichen Status statt „READY TO RUN“.
  Bei fehlender Verbindung lautet er „Status nicht bestätigt“. Kein direkter Start oder
  generischer Test dieser Fachabläufe; Aufträge gehören in die Business-Steuerung.
- Aufgaben und Ergebnisse stehen in lesbaren Karten untereinander. Die drei älteren Linien
  sind separat gekennzeichnet; ihre Anweisungen, Agenten und Geometrie bleiben unverändert.
- Die Business-Steuerung erzeugt Aufträge aus bestätigten Paketen, lädt bestehende Agentenmodelle
  ohne Schlüsselzugriff und zeigt Ergebnisse plus strukturierte Prüfbelege. Die Kompatibilität
  der gespeicherten Anschluss-/Konto-Modelle ist kein Inference- oder Produktionsnachweis.
- **Technischer Stand:** alle 13 Fachverträge bestehen synthetische Tests. Zwei isolierte L01-
  Modelltests sind fehlgeschlagen: DeepSeek gab unter der ersten Ein-Turn-Grenze kein JSON zurück;
  GPT-6-Luna antwortete mit Provider-`format_error`. Beide Tasks sind `testOnly` und blockiert.
  Der nächste Test nutzt die vorhandene DeepSeek-Verbindung mit zwei werkzeugfreien Turns und
  4.096-Tokens-Ausgabedeckel. Kein Geschäftsauftrag wurde freigegeben.

```sh
node --test test/colony-processes.test.js test/colony-runtime-contract.test.js test/colony.http.test.js
node --test lab/homestackr-clarity.test.cjs lab/homestackr.test.cjs
node lab/homestackr-clarity.cjs --live-authoring          # Vorschau
node lab/homestackr-clarity.cjs --live-authoring --apply  # nur bestehende H01–H05 beschriften
python3 lab/check-homestackr-clarity.py                  # Desktop/Mobil, alle Browser-Schreibzugriffe gesperrt
node lab/activate-business.cjs --pilot-model deepseek-v4.1-flash --apply # bestehende Modelle, Token/Zeit-Budget
node lab/check-business-live.cjs --live-models           # ausschließlich isolierter Testauftrag
```

Vor dem Speichern wird privat gesichert. Die Migration behält die Save-Revision bei und
verweigert unbekannte/selbst bearbeitete Anweisungen; wiederholtes Anwenden ändert nichts.
Nach dem Speichern die Oberfläche neu laden. Visuelle Nachweise: `output/homestackr-clarity/`.
