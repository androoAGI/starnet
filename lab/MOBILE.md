# Handy-Oberfläche: Menüs und Hintergrundlast

Status: 19. Oktober 2026. Lab-only, ohne Modellaufrufe, ohne Schreibzugriffe im Prüfbrowser.

## Was gebremst hat

Die Station wird im Browser gezeichnet, nicht auf dem Server. Bei geöffnetem Menü lief die
komplette Szenen-Schleife weiter (Figuren, Lichter, Canvas) und konkurrierte mit dem Aufbau des
Menüs um denselben Haupt-Thread. Zusätzlich baute SETTINGS alle neun Bereiche sofort auf, auch
die unsichtbaren. Gemessen mit lokalem Chromium (390×844, DPR 3) und **6-facher**
CPU-Verlangsamung:

| Fall (Median, 6× CPU) | vorher | nachher |
|---|---|---|
| SYSTEM-Menü öffnen | 1,46 s | 1,09 s |
| SETTINGS öffnen | 3,22 s | **0,90 s** |
| Figuren-Menü öffnen | 3,71 s | **1,70 s** |

Gemessen mit einem verworfenen Aufwärmlauf und drei echten Tippvorgängen je Modus
(`evidence/mobile-performance.json`).

Die Werte sind ein lokaler Vergleich, **keine** Messung des echten Smartphones. Der Server selbst
antwortet lokal in wenigen Millisekunden; die Verzögerung entsteht im Browser. Die volle
Startzeit (viele JS-Dateien, Erstaufbau) bleibt bestehen.

## Änderungen

1. `frontend/js/lab-mobile-ui.js` (neu, nur im Lab geladen): Auf schmalen Touchscreens
   (`max-width: 760px` und grober Zeiger) pausiert die Szenen-Schleife, solange ein Dock-Menü
   oder ein sichtbares Fenster offen ist. Schließen setzt sie fort. Die Simulation wird **nicht**
   nachgeholt, damit nach dem Lesen kein Sprung entsteht.
   - Nur das Zeichnen pausiert. SSE-Verbindung, Hintergrundarbeit, Freigaben und DOM bleiben live.
   - Kein `start()` beim Fortsetzen: Ein per BUILD MODE oder Lebenszyklus gestoppter Boden bleibt
     gestoppt.
   - Opt-out: `?lab-mobile=off`.
2. `frontend/app/world.js`: `World.setMenuPaused()` und `renderPace().mode === 'menu-paused'`.
   Geplante Frames werden abgebrochen; ein erzwungener Resize darf genau ein Standbild zeichnen.
3. `frontend/app/stationui.js`: SETTINGS baut auf dem Handy nur den geöffneten Bereich und
   verdrahtet ihn bei der ersten Anzeige. Ein gebauter Bereich bleibt im DOM, damit Eingaben
   erhalten bleiben. Suche baut alle Bereiche auf, weil sie alle durchsucht. Desktop bleibt
   eager (alle Bereiche sofort), der Ablauf dort ist unverändert.
4. `frontend/css/lab-theme.css`: Bei offenem Handy-Menü keine Ein-/Ausblend-Animation und kein
   `backdrop-filter` auf Fenster/Scrim.

## Grenzen

- Das Figuren-Menü (AGENT DOSSIER) baut weiterhin alle fünf Registerkarten sofort auf. Die
  Szenen-Pause hilft dort, aber der Menüaufbau selbst wurde nicht umgebaut.
- Der Erststart lädt weiterhin über 260 Skripte und braucht auf einem langsamen Gerät spürbar
  Zeit. Dafür gibt es noch keine Bündelung.
- Keine harte Speicher-/CPU-Grenze, keine Betriebssystem-Sandbox. Der Live-Modus bleibt offen.
- Die Prüfung nutzt Chromium mit Geräteemulation und künstlicher Verlangsamung. Ein Test auf dem
  echten Smartphone steht aus.
- Alle Prüfungen blockieren Schreibzugriffe und fremde Hosts; es wurden keine Schlüssel gelesen
  und keine Modelle aufgerufen.

## Nachweise

```sh
node --test lab/mobile-ui.test.cjs test/render-pacing.test.js \
  test/settings-p1-ui.test.js test/room-lighting-settings.test.js
python3 lab/check-mobile-ui.py      # Handy, Desktop, Opt-out; alle Tabs, Suche, Entwurf, Fortsetzen
python3 lab/benchmark-mobile-ui.py  # A/B mit 6-facher CPU-Bremse
```

Ergebnisse: `lab/evidence/mobile-ui.json`, `lab/evidence/mobile-performance.json`.
Screenshots: `/tmp/opencode/starnet-mobile-ui/`.
