/* sidecar/browser-handoff-routes.js — the STEP-IN HTTP surface + the remembered-sign-ins list.

   Routes (all behind the central /api auth gate; nothing here is reachable without the station token):
     GET  /api/browser/handoffs              live + recent handoffs and the remembered-sign-ins view
     POST /api/browser/handoff/take   {id}   the Commander takes the wheel (stream starts)
     POST /api/browser/handoff/back   {id}   HAND BACK — the agent resumes
     POST /api/browser/handoff/cancel {id}   CAN'T DO IT — the agent is told to take another route
     GET  /api/browser/handoff/frame?id=&after=   long-poll for the next JPEG frame (only while taken)
     POST /api/browser/handoff/input  {id, events:[…]}   the Commander's pointer / keys / paste (only while taken)
     GET  /api/browser/signins                remembered sign-ins
     POST /api/browser/signins/forget         wipe the station browser profile (every saved sign-in)

   SECRECY. Input events are forwarded and forgotten: never logged, never stored, never echoed. Frames are served
   only to the authenticated station page. The remembered-sign-ins list records WHERE the Commander signed in (host,
   agent, when) and nothing else — no usernames, no cookies.

   REMEMBERED SIGN-INS, grounded against trunk (2026-09-29): the station already keeps ONE durable browser profile
   (index.js BROWSER_PROFILE_DIR, single-run leased) that every run tries first. A handoff inside a run that holds
   that lease is remembered automatically; one inside a run that fell back to a temporary profile is not, and the
   handoff record says which (`remembered`). The list lives INSIDE the profile dir, so FORGET (which removes the
   whole profile) can never leave a list claiming sign-ins that no longer exist. */
'use strict';
const { note: failNote } = require('./failopen.js');

const LIST_FILE = 'Agent OS-signins.json';
const MAX_SITES = 60;
const MAX_EVENTS = 64;

function makeSigninStore(deps) {
  const { dir, fs, path, load, save, isBusy, anyLive, now } = deps;
  const file = () => path.join(dir, LIST_FILE);
  function sites() {
    let v; try { v = fs.existsSync(file()) ? load(file(), 'browser-signins') : null; } catch (_) { v = null; }
    return (v && Array.isArray(v.sites)) ? v.sites.filter(s => s && typeof s.host === 'string').slice(0, MAX_SITES) : [];
  }
  function note(view) {
    // Only a COMPLETED handoff on the DURABLE profile is a remembered sign-in. Anything else would be a claim the
    // browser cannot back up.
    if (!view || view.state !== 'returned' || view.remembered !== true || !view.host) return false;
    try {
      if (!fs.existsSync(dir)) return false;
      const list = sites().filter(s => s.host !== view.host);
      list.unshift({ host: String(view.host).slice(0, 200), agentId: String(view.agentId || '').slice(0, 80), at: now() });
      save(file(), { sites: list.slice(0, MAX_SITES) });
      return true;
    } catch (_) { return false; }
  }
  function view() {
    let exists = false; try { exists = fs.existsSync(dir); } catch (e) { failNote('signins.exists', e); }
    return { profile: exists, inUse: !!isBusy(), sites: exists ? sites() : [] };
  }
  function forget() {
    if (anyLive()) return { ok: false, error: 'an agent is waiting on you in this browser right now - hand it back or cancel first' };
    if (isBusy()) return { ok: false, error: 'a run is using the station browser right now - try again when it finishes' };
    try { fs.rmSync(dir, { recursive: true, force: true }); }
    catch (e) { return { ok: false, error: 'could not remove the saved browser profile: ' + ((e && e.message) || e) }; }
    let gone = true; try { gone = !fs.existsSync(dir); } catch (e) { failNote('signins.gone', e); }
    return gone ? { ok: true } : { ok: false, error: 'the saved browser profile is still on disk' };
  }
  return { note, view, forget, sites };
}

function makeHandoffRoutes(deps) {
  const { host, readBody, respondJson, signins } = deps;
  async function body(req, max) { try { return JSON.parse(await readBody(req, max || 4096)) || {}; } catch (_) { return null; } }
  const idOf = b => String((b && b.id) || '').slice(0, 64);

  async function list(req, res) {
    const l = host.list();
    respondJson(res, 200, { ok: true, live: l.live, recent: l.recent, signins: signins.view() });
  }
  async function take(req, res) {
    const b = await body(req); if (!b) return respondJson(res, 400, { ok: false, error: 'bad json' });
    const r = await host.take(idOf(b));
    respondJson(res, r.ok || r.view ? 200 : 404, r);
  }
  function settle(fn) {
    return async (req, res) => {
      const b = await body(req); if (!b) return respondJson(res, 400, { ok: false, error: 'bad json' });
      const v = fn(idOf(b));
      if (!v) return respondJson(res, 404, { ok: false, error: 'no live handoff ' + idOf(b), view: host.get(idOf(b)) });
      respondJson(res, 200, { ok: true, view: v });
    };
  }
  async function frame(req, res) {
    const u = new URL(req.url, 'http://x');
    const r = await host.frame(String(u.searchParams.get('id') || '').slice(0, 64), Number(u.searchParams.get('after')) || 0, 12000);
    if (!r.ok) return respondJson(res, 409, { ok: false, error: r.error, view: host.get(String(u.searchParams.get('id') || '')) });
    respondJson(res, 200, { ok: true, frame: r.frame ? { seq: r.frame.seq, mime: r.frame.mime, width: r.frame.width, height: r.frame.height, data: r.frame.data } : null });
  }
  async function input(req, res) {
    const b = await body(req, 64 * 1024); if (!b) return respondJson(res, 400, { ok: false, error: 'bad json' });
    const events = Array.isArray(b.events) ? b.events.slice(0, MAX_EVENTS) : (b.event ? [b.event] : []);
    if (!events.length) return respondJson(res, 400, { ok: false, error: 'no input events' });
    let n = 0;
    for (const ev of events) {
      let r;
      try { r = await host.input(idOf(b), ev); }
      catch (e) { return respondJson(res, 502, { ok: false, error: 'the browser did not take the input: ' + ((e && e.message) || e), applied: n }); }
      if (!r.ok) return respondJson(res, 409, { ok: false, error: r.error, applied: n });
      n++;
    }
    respondJson(res, 200, { ok: true, applied: n });
  }
  async function signinList(req, res) { respondJson(res, 200, Object.assign({ ok: true }, signins.view())); }
  async function forget(req, res) {
    const r = signins.forget();
    respondJson(res, r.ok ? 200 : 409, Object.assign({}, r, signins.view()));
  }
  const back = settle(id => host.handBack(id));
  const cancel = settle(id => host.cancel(id));
  return {
    list, take, back, cancel, frame, input, signinList, forget,
    routes: [
      { m: 'GET', exact: '/api/browser/handoffs', h: list },
      { m: 'POST', exact: '/api/browser/handoff/take', h: take },
      { m: 'POST', exact: '/api/browser/handoff/back', h: back },
      { m: 'POST', exact: '/api/browser/handoff/cancel', h: cancel },
      { m: 'GET', qsplit: '/api/browser/handoff/frame', h: frame },
      { m: 'POST', exact: '/api/browser/handoff/input', h: input },
      { m: 'GET', exact: '/api/browser/signins', h: signinList },
      { m: 'POST', exact: '/api/browser/signins/forget', h: forget }
    ]
  };
}

/* The 2-minute nudge line for a connected channel. Plain words, no URL, no query string: where + why. */
function nudgeLine(view, agentName) {
  const who = String(agentName || view.agentId || 'An agent').toUpperCase();
  const why = { login: 'sign in', '2fa': 'enter a sign-in code', captcha: 'get past a human check', payment: 'confirm a payment', other: 'help with a page' }[view.reason] || 'help with a page';
  return who + ' is waiting for you to ' + why + (view.where ? ' at ' + view.where : '') + '. Open Agent OS > STEP-IN to take its browser.' + (view.note ? ' (' + String(view.note).slice(0, 160) + ')' : '');
}

module.exports = { makeHandoffRoutes, makeSigninStore, nudgeLine, LIST_FILE };
