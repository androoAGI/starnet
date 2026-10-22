/* AGENT OS — journey.js: pure presentation helpers for the Commander journey.
   Journey progress is separate from agent XP and from station-size tier. It never gates capabilities. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Journey = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const DOMAINS = ['building', 'research', 'writing', 'growth', 'operations', 'creative', 'planning', 'support'];
  const DOMAIN_LABEL = { building: 'BUILDING', research: 'RESEARCH', writing: 'WRITING', growth: 'GROWTH', operations: 'OPERATIONS', creative: 'CREATIVE', planning: 'PLANNING', support: 'SUPPORT' };
  const RULES = [
    // Specific output forms precede broad shipping words: "draft the launch email" is writing, not building.
    ['writing', /\b(write|draft|copy|article|email|document|publish|script|story|content)\b/i],
    ['building', /\b(build|ship|implement|code|develop|deploy|launch|fix|test|game|app|website|saas)\b/i],
    ['research', /\b(research|investigate|compare|audit|analy[sz]e|study|validate|discover|interview)\b/i],
    ['growth', /\b(revenue|mrr|customer|user|conversion|sell|sales|market|growth|acquisition|retention)\b/i],
    ['operations', /\b(automate|routine|workflow|process|monitor|schedule|operate|pipeline)\b/i],
    ['creative', /\b(design|art|music|creative|visual|brand|illustrat|animate)\b/i],
    ['support', /\b(support|help|respond|resolve|service|onboard)\b/i],
    ['planning', /\b(plan|strategy|roadmap|scope|prioriti[sz]e|decide)\b/i]
  ];
  function domainOf(text) { const s = String(text || ''); const row = RULES.find(r => r[1].test(s)); return row ? row[0] : null; }
  function metricProgress(m) {
    if (!m || !Number.isFinite(Number(m.baseline)) || !Number.isFinite(Number(m.target)) || !Number.isFinite(Number(m.current))) return null;
    const span = Number(m.target) - Number(m.baseline); if (!span) return null;
    const pct = Math.max(0, Math.min(100, Math.round(((Number(m.current) - Number(m.baseline)) / span) * 100)));
    return { pct, reached: m.direction === 'atMost' ? Number(m.current) <= Number(m.target) : Number(m.current) >= Number(m.target) };
  }
  return { DOMAINS, DOMAIN_LABEL, domainOf, metricProgress };
});
