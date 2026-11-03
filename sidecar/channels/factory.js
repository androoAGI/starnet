'use strict';
// Production hub dependency policy. Every option consumed by hub.js has one explicit row;
// adding an option requires deciding which entry surfaces can actually carry it.
const KINDS = Object.freeze(["telegram", "telegram-bot", "discord", "slack", "matrix", "signal", "dev", "sample", "trigger", "handoff"]);
const POLICY = Object.freeze({
  agentPrefix: { wired: ["dev", "sample", "trigger", "handoff"], off: "Conversation transports keep their existing shared fallback prefix." },
  albumWaitMs: { wired: [], off: "The hub owns this timing or delivery default; the host does not override it." },
  answerCallback: { wired: ["telegram", "telegram-bot"], off: "This transport does not carry the Telegram callback contract." },
  askConsent: { wired: ["telegram", "telegram-bot"], off: "This transport does not carry the Telegram approval keyboard contract." },
  bindChats: { wired: ["sample", "trigger", "handoff"], off: "Ordinary conversations keep the default binding; sample and trigger explicitly opt out." },
  briefFor: { wired: ["telegram", "telegram-bot", "dev"], off: "This hub does not offer a task clarification keyboard." },
  canReadAllGroupMessages: { wired: ["telegram", "telegram-bot"], off: "This transport has no proven Telegram group-visibility claim." },
  chain: { wired: [], off: "The host supplies its one LineRunner instead of creating a private executor." },
  channel: { wired: ["telegram", "telegram-bot", "discord", "slack", "matrix", "signal", "dev", "sample", "trigger", "handoff"], off: "This hub kind has no caller for this dependency." },
  chatAction: { wired: ["telegram", "telegram-bot", "discord", "slack", "matrix", "signal"], off: "This local or one-job surface has no typing transport." },
  classify: { wired: ["telegram", "telegram-bot", "discord", "slack", "matrix", "signal", "dev", "sample", "trigger", "handoff"], off: "This hub kind has no caller for this dependency." },
  clearTimeout: { wired: [], off: "The hub owns this timing or delivery default; the host does not override it." },
  consentOutcome: { wired: ["telegram", "telegram-bot"], off: "This transport does not carry the Telegram approval keyboard contract." },
  deleteMessage: { wired: ["telegram", "telegram-bot"], off: "This hub does not enable edit-in-place replies." },
  desktopCommand: { wired: ["telegram", "telegram-bot", "discord", "slack", "matrix", "signal", "dev"], off: "One-job sample/trigger inputs are not an owner command surface." },
  editMessage: { wired: ["telegram", "telegram-bot"], off: "This hub does not enable edit-in-place replies." },
  emit: { wired: ["telegram", "telegram-bot", "discord", "slack", "matrix", "signal", "dev", "sample", "trigger", "handoff"], off: "This hub kind has no caller for this dependency." },
  entryTaint: { wired: ["trigger", "handoff"], off: "Only payload-triggered and handed-off jobs carry this entry taint." },
  entryUntrusted: { wired: ["trigger", "handoff"], off: "Only handoff/trigger jobs inherit an explicit entry verdict." },
  expandAttachments: { wired: ["telegram", "telegram-bot", "dev"], off: "This transport has no supported attachment ingestion path." },
  fetchMedia: { wired: ["telegram", "telegram-bot", "dev"], off: "This transport has no supported media ingestion path." },
  getTag: { wired: ["telegram", "telegram-bot", "discord", "slack", "matrix", "signal", "dev", "sample", "trigger", "handoff"], off: "This hub kind has no caller for this dependency." },
  groundedFor: { wired: ["telegram", "telegram-bot", "dev"], off: "This hub does not offer a task clarification keyboard." },
  handoffReads: { wired: ["trigger", "handoff"], off: "Only handoff/trigger jobs import proved upstream files." },
  historyFor: { wired: ["telegram", "telegram-bot", "discord", "slack", "matrix", "signal", "dev", "sample", "trigger", "handoff"], off: "This hub kind has no caller for this dependency." },
  hostPathPrefixes: { wired: [], off: "The host supplies its shared scrubOutbound instead." },
  isOwner: { wired: ["telegram", "telegram-bot", "discord", "slack", "matrix", "signal"], off: "Only adapter-paired conversation channels expose owner commands." },
  jobEntry: { wired: ["sample", "trigger", "handoff"], off: "Ordinary channel jobs use the shared channel entry." },
  jobId: { wired: ["sample", "trigger", "handoff"], off: "Ordinary channel jobs allocate identity through LineRunner." },
  lineOriginFor: { wired: ["telegram", "telegram-bot", "discord", "slack", "matrix", "signal", "dev", "sample", "trigger", "handoff"], off: "This hub kind has no caller for this dependency." },
  lineRunner: { wired: ["telegram", "telegram-bot", "discord", "slack", "matrix", "signal", "dev", "sample", "trigger", "handoff"], off: "This hub kind has no caller for this dependency." },
  maxMessageLength: { wired: ["telegram", "telegram-bot", "discord", "slack", "matrix", "signal", "dev", "sample", "trigger", "handoff"], off: "This hub kind has no caller for this dependency." },
  modelCatalog: { wired: ["telegram", "discord", "slack", "matrix", "signal", "dev"], off: "Only station conversation hubs expose model selection." },
  newId: { wired: ["telegram", "telegram-bot", "discord", "slack", "matrix", "signal", "dev", "sample", "trigger", "handoff"], off: "This hub kind has no caller for this dependency." },
  now: { wired: ["telegram", "telegram-bot", "discord", "slack", "matrix", "signal", "dev", "sample", "trigger", "handoff"], off: "This hub kind has no caller for this dependency." },
  observeInto: { wired: ["telegram", "telegram-bot", "discord", "slack", "matrix", "signal", "dev", "sample", "trigger", "handoff"], off: "This hub kind has no caller for this dependency." },
  onJobSettled: { wired: ["sample", "trigger", "handoff"], off: "Only host-owned sample/trigger jobs publish this receipt." },
  onLineOutcome: { wired: ["sample", "trigger", "handoff"], off: "Only host-owned sample/trigger jobs consume this outcome callback." },
  onResolved: { wired: ["dev", "sample", "trigger", "handoff"], off: "Only dev/sample/trigger need a constructor-level resolution observer." },
  ownerSurface: { wired: ["dev", "sample"], off: "Only authenticated local dev and sample routes carry ambient owner authority." },
  ownerTrusted: { wired: ["telegram", "telegram-bot"], off: "Only Telegram adapters prove an owner DM; local sample/dev use ownerSurface." },
  persona: { wired: ["telegram", "telegram-bot", "discord", "slack", "matrix", "signal", "dev", "sample", "trigger", "handoff"], off: "This hub kind has no caller for this dependency." },
  prompts: { wired: ["telegram", "telegram-bot"], off: "This transport does not carry the Telegram prompt registry." },
  reactionAck: { wired: [], off: "The hub owns this timing or delivery default; the host does not override it." },
  recoverMs: { wired: [], off: "The hub owns this timing or delivery default; the host does not override it." },
  redact: { wired: ["telegram", "telegram-bot", "discord", "slack", "matrix", "signal", "dev", "sample", "trigger", "handoff"], off: "This hub kind has no caller for this dependency." },
  resolveAgent: { wired: ["telegram", "telegram-bot", "discord", "slack", "matrix", "signal", "dev", "sample", "trigger", "handoff"], off: "Resolution is supplied by the host routing policy." },
  resolveConsent: { wired: ["telegram", "telegram-bot"], off: "This transport does not carry the Telegram approval keyboard contract." },
  resolveEntryRunConfig: { wired: ["telegram", "telegram-bot", "discord", "slack", "matrix", "signal", "dev", "sample", "trigger", "handoff"], off: "This hub kind has no caller for this dependency." },
  resolveRunConfig: { wired: ["telegram", "telegram-bot", "discord", "slack", "matrix", "signal", "dev", "sample", "trigger", "handoff"], off: "This hub kind has no caller for this dependency." },
  resolveStation: { wired: ["telegram", "telegram-bot", "discord", "slack", "matrix", "signal", "dev", "sample", "trigger", "handoff"], off: "This hub kind has no caller for this dependency." },
  roster: { wired: ["telegram", "discord", "slack", "matrix", "signal", "dev"], off: "Bound bots retain their identity; one-job hubs do not expose roster commands." },
  runOnce: { wired: ["telegram", "telegram-bot", "discord", "slack", "matrix", "signal", "dev", "sample", "trigger", "handoff"], off: "This hub kind has no caller for this dependency." },
  runSlash: { wired: ["telegram", "telegram-bot", "discord", "slack", "matrix", "signal", "dev"], off: "One-job sample/trigger inputs are not an owner command surface." },
  saveAttachment: { wired: ["telegram", "telegram-bot", "dev"], off: "This transport does not normalize supported inbound attachment bytes." },
  scrubOutbound: { wired: ["telegram", "telegram-bot", "discord", "slack", "matrix", "signal", "dev", "trigger", "handoff"], off: "The sample captures local proof output; it has no external delivery transport." },
  secrets: { wired: ["telegram", "telegram-bot", "discord", "slack", "matrix", "signal", "dev", "sample", "trigger", "handoff"], off: "This hub kind has no caller for this dependency." },
  send: { wired: ["telegram", "telegram-bot", "discord", "slack", "matrix", "signal", "dev", "sample", "trigger", "handoff"], off: "This hub kind has no caller for this dependency." },
  senderWithheld: { wired: ["trigger", "handoff"], off: "Only handoff/trigger jobs inherit an explicit sender verdict." },
  setModel: { wired: ["telegram", "discord", "slack", "matrix", "signal", "dev"], off: "Bound bots and one-job hubs cannot change a conversation binding." },
  setReaction: { wired: ["telegram", "telegram-bot"], off: "This transport has no wired reaction acknowledgement." },
  setTimeout: { wired: [], off: "The hub owns this timing or delivery default; the host does not override it." },
  sleep: { wired: [], off: "The hub owns this timing or delivery default; the host does not override it." },
  stageBriefFor: { wired: ["telegram", "telegram-bot", "discord", "slack", "matrix", "signal", "dev", "sample", "trigger", "handoff"], off: "This hub kind has no caller for this dependency." },
  steerRun: { wired: ["telegram", "telegram-bot", "discord", "slack", "matrix", "signal"], off: "One-job and dev hubs retain their existing supersede behavior." },
  store: { wired: ["telegram", "telegram-bot", "discord", "slack", "matrix", "signal", "dev", "sample", "trigger", "handoff"], off: "This hub kind has no caller for this dependency." },
  streamId: { wired: ["sample", "trigger", "handoff"], off: "Ordinary channels derive their canonical conversation stream." },
  streamMinChars: { wired: [], off: "The hub owns this timing or delivery default; the host does not override it." },
  streamMinMs: { wired: [], off: "The hub owns this timing or delivery default; the host does not override it." },
  streamReplies: { wired: ["telegram", "telegram-bot"], off: "Only Telegram explicitly selects final-only delivery; other hubs keep the safe default." },
  supersedeBackoffMs: { wired: [], off: "The hub owns this timing or delivery default; the host does not override it." },
  supersedeRetries: { wired: [], off: "The hub owns this timing or delivery default; the host does not override it." },
  taskIntent: { wired: ["telegram", "telegram-bot", "dev"], off: "This hub does not offer a task clarification keyboard." },
  textBatchWaitMs: { wired: ["telegram", "telegram-bot", "dev", "sample", "trigger", "handoff"], off: "Registry channels keep the hub batching default." },
  transcribe: { wired: ["telegram", "telegram-bot"], off: "This transport has no supported voice download path." },
  typingRefreshMs: { wired: [], off: "The hub owns this timing or delivery default; the host does not override it." },
  untrustedSenders: { wired: ["trigger", "handoff"], off: "Only trigger and handoff have no chat sender; their explicit entry verdicts narrow authority." },
  userCommandNames: { wired: ["telegram", "telegram-bot", "discord", "slack", "matrix", "signal", "dev"], off: "One-job sample/trigger inputs are not an owner command surface." }
});
function manifest(kind) {
  if (!KINDS.includes(kind)) throw new Error('unknown channel hub kind: ' + kind);
  return Object.fromEntries(Object.entries(POLICY).map(([name, row]) => [name,
    row.wired.includes(kind) ? { mode: 'wired' } : { mode: 'off', reason: row.off }]));
}
// Common values are evaluated by the host at construction, after its stores and routing owners
// exist. Per-kind overrides retain closures over the real adapter, bot record or current job.
function makeHubDeps(kind, common, overrides) {
  const policy = manifest(kind), out = {};
  for (const [name, value] of Object.entries(common || {})) {
    if (!policy[name]) throw new Error('unclassified hub dependency: ' + name);
    if (policy[name].mode === 'wired') out[name] = value;
  }
  for (const [name, value] of Object.entries(overrides || {})) {
    if (!policy[name]) throw new Error('unclassified hub dependency: ' + name);
    if (policy[name].mode !== 'wired') throw new Error(kind + ' cannot wire ' + name + ': ' + policy[name].reason);
    out[name] = value;
  }
  if (typeof out.resolveEntryRunConfig !== 'function' || typeof out.resolveRunConfig !== 'function')
    throw new Error(kind + ' requires live entry and downstream configuration');
  return out;
}
module.exports = { KINDS, POLICY, manifest, makeHubDeps };
