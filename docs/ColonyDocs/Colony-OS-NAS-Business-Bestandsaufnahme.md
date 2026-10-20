# NAS-Bestand als Grundlage der Business-Prozesse

Stand: 18.10.2026. Direkt und lesend geprüft: Ashveil Social Media, Ashveil STL Library, HomeStackR und Lifestruct unter `\\fritz.nas\FRITZ.NAS\General-USBFlashDisk-01`.

Umfang: gezielte Ordnerinventur, zentrale Briefings/Prozesspapiere, ausgewählte Quellcodedateien und gespeicherte JSON-/CSV-Daten, Tracker-Struktur. Kein Start von Projektprogrammen, keine Prüfung externer Konten oder Websites und keine Änderungen an diesen vier Quellbereichen. Nicht sämtliche Fotos, Modelle, PDF-Inhalte oder Artikel einzeln geprüft. Mehrere Unterpfade waren beim rekursiven Auflisten nicht lesbar; das Inventar ist nicht vollständig. Nur Prozessplan und Nachweise im Colony-OS-Ordner wurden ergänzt.

## 1. Ashveil Social Media

### Direkt belegter Bestand

- `Ashveil_Project_Brief.md`: Markenwelt, Conjura the Dreadweaver, Dreadlings, Kollektionen, Produkt-/Listing-Struktur, Tonalität und möglicher Produktionsworkflow. Historischer Stand Juni 2026.
- `Dread Masquerade/`: zahlreiche eigene Fotodateien, ein als `Dread_Masquerade_public.jpg` benanntes Bild und dessen Bearbeitungsdatei. Keine Einzelbild-QA durchgeführt.
- `Twitch/Ashveil_Creatures_Szenen.json`: gespeicherte OBS-Szenen unter anderem Start, Desk_sitzend, Fullface, End, Alerts, Chat und Canon_RAW. Dazu visuelle und Audioassets; keine aktive Streamingverbindung geprüft.
- `lifestruct-lifestruct_rotation_62_20261006-bulk-20261007-406785.csv`: Inhalte, Medien-URLs, Zielseiten und UTM-Kennungen weisen auf Lifestruct, obwohl die Datei im Ashveil-Ordner liegt.
- `Pinterest Analytics overview 20260906-20261006.csv`: mehrteiliger Übersichtsexport mit Zeitraum, Filtern, Tagesreihe und Pin-/Boardtabellen. Der Ablageordner beweist keine Kontozugehörigkeit. Nicht als Beleg für Ashveils Reichweite verwenden.

### Konsequenz

Eigene Assets mit Projekt-/Produktzuordnung erschließen. Listing-Basis und Social-Briefings aus derselben Produktakte ableiten, aber markenspezifisch und kuratiert prüfen. Die aktuelle Nutzerangabe zu ca. 16.000 Pinterest-Impressionen pro Monat bleibt eine Nutzerangabe; durch die hier untersuchte CSV nicht bestätigt oder widerlegt. Aktuelle Angaben zu TikTok/Pinterest/Twitch haben Vorrang vor älteren „optional“-Formulierungen.

## 2. Ashveil STL Library

- `_Codex_Arbeitsordner/UEBERBLICK_STL_LIBRARY.md`: historische Bestandsaufnahme vom 28.07.2026 mit Modellfamilien und damaligen Dateizahlen. Diese Zahlen nicht als neuen Vollscan ausgeben.
- Direkt gelistete Modell-/Kollektionordner, etwa #DreadMasquerade, #Hollow_Harlequin, Anhänger, Shield_plates, Stab_Akzente und Ornament_Sun_01.
- In #DreadMasquerade direkt gefunden: Schäferstock_Base.stl, Widder_steigend.stl, Zepterspitze_raw.stl, zwei Spiral-/Klingen-ZIPs sowie Konzeptbilder.
- In Stab_Akzente direkt gefunden: Griff-, Spitzen-, Bodenabschluss- und Dekovarianten, Vorschaubilder und Blender-Quellen.
- #Hollow_Harlequin enthält jüngere PrintPrep-/STL-/Bilddateien; die ältere Übersicht bildet diesen späteren Stand nicht vollständig ab.
- `#Ashveil_STL_Tracker.xlsx`, Blatt `Ashveil STL Tracker`, Bereich A1:U1: direkt aus der XLSX-Struktur gelesen. Genau eine nichtleere Zeile, die Kopfzeile; keine eingetragenen Produkte. Felder für Kollektion, Produkt, Datei, Version, Druckverfahren, README, ZIP, Vorschaubilder, Preis und Shop-/Releasestatus.
- `KI_Modell_Prompts.xlsx`, Blatt Plates: technisch ausgerichtete Modellprompt-Bausteine vorhanden. Nicht als Produktkatalog oder Drucknachweis verwendet.

### Konsequenz

Katalogaufbau und Produktreife sind ein eigener Backend-Prozess vor der Listing-Automatisierung. Produkt, Variante, Datei und Releasepaket getrennt verwalten. Testdruck/Montage brauchen einen dokumentierten Nachweis; Quelldatei, Dateiname und älteres Briefing reichen dafür nicht. Das Zepter ist ein Kandidat zur Prüfung, kein neu bestätigtes fertiges Shopprodukt.

## 3. Gemeinsames Pinterest-Dashboard

### Quellen

Unter `HomeStackR/Pinterest`: server.js, app.js, data/brands.json, data/pins.json, data/README.md, homestackr_pinterest_prozess.md, scripts/export-policy.cjs, scripts/import-rejected-revision.cjs sowie Skriptinventur.

Unter `Lifestruct/Pinterest/data`: pins.json, analyses.json, codex-jobs.json, export-batches.json, boards.json, board-mapping-current.json und ausgewählte Konfigurationsfelder.

### Direkter Code-/Datenbefund

- Zwei Marken sind registriert: HomeStackR und Lifestruct; gemeinsame Bedienlogik, getrennte Markenpfade.
- Analyseimport akzeptiert CSV/Screenshots; Briefing und dessen Freigabestatus werden gespeichert. Ein Job-Endpunkt und gespeicherte Codex-Aufträge existieren; aus der Prüfung folgt kein nachgewiesener dauerhaft laufender Jobkonsument.
- Review verlangt bei Ablehnung eine Prüfnotiz; Inhalt und Bildrevision beeinflussen die Freigabe. Der Revisionsimport setzt überarbeitete abgelehnte Pins wieder in den Prüfzustand.
- Bulk-Export benötigt Freigabe und passende bereitgestellte Bildrevision. Exportpolitik berücksichtigt frühere Exporte, feste Rotation und doppelte Termine. Keine Laufzeittests durchgeführt.
- Der Deploymentpfad ist im gelesenen Code nur für Lifestruct aktiviert und nutzt einen separat konfigurierten Produktions-Worktree. Verfügbarkeit dieses Worktrees oder erfolgreicher Zugriff wurde nicht geprüft.
- CSV-Erzeugung setzt den lokalen Lieferstatus auf exported. Die separate Bestätigungsaktion setzt upload_confirmed. Weder Zustand ist allein ein Live-Nachweis für die Veröffentlichung einzelner Pins.
- Der Code fügt UTM-Kennungen hinzu und bildet interne auf externe Boardnamen ab.
- Aktuelle Lifestruct-Boarddatei enthält vier Einträge. Das ältere LS_CLAUDE_PIN_BATCH_FORMAT.md nennt sieben andere bzw. ältere Bezeichnungen. Keine davon ohne Abgleich als aktuelle externe Board-ID behandeln.
- HomeStackR pins.json: 112 Datensätze, alle mit homestackr.com als Zielhost, ohne die neueren reviewStatus-/deliveryStatus-Felder.
- Lifestruct pins.json: 209 Datensätze insgesamt, darunter historische Datensätze; nicht 209 aktive oder veröffentlichte Pins. Zwei benannte Kampagnen umfassen 31 und 62 Pins. 93 Datensätze tragen lokal approved/exported.
- Lifestruct export-batches.json enthält zwei Exportdatensätze, beide mit Status exported. Tatsächlichen Uploadstand beim Anschluss abgleichen, keinen Neuversand daraus ableiten.
- Lifestruct-Konfiguration: aktive 62er-Kampagne, 12/18 Uhr, Europe/Berlin, 31 Rotationstage. Dies sind Bestandseinstellungen, keine neue globale Vorgabe.

### Historische Analyse und heutige Grenzen

Das gespeicherte Analysebriefing vom 06.10.2026 unterscheidet Tages-, Board- und Pin-Teiltabellen, sehr kleine Stichproben und fehlende Conversion-Zuordnung. Es dokumentiert einen damals fehlenden Checkout-Link auf einer einzelnen Blogzielseite. Das ist kein heutiger Live-Befund und widerspricht nicht automatisch der späteren Nutzerbestätigung, dass Stripe/PDF funktionieren. Daraus folgt als geplanter Prozess ein aktueller Test des jeweiligen Pin-Zielpfads bis zum Kauf, keine Behauptung eines aktuell defekten Checkouts.

## 4. Lifestruct-Inhalte und Newsletter

Quellen: lifestruct_ki_briefing.md, lifestruct_hp_codex_briefing_V1.md, HP_Blog/Review Lifestruct Version 2.md, HP_Blog-Dateiinventur, Pinterest/LS_CLAUDE_PIN_BATCH_FORMAT.md, Newsletter/newsletter_strategie_guide_launch.txt, Dateiinventur der Mails 4–7 und Textauszüge der Mails 4 und 7.

- Vorhandene Mail-Entwürfe 4–7 behandeln einzelne Prompts, getrennte KI-Chats, Waage/Fortschritt und Rückkehr nach schwierigen Tagen.
- Das Strategiepapier beschreibt eine siebenstufige MailerLite-Einstiegssequenz, Tags/Gruppen, Abstände, Themen und Messgrößen. Das ist ein lokaler Plan, keine Live-Bestätigung der Automation.
- Texte enthalten vergangene Launchtermine (01.08.2026) und einen geplanten Wechsel von 59 auf 79 EUR. Aktuell gilt die Nutzerbestätigung: Guide kaufbar für 59 EUR. Vor Verwendung aktualisieren.
- Reviewnotizen konkretisieren Newsletter-Bestätigung, Tonalität und zielbezogene Blog-Verweise auf Guide/Mini-Kurs. Umsetzungsstand der Website nicht getestet.

Konsequenz: Vorhandene Entwürfe aufarbeiten und die Kursautomation separat vom laufenden redaktionellen Newsletter planen. Blog, Pin und tatsächliches Zielversprechen gemeinsam prüfen. Nachfragebasierte Produktvorschläge benötigen nachvollziehbare Signale.

## 5. HomeStackR-Website und Affiliate-Funnel

Quellen: affiliate-funnel-strategie-ohne-mikroprodukte.md, main/AGENTS.md, main/README.md, main/TODO.md, main/PM_TASKS.md, main/affiliate_review_report.md, main/src/config/monetization.ts, main/src/lib/umami.ts, ausgewählte Tracking-Codefundstellen in Quiz-Komponenten, main/scripts/README.md, Inhalte/Pinterest_Review_Status.md sowie gezielte Ordnerinventuren.

- Websitecode enthält Wissen, Energie, 3D-Druck, Quiz und acht Tool-Unterordner: energie-sparrechner, gehaeuse-konfigurator, kompatibilitaet, kostenrechner, mieter-check, pv-optimierer, raumplaner, systemvergleich. Ordner sind kein Funktionsnachweis.
- Produkt-, Kosten- und Kompatibilitätsdaten sowie Affiliate-URL-Tabellen sind vorhanden.
- Umami-Helfer und Quiz-Ereignisse wie quiz_completed, quiz_question_answered und quiz_cta_clicked im Code gefunden. Aktive Umami-Einbindung, erhobene Daten und Affiliate-Klickabdeckung nicht bestätigt.
- Reviewbericht nennt 81 geprüfte Artikel und 56 mit Affiliate-Funktionen. Historischer Bericht, kein in dieser Aufgabe erneut bestandener Audit.
- Aktuelle gelesene Konfiguration: HIDE_MONETIZATION=false, HIDE_MICROPRODUCTS=true. Ältere TODO-/Prozessdateien erwähnen Mikroproduktshop und teilweise bereits erledigte bzw. überholte Arbeiten. Keine neue Shop-Automation daraus ableiten.
- Strategiepapier beschreibt Pinterest/Google → Artikel/Tool → konkrete Entscheidung → Produktempfehlung → Affiliate-Klick. Priorisierungen und damalige Provisionsangaben sind historische Annahmen, keine aktuellen Leistungs- oder Konditionsnachweise.
- Skripte für Bilder, Produkt-/Affiliate-Pflege und Prüfungen sind Integrationskandidaten; nicht ausgeführt.

Konsequenz: Bestehende Zielseiten/Tools und deren Empfehlungsdaten als Prozessobjekte aufnehmen. Messbarkeit, Seitenverbesserung, Pinterest-Zulauf, Link-/Produktpflege und Qualitätskontrolle getrennt definieren. Bestätigte Provisionen separat aus Partnerdaten beziehen, nicht aus Klicks schätzen.

## 6. Aktualisierte Prozessplanung

Die operative Planung steht in Colony-OS-Business-Prozesse.md. Ergänzungen umfassen L02a/L02b, A02–A04 sowie H01–H05. Vorschläge bleiben als solche gekennzeichnet; Lesefreigabe ist keine Produktionsfreigabe.

Technischer Auswertungsnachweis: outputs/nas-bestand-auswertung.json; liest Trackerstruktur und ausgewählte lokale JSON-/CSV-Metadaten. Die vier Quellbereiche wurden dabei nicht verändert.
