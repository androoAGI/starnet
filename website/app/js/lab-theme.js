'use strict';
/* Lab-only presentation and boot hygiene. Loaded in <head>, before the app. */
const labStyle = new URLSearchParams(location.search).get('lab-style') === 'original' ? 'original' : 'custom';
document.documentElement.dataset.labStyle = labStyle;

/* The lab has no managed (STARNET) account. If a previous session persisted that
   provider, boot would strand on the RESUME screen — pin the dev provider instead. */
try {
  if (localStorage.getItem('starnet.byok.prov') !== 'custom') localStorage.setItem('starnet.byok.prov', 'custom');
  /* OpenCode: chat lives under /inference/openai/v1, the catalog under
     /inference/v1. A stale chat base (the old /inference/v1) would 404 every
     run, so normalize opencode.ai custom endpoints to the chat base. */
  const baseKey = 'starnet.byok.baseUrl.custom';
  const base = localStorage.getItem(baseKey) || '';
  let host = null; try { host = base ? new URL(base).hostname : null; } catch (_) { host = null; }
  if (!base || (host && /(^|\.)opencode\.ai$/i.test(host))) {
    if (base !== 'https://opencode.ai/inference/openai/v1') localStorage.setItem(baseKey, 'https://opencode.ai/inference/openai/v1');
  }
  if (!localStorage.getItem('starnet.byok.model.custom')) localStorage.setItem('starnet.byok.model.custom', 'deepseek-v4.1-flash');
} catch (_) {}

if (labStyle === 'custom') {
  document.title = 'Colony · StarNet-Lab';
  const tighten = () => {
    document.body.classList.add('no-scan', 'no-flicker');
    const logo = document.querySelector('#logo .logo-img');
    if (logo) logo.setAttribute('aria-label', 'Colony · StarNet-Lab');
  };
  document.addEventListener('DOMContentLoaded', () => {
    tighten();
    /* Only the cheap render knobs: a full StationUI.setLook would rewrite settings
       and re-bake the station, which is what made startup drag. */
    try { if (typeof World !== 'undefined' && World.crt) World.crt.staticLevel = 0; } catch (_) {}
    /* Say the truth about what this station may do. */
    fetch('/api/lab/status', { cache: 'no-store' })
      .then(r => { if (!r.ok) throw new Error('LAB_STATUS_UNREADABLE ' + r.status); return r.json(); })
      .then(status => {
        const notice = document.getElementById('lab-notice');
        if (!notice) return;
        if (status && status.live) {
          notice.textContent = 'Testbetrieb · KI aktiv (' + (status.hosts || []).join(', ') + ')';
          notice.title = 'Live-Modus: echte Modellaufrufe sind erlaubt. Veröffentlichungen und Uploads sind nicht eingerichtet.';
        } else {
          notice.textContent = 'Testbetrieb · KI noch nicht aktiviert';
          notice.title = 'Offline-Modus: Modellaufrufe und Uploads sind gesperrt. Start mit --live für echte Aufrufe.';
        }
      })
      .catch(() => {
        const notice = document.getElementById('lab-notice');
        if (!notice) return;
        // Never leave the pre-fetch text claiming the KI is off: that was the
        // visible state after every restart while the request was in flight.
        notice.textContent = 'Testbetrieb · Status nicht erreichbar — Seite neu laden';
        notice.title = 'Der lokale Server antwortet gerade nicht.';
      });
  });
  window.addEventListener('load', tighten);
}
