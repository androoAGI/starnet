# Colony OS – Systemabgleich und nötige Änderungen

Stand: 19.10.2026. Analyse, keine Implementierung oder Ausführungsfreigabe.

**Nachträgliche Nutzerentscheidung:** Eigener Raum je BU, eine Pipeline pro Ablauf und eigene Agentenidentitäten je Marke. Gemeinsam bleiben nur markenunabhängige Fähigkeit-/Rollenvorlagen sowie die übergreifende Hauptleitung und KVP. Die nachstehenden Zielvorgaben sind entsprechend angepasst; abweichende Vorschläge in den ursprünglichen drei Dokumenten sind in diesem Punkt überholt.

## 1. Ergebnis in Kürze

**StarNet ist als Ausführungsbasis weiter nutzbar. Das aktuelle Lab bildet aber noch nicht die geforderte Business-Steuerung ab.** Mehr Agenten, längere Prompts oder zusätzliche Räume schließen diese Lücke nicht. Benötigt wird eine persistente fachliche Steuerung, die vorhandene StarNet-Läufe und Werkzeuge benutzt.

Die entscheidenden Änderungen:

1. BusinessUnits als eigene Datensätze mit Markenwissen, Verantwortlichkeit, Quellen, Konten und Budgets einführen – unabhängig von Räumen.
2. Eigene Markenagenten auf Basis gemeinsamer versionierter Rollenvorlagen einsetzen. Innerhalb derselben BU dürfen sie mehrere Pipelines bedienen; Auftragskontexte bleiben isoliert.
3. Prozessvorlage, konkreten Auftrag und einzelnen Agentenlauf auseinanderhalten; Schritte nach Unterbrechungen gezielt wiederaufnehmen.
4. Interne Qualitätsnacharbeit technisch steuern; fehlerhafte Ergebnisse dürfen nicht als freigabefähig enden.
5. Eine gemeinsame Freigabe-Inbox für die tatsächlich geprüfte Version und konkret benannte Außenaktionen bauen.
6. Markenbezogenes Feedback von allgemeinen Nutzerpräferenzen trennen; KVP versioniert prüfen und zurücknehmen können.
7. Zuerst Lifestruct-Pinterest vollständig erproben, danach Newsletter, Ashveil und HomeStackR ausbauen.

## 2. Prüfgrundlage und Grenzen

Gelesene Anforderungen:

- `Colony-OS-Agentenstruktur.md`
- `Colony-OS-Business-Prozesse.md`
- `Colony-OS-Freigaben-und-Mitwirkung.md`

Geprüft wurden Quellcode und ausgewählte Strukturfelder des lokalen Zustands in diesem Repository, Branch `lab/lifestruct-spike`. Das ist ein Abgleich des **StarNet-Labs**, keine Bestandsprüfung einer anderen Colony-OS-Installation. NAS-Dashboard und externe Konten wurden nicht erneut gelesen oder getestet. Die Bestandsangaben dort stammen aus den drei Vorgabedokumenten.

Die referenzierten Dokumente `Colony-OS-NAS-Business-Bestandsaufnahme.md` und `Colony-OS-Qualitaet-Lernen-KVP.md` liegen nicht im bereitgestellten Ordner. Ihre zusätzlichen Inhalte sind deshalb nicht als geprüft anzusehen.

Vorhandene, auch umfangreiche lokale Änderungen bleiben unberührt. Es wurden keine Provider-Schlüssel gelesen, Agenten gestartet, Zeitpläne aktiviert oder Veröffentlichungen ausgelöst.

## 3. Tatsächlicher Ausgangsstand

### Lokale Einrichtung

- 13 eindeutige Agentenidentitäten: drei Lifestruct-Profile, neun HomeStackR-Profile und ein zusätzlicher manueller Koordinator.
- Vier Linien mit jeweils drei festen Schritten: Lifestruct Pinterest; HomeStackR Wissen, Pinterest sowie Pflege & Affiliate.
- Keine Prüfschleifen in der gespeicherten Raumkonfiguration.
- Keine Projektordner und keine eigenen Linienbudgets an diesen vier Eingängen hinterlegt; vorhandene Systemstandards sind davon unabhängig.
- Keine Ashveil-Einrichtung und keine separaten Markenverantwortlichen oder KVP-Rolle.
- Der sichtbare Orchestrator ist technisch ein normaler Spezialist. Der native Hauptagent ist weiterhin der Lifestruct Analyst mit `role: orchestrator`.
- Der Launcher schaltet Cron und Night Shift aus. Ein manuell nutzbarer Live-Modus existiert; ein echter erfolgreicher Modell-/Business-Durchlauf wird durch diese Analyse nicht nachgewiesen.

**Zusätzlicher Migrationsbefund:** Der gespeicherte Hauptagent `agent` kommt auch in der Agentenliste vor. Die separat gelesene Roster-Datei enthält drei Einträge, der Save dagegen 13 eindeutige Identitäten. Daraus folgt nicht automatisch ein Fehler des laufenden RAM-Rosters; die tatsächliche Synchronisation muss vor der Migration geprüft werden. Die neue Einrichtung darf nicht weiter auf einen Browser-Reload als notwendigen Synchronisationsschritt angewiesen sein.

Belege: `lab/start.cjs:18–44`, `lab/orchestrator.cjs:75–90`, `lab/homestackr.cjs:52–64`, `lab/fixtures/lifestruct.json`, lokale Strukturprüfung von `.lab-state/workspaces/agent.save.json` und `agent.roster.json`.

### Bereits vorhandene Grundlagen – wiederverwenden

- Routingcompiler, Editor und schrittbezogene Agentenzuordnung: `frontend/app/pipeline.js`, `frontend/app/lineedit.js`, `frontend/app/worldmodel.js`.
- Reale Agentenläufe, strukturierte Delegation und Ergebnisvalidierung: `sidecar/loop.js`, `sidecar/tools/builtin/orchestration.js`.
- Verzweigung, parallele Teilpfade, Zusammenführung und begrenzte Prüfschleifen: `sidecar/routing/chain.js`, `verdict.js`.
- Laufprotokolle, Artefaktverweise, Aufgabenhistorie und Dateiwiederherstellung: `sidecar/runstore.js`, `routing/linejobs.js`, `checkpoint.js`.
- Sichere Fortsetzungsplanung einzelner unterbrochener Läufe: `sidecar/run-recovery.js`.
- Atomare Dateischreibvorgänge, Konfliktprüfung und serialisierte Updates: `sidecar/savestore.js`, `durable-store.js`.
- Toolberechtigungen, Kontozugänge, Halt und Kosten-/Tokenabrechnung: bestehende Sidecar-Dienste.
- Formale Ergebnisprüfungen einschließlich Datei-Prüfsummen und Connector-Rücklesen: `sidecar/task-postconditions.js`.
- Feedback-/Präferenzspeicher, Lernnachweise, Skill-Versionierung und Änderungsvorschläge: `sidecar/feedbackmemory.js`, `trusted-learning.js`, `verdictreview.js`, `routing/linefix.js`, `sidecar/skills/`.

Diese Grundlagen sind nicht mit einer bereits vorhandenen fachlichen Freigabe-, Marken- oder Prozessverwaltung gleichzusetzen.

## 4. Änderungen nach Priorität

### P0 – Voraussetzungen vor autonomer Business-Arbeit

#### V01 – BusinessUnit-Verwaltung und harte Markentrennung

**Heute:** Marken stehen vor allem in Raumnamen, Profilen und Anweisungen. Ein Raum ist bei StarNet zugleich Teil der Werkzeug-/Routingstruktur. Es gibt keine entsprechende fachliche BU-Verwaltung im geprüften Code.

**Ändern:** Stabile IDs `lifestruct`, `ashveil`, `homestackr`; je BU ein versioniertes Profil mit Verantwortungsrolle, bestätigten Fakten, Quellen, Kontozuordnung, Präferenzen, Budgetrahmen und kompaktem Arbeitsstand. Marke muss jeden Auftrag, Kontext, Artefaktverweis, Review und jede Außenaktion begleiten. Ein Raumnamenwechsel darf keine Marke oder Rechte ändern. Kundendaten bleiben gesondert zugriffsbeschränkt.

**Besonders wichtig:** `feedbackmemory.js:135–142` schreibt Feedback global; `stationTaste():235–249` führt Feedback anderer Agenten zusammen. `index.js` verwendet diese Zusammenführung in mehreren Laufpfaden. Die vorhandene Projektgrenze in `context.js:546–580` schützt projektbezogene Erinnerungen, ersetzt aber keine Markengrenze für globales Feedback.

**Abnahme:** Ein Ashveil-Auftrag erhält keine Lifestruct-Stilbeispiele – auch nicht über Recall, Feedback, Komprimierung, explizites Nachladen oder Fortsetzung. Wirklich allgemeine Nutzerregeln dürfen ausdrücklich global bleiben. Altfeedback ohne sichere Zuordnung wird nicht ungeprüft einer Marke zugewiesen.

#### V02 – Zuständigkeit, Rollenprofil und Lauf trennen

**Heute:** Pro Pipeline eigene feste Profile; der zusätzliche Koordinator darf laut Auftrag weder automatisch delegieren noch Folgeaufträge starten. Native Leitungsidentität und sichtbarer Orchestrator sind nicht dieselbe Identität.

**Ändern:** Übergreifende Hauptleitung und KVP, drei eigene Markenverantwortliche sowie eigene Spezialistenidentitäten je Marke nach Bedarf. Die sechs Spezialistenfähigkeiten dienen als gemeinsame versionierte Rollenvorlagen, nicht als markenübergreifend geteilte Agenten oder Gedächtnisse. Es gibt keine feste Gesamtzahl und keine Pflicht zu sechs Spezialisten pro Marke. Eigene Markenagenten dürfen mehrere Pipelines ihrer BU bearbeiten; jeder Auftrag und parallele Lauf erhält einen getrennten Kontext. Profile werden nur bei Arbeit aktiviert, nicht als dauerhafte Modellprozesse betrieben. Allein die Rollenzuweisung erteilt keine neuen Werkzeuge oder Außenrechte.

Leitung und Markenverantwortliche nur bei Planungs-/Entscheidungsbedarf aktivieren; Routineübergaben ohne zusammenfassenden Leitungs-LLM-Aufruf. Gemeinsame Spezialisten nicht alle obligatorisch an jedem Prozess beteiligen. Bestehende Multi-Bay-Unterstützung und `team.dispatch` sind Integrationspunkte, aber noch keine auftragsbezogene Markentrennung.

**Abnahme:** Zwei eigene Markenagenten nutzen dieselbe markenunabhängige Rollenvorlage, aber getrennte Identitäten, Erinnerungen, Stilfeedback und Arbeitsbereiche. Ein Markenagent kann mehrere Abläufe derselben BU mit getrennten Auftragskontexten bearbeiten. Rollen-, Run- und Task-ID bleiben unterscheidbar. Hauptleitung und Markenverantwortung sind eindeutig, ohne die bestehende Founder-Sonderrolle versehentlich zu duplizieren. Hauptleitung und KVP erhalten nur gezielt benötigte Markeninformationen. Keine bestehende Identität oder Historie vorschnell löschen. Die stationsweite Feedback-Verteilung muss trotz eigener Markenagenten technisch korrigiert werden.

#### V03 – Persistenter Prozesszustand und Wiederanlauf

**Heute:** Routingplan und Laufhistorie sind gespeichert, die Fortsetzung einer ganzen Kette jedoch nicht. `chain.js:301–310` beschreibt dies ausdrücklich; wartende Verzweigungen werden nach Neustart gemeldet und verworfen. `linejobs.boot():137–145` kennzeichnet Aufträge als unterbrochen und verlangt erneutes Senden. Einzelne Run-Recovery ersetzt keinen fachlichen Wiederanlauf des gesamten Auftrags.

**Ändern:** Versionierte Prozessvorlage und konkrete Prozessinstanz mit Schritten, Abhängigkeiten, Versuchen, Artefaktversionen, offenen Befunden, Wartegründen und nächster Aktion führen. Nach jedem bestätigten Schritt dauerhaft speichern. Wartende Aufgaben, Parallelzweige und Adapteraktionen müssen Neustarts überstehen. Prozessversion für den Auftrag festhalten; aktive Aufträge nicht stillschweigend auf eine neue Vorlage umstellen.

Ein verbindlicher Backend-Schreibweg; revisionsgebundene Befehle und durable Ereignisse/Übergaben. Bei unklarem externem Ergebnis zuerst abgleichen, nicht blind wiederholen. Die vorhandene Wiederherstellung und Duplikatsperre für einzelne Tools weiterverwenden. Keine neue konkurrierende Agentenlaufzeit oder zweite Routinglogik bauen.

**Abnahme:** Neustart nach Produktion, während Review und nach einer externen Aktion: bestätigte Schritte werden weiterverwendet; keine doppelte Veröffentlichung. Ist der externe Zustand nicht aufklärbar, wird konkret blockiert.

#### V04 – Qualitätsgate statt bloßem „DONE“

**Heute:** Das Lab hat nur lineare Prüfschritte. StarNet kann zwar Review-Schleifen, führt sie bei erschöpftem Limit aber auf die DONE- bzw. Eskalationsspur weiter (`chain.js:98–129`). Der Test `test/loop-verdict.test.js:102–114` bestätigt dieses Verhalten. Ein erfolgreicher technischer Lauf ist kein bestandener fachlicher Review.

**Ändern:** Formale Prüfungen zuerst, danach unabhängiger inhaltlicher Review mit dokumentierten Dimensionen und gegebenenfalls tatsächlicher visueller Prüfung. Strukturierte Befunde je Teilobjekt/Version speichern; nur betroffene Teile und deren Abhängigkeiten zurück zur Produktion schicken. Reviewer darf nicht gleichzeitig unbemerkt das Freigabeobjekt überarbeiten und seine eigene Änderung freiprüfen; die aktuelle generische Verdict-Anweisung fordert auch eigene Fixes (`verdict.js:55–62`).

Neue fachliche Zustände wie `needs_revision`, `blocked` und `ready_for_approval` von Laufende und Outbox-Ablage unterscheiden. Erschöpfte Schleife, fehlende Pflichtprüfung oder offener Mangel: keine Freigabe-Inbox und keine Außenaktion. Keine Mindestzahl an Runden; Budget-/Zeitgrenzen und fehlender Fortschritt führen zu Ursachenwechsel oder konkreter Ausnahme.

**Abnahme:** „VERDICT: approved“ allein reicht nicht. Es braucht den Nachweis für die vollständige aktuelle Version und alle Pflichtkriterien. Wiederholtes „revise“, fehlendes Bild oder erschöpftes Budget kann niemals als freigabefähig weitergereicht werden.

#### V05 – Fachliche Freigaben und begrenzte interne Befugnisse

**Heute:** Toolfreigaben und globale/agentenbezogene Rechte existieren. Das ist keine Freigabe eines konkreten Business-Pakets. Allgemeine Grant-Schlüssel in `permissions.js:27–29` sind beispielsweise Werkzeugklassen, nicht Marke + Artefaktversion + Veröffentlichungstermin.

**Ändern:** Eigene persistente Freigabeobjekte: Marke, Konto, geprüfte Artefaktversionen/Prüfsummen, Reviewnachweis, erlaubte Aktion(en), Zielgruppe, Termin samt Zeitzone, Entscheider und Gültigkeit/Widerruf. Batchfreigabe mit Einzel-Ausnahmen; ein Klick kann mehrere ausdrücklich genannte Folgeaktionen umfassen. Vor jedem wirksamen Schritt Gültigkeit erneut prüfen. Änderungen entwerten abhängige Prüfungen und Freigaben angemessen.

Interne Recherche, Entwürfe, Prüfungen und zulässige Revisionen benötigen einen einmal festgelegten engen Befugnisrahmen statt einzelner Routineklicks. Dafür begrenzte Arbeitsordner, Tool-/Domain-/Kontofreigaben und Budgets technisch durchsetzen – **nicht einfach Full Power einschalten**. Die neue fachliche Grenze muss auch direkte Tools, Connectoren, Shell und Browser berücksichtigen; ein veröffentlichungssicherer Adapter allein genügt nicht, wenn andere Wege dieselbe Aktion ungeprüft ausführen können.

**Abnahme:** Interne Nacharbeit ohne Nutzerklick; Außenaktion ohne gültige Freigabe verweigert. Falsches Konto, geändertes Bild, geänderte Empfänger oder relevanter Terminwechsel verhindern die alte Freigabe. Ablehnung wird nicht durch neue IDs oder kosmetische Varianten umgangen.

### P1 – Vollständiger Lifestruct-Pilot

#### V06 – Gezielte Kontextpakete und vier Wissensbereiche

Heute trägt `pipeline.handoffPrompt():1859–1883` vor allem Originalauftrag, vollständiges vorheriges Ergebnis und Schrittbriefing weiter. Das passt nicht zu minimalen, quellengestützten Fachpaketen.

Benötigt werden Task/Prozess/Marke, konkrete Teilaufgabe, zugängliche Artefaktversionen, benötigte Originalfakten mit Quelle/Stand/Unsicherheiten, passende Präferenzen, Kriterien, Befunde, Werkzeugrahmen und Ergebnisformat. Ein Paket-Faktenstand wird einmal erarbeitet und referenziert. Auswahl zuerst nach Marke, Prozess, Objekt und Version; semantische Ähnlichkeit erst danach. Fehlen wichtige Inhalte oder Zugriffsrechte, blockieren statt Zusammenfassungen als vollständige Quellen behandeln.

Vier getrennte logische Speicher: Fakten/Markenprofile; Präferenzen/Beispiele; Auftragszustand; Rollen-/Prozessversionen und KVP. Kontrollierter Schreibdienst, keine beliebigen globalen Regeländerungen durch Produktionsagenten. Quellen bleiben Daten und können keine Rechte freischalten. Frische Läufe aus kompaktem Arbeitsstand starten; gezielte Revision darf im noch passenden Produzentenkontext bleiben. Erster Review ohne Qualitäts-Selbsteinschätzung des Produzenten.

#### V07 – Pinterest-Dashboard über Adapter anbinden

Dashboard zunächst lesen und einen maßgeblichen Schreibweg vereinbaren. Bestehende IDs, Marken-/Kontokennung, Reviews, Revisionen, Exporthistorie und Versionsentwertung erhalten. Keine direkten parallelen JSON-Schreiber. Legacy-Datensätze ohne Freigabefelder bleiben ungeklärt, nicht freigegeben.

Die Integrationskette braucht getrennte Nachweise: erzeugt → intern geprüft → menschlich freigegeben → bereitgestellt → exportiert → hochgeladen → veröffentlicht → Wirkung gemessen. Sie muss nicht aus acht Agenten bestehen. Adapter und technische Schritte arbeiten ohne LLM, soweit möglich; manueller Upload bleibt als solcher sichtbar. Aktuelle Boards, Domains und Zielversprechen vor Produktion abgleichen. Lifestruct-Deployment nicht automatisch für HomeStackR aktivieren.

Die im Anforderungsdokument genannten 62 bzw. 112 Pins, alten Templates und Zeitpläne sind Altbestand, keine neuen Standardvorgaben. Der Dashboardcode und seine Schnittstelle sind im Lab noch nicht integriert; eine Jobdatei allein beweist keinen laufenden Worker.

#### V08 – Nachvollziehbare Messdaten, Budgets und Kapazität

Vorhandene Run-/Linienbudgets und Token-/Kostenabrechnung erweitern, nicht ersetzen: Gesamtauftrag einschließlich Recherche, Produktion, Review, Fehlversuchen, KVP und externen Bild-/Toolkosten zusammenrechnen. Auch Übergaben zwischen Linien müssen unter demselben Auftragsbudget bleiben; heute besitzt die Ziel-Linie bei SEND TO ihren eigenen Budgetrahmen (`handoff-runner.js:5–10`). Gleichzeitige Aufträge benötigen gemeinsame Reservierungen, damit sie das Restbudget nicht mehrfach verplanen.

Token-/Zeitgrenzen auch bei unbekanntem oder nicht einzeln abgerechnetem Geldverbrauch verwenden. `cost.js` unterscheidet bereits Provider-/Katalogpreise und `unpriced`; unbekannt darf nicht als kostenlos erscheinen. Modellwahl nach Rolle und belegter Qualität; Verfügbarkeit, Limits und Ressourcen tatsächlich prüfen.

Für Business-Zahlen: Marke/Konto, Metrik, Einheit, Zeitraum, Datenebene, Quelle und Datenqualität speichern. Fehlende Klicks oder Käufe unbekannt lassen; Pin-/Board-/Tagesteiltabellen nicht doppelt zählen. Menschliche Nacharbeitszeit und interne Revisionen zusätzlich erfassen. Keine pauschalen Einsparungs- oder Conversion-Versprechen.

#### V09 – Feedback und KVP ab dem ersten Pilotfall

Vorhandene Ratings, Feedbackspeicher, Skill-Reviews und `linefix` sind nützliche Teile, aber keine vollständige KVP-Kette für Orchestrator, Reviewer und Prozesse.

Fall anlegen bei Ablehnung nach bestandenem Review, wiederholten Mängeln, hohen Korrekturkosten, Fehlablehnungen oder schlechter Kontext-/Auftragssteuerung. Fall enthält relevante Artefakte, Regel-/Rollen-/Prozessversionen und echte Befunde. Ursachenanalyse → begrenzte Änderung → unabhängige Prüfung am Problem und Vergleichsfällen → neue Version → Beobachtung → gegebenenfalls Rücknahme.

Menschliche Aussage, interne Hypothese und gemessene Wirkung getrennt führen. Bewährte reversible interne Verbesserungen innerhalb bestehender Rechte ohne zusätzliche Routinefreigabe übernehmen können. Keine Ausweitung von Budgets, Außenrechten, Strategie, Preisen oder Lizenzen durch KVP. Simulierte Zustimmung ist kein Nachweis menschlicher Akzeptanz.

### P2 – Bedienung und weitere Prozesse

#### V10 – Roboterhaus und mobile Steuerung aus demselben Zustand

Je BU ein eigener Raum mit einer Pipeline pro Ablauf. Eigene Markenagenten können mehrere dieser Pipelines bedienen; nicht jeder Ablauf braucht ein vollständig neues Team. Funktionsbereiche wie Planung, Recherche, Produktion, Prüfung und Lounge dürfen innerhalb der Markenräume dargestellt werden; übergreifende Leitung und KVP bleiben gesondert erkennbar. BU zusätzlich als Filter und Auftragskennzeichen führen. Kein Umbau in ausschließlich markenübergreifende Funktionsräume erforderlich. Raumumbau ist der Steuerung nachgeordnet; weil Geometrie derzeit Routing und Fähigkeiten beeinflusst, darf er kein ungetestetes Verschieben von Möbeln sein.

Jeder aktive Roboter zeigt Rolle/Run-ID, Marke, Auftrag, Schritt und Artefakt. Mehrere Läufe derselben Rolle unterscheidbar darstellen. Verfügbar ohne Auftrag, arbeitet, wartet auf externe Daten, wartet auf Nutzerentscheidung und offline unterscheiden; Verbindungsverlust nicht als Lounge-Idle melden. Gemeinsamer Backend-Snapshot mit Aktualitätsangabe und Ereignissen für Desktop und mobile Teamliste; keine Modellaufrufe für Animationen. Die vorhandene mobile Lab-Datei pausiert nur die Szene bei offenen Menüs, sie ist noch keine fachliche Teamliste.

#### V11 – Konfiguration und Workflow-Autorenschaft zuverlässig machen

`lab/workflow.cjs` kann bereits Vorschau, Erstellen und beschränktes Bearbeiten. Save und Routing-Publikation erfolgen jedoch getrennt (`workflow.cjs:114–123`); der Browser muss neu laden. Roster, Routing und Save dürfen künftig nicht still auseinanderlaufen.

Benötigt: ein revisionsgebundener Backend-Befehl für validierte Konfigurationsänderungen, konsistente Veröffentlichung von Profilen und Prozess-/Routingversionen sowie Live-Abgleich aller Clients. Falls mehrere Dateien bleiben, eine nach Absturz eindeutig rekonstruierbare Commit-/Aktivierungsfolge statt behaupteter Atomarität. Vorschau, Sicherung, Konfliktablehnung und Rücknahme erhalten. Native `LineEdit`-Operationen wiederverwenden. Ein eigenes Workflow-MCP-Tool ist optional, keine Voraussetzung für den ersten Prozess.

#### V12 – Übrige Business-Prozesse als Fachvorlagen ergänzen

Alle 13 Prozesse sollen im Katalog benennbar sein; erst nach Prüfung ihrer Voraussetzungen aktivieren:

- **L01:** Pinterest-Pilot mit Analyse, Nacharbeit, Freigabe, Adapteraktionen und Rückkopplung.
- **L02a:** Einstiegskurs als komplette Sequenz 1–7 mit aktueller Versandlogik prüfen; lokale Entwürfe nicht als aktiv versendet melden.
- **L02b:** Regelmäßigen Newsletter separat führen; belegtes Thema, ausprobierbarer Prompt, Beispiel, Ausgabe-/Zielgruppen-/Terminfreigabe.
- **L03:** Nachfragebelegte Produktvorschläge; Entscheidung über größeren Produktionsaufwand vor Entwicklung, finale Startfreigabe später getrennt.
- **A01:** Etsy-Angebot aus bestätigter Produktakte inklusive Digitalhinweis, Paket, Preis und Lizenz vorbereiten. Shopänderung gesondert autorisieren.
- **A02:** Dateiinventar, Familien/Varianten, Produktreife und echte Druck-/Montagebelege. Originale unverändert referenzieren; Dateiname oder Dateizahl beweist keine Reife.
- **A03:** Wenige eigene passende Fotos/Clips kuratieren, Kanalvarianten prüfen und freigeben; kein Mengenprogramm oder automatischer Streamstart.
- **A04:** Änderung einer Produktversion auf README, ZIP, Listing und Content fortpflanzen; alte Paketfreigabe nicht übernehmen.
- **H01:** Seiten/Tools/Quiz/Produkte mit stabilen IDs und korrekten Zielversprechen inventarisieren.
- **H02:** Einen belegten Funnel-Engpass bearbeiten; bei fehlenden Zahlen zuerst Messaufgabe. Historische Strategien und deaktivierte Mikroprodukte nicht still aktivieren.
- **H03:** Eigene Pinterest-Marken-/Kontokette; Legacy-Pins ohne gesicherte Zustimmung nicht als freigegeben migrieren.
- **H04:** Erreichbarkeit, Preis/Verfügbarkeit, Kompatibilität, Tracking und bestätigte Provisionen getrennt prüfen.
- **H05:** Nach Änderungen tatsächliche Seiten, mobile Darstellung, Tools, Links und Empfehlungspfade gezielt prüfen.

Die bestehende HomeStackR-Wissenslinie ist ein optionaler Produktionsbaustein, nicht der Ersatz für H01–H05. Bestehende Linien zunächst erhalten und zuordnen, nicht löschen. Etsy ist im lokalen Servicekatalog ausdrücklich nicht für dauerhafte unbeaufsichtigte Shopautomation angeschlossen (`sidecar/servicekeys-catalog.js:84–89`). Verfügbarkeit anderer Integrationen ist vor Anschluss nachzuweisen; ein Katalogeintrag ist keine funktionierende Kontoverbindung.

## 5. Vorgeschlagenes Datenmodell und Einbauorte

Neue Bezeichnungen sind Vorschläge, keine bereits vorhandenen Schnittstellen:

- `BusinessUnit`: Marke, Profilversion, Verantwortungsrolle, Quellen-/Kontoverweise, Präferenzen, erlaubter Rahmen und kompakter Stand.
- `RoleProfile` / `RoleVersion`: Zweck, erlaubte Fähigkeiten, Kontext-/Ergebnisvertrag und Modellwahlregeln.
- `ProcessTemplate` / `ProcessVersion`: Prozesskennung, Schritte, Abhängigkeiten, Prüfungen und Eskalation.
- `Task` / `StepAttempt`: verwendete Versionen, Marke, Ziel, Zustand, Abhängigkeiten, Budget und einzelne reale Runs.
- `ArtifactVersion`: stabiler Objektbezug, Datei-/Bildversion mit Prüfsumme, Quellen und abhängige Ergebnisse.
- `Review` / `Finding`: unabhängiger Run, Objektversion, Kriterienversion, Dimension, Befund und Auflösung.
- `Approval` / `ActionExecution`: menschliche Entscheidung über exakte Version/Aktion sowie getrennte Ausführung und externe Bestätigung.
- `MetricObservation`, `Feedback` und `ImprovementCase`: belastbare Messwerte, Herkunft/Geltung von Rückmeldungen und versionierte Verbesserung.

Fachliche Dienste vorzugsweise gekapselt etwa unter `sidecar/colony/`; bestehende Laufzeit, durable Stores, Tool-Sicherheitsgrenzen und Protokolle weiterverwenden. `sidecar/index.js` nur als Einbau-/API-Stelle erweitern, nicht sämtliche Fachlogik dort sammeln. `shared/events.js` und vorhandene Save-/UI-Verträge additiv und mit Migrationstests erweitern. UI-Projektionen an dieselben Backend-Daten binden.

Wesentlich: `taskId`, `businessUnitId`, `processVersion`, `stepId`, `attemptId`, `roleVersion`, `runId` und Artefaktversion über alle Pfade mitführen – auch Delegation, Cron, Trigger, Revision, Recovery und Bewertungen. Metadaten dürfen nicht in vorhandenen Normalisierern verloren gehen.

## 6. Empfohlene Umsetzung und Abnahme

1. **Fundament sichern:** Identitäten/Quellen zuordnen, BU- und Rollenmodell, Markengrenzen und enge Befugnisse; konsistente Konfigurationsänderung. Keine automatische Ausführung aktivieren.
2. **Vertikalen L01-Durchlauf bauen:** persistenter Auftrag, Faktenpaket, Produktion/Gestaltung, formale Prüfungen, unabhängiger Review, gezielte Revision und finale Freigabe-Inbox. KVP-Fall und Kosten von Anfang an mitführen.
3. **Unterbrechung und Außenaktionen absichern:** Neustart/Wiederaufnahme, Adapterabgleich, Versionsentwertung, Doppelaufrufschutz, explizite Konten/Aktionen. Im ersten sicheren Test externe Wirkung simulieren; realen Veröffentlichungsweg erst nach Freigabe erproben.
4. **Echten kleinen Pilot abnehmen:** zugelassene Modell-/Toolaufrufe und echte Artefakte, mindestens ein gezielter Fehler-/Nacharbeitsfall sowie simulierte Unterbrechung. Negative Gegenfälle testen: fremde Marke, alter Review, veraltete Freigabe, keine Pflichtprüfung, Budgetende, unbekannter externer Zustand und doppelte Aktion. Qualität, Kosten und menschliche Änderungszeit messen.
5. **Ausweiten:** L02a/L02b, dann ein Ashveil-Produkt A02 → A01 mit A03/A04, danach eine kaufnahe HomeStackR-Seite mit H01–H05. L03 nur Vorschläge bis zur gesonderten Produktentscheidung. Teamliste/Roboteransicht parallel aus stabilisierten Statusdaten aufbauen.

**Noch vor realer Ausführung festzulegen:** tatsächlich nutzbare Laufzeit/Modelle, Konto-/Schnittstellenzugänge, Quellenstand und Rechte, erlaubte interne Arbeitsbereiche, veröffentlichender Adapter oder Handübergabe, Gesamt-/Teilbudgets und Ressourcen/Parallelität. Keine Bezahlplattform und keinen Anbieter voraussetzen.

### Aufgelöster Widerspruch in den Anforderungen

L01 nennt in `Business-Prozesse.md:40` noch eine Briefingfreigabe. Die ausdrückliche Präzisierung in `Freigaben-und-Mitwirkung.md:13` und `Agentenstruktur.md:152` legt fest: **bekannte Routinebriefings intern; menschliche Briefingentscheidung nur bei neuer strategischer Richtung oder echter offener Entscheidung.** Die technischen Zustände bleiben getrennt, nicht jeder Zustand benötigt einen Klick.

## 7. Ausgeführte Prüfungen

Zwölf lokale Testgruppen erfolgreich, ohne Modellaufrufe: Lab-Konfiguration einschließlich HomeStackR/Orchestrator/Worker-Startpunkt; Pipeline; LineEdit; Chain; Multi-Bay; Loop-Verdict; LineJobs; Linienbudgets; Feedbackmemory; Projekt-Memory-Grenze; LineFix; Contextpack.

Ausgaben: `/tmp/opencode/colony-systemabgleich/results.json` und zugehörige Gruppenlogs. Das bestätigt die geprüften vorhandenen Mechanismen, **nicht** die noch zu bauenden Colony-Prozesse. Keine vollständige Upstream-Suite, kein Live-Inference-, Sicherheits-, Dashboard- oder Veröffentlichungstest. Der reine Code-/Datenabgleich erforderte keine visuelle Änderung oder Browserprüfung.
