'use strict';
(() => {
  let token, state, busy = false, installationPreview = null;
  const $ = id => document.getElementById(id);
  const el = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
  const names = { lifestruct: 'Lifestruct', ashveil: 'Ashveil', homestackr: 'HomeStackR' };
  const requestedProcess = new URLSearchParams(location.search).get('process');
  let processRevealed = false;
  let editingTask = null;
  const status = { queued: 'Bereit für interne Arbeit', running: 'In Bearbeitung', needs_revision: 'Interne Nacharbeit', blocked: 'Blockiert',
    ready_for_approval: 'Wartet auf deine Entscheidung', approved: 'Freigegeben – Außenaktion nicht automatisch ausgeführt',
    available: 'Konfiguriert · fachliche Abnahme offen', active: 'Arbeitet', waiting_external: 'Wartet auf Voraussetzung', waiting_user: 'Wartet auf Entscheidung', offline: 'Nicht betriebsbereit' };
  const selected = value => $('brand').value === 'all' || value === $('brand').value;
  function packetExample(p) {
    const inputs = Object.fromEntries((p.inputs || []).map(key => [key, key === 'mails_1_to_7' ? Array.from({ length: 7 }, (_, i) => ({ id: String(i + 1), body: '' }))
      : key === 'sequence' ? ['1','2','3','4','5','6','7']
      : key === 'price' ? { amount: null, currency: '' } : key === 'license' ? ''
      : key === 'product_record' ? { id: '', files: [], variants: [] }
      : key === 'change_package' ? { version: '', affectsTools: false, pageIds: [] }
      : ['page_inventory','file_inventory','affiliate_inventory','demand_evidence','owned_assets','metrics','print_evidence','dependencies','channels','rights','screenshots','checks'].includes(key) ? [] : null]));
    if (['L01','H03'].includes(p.id)) { inputs.pinCount = 3; inputs.visualGuidelines = ''; }
    return { sources: [{ id: 'quelle-1', uri: '', asOf: new Date().toISOString().slice(0,10), version: '', excerpt: '' }], inputs,
      ...(p.outputKind === 'pins' ? { targets: [{ url: '', promise: '' }], boards: [] } : {}) };
  }
  const explain = text => ({ COLONY_MODEL_NOT_CONFIGURED: 'Für diesen Agenten fehlt ein ausführbares Modell.', COLONY_MODEL_OUTPUT_LIMIT: 'Die Modellantwort wurde an der Ausgabegrenze abgeschnitten. Der Auftrag bleibt blockiert.', COLONY_MODEL_MAX_ITERS: 'Das Modell hat sein Ergebnis nicht innerhalb der erlaubten Turns fertiggestellt.', COLONY_MODEL_ERROR: 'Der Anbieter hat den Modelllauf abgewiesen. Auftrag blockiert; keine Freigabe möglich.', COLONY_INVALID_JSON_RESULT: 'Das Modell lieferte kein gültiges Ergebnisformat. Es folgt nur eine begrenzte Korrekturrunde.', COLONY_INVALID_PINS: 'Mindestens ein Pin hat fehlende oder unzulässige Felder; die Redaktion korrigiert das intern.', COLONY_CONFIGURATION_RUNS_ACTIVE: 'Modelleinstellungen können erst nach dem laufenden Auftrag geändert werden.', COLONY_REVISION_LIMIT: 'Die interne Nacharbeit hat ihre Grenze erreicht; Ursache prüfen statt weiter wiederholen.', COLONY_POOL_SPEND_UNKNOWN: 'Der Verbrauch eines unterbrochenen Laufs muss zuerst abgeglichen werden.', COLONY_REVISION_CONFLICT: 'Der Stand hat sich geändert. Bitte aktualisieren und erneut versuchen.', COLONY_METRIC_PROVENANCE_REQUIRED: 'Kennzahlen brauchen Quelle, Zeitraum, Datenebene und Einheit.', COLONY_REAL_PRINT_CONFIRMATION_REQUIRED: 'Die reale Druck-/Montageprüfung muss von dir bestätigt werden.', COLONY_LISTING_DIGITAL_ITEM_NOT_DISCLOSED: 'Der Listingtext muss den STL-/Digitaldownload eindeutig benennen.', COLONY_PRODUCT_REVIEW_UNCONFIRMED: 'Reale Druck-/Montagebestätigung für diese Variante fehlt.', COLONY_CHANGE_VERSION_REQUIRED: 'Für die Seitenänderung fehlt eine stabile Versionskennung.', COLONY_ASSET_SCOPE_UNCONFIRMED: 'Bild/Prüfbeleg oder Rechtebestätigung fehlen oder gehören zu einem anderen Konto.' }[text] || (String(text).startsWith('COLONY_INPUT_REQUIRED_') ? 'Benötigte Eingabe fehlt: ' + String(text).slice('COLONY_INPUT_REQUIRED_'.length).toLowerCase().replaceAll('_', ' ') : text));
  async function api(route, body) {
    const r = await fetch(route, { method: body ? 'POST' : 'GET', cache: 'no-store',
      headers: { 'X-StarNet-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const value = await r.json(); if (!r.ok || !value.ok) throw new Error(explain(value.error || 'Anfrage fehlgeschlagen')); return value;
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
      if (entry.summary) card.append(el('p', entry.summary));
      const previews = el('div', null, 'preview'), checks = [];
      if (!t.pins && Array.isArray(t.items)) {
        const fields = state.processes[t.processId].outputFields || {};
        for (const item of t.items) {
          const cardItem = el('div', null, 'card result-item'), selected = el('input'); selected.type = 'checkbox'; selected.checked = true; checks.push([item.id, selected]);
          const heading = el('label'); heading.append(selected, document.createTextNode(item.title || item.subject || item.id)); cardItem.append(heading);
          const body = el('dl');
          for (const [key, value] of Object.entries(item)) if (!['id', 'sourceIds'].includes(key)) body.append(el('dt', fields[key] || key), el('dd', typeof value === 'string' ? value : JSON.stringify(value)));
          cardItem.append(body); previews.append(cardItem);
        }
      }
      for (const pin of t.pins || []) {
        const p = el('div', null, 'pin'), label = el('label'), check = el('input'); check.type = 'checkbox'; check.checked = true;
        label.append(check, document.createTextNode(pin.title || pin.subject || pin.id)); checks.push([pin.id, check]);
        if (!t.pins) {
          const content = el('dl', null, 'result-item'), fields = state.processes[t.processId].outputFields || {};
          for (const [key, value] of Object.entries(pin)) if (!['id', 'sourceIds'].includes(key)) content.append(el('dt', fields[key] || key), el('dd', typeof value === 'string' ? value : JSON.stringify(value)));
          p.append(label, content); previews.append(p); continue;
        }
        const img = el('img'); img.alt = pin.overlay;
        fetch('/api/colony/image/' + t.artifacts.find(a => a.pinId === pin.id).sha256, { headers: { 'X-StarNet-Token': token } })
          .then(r => { if (!r.ok) throw new Error('Bildnachweis nicht verfügbar'); return r.blob(); })
          .then(blob => { const url = URL.createObjectURL(blob); img.onload = img.onerror = () => URL.revokeObjectURL(url); img.src = url; })
          .catch(error => { img.alt = error.message; });
        const link = el('a', 'Zielseite öffnen'); link.href = pin.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
        p.append(label, img, el('p', pin.description), link); previews.append(p);
      }
      const action = el('select'); action.setAttribute('aria-label', 'Freizugebende Folgeaktion');
      const actionLabels = { accept: 'Interne Übergabe freigeben', provide: 'Internes Paket bereitstellen', export: 'Export vorbereiten', upload: 'Upload vorbereiten', publish: 'Veröffentlichung vorbereiten', send: 'Versand vorbereiten', listing: 'Listing vorbereiten', deploy: 'Änderungspaket vorbereiten' };
      for (const value of entry.actions) { const o = el('option', actionLabels[value] || value); o.value = value; action.append(o); }
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
    const selectedTasks = Object.values(state.tasks).filter(x => selected(x.businessUnitId)).reverse();
    const renderTask = (t, target) => {
      const card = el('article', null, 'card');
      card.append(el('h3', names[t.businessUnitId] + ' · ' + t.goal), el('p', t.testOnly ? 'Techniktest abgeschlossen · nicht freigabefähig' : status[t.status] || t.status, 'badge'),
        el('small', t.spent.unknown ? 'Verbrauch unbekannt – Abgleich erforderlich' : 'Verbrauch: ' + t.spent.tokens + ' Tokens · ' + (t.spent.usdUnknown ? 'Dollarverbrauch nicht beziffert (Abo/Go)' : t.spent.usd.toFixed(4) + ' USD')));
      if (t.reason) card.append(el('p', 'Grund: ' + explain(t.reason)));
      if (t.testOnly) card.append(el('p', 'Techniktest – kein Geschäftsauftrag und nicht für Außenaktionen freigabefähig.', 'badge'));
      if (['queued', 'needs_revision'].includes(t.status)) card.append(button('Internen Durchlauf starten', async () => {
        if (!confirm('Dieser Durchlauf nutzt echte Modelle innerhalb des gespeicherten Budgets. Keine Veröffentlichung. Starten?')) return;
        await api('/api/colony/run', { taskId: t.id, expectedRevision: state.revision, reserve: { usd: t.accountingMode === 'tokens' ? 0 : Math.min(0.5, t.budget.usd / 5), tokens: Math.min(24000, Math.floor(t.budget.tokens / 5)), ms: Math.min(180000, Math.floor(t.budget.ms / 5)) } });
      }));
      if (t.status === 'blocked' && !t.spent.unknown) card.append(button('Fehlende Eingaben ergänzen', () => {
        editingTask = t.id; $('process-select').value = t.processId;
        $('task-goal').value = t.goal; $('task-account').value = t.account; $('task-audience').value = t.audience; $('task-schedule').value = t.schedule;
        $('source-packet').value = JSON.stringify({ businessUnitId: t.businessUnitId, account: t.account, sources: t.sources, inputs: t.inputs, targets: t.targets, boards: t.boards }, null, 2);
        $('confirm-packet').checked = false; $('cancel-edit').hidden = false;
        $('save-task').textContent = 'Eingaben aktualisieren – noch nicht ausführen'; $('prepare-task').scrollIntoView({ block: 'start' });
      }));
      const details = el('details'); details.append(el('summary', 'Auftragsnachweise und Versionen'), el('pre', JSON.stringify(t, null, 2))); card.append(details); target.append(card);
    };
    for (const t of selectedTasks.filter(t => !t.testOnly)) renderTask(t, tasks);
    if (!tasks.childNodes.length) empty(tasks, 'Noch keine Business-Aufträge gespeichert.');
    const technical = selectedTasks.filter(t => t.testOnly);
    if (technical.length) { const details = el('details', null, 'technical-tests'), summary = el('summary', 'Technische Abnahmetests (' + technical.length + ') · nicht freigabefähig'); for (const t of technical) renderTask(t, details); tasks.append(details); }
    const team = $('team'); team.replaceChildren();
    for (const a of state.team.filter(x => selected(x.businessUnitId) || x.businessUnitId === null)) {
      const card = el('article', null, 'card'); card.append(el('h3', a.name), el('p', (a.configured ? '' : 'Modell nicht konfiguriert · ') + (status[a.state] || a.state)),
        el('small', a.id)); for (const run of a.runs) card.append(el('p', run.stepId + ' · ' + run.taskId)); team.append(card);
    }
    const processes = $('processes'); processes.replaceChildren();
    for (const p of Object.values(state.processes).filter(x => selected(x.businessUnitId))) {
      const card = el('article', null, 'card'); card.id = 'process-' + p.id;
      if (p.id === requestedProcess) card.classList.add('process-selected');
      const readiness = p.enabled ? 'Modell und interne Ausführung konfiguriert; ein echter fachlicher Pilot ist noch nicht abgenommen.'
        : p.implemented ? 'Fachvertrag eingerichtet; noch nicht freigeschaltet oder ein Rollenmodell fehlt.'
        : 'Noch nicht eingerichtet – Fachablauf noch nicht angeschlossen.';
      card.append(el('h3', p.id + ' · ' + names[p.businessUnitId] + ' · ' + p.name), el('p', readiness, 'badge'));
      const definition = p.steps ? { goal: p.goal, inputs: p.prerequisites.join(', '), steps: p.steps, qualityLoop: p.qualityLoop } : typeof HomeStackRWorkflows !== 'undefined' && HomeStackRWorkflows.processes[p.id];
      if (definition) {
        card.append(el('p', definition.goal), el('p', 'Benötigte Eingaben: ' + definition.inputs), el('h4', 'Geplante Arbeitsschritte'));
        if (definition.qualityLoop) card.append(el('p', (p.nativeBlueprint === 'fire_escape' ? 'Native StarNet-Blueprint „Review + Fixer“ ist eingesetzt. ' : 'Qualitätsschleife wird im Colony-Backend ausgeführt. ') + definition.qualityLoop.producerRole + ' → Review; Befunde gehen bis zu ' + definition.qualityLoop.maxRevisions + ' Mal an die Produktionsrolle zurück. Erst danach wird der optionale Fixer aufgerufen (' + (p.fixerConfigured ? 'Modell konfiguriert' : 'Modell nicht konfiguriert') + '). Sein Ergebnis braucht zwingend einen neuen unabhängigen Review; No-Progress oder ein nicht bestandenes Schlussreview blockiert. Bei bestandenem Standard-Review läuft der Fixer nicht. Nur bestandene, aktuelle Reviews kommen in die menschliche Freigabe-Inbox.'));
        const steps = el('ol', null, 'process-steps');
        for (const step of definition.steps) {
          const item = el('li');
          item.append(el('strong', step.label), el('p', 'Ergebnis: ' + step.hands));
          const details = el('details'); details.append(el('summary', 'Arbeitsanweisung'), el('p', step.brief));
          item.append(details); steps.append(item);
        }
        card.append(steps);
      } else {
        card.append(el('p', p.goal || ''), el('small', 'Voraussetzungen: ' + p.prerequisites.join(', ')));
        if (p.steps) { const steps = el('ol', null, 'process-steps'); for (const step of p.steps) { const item = el('li'); item.append(el('strong', step.label), el('p', step.brief)); steps.append(item); } card.append(steps); }
      }
      card.append(button('Auftrag für diesen Ablauf vorbereiten', () => { $('process-select').value = p.id; updateProcessHelp(); $('prepare-task').scrollIntoView({ block: 'start' }); }));
      processes.append(card);
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
    try {
      state = await api('/api/colony');
      if (!$('process-select').options.length) {
        for (const p of Object.values(state.processes)) { const option = el('option', p.id + ' · ' + names[p.businessUnitId] + ' · ' + p.name); option.value = p.id; $('process-select').append(option); }
        if (state.processes[requestedProcess]) $('process-select').value = requestedProcess;
        updateProcessHelp();
        $('accounting-mode').value = state.configuration.accountingMode || 'priced';
        $('enable').checked = state.configuration.enabled;
        $('pool-input').value = JSON.stringify(state.configuration.poolBudget, null, 2);
        if (Object.keys(state.configuration.models || {}).length) $('model-input').value = JSON.stringify(state.configuration.models, null, 2);
      }
      if (!processRevealed && state.processes[requestedProcess]) $('brand').value = state.processes[requestedProcess].businessUnitId;
      show();
      if (!processRevealed && state.processes[requestedProcess]) { $('process-' + requestedProcess).scrollIntoView({ block: 'start' }); processRevealed = true; }
    }
    catch (error) { $('connection').textContent = 'Offline / nicht erreichbar – kein aktueller Teamstatus'; $('error').textContent = error.message;
      $('team').replaceChildren(el('p', 'Verbindung unterbrochen. Verfügbarkeit unbekannt.')); }
  }
  $('brand').addEventListener('change', () => { if (state) show(); });
  function updateProcessHelp() {
    const p = state?.processes[$('process-select').value]; if (!p) return;
    $('process-help').textContent = (p.goal || p.name) + ' · Benötigte Eingaben: ' + p.prerequisites.join(', ') + '. Fehlende Daten werden nicht erfunden.';
    $('confirm-packet').checked = false;
    if (!editingTask) $('source-packet').value = JSON.stringify(packetExample(p), null, 2);
  }
  $('process-select').addEventListener('change', updateProcessHelp);
  $('packet-file').addEventListener('change', async () => {
    try { const file = $('packet-file').files[0]; if (!file) return; if (file.size > 500000) throw new Error('Datenpaket ist zu groß (max. 500 KB).'); const text = await file.text(); JSON.parse(text); $('source-packet').value = text; $('confirm-packet').checked = false; }
    catch (error) { $('error').textContent = error.message; }
  });
  $('save-task').addEventListener('click', () => operation(async () => {
    if (!$('confirm-packet').checked) throw new Error('Bitte zuerst Marke, Konto und Quellenstand bestätigen.');
    const p = state.processes[$('process-select').value], packet = JSON.parse($('source-packet').value), account = $('task-account').value.trim();
    if ((packet.businessUnitId && packet.businessUnitId !== p.businessUnitId) || (packet.account && packet.account !== account)) throw new Error('Datenpaket gehört zu einer anderen Marke oder einem anderen Konto.');
    const fields = { goal: $('task-goal').value.trim(), account, audience: $('task-audience').value.trim(), schedule: $('task-schedule').value.trim(),
      sources: (packet.sources || []).map(s => { if (s.businessUnitId && s.businessUnitId !== p.businessUnitId) throw new Error('Markenfremde Quelle.'); return { ...s, businessUnitId: p.businessUnitId, confirmed: true }; }), inputs: packet.inputs || {} };
    if (editingTask) await command({ type: 'task.change', taskId: editingTask, patch: fields });
    else await command({ ...fields, type: 'task.create', processId: p.id, businessUnitId: p.businessUnitId, targets: packet.targets || [], boards: packet.boards || [],
      budget: { usd: state.configuration.accountingMode === 'tokens' ? 0 : 5, tokens: Number($('task-tokens').value), ms: Number($('task-minutes').value) * 60000 } });
    editingTask = null; $('cancel-edit').hidden = true; $('save-task').textContent = 'Auftrag speichern – noch nicht ausführen';
  }));
  $('cancel-edit').addEventListener('click', () => { editingTask = null; $('cancel-edit').hidden = true; $('save-task').textContent = 'Auftrag speichern – noch nicht ausführen'; });
  $('upload-asset').addEventListener('click', () => operation(async () => {
    const file = $('asset-file').files[0], p = state.processes[$('process-select').value];
    if (!file || file.type !== 'image/png' || file.size > 8 * 1024 * 1024 || !$('asset-rights').checked || !$('task-account').value.trim()) throw new Error('PNG, Nutzungsrechte und Konto fehlen oder die Datei ist zu groß.');
    const data = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result.split(',')[1]); r.onerror = reject; r.readAsDataURL(file); });
    const response = await api('/api/colony/asset', { png: data, businessUnitId: p.businessUnitId, account: $('task-account').value.trim(), rightsConfirmed: true, expectedRevision: state.revision });
    $('asset-result').textContent = JSON.stringify(response.result, null, 2);
    const packet = JSON.parse($('source-packet').value); packet.inputs ||= {}; const key = p.id === 'H05' ? 'screenshots' : 'owned_assets';
    const metadata = { ...response.result, pageId: $('asset-page-id').value.trim(), version: packet.inputs.change_package?.version };
    if (p.id === 'H05' && !metadata.pageId) throw new Error('Für den Screenshot fehlt die stabile Seiten-ID.');
    packet.inputs[key] ||= []; packet.inputs[key].push(metadata); $('source-packet').value = JSON.stringify(packet, null, 2);
    if (p.id === 'A03' && !packet.inputs.rights) { packet.inputs.rights = ['Nutzung dieses hochgeladenen Bildes vom Betreiber bestätigt.']; $('source-packet').value = JSON.stringify(packet, null, 2); }
  }));
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
  $('sync-catalog').addEventListener('click', () => operation(() => command({ type: 'catalog.sync' })));
  $('load-models').addEventListener('click', () => operation(async () => { const r = await api('/api/colony/model-defaults'); $('model-input').value = JSON.stringify(r.models, null, 2); }));
  $('configure').addEventListener('click', () => operation(() => command({ type: 'configuration.set', models: JSON.parse($('model-input').value), poolBudget: JSON.parse($('pool-input').value), accountingMode: $('accounting-mode').value, enabled: $('enable').checked })));
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
