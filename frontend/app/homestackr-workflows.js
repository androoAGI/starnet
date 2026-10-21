'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HomeStackRWorkflows = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // These are work descriptions, NOT implementations or permission to run them.
  const guard = ' Nur Entwürfe mit Quellen und offenen Fragen zur manuellen Freigabe. Fehlende Eingaben als BLOCKIERT melden. Keine Website-/Repo-Änderungen, Uploads, Veröffentlichung oder automatischen Folgeaufträge. Fachaufträge ausschließlich über die Business-Steuerung mit Versions- und Budgetnachweisen.';
  const step = (label, brief, hands) => ({ label, brief: brief + guard, hands });
  const processes = {
    H01: {
      goal: 'Vorhandene Seiten erfassen und ihren Prüfbedarf sichtbar machen.',
      inputs: 'Seitenliste mit echten URLs und vorhandenen Artikelinhalten.',
      steps: [
        step('Seiten erfassen', 'Erfasse die bereitgestellten Seiten mit URL, Thema, Zielgruppe, Inhaltsstand und vorhandenen Affiliate-Verweisen. Trenne bestätigte Angaben von fehlenden Daten; behaupte keinen vollständigen Website-Scan.', 'Seitenübersicht mit Quellen, fehlenden Angaben und erkennbarem Prüfbedarf.'),
        step('Seitenübersicht prüfen', 'Prüfe die Seitenübersicht gegen die bereitgestellten Inhalte: stimmen URLs, Zuordnung und Inhaltsstand? Benenne Lücken und doppelte Einträge; erfinde keine geprüften Seiten.', 'Geprüfte Seitenübersicht mit Korrekturen, Lücken und Status.')
      ]
    },
    H02: {
      goal: 'Belegte, zum Leserbedarf passende Einnahmemöglichkeiten vorschlagen.',
      inputs: 'Geprüfte Seitenübersicht, Messdaten mit Zeitraum und bestätigte Affiliate-Angebote.',
      steps: [
        step('Leserbedarf auswerten', 'Werte Seitenübersicht und bereitgestellte Messdaten aus. Benenne konkrete Leserprobleme und passende Seiten; ohne Messbelege keine Umsatz-, Conversion- oder Traffic-Gewinner behaupten.', 'Belegte Leserbedürfnisse und priorisierte Seiten; Datenlücken separat.'),
        step('Empfehlungen vorbereiten', 'Schlage passende Einnahmewege und kontextuelle Produktempfehlungen nur aus bestätigten Angeboten vor. Beachte CONTENT.md: Theorie, Recht, Versicherung und Glossar werbefrei; Bedarf zuerst erklären, keine doppelten Werbeplatzierungen oder erfundenen Provisionen.', 'Begründete Vorschläge mit betroffenen Seiten und bestätigten Angebotsreferenzen.'),
        step('Nutzen und Belege prüfen', 'Prüfe Lesermehrwert, Messbelege, Produktauswahl und Werbekennzeichnung unabhängig. Stelle sicher, dass Vorschläge keine unbelegten Einnahmeversprechen oder Tracking-Empfehlungen enthalten.', 'Geprüftes Vorschlagspaket mit Risiken und Status; keine Umsetzung.')
      ]
    },
    H03: {
      goal: 'Pinterest-Entwürfe für bestätigte HomeStackR-Artikel vorbereiten.',
      inputs: 'Bestätigter Artikeltext, echte Ziel-URL, gewünschte Pin-Anzahl, Boards und freigegebene Bild-/Markenvorgaben.',
      steps: [
        step('Artikel und Pin-Ideen prüfen', 'Lies den bestätigten Artikel und seine echte Ziel-URL. Leite belegte Leserprobleme und Pin-Ideen ab; werte Pin-Kennzahlen nur bei einem bereitgestellten Export mit Zeitraum aus.', 'Pin-Briefing mit Artikel-URL, belegten Aussagen und offenen Fragen.'),
        step('Pin-Texte entwerfen', 'Erstelle die beauftragte Anzahl Pin-Texte, ohne Mengenangabe höchstens drei: Titel, Beschreibung und Overlay-Text. Nur belegte Aussagen aus dem Artikel; keine Clickbait-Versprechen. Board-Vorschläge ohne bestätigte Board-Liste ausdrücklich als Vorschlag markieren.', 'Pin-Texte je Entwurf mit Ziel-URL, Board-Vorschlag und Quellenbezug.'),
        step('Bildgestaltung vorbereiten', 'Bereite zu jedem Pin ein Bildbriefing und Alt-Text anhand der Markenregeln und freigegebenen Assets vor. Ordne vorhandene Bildrechte zu; fehlende Bilder offen benennen. Keine Bilderzeugung, fremden Downloads oder erfundenen Assets.', 'Bildbriefing und Alt-Text je Pin; vorhandene Rechte und fehlende Assets.'),
        step('Pins und Zielseiten prüfen', 'Prüfe jeden Pin unabhängig gegen Artikel, Ziel-URL, Markenregeln und Bildrechte. Ohne tatsächlichen Linktest keinen funktionierenden Link behaupten. Fehlende Bilder oder Boards sichtbar lassen; keine fertige Upload-Datei behaupten.', 'Geprüfte Pin-Entwürfe mit Status und offenen Punkten; kein Upload.')
      ]
    },
    H04: {
      goal: 'Vorhandene Affiliate-Empfehlungen gezielt überprüfen und pflegen.',
      inputs: 'Artikeltexte und Affiliate-Verzeichnis mit bestätigten Produkten, Link-IDs und aktuellen Quellen.',
      steps: [
        step('Affiliate-Änderungen vorbereiten', 'Prüfe vorhandene Empfehlungen auf Aktualität, nachvollziehbaren Leserbedarf und bestätigte Link-IDs. Bereite gezielte Vorher/Nachher-Vorschläge vor, keine erfundenen Händler-URLs oder Preise. Theorie-/Rechtsseiten bleiben werbefrei; keine doppelten Werbeplatzierungen.', 'Belegte Affiliate-Befunde und gezielte Text-/Linkvorschläge ohne Website-Änderung.'),
        step('Empfehlungen unabhängig prüfen', 'Prüfe die Vorschläge gegen Artikel, Produktquellen und CONTENT.md: Bedarf, Kompatibilität, Kennzeichnung und Datenschutz. Ohne echten Linktest keinen erfolgreichen Test behaupten; fehlende Belege als offen ausweisen.', 'Geprüftes Affiliate-Änderungspaket mit Risiken, offenen Punkten und Status.')
      ]
    },
    H05: {
      goal: 'Die Qualität eines konkreten Seiten-Änderungspakets kontrollieren.',
      inputs: 'Konkretes Änderungspaket, betroffene Artikel und geprüfte Seitenübersicht.',
      steps: [
        step('Seitenänderungen kontrollieren', 'Vergleiche das bereitgestellte Änderungspaket mit den betroffenen Seiten. Prüfe Verständlichkeit, interne Links, Metadaten, Barrierefreiheit und fachliche Aussagen. Dokumentiere tatsächliche Prüfungen und Grenzen; keine erfolgreichen Browser- oder Linktests erfinden.', 'Qualitätsbericht mit Fundstellen, Belegen und gezielten Korrekturvorschlägen.'),
        step('Qualitätsbericht gegenprüfen', 'Prüfe Befunde und Korrekturvorschläge unabhängig auf Belege, Datenschutz und sichere Anleitungen. Empfehle keine gefährlichen Elektroarbeiten. lastUpdated nur bei sachlicher Inhaltsänderung, nicht für Linkkosmetik. Ein Prüfurteil ersetzt keine Betreiberfreigabe.', 'Geprüfter Qualitätsbericht mit Status und offenen Prüfungen; kein Deployment.')
      ]
    }
  };

  function describe(intakeId, agentIds, installation, snapshot) {
    const entry = Object.entries(installation && installation.mappings || {}).find(([, m]) => m && ['lifestruct', 'ashveil', 'homestackr'].includes(m.businessUnitId) && m.intake === intakeId);
    // Until the installation read answers, generated agents still must not look runnable.
    if (!entry && !(agentIds || []).some(id => /^colony_(lifestruct|ashveil|homestackr)_/.test(id))) return null;
    const id = entry && entry[0], process = snapshot && snapshot.processes && snapshot.processes[id];
    const known = !!process && process.businessUnitId === entry?.[1].businessUnitId;
    const label = !known ? 'Status nicht bestätigt' : process.implemented !== true ? 'Noch nicht eingerichtet' : process.enabled !== true ? 'Modell oder Freigabe fehlt' : 'Über Business-Steuerung';
    const reason = !known ? 'Der aktuelle Fachstatus ist nicht erreichbar oder wird noch geprüft. Hier wird kein Auftrag gestartet.'
      : process.implemented !== true ? 'Der Fachablauf ist noch nicht angeschlossen. Hier kann kein Auftrag starten.'
      : process.enabled !== true ? 'Fachvertrag vorhanden; Modellauswahl, geprüfter Anbieterschlüssel und interne Freigabe müssen noch bereit sein. Keine direkte Ausführung in diesem Fenster.'
      : 'Aufträge werden ausschließlich in der Business-Steuerung mit bestätigten Eingaben und Budget geprüft und gestartet.';
    const definition = known && process.steps ? { goal: process.goal, inputs: (process.prerequisites || []).join(', '), steps: process.steps, qualityLoop: process.qualityLoop } : processes[id] || null;
    return { id, label, reason, definition, href: '/colony/index.html' + (id ? '?process=' + encodeURIComponent(id) : '') };
  }
  return { processes, describe };
});
