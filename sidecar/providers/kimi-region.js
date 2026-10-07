/* sidecar/providers/kimi-region.js — Kimi for Coding account REGIONS (issue #70).

   Kimi runs two separate deployments and an account belongs to exactly one of them:
     · cn     — mainland China, kimi.com : auth.kimi.com  + api.kimi.com/coding/v1   (StarNet's original, only, wire)
     · global — international,  kimi.ai  : auth.kimi.ai   + api.kimi.ai/coding/v1
   A global account cannot sign in at auth.kimi.com, and a token minted by one region is refused by the other
   region's API — so the sign-in AND every request after it must use the SAME region.

   Mirrors Moonshot's own kimi-code region profiles (packages/oauth/src/region.ts). Per that source the OAuth
   client_id, the /api/oauth/* paths and the X-Msh-* device headers are shared across regions; only the hosts
   differ. Live-checked 2026-10-06: auth.kimi.ai's device_authorization answers the same client_id with the same
   RFC 8628 shape (verification page on www.kimi.ai).

   The region is persisted WITH the credential (tokens.json `region`). A credential with no region predates this
   module and was minted at auth.kimi.com, so it reads as 'cn' — existing sign-ins keep working untouched.
   Pure: no fs, no network, no clock. */
'use strict';

const REGIONS = Object.freeze({
  cn: Object.freeze({ id: 'cn', label: 'China (kimi.com)', oauthHost: 'https://auth.kimi.com', baseUrl: 'https://api.kimi.com/coding/v1' }),
  global: Object.freeze({ id: 'global', label: 'Global (kimi.ai)', oauthHost: 'https://auth.kimi.ai', baseUrl: 'https://api.kimi.ai/coding/v1' })
});
// The region a credential WITHOUT a stored region belongs to (every pre-#70 sign-in went to auth.kimi.com).
const LEGACY_REGION = 'cn';

// A requested region -> 'cn' | 'global', or null when the value names neither (callers reject, never guess).
// Accepts kimi-code's own spelling ('mainland-cn') and the domain names so a hand-written value still lands.
function normalizeRegion(value) {
  const s = String(value == null ? '' : value).trim().toLowerCase();
  if (s === 'global' || s === 'intl' || s === 'international' || s === 'kimi.ai' || s === 'ai') return 'global';
  if (s === 'cn' || s === 'china' || s === 'mainland-cn' || s === 'mainland' || s === 'kimi.com' || s === 'com') return 'cn';
  return null;
}
// The region a stored credential belongs to. Missing/unknown = the legacy China deployment.
function regionOfTokens(tokens) {
  return (tokens && typeof tokens === 'object' && normalizeRegion(tokens.region)) || LEGACY_REGION;
}
function profile(region) { return REGIONS[normalizeRegion(region) || LEGACY_REGION]; }
function oauthUrls(region) {
  const host = profile(region).oauthHost;
  return { deviceUrl: host + '/api/oauth/device_authorization', tokenUrl: host + '/api/oauth/token' };
}
function baseUrlFor(region) { return profile(region).baseUrl; }

function sameUrl(a, b) { return String(a || '').trim().replace(/\/+$/, '').toLowerCase() === String(b || '').trim().replace(/\/+$/, '').toLowerCase(); }
// Is this one of Kimi's own regional API bases? (Either region — the value a stale default or an old save carries.)
function isRegionalBaseUrl(url) { return Object.keys(REGIONS).some(r => sameUrl(url, REGIONS[r].baseUrl)); }
// The inference base for a credential in `region`: an empty value or EITHER region's stock base resolves to the
// credential's own region (a kimi.ai token must never be sent to api.kimi.com, nor the reverse). A genuinely
// custom endpoint (a proxy the Commander configured) is left exactly as given.
function resolveBaseUrl(region, url) {
  const u = String(url == null ? '' : url).trim();
  if (!u || isRegionalBaseUrl(u)) return baseUrlFor(region);
  return u;
}

module.exports = { REGIONS, LEGACY_REGION, normalizeRegion, regionOfTokens, oauthUrls, baseUrlFor, isRegionalBaseUrl, resolveBaseUrl };
