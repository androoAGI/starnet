# Colony OS – Business-Automatisierung

Stand: 18.10.2026. Konkretisierung durch Nutzerangaben und direkte, lesende Prüfung der freigegebenen NAS-Bereiche Ashveil Social Media, Ashveil STL Library, HomeStackR und Lifestruct. Planungsgrundlage; vorhandener Quellcode und gespeicherte Zustände wurden geprüft, laufende Systeme und externe Konten nicht getestet. Gesprächsfokus: Business; andere Bereiche bleiben Teil des Gesamtprojekts. Quellen und Grenzen: Colony-OS-NAS-Business-Bestandsaufnahme.md.

**Agentenzuschnitt und Kontextführung:** Colony-OS-Agentenstruktur.md ordnet sämtliche Prozesse einer zentralen Leitung, drei Markenverantwortlichen, gemeinsam nutzbaren Spezialisten und einer KVP-Funktion zu. Colony-OS-Freigaben-und-Mitwirkung.md konkretisiert die vorgeschlagenen menschlichen Entscheidungen. Diese ergänzen die nachstehenden Prozessschritte: bekannte Routinebriefings werden intern entschieden; vorgelegt wird das fertig geprüfte Ergebnis mit benannter Folgeaktion. Die Roboteransicht zeigt dieselben realen Auftrags-/Laufzustände, sie löst keine dekorativen Modellaufrufe aus.

## Übergreifende Anforderung: interne Qualitätsschleifen, Lernen und KVP

**Nutzerentscheidung vom 18.10.2026:** Eine menschliche Freigabe soll erst erfolgen, wenn das Ergebnis nach interner Prüfung voraussichtlich ohne Nacharbeit freigabefähig ist. Der Orchestrator soll aus Freigaben und Ablehnungen lernen. Eine eigene KVP-Funktion soll Agenten und Abläufe bei Bedarf verbessern. Feedback muss neben dem einzelnen Ergebnis auch den Prozess verbessern können.

Diese Anforderung gilt für alle nachstehenden Prozesse und präzisiert dort jede Formulierung wie „Entwurf vorlegen“: Vorher durchlaufen die Ergebnisse eine passende fachliche Prüfung, Marken-/Präferenzprüfung, gegebenenfalls eine technische Prüfung, gezielte Überarbeitungen und eine abschließende Prüfung der aktuellen Version. Die Rollen und der Verbesserungsablauf sind in Colony-OS-Qualitaet-Lernen-KVP.md beschrieben. Das ist eine Planungsänderung, keine implementierte Agentenausführung.

Es gibt keine Mindestzahl künstlicher Überarbeitungen: Das System iteriert so lange wie erforderlich, solange der vereinbarte Rahmen reicht und Fortschritt erkennbar ist. Bekannte behebbare Mängel gehen intern zurück. Fehlende menschliche Entscheidungen werden als konkrete Rückfrage oder Ausnahme ausgewiesen, nicht als Freigabeantrag für unfertige Arbeit. Grenzen bei Zeit, Kosten, Berechtigungen und Außenwirkungen bleiben wirksam.

## Lifestruct

### Bestätigter Bestand und Ziel

- Homepage mit kaufbarem Guide für 59 EUR.
- Newsletter über „mit KI das Leben strukturieren und Ziele erreichen“, mit gelegentlichen Prompts zum Ausprobieren.
- Pinterest als Funnel; Dashboard für Planung und Freigabe bereits vorhanden.
- Ziel: mehr Traffic und mehr Conversion; die Website soll verkaufen.

### L01 – Pinterest-Batch mit Rückkopplung

1. Bestehendes Dashboard integrieren und aktuelle Pin-Leistung analysieren.
2. Daraus ableiten, was im nächsten Batch ausprobiert werden soll.
3. Pins durch Codex erstellen lassen.
4. Nutzerin prüft und gibt einzelne Pins frei oder lehnt sie ab.
5. Bei Ablehnung: Feedback berücksichtigen, betroffene Pins neu bauen und erneut zur Prüfung vorlegen. Keine stillschweigende Freigabe.
6. Freigegebene Pins für Veröffentlichung weitergeben; konkreter Veröffentlichungsweg noch offen.
7. Wirkung analysieren und in die nächste Batchplanung übernehmen.

Zielseiten: Homepage, Blog oder Verkaufsseite für die Conversion. Die Auswertung der Käufe ist eine vorgeschlagene Konkretisierung des Conversion-Ziels; Messzugriff und Zuordnung sind noch zu definieren.

**NAS-Ergänzung:** Das gemeinsame Dashboard liegt unter HomeStackR/Pinterest und bindet Lifestruct als eigene Marke mit eigenem Datenordner an. Analyseimport, Analysebriefing, gespeicherte Codex-Aufträge, bildbezogene Revisionen, Freigabe/Ablehnung mit Historie, Bildbereitstellung und CSV-Export sind im Quellcode vorhanden. Neue Inhalte bzw. Bildrevisionen entwerten eine bestehende Bulk-Freigabe. Ein Revisionsimport für abgelehnte Pins ist vorhanden; ein dauerhaft laufender automatischer Bearbeiter ist nicht nachgewiesen.

Der gespeicherte aktuelle Lifestruct-Batch enthält 62 Pins für 31 Zielseiten; die Konfiguration nennt 12 und 18 Uhr, Europe/Berlin und eine 31-Tage-Rotation. Das ist übernommener Bestand, keine neue Vorgabe für alle künftigen Batches. Ältere Formatbeschreibungen nennen andere Boards als die aktuellen Daten; laufende Konfiguration und tatsächlich vorhandene Pinterest-Boards beim Anschluss abgleichen.

Der Ablauf muss deshalb explizit ergänzen: Analyse → Briefingfreigabe → Produktion → Pinfreigabe → freigegebene Bildrevision öffentlich bereitstellen → CSV erzeugen → Upload bei Pinterest bestätigen → Veröffentlichung beobachten → Wirkung auswerten. Diese Zustände nicht zusammenfassen: Ein Export ist noch kein Pinterest-Upload, eine Uploadbestätigung kein Nachweis, dass jeder Pin veröffentlicht wurde. Zwei Lifestruct-Exportdatensätze sind lokal noch als `exported` gespeichert; keine Aussage über den tatsächlichen Pinterest-Stand.

Offen: Frische und Vollständigkeit der Kennzahlen, laufender Codex-Bearbeiter, künftiger Batchumfang, tatsächlicher Veröffentlichungsweg, Zuordnung zu Käufen und Revisionsgrenze. Deployment ist im gelesenen Dashboardcode ausdrücklich nur für Lifestruct aktiviert; nicht ungeprüft für HomeStackR übernehmen.

### L02 – Regelmäßiger Newsletter

Zwei getrennte Abläufe planen:

- **L02a – Einstiegskurs pflegen:** Bereits vorhandene Mail-Entwürfe 4–7 prüfen, veraltete Launch- und Preiswechseltexte aktualisieren und nach Freigabe mit den laut Nutzerbestätigung bestehenden Mails 1–3 abgleichen. MailerLite-Automation auf tatsächlichen Stand prüfen; lokales Vorhandensein ist kein Versandnachweis.
- **L02b – Redaktionellen Newsletter erstellen:** Aktuell interessante Themen recherchieren → passenden Prompt zum Ausprobieren und Alltagsbeispiel erarbeiten → Newsletter zur Prüfung vorlegen → freigegebenen Versand planen → Reaktionen auswerten.

Das NAS-Strategiepapier beschreibt den Einstieg nach Anmeldung mit Mails an Tag 0/3/6/10/15/20/27. Dieser historische Vorschlag wird nicht automatisch zur aktuellen Einstellung. Der regelmäßige Newsletter bleibt davon getrennt. Die aktuelle Nutzerbeschreibung umfasst allgemein KI, Alltag und Ziele; der bestehende Guide und ältere Texte konzentrieren sich auf Abnehmen. Themenkontext und Zielgruppe pro Inhalt festlegen.

Offen: Rhythmus, Umfang, Quellen, Freigabe und Versandweg. Automatischer Versand ist durch diese Planungsangaben nicht festgelegt.

### L03 – Nachfragebasierte Produktvorschläge

Wiederholt stark nachgefragte Themen erkennen → Vorschlag für ein digitales Produkt erstellen → Entscheidung durch Nutzerin.

Offen: Nachfragesignale und Schwelle, Bewertung eines Vorschlags, anschließender Produktionsprozess. Automatische Produkterstellung oder Veröffentlichung ist bisher nicht definiert.

## Ashveil

### Bestätigter Bestand und Ausrichtung

- Marke für Dark Fantasy Cosplay.
- Instagram, Pinterest, TikTok und Twitch vorhanden; Twitch für Live-Drucken und -Bauen.
- Pinterest aktuell laut Nutzerangabe ca. 16.000 Impressionen pro Monat; kuratierte Befüllung, kein Mengenziel.
- Etsy-Shop eingerichtet, noch ohne Listings.

### A01 – Etsy-Listing vorbereiten

Auslöser: Ein Teil ist fertig. Automatisierung: Etsy-Listing vorbereiten, einschließlich Text und Beschreibung.

Vorschlag zur Konkretisierung: Produktinformationen übernehmen und daraus Titel, Beschreibung sowie fehlende Angaben ableiten.

**NAS-Ergänzung:** Das Markenbriefing gibt bereits eine Listing-Struktur vor: suchbarer Titel, kurze atmosphärische Einleitung, konkrete enthaltene Dateien, Formate, Größen, Druck-/Supporthinweise, Nutzung und Lizenz sowie eine kurze Lore-Notiz. Ein digitaler STL-Download muss als solcher erkennbar sein. Das Briefing nennt das Zepter-Bundle als produktnahen Kandidaten; das ersetzt keine aktuelle Produktprüfung.

Offen: Definition „fertig“, Auslöser, Produktzuordnung, Drucknachweise, Lizenz und Preis sowie Prüfung/Freigabe. Automatisches Einstellen ist weiterhin nicht festgelegt.

### A02 – STL-Katalog und Produktreife aufbauen (neu konkretisierter Vorschlag)

Auslöser: initialer Import und neue/geänderte Quelldateien. Dateibestand erfassen → Dateien zu Produkten, Varianten und Kollektionen zuordnen → offene Voraussetzungen markieren → menschliche Druck-/Montageprüfung dokumentieren → README, Bilder und Produkt-ZIP vorbereiten → Produktversion zur Listing-Vorbereitung bereitstellen.

Der vorhandene Excel-Tracker enthält bei direkter Prüfung nur die Kopfzeile. Seine vorgesehenen Felder (Kollektion, Version, Dateipfad, Skalierung, FDM/Resin, README, ZIP, Vorschaubilder, Preis, Shoplinks und Releasestatus) eignen sich als Ausgangspunkt für das Backend. Dateizahl ist keine Produktzahl; eine STL oder ein `final`-Dateiname beweist keine Verkaufsreife. Originaldateien und Ordner bei einem späteren Import zunächst unverändert referenzieren.

### A03 – Kuratierten Social Content vorbereiten (Vorschlag)

Auslöser: neuer Baufortschritt, fertiges Produkt oder redaktionell ausgewähltes Material. Eigene Fotos/Clips einem Projekt und Produkt zuordnen → wenige geeignete Motive auswählen → plattformspezifischen Text und gegebenenfalls kurze Ashveil-Lore entwerfen → zur Freigabe vorlegen → freigegebenen Beitrag einplanen → Reaktionen bzw. Shopbesuche auswerten, soweit messbar.

Vorhanden sind ein Markenbriefing, eine umfangreiche Dread-Masquerade-Fotoserie und Twitch-/OBS-Szenen. Diese Quellen sind nutzbar; Bildqualität, Rechte für konkrete Veröffentlichungen und tatsächliche Live-Anbindung wurden nicht geprüft. Keine beliebigen fremden Pins übernehmen. Ashveil bleibt in Ton und Bildwelt strikt von Lifestruct und HomeStackR getrennt. Kein automatisches Mengenprogramm und kein automatischer Streamstart.

### A04 – Produktpakete nach Änderungen pflegen (Vorschlag)

Auslöser: neue Modell- oder Dokumentationsversion. Betroffene Varianten, README, ZIP, Listing und Content-Entwürfe ermitteln → Änderungen als zusammengehörige neue Produktversion vorbereiten → erneut prüfen. Ein geänderter Bestandteil darf keine alte Paketfreigabe ungeprüft übernehmen.

## HomeStackR

### Bestandsbasierter Funnel

Pinterest oder Google → Beitrag, Quiz oder Tool → passende Entscheidungshilfe → Produktempfehlung → Affiliate-Klick → Partnerbestätigung/Provision, soweit zuordenbar.

Direkt vorhanden: Websitequellcode mit Wissens-, Energie- und 3D-Druckbereichen, Quiz und acht Tool-Unterordnern; Produkt-/Vergleichsdaten und Affiliate-URL-Bestände. Der Umami-Helfer und mehrere Quiz-Ereignisse stehen im Code; aktive Datenerfassung und Affiliate-Klickabdeckung sind noch nicht bestätigt. Ein vorhandener Reviewbericht nennt 81 geprüfte Artikel und 56 mit Affiliate-Funktionen; dies wurde nicht erneut vollständig nachgeprüft.

### H01 – Content- und Seiteninventar pflegen (Vorschlag)

Auslöser: initialer Import oder Inhaltsänderung. Artikel, Tools, Quiz-Ziele und Produkte erfassen → Seitenzweck, Pin-Zuordnung, Empfehlungen und Änderungsstand verbinden → fehlende Daten oder falsche Zielversprechen als Aufgabe ausgeben. Vorhandene Reviewliste nutzen, alte lokale Pfadlinks nicht ungeprüft übernehmen.

### H02 – Bestehende Einnahmewege verbessern (konkretisierter Vorschlag)

Auslöser: regelmäßiger Review oder auffällige Kennzahlen. Verfügbare Pinterest-/Such-/Website- und Partnerdaten mit Zeitraum übernehmen → Engpass auf einer Zielseite benennen → konkrete Änderung vorbereiten → freigeben → umsetzen → spätere Wirkung vergleichen. Bei fehlenden Messdaten eine Messaufgabe statt eines erfundenen Conversion-Gewinners erzeugen.

Bestehende Strategie priorisiert Kosten, Mietwohnung, erstes Gerät und Strommessung; PV, Hardware und 3D-Druck sind weitere Cluster. Diese Priorität bleibt eine zu prüfende historische Hypothese. Mikroprodukte werden nicht als aktiver Funnel übernommen: Die aktuelle Quellkonfiguration setzt `HIDE_MICROPRODUCTS = true`, das Strategiepapier fokussiert Affiliate-Funnels. Ältere Prozessdokumente und TODOs enthalten abweichende Mikroproduktpläne.

### H03 – Pinterest-Batches vorbereiten und prüfen (konkretisierter Vorschlag)

Auslöser: vereinbarter Redaktionszeitpunkt. Leistung und Zielseiten prüfen → Batch-Briefing erstellen → vorhandene Bilder und Templates passend verwenden oder neue Motive erstellen → Pins importieren → Freigabe/Nacharbeit → markenspezifischen Veröffentlichungsweg → Ergebnisabgleich.

Es gibt einen lokalen Bestand von 112 HomeStackR-Pins mit älterem Statusschema. Fehlende neue Freigabefelder dürfen bei der Integration nicht als bereits erteilte Freigabe ausgelegt werden. Das ältere Prozesspapier nennt vierwöchige Batches mit 112 Pins und vier Canva-Templates; Umfang und Werkzeuge sind historische Einstellungen, keine neue Verpflichtung. Für HomeStackR fehlen im gelesenen Datenordner entsprechende Analyse-/Exportdateien; daraus folgt nicht, dass niemals extern analysiert oder veröffentlicht wurde.

### H04 – Affiliate- und Produktpflege (Vorschlag)

Auslöser: regelmäßige Kontrolle oder veränderte Produktdaten. Produkt- und Linkbestand abgleichen → defekte Links, unpassende Empfehlungen und veraltete Angaben markieren → belegte Korrektur vorbereiten → prüfen und umsetzen. Erreichbarkeit, Preis/Verfügbarkeit, Kompatibilität, Tracking und tatsächlich bestätigte Provisionen getrennt behandeln.

### H05 – Websitequalität nach Änderungen prüfen (Vorschlag)

Auslöser: freigegebene Inhalts- oder Produktänderung. Betroffene Seiten und Tool-Ergebnisse, interne Links, Bilder, mobile Darstellung und Empfehlungspfade prüfen → Befund speichern → bei Fehlern Korrekturauftrag erstellen. Bestehende Bildverwaltungs- und Affiliate-Prüfskripte als Integrationskandidaten erfassen; im Rahmen dieser Bestandsaufnahme wurden sie nicht ausgeführt.

## Gemeinsamer Backend-Kern – bisheriger Planungsvorschlag

Aufträge und Auslöser, markenspezifischer Kontext, Agentenzuweisung, Artefakte, Reviewfeedback, Freigaben, Wiederholungen, Ausführungsverlauf, Kennzahlen und begrenzte Budgets. Konkrete Infrastruktur und verfügbare Automatisierungsschnittstellen noch prüfen.

**Durch den NAS-Bestand zusätzlich erforderlich:**

1. **Quellen eindeutig zuordnen:** Marke/Konto, Zeitraum und Herkunft speichern. Im Ashveil-Social-Ordner liegt beispielsweise eine eindeutig als Lifestruct erkennbare Pin-CSV; Ordnernamen allein sind keine sichere Markenkennung. Der danebenliegende Analytics-Export ist ohne Kontonachweis keiner Marke verlässlich zugeordnet.
2. **Bestand schonend integrieren:** Alte und neue Pin-Schemata unterscheiden, stabile IDs übernehmen und Freigaben nicht aus fehlenden Feldern ableiten. Zunächst Adapter und einen verbindlichen Schreibweg festlegen; parallele direkte JSON-Schreiber vermeiden.
3. **Freigaben nach Version führen:** Briefing, Creative, Produktpaket und externe Aktion sind getrennte Freigabeobjekte. Änderungen lösen erforderliche erneute Prüfung aus.
4. **Außenwirkung getrennt bestätigen:** Erzeugt, freigegeben, bereitgestellt, exportiert, hochgeladen und veröffentlicht sind unterschiedliche Zustände. Ein Codex-Auftragseintrag ist noch kein Nachweis eines aktiven Workers.
5. **Kennzahlen korrekt übernehmen:** Metrik, Einheit, Zeitraum, Datenebene und Quelle speichern. Fehlende Klickdaten bleiben unbekannt. Tages-, Board- und Pin-Teiltabellen nicht doppelt addieren. Attribution zu Verkäufen nur behaupten, wenn die Daten sie tragen.
6. **Veraltete Texte erkennen:** Vergangene Launchtermine, alte Preise, Boardlisten, Dateipfade und widersprüchliche Strategien vor Produktion kennzeichnen. Aktuelle Nutzerangaben haben Vorrang; insbesondere Lifestruct aktuell 59 EUR und kein erneuter Launch am 01.08.2026.

## Vorgeschlagene Reihenfolge

0. Gemeinsamen Qualitätsmaßstab, versionierte Prüfkriterien, Feedbackspeicher und KVP-Rückkopplung definieren; am ersten Prozess von Beginn an verwenden.
1. Gemeinsames Quellen-/Markeninventar und vorhandenes Pinterest-Dashboard als Adaptergrundlage aufnehmen.
2. Lifestruct-Pinterest von Analyse bis bestätigtem Veröffentlichungsstatus anschließen; aktuelle Datenlücken und Worker-Anbindung schließen.
3. Lifestruct-Einstiegssequenz aus vorhandenen Entwürfen aktualisieren; regelmäßigen Newsletter separat definieren.
4. Für ein Ashveil-Produkt die gesamte Kette Katalog → Produktreife → Paket → Etsy-Entwurf erproben und passendes eigenes Social-Material zuordnen.
5. HomeStackR mit einer vorhandenen kaufnahen Seite und deren Pinterest-/Google-Zugängen verbinden; Verbesserungs- und Affiliate-Pflegeprozesse anschließen.

Diese Reihenfolge ist ein Vorschlag. Die Freigabe zum Lesen der NAS-Bereiche und zur Prozessplanung ist keine Freigabe für Shopänderungen, Newsletter-Versand oder Veröffentlichungen.
