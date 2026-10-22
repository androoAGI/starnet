/* AGENT OS — remote-devices.js : SETTINGS › REMOTE, the desk side of Agent OS Remote.

   Switch Remote on, pair a phone with a QR code, see which phones are paired and connected, remove one.
   Everything shown is read from GET /api/remote (the sidecar's real state): the relay line says ONLINE only
   when the station is signed in at the relay, a phone reads CONNECTED only while it holds a live session.

     RemoteDevices.mount(el, arrange)   builds the pane inside `el` (arrange = stationui's arrangeSettingsPane)

   Uses the settings vocabulary only (h4.ms-h, p.set-about, label.set-row, .set-save, button.bb, .msg), so the
   glass skin applies exactly as it does to every other settings pane. No native dialogs: removal arms via
   ArmConfirm. The QR is drawn by app/qr.js; the pairing link carries its one-time code in the URL FRAGMENT. */
'use strict';
(function (root) {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ago = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); if (s < 60) return s + 's ago'; const m = Math.round(s / 60); if (m < 60) return m + 'm ago'; const h = Math.round(m / 60); return h < 48 ? h + 'h ago' : Math.round(h / 24) + 'd ago'; };

  async function api(path, body) {
    const r = await fetch(path, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let j = null; try { j = await r.json(); } catch (_) {}
    if (!r.ok || !j || j.ok === false) throw new Error((j && j.error) || ('request failed (' + r.status + ')'));
    return j;
  }

  function mount(el, arrange) {
    el.innerHTML =
      '<h4 class="ms-h">REMOTE <span class="dim">— your station, from your phone</span></h4>' +
      '<p class="set-about">Pair a phone and it can see your crew, send tasks, answer approvals and open what your agents made, from anywhere. ' +
      'Everything between the phone and this computer is encrypted end to end: the Agent OS relay in the middle passes sealed messages it cannot read. ' +
      'A phone works with the same permissions as this desk: an agent on full access acts without asking from your phone too, so you can work on the go. Tick ALWAYS ASK on a phone to have it ask before every step that needs an OK. Standing grants and full access are only ever set here, at the desk.</p>' +
      '<label class="set-row"><input type="checkbox" id="rmt-on"> REMOTE ON <span class="dim" id="rmt-on-note">— checking…</span></label>' +
      '<p class="set-about" id="rmt-link"></p>' +
      '<div class="set-save"><button class="bb sm" id="rmt-pair" type="button" disabled>PAIR A PHONE</button></div>' +
      '<div id="rmt-pairbox" hidden></div>' +
      '<span class="msg" id="rmt-msg" aria-live="polite"></span>' +
      '<h4 class="ms-h">PAIRED PHONES</h4>' +
      '<div id="rmt-devices"><span class="dim">reading…</span></div>';
    if (typeof arrange === 'function') arrange(el);

    const $ = (id) => el.querySelector('#' + id);
    let snap = null, pairTimer = null, poll = null, pairing = null;

    function say(text, bad) { const m = $('rmt-msg'); if (!m) return; m.textContent = text || ''; m.classList.toggle('bad', !!bad); }

    function paint() {
      if (!snap) return;
      $('rmt-on').checked = !!snap.enabled;
      const relay = snap.relay || null;
      let note = snap.enabled ? '— paired phones can reach this station' : '— off: no phone can reach this station';
      $('rmt-on-note').textContent = note;
      let link;
      if (!snap.enabled) link = '';
      else if (!relay) link = snap.listening ? 'Relay: not set up in this build. Phones on this computer’s network can use the test door on port ' + esc(snap.port) + '.' : 'Relay: not set up in this build.';
      else if (relay.state === 'online') link = '● Relay: <b>online</b> at ' + esc(relay.url) + (relay.since ? ' since ' + esc(ago(Date.now() - relay.since)) : '') + '.';
      else if (relay.state === 'connecting') link = '○ Relay: connecting to ' + esc(relay.url) + '…';
      else link = '✕ Relay: <b>offline</b>' + (relay.lastError ? ' — ' + esc(relay.lastError) : '') + '. Retrying on its own.';
      if (snap.station && snap.enabled) link += (link ? '<br>' : '') + 'This station’s code: <b>' + esc(snap.station.fingerprint) + '</b> (a phone shows the same code when it pairs).';
      $('rmt-link').innerHTML = link;
      $('rmt-link').hidden = !link;
      $('rmt-pair').disabled = !snap.enabled || !(relay ? relay.state === 'online' : snap.listening);

      const box = $('rmt-devices');
      const live = new Set((snap.connected || []).filter(c => c.live || (Date.now() - c.lastAt) < 60000).map(c => c.deviceId));
      if (!snap.devices || !snap.devices.length) { box.innerHTML = '<span class="dim">No phones paired.</span>'; return; }
      box.innerHTML = snap.devices.map(d =>
        '<div class="set-row rmt-dev" data-dev="' + esc(d.id) + '">' +
          '<span class="dot' + (live.has(d.id) ? ' on' : '') + '"></span> ' + esc(d.name) +
          ' <span class="dim">— ' + (live.has(d.id) ? 'connected now' : (d.lastSeenAt ? 'last seen ' + esc(ago(Date.now() - d.lastSeenAt)) : 'never connected')) +
          ' · code ' + esc(d.fingerprint) + '</span>' +
          ' <label class="dim" title="This phone asks before every step that needs an OK, even for agents on full access"><input type="checkbox" data-askfirst="' + esc(d.id) + '"' + (d.askFirst ? ' checked' : '') + '> ALWAYS ASK</label>' +
          ' <button class="bb xs danger" type="button" data-remove="' + esc(d.id) + '">REMOVE</button>' +
        '</div>').join('');
      box.querySelectorAll('[data-askfirst]').forEach(cb => {
        cb.onchange = async () => {
          const id = cb.getAttribute('data-askfirst'), on = cb.checked;
          cb.disabled = true;
          try { snap = await api('/api/remote/device', { deviceId: id, askFirst: on }); say(on ? 'From its next task, that phone asks before every step that needs an OK (a task it is running now keeps the permissions it started with).' : 'That phone now works with this desk’s permissions (agents on full access act without asking).'); paint(); }
          catch (e) { cb.checked = !on; cb.disabled = false; say(e.message, true); }
        };
      });
      box.querySelectorAll('[data-remove]').forEach(btn => {
        const id = btn.getAttribute('data-remove');
        if (typeof ArmConfirm !== 'undefined') ArmConfirm.wire(btn, { armedLabel: 'SURE? REMOVE', onConfirm: () => remove(id) });
        else btn.onclick = () => remove(id);
      });
    }

    async function refresh() {
      try { snap = await api('/api/remote'); paint(); }
      catch (e) { say('Could not read Remote status: ' + e.message, true); }
    }

    async function remove(id) {
      try { snap = await api('/api/remote/revoke', { deviceId: id }); say('Removed. That phone is disconnected and can no longer reach this station.'); paint(); }
      catch (e) { say(e.message, true); }
    }

    $('rmt-on').onchange = async (ev) => {
      const on = ev.target.checked;
      ev.target.disabled = true;
      try { snap = await api('/api/remote/enable', { on }); say(on ? 'Remote is on.' : 'Remote is off. Paired phones are disconnected (they stay paired for next time).'); }
      catch (e) { say(e.message, true); await refresh(); }
      ev.target.disabled = false;
      closePairing(); paint();
    };

    function closePairing() { clearInterval(pairTimer); pairTimer = null; pairing = null; const b = $('rmt-pairbox'); if (b) { b.hidden = true; b.innerHTML = ''; } }

    $('rmt-pair').onclick = async () => {
      closePairing();
      let p;
      try { p = await api('/api/remote/pair', {}); } catch (e) { say(e.message, true); return; }
      pairing = p;
      const box = $('rmt-pairbox');
      let qr = '';
      try { qr = (typeof QR !== 'undefined' && p.pairUrl) ? QR.svg(p.pairUrl, { quiet: 4 }) : ''; } catch (_) { qr = ''; }
      box.innerHTML =
        '<div class="rmt-pair">' +
          (qr ? '<div class="rmt-qr" role="img" aria-label="Pairing code for your phone">' + qr + '</div>' : '') +
          '<div class="rmt-pair-text">' +
            '<p class="set-about">Scan this with your phone’s camera. It opens Agent OS Remote and pairs this one phone. On an iPhone it first shows you how to put Agent OS on your Home Screen, so it works like an app.</p>' +
            '<p class="set-about">Station code: <b>' + esc(p.fingerprint) + '</b> — your phone will show the same.</p>' +
            '<p class="set-about dim" id="rmt-exp"></p>' +
            '<div class="set-save"><button class="bb xs" type="button" id="rmt-copy">COPY LINK</button><button class="bb xs" type="button" id="rmt-cancel">CANCEL</button></div>' +
          '</div>' +
        '</div>';
      box.hidden = false;
      $('rmt-cancel').onclick = closePairing;
      $('rmt-copy').onclick = async () => {
        try { await navigator.clipboard.writeText(p.pairUrl); say('Link copied. Open it on the phone you want to pair. It works once.'); }
        catch (_) { say('Could not copy. Scan the code instead.', true); }
      };
      const tick = () => {
        const left = p.expiresAt - Date.now();
        if (left <= 0) { closePairing(); say('That pairing code expired. Press PAIR A PHONE for a new one.'); return; }
        const e = $('rmt-exp'); if (e) e.textContent = 'Works once, for the next ' + Math.floor(left / 60000) + ':' + String(Math.floor(left / 1000) % 60).padStart(2, '0') + '.';
      };
      tick(); pairTimer = setInterval(tick, 1000);
      const before = (snap && snap.devices ? snap.devices.length : 0);
      // the pairing completes on the phone: watch for the new device, then close the code
      const watch = setInterval(async () => {
        if (pairing !== p) { clearInterval(watch); return; }
        await refresh();
        if (snap && snap.devices && snap.devices.length > before) { clearInterval(watch); closePairing(); say('Paired ' + snap.devices[snap.devices.length - 1].name + '.'); }
      }, 2000);
    };

    refresh();
    poll = setInterval(() => { if (!el.isConnected) { clearInterval(poll); closePairing(); return; } if (!pairing) refresh(); }, 5000);
  }

  root.RemoteDevices = { mount };
})(typeof window !== 'undefined' ? window : globalThis);
