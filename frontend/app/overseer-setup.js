/* Two reversible setup steps. Credentials and identity remain owned by app.js. */
window.OverseerSetup = (() => {
  const el = id => document.getElementById(id);
  let recovery = false;
  let hooks = {}, modelBefore = '', currentModel = {}, nameWired = false;
  const screen = () => el('screen-connect');
  const providers = {
    grok: ['Grok','Sign in'], kimi: ['Kimi','Sign in'], openrouter: ['OpenRouter','API key'],
    openai: ['OpenAI','ChatGPT or API key'], anthropic: ['Anthropic','API key'], gemini: ['Gemini','API key'],
    ollama: ['Ollama','Free · local'], xai: ['xAI','API key'], groq: ['Groq','API key'],
    mistral: ['Mistral','API key'], deepseek: ['DeepSeek','API key'], together: ['Together','API key'],
    fireworks: ['Fireworks','API key'], perplexity: ['Perplexity','API key'], cerebras: ['Cerebras','API key'],
    custom: ['Custom','Your endpoint']
  };
  function reflectProvider(provider) {
    const title = el('ov-connection-title');
    if (title) title.textContent = provider === 'starnet' ? 'Your StarNet account' : (providers[provider]?.[0] || 'Provider');
    const help = el('ov-connection-help');
    if (help) help.textContent = provider === 'starnet' ? 'Confirm your account in the browser, then choose a model.'
      : provider === 'ollama' ? 'Choose a model installed on this computer.'
      : provider === 'custom' ? 'Enter your endpoint, then choose or enter a model ID.'
      : provider === 'openai' ? 'Sign in with ChatGPT or add an OpenAI API key.'
      : ['grok','kimi','codex'].includes(provider) ? 'Sign in, then choose a model from your account.'
      : 'Add your provider’s API key, then choose a model.';
    const logo = el('ov-connection-logo');
    if (logo) {
      logo.classList.toggle('ov-starnet-logo', provider === 'starnet');
      logo.style.setProperty('--provider-icon', 'url("' + new URL('assets/brand/' + (provider === 'starnet' ? 'starnet-wordmark.svg' : 'providers/' + (provider === 'codex' ? 'openai' : provider) + '.svg'), document.baseURI).href + '")');
    }
  }
  function beginConnection() {
    screen().dataset.connection = 'open';
    screen().querySelector('.ov-connection').hidden = false;
    el('ov-brain').scrollTop = 0;
  }
  function showProviders() {
    screen().dataset.connection = 'choose';
    screen().querySelector('.ov-connection').hidden = true;
    el('ov-brain').scrollTop = 0;
    screen().querySelector('.prov.sel:not(.hidden)')?.focus({preventScroll:true});
  }
  function reflectModel(item, provider) {
    currentModel = { ...item, provider };
    if (el('ov-model-dialog')?.open) return;
    el('ov-model-name').textContent = item.id ? ModelDock.labels.model(item) : 'Choose a model';
    el('ov-model-detail').textContent = item.id ? 'Change model or browse the catalog' : 'Browse the model catalog';
    renderReasoning();
  }
  function renderReasoning() {
    const api = ModelDock.efforts, item = currentModel;
    const options = api.optionsFor(item), presets = api.presetsFor(item);
    const selected = Harness.getReasoningEffort(item.provider);
    el('ov-reasoning').hidden = !item.id || !presets.length;
    const active = api.presetFor(selected, item);
    const render = (id, choices) => {
      const wrap = el(id); wrap.replaceChildren();
      choices.forEach(choice => {
        const button = document.createElement('button'); button.type = 'button';
        button.textContent = choice.label; button.setAttribute('aria-pressed', String(choice.active));
        button.onclick = () => { Harness.setReasoningEffort(choice.value,item.provider); renderReasoning(); };
        wrap.appendChild(button);
      });
    };
    render('ov-reasoning-presets', presets.map(p => ({label:p.label, value:api.forPreset(p.id,selected,item), active:active?.id === p.id})));
    render('ov-reasoning-exact', options.map(value => ({label:api.label(value), value, active:selected === value})));
  }
  function openModel() {
    modelBefore = el('in-model').value;
    el('ov-model-dialog').showModal();
    el('in-model').focus(); el('in-model').select();
  }
  function finishModel(cancel) {
    const dialog = el('ov-model-dialog');
    if (!dialog.open) return false;
    if (cancel) el('in-model').value = modelBefore;
    dialog.close(); hooks.closeModel?.(); hooks.refreshModel?.();
    el('ov-model-open').focus();
    return true;
  }
  const cancelModel = () => finishModel(true);
  const modelPicked = () => finishModel(false);
  function select(step, focus = true) {
    if (recovery) step = 'brain';
    const screen = el('screen-connect');
    screen.dataset.setupStep = step;
    const brain = step === 'brain';
    el('ov-identity').hidden = brain;
    el('ov-brain').hidden = !brain;
    el('btn-setup-next').hidden = brain;
    el('btn-wake').hidden = !brain;
    el('btn-back').hidden = !brain;
    screen.querySelectorAll('[data-setup-step]').forEach(button => {
      if (button.dataset.setupStep === step) button.setAttribute('aria-current', 'step');
      else button.removeAttribute('aria-current');
    });
    screen.querySelector('.ov-grid').scrollTop = 0;
    if (focus) {
      const target = brain ? (screen.dataset.connection === 'open' ? el('ov-change-provider') : screen.querySelector('.prov.sel:not(.hidden)')) || el('ov-model-open') : el('in-name');
      target.focus({ preventScroll: true });
    }
  }
  function init(isRecovery, callbacks) {
    hooks = callbacks || {};
    recovery = !!isRecovery;
    showProviders();
    el('ov-change-provider').onclick = showProviders;
    el('ov-model-open').onclick = openModel;
    el('ov-model-cancel').onclick = cancelModel;
    el('ov-model-custom').onclick = modelPicked;
    el('ov-model-dialog').oncancel = event => { event.preventDefault(); cancelModel(); };
    const reflectName = () => { el('ov-name-length').textContent = el('in-name').value.length + ' / 18'; };
    if (!nameWired) { el('in-name').addEventListener('input',reflectName); nameWired = true; }
    reflectName();
    el('ov-skin-count').textContent = el('skin-picker').querySelectorAll('button').length + ' characters';
    document.querySelectorAll('.prov-grid .prov').forEach(button => {
      const id = button.dataset.prov, info = providers[id];
      if (!info) return;
      const icon = document.createElement('span'); icon.className = 'ov-provider-logo';
      icon.style.setProperty('--provider-icon', 'url("' + new URL('assets/brand/providers/' + id + '.svg', document.baseURI).href + '")');
      icon.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span'); label.className = 'ov-provider-label';
      const name = document.createElement('span'); name.textContent = info[0];
      const hint = document.createElement('small'); hint.textContent = info[1];
      label.append(name, hint); button.replaceChildren(icon, label);
      button.setAttribute('aria-label', info[0] + ' — ' + info[1]);
    });
    el('screen-connect').querySelector('.ov-setup-nav').hidden = recovery;
    el('screen-connect').querySelectorAll('[data-setup-step]').forEach(button => {
      button.onclick = () => select(button.dataset.setupStep);
    });
    el('btn-setup-next').onclick = () => select('brain');
    if (!recovery) {
      el('btn-back').classList.remove('hidden');
      el('btn-back').textContent = '← YOUR OVERSEER';
      el('btn-back').onclick = () => select('identity');
      el('in-name').onkeydown = event => {
        if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); select('brain'); }
      };
    }
    select(recovery ? 'brain' : 'identity', false);
    if (recovery) beginConnection();
  }
  return { init, reflectProvider, reflectModel, beginConnection, modelPicked, cancelModel };
})();
