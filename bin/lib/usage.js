/* bin/lib/usage.js — the terminal's /usage: every provider this station is connected to, and how much of it is left, as
   the provider itself last said it. Nothing is estimated:
     a subscription (Claude Code, ChatGPT)   each sign-in's windows from its last run — "5-hour 88% left · resets 4:00 PM",
                                             with when that was seen; a sign-in no run has used yet: unknown
     a subscription that says nothing       Grok, Kimi: signed in, and that they do not say — never a made-up meter
     a sign-in that hit its limit           the station cools it (the next sign-in takes the runs): until when
     an API key                             its rate-limit buckets from its last response (per-minute meters, not a
                                            balance); none yet: unknown
     StarNet credits                        the linked balance
     Ollama                                 runs on this computer: no limit
   and, last, what the station's ledger says was spent (the old /usage line).

   usageLines({ providers, facts, usage, accounts, budget, now }) -> [string]
     providers  connect.ordered() rows; facts: the dashboard's connectFacts(); status: connect.status
     usage      GET /api/usage/providers  { subscriptions, rate }
     accounts   { <providerId>: [{ account, label, connected|loggedIn, coolingUntil }] }  (GET /api/auth/<id>/accounts)
     budget     GET /api/budget/status (or null) */
'use strict';

const connect = require('./connect.js');
const SAYS_NOTHING = { grok: 'Grok', kimi: 'Kimi' };

function clockAt(ms, now) {
  const d = new Date(ms), t = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const days = Math.floor((new Date(ms).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86400000);
  return days === 0 ? t : days === 1 ? 'tomorrow ' + t : d.toLocaleDateString('en-US', { weekday: 'short' }) + ' ' + t;
}
function ago(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return m + ' min ago';
  const h = Math.round(m / 60);
  return h < 48 ? h + ' h ago' : Math.round(h / 24) + ' days ago';
}
const usd = n => '$' + (Number(n) || 0).toFixed(2);
const big = n => n >= 10000 ? Math.round(n / 1000) + 'k' : String(Math.round(n));

// one window: what is left of it, and when it resets
function windowText(w, now) {
  if (w.resetsAt != null && w.resetsAt <= now) return w.label + ' reset since';
  const left = w.usedPct == null ? null : Math.max(0, Math.round(100 - w.usedPct));
  const what = w.status === 'rejected' ? 'spent' : left == null ? (w.status || 'in use') : left + '% left';
  return w.label + ' ' + what + (w.resetsAt != null ? ' · resets ' + clockAt(w.resetsAt, now) : '');
}
function accountLine(label, entry, coolingUntil, now) {
  const head = '  ' + label + '  ';
  if (coolingUntil && coolingUntil > now) return head + 'hit its limit — the next sign-in takes the runs until ' + clockAt(coolingUntil, now);
  if (!entry) return head + 'unknown — no run on it yet';
  const parts = entry.windows.map(w => windowText(w, now));
  if (entry.credits && entry.credits.unlimited) parts.push('credits unlimited');
  else if (entry.credits && entry.credits.balance != null) parts.push('credits ' + big(entry.credits.balance));
  return head + parts.join('   ') + '   (as of ' + ago(now - entry.seenAt) + ')';
}

function usageLines(o) {
  const now = o.now, facts = o.facts || {}, subs = (o.usage && o.usage.subscriptions) || {}, rate = (o.usage && o.usage.rate) || [];
  const out = [];
  const on = (o.providers || connect.ordered()).filter(p => connect.status(p, facts)[1] === 'ok');
  if (!on.length) return ['No provider is connected yet — /connect adds one.'];
  for (const p of on) {
    const flow = connect.flowOf(p.id);
    if (flow === 'credits') { out.push(p.name + ' · ' + (facts.credits && typeof facts.credits.balanceUsd === 'number' ? usd(facts.credits.balanceUsd) + ' left' : 'linked — balance unknown right now')); continue; }
    if (flow === 'local') { out.push(p.name + ' · runs on this computer — no limit'); continue; }
    if (flow === 'device' || flow === 'claude') {
      const accts = (o.accounts && o.accounts[p.id]) || [{ account: '', label: 'account 1' }];
      const live = accts.filter(a => a.connected !== false && a.loggedIn !== false);
      out.push(p.name + ' · ' + live.length + ' sign-in' + (live.length === 1 ? '' : 's') + (SAYS_NOTHING[p.id] ? ' — ' + SAYS_NOTHING[p.id] + ' does not say how much is left' : ''));
      for (const a of accts) {
        if (a.connected === false || a.loggedIn === false) { out.push('  ' + (a.label || 'account') + '  signed out'); continue; }
        if (SAYS_NOTHING[p.id]) { if (a.coolingUntil > now) out.push(accountLine(a.label, null, a.coolingUntil, now)); continue; }
        out.push(accountLine(a.label || 'account', (subs[p.id] || {})[a.account || 'primary'] || null, a.coolingUntil, now));
      }
      continue;
    }
    const r = rate.find(x => x && x.provider === p.id);
    const bits = r ? Object.keys(r.buckets || {}).map(k => { const b = r.buckets[k]; return b.remaining == null ? null : k + ' ' + big(b.remaining) + (b.limit ? ' of ' + big(b.limit) : '') + ' left'; }).filter(Boolean) : [];
    out.push(p.name + ' · ' + (flow === 'custom' ? 'endpoint saved' : 'key saved') + ' — ' + (bits.length ? bits.join(' · ') + ' this window (as of ' + ago(r.ageMs || 0) + ')' : 'unknown until a call says (its rate limits, not a balance)'));
  }
  const b = o.budget;
  if (b && typeof b.spentToday === 'number') out.push('Spent today ' + usd(b.spentToday) + (typeof b.lifetime === 'number' ? ' · all time ' + usd(b.lifetime) : '') + ' — the station ledger (subscriptions not in dollars)');
  return out;
}

module.exports = { usageLines, windowText, clockAt, ago };
