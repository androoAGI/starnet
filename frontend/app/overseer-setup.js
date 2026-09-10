/* Two reversible setup steps. Credentials and identity remain owned by app.js. */
window.OverseerSetup = (() => {
  const el = id => document.getElementById(id);
  let recovery = false;
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
  return { init };
})();
