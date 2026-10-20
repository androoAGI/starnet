'use strict';
/* Lab-only presentation and boot hygiene. Loaded in <head>, before the app. */
const labStyle = new URLSearchParams(location.search).get('lab-style') === 'original' ? 'original' : 'custom';
document.documentElement.dataset.labStyle = labStyle;

/* The lab has no managed (STARNET) account. If a previous session persisted that
   provider, boot would strand on the RESUME screen — pin the dev provider instead. */
try {
  if (localStorage.getItem('starnet.byok.prov') !== 'custom') localStorage.setItem('starnet.byok.prov', 'custom');
  /* OpenCode has TWO endpoints and they are not interchangeable:
     - Go plan (the lab's setup):  https://opencode.ai/zen/go/v1
     - pay-as-you-go:               https://opencode.ai/inference/openai/v1
     A GO key has NO model access on the pay-as-you-go path ("Model access is disabled"), so the lab pins
     the GO path. The GO gateway also demands a conversation id in x-opencode-session — StarNet sends one
     per run. */
  const baseKey = 'starnet.byok.baseUrl.custom';
  const GO_BASE = 'https://opencode.ai/zen/go/v1';
  const base = localStorage.getItem(baseKey) || '';
  let host = null; try { host = base ? new URL(base).hostname : null; } catch (_) { host = null; }
  if (!base || (host && /(^|\.)opencode\.ai$/i.test(host))) {
    if (base !== GO_BASE) localStorage.setItem(baseKey, GO_BASE);
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
          notice.textContent = 'Testbetrieb · KI aktiv (' + (status.hosts || []).length + ' Hosts · OpenCode Go-Pfad)';
          notice.title = 'Live-Modus: echte Modellaufrufe sind erlaubt. Der OpenCode-Key (oc_sk_…) gehört auf die Karte '
            + 'CUSTOM mit der Basis-URL ' + GO_BASE + '. Veröffentlichungen und Uploads sind nicht eingerichtet.';
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
