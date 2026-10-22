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

const UNAVAILABLE = 'Google sign-in is not available in this build. Agent OS needs to finish enabling it. You do not need to create an app or enter credentials.';
// Release scope, deliberately source-controlled: publisher credentials do not enable this feature.
// true = each Workspace service is gated by RELEASED below. Only test/review preloads set it false.
const RELEASE_DEFERRED = true;
const SELECTED_FILES_ENABLED = true;
const FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FILES_URL = 'https://www.googleapis.com/drive/v3#selected-files';

/* PER-SERVICE RELEASE. Google reviews OAuth scopes by tier: SENSITIVE scopes need data-access verification
   (scope justification + demo video); RESTRICTED scopes additionally need the CASA security assessment,
   renewed every 12 months. Each service ships on its OWN tier's approval, so Calendar/Docs/Sheets and
   send-only Gmail never wait on the Gmail/Drive assessment. Keyed by the exact local-adapter endpoint
   (transport.google.js ENDPOINTS) — an old hosted-MCP URL or a manual alias matches no service and stays
   deferred whatever is released. Flip a service to true ONLY after Google approves its tier AND signed-
   installer acceptance for that service has passed (docs/GOOGLE_VERIFICATION_PACKET.md). */
const SERVICES = Object.freeze({
  gmail: { name: 'Gmail', tier: 'restricted', url: 'https://gmail.googleapis.com/gmail/v1/users/me' },
  'gmail-send': { name: 'Gmail (send only)', tier: 'sensitive', url: 'https://gmail.googleapis.com/gmail/v1/users/me#send-only' },
  'google-drive': { name: 'Google Drive', tier: 'restricted', url: 'https://www.googleapis.com/drive/v3' },
  'google-calendar': { name: 'Google Calendar', tier: 'sensitive', url: 'https://www.googleapis.com/calendar/v3' },
  'google-docs': { name: 'Google Docs', tier: 'sensitive', url: 'https://docs.googleapis.com/v1/documents' },
  'google-sheets': { name: 'Google Sheets', tier: 'sensitive', url: 'https://sheets.googleapis.com/v4/spreadsheets' }
});
const RELEASED = {
  gmail: false, 'gmail-send': false, 'google-drive': false,
  'google-calendar': false, 'google-docs': false, 'google-sheets': false
};

/* EARLY ACCESS — never a user setting. It opens every Google service BEFORE Google's verification: Google then
   shows its "unverified app" warning at sign-in and caps the app at 100 users. The catalog labels every card so
   nobody mistakes it for a verified release. Legacy endpoints stay deferred; the relay guard applies.
   The SOURCE default below is what decides it today: ON since 2026-09-23 (Andrew) — users need Google NOW while
   verification is pending, so EVERY build (public release-train included) is early access. The staged-registration
   flag (STARNET_GOOGLE_EARLY_ACCESS=1 → `earlyAccess: true`, read by loadEarlyAccess) can only turn it ON, so it is
   inert while this is true. When Google approves: set this back to false and release services through RELEASED. */
const EARLY_ACCESS = true;
function loadEarlyAccess({ readFile }) {
  try { return JSON.parse(readFile() || '{}').earlyAccess === true; }
  catch (e) { return false; }   // no staged registration (dev, public build) => not early access
}

function isSelectedFiles(cfg) { return !!cfg && cfg.id === 'google-files' && cfg.url === FILES_URL; }
function fileScopeOnly(scope) { const scopes = String(scope || '').trim().split(/\s+/); return scopes.length === 1 && scopes[0] === FILE_SCOPE; }
const DEFERRED = 'Full Google Workspace access is deferred while Google verification is completed. Saved broad-access connections are kept but cannot run. Selected Google files is available separately.';
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
// The service a connector config/catalog entry runs as — EXACT endpoint match only (see SERVICES).
function serviceOf(cfg) {
  const url = cfg && String(cfg.url || '');
  return Object.keys(SERVICES).find(id => SERVICES[id].url === url) || null;
}
function isGoogleConnector(cfg) {
  return !!cfg && (!!cfg.googleApi || cfg.transport !== 'stdio' && isWorkspaceUrl(cfg.url));
}
// Read through the exported object so test/review preloads (which mutate the export) take effect.
function connectorDeferred(cfg) {
  if (api.RELEASE_DEFERRED === false || !isGoogleConnector(cfg)) return false;
  if (isSelectedFiles(cfg)) return !api.SELECTED_FILES_ENABLED;
  const svc = serviceOf(cfg);
  if (svc && api.EARLY_ACCESS === true) return false;
  return !(svc && api.RELEASED[svc] === true);
}
function deferredMessage(cfg) {
  const s = SERVICES[serviceOf(cfg)];
  if (!s) return DEFERRED;
  const waitsOn = s.tier === 'restricted'
    ? 'Google’s app verification and the security assessment Google requires for mailbox and whole-Drive access are complete'
    : 'Google’s app verification is complete';
  return s.name + ' is deferred until ' + waitsOn + '. Saved connections are kept but cannot run. Selected Google files is available now.';
}

const api = module.exports = { desktopClient, loadDesktopClient, UNAVAILABLE, RELEASE_DEFERRED, SELECTED_FILES_ENABLED, FILE_SCOPE, FILES_URL,
  isSelectedFiles, fileScopeOnly, DEFERRED, isWorkspaceUrl, SERVICES, RELEASED, serviceOf, isGoogleConnector, connectorDeferred, deferredMessage,
  EARLY_ACCESS, loadEarlyAccess };
