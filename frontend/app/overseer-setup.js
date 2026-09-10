/* Two reversible setup steps. Credentials and identity remain owned by app.js. */
window.OverseerSetup = (() => {
  const el = id => document.getElementById(id);
  let recovery = false;
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
    if (title) title.textContent = provider === 'starnet' ? 'Your StarNet account' : (providers[provider]?.[0] || 'Provider') + ' connection';
  }
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
      const target = brain ? screen.querySelector('.prov.sel:not(.hidden)') || el('in-model') : el('in-name');
      target.focus({ preventScroll: true });
    }
  }
  function init(isRecovery) {
    recovery = !!isRecovery;
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
  }
  return { init, reflectProvider };
})();
