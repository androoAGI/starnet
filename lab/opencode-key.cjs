'use strict';
/* lab/opencode-key.cjs — der OpenCode-Schluessel, den diese Maschine schon hat.

   Wofuer: die Karte CUSTOM braucht einen OpenCode-Key (Service-Account-Key `oc_sk_…` aus der
   Console, Permission *Inference*). Der Key, den der Commander eingefuegt hat, wurde von
   OpenCode selbst abgelehnt (401 "Invalid credential", wortgleich mit einem erfundenen Key).
   Auf diesem Rechner liegt aber meist ein GUELTIGER Key — der OpenCode-CLI hat ihn in seiner
   eigenen Auth-Datei gespeichert (`~/.local/share/opencode/auth.json`, Eintrag `opencode-go`).

   Das Skript holt ihn von dort und macht genau eine von drei Dingen:
     (ohne Schalter)  den Key auf dem Terminal ausgeben, damit er eingefuegt werden kann
     --copy            denselben Key in die Zwischenablage legen (xclip / xsel / wl-copy)
     --push            ihn der Station des Labos geben (Datei .lab-state/.../provider-keys.json),
                      damit Laeufe OHNE offenen Browser (Routinen, Night Shift) ihn benutzen

   Es schreibt NIE in den Browser des Commanders: der Browser haelt seinen eigenen Key, und nur
   der Commander entscheidet, welcher es ist. Der Aufruf liest nur die Auth-Datei des OpenCode-CLI
   auf diesem Rechner. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const wantCopy = argv.includes('--copy');
const wantPush = argv.includes('--push');

function authCandidates() {
  const home = os.homedir();
  const out = [];
  const dataHome = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  out.push(path.join(dataHome, 'opencode', 'auth.json'));
  out.push(path.join(home, '.local', 'share', 'opencode', 'auth.json'));
  out.push(path.join(home, '.opencode', 'auth.json'));
  return [...new Set(out)];
}

function readCliKey() {
  for (const file of authCandidates()) {
    let doc = null;
    try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { continue; }
    const entry = (doc && (doc['opencode-go'] || doc.opencode || doc.zen)) || null;
    const key = String((entry && entry.key) || '').trim();
    if (key) return { key, file };
  }
  return null;
}

const found = readCliKey();
if (!found) {
  console.error('Kein OpenCode-Key auf diesem Rechner gefunden (gesucht: ' + authCandidates().join(', ') + ').');
  console.error('Einen holen: opencode.ai/console -> Keys -> Add Service Account -> Add API Key (Permission: Inference).');
  process.exit(1);
}
const key = found.key;

if (wantPush) {
  // Die Station des Labos: dieselbe Datei, die die Seite befüllt (sidecar/engine-credential.js).
  const stateDir = path.join(root, '.lab-state', 'workspaces', '.secrets');
  const file = path.join(stateDir, 'provider-keys.json');
  let envelope = { version: 1, providers: {} };
  try { envelope = JSON.parse(fs.readFileSync(file, 'utf8')) || envelope; } catch (_) {}
  if (!envelope.providers || typeof envelope.providers !== 'object') envelope.providers = {};
  const prev = envelope.providers.custom || {};
  envelope.providers.custom = {
    key,
    baseUrl: String(prev.baseUrl || 'https://opencode.ai/zen/go/v1'),
    rev: String(prev.rev || 'labopencode').slice(0, 32)
  };
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(envelope, null, 2), { mode: 0o600 });
  console.log('Key in der Station hinterlegt: ' + file);
  console.log('Er gilt fuer Laeufe OHNE offenen Browser (Routinen, Night Shift).');
  console.log('Fuer den Chat im Browser muss der Key trotzdem auf der Karte CUSTOM stehen — dort entscheidet der Commander.');
}

if (wantCopy) {
  const candidates = [['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']], ['wl-copy', []]];
  for (const [bin, args] of candidates) {
    try {
      execFileSync(bin, args, { input: key, stdio: ['pipe', 'ignore', 'ignore'] });
      console.log('Key in die Zwischenablage gelegt (' + bin + ').');
      process.exit(0);
    } catch (_) { /* das naechste Werkzeug */ }
  }
  console.error('Kein Zwischenablage-Werkzeug gefunden (xclip / xsel / wl-copy) — der Key steht unten.');
}

console.log('---');
console.log(key);
console.log('---');
console.log('Quelle: ' + found.file + '  (Eintrag opencode-go)');
console.log('Das ist ein Geheimnis: damit kann jemand dein OpenCode-Konto benutzen.');
console.log('Einfuegen: SETTINGS -> PROVIDERS -> CUSTOM -> Key-Feld -> einfuegen -> SAVE.');
