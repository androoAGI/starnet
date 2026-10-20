# Zentraler Orchestrator-Raum

Anordnung: **Lifestruct → kleiner Orchestrator-Raum → HomeStackR**.

- Neuer Raum: 9 × 7 Bodenfelder, eigener Schreibtisch für das Profil `Orchestrator`.
- HomeStackR wird als Ganzes um neun Felder nach rechts versetzt. Seine Möbel, Rechner,
  Linien und Förderbänder wandern mit; die Verbindungen und Arbeitsanweisungen bleiben gleich.
- Lifestruct bleibt an Ort und Stelle. Die zuvor diskutierte Begradigung seiner Linie
  ist **nicht** Teil dieser Änderung.
- Kleiner Darstellungsfix in `frontend/app/world.js`: Ein zusätzliches Profil ohne
  Pipeline erscheint beim Laden an seinem zugeordneten Schreibtisch statt im Startraum.
  Bestehende Pipeline-Figuren bleiben unberührt; ohne erreichbaren Sitz bleibt der alte
  Startpunkt erhalten. Keine künstliche Arbeits-/Sitzanimation und kein Modelllauf.
- Der neue Agent ist ein manueller Koordinator: Er kann bei Beauftragung Ziele/Input klären,
  Aufträge vorbereiten und bereitgestellte Ergebnisse zusammenfassen. Es gibt noch keine
  automatische Steuerung oder Überwachung der Pipelines und keine neuen Zeitpläne/Trigger.
- Technisch ist er ein normaler, löschbarer Spezialist mit Koordinationsauftrag, kein zweiter
  globaler StarNet-Founder. Der bestehende Hauptagent bleibt unverändert.
- `approvalMode=ask`, `workshop=false`, Modell `custom/deepseek-v4.1-flash-free`. Keine
  Modellaufrufe Teil der Einrichtung. OpenCode-Anbindung weiterhin nicht als lauffähig bestätigt.
  Anweisungen sind keine harte Sandbox; der Live-Modus wird dadurch nicht abgesichert.

## Einrichtung und Prüfung

```sh
node --test lab/orchestrator.test.cjs
node lab/orchestrator.cjs --live-authoring           # Vorschau
node lab/orchestrator.cjs --live-authoring --apply   # einmalig speichern
python3 lab/check-orchestrator.py                    # lokaler Browsercheck ohne Ausführung
```

Verwendet den nativen WorldModel-Raumumzug und die revisionsgebundene HTTP-Save-API.
Private Sicherung vor dem Speichern: `.lab-state/authoring-backups/before-orchestrator-*.json`.
Bei Dubletten, unerwarteter Raumanordnung oder raumübergreifenden Objekten/Workflows wird
abgebrochen. Bestehende Agenten, Sitzungen und Modell-/Provider-Einstellungen bleiben erhalten.
Speichern/Routing-Publizieren sind wie bisher getrennt; Browser danach neu laden, um auch
den nativen Crew-Roster zu synchronisieren. Keine Schlüssel werden gelesen.

Browsernachweis: `lab/evidence/orchestrator-browser.json`; Screenshots unter
`/tmp/opencode/starnet-orchestrator/`. Smartphone ist nur lokal emuliert, kein Endgerätetest.

19 Lab-Tests erfolgreich (inklusive Startpunkt-/Fallback-Gegenfällen). Desktop und emuliertes
Smartphone erkennen den Raum, das Profil, seinen Schreibtisch und die tatsächlich im Raum
befindliche Figur. Alle vier vorhandenen Linien weiterhin mit je drei besetzten Schritten;
Roster-Synchronisation erfolgreich, keine JavaScript-Seitenfehler, UI-Modellzähler null.
Ausführungs- und Schlüsselrouten wurden im Browsercheck zusätzlich gesperrt.
