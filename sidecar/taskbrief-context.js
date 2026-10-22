'use strict';
// Model-written working understanding, anchored to the user's actual words. Never global memory.
const DIMENSIONS = new Set(['objective','audience','deliverable','scope','constraints','sources','acceptance','safety']);
const clip = (x,n) => String(x == null ? '' : x).trim().slice(0,n);
const texts = (x,n) => (Array.isArray(x) ? x : []).map(v=>clip(v,400)).filter(Boolean).slice(0,n);
const delegate = s => /^\s*(?:use your judgment(?: for the rest)?|just do it|you decide)[.!\s]*$/i.test(String(s || '')) || /\nUse your judgment for the remaining choices\.$/.test(String(s || ''));
// The label an unanchored item carries once it is demoted out of `facts` (see validate).
const UNCONFIRMED = 'Unconfirmed (no matching quote): ';
function latestAnswer(brief) {
  return (brief.questions || []).filter(q=>q.answer).slice(-1)[0] || null;
}
function normalize(value) {
  const v=value || {};
  return { revision:Math.max(0,Number(v.revision)||0), through:clip(v.through,100),
    facts:(Array.isArray(v.facts)?v.facts:[]).filter(f=>f && DIMENSIONS.has(f.dimension))
      .slice(0,12).map(f=>({dimension:f.dimension,text:clip(f.text,400),quote:clip(f.quote,600),sourceId:clip(f.sourceId,100)})),
    assumptions:texts(v.assumptions,12), unknowns:texts(v.unknowns,6), nextStep:clip(v.nextStep,500) };
}
/* QUOTE ANCHORING (2026-10-12, user report: "Agent OS repeatedly blocked authorized actions with brief_update
   quote/source validation errors"). A fact's quote had to be a byte-exact, case-sensitive substring of ONE named
   source, and a single miss rejected the WHOLE snapshot. Models re-type quotes — a curly apostrophe, a capital, a
   collapsed line break, a dropped period, an elided middle, the right words under the wrong sourceId — so the update
   failed again and again; proceed() refuses until a conversational answer is incorporated, and canMutate blocks
   every write until proceed. One paraphrase therefore locked a run out of the action the Commander had just
   authorized, and the only way out was the Commander retyping their own words.
   The evidence rule is unchanged — a fact still needs the user's actual words — but the match is now on meaning-
   preserving folds only (unicode compatibility form, quote/dash glyphs, whitespace, case, edge punctuation, "..."
   between in-order fragments, each >= 3 chars), any source that holds the words is accepted (sourceId corrected),
   and an item with no anchor is DEMOTED to a labelled assumption instead of failing the update. A guess is never
   stored as the user's words; it is also never a reason to stop the run. */
const fold = s => String(s == null ? '' : s).normalize('NFKC')
  .replace(/[‘’‚‛′´`]/g, "'")
  .replace(/[“”„‟″«»]/g, '"')
  .replace(/[‐-―−]/g, '-')
  .replace(/\s+/g, ' ').trim().toLowerCase();
const trimEdges = s => s.replace(/^[\s"'.,;:!?()[\]{}*-]+|[\s"'.,;:!?()[\]{}*-]+$/g, '');
function anchored(quote, source) {
  const parts = fold(quote).split(/\s*\.{3,}\s*/).map(trimEdges).filter(Boolean);
  if (!parts.length || parts.some(p => p.length < 3)) return false;
  const src = fold(source);
  let at = 0;
  for (const p of parts) { const i = src.indexOf(p, at); if (i < 0) return false; at = i + p.length; }
  return true;
}
function validate(value,brief) {
  const v=normalize(value), latest=latestAnswer(brief);
  const expected=latest ? latest.id : 'request';
  if(v.through!==expected) return {ok:false,error:'Read the entire latest answer and set through to '+expected};
  const sources=new Map([['request',brief.originalDirective || '']]);
  for(const q of brief.questions || []) if(q.answer) sources.set(q.id,q.answer);
  const facts=[], demoted=[];
  for(const f of v.facts) {
    const text=f.text || f.quote;
    if(!text) continue;
    let sourceId=sources.has(f.sourceId) && anchored(f.quote,sources.get(f.sourceId)) ? f.sourceId : '';
    if(!sourceId) for(const [id,src] of sources) if(anchored(f.quote,src)) { sourceId=id; break; }
    if(sourceId) facts.push(Object.assign({},f,{text,sourceId}));
    else demoted.push(clip(UNCONFIRMED+text,400));
  }
  if(!v.nextStep) return {ok:false,error:'Name the next useful action, including a draft when feedback would resolve the uncertainty.'};
  v.facts=facts;
  v.assumptions=v.assumptions.filter(a=>demoted.indexOf(a)<0).slice(0,Math.max(0,12-demoted.length)).concat(demoted);
  v.revision=(Number(brief.context && brief.context.revision)||0)+1;
  return {ok:true,context:v,demoted};
}
function current(brief) {
  const last=latestAnswer(brief);
  return !!brief.context && brief.context.through===(last ? last.id : 'request');
}
/* WHAT THE COMMANDER ALREADY ANSWERED (review 10-14), for crew seated mid-task with station.control group.add: the kickoff
   turn in the group used to re-ask "What are we launching?" seconds after it was answered. Each answered question with the
   Commander's own answer, in order, on one line — '' when nothing was answered. Bounded: a long answer is clipped (its
   start is what tells the lead not to ask), and the whole line never passes `max`. */
function answeredSoFar(brief, max = 600) {
  const one = (x, n) => { const t = String(x == null ? '' : x).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
  const rows = ((brief && brief.questions) || []).filter(q => q && q.text && String(q.answer || '').trim())
    .map(q => one(q.text, 120) + ' → ' + one(q.answer, 200));
  let out = '';
  for (const r of rows) { const next = out ? out + '; ' + r : r; if (next.length > max) break; out = next; }
  return out;
}
module.exports={normalize,validate,latestAnswer,current,delegate,anchored,UNCONFIRMED,answeredSoFar};
