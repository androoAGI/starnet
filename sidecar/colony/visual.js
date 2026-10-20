'use strict';

// A deliberately small, local template. The independent reviewer receives the
// actual PNG; creating bytes never counts as visual approval or an image-rights proof.
function renderPin(pin, brand) {
  const { createCanvas } = require('@napi-rs/canvas');
  const canvas = createCanvas(1000, 1500), ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f6f0e4'; ctx.fillRect(0, 0, 1000, 1500);
  ctx.fillStyle = '#2c3835'; ctx.fillRect(60, 70, 880, 1360);
  ctx.fillStyle = '#dfc48d'; ctx.font = 'bold 38px sans-serif';
  ctx.fillText(brand.name, 120, 180, 760);
  ctx.fillStyle = '#fffaf0'; ctx.font = 'bold 76px sans-serif';
  const lines = []; let line = '';
  for (const word of pin.overlay.split(/\s+/)) {
    const candidate = line ? line + ' ' + word : word;
    if (ctx.measureText(candidate).width > 750 && line) { lines.push(line); line = word; } else line = candidate;
  }
  if (line) lines.push(line);
  if (lines.length > 9 || lines.some(text => ctx.measureText(text).width > 750)) throw new Error('COLONY_OVERLAY_DOES_NOT_FIT');
  lines.forEach((text, i) => ctx.fillText(text, 120, 420 + i * 100));
  ctx.fillStyle = '#dfc48d'; ctx.font = '32px sans-serif';
  ctx.fillText('Mehr auf der Zielseite', 120, 1330);
  return canvas.toBuffer('image/png');
}
module.exports = { renderPin };
