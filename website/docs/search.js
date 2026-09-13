/* Local, section-aware docs search. No requests or analytics. Also usable by the link gate. */
(function(root){
  'use strict';
  function search(index, query){
    var terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length || query.trim().length < 2) return [];
    var score = function(text, weight){
      text = (text || '').toLowerCase();
      return terms.reduce(function(n,t){ return n + (text.includes(t) ? weight : 0); },0);
    };
    return index.map(function(p){
      var sections = p.s || [];
      var corpus = [p.t,p.d,p.g].concat(sections.map(function(s){ return s.t + ' ' + s.b; })).join(' ').toLowerCase();
      if (!terms.every(function(t){ return corpus.includes(t); })) return null;
      var ranked = sections.map(function(s){ return {section:s, score:score(s.t,8)+score(s.b,2)}; })
        .sort(function(a,b){ return b.score-a.score; });
      var best = ranked[0];
      var titleScore = score(p.t,12);
      var section = best && best.score > 0 && titleScore < terms.length * 12 ? best.section : null;
      return {page:p, score:titleScore + score(p.d,3) + (best ? best.score : 0),
        url:p.u + (section ? '#' + section.id : ''),
        label:section ? section.t : p.t,
        excerpt:section ? section.b.slice(0,140) : p.d.slice(0,140)};
    }).filter(Boolean).sort(function(a,b){return b.score-a.score;}).slice(0,8);
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = search;
  else root.SN_DOCS_SEARCH = search;
})(typeof window !== 'undefined' ? window : this);
