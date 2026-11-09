/* StarNet site — which installer fits this computer.
   Loaded by the download page before site.js; test/website-platform.test.js requires it directly.
   Every Mac browser says "Intel Mac OS X" in its user agent and "MacIntel" in navigator.platform, Apple Silicon included,
   so neither can tell the two Mac builds apart. An Intel Mac sent to the Apple Silicon .dmg gets macOS's "not supported on
   this type of Mac" (customer report, 2026-11-08). So the chip is only named when the browser really says it:
     - Chromium (Chrome, Edge, Brave, Arc): navigator.userAgentData.getHighEntropyValues(['architecture']) → 'arm' | 'x86';
     - otherwise the WebGL renderer: an Apple M-series GPU means Apple Silicon; an Intel, AMD/Radeon or NVIDIA GPU means an
       Intel Mac (Apple Silicon Macs have no other GPU). Safari reports "Apple GPU" on both kinds, which names nothing.
   When neither says, the answer is "a Mac, chip unknown" and the page shows both Mac builds with the About This Mac check
   instead of guessing. Nothing here touches the network; the GPU name is read from a throwaway 1x1 canvas and never sent. */
(function(root, factory){
  var api = factory();
  if(typeof module === 'object' && module.exports) module.exports = api;
  else root.SNPlatform = api;
})(typeof self !== 'undefined' ? self : this, function(){
  'use strict';

  /* 'windows' | 'mac' | null. An iPad asking for the desktop site says "Macintosh" too, but it has a touch screen and no
     Mac build runs on it, so it is not a Mac here. */
  function osFamily(ua, platform, maxTouchPoints){
    ua = String(ua || ''); platform = String(platform || '');
    if(/Windows/i.test(ua) || /^Win/i.test(platform)) return 'windows';
    if(/iPhone|iPad|iPod/i.test(ua)) return null;
    if(/Macintosh|Mac OS X/i.test(ua) || /^Mac/i.test(platform)) return (maxTouchPoints > 1) ? null : 'mac';
    return null;
  }

  /* User-Agent Client Hints (Chromium): { architecture: 'arm' | 'x86', ... } → 'arm' | 'intel' | null */
  function archFromHints(hints){
    var a = hints && typeof hints.architecture === 'string' ? hints.architecture.toLowerCase() : '';
    if(a === 'arm') return 'arm';
    if(a === 'x86') return 'intel';
    return null;
  }

  /* An unmasked WebGL renderer string → 'arm' | 'intel' | null. Only a GPU that exists on one kind of Mac counts. */
  function archFromRenderer(renderer){
    var r = String(renderer || '');
    if(/\bApple M\d/i.test(r)) return 'arm';                                        // "Apple M1", "ANGLE Metal Renderer: Apple M2 Pro"
    if(/\bIntel\b|\bAMD\b|Radeon|\bATI\b|NVIDIA|GeForce|Quadro/i.test(r)) return 'intel';
    return null;                                                                      // "Apple GPU" (Safari), software renderers, ''
  }

  /* os + arch → the card to point at: 'windows' | 'mac-arm' | 'mac-intel' | 'mac-unknown' | null */
  function pick(os, arch){
    if(os === 'windows') return 'windows';
    if(os !== 'mac') return null;
    if(arch === 'arm') return 'mac-arm';
    if(arch === 'intel') return 'mac-intel';
    return 'mac-unknown';
  }

  function webglRenderer(doc){
    try{
      var c = doc.createElement('canvas'); c.width = c.height = 1;
      var gl = c.getContext('webgl', { powerPreference:'low-power' }) || c.getContext('experimental-webgl');
      if(!gl) return '';
      var ext = gl.getExtension('WEBGL_debug_renderer_info');
      var name = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '';
      var lose = gl.getExtension('WEBGL_lose_context'); if(lose) lose.loseContext();
      return String(name || '');
    }catch(e){ return ''; }
  }

  /* The browser glue: resolves { os, arch, card, source }. Never rejects. */
  function detect(nav, doc){
    nav = nav || {};
    var uad = nav.userAgentData;
    var os = osFamily(nav.userAgent, (uad && uad.platform) || nav.platform, nav.maxTouchPoints);
    var done = function(arch, source){ return { os: os, arch: arch, card: pick(os, arch), source: source }; };
    if(os !== 'mac') return Promise.resolve(done(null, 'os'));
    var fromGpu = function(){
      var arch = archFromRenderer(webglRenderer(doc));
      return done(arch, arch ? 'webgl' : 'unknown');
    };
    if(uad && typeof uad.getHighEntropyValues === 'function'){
      return Promise.resolve()
        .then(function(){ return uad.getHighEntropyValues(['architecture']); })
        .then(function(h){ var arch = archFromHints(h); return arch ? done(arch, 'client-hints') : fromGpu(); },
              function(){ return fromGpu(); });
    }
    return Promise.resolve().then(fromGpu);
  }

  return { osFamily: osFamily, archFromHints: archFromHints, archFromRenderer: archFromRenderer, pick: pick, detect: detect };
});
