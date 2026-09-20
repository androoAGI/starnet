'use strict';
// The setup viewer uses StarNet's own component CSS and artwork. No re-created
// design tokens or duplicate font declarations: builds copy these exact sources.
const UI_ASSETS = [
  'css/style.css', 'css/app.css', 'css/motion.css', 'css/interface.css',
  'css/glass-demo.css', 'css/readability.css',
  'assets/fonts/vt323.woff2', 'assets/brand/starnet-wordmark.svg'
];
if (require.main === module) {
  const fs = require('node:fs'), path = require('node:path');
  const destination = path.resolve(process.argv[2]);
  for (const file of UI_ASSETS) {
    const target = path.join(destination, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(__dirname, '../frontend', file), target);
  }
}
module.exports = { UI_ASSETS };
