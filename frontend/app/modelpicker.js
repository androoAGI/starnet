/* AGENT OS shared model picker — a per-TARGET model/effort chooser for the recruitment bay (a NEW agent's
   model) and the agent dossier (an EXISTING agent's model). Unlike the COMMS ModelDock (a global singleton
   bound to the FOCUSED agent's live transport), this writes nothing on its own: it renders a grouped native
   <select>, fills it from ModelDock.catalog() (same fallbacks/gating), and hands the picked {model,provider,
   effort} back via read()/onChange so the caller persists it against whichever agent it means. The <option>
   value carries BOTH provider and id, so a chosen model can never desync from its provider. */
'use strict';

const ModelPicker = (() => {
  const SEP = '|';   // provider/id delimiter in the option value — never appears in a provider id or model id
  // Delegates to the one complete implementation (U.esc escapes & < > " ' — quotes included, so the many
  // id="…" / aria-label="…" attribute contexts this picker builds are injection-safe). This module is
  // require()'d directly in Node tests where the browser global U isn't loaded, so guard for it and keep an
  // identical inline fallback (same 5-char set) for that path — matches the pattern in updates.js.
  const esc = s => (typeof U !== 'undefined' && U.esc)
    ? U.esc(s == null ? '' : s)
    : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function md() { return (typeof ModelDock !== 'undefined' && ModelDock && ModelDock.catalog) ? ModelDock : null; }
  function norm(p) { const M = md(); return M ? M.labels.normProvider(p) : String(p || '').trim().toLowerCase(); }

  // The control shell: a model <select> (+ optional effort <select>). Options are filled later by populate().
  // opts: { id, inheritLabel, ariaLabel, effort:boolean }
  function shellHTML(opts) {
    opts = opts || {};
    const id = opts.id || 'mp';
    const inherit = opts.inheritLabel || 'Follow station default';
    let h = '<span class="mp-wrap" data-mp="' + esc(id) + '">';
    h += '<select class="mp-model" id="' + esc(id) + '-model" aria-label="' + esc(opts.ariaLabel || 'Model') + '">';
    h += '<option value="">' + esc(inherit) + '</option>';
    h += '<option value="__loading" disabled>loading catalog…</option>';
    h += '</select>';
    if (opts.effort) {
      h += '<select class="mp-effort" id="' + esc(id) + '-effort" aria-label="Reasoning effort" title="Reasoning effort — how hard this model thinks">';
      h += '<option value="">effort: auto</option>';
      h += '</select>';
    }
    h += '</span>';
    return h;
  }

  function modelSel(root) { return root && root.querySelector && root.querySelector('.mp-model'); }
  function effortSel(root) { return root && root.querySelector && root.querySelector('.mp-effort'); }

  function groupLabelFor(item) {
    const M = md(); if (!M) return 'MODELS';
    const p = norm(item.provider);
    if (p === 'openrouter') return 'OPENROUTER · ' + M.labels.orGroup(item);
    return M.labels.provider(p);
  }
  function optValue(item) { return norm(item.provider) + SEP + String(item.id || ''); }

  // Fill the effort <select> with the efforts a given model supports, preselecting `selected` (clamped).
  function fillEfforts(sel, item, selected) {
    const M = md(); if (!sel) return;
    sel.innerHTML = '<option value="">effort: auto</option>';
    if (!M) return;
    const opts = M.efforts.optionsFor(item || {}) || [];
    for (const e of opts) { const o = document.createElement('option'); o.value = e; o.textContent = 'effort: ' + M.efforts.label(e); sel.appendChild(o); }
    const want = M.normalizeEffort(selected == null ? '' : selected);
    sel.value = (selected && opts.indexOf(want) >= 0) ? want : '';
  }

  // Async: fill the model options from the live catalog and preselect `current` (if any).
  // opts: { current:{model,provider,effort}, inheritLabel, force }
  async function populate(root, opts) {
    opts = opts || {};
    const M = md(); const sel = modelSel(root); if (!sel) return [];
    const current = opts.current || {};
    let list = [];
    try { list = M ? await M.catalog({ force: !!opts.force, ensure: current.model ? { id: current.model, provider: current.provider } : null }) : []; }
    catch (_) { list = []; }
    root._mpList = list;   // stash the full items so onChange can recompute effort options accurately

    const inheritLabel = opts.inheritLabel || (sel.querySelector('option[value=""]') ? sel.querySelector('option[value=""]').textContent : 'Follow station default');
    sel.innerHTML = '';
    sel.appendChild(new Option(inheritLabel, ''));
    let group = '', og = null;
    for (const item of list) {
      const gl = groupLabelFor(item);
      if (gl !== group) { group = gl; og = document.createElement('optgroup'); og.label = gl; sel.appendChild(og); }
      const opt = document.createElement('option');
      opt.value = optValue(item);
      // E4: an item flagged `fallback` came from the hardcoded seed list (live catalog fetch failed for
      // its provider) — label it so this picker doesn't assert an unverified model as a live one, the
      // same honesty the model dock and the connect screen's "(catalog offline)" carry.
      opt.textContent = (M ? M.labels.model(item) : item.id) + (item.fallback ? '  (catalog offline)' : '');
      opt.title = item.id + '  ·  ' + norm(item.provider) + (item.fallback ? '  ·  fallback (catalog offline, unverified)' : '');
      (og || sel).appendChild(opt);
    }
    if (!list.length) { const o2 = document.createElement('option'); o2.value = '__none'; o2.disabled = true; o2.textContent = 'no models found — add a provider key in Settings'; sel.appendChild(o2); }
    // STRANDED-STATE DOOR: an empty catalog means no key is connected — a <select> option can't be clicked, so we
    // render a sibling BUTTON inside the shell that opens the key-entry surface (Settings ▸ PROVIDERS). Purely
    // additive to the DOM (a `.mp-none` node next to the <select>), so read()/onChange/shellHTML are untouched and
    // every consumer (recruitment bay, dossier) gets the door for free without any wiring change. Toggled each
    // populate so it appears exactly when the list is empty and vanishes the moment a key lands + a re-populate runs.
    try { syncNoneDoor(root, !list.length); } catch (_) {}

    // preselect the agent's current model (ensure guaranteed it's present in the list)
    const curKey = current.model ? (norm(current.provider) + SEP + current.model) : '';
    if (curKey) { sel.value = curKey; if (sel.value !== curKey) sel.value = ''; }

    const es = effortSel(root);
    if (es) { const item = list.find(m => optValue(m) === sel.value) || (current.model ? { id: current.model, provider: current.provider } : {}); fillEfforts(es, item, current.effort); }
    return list;
  }

  // Open Settings on the PROVIDERS (key entry) section — the same door friendlyerror routes no-key/auth errors to.
  // Prefers Lane C's openTerm(key, section) when it ships (arity ≥ 2); falls back to the bare settings window today.
  function openKeyEntry() {
    if (typeof StationUI === 'undefined' || !StationUI.openTerm) return;
    try { if (StationUI.openTerm.length >= 2) { StationUI.openTerm('settings', 'providers'); return; } } catch (_) {}
    try { StationUI.openTerm('settings'); } catch (_) {}
  }

  // Show/hide the stranded-state door — a `.mp-none` row (button) rendered as a sibling of the <select> inside the
  // `.mp-wrap` shell. Idempotent: created once, then toggled hidden. Never throws (fail-open: no shell → no door).
  function syncNoneDoor(root, show) {
    const wrap = (root && root.querySelector && root.matches && root.matches('.mp-wrap')) ? root
               : (root && root.querySelector) ? root.querySelector('.mp-wrap') : null;
    const host = wrap || root;
    if (!host || !host.querySelector) return;
    let door = host.querySelector('.mp-none');
    if (!show) { if (door) door.hidden = true; return; }
    if (!door) {
      door = document.createElement('button');
      door.type = 'button';
      door.className = 'mp-none bb sm';
      door.textContent = '🔑 add a provider key';
      door.title = 'No models are available yet — connect a provider key to fill this list';
      door.addEventListener('click', (ev) => { try { ev.preventDefault(); ev.stopPropagation(); } catch (_) {} openKeyEntry(); });
      host.appendChild(door);
    }
    door.hidden = false;
  }

  // Read the current selection. model==='' means "inherit / follow default" (a deliberate clear).
  function read(root) {
    const sel = modelSel(root);
    const val = sel ? sel.value : '';
    let model = '', provider = '';
    if (val && val !== '__loading' && val !== '__none') { const i = val.indexOf(SEP); if (i >= 0) { provider = val.slice(0, i); model = val.slice(i + 1); } else { model = val; } }
    const es = effortSel(root);
    return { model: model, provider: provider, effort: (es ? es.value : '') };
  }

  // Wire change events. When the model changes, the effort options re-fit the new model; cb gets the fresh read().
  function onChange(root, cb) {
    const sel = modelSel(root); const es = effortSel(root);
    if (sel) sel.addEventListener('change', () => {
      if (es) { const item = (root._mpList || []).find(m => optValue(m) === sel.value) || itemFromValue(sel.value); fillEfforts(es, item, es.value); }
      if (cb) cb(read(root));
    });
    if (es) es.addEventListener('change', () => { if (cb) cb(read(root)); });
  }
  function itemFromValue(val) { if (!val || val === '__loading' || val === '__none') return {}; const i = val.indexOf(SEP); return (i >= 0) ? { id: val.slice(i + 1), provider: val.slice(0, i) } : { id: val }; }

  return { shellHTML, populate, read, onChange, fillEfforts };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ModelPicker;
