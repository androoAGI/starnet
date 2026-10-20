# Ergebnis des lokalen Machbarkeitstests

Stand: 18. Oktober 2026. Getesteter Upstream-Commit: `d540d503d9c8d5140685881880d46985b27e2f9c`.

## Bestaetigt

- Lokaler Start des Node-Servers auf Linux und Port 8790, mit eigenem HOME und Datenspeicher.
- Ein externer Coding-Agent (diese Session) kann eine echte Linie ohne UI-Klicks erstellen,
  lesen, pruefen und deren Schrittanweisungen bearbeiten.
- StarNets eigener Editor/Compiler wird wiederverwendet, keine parallele Workflow-Engine gebaut.
- Lifestruct hat drei feste Testprofile und eine Linie Analyst -> Content -> Review -> Outbox.
  Jedem Profil wurde ein echter Computer zugewiesen; die UI erkennt die Linie strukturell als eingerichtet.
- Die extern gespeicherte Aenderung am Content-Schritt erscheint nach Neuladen in der realen UI.
- Ein veralteter API-Schreibzugriff wird abgewiesen. Die neuere Speicherung bleibt bestehen.
- Vorschauen veraendern den gespeicherten Zustand nicht.
- Originalpalette und kleine eigene Farbpalette zeigen dieselbe Workflow-Konfiguration.
- In beiden Browserpruefungen: keine JavaScript-Seitenfehler, keine Agentenlaeufe.
- Modell-/Upload-Ausfuehrung ist im Lab blockiert. Es wurden keine Provider-Anmeldungen eingerichtet.
- Colony OS bleibt unveraendert; es wurde nichts gepusht oder oeffentlich geforkt.

## Nachweise

- `evidence/http-smoke.json`: neun bestandene HTTP-Pruefungen.
- `evidence/browser.json`: Headless-Browserpruefung beider Paletten, Rollen und Arbeitsanweisungen.
- `evidence/validation.json`: Routing- und Workflow-Zustand.
- Screenshots liegen unter `/tmp/opencode/starnet-lab-visual/`.
- `workflow.test.cjs`: vier Tests fuer Erstellung, Bearbeitung, Routing, Undo und negative Gegenfaelle.
- `guard.test.cjs`: Sperren fuer ausgehende I/O und fremde Zielstationen.
- Upstream-Tests bestanden: pipeline (187), line-edit (120), line-layout (382),
  line-edit-panel (37), conveyor (220), save (84), mcp-serve (44 Assertions)
  sowie save-concurrency. Nicht die gesamte umfangreiche Upstream-Suite ausgefuehrt.

## Grenzen / vor produktiver Nutzung

- Dies ist ein Konfigurations- und Integrationsnachweis, KEIN abgeschlossener KI-Pin-Produktionslauf.
- Es wurden weder echte Analytics noch PDF-Inhalte verarbeitet. Die vorhandenen CSV-Scripte fehlen noch.
- Das neue CLI kann feste lineare Workflows erstellen sowie Anweisung/Uebergabe/Beschriftung aendern.
  Beliebige strukturelle Bearbeitung, MCP-Workflow-Werkzeuge und atomarer Live-Abgleich fehlen noch.
- Speichern und Routing-Publizieren sind getrennte HTTP-Schritte. Browser nach externen Aenderungen
  neu laden; gleichzeitige Bearbeitung ist nicht als produktiv sicher abgenommen.
- Die Farbpalette ist nur ein kleiner Stiltest. Originalgrafiken bleiben unveraendert und werden
  nicht als eigene oder frei lizenzierte Assets ausgegeben.
- `oc-check` hing bei der Live-Canvas-/SSE-Oberflaeche. Visuelle Verifikation erfolgte danach erfolgreich
  mit dem auf dem Host installierten Playwright und Chromium, ohne die CSP zu lockern.
- Abhaengigkeiten mit `--ignore-scripts` installiert. Die native PTY-Komponente ist deshalb nicht gebaut;
  der eingebettete Terminalbetrieb wurde nicht bestaetigt. Externe CLI-Bearbeitung funktioniert ohne PTY.
- Das Lab meldet absichtlich ein nicht vorhandenes Modell (`lab/no-model`). Ein UI-Status wie
  "ready to run" prueft nur die Struktur und ist KEINE Freigabe fuer echte Modellarbeit.
- Prozessebene-Testschutz, keine Betriebssystem-Sandbox und keine umfassende Sicherheitsabnahme.
- Die lokale Arbeitskopie inklusive Abhaengigkeiten belegt ungefaehr 6 GiB; auf diesem Host ist der
  verbleibende Speicher knapp. Vor groesseren Builds/weiteren Kopien Platzbedarf klaeren.

## Empfehlung

### Nachtrag: Live-Modus und Startzeit (18. Oktober 2026)

- Ursache: Der Testschutz blockierte ausgehende Verbindungen und alle Schlüssel-/Start-Routen;
  zusätzlich stand der gespeicherte Anbieter auf `starnet` (verwaltete Abrechnung), wofür im Lab
  kein Konto existiert. Dadurch landete der Start dauerhaft im RESUME-Bildschirm.
- Behoben: ausdrücklicher Live-Modus (`--live`) mit Host-Liste, automatische Anbieter-Reparatur
  beim Start, Einstieg direkt in die Station.
- Gemessen: DOM bereit 0,6 s, Station sichtbar 5,1 s, voll betriebsbereit 5,4 s,
  keine JavaScript-Seitenfehler. Vorher: nie betriebsbereit, dauerhaft Anmeldebildschirm.
- `https://opencode.ai/inference/v1` liefert 85 Modelle. Standardmodell bleibt ein kostenloses.
- Offen: echter Ende-zu-Ende-Modellaufruf mit Kosten-/Nutzungsnachweis; Schlüssel wird noch
  in der Oberfläche eingetragen.

### Nachtrag: Design an Draftidea angenaehert (ohne Roboter-Tausch)

- Gruen entfernt. Warme Palette: Eiche/Parkett, helle Waende, Stein-Huelle, dunkle Schilder, Gold-Akzente.
- CRT-Scanlines, Flimmern und Monospace-Zwangs-Schrift in der Stilprobe abgeschaltet.
- Eigenes Colony-Wordmark als SVG, Originalgrafiken sonst unveraendert.
- Colony-Roboter bewusst NICHT uebernommen (Bewegungsablauf unpassend).
- Das gemalte mehrstoeckige Gebaeude aus dem Draft ist damit nicht nachgebaut, nur die Oberflaeche angenaehert.

### Nachtrag: privater Tailscale-Zugang

- Direkter Netzwerk-Listener `172.26.61.46:8791` geschlossen; diese Adresse war nur das VM-Netz,
  kein nachgewiesener Zugang aus dem Heimnetz.
- Passwortgeschuetzter Proxy jetzt ausschliesslich auf `127.0.0.1:8792`.
- Tailscale Serve: `https://sandboxhp-virtual-machine.tailcfc506.ts.net:8791/`.
- Fuer diesen Port ist kein Funnel aktiviert. Bestehende Serve-/Funnel-Eintraege auf anderen
  Ports wurden exakt unveraendert erhalten; vorher/nachher automatisiert verglichen.
- HTTPS-Zertifikat ohne Ausnahme geprueft; Browserstart, Workflow und API-Zugriff erfolgreich.
  Ohne Passwort 401, KI-Ausfuehrung weiter 403, keine JavaScript-Seitenfehler.
- Nachweis: `evidence/tailnet.json`. Zugriff vom Endgeraet setzt eine passende Tailscale-Verbindung
  und die Tailnet-Zugriffsrechte voraus; er wurde nicht von einem fremden Endgeraet getestet.

### Nachtrag: Handy-Menüs (19. Oktober 2026)

- Ursache der langen Menüzeiten: Die Station wird im Browser animiert und lief hinter offenen
  Menüs weiter; SETTINGS baute alle neun Bereiche sofort auf, auch unsichtbare.
- Auf schmalen Touchscreens pausiert die Szene jetzt bei offenem Menü/Fenster; SETTINGS und das
  Figuren-Menü bauen nur das Gezeigte und verdrahten es beim ersten Öffnen. Eingaben und
  bereits gebaute Bereiche bleiben erhalten; die Suche baut weiterhin alle Bereiche auf.
- Lokaler A/B-Test mit 6-facher CPU-Bremse: SETTINGS im Median 3,5 s → 1,4 s
  (erster kalter Durchlauf bleibt deutlich langsamer). Keine Messung auf dem echten Gerät.
- Nicht geändert: Erststart mit über 260 Skripten, Bündelung, Betriebssystem-Grenzen.
  Details: `MOBILE.md`.

### Nachtrag: Ladezeit (19. Oktober 2026)

- Ein HAR vom Windows-PC zeigte 309 s Ladezeit: 232 MB Texturen als einzelne 1–3-MB-PNGs
  über eine Tailscale-Verbindung, dazu `Cache-Control: no-store` für jede Datei.
- Die 267 Texturen liegen jetzt zusätzlich als WebP vor (232 MB → 38,9 MB); derselbe
  `.png`-Pfad liefert WebP, wenn der Browser es akzeptiert, sonst das Original.
- JavaScript/CSS werden gzip-komprimiert; statische Dateien tragen ETag und werden mit
  `304 Not Modified` bestätigt. Nur die App-Seite bleibt `no-store`.
- Lokal: erster Aufruf 44,4 MB, Neuladen 0,81 MB. Der erste Aufruf über eine echte
  Tailscale-Strecke wurde nicht erneut gemessen; die CPU-Startarbeit bleibt bestehen.
  Details: `LOADING.md`, `evidence/loading.json`.

### Nachtrag: OpenCode-Modelle (19. Oktober 2026)

- OpenCode nutzt zwei Pfade: Chat unter `/inference/openai/v1/chat/completions`,
  Modellliste unter `/inference/v1/models`. Die frühere Basis-URL zeigte auf den
  Listen-Pfad, deshalb blieb die Modellwahl leer und Läufe brachen sofort ab.
- Der Server liest den Katalog jetzt zusätzlich über den dokumentierten Listen-Pfad,
  auch wenn die Basis-URL der Chat-Pfad ist. Damit zeigt die Oberfläche wieder alle
  85 Modelle inklusive `deepseek-v4.1-flash`.
- Station-Standard und alle 13 anwesenden Agenten stehen auf `custom` /
  `deepseek-v4.1-flash` (kostenpflichtig; freie Alternative `…-flash-free`).
- Anbieter-Prüfung bestätigt: erreichbar, Katalog vorhanden, Schlüssel akzeptiert.
  Es wurde kein Chat-Aufruf gestartet. Details: `MODELS.md`.

### Nachtrag: OpenCode-Schluessel und Go-Vertrag (20. Oktober 2026)

- Die Agenten meldeten "der OpenCode-Key wird nicht akzeptiert". Nachgemessen gegen
  `opencode.ai`: ein **403 FreeTierError** entsteht **vor** der Schluesselpruefung und
  betrifft nur die freien Chat-Modelle (`…-free`). Ein gueltiger und ein ungueltiger
  Key liefern dort dieselbe Antwort. Zum Fehlerzeitpunkt liefen die Agenten auf
  `deepseek-v4.1-flash-free` – die 403 war das Modell, nicht der Key.
- Der Key selbst wurde am 18.10. beim Speichern mit **401 "Invalid credential"**
  abgelehnt (wortgleich zu einem Testkey) und ist deshalb nie gespeichert worden.
  Die Station hatte seither keinen Key; Laeufe endeten mit 401 "Missing API key".
- Behoben in StarNet:
  - Fremd-Client meldet sich wie von OpenCode fuer das Go-Abo verlangt: eigener
    User-Agent (`starnet/<Version>`) und stabile Session-ID in `x-opencode-session`.
  - Die Anbieter-Pruefung beweist einen entfernten Custom-Endpunkt mit einem **echten**
    Aufruf statt mit der oeffentlichen Modellliste. Vorher meldete sie "verified" fuer
    eine Station ganz ohne Key. Gemessen: `credentialVerified:false`,
    `keyConnected:false`, Fehlertext nennt den fehlenden Service-Account-Key.
  - Die 403/401-Fehlertexte sagen jetzt, was zu tun ist, statt den Key zu beschuldigen.
  - Die freien Modelle (`…-free`) stehen nicht mehr im Modell-Picker (76 statt 85
    Modelle); ein Beweis- oder Pruef-Aufruf ueberspringt sie und nutzt das gewaehlte
    Modell, nicht den ersten Katalogeintrag (der ist ein Platzhalter).
- Offen: ein **neuer** Console-Service-Account-Key (`oc_sk_...`, Permission
  `Inference`) muss erstellt und in `SETTINGS -> PROVIDERS -> CUSTOM` eingetragen
  werden; das Go-Abo allein genuegt der Inference-API nicht (ohne Key: 401
  "Missing API key"). Details: `MODELS.md`.

### Basisentscheidung

StarNet ist eine brauchbare technische Basis fuer den gewuenschten Ansatz. Der entscheidende
Machbarkeitsnachweis fuer externe Workflow-Autoren ist positiv. Vor einem Austausch von Colony OS
zuerst eine produktionsgeeignete Aenderungsschnittstelle und die konkrete CSV-Script-Anbindung
fertigstellen, dann einen gesondert freigegebenen echten Modelllauf pruefen.
