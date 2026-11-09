/*
 * hidden-prompt.mjs — read one secret line from the terminal with echo off.
 *
 * Used for the updater key passphrase (scripts/updater-key-passphrase.mjs, release-cut.mjs,
 * update-canary.mjs). The value is returned to the caller only: it is never echoed, logged or
 * written anywhere. Needs an interactive terminal; callers decide what to do without one.
 */

export function canPromptHidden(input = process.stdin) {
  return !!(input && input.isTTY && typeof input.setRawMode === 'function');
}

export function promptHidden(question, { input = process.stdin, output = process.stderr } = {}) {
  return new Promise((resolvePrompt, rejectPrompt) => {
    if (!canPromptHidden(input)) {
      rejectPrompt(new Error('a passphrase prompt needs an interactive terminal'));
      return;
    }
    output.write(question);
    const wasRaw = input.isRaw;
    let chars = [];
    const finish = (err) => {
      input.removeListener('data', onData);
      input.setRawMode(!!wasRaw);
      input.pause();
      output.write('\n');
      const value = chars.join('');
      chars = [];
      if (err) rejectPrompt(err); else resolvePrompt(value);
    };
    function onData(chunk) {
      for (const ch of Array.from(String(chunk))) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') { finish(); return; }
        if (ch === '\u0003') { finish(new Error('cancelled')); return; }
        if (ch === '\u0008' || ch === '\u007f') { chars.pop(); continue; }
        if (ch < ' ') continue;
        chars.push(ch);
      }
    }
    input.setEncoding('utf8');
    input.setRawMode(true);
    input.on('data', onData);
    input.resume();
  });
}
