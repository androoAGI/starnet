# Colony OS – Implementierungsstatus der Business-Prozesse

Stand: 21.10.2026. Gegen `Colony-OS-Business-Prozesse.md`, `Colony-OS-Agentenstruktur.md`,
`Colony-OS-Freigaben-und-Mitwirkung.md` und `Colony-OS-Systemabgleich-und-Aenderungsbedarf.md`
abgeglichen. Dokumente sind Prozessspezifikation; nur die folgenden geprüften Runtime-Pfade
gelten als Implementierung. Außenaktionen bleiben abgeschaltet.

## Fachliche Prozessverträge

Alle 13 Katalogabläufe haben Prozessversion 3 mit Prozessziel, erforderlichen Quellen/Eingaben,
markenspezifischen Regeln, Rollenfolge, Arbeitsanweisungen und strukturierten Ergebnisfeldern.
Prozessinstanzen übernehmen eine unveränderliche Vertragssnapshot-Version. Katalogänderungen
wirken nicht rückwirkend auf laufende Tasks.

1. **L01 – Pinterest-Batch:** Quellen-/Metrikpaket → Analyse → Pins → deterministisches Bild → unabhängige Prüfung. Quelle, Zeitraum, Einheit und Datenebene der Metriken sind erforderlich. Isolierte Testaufträge dürfen ausdrücklich ohne Geschäftsmessdaten laufen; sie sind nie freigabefähig.
2. **L02a – Einstiegskurs:** genau sieben identifizierte, vollständige vorhandene Mails plus bestätigte Reihenfolge → Überarbeitung → Prüfung. Keine erfundene Automatisierung.
3. **L02b – Newsletter:** belegtes Thema → Ausgabe mit Prompt und nachvollziehbarem Beispiel → Prüfung. Versand bleibt aus.
4. **L03 – Produktvorschläge:** Nachfragesignale → maximal drei Vorschläge → Prüfung/Entscheidung. Keine automatische Produktion.
5. **A01 – Etsy-Listing:** Produktakte, menschlich bestätigter Druckbeleg, Preis und Lizenz → Listingentwurf → unabhängiger Check. Digital-/STL-Download und Lieferumfang deterministisch geprüft; kein Shopzugriff.
6. **A02 – STL-Katalog:** originale Datei-IDs/Hashes → Familien-/Varianteninventar und Reifestand → Prüfung. Dateiname ist kein Drucknachweis.
7. **A03 – Social:** eigens hochgeladenes PNG plus Rechtebestätigung und Kanal → kuratierter Entwurf → Reviewer erhält das wirkliche Bild. Kein Post/Stream.
8. **A04 – Paketpflege:** betroffene Abhängigkeiten → versioniertes Änderungspaket → Prüfung. Paketstände/Freigaben werden nicht stillschweigend vererbt.
9. **H01 – Seiteninventar:** stabile IDs und HTTPS-Seitenbestand → zweiter Review.
10. **H02 – Einnahmewege:** belegte Hypothese/Änderung oder bei fehlenden Zahlen konkrete Messaufgabe → Review. Conversion-Ergebnisse werden nicht erfunden.
11. **H03 – HomeStackR-Pinterest:** getrenntes Markenpaket/Legacy-Freigabezustand; keine Übernahme des Lifestruct-Deployments.
12. **H04 – Affiliate-Pflege:** bestätigte Produkt-/Linkreferenzen und getrennte Prüfdimensionen für Link, Preis, Verfügbarkeit, Kompatibilität, Tracking und Provision.
13. **H05 – Seitenqualität:** versioniertes Änderungspaket plus markengebundener PNG-Screenshot, echter Link-/Tool-Prüfbeleg → unabhängiger Review. Ohne aktuellen Screenshot/Prüfnachweis bleibt der Task blockiert.

Für generische Prozessresultate prüft der Host JSON-Vertrag, Eingabe-/Quellen-IDs und stabile Objekt-IDs. Nur Pins-/Newsletter-Entwürfe oder das konkret verlangte strukturierte Paket gelangen nach formaler und unabhängiger Prüfung in die Inbox. Bei No-Progress wird mit KVP-Fall blockiert. Nach ausgeschöpften normalen Review-/Korrekturrunden kann der optionale Fixer genau einmal übernehmen; sein Ergebnis muss durch formale Prüfung und einen frischen unabhängigen Review, getrennt von Produzent und Fixer, bestehen. Ein Fehlschlag blockiert mit KVP-Fall. Bei bestandenem Standard-Review wird der Fixer nicht aufgerufen. Test-Tasks werden nie zur Freigabe zugelassen.

Ein deterministischer Format-/Quellenfehler im Produzentenergebnis wird als kostenpflichtiger
fehlgeschlagener Versuch protokolliert und genau innerhalb des normalen Revisions-/Budgetlimits
mit konkretem Schemahinweis zurückgegeben. Unabhängige Reviews erhalten höchstens einen
begrenzten Format-Retry; ein wiederholter Fehler blockiert. Fehlerhafte Outputs werden nie
als gültige Zwischenergebnisse oder Freigaben gespeichert.

## Ausführungs- und Freigabegrenzen

- Modelle werden aus der vorhandenen Marken-Agenten-Roster übernommen; Schlüssel werden nicht gelesen oder kopiert. Ausführung erfordert weiterhin ausdrückliche Betreiberkonfiguration und Aktivierung.
- Für OpenCode Go kann der Operator `accountingMode=tokens` setzen: Token und Laufzeit besitzen harte Gesamt-/Einzellimits, der Dollarwert bleibt explizit unbekannt. Fehlender Token-/Zeitverbrauch blockiert den Task.
- Fotos/Screenshots können nur mit bestätigten Rechten als PNG bis 8 Megapixel hochgeladen werden; Store pro Marke/Konto, SHA-256-Inhalt und unveränderliche Referenz.
- `externalActionsEnabled` bleibt `false`. `approve` erstellt nur einen geprüften Approval-Datensatz. `action.prepare` erzeugt ein Manifest im Modus `manual`, keinen Upload, Versand, Shop- oder Websitezugriff.
- Dashboard-/Pinterest- und NAS-Dateien sind noch nicht als Produktionsadapter verbunden. Quelleingaben kommen derzeit bestätigt von der betreibenden Person. H01–H05 sowie A*/L* sind dadurch keine Konten-/Website-Automation.
- Rollen und Verträge sind kein OS-Sandboxnachweis. Tests/Live-Pilot verwenden die vorhandene Station. Keine echte Auftrags-/Produktionsreife behaupten, solange Konten, Quellen, Rechte, Wiederanlauf und echte fachliche Abnahme fehlen.
- Der commit-gebundene Upgrade-Pfad wurde auf der lokalen Station für genau den L01-Pilot angewendet: ein unverändertes StarNet-Blueprint `fire_escape` („Review + fixer“). Die frühere L01-Pipeline bleibt als Legacy-Sicherung erhalten; die zwölf anderen vorhandenen Linien, Räume und Prozessanweisungen wurden nicht ersetzt. Das Upgrade war atomar und erzeugte keinen Modellaufruf. Ein frischer Erstinstallations-Preview verwendet dieselbe Blueprint-Vorlage für neue Prozesslinien. Die 13 Fachverträge und ihre spezifischen Eingaben/Ergebnisse bleiben in der Colony-Fachsteuerung.
- Wichtig: Das native Blueprint führt den Fixer-Ausgang direkt zur nativen Outbox. Diese Outbox ist **keine Colony-Freigabe**. Die persistente Colony-Prozessinstanz ruft nach einem Fixer-Lauf zwingend erneut den unabhängigen Reviewer auf und blockiert bei jedem offenen Befund vor der Approval-Inbox. Direkte native Nutzung außerhalb dieser Fachsteuerung erhält diesen Zusatzgate nicht.
- Bei regulärem Review-Erfolg wird kein Fixer-Modellaufruf erzeugt. Normale Korrekturen bleiben begrenzt; No-Progress blockiert mit KVP-Fall. Schemafehler erhalten eine begrenzte Formatkorrektur.

## Prüfung und aktueller Pilotstatus

- `test/colony-processes.test.js`: prozessspezifische synthetische Durchläufe für alle 13 Abläufe, Fixer-Eskalation mit erneutem Review, harte Negativfälle, Revisionsgrenzen und keine Außenaktion.
- `test/colony-runtime-contract.test.js`: Output-only, Token-/Ausgabelimit und unbekannte Dollarabrechnung.
- `test/colony.http.test.js`: vollständiger L01-Lauf über einen synthetischen HTTP-Modellprovider, Revision und unabhängige Bildprüfung. **Kein Nachweis für OpenCode/Go-Qualität oder Live-Konten.**
- Ein echter, aber ausdrücklich **testOnly** markierter, werkzeugfreier L01-Durchlauf lief mit DeepSeek durch Recherche → Pin-Entwurf → deterministisches Bild → unabhängige Review: 12.499 Tokens, Dollarwert unbekannt, 3 Läufe abgeschlossen. Verwendet wurden synthetische `example.org`-Zielseite und ein nicht verbundenes Testboard. Es gab keine Freigabe, keinen Upload und keine andere Außenaktion; der Auftrag wurde vom Approval-Gate ausgeschlossen.
- Dieser Test demonstriert technische Ausführung, **nicht** Produktions-/Kreativfreigabe: die Bilddatei ist ein einfacher deterministischer Text-/Grafikstarter, kein fertiges, marktfähig abgenommenes Pinterest-Motiv. Fehlende Kennzahlen, echte Boards, Kontozugriff und Dashboard-Adapter sind weiterhin offen.
- Die Prüfung fand außerdem eine widersprüchliche Forschungsnotiz über ein fehlendes PNG, obwohl die Host-Laufzeit später das vollständige Bild an die Review anhängte. Der Host versieht solche nachweislich behobenen Notizen jetzt mit einer gehashten Evidenzauflösung; ungelöste Bildwidersprüche verhindern die Freigabe. Eine frische Abnahme nach diesem letzten Prüf-Gate steht noch aus.
- Folge: Der frühere Test darf nicht als Produktionsfreigabe gelten. Das neue Evidenz-Gate muss nach Neustart mit frischem `testOnly`-Lauf nachgeprüft werden. Modellanbindung ist vorhanden; verlässlicher Dollarverbrauch, echte Account-/Dashboard-Adapter, menschliche Abnahme und Produktionsbetrieb bleiben offen.
