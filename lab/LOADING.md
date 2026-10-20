# Ladezeit über Tailscale: Texturen, Cache und Kompression

Status: 19. Oktober 2026. Lokales Lab, keine Veröffentlichung.

## Befund aus dem HAR

Der HAR vom Windows-PC (18.10.2026) zeigt:

- `onLoad` nach **309,75 s**, `DOMContentLoaded` nach 30,56 s.
- Über 30 einzelne **PNG-Texturen mit 1–3 MB** wurden gleichzeitig über dieselbe
  Tailscale-HTTP/2-Verbindung geladen. Pro Datei: 40–195 s Empfangszeit.
- Der Server lieferte für **jede** Datei `Cache-Control: no-store`. Damit lädt der
  Browser bei jedem Besuch alles neu, auch wenn sich nichts geändert hat.
- Die Texturquelle ist **232 MB** (267 Dateien: Industrie-Materialien plus
  Projektions-Props). Dazu kamen ~11 MB ungepacktes JavaScript in 264 Dateien.
- Der Server selbst antwortete lokal in Millisekunden; die Zeit entsteht bei
  Übertragung und Browserarbeit, nicht in der Node-Logik.

## Änderungen

1. **WebP-Nebenversionen** über `lab/make-webp.cjs`:
   - 77 Material-/Shell-Texturen: ca. 144,6 MB → 26,4 MB (q92; verlustfrei bei
     transparenten Einzelstücken).
   - 190 Projektions-Props: ca. 87,4 MB → 12,5 MB (q95, Alpha-Qualität 100).
   - Zusammen **232 MB → 38,9 MB**.
   - Die PNG-Originale bleiben unverändert die Quelle.
2. **Server-Aushandlung** in `sidecar/index.js`: Eine `.png`-URL liefert WebP-Bytes
   mit `Content-Type: image/webp`, wenn der Browser `image/webp` akzeptiert und eine
   gleichnamige `.webp`-Datei existiert. Sonst kommt das Original-PNG.
   `Vary: Accept` hält Caches korrekt. Keine URL-Änderung, keine Manifest-Änderung,
   kein Fallback-Code im Frontend.
3. **Caching**: Statische Dateien erhalten
   `Cache-Control: public, max-age=0, must-revalidate` plus `ETag`; ein unveränderter
   Besuch bekommt **304** statt der Datei. Die App-Seite (`index.html`) bleibt
   `no-store`, weil sie bei jedem Aufruf einen frischen Boot-Nonce und das Token
   einbettet. Der Tailscale-Proxy erzwingt kein `no-store` mehr.
4. **gzip** für JS/CSS/JSON/SVG/HTML ab 1 KB. Die 11,3 MB JavaScript werden so zu
   ca. 3,1 MB Transfer.

## Messung (lokal, Headless-Chromium)

| Größe | vorher | nachher |
|---|---|---|
| Textur-Transfer | 232 MB (PNG) | 38,9 MB (WebP) |
| Erster Seitenaufruf, gesamt | – | 44,4 MB, 14,2 s lokal |
| Neuladen, gesamt | 232 MB + JS | **0,81 MB** (304/ETag) |
| JavaScript-Transfer | 11,3 MB | ~3,1 MB (gzip) |

Die 14,2 s sind lokal gemessen und enthalten weiterhin Browser-/Bake-Arbeit; der
erste Aufruf über Tailscale ist nicht erneut mit einem echten PC gemessen. Neu ist:
Wiederholte Aufrufe übertragen unter 1 MB statt erneut 232 MB.

## Grenzen

- Der **erste** Aufruf lädt weiterhin ~39 MB Texturen und braucht auf einer langsamen
  Tailscale-Strecke spürbar Zeit. Nur wiederholte Aufrufe profitieren voll.
- Nur die tatsächlich vom Remaster genutzten Ordner (`industrial/`, `remaster/`,
  `projection-correction/`, Shell-/Boden-Varianten) sind optimiert. Andere große
  Assets (z. B. Sprites) bleiben PNG.
- WebP-Dateien sind **lab-lokal**, per `.gitignore` ausgeschlossen und werden nicht
  veröffentlicht. StarNet-Grafiken sind laut `NOTICE.md` nicht MIT-lizenziert.
- `lab/make-webp.cjs` nutzt `sharp` aus den vorhandenen Abhängigkeiten; der Server
  braucht `sharp` nicht, er liefert nur vorhandene Dateien aus.
- Keine Aussage über das Verhalten eines echten Smartphones oder fremden PCs; der
  Endgerätezugriff wurde hier nicht getestet.

## Wiederherstellen / Neu erzeugen

```sh
node lab/make-webp.cjs
```

Das Skript ist idempotent und überschreibt nur veraltete WebP-Dateien. Fehlt eine
WebP-Datei, liefert der Server automatisch das PNG. Zum Prüfen:

```sh
curl -sSI -H 'Accept: image/webp,image/png,*/*' \
  http://127.0.0.1:8790/assets/industrial/remaster/floors/parquet.png
```

Erwartet: `Content-Type: image/webp`, `Vary: Accept`, `Cache-Control:
public, max-age=0, must-revalidate`, `ETag`.
