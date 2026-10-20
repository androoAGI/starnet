'use strict';
(() => {
  let token, state, busy = false, installationPreview = null;
  const $ = id => document.getElementById(id);
  const el = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
  const names = { lifestruct: 'Lifestruct', ashveil: 'Ashveil', homestackr: 'HomeStackR' };
  const status = { queued: 'Bereit für interne Arbeit', running: 'In Bearbeitung', needs_revision: 'Interne Nacharbeit', blocked: 'Blockiert',
    ready_for_approval: 'Wartet auf deine Entscheidung', approved: 'Freigegeben – Außenaktion nicht automatisch ausgeführt',
    available: 'Verfügbar', active: 'Arbeitet', waiting_external: 'Wartet auf Voraussetzung', waiting_user: 'Wartet auf Entscheidung', offline: 'Nicht betriebsbereit' };
  const selected = value => $('brand').value === 'all' || value === $('brand').value;
  async function api(route, body) {
    const r = await fetch(route, { method: body ? 'POST' : 'GET', cache: 'no-store',
      headers: { 'X-StarNet-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const value = await r.json(); if (!r.ok || !value.ok) throw new Error(value.error || 'Anfrage fehlgeschlagen'); return value;
  }
  async function command(body) { return api('/api/colony/command', { ...body, expectedRevision: state.revision }); }
  async function operation(fn) {
    if (busy) return; busy = true; $('error').textContent = '';
    document.querySelectorAll('button').forEach(b => { b.disabled = true; });
    try { await fn(); } catch (error) { $('error').textContent = error.message; }
    finally { busy = false; await refresh(); }
  }
  function button(label, fn) { const b = el('button', label); b.addEventListener('click', () => operation(fn)); return b; }
  function empty(node, text) { node.replaceChildren(el('p', text, 'muted')); }
  function show() {
    $('connection').textContent = 'Verbunden · Stand ' + new Date(state.observedAt).toLocaleTimeString('de-DE') + ' · Revision ' + state.revision;
    const inbox = $('inbox'); inbox.replaceChildren();
    for (const entry of state.inbox.filter(x => selected(x.businessUnitId))) {
      const t = state.tasks[entry.taskId], card = el('article', null, 'card');
      card.append(el('h3', names[t.businessUnitId] + ' · ' + t.goal), el('p', 'Konto: ' + t.account + ' · Zielgruppe: ' + t.audience + ' · Termin: ' + t.schedule));
      const previews = el('div', null, 'preview'), checks = [];
      for (const pin of t.pins) {
        const p = el('div', null, 'pin'), label = el('label'), check = el('input'); check.type = 'checkbox'; check.checked = true;
        label.append(check, document.createTextNode(pin.title)); checks.push([pin.id, check]);
        const img = el('img'); img.alt = pin.overlay;
        fetch('/api/colony/image/' + t.artifacts.find(a => a.pinId === pin.id).sha256, { headers: { 'X-StarNet-Token': token } })
          .then(r => { if (!r.ok) throw new Error('Bildnachweis nicht verfügbar'); return r.blob(); })
          .then(blob => { const url = URL.createObjectURL(blob); img.onload = img.onerror = () => URL.revokeObjectURL(url); img.src = url; })
          .catch(error => { img.alt = error.message; });
        const link = el('a', 'Zielseite öffnen'); link.href = pin.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
        p.append(label, img, el('p', pin.description), link); previews.append(p);
      }
      const action = el('select'); action.setAttribute('aria-label', 'Freizugebende Folgeaktion');
      for (const value of entry.actions) { const o = el('option', value); o.value = value; action.append(o); }
      const decide = decision => {
        const feedback = decision === 'reject' ? prompt('Was soll intern verbessert werden?') : '';
        if (decision === 'reject' && !feedback) return;
        return command({ type: 'approval.decide', taskId: t.id, digest: entry.digest,
          decision, pinIds: checks.filter(x => x[1].checked).map(x => x[0]), actions: [action.value], feedback });
      };
      const controls = el('div', null, 'actions'); controls.append(action, button('Auswahl freigeben', () => decide('approve')), button('Nacharbeit anfordern', () => decide('reject')));
      card.append(previews, controls); inbox.append(card);
    }
    if (!inbox.childNodes.length) empty(inbox, 'Keine geprüften Ergebnisse zur Freigabe.');
    const tasks = $('tasks'); tasks.replaceChildren();
    for (const t of Object.values(state.tasks).filter(x => selected(x.businessUnitId)).reverse()) {
      const card = el('article', null, 'card');
      card.append(el('h3', names[t.businessUnitId] + ' · ' + t.goal), el('p', status[t.status] || t.status, 'badge'),
        el('small', t.spent.unknown ? 'Verbrauch unbekannt – Abgleich erforderlich' : 'Verbrauch: ' + t.spent.tokens + ' Tokens · ' + t.spent.usd.toFixed(4) + ' USD'));
      if (t.reason) card.append(el('p', 'Grund: ' + t.reason));
      if (['queued', 'needs_revision'].includes(t.status)) card.append(button('Internen Durchlauf starten', async () => {
        if (!confirm('Dieser Durchlauf nutzt echte Modelle innerhalb des gespeicherten Budgets. Keine Veröffentlichung. Starten?')) return;
        await api('/api/colony/run', { taskId: t.id, expectedRevision: state.revision, reserve: { usd: Math.min(0.5, t.budget.usd / 5), tokens: Math.min(16000, Math.floor(t.budget.tokens / 5)), ms: Math.min(120000, Math.floor(t.budget.ms / 5)) } });
      }));
      const details = el('details'); details.append(el('summary', 'Auftragsnachweise und Versionen'), el('pre', JSON.stringify(t, null, 2))); card.append(details); tasks.append(card);
    }
    if (!tasks.childNodes.length) empty(tasks, 'Noch keine Business-Aufträge gespeichert.');
    const team = $('team'); team.replaceChildren();
    for (const a of state.team.filter(x => selected(x.businessUnitId) || x.businessUnitId === null)) {
      const card = el('article', null, 'card'); card.append(el('h3', a.name), el('p', (a.configured ? '' : 'Modell nicht konfiguriert · ') + (status[a.state] || a.state)),
        el('small', a.id)); for (const run of a.runs) card.append(el('p', run.stepId + ' · ' + run.taskId)); team.append(card);
    }
    const processes = $('processes'); processes.replaceChildren();
    for (const p of Object.values(state.processes).filter(x => selected(x.businessUnitId))) {
      const card = el('article', null, 'card'); card.append(el('h3', p.id + ' · ' + names[p.businessUnitId] + ' · ' + p.name),
        el('p', p.implemented ? 'Interner Technikpfad vorhanden; echter Pilot offen' : 'Katalogisiert – noch nicht angeschlossen'),
        el('small', 'Voraussetzungen: ' + p.prerequisites.join(', '))); processes.append(card);
    }
    const cases = $('cases'); cases.replaceChildren();
    for (const c of Object.values(state.cases).filter(x => selected(x.businessUnitId))) {
      const card = el('article', null, 'card'); card.append(el('h3', names[c.businessUnitId] + ' · ' + c.status), el('p', c.feedback)); cases.append(card);
    }
    if (!cases.childNodes.length) empty(cases, 'Noch keine Verbesserungsfälle.');
    $('limitations').replaceChildren(...state.limitations.map(text => el('li', text)));
    document.querySelectorAll('button').forEach(b => { b.disabled = busy; });
    $('install').disabled = busy || !installationPreview;
  }
  async function refresh() {
    try { state = await api('/api/colony'); show(); }
    catch (error) { $('connection').textContent = 'Offline / nicht erreichbar – kein aktueller Teamstatus'; $('error').textContent = error.message;
      $('team').replaceChildren(el('p', 'Verbindung unterbrochen. Verfügbarkeit unbekannt.')); }
  }
  $('brand').addEventListener('change', () => { if (state) show(); });
  $('preview-install').addEventListener('click', () => operation(async () => {
    installationPreview = await api('/api/colony/installation/preview');
    $('installation-preview').textContent = JSON.stringify({ report: installationPreview.report,
      rooms: installationPreview.rooms, processPipelines: Object.keys(installationPreview.mappings).length }, null, 2);
  }));
  $('install').addEventListener('click', () => operation(async () => {
    if (!installationPreview || !confirm('Diese geprüfte Einrichtung mit Sicherung speichern? Keine Modellaufrufe.')) return;
    await api('/api/colony/installation/install', {
      expectedSaveRevision: installationPreview.expectedSaveRevision, expectedStateRevision: installationPreview.expectedStateRevision, previewDigest: installationPreview.previewDigest
    });
    installationPreview = null; $('installation-preview').textContent = 'Einrichtung konsistent gespeichert. Das Roboterhaus übernimmt sie bei passendem lokalem Stand automatisch.';
  }));
  $('refresh').addEventListener('click', refresh);
  $('create').addEventListener('click', () => operation(() => command({ ...JSON.parse($('task-input').value), type: 'task.create' })));
  $('configure').addEventListener('click', () => operation(() => command({ type: 'configuration.set', models: JSON.parse($('model-input').value), poolBudget: JSON.parse($('pool-input').value), enabled: $('enable').checked })));
  $('task-input').value = JSON.stringify({ businessUnitId: 'lifestruct', processId: 'L01', goal: 'Ziel eintragen', account: 'KONTO_EINTRAGEN',
    schedule: 'Termin mit Europe/Berlin eintragen', audience: 'Zielgruppe eintragen',
    sources: [{ id: 'quelle-1', businessUnitId: 'lifestruct', confirmed: false, uri: 'QUELLE_EINTRAGEN', asOf: '2026-10-19', version: '1', excerpt: 'Tatsächlichen Quellinhalt eintragen' }],
    targets: [{ url: 'https://example.org/', promise: 'Tatsächliches Zielversprechen eintragen' }], boards: ['BESTAETIGTES_BOARD'], budget: { usd: 0, tokens: 0, ms: 0 } }, null, 2);
  fetch('/', { cache: 'no-store' }).then(r => r.text()).then(page => {
    const m = page.match(/window\.__STARNET_API_TOKEN__=("(?:\\.|[^"])*")/);
    if (!m) throw new Error('Anmeldung am lokalen Sidecar nicht verfügbar.'); token = JSON.parse(m[1]); return refresh();
  }).catch(error => { $('connection').textContent = 'Nicht verbunden'; $('error').textContent = error.message; });
  setInterval(() => { if (!document.hidden && !busy) refresh(); }, 10000);
})();
