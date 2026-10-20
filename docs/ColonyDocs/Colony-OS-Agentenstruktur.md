# Colony OS – Agentenstruktur und Kontextführung

Stand: 18.10.2026. Architekturvorschlag auf Basis der Business-Prozesse, NAS-Bestandsaufnahme und Anforderungen zu Qualität, Lernen, KVP und geringer menschlicher Nacharbeit. Keine laufenden Agenten implementiert oder gestartet. Ziel ist eine praktikable Ausgangsstruktur; ihre Effizienz muss am echten Pilotprozess gemessen werden.

## 1. Grundentscheidung

Dauerhafte Verantwortung, kurzlebige Ausführung und persistenter Zustand werden getrennt. Ein Rollenprofil ist kein ständig laufender Modellprozess und keine endlos wachsende Unterhaltung. Keine eigene dauerhaft aktive KI pro Raum, Plattform, Produkt oder Prüfung.

Vorgeschlagene Verantwortung:

- Eine zentrale Leitung: Hauptorchestrator.
- Drei Markenverantwortliche: Lifestruct, Ashveil und HomeStackR.
- Sechs gemeinsam nutzbare Spezialistenprofile: Recherche/Analyse, Redaktion, Gestaltung, Produkt/Katalog, Web/Affiliate und Qualitätsreview.
- Eine übergreifende KVP-Funktion, die auch Orchestrator und Reviewer verbessern darf.
- Deterministische Backend-Dienste für Zustand, Kontextauswahl, Termine, Budgets, Integrationen, Freigaben, Dateiprüfungen und Ereignisse.

Diese elf logischen Rollen sind keine Vorgabe für elf parallele Agenten. Gleichartige Spezialisten können innerhalb eines vereinbarten Limits mehrere isolierte Aufträge bearbeiten. Die tatsächliche Parallelität richtet sich nach Ressourcen, verfügbaren Ausführungswegen, Dienstlimits und Kosten.

## 2. Leitung und Markenverantwortung

### Hauptorchestrator

Verantwortet markenübergreifende Ziele, Prioritäten, Kapazität, Konflikte und Ausnahmen. Er legt Arbeitsbudgets innerhalb autorisierter Grenzen zu und entscheidet über neue oder wesentlich geänderte Pläne. Er liest kompakte Markenstände, wesentliche Kennzahlen mit Datenqualitätsangabe, Entscheidungen und Blockaden.

Er liest nicht automatisch alle Entwürfe, Quellseiten, Bilder oder internen Dialoge und paraphrasiert keine fertigen Ergebnisse zur Übergabe. Er wird durch neue Aufträge, relevante Ereignisse oder vereinbarte Rückblicke aktiviert. Ein routinemäßiger Statuswechsel ruft ihn nicht zwingend auf. Routine-Freigabevorlagen können nach bestandenen Kriterien direkt in die gemeinsame Inbox gelangen.

### Markenverantwortliche

Je Marke ein langlebiges Verantwortungsprofil mit einem separat gespeicherten Markenstand. Verantwortet Themen-/Produktplanung, Arbeitspakete, relevante Markenerinnerungen und die Auflösung schwieriger Qualitätsbefunde.

- **Lifestruct:** Guide, Zielseiten, Pinterest, Einstiegskurs, laufender Newsletter und Nachfragebeobachtung.
- **Ashveil:** Produktfamilien/-versionen, Reifegrad, Listing-Vorbereitung, kuratierte Social-Inhalte und Markenwelt.
- **HomeStackR:** Seiten, Tools, Empfehlungsdaten, Pinterest-/Suchzugänge und Affiliate-Pflege.

Die Markenverantwortlichen planen ein Paket und greifen bei Abweichungen ein. Bereits beschriebene Routineabläufe können aus einer versionierten Prozessvorlage starten, ohne bei jedem Aufruf erneut einen vollständigen Plan zu erzeugen. Eine Änderungsschleife wird möglichst innerhalb desselben Auftrags gesteuert; der Hauptorchestrator wird dabei nicht Runde für Runde eingeschaltet.

## 3. Gemeinsame Spezialistenprofile

| Profil | Zuständigkeit | Typischer minimaler Kontext |
|---|---|---|
| Recherche/Analyse | Quellen recherchieren, Daten erklären, Themen-/Nachfragehypothesen bilden | Fragestellung, passender Marken-/Zielgruppenausschnitt, Quellen oder Daten mit Zeitraum und Ebene |
| Redaktion | Newsletter, Artikeltexte, Pintexte, Listingtexte, Käuferdokumentation | freigegebenes Briefing, Faktenpaket, Tonalitätsregeln, Zielseite bzw. Produktakte, passende Beispiele |
| Gestaltung | Pinmotive, Bildauswahl, Layout, Produktpräsentation und benötigte Medienvarianten | Gestaltungsvorgaben, bestätigte Texte, relevante Referenzen, konkret zu prüfendes oder zu erzeugendes Motiv |
| Produkt/Katalog | Dateien/Varianten zu Produkten ordnen, Reifegrad pflegen, Paket-/Dokumentationsstand vorbereiten | betroffene Produktfamilie und Dateireferenzen, Versions-/Drucknachweise, Katalogregeln |
| Web/Affiliate | Zielseiten verbessern, Empfehlungsdaten pflegen, technische Änderungen vorbereiten | betroffene Seiten/Dateien, Projektanweisungen, Datenmodell, konkretes Ziel und passende Prüfung |
| Qualitätsreview | Fach-, Marken-/Präferenz- und erforderliche visuelle Prüfung | aktuelles Artefakt, relevante Quellen, Kriterien und Regeln; konkrete Toolbefunde |

Gemeinsam nutzbar heißt: gleiche Rollenfähigkeiten, aber getrennte Auftragskontexte. Ein Redaktionslauf für Ashveil erhält keine Lifestruct-Tonalität. Unveränderliche gemeinsame Sachquellen dürfen referenziert und wiederverwendet werden; Markenstimmen und Kundendaten werden nicht vermischt.

Sonderrollen nur bei wiederholt erkennbarem Bedarf abspalten. Etwa einen spezialisierten Reviewer für Druck-/Dateipakete oder für konkrete technische Änderungen. Keine pauschale Kombination aller verfügbaren Rollen für jeden Auftrag.

## 4. Backend als Ablaufsteuerung

Ein persistenter Workflow steuert Reihenfolge, Abhängigkeiten und Wiederaufnahme. Das Sprachmodell bearbeitet Entscheidungen, Inhalte und unstrukturierte Befunde. Wiederkehrende Regeln werden möglichst ohne Modellaufruf geprüft.

Beispiele ohne notwendige LLM-Interpretation: Pflichtfelder, zugelassene Domain, bekannte Boardzuordnung, Dateivorhandensein, Prüfsumme, Versionsvergleich, Duplikatkennung, feste Termine, Freigabegültigkeit und bereits exportierte Einträge. Ein gültiger Link ersetzt keine fachliche Prüfung seiner Zielseite.

Ein abgeschlossener Schritt speichert Ergebnisreferenz und Zustand. Nach einem Abbruch werden bestätigte Schritte weiterverwendet; externe Vorgänge erst abgleichen, bevor sie erneut ausgelöst werden. Ein einzelner verbindlicher Schreibweg pro integriertem Bestand verhindert konkurrierende JSON-Schreiber.

Vorhandenes Pinterest-Dashboard wird zunächst über einen Adapter angeschlossen. Seine Marken-, Revisions-, Review- und Exportdaten bleiben erkennbar. Bestehende Codex-Jobdatensätze sind eine mögliche Auftragsquelle, aber kein Nachweis eines bereits laufenden Workers. Weder neues Framework noch bestimmter Modellanbieter ist mit diesem Vorschlag festgelegt.

## 5. Standardablauf und interne Iteration

1. Ereignis/Auftrag einem Prozess und einer Marke zuordnen. Falls ein gültiger bekannter Ablauf existiert, dessen Vorlage verwenden.
2. Markenverantwortlicher konkretisiert bei Bedarf Ziel, Umfang, Erfolgskriterien und Entscheidungsbedarf. Nur erforderliche Quellen und Präferenzen auswählen.
3. Datenaufbereitung und Recherche einmal pro zusammengehörigem Paket durchführen. Faktenpaket und belegte Zielversprechen versioniert speichern.
4. Passende Spezialisten erzeugen Ergebnisse. Unabhängige Teilpakete dürfen innerhalb verfügbarer Grenzen parallel laufen.
5. Günstige formale Prüfungen zuerst durchführen; notwendige fachliche Prüfung bei fehlender Voraussetzung blockieren oder gezielt auf vorhandene Teilbereiche begrenzen.
6. Ein unabhängiger Reviewlauf bewertet standardmäßig alle passenden inhaltlichen Prüfdimensionen zusammen. Für Bild-/Websitearbeit die aktuelle tatsächliche Darstellung ansehen. Fach-/Marken-/Technikverantwortung bleibt getrennt nachvollziehbar, auch wenn sie keinen eigenen Modellaufruf pro Dimension benötigt.
7. Befundliste direkt an die zuständige Produktionsrolle zurückgeben. Überarbeitungen betreffen möglichst nur fehlerhafte Teile. Keine langen Agentendiskussionen; konkrete Artefakte, Befunde und neue Versionen austauschen.
8. Geänderte Teile und ihre Abhängigkeiten erneut prüfen. Bei einem Pintextwechsel beispielsweise weiterhin Zielversprechen, Bildlesbarkeit und Bild-/Textversion prüfen. Die Endprüfung sieht das vollständige endgültige Freigabeobjekt; reine Ausschnittsprüfung reicht dafür nicht.
9. Erst nach bestandenen vorgeschriebenen Kriterien in die Freigabe-Inbox. Bekannte Mängel bleiben intern. Unauflösbare Entscheidungen oder Grenzen als Ausnahme an die zuständige Ebene geben.
10. Nach konkreter menschlicher Freigabe die benannte Außenaktion über ihren Adapter ausführen, sofern technisch verfügbar und autorisiert. Ergebnis abgleichen und später Wirkung beobachten.
11. Feedback und systematische Befunde in Präferenzpflege/KVP übernehmen. Erfolgreiche Routine ohne relevante neue Erkenntnisse erfordert keinen ausführlichen KVP-Aufruf.

Reviewer ist ein getrennter Lauf, nicht die Selbsteinschätzung des Produzenten. Er erhält beim ersten Review nicht dessen selbstbewertete Qualitätsargumentation, sondern das Artefakt, Fakten und Kriterien. Bei Nachprüfungen erhält er zusätzlich offene Befunde und Änderungen. Bei fachlichem Streit kann ein gezielter Zweitprüfer oder der Markenverantwortliche entscheiden; kein Mehrheitsvotum gleichartiger Agenten als Wahrheitsersatz.

## 6. Zuordnung sämtlicher Business-Prozesse

Der Hauptorchestrator beteiligt sich jeweils nur bei Portfolioentscheidungen oder Ausnahmen. Markenverantwortung und Workflowzustand bleiben durchgehend zugeordnet.

| Prozess | Typische Spezialisten | Besonderheit |
|---|---|---|
| L01 Pinterest | Analyse, Redaktion, Gestaltung, Review | Ein Fakten-/Testbriefing pro Batch; Teilrevision je Pin; bestehende Dashboardzustände |
| L02a Einstiegskurs | Redaktion, Review; Recherche bei Bedarf | Bestehende Mails 1–7 und Reihenfolge zusammen prüfen; ein Sequenzpaket |
| L02b Newsletter | Recherche, Redaktion, Review | Ein belegtes Thema mit ausprobierbarem Prompt und Beispiel |
| L03 Produktvorschläge | Analyse, Produkt, Review | Nachfragebelege statt automatischer Produktion; Nutzerentscheidung vor größerer Entwicklung |
| A01 Etsy-Entwurf | Produkt, Redaktion, Gestaltung nach Bedarf, Review | Bestätigte Produktakte als Faktenquelle; Lizenz/Preis klären |
| A02 STL-Katalog | Produkt, Review; Redaktion für Anleitung | Dateizugehörigkeit, Varianten und Nachweise; tatsächlicher Druck bleibt menschlich |
| A03 Social Content | Gestaltung, Redaktion, Review | Kuratierte eigene Assets; Auswahl statt Mengenproduktion |
| A04 Paketpflege | Produkt, Redaktion/Gestaltung nach Änderung, Review | Abhängigkeiten einer Produktversion neu prüfen |
| H01 Seiteninventar | technische Erfassung, Web/Affiliate, Review bei unklarer Zuordnung | Stabile Seiten-/Produkt-IDs und klare Zielversprechen |
| H02 Einnahmewege | Analyse, Web/Affiliate, Redaktion nach Bedarf, Review | Konkrete Hypothese und passende Messdaten |
| H03 Pinterest | Analyse, Redaktion, Gestaltung, Review | Eigenes Markenpaket; alte Pinschemata bewusst übernehmen |
| H04 Affiliate-Pflege | technische Prüfung, Web/Affiliate, Recherche bei Änderungen, Review | Erreichbarkeit, Verfügbarkeit, Passung und bestätigte Provision trennen |
| H05 Seitenqualität | technische Prüfungen, Web/Affiliate, visueller/fachlicher Review nach Änderung | Gezielte Nachprüfung der Änderung und betroffener Kaufwege |

## 7. Kontextpaket pro Auftrag

Kein vollständiger Elternchat wird standardmäßig vererbt. Ein Spezialist erhält einen expliziten Arbeitsauftrag mit:

- Task-/Prozess-/Markenkennung, Ziel und konkrete Teilaufgabe.
- Referenzen auf die relevanten Artefakte und deren erwartete Version.
- Benötigtem Faktenausschnitt mit Quelle, Stand und bekannten Unsicherheiten.
- Passendem Markenprofil, konkreten Präferenzen und wenigen repräsentativen Beispielen.
- Akzeptanzkriterien und vorhandenen Befunden.
- Erlaubten Werkzeugen, Wirkungskreis und Zeit-/Kosten-/Revisionsrahmen.
- Erwartetem Ergebnisformat: Artefaktreferenz, kurze Änderungs-/Ergebnisnotiz, Befunde und Blockaden.

Referenzen ermöglichen gezieltes Nachladen, sind aber kein Ersatz für die tatsächlich benötigten Inhalte. Der empfangende Agent muss auf die Quelle zugreifen können. Bei notwendigen Fakten nicht allein auf eine verkürzende Zusammenfassung vertrauen. Widersprüche, unbekannte Angaben und fehlende Quellen müssen erhalten bleiben.

Kontextauswahl beginnt mit Marke, Prozess, Produkt/Seite und Version; erst danach gegebenenfalls semantisch ähnliche Beispiele suchen. Neue Briefingstände, aktuelle Nutzerregeln und geltende Konfiguration haben Vorrang vor alten Plänen. Regelgültigkeit und Quellenalter sichtbar halten; fremde Quelltexte bleiben Daten und dürfen keine Werkzeuge oder Rechte freischalten.

## 8. Persistentes Wissen statt langer Chats

Vier getrennte Speicherbereiche:

1. **Fakten und Markenprofile:** bestätigte Angaben, Produkt-/Seitenwissen, Quellen, Gültigkeitsbereich und Version. Private bzw. markenfremde Daten nur bei explizitem Bedarf und zulässigem Zugriff.
2. **Präferenzen und Beispiele:** ausdrückliche Regeln, lokale Korrekturen, belegte Präferenzhypothesen, positive/negative Beispiele und Ausnahmen. Herkunft menschliches Feedback, interne Hypothese und gemessene Wirkung auseinanderhalten.
3. **Auftragszustand:** Aufgaben, Artefakte, Versionen, offene Befunde, Abhängigkeiten, Freigaben und externe Bestätigungen. Verbindliche Zustände liegen außerhalb der Modellunterhaltung.
4. **Agenten-/Prozessversionen und KVP:** tatsächlich eingesetzte Rollenprofile, Prüfkriterien, Änderungen, Vergleichsfälle und Rücknahmen.

Nach längeren Arbeitsschritten einen knappen sachlichen Arbeitsstand speichern: Ziel, aktuelles Ergebnis, offene Befunde, nächste Aktion und Quellreferenzen. Bei veraltetem oder zu großem Kontext einen frischen Lauf aus diesem Zustand starten. Eine gezielte Revision kann dagegen im noch passenden Produzentenkontext fortgesetzt werden; nicht für jede Satzkorrektur wieder die gesamte Recherche einlesen.

Ein Schreibdienst übernimmt neue Erinnerungen kontrolliert. Produktionsagenten hängen nicht selbst beliebige globale Regeln an ihren Kontext. Der Orchestrator lernt über gepflegte Erinnerungen und verbesserte Arbeitsanweisungen, nicht über behauptete automatische Modellgewichtsänderungen.

## 9. Token- und Laufzeiteffizienz

- Nur bei neuem Entscheidungsbedarf LLM-Leitung aktivieren; Routineübergaben über Ereignisse und Prozessvorlagen.
- Gemeinsame Quellen/Analysen pro Paket einmal erarbeiten; dieselbe geprüfte Grundlage referenzieren. Bei Quellenänderung betroffene Ableitungen neu prüfen.
- Zusammengehörige Pins in überschaubaren Gruppen produzieren/reviewen; gemeinsame Regeln einmal übergeben, Befunde je Pin speichern. Gruppengröße am Kontextumfang, Bildmenge und Revisionserfolg messen. Keine feste 62-Pin-Riesenunterhaltung.
- Nur betroffene Komponenten überarbeiten. Große Artefakte in Dateien speichern, nicht in jeder Nachricht erneut ausgeben.
- Bild-/Medienkontext gezielt laden; für lokale Fehler passende Ausschnitte, für Endfreigabe die tatsächliche vollständige Darstellung. ZIP-/Dateiprüfungen möglichst maschinell, Layouts zusätzlich visuell.
- Standardmäßig einen unabhängigen inhaltlichen Reviewlauf verwenden. Zusätzliche Spezialprüfung nur, wenn erforderlich oder ein Befund offen bleibt. Die freigegebenen Prüfkriterien nicht zum Sparen abschwächen.
- Je Rolle das kleinste hinreichend zuverlässige verfügbare Modell wählen, sofern die eingesetzte Plattform das erlaubt. Komplexe Konflikte oder wiederholte Qualitätsprobleme begründet eskalieren. Keine konkrete Modell-/Preiszusage ohne Prüfung.
- Stabile Regeln/Markenausschnitte in gleichbleibender Reihenfolge liefern. Anbieter-Caching nur als mögliche zusätzliche Optimierung betrachten, nicht als zugesicherte kostenlose Leistung.
- Ein laufendes Gesamtbudget und Teilbudgets für Recherche, Produktion, Review/Nacharbeit sowie KVP führen. Fehlversuche und Wiederholungen zählen mit. Vor Budgetende verbleibende Arbeit speichern.
- Keine künstliche Zahl von Iterationen. Bei fehlendem Fortschritt Ursache untersuchen, Methode ändern oder konkrete Ausnahme melden.

Effizienz bedeutet Gesamterfolg mit wenig menschlicher Nacharbeit. Mehrere gezielte Runden können günstiger sein als ein schlechter Erstentwurf mit menschlicher Reparatur. Tatsächliche Token, Laufzeit, Tool-/Bildkosten und Korrekturaufwand messen; keine Einsparquote vorab behaupten.

## 10. KVP als eigene Funktion

KVP erhält gezielte Fehler-/Erfolgsfälle, relevante Artefakte und verwendete Agenten-/Regelversionen; nicht sämtliche Markenarchive bei jedem Auftrag. Auslöser sind insbesondere menschliche Ablehnung nach bestandenem Review, wiederholte gleiche Mängel, hohe Überarbeitungskosten, schlechte Kontextauswahl oder unnötige Eskalationen.

Die Funktion erstellt eine Ursachenanalyse und einen eng begrenzten Änderungsvorschlag. Die neue Rollen-/Prozessversion wird mit dem ursprünglichen Problem und weiteren repräsentativen Vergleichsfällen geprüft. Untersuchung und Bewertung laufen mit getrenntem Kontext; vorgeschlagene Änderung und erwarteter Erfolg ersetzen keinen Befund. Die spätere menschliche Freigabequote kann nicht allein durch simuliertes Nutzerfeedback nachgewiesen werden.

Bewährte reversible interne Änderungen innerhalb bestehender Rechte können ohne zusätzliche Routinefreigabe übernommen werden. Neue Außenrechte, Budgets, Strategie- oder Preis-/Lizenzentscheidungen bleiben gesondert zu entscheiden. Änderung versionieren, Einsatz beobachten und bei Verschlechterung zurücknehmen. Auch falsche Prüferablehnungen und Orchestratorfehler gehören zum KVP-Auftrag.

## 11. Freigaben und Mitwirkung

Siehe Colony-OS-Freigaben-und-Mitwirkung.md. Grundprinzip: interne Routine selbstständig; menschliche Freigabe am fertigen Paket und der konkreten nächsten Außenaktion. Kein obligatorischer menschlicher Zwischenklick für jedes Briefing, jede Agentenrunde oder jede Routine-Promptkorrektur.

Freigabe bindet Marke/Konto, Artefaktversion, Aktion und relevanten Zeitplan. Änderungen nach Freigabe lösen die nötige Neuprüfung und gegebenenfalls erneute Freigabe aus. Vorhergesagte Zustimmung des Orchestrators ersetzt keine menschliche Freigabe.

## 12. Beispiel: ein Lifestruct-Pinterest-Batch

1. Backend stellt neue Analysequellen bereit. Die Lifestruct-Verantwortung startet den bekannten Ablauf und legt die Testfrage fest, sofern keine strategische Nutzerentscheidung fehlt. Hauptorchestrator erhält keinen Volltext.
2. Analyseprofil erstellt einmal ein Fakten-/Themenpaket. Redaktion nutzt dazu die passenden Zielseiten und erstellt Pintexte; Gestaltung bearbeitet die bestätigten Texte mit passendem Stilkontext.
3. Formale Prüfungen kontrollieren Felder/Boards/Versionen. Ein unabhängiger Reviewer erhält jeweils das zu prüfende Teilpaket mit Quellen und fachlichen/visuellen Kriterien.
4. Zwei Pins versprechen einen nicht vorhandenen Download, ein Motiv ist mobil unlesbar. Nur diese Bestandteile gehen mit konkreten Befunden zurück. Die geänderten Ergebnisse und ihre Abhängigkeiten werden erneut geprüft.
5. Die Endvorlage enthält die tatsächlich geprüften Versionen. Die Nutzerin kann den Batch oder einzelne Pins zur benannten Folgeaktion freigeben. Bereitstellung, CSV, Upload und Veröffentlichung bleiben gesondert nachweisbare Schritte, aber benötigen nicht automatisch jeweils einen neuen Klick.
6. Eine spätere menschliche Ablehnung nach bestandenem Review erzeugt einen KVP-Fall. Die Markenverantwortung erhält einen kurzen Ergebnis-/Lernstand. Der Hauptorchestrator sieht nur relevante Budget-/Prioritätsabweichungen und den kompakten Fortschritt.

## 13. Darstellung als Roboterteam

Die Räume zeigen logische Funktionen: Planung, Recherche, Produktion, Prüfung, KVP und Lounge. Marken sind auswählbarer Kontext und am Auftrag erkennbar; sie müssen nicht je einen kompletten eigenen Gebäudekomplex bekommen.

Jeder sichtbare Roboter ist mit einer Agentenidentität bzw. konkret nachvollziehbaren Rolle verknüpft. Aktive Läufe zeigen Task, Prozessschritt und Artefakt. Mehrere gleichartige Läufe bleiben unterscheidbar. Eine wiederverwendete Rolle heißt nicht, dass ihre früheren Chats weiterlaufen.

Aktiv, verfügbar ohne Auftrag, wartet auf externe Daten, wartet auf Nutzerentscheidung und offline sind getrennte Zustände. Lounge bedeutet verfügbar ohne Aufgabe; keine gemütliche Idle-Animation als Ersatz für einen Verbindungsverlust. Keine laufenden Modellaufrufe nur für dekorative Bewegung. Desktop-Roboterhaus und mobile Teamliste lesen dieselben Zustände.

## 14. Pilot und offene technische Entscheidungen

Pilot: Lifestruct-Pinterest wegen des bestehenden Dashboards. Zuerst einen kleinen vollständigen Durchlauf mit echten Artefakten und Nachweisen erproben, einschließlich einer begründeten internen Nacharbeit und einer simulierten Unterbrechung. Keine Veröffentlichung ohne konkret geltende Freigabe.

Prüfen: Qualität vor Nutzerfreigabe, menschliche Änderungszeit, Gesamttoken, Bild-/Toolkosten, Wiederanlauf, korrekte Markenabgrenzung, Freigabeversionen und Aufwand des KVP-Falls. Danach Rollen, Gruppengröße und Parallelität anpassen.

Vor Ausführung noch zu klären: tatsächlich nutzbare Agentenlaufzeit, erlaubte Schnittstellen und Konten, Ressourcen des Werkstatt-PCs, Ausführungs-/Tokenbudget und verlässliche Kostenmessung. Vorhandene Chat-Abos belegen keinen unbeaufsichtigten API-Betrieb. Der Vorschlag setzt keine zusätzlichen kostenpflichtigen Dienste voraus; ein kostenloser vollständiger Dauerbetrieb ist damit nicht nachgewiesen.
