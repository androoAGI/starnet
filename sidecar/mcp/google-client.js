'use strict';

// Publisher configuration, never a user setting. Only Google's installed-app
// credentials belong in a desktop bundle; a confidential web client must not.
function desktopClient(raw) {
  if (!raw || !raw.installed || raw.web) throw new Error('Google sign-in requires an installed Desktop app registration');
  const c = raw.installed;
  if (!/^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/i.test(c.client_id || '')) throw new Error('Google Desktop app registration is invalid');
  if (c.auth_uri && c.auth_uri !== 'https://accounts.google.com/o/oauth2/auth' && c.auth_uri !== 'https://accounts.google.com/o/oauth2/v2/auth') throw new Error('Google authorization host is invalid');
  if (c.token_uri && c.token_uri !== 'https://oauth2.googleapis.com/token') throw new Error('Google token host is invalid');
  const secret = c.client_secret || '';
  if (typeof secret !== 'string' || secret.length > 512 || /[^\x21-\x7e]/.test(secret)) throw new Error('Google Desktop registration is invalid');
  return { clientId: c.client_id, clientSecret: secret, tokenEndpointAuthMethod: secret ? 'client_secret_post' : 'none', desktop: true };
}

function loadDesktopClient({ env, readFile }) {
  try {
    const raw = env.STARNET_GOOGLE_DESKTOP_CLIENT_JSON || readFile();
    if (!raw) return null;
    return desktopClient(JSON.parse(raw));
  } catch (_) { return null; } // UI reports unavailable; release staging fails with a useful operator error.
}

const UNAVAILABLE = 'Google sign-in is not available in this build. StarNet needs to finish enabling it. You do not need to create an app or enter credentials.';
// Release scope, deliberately source-controlled: publisher credentials do not enable this feature.
const RELEASE_DEFERRED = true;
const DEFERRED = 'Google Workspace connections are deferred from 0.11.0 while Google verification is completed. Saved connections are kept but cannot run in this update.';
function isWorkspaceUrl(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && !u.port && (
      ['gmail.googleapis.com', 'docs.googleapis.com', 'sheets.googleapis.com',
        'gmailmcp.googleapis.com', 'drivemcp.googleapis.com', 'calendarmcp.googleapis.com',
        'docsmcp.googleapis.com', 'sheetsmcp.googleapis.com'].includes(u.hostname) ||
      u.hostname === 'www.googleapis.com' && /^\/(drive|calendar)(\/|$)/.test(u.pathname));
  } catch (_) { return false; }
}
module.exports = { desktopClient, loadDesktopClient, UNAVAILABLE, RELEASE_DEFERRED, DEFERRED, isWorkspaceUrl };
