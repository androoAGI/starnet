/* StarNet site — boot sequence, platform detect, live release links, motion */
(function(){
  'use strict';

  // The network lookup below remains authoritative. This is the last signed public
  // release so an offline/rate-limited page never falls back to an older train.
  var FALLBACK_VERSION = '0.11.2';

  // Pricing page is written but deliberately NOT deployed (Andrew, 2026-08-02). Every link to
  // it is marked data-pricing-link and hidden while this is false, so the site never offers a
  // link that silently lands on the homepage. Flip to true in the same commit that ships
  // pricing.html and the links come back everywhere at once — EXCEPT the docs and legal pages,
  // which do not load this script (adding it there would break the privacy page's "the download
  // page makes ONE api.github.com request" disclosure). scripts/website-shell.mjs stamps their
  // PRICING links as plain anchors; scripts/stage-website-deploy.mjs reads this flag to decide
  // whether pricing.html publishes at all, so the two stay in step by construction.
  var PRICING_LIVE = true;
  // Mark the whole sentence, not just the <a>, wherever pricing is mentioned mid-paragraph —
  // hiding a bare link would leave the surrounding prose referring to a page nobody can reach.
  document.querySelectorAll('[data-pricing-link]').forEach(function(el){ el.hidden = !PRICING_LIVE; });

  var RELEASES_REPO = 'androoAGI/starnet-releases';

  // StarNet Credits (managed plans). The billing service is a separate host; until it is
  // deployed `live:false` keeps every buy button honest — no button on this site may imply
  // a purchase we cannot actually take. Flip `live` to true once the service answers.
  var CREDITS = {
    live: true,
    accountUrl: 'https://account.starnetos.com'
  };
  (function wireCredits(){
    var ctas = document.querySelectorAll('[data-credits-cta]');
    if(!ctas.length) return;
    document.querySelectorAll('[data-credits-gate]').forEach(function(el){ el.hidden = !CREDITS.live; });
    document.querySelectorAll('[data-credits-soon]').forEach(function(el){ el.hidden = CREDITS.live; });
    ctas.forEach(function(a){
      var tier = a.getAttribute('data-tier');
      if(!CREDITS.live){
        // Only the buttons that promise a transaction get defused; in-page nav stays usable.
        if(tier || a.hasAttribute('data-account')){ a.textContent = '[ SOON ]'; a.href = '#get'; }
        return;
      }
      if(tier) a.href = CREDITS.accountUrl + '/account?tier=' + encodeURIComponent(tier);
      else if(a.hasAttribute('data-account')) a.href = CREDITS.accountUrl + '/login';
      else if(a.getAttribute('href') === '#') a.href = CREDITS.accountUrl + '/login';
    });
  })();

  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- boot sequence (once per session) ---------- */
  var bootLines = [
    '> STARNET TERMLINK',
    '> ESTABLISHING UPLINK ........... OK',
    '> STATION MANIFEST LOADED ....... OK',
    '> RENDERING TERMINAL'
  ];
  var boot = document.getElementById('boot');
  var flash = document.getElementById('boot-flash');
  var bootTimers = [];

  function endBoot(withFlash){
    bootTimers.forEach(clearTimeout);
    if(boot) boot.classList.add('hidden');
    try{ sessionStorage.setItem('sn-booted','1'); }catch(e){}
    if(withFlash && flash){
      flash.hidden = false;
      setTimeout(function(){ flash.hidden = true; }, 560);
    }
    startTagline();
  }

  var booted = false;
  try{ booted = sessionStorage.getItem('sn-booted') === '1'; }catch(e){}

  // Subpages (pricing, etc.) reuse this script but carry no #boot overlay.
  if(!boot){
    /* nothing to play */
  }else if(booted || reduce){
    boot.classList.add('hidden');
    startTagline();
  }else{
    var linesEl = document.getElementById('boot-lines');
    var step = 260;
    bootLines.forEach(function(line, i){
      bootTimers.push(setTimeout(function(){
        var d = document.createElement('div');
        d.textContent = line;
        linesEl.appendChild(d);
      }, step * (i + 1)));
    });
    bootTimers.push(setTimeout(function(){ endBoot(true); }, step * bootLines.length + 600));
    boot.addEventListener('click', function(){ endBoot(false); });
    window.addEventListener('keydown', function onKey(){ endBoot(false); window.removeEventListener('keydown', onKey); });
  }

  /* ---------- hero tagline types itself once the terminal is up ---------- */
  var taglineStarted = false;
  function startTagline(){
    if(taglineStarted) return; taglineStarted = true;
    var tl = document.querySelector('.hero .tagline');
    if(!tl || reduce || booted) return;                  // returning visitors get the final frame
    var textNode = tl.firstChild;
    if(!textNode || textNode.nodeType !== 3) return;
    var full = textNode.nodeValue, i = 0;
    textNode.nodeValue = '';
    tl.classList.add('typing');
    (function tick(){
      textNode.nodeValue = full.slice(0, ++i);
      if(i < full.length) setTimeout(tick, full[i-1] === ' ' ? 60 : 34);
      else tl.classList.remove('typing');
    })();
  }

  /* ---------- platform detection ---------- */
  function detectOS(){
    var ua = navigator.userAgent || '';
    var plat = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
    if(/Windows/i.test(ua) || /Win/i.test(plat)) return 'windows';
    if(/Macintosh|Mac OS X/i.test(ua) || /Mac/i.test(plat)){
      // Apple Silicon Macs report Intel in UA; default to arm (the common case for new downloads)
      return 'mac-arm';
    }
    return null;
  }

  var os = detectOS();
  if(os){
    var card = document.querySelector('.dl-card[data-os="' + os + '"]');
    if(card) card.classList.add('detected');
    /* hero CTA stays a plain [ DOWNLOAD ] (Andrew 2026-07-20) — the detected-OS
       highlight below still personalizes the download cards. */
  }

  /* ---------- live release links ---------- */
  function setVersion(v){
    var tag = v.replace(/^v/,'');
    ['ver-badge','ver-foot'].forEach(function(id){
      var el = document.getElementById(id);
      if(el) el.textContent = 'v' + tag;
    });
    document.querySelectorAll('.ver').forEach(function(el){ el.textContent = 'v' + tag; });
  }
  setVersion(FALLBACK_VERSION);

  // Try to resolve exact asset URLs from the latest release. If the API call
  // fails (offline, rate limit, repo not public yet) the buttons keep their
  // fallback href: the releases page itself. Never a dead link.
  fetch('https://api.github.com/repos/' + RELEASES_REPO + '/releases/latest')
    .then(function(r){ if(!r.ok) throw new Error(r.status); return r.json(); })
    .then(function(rel){
      if(rel.tag_name) setVersion(rel.tag_name);
      var assets = rel.assets || [];
      document.querySelectorAll('.dl-btn[data-asset]').forEach(function(btn){
        var suffix = btn.getAttribute('data-asset');
        var match = assets.find(function(a){ return a.name.indexOf(suffix) !== -1; });
        if(match) btn.href = match.browser_download_url;
      });
    })
    .catch(function(){ /* fallback links already in place */ });

  /* ---------- copy buttons ---------- */
  document.querySelectorAll('[data-copy]').forEach(function(btn){
    btn.addEventListener('click', function(){
      var target = document.querySelector(btn.getAttribute('data-copy'));
      if(!target) return;
      navigator.clipboard.writeText(target.textContent).then(function(){
        var old = btn.textContent;
        btn.textContent = '[ COPIED ]';
        setTimeout(function(){ btn.textContent = old; }, 1400);
      });
    });
  });

  /* ---------- year ---------- */
  var y = document.getElementById('year');
  if(y) y.textContent = String(new Date().getFullYear());

  /* ---------- sticky topbar state + scroll-spy on section links ---------- */
  var topbar = document.getElementById('topbar') || document.querySelector('.topbar');
  var toTop = document.querySelector('.to-top');
  var navLinks = Array.prototype.slice.call(document.querySelectorAll('.topnav a[href^="#"]'));
  var spied = navLinks.map(function(a){ return document.querySelector(a.getAttribute('href')); });
  function onScroll(){
    var sy = window.scrollY || document.documentElement.scrollTop;
    if(topbar) topbar.classList.toggle('scrolled', sy > 24);
    if(toTop) toTop.classList.toggle('show', sy > 700);
    if(spied.length){
      var cur = -1;
      for(var i = 0; i < spied.length; i++) if(spied[i] && spied[i].offsetTop - 140 <= sy) cur = i;
      navLinks.forEach(function(a, i){ a.classList.toggle('on', i === cur); });
    }
  }
  window.addEventListener('scroll', onScroll, { passive:true }); onScroll();

  /* ---------- reveal on scroll (additive; nothing is hidden without JS) ---------- */
  if(!reduce && 'IntersectionObserver' in window){
    var targets = Array.prototype.slice.call(document.querySelectorAll('[data-reveal]'));
    var io = new IntersectionObserver(function(entries){
      entries.forEach(function(en){ if(en.isIntersecting){ en.target.classList.add('in'); io.unobserve(en.target); } });
    }, { rootMargin:'0px 0px -10% 0px', threshold:0.05 });
    targets.forEach(function(el){
      el.classList.add(el.getAttribute('data-reveal') === 'stagger' ? 'rv-stagger' : 'rv');
      io.observe(el);
    });
    document.querySelectorAll('.section-head').forEach(function(el){ io.observe(el); });
    // above-the-fold content must not wait for a scroll event
    setTimeout(function(){ targets.forEach(function(el){ if(el.getBoundingClientRect().top < window.innerHeight) el.classList.add('in'); }); }, 80);
    // belt-and-braces: a target the observer somehow missed (fast scroll, odd viewport) must never
    // stay invisible — anything whose top has entered the viewport is revealed on the next scroll.
    var sweep = function(){
      var left = 0;
      targets.forEach(function(el){ if(el.classList.contains('in')) return; if(el.getBoundingClientRect().top < window.innerHeight) el.classList.add('in'); else left++; });
      if(!left) clearInterval(sweepTimer);
    };
    var sweepTimer = setInterval(sweep, 450);
    window.addEventListener('scroll', sweep, { passive:true });
  }

  /* ---------- feature cards: pointer-tracked glow ---------- */
  if(!reduce && window.matchMedia && window.matchMedia('(hover:hover)').matches){
    document.querySelectorAll('.feat').forEach(function(card){
      card.addEventListener('pointermove', function(e){
        var r = card.getBoundingClientRect();
        card.style.setProperty('--mx', ((e.clientX - r.left) / r.width * 100).toFixed(1) + '%');
        card.style.setProperty('--my', ((e.clientY - r.top) / r.height * 100).toFixed(1) + '%');
      });
    });
  }
})();
