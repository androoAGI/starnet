'use strict';

// Deterministic, locally rendered text-pin layout. It is a branded starter layout,
// not generated photography, a rights check, or a visual review.
const WIDTH = 1000, HEIGHT = 1500, INK = '#253631', GOLD = '#c49a52', PAPER = '#f5f0e4';
function wrap(ctx, value, maxWidth, maxLines) {
  const words = String(value || '').trim().split(/\s+/).filter(Boolean), lines = [];
  let line = '';
  for (const word of words) {
    if (ctx.measureText(word).width > maxWidth) throw new Error('COLONY_PIN_WORD_DOES_NOT_FIT');
    const candidate = line ? line + ' ' + word : word;
    if (ctx.measureText(candidate).width > maxWidth && line) { lines.push(line); line = word; }
    else line = candidate;
  }
  if (line) lines.push(line);
  if (!lines.length || lines.length > maxLines) throw new Error('COLONY_PIN_TEXT_DOES_NOT_FIT');
  return lines;
}
function roundRect(ctx, x, y, w, h, r, color) {
  ctx.fillStyle = color; ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.fill();
}
function renderPin(pin, brand) {
  const { createCanvas } = require('@napi-rs/canvas');
  if (!pin || !brand || !String(pin.overlay || '').trim() || String(pin.overlay).length > 120) throw new Error('COLONY_PIN_OVERLAY_REQUIRED');
  const canvas = createCanvas(WIDTH, HEIGHT), ctx = canvas.getContext('2d');
  ctx.fillStyle = PAPER; ctx.fillRect(0, 0, WIDTH, HEIGHT);
  roundRect(ctx, 42, 42, 916, 1416, 34, '#fffdf8');
  roundRect(ctx, 42, 42, 916, 222, 34, INK);
  // Squared bottom corners keep the header one simple, clean editorial banner.
  ctx.fillStyle = INK; ctx.fillRect(42, 230, 916, 34);
  ctx.fillStyle = GOLD; ctx.font = '700 38px sans-serif';
  ctx.fillText(String(brand.name), 96, 147, 730);
  ctx.fillStyle = '#d9e2d9'; ctx.font = '500 22px sans-serif';
  ctx.fillText('WISSEN · ALLTAG · ENTSCHEIDUNG', 98, 202, 790);

  // Simple abstract idea-map motif; no claimed product photo or third-party asset.
  ctx.strokeStyle = '#d9e7dd'; ctx.lineWidth = 4; ctx.globalAlpha = 0.7;
  ctx.beginPath(); ctx.moveTo(788, 126); ctx.lineTo(844, 160); ctx.lineTo(890, 112); ctx.moveTo(844, 160); ctx.lineTo(886, 202); ctx.stroke();
  for (const [x, y] of [[788,126],[844,160],[890,112],[886,202]]) { ctx.fillStyle = GOLD; ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.fill(); }
  ctx.globalAlpha = 1;

  roundRect(ctx, 96, 324, 136, 9, 5, GOLD);
  ctx.fillStyle = GOLD; ctx.font = '700 25px sans-serif'; ctx.fillText('EINFACH ERKLÄRT', 96, 390);
  const titleY = 500; let title = null, titleFont = 76;
  for (const font of [76, 70, 64, 60]) {
    ctx.font = '700 ' + font + 'px sans-serif';
    try { title = wrap(ctx, pin.overlay, 790, 4); titleFont = font; break; } catch (error) { if (!/TEXT_DOES_NOT_FIT/.test(error.message)) throw error; }
  }
  if (!title) throw new Error('COLONY_PIN_TEXT_DOES_NOT_FIT');
  ctx.font = '700 ' + titleFont + 'px sans-serif';
  const titleLine = Math.round(titleFont * 1.25);
  title.forEach((line, i) => ctx.fillText(line, 96, titleY + i * titleLine));

  const description = String(pin.description || '').replace(/\s+/g, ' ').trim();
  let bodyBottom = titleY + title.length * titleLine;
  if (description) {
    ctx.font = '400 38px sans-serif';
    const excerpt = description.length > 160 ? description.slice(0, 157).replace(/\s+\S*$/, '') + '…' : description;
    const lines = wrap(ctx, excerpt, 790, 4), y = titleY + title.length * titleLine + 54;
    if (y + lines.length * 52 > 1160) throw new Error('COLONY_PIN_TITLE_DESCRIPTION_DOES_NOT_FIT');
    ctx.fillStyle = '#485951'; lines.forEach((line, i) => ctx.fillText(line, 98, y + i * 52));
    bodyBottom = y + lines.length * 52;
  }

  // A quiet, non-claiming diagram fills the middle when the supplied copy is short.
  const graphicTop = Math.max(bodyBottom + 48, 930), graphicBottom = Math.min(graphicTop + 150, 1170);
  if (graphicBottom - graphicTop >= 100) {
    const y = graphicTop + (graphicBottom - graphicTop) / 2, xs = [300, 500, 700];
    ctx.strokeStyle = '#d5dfd5'; ctx.lineWidth = 10; ctx.beginPath(); ctx.moveTo(xs[0], y); ctx.lineTo(xs[2], y); ctx.stroke();
    for (const [i, x] of xs.entries()) {
      ctx.fillStyle = i === 1 ? '#e4c98e' : '#edf1e8'; ctx.beginPath(); ctx.arc(x, y, 48, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = i === 1 ? GOLD : '#b7c5b8'; ctx.lineWidth = 5; ctx.stroke();
      ctx.fillStyle = INK; ctx.font = '700 23px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(String(i + 1).padStart(2, '0'), x, y + 8);
    }
    ctx.textAlign = 'left';
  }

  roundRect(ctx, 96, 1220, 808, 148, 24, '#edf1e8');
  ctx.fillStyle = GOLD; ctx.beginPath(); ctx.arc(143, 1294, 18, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = INK; ctx.font = '700 31px sans-serif'; ctx.fillText('Mehr auf der Zielseite', 184, 1304, 670);
  ctx.fillStyle = '#65736a'; ctx.font = '400 20px sans-serif'; ctx.fillText(String(brand.name), 98, 1418);
  const bytes = canvas.toBuffer('image/png');
  if (bytes.length > 8 * 1024 * 1024) throw new Error('COLONY_PIN_IMAGE_TOO_LARGE');
  return bytes;
}
module.exports = { renderPin, wrap, WIDTH, HEIGHT };
