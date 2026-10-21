# Sci-Fi-Schilder (2026-10-21)

Dauerhaft sichtbare Schilder, die auf dem Stationsboden neben einer Produktionslinie stehen.
Der Text wird vom Commander selbst geschrieben — und **der Text bestimmt die Größe des Schildes**:
kurz ⇒ kleines Schild, zwei Absätze ⇒ hohes, breites Schild.

## Die drei Varianten

| Schild | Id | Größe (leer) | max | Charakter |
|---|---|---|---|---|
| SIGN BOARD | `sign_board` | 2 × 2 Kacheln | 8 × 4 | Stahltafel auf zwei Beinen — das klassische Schild an der Linie |
| HOLO SIGN | `sign_holo` | 2 × 2 | 6 × 4 | Lichtpanel über einem Emitter (leuchtend, mit Scanlinien) |
| SIGN PYLON | `sign_pylon` | 2 × 2 | 3 × 4 | Schmale Stele mit kleinem Kopf — das Startschild einer Linie |

Alle drei liegen in der Palette unter **FURNITURE › SIGNS** (Reiter „SIGNS", 3 Einträge).

## Die eine Regel (Text ⇒ Größe)

`frontend/app/signtext.js` ist ein **reines** Modul (kein DOM, kein Canvas, keine Station) und die
**einzige** Stelle, die misst:

- **Breite folgt der Textlänge.** Der Text wird umbrochen; die breiteste Zeile bestimmt die
  Breite (2–8 Kacheln, je nach Stimmung).
- **Höhe folgt den Absätzen.** Ein Zeilenumbruch im Text = ein Absatz = eine Zeile mehr auf dem
  Schild ⇒ das Schild wird höher.
- **Beides ist begrenzt** (pro Stimmung ein Minimum und ein Maximum). Passt der Text am Ende
  trotzdem nicht, wird die Schrift kleiner (7 → 4 px) und zuletzt mit „…" abgeschnitten — ein
  Schild verliert nie stillschweigend ein Wort.
- **Der Rahmen zählt mit.** Jede Stimmung hat eigenen „Chrome" (Rahmen, Beine, Emitter, Mast).
  Die Engine misst diese Pixel mit, damit das Schild nicht zu klein für seinen Text ausfällt.

Beispiel (SIGN BOARD): `A` → 2 × 2 · `LINE ALPHA` → 5 × 2 · `RESEARCH LINE ALPHA` → 8 × 2 ·
`LINE ALPHA` + `SECOND ROW` → 5 × 3.

## Bedienung (BUILD MODE)

1. **Props ▸ FURNITURE ▸ SIGNS** → Schild anklicken (das Werkzeug bleibt scharf).
2. Auf freie Fläche klicken ⇒ das Schild landet **leer** und der Text-Editor öffnet sofort.
3. Text eintragen (Enter = neue Zeile = neuer Absatz). Die Anzeige unten rechts sagt vorher,
   wie groß das Schild dadurch wird (`8 × 3 TILES`).
4. **SET WORDS** ⇒ Text und Größe gehen in einem Schritt ins Modell. **CLEAR** leert das Schild.

Ein Schild lässt sich später jederzeit wieder anklicken (dann öffnet derselbe Editor) oder über
**WORDS** in der Auswahl-Karte bearbeiten. Beim Kopieren/Duplizieren reisen die Worte mit.

Wächst ein Schild in eine Maschine hinein, lehnt das Modell den Schritt ab
(`OVERLAP` / `OFF_DECK`) — ein Schild darf nie eine Maschine fressen.

## Speichern

Der Text liegt am Prop (`prop.text`, max. 240 Zeichen) und übersteht Speichern/Neuladen
(`migrate()` in `worldmodel.js` behält ihn). Das Modell kennt die **Schrift-Messregel nicht**
(das Modell importiert nie den Katalog) — es speichert Text und Größe, gemessen vom Aufrufer.

## Dateien

| Datei | Rolle |
|---|---|
| `frontend/app/signtext.js` | **neu** — die reine Messregel (Text ⇒ Zeilen ⇒ Kachelmaß) |
| `frontend/app/propsprites.js` | Katalogzeilen (`signs`-Shelf), die drei Art-Funktionen, `CAT_LABEL.signs` |
| `frontend/app/worldmodel.js` | `setPropText(propId, text, box)` (Text + Größe, ein Undo-Schritt), `migrate()`, `addProp({text})` |
| `frontend/app/build.js` | Text-Editor (`openSignEditor`), Platzieren/Auswählen/Kopieren |
| `frontend/css/refit.css` | `.refit-sign-editor` (Textfeld + Größenanzeige) |
| `test/signtext.test.js` | die Messregel (Breite/Höhe/Umbruch/Clipping) |
| `test/sign-prop.test.js` | Katalog, Modell, Speichern, „die Worte landen auf den Pixeln" |
| `test/sign-editor.test.js` | der Editor im BUILD MODE (Text → Größe → Modell) |
