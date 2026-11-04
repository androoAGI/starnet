/* frontend/app/usertext.js — the ONE flattener of a message's text parts (turn-identity, commit 4).

   A user message's content is a string, or (an attachment turn, a screen capture, a provider-shaped history) an array
   of parts. Seven functions across the sidecar each joined those parts their own way, and an attachment turn read
   differently in each: the run title, the transcript row, the task brief and the study pass could each name a
   different message (bug-sweep P0, e7dcb889). Every copy now delegates here and names its POLICY, so a reader's bytes
   are a choice made in one place, and a new copy is caught by test/user-text.census.test.js.

   No policy changes any caller's bytes: each is the exact join its copy used (the content rung of directive reuse and
   markRecorded's identity must still match rows already on disk).

     flatten(content, policy)        string content as is; an array joined by the policy; any other shape is the
                                     policy's `other` (null for DIRECTIVE: "not a turn we can read, keep walking")
     latest(messages, policy)        the newest user message's text ('' when none can be read)
     recent(messages, n, policy)     the newest n user messages' texts, newest first

     DIRECTIVE  string parts + `.text` parts, joined ''   index.js userMsgText / latestUserText / recentUserTexts,
                                                          earlier-conversation userText, attachments textOf
     STORED     `.text` parts, '' for any other part,     transcriptstore flattenContent (BYTE-FROZEN: markRecorded and
                joined ' '                                taintOf compare against rows it wrote), tasteref contentText
     OBSERVER   STORED with the empty parts dropped       observer lastUserText (the watch feed's prompt line)
     LEARNING   `type: 'text'` parts only, joined '\n'    trusted-learning textOf
     OPENAI     bounded OpenAI typed parts, joined '\n'   openai-compat normalizeContent (its depth guard stays there)
     LABELLED   compaction text with image counts         compaction-fidelity userText; screen captures stay excluded

   Pure, zero-dep, UMD: the sidecar require()s it; a page may load the same file. */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./turnkinds.js'));
  else { root.UserText = factory(root.TurnKinds); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (TurnKinds) {
  'use strict';

  /* A policy is data: strings (a bare string part counts), typedOnly (only `type: 'text'` parts), blanks (any other part
     joins as ''), dropEmpty (empty texts are dropped before the join), sep, other (the value for a non-string,
     non-array content). */
  function policy(name, o) { return Object.freeze(Object.assign({ name, strings: false, typedOnly: false, blanks: false, dropEmpty: false, sep: '', other: '' }, o)); }
  const DIRECTIVE = policy('DIRECTIVE', { strings: true, sep: '', other: null });
  const STORED = policy('STORED', { blanks: true, sep: ' ' });
  const OBSERVER = policy('OBSERVER', { blanks: true, dropEmpty: true, sep: ' ' });
  const LEARNING = policy('LEARNING', { typedOnly: true, sep: '\n' });
  const OPENAI = policy('OPENAI', { mode: 'openai' });
  const LABELLED = policy('LABELLED', { mode: 'labelled' });
  const POLICIES = Object.freeze({ DIRECTIVE, STORED, OBSERVER, LEARNING, OPENAI, LABELLED });

  // Byte-frozen OpenAI normalization: unlike DIRECTIVE, typed scalar text is stringified and bare empty strings
  // are skipped. The public adapter keeps its depth guard; this policy owns the part cap and the join.
  function openai(content) {
    if (content == null) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const parts = [];
      for (const item of content.slice(0, 1000)) {
        if (typeof item === 'string') { if (item) parts.push(item); continue; }
        if (item && typeof item === 'object') {
          const t = String(item.type || '').trim().toLowerCase();
          if (t === 'text' || t === 'input_text' || t === 'output_text') { if (item.text != null) parts.push(String(item.text)); }
        }
      }
      return parts.join('\n');
    }
    try { return String(content); } catch (_) { return ''; }   // the adapter's existing fail-closed coercion
  }

  // Byte-frozen compaction wording: images are counted only beside real text, never carried as bytes. The first
  // screen-capture part proves that these are tool pixels, not the user's own words to preserve in a fold.
  function labelled(content) {
    if (typeof content === 'string') return content.trim() ? content : '';
    if (!Array.isArray(content)) return '';
    const texts = [];
    let images = 0;
    for (const p of content) {
      if (typeof p === 'string') { if (p.trim()) texts.push(p); continue; }
      if (!p || typeof p !== 'object') continue;
      const type = String(p.type || '');
      if (typeof p.text === 'string' && (!type || /text/.test(type))) texts.push(p.text);
      else if (/image/.test(type)) images++;
    }
    if (texts.length && TurnKinds.classify({ role: 'user', content: texts[0] }).kind === 'capture') return '';
    const t = texts.join('\n');
    if (!t.trim()) return '';
    return images ? t + '\n[' + images + ' image' + (images === 1 ? '' : 's') + ' attached - not carried]' : t;
  }

  function flatten(content, pol) {
    const p = pol || DIRECTIVE;
    if (p.mode === 'openai') return openai(content);
    if (p.mode === 'labelled') return labelled(content);
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return p.other;
    const out = [];
    for (const part of content) {
      let t = null;
      if (typeof part === 'string') { if (p.strings) t = part; }
      else if (part && typeof part.text === 'string' && (!p.typedOnly || part.type === 'text')) t = part.text;
      if (t === null) { if (p.blanks) out.push(''); continue; }
      out.push(t);
    }
    return (p.dropEmpty ? out.filter(Boolean) : out).join(p.sep);
  }

  // the text of one message when it is a user turn this policy can read; null otherwise
  function userTurnText(m, pol) {
    if (!m || m.role !== 'user') return null;
    return flatten(m.content, pol);
  }

  function latest(messages, pol) {
    const msgs = Array.isArray(messages) ? messages : [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const t = userTurnText(msgs[i], pol);
      if (t != null) return t;
    }
    return '';
  }

  function recent(messages, n, pol) {
    const msgs = Array.isArray(messages) ? messages : [];
    const out = [];
    for (let i = msgs.length - 1; i >= 0 && out.length < n; i--) {
      const t = userTurnText(msgs[i], pol);
      if (t != null) out.push(t);
    }
    return out;
  }

  return { DIRECTIVE, STORED, OBSERVER, LEARNING, OPENAI, LABELLED, POLICIES, flatten, latest, recent };
});
