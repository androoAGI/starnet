# Lokaler StarNet-Machbarkeitstest

Getrennte lokale Arbeitskopie, kein veroeffentlichter GitHub-Fork. Colony OS wird nicht veraendert.
Ausgangsstand: `d540d503d9c8d5140685881880d46985b27e2f9c`, Upstream-Branch `feat/harness-backend`.
Arbeitsbranch: `lab/lifestruct-spike`.

## Start

```sh
npm ci --ignore-scripts --no-audit --no-fund
node lab/start.cjs
```

URL: `http://127.0.0.1:8790`. Zustand: `.lab-state/`, vom Git ausgeschlossen.

## Live-Modus (echte Modellaufrufe)

```sh
node lab/start.cjs --live
```

- Ausgehende Verbindungen sind nur zu `opencode.ai` und `openrouter.ai` erlaubt
  (`LAB_ALLOW_HOSTS` überschreibt die Liste).
- Der Anbieter im Lab ist auf `CUSTOM` gestellt; die Basis-URL wird auf
  `https://opencode.ai/inference/openai/v1` gesetzt (Chat). Den Modellkatalog liest der
  Server zusätzlich von `https://opencode.ai/inference/v1/models` (85 Modelle).
- Standardmodell und alle Agenten: `deepseek-v4.1-flash` (`LAB_MODEL=…` überschreibt
  es). Details, kostenlose Alternative und Änderung: [`MODELS.md`](MODELS.md).
- **Der Schlüssel fehlt noch.** In der Oberfläche: `SETTINGS → PROVIDERS → CUSTOM`,
  Basis-URL stehen lassen, OpenCode-Schlüssel einfügen, dann das Modell wählen.
- Werkzeuge und Unterprozesse sind im Live-Modus erlaubt, weil echte Agentenarbeit sie
  braucht. Das ist eine bewusste Erweiterung — nur im vertrauenswürdigen Netz starten.
- Weiterhin nicht eingerichtet: Veröffentlichungen, Uploads, Pinterest, Newsletter-Versand.
- `node lab/repair.cjs` korrigiert einen Lab-Stand, dessen Anbieter auf `starnet`
  (verwaltete Abrechnung) gerutscht ist — ohne Konto strandet der Start sonst im
  RESUME-Bildschirm. Läuft bei jedem Start automatisch.
Optionaler Heimnetz-Zugang: `node lab/lan.cjs LAN_IP 8791`. Der passwortgeschuetzte Proxy
bindet nur diese private IPv4-Adresse; der eigentliche Server bleibt auf Loopback.
Zugangsdaten werden einmalig in `.lab-state/lan-access.json` (0600) erzeugt.
Nur im vertrauenswuerdigen Heimnetz verwenden: HTTP ist nicht verschluesselt.
Keine Router-Portfreigabe einrichten. KI-/Upload-Sperren bleiben aktiv.

Aktuell stattdessen nur Tailscale Serve (kein direkter Heimnetz-Listener):

```sh
node lab/lan.cjs 127.0.0.1 8792 https://sandboxhp-virtual-machine.tailcfc506.ts.net:8791
tailscale serve --bg --https=8791 http://127.0.0.1:8792
```

Der vorhandene Passwortschutz bleibt bestehen, jetzt hinter Tailscale-HTTPS.
Die bestehenden Tailscale-Dienste auf anderen Ports bleiben unveraendert.
Nur diese Freigabe entfernen: `tailscale serve --https=8791 off` (kein globales `reset`).
Keine existierenden StarNet-/Colony-Daten oder Provider-Anmeldungen werden importiert.
Der Launcher uebergibt nur eine kleine Liste eigener Umgebungsvariablen und ein separates HOME.
Cron und Night Shift sind ausgeschaltet. Der Testprozess blockiert ausgehende Verbindungen,
Unterprozesse und ausfuehrende HTTP-Schreibzugriffe. Das ist ein Testschutz auf Prozessebene,
keine behauptete Betriebssystem-Sandbox. Keine Zugangsdaten eingeben.

## Workflow-Bearbeitung fuer externe Agenten

Externe Coding-Agenten mit Terminalzugriff koennen diese Kommandos ausfuehren, ohne die UI anzuklicken:

```sh
node lab/workflow.cjs help
node lab/workflow.cjs read
node lab/workflow.cjs create --spec lab/fixtures/lifestruct.json
node lab/workflow.cjs create --spec lab/fixtures/lifestruct.json --apply
node lab/workflow.cjs validate
node lab/workflow.cjs edit --step SCHRITT_ID --patch lab/fixtures/content-edit.json
node lab/workflow.cjs edit --step SCHRITT_ID --patch lab/fixtures/content-edit.json --apply
```

Ohne `--apply` bleibt jede Aenderung eine Vorschau. Die IDs liefert `read`.
`create` legt eine echte StarNet-Linie mit gebundenen Agenten, Arbeitsanweisungen und Uebergaben an.
`edit` aendert in diesem Prototyp nur Arbeitsanweisung, Uebergabetext und Beschriftung.
Fuer strukturelle Aenderungen ist StarNets vorhandener `LineEdit`-Kern nutzbar, aber noch nicht
ueber diese kleine CLI freigegeben. Die HTTP-Schnittstelle speichert revisionsgebunden; ein
Konflikt wird abgelehnt, nicht automatisch ueberschrieben.

**Grenze:** Speichern und Routing-Publizieren sind zwei Schritte, keine atomare Transaktion.
Nach externen Aenderungen Browser neu laden. Nicht gleichzeitig im Browser und extern bearbeiten.
Ein spaeterer produktiver Adapter braucht eine gemeinsame Aenderungsschnittstelle mit Live-Abgleich.
Die existierende MCP-Bruecke ist vor allem fuer Nachrichten, Ereignisse und Freigaben gedacht;
Workflow-Erstellung/-Bearbeitung ist dort noch nicht als eigenes Werkzeug vorhanden.

## Was dieser Pilot nicht tut

- Keine echten KI-Aufgaben, Bilderzeugung oder Pin-Batches erzeugen.
- Keine echten Pinterest-Daten oder PDF-Inhalte verarbeiten.
- Keine vorhandenen CSV-Scripte anbinden: sie wurden noch nicht bereitgestellt.
- Keine Uploads, Nachrichten, Veroeffentlichungen, bezahlten Aufrufe oder Git-Pushes.
- Keine persistente autonome Prozessoptimierung aktivieren.

Die Linie bildet die drei inhaltlichen Rollen ab: Analyst -> Content -> Pruefer -> Outbox.
Technischer Datenimport, CSV-Aufbereitung und Betreiberfreigabe sind absichtlich nicht als
KI-Agenten getarnt. Sie benoetigen spaeter eigene technische Schritte/Handuebergaben.

## HomeStackR-Raum

Ein eigener Raum mit drei Linien (Wissen, Pinterest, Pflege & Affiliate) und neun
zugeordneten Profilen. Einrichtung, Eingaben und Grenzen: [`HOMESTACKR.md`](HOMESTACKR.md).
Kein KI-Lauf und keine Veröffentlichung Teil der Einrichtung. Die OpenCode-Anbindung
ist weiterhin nicht als funktionierend bestätigt.

Zwischen Lifestruct und HomeStackR liegt ein kleiner, besetzter Orchestrator-Raum.
Details und bewusste Grenzen der manuellen Koordination: [`ORCHESTRATOR.md`](ORCHESTRATOR.md).

Auf schmalen Touchscreens pausiert die Szene hinter offenen Menüs, und SETTINGS baut nur den
geöffneten Bereich auf. Messung, Opt-out und Grenzen: [`MOBILE.md`](MOBILE.md).

Die Ladezeit über Tailscale wurde durch WebP-Texturen (232 MB → 39 MB), gzip und ETag/304
deutlich gesenkt. Erster Aufruf bleibt datenintensiv; Folgeladen liegt unter 1 MB.
Ursache, Messung und Grenzen: [`LOADING.md`](LOADING.md).

## Tests

```sh
node --test lab/workflow.test.cjs
node --test lab/guard.test.cjs
node test/pipeline.test.js
node test/line-edit.test.js
node test/line-layout.test.js
node test/line-edit-panel.test.js
node test/conveyor.test.js
```

Nur gegen eine frisch gestartete Lab-Station ohne Pilotlinie:

```sh
node lab/smoke.cjs
```

Der Smoke-Test erstellt und aendert die Pilotlinie ueber die echten lokalen HTTP-Endpunkte.
Er prueft Vorschauen ohne Speicherung, Konfliktablehnung und gesperrte Ausfuehrung.
Er ist absichtlich nicht destruktiv/idempotent: eine bereits vorhandene Pilotlinie wird nicht ersetzt.

Aktueller Ergebnisbericht: `lab/RESULTS.md`. Visuelle Pruefung alternativ mit dem auf diesem Host
installierten Playwright: `python3 lab/check-ui.py`. Sie erzeugt Screenshots in `/tmp/opencode/`.

## Design und Rechte

`frontend/css/lab-theme.css` ist eine kleine ueberlagerte Farbpalette; Geometrie, Objekte,
Verbindungen und Originalgrafiken bleiben unveraendert. `?lab-style=original` zeigt die
urspruengliche Palette. Beide Varianten kennzeichnen den gesperrten lokalen Test.
Dies ist keine neue Produktgestaltung und keine Veroeffentlichungsfreigabe.
StarNets Code steht unter MIT; `LICENSE`, `NOTICE.md` und Drittanbieterhinweise bleiben bestehen.
Originalgrafiken und Marke sind laut Upstream ausdruecklich nicht MIT-lizenziert; sie werden
in diesem lokalen Test nicht als eigene Assets ausgegeben oder veroeffentlicht.
