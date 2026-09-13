/* Pure admission + completion policy for explicit image-generation tasks.

   STUDIO uses either the linked StarNet cloud (which owns upstream credentials and
   credit metering) or a separately configured OpenAI/OpenRouter BYOK route. Credentials and
   endpoints travel together; an ordinary model key cannot authorize another service.
   Completion still depends on the artifact ledger, not the model's prose. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.imageTask = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // This classification imposes a host-side STUDIO requirement before the model runs.
  // Require a direct request for visual content, not nearby keywords or the verbs
  // "draw"/"illustrate" alone. Ambiguous requests retain the ordinary tool path.
  const EXPLICIT_IMAGE_REQUEST = /^(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?)?(?:create|generate|make|draw|render|illustrate|produce)\s+(?:me\s+)?(?:(?:an?|the|some|any)\s+)?(?:(?:new|raster|photorealistic|realistic|digital)\s+)?(?:images?|pictures?|illustrations?|artwork|graphics?)(?:(?:\s+(?:of|depicting|showing)\s+\S.*)|(?:\s*[.!?]*))$/i;
  // Code/vector/text deliverables are not proof of a raster STUDIO requirement.
  const OTHER_MEDIUM = /\b(?:svg|html|css|canvas|mermaid|ascii|unicode|docker|container|disk|iso)\b/i;

  function classify(text) {
    const src = String(text || '').trim();
    if (!EXPLICIT_IMAGE_REQUEST.test(src) || OTHER_MEDIUM.test(src)) return null;
    return { kind: 'image-generation' };
  }

  // OpenAI's /v1/models catalog mixes text agents with specialized media models. StarNet's
  // primary provider seam is a streaming, tool-calling text conversation, so an image-output
  // model cannot be offered or admitted there. It remains available through STUDIO's dedicated
  // image-generation route below.
  const OPENAI_IMAGE_MODEL = /^(?:gpt-image-|chatgpt-image-|dall-e-)/i;
  function isImageModel(providerId, model) {
    return String(providerId || '').trim().toLowerCase() === 'openai'
      && OPENAI_IMAGE_MODEL.test(String(model || '').trim());
  }
  function isAgentModel(providerId, model) { return !isImageModel(providerId, model); }
  function agentModelBlocker(providerId, model) {
    if (!isImageModel(providerId, model)) return null;
    return 'Model unavailable for agent chat: "' + String(model || '').trim()
      + '" generates images and does not support StarNet\'s streaming, tool-calling agent wire. '
      + 'Choose a text model in COMMS; for image requests that agent will use the placed STUDIO with your OpenAI API key. No provider request was sent.';
  }

  // Managed credentials come from the host's linked-account resolver, never from tool
  // arguments or the conversation provider's endpoint override. A StarNet run cannot
  // silently fall back to spending a separate BYOK key when its link is unavailable.
  function resolveRoute(input) {
    input = input || {};
    const providerId = String(input.providerId || '').trim().toLowerCase();
    const runKey = String(input.runKey || '').trim();
    const base = value => String(value || '').trim().replace(/\/+$/, '');
    const managedKey = String(input.managedKey || '').trim();
    const managedBaseUrl = base(input.managedBaseUrl);
    if (providerId === 'openrouter' && runKey) {
      return { ok: true, provider: 'openrouter', protocol: 'openrouter-chat', key: runKey, baseUrl: base(input.providerBaseUrl), keySource: 'run' };
    }
    if (providerId === 'openai' && runKey) {
      return { ok: true, provider: 'openai', protocol: 'openai-images', key: runKey, baseUrl: base(input.providerBaseUrl), keySource: 'run' };
    }
    if (managedKey && managedBaseUrl) {
      return { ok: true, provider: 'starnet', protocol: 'openrouter-chat', key: managedKey, baseUrl: managedBaseUrl, keySource: 'managed' };
    }
    if (providerId !== 'starnet' && String(input.stationOpenRouterKey || '').trim()) {
      return { ok: true, provider: 'openrouter', protocol: 'openrouter-chat', key: String(input.stationOpenRouterKey).trim(), baseUrl: base(input.stationOpenRouterBaseUrl), keySource: 'station' };
    }
    if (providerId !== 'starnet' && String(input.stationOpenAIKey || '').trim()) {
      return { ok: true, provider: 'openai', protocol: 'openai-images', key: String(input.stationOpenAIKey).trim(), baseUrl: base(input.stationOpenAIBaseUrl), keySource: 'station' };
    }
    return { ok: false, code: 'media-route-required' };
  }

  function label(providerId, model) {
    const p = String(providerId || 'selected provider').trim() || 'selected provider';
    const m = String(model || '').trim();
    return m ? p + ' / ' + m : p;
  }

  // Returns null when admission is safe, otherwise the exact user-facing blocker.
  // Gear is checked first: connecting another key cannot grant a missing floor object.
  function admissionBlocker(input) {
    input = input || {};
    if (!input.hasStudio) {
      return 'Image task blocked: this agent has no STUDIO. Open REFIT, place a STUDIO in this agent\'s room, and retry. No image artifact was produced.';
    }
    if (!input.studioEnabled) {
      return 'Image task blocked: a STUDIO is present, but MEDIA STUDIO is disabled for this run. Enable MEDIA STUDIO in ABILITIES > TOOLSETS (and include studio in the routine toolsets if this run is restricted), then retry. No image artifact was produced.';
    }
    if (!(input.route && input.route.ok)) {
      const managed = ['starnet', 'starnet-cloud', 'managed'].includes(String(input.providerId || '').toLowerCase());
      return 'Image task blocked: ' + (managed ? 'the StarNet credits connection is unavailable for ' : 'no media connection is configured for ')
        + label(input.providerId, input.model) + '. Open SETTINGS and ' + (managed
          ? 'relink this station to your StarNet account'
          : 'connect an OpenAI or OpenRouter API key for image generation, or link this station to your StarNet account')
        + ', then retry. No image artifact was produced.';
    }
    return null;
  }

  function hasImageArtifact(artifacts) {
    return Array.isArray(artifacts) && artifacts.some(a => a && a.kind === 'image' && String(a.path || '').trim());
  }

  // Mutates the actual run result at the host's settle seam. Returning a message tells
  // the host to emit agent.run.error; null means the existing terminal is truthful.
  function enforceCompletion(result, artifacts, input) {
    input = input || {};
    if (!result || result.reason !== 'done' || input.clarifying || hasImageArtifact(artifacts)) return null;
    result.reason = 'error';
    return 'Image task did not complete: the run ended without a produced image artifact. Nothing was marked OK; retry after checking the STUDIO route.';
  }

  return { classify, isImageModel, isAgentModel, agentModelBlocker, resolveRoute, admissionBlocker, hasImageArtifact, enforceCompletion };
});
