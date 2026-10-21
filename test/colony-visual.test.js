'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderPin, wrap, WIDTH, HEIGHT } = require('../sidecar/colony/visual.js');

test('deterministic editorial pin rendering fits authored copy inside the local template', async () => {
  const { loadImage, createCanvas } = require('@napi-rs/canvas');
  const bytes = renderPin({ overlay: 'Mit KI den Alltag strukturieren und Ziele erreichen',
    description: 'Ein kurzer Einstieg mit einem belegten Alltagsbeispiel und einem konkreten nächsten Schritt.', url: 'https://example.org' }, { name: 'Lifestruct' });
  const image = await loadImage(bytes);
  assert.equal(image.width, WIDTH); assert.equal(image.height, HEIGHT); assert.ok(bytes.length > 10000);
  assert.throws(() => renderPin({ overlay: '' }, { name: 'Lifestruct' }), /OVERLAY_REQUIRED/);
  assert.throws(() => renderPin({ overlay: 'Z'.repeat(121) }, { name: 'Lifestruct' }), /OVERLAY_REQUIRED/);
  assert.doesNotThrow(() => renderPin({ overlay: 'KI als Strukturhilfe: Aufgaben ordnen, Ziele planen, Prompts testen.', description: 'Ein einfacher Einstieg: Nutze KI, um Aufgaben zu sortieren, Prioritäten zu setzen und Ziele in kleine Schritte zu zerlegen. Der Newsletter zeigt gelegentlich Prompts zum Ausprobieren; der Guide kostet laut Nutzerangabe 59 EUR. Hinweis: Dies ist ein isolierter Test-Pin; die Zielseite ist synthetisch.' }, { name: 'Lifestruct' }));
  const ctx = createCanvas(1000, 100).getContext('2d'); ctx.font = '700 76px sans-serif';
  assert.throws(() => wrap(ctx, 'Z'.repeat(130), 790, 4), /WORD_DOES_NOT_FIT/);
});
