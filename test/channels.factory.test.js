'use strict';
// Constructor-level proof: actual host resolver expressions, shared hub, LineRunner and chain.
// The paid run/send edges are recorded. The routing plan is a fixed two-hop fixture;
// actual adapter normalization and live HTTP routing have their own acceptance matrix.
const fs = require('fs'), os = require('os'), path = require('path');
const A = require('./_assert.js');
const Factory = require('../sidecar/channels/factory.js');
const Bags = require('./helpers/channel-hub-bags.js');
const History = require('./helpers/channel-history.js');
const { makeChannelHub, dockSystem } = require('../sidecar/channels/hub.js');
const { makeChannelStore } = require('../sidecar/channels/store.js');
const { makeLineRunner } = require('../sidecar/routing/line-runner.js');
const { makeChainRunner } = require('../sidecar/routing/chain.js');
const RunWire = require('../sidecar/run-wire.js');

const source = fs.readFileSync(path.join(__dirname, '../sidecar/channels/hub.js'), 'utf8');
const consumed = [...new Set([...source.slice(source.indexOf('function makeChannelHub(opts)')).matchAll(/\bo\.([A-Za-z_$][\w$]*)/g)].map(m => m[1]))].sort();
A.eq(Object.keys(Factory.POLICY).sort(), consumed, 'every consumed hub option has an explicit capability policy');
for (const kind of Factory.KINDS) {
  const manifest = Factory.manifest(kind);
  A.ok(Object.values(manifest).every(row => row.mode === 'wired' || (row.mode === 'off' && row.reason)), kind + ': every opt-out has a reason');
}
A.throws(() => Factory.makeHubDeps('telegram', { futureOption: true }, {}), 'new unclassified common option is refused');
A.throws(() => Factory.makeHubDeps('telegram', { constructor: true }, {}), 'prototype names are not declared hub dependencies');
A.throws(() => Factory.makeHubDeps('discord', {}, { ownerSurface: true }), 'registry conversation cannot acquire local owner authority');
const adapterOptions = new Set();
for (const kind of ['adapter','telegram','discord','slack','matrix','signal']) {
  const text = fs.readFileSync(path.join(__dirname,'../sidecar/channels',kind + '.js'),'utf8');
  const name = kind === 'adapter' ? 'makeChannelAdapter' : 'make' + kind[0].toUpperCase() + kind.slice(1) + 'Adapter';
  const start = text.indexOf('  function ' + name + '('), end = text.indexOf('\n  }',start);
  A.ok(start >= 0 && end > start, kind + ': actual adapter constructor is located');
  for (const match of text.slice(start,end).matchAll(/\bo\.([A-Za-z_$][\w$]*)/g)) adapterOptions.add(match[1]);
}
A.eq(Object.keys(Factory.ADAPTER_POLICY).sort(), [...adapterOptions].sort(), 'every adapter option has an explicit capability decision');
A.throws(() => Factory.makeAdapterOpts('telegram',{futureOption:true}), 'new adapter option requires a manifest decision');
A.throws(() => Factory.makeAdapterOpts('signal',{token:'invented'}), 'Signal cannot silently accept a token credential');
A.throws(() => Factory.makeAdapterOpts('sample',{}), 'local sample cannot acquire an external adapter');

function host() {
  const agentRoster = new Map([
    ['agent', { name: 'NOVA', provider: 'custom', model: 'station-model', system: 'STATION-SYSTEM' }],
    ['writer', { name: 'Writer', provider: 'custom', model: 'writer-model', system: 'WRITER-SYSTEM' }],
    ['editor', { name: 'Editor', provider: 'openrouter', model: 'editor-model', system: 'EDITOR-SYSTEM' }],
    ['reviewer', { name: 'Reviewer', provider: 'custom', model: 'review-model', system: 'REVIEW-SYSTEM' }]
  ]);
  const snap = { agentId: 'writer', provider: 'custom', model: 'stale-connect-model', key: 'fixture-custom', system: 'STALE-CONNECT-SYSTEM' };
  const scope = {
    agentRoster, RunWire, codexTokens: null, CODEX_DEFAULT_MODEL: 'unused', ENV: () => '',
    normalizeProvider: p => String(p || 'openrouter'), normalizeProviderId: p => ['custom','openrouter'].includes(p) ? p : '',
    registryProviderUsesCodex: () => false, chatModelId: (_p,m) => m,
    resolveReasoningEffort: (_p,e) => e || 'default',
    providerRuntimeKey: (p,k) => k || 'fixture-' + p,
    providerRuntimeBaseUrl: p => 'http://fixture.invalid/' + p,
    providerHasCredential: () => true, providerHasStoredCredential: () => true,
    providerCredentialError: () => 'missing fixture credential', channelKeyLostError: () => 'fixture key lost'
  };
  const names = ['runWireEnv','runWireFor','channelRunConfigFor','stationHubRunConfig','devHubSecrets','sampleRunConfigFor'];
  const text = Bags.hostSource();
  const code = names.map(name => Bags.topLevel(text, name)).join('\n') + '\nreturn {' + names.join(',') + '};';
  Object.assign(scope, new Function(...Object.keys(scope), code)(...Object.values(scope)));
  scope.channelCredential = () => snap;
  scope.recOf = () => snap; scope.botId = 'fixture-bot';
  scope.hooks = { entryAllowed: () => true };
  return { scope, agentRoster, snap };
}
function resolve(props, names, scope) { return Bags.evaluate(props, names, scope); }
function pair(run) { return run ? [run.provider, run.model, run.system] : null; }

(async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-channel-factory-'));
  const opened = [];
  try {
    for (const kind of ['telegram','telegram-bot','discord','slack','matrix','signal']) {
      const store = makeChannelStore({fs,pathMod:path,root:path.join(temporary,kind,'mention'),clock:{now:()=>1}});
      const sends = [], runs = [];
      const cfg = {ok:true,configured:true,key:'fixture',model:'fixture',provider:'custom',agentId:'writer'};
      const hub = makeChannelHub(Factory.makeHubDeps(kind,{ history: History.make(store).history }, {
        channel:kind, store, runOnce:o=>runs.push(o), secrets:()=>cfg, isOwner:()=>true,
        resolveEntryRunConfig:()=>cfg,resolveRunConfig:()=>cfg,
        send:async (_chat,text)=>{sends.push(text);return {ok:true};},newId:()=>kind+'-mention',now:()=>1
      }));
      opened.push(hub);
      await hub.onInbound({channel:kind,chatId:'-100',chatType:'group',userId:'owner',text:'/mention@fixture off',messageId:'m1',ts:1});
      const available=kind === 'telegram' || kind === 'telegram-bot';
      A.eq(store.getChatRecord('-100')?.requireMention,available ? false : undefined,kind+': only a capable transport changes the durable mention gate');
      A.ok(sends.some(text=>available ? text.includes('answer every message') : text.includes('not available')),kind+': mention response matches transport capability');
      A.eq(runs.length,0,kind+': mention refusal/setting never buys a model run');
      hub.close();
    }
    for (const kind of Factory.KINDS) {
      for (const mode of ['entry','target-change','two-hop']) {
        const h = host(), bag = Bags.productionHubBag(kind);
        h.scope.id = kind;
        const liveValues = resolve(bag.props, ['resolveEntryRunConfig','resolveRunConfig'], h.scope);
        const calls = [], wire = [];
        let seq = 0;
        const runOnce = async o => {
          calls.push(o);
          o.emit('agent.run.start', { agentId:o.agentId, runId:o.runId });
          o.emit('agent.token', { agentId:o.agentId, runId:o.runId, delta:'Answer from ' + o.agentId });
          const end = { agentId:o.agentId, runId:o.runId, reason:'done', outcome:'succeeded', turns:1, usd:0 };
          o.emit('agent.run.end', end);
          return Object.assign({ text:'Answer from ' + o.agentId }, end);
        };
        const store = makeChannelStore({ fs, pathMod:path, root:path.join(temporary,kind,mode), clock:{now:()=>1} });
        const live = bag.factory ? Factory.makeHubDeps(kind, { history: History.make(store).history }, liveValues) : liveValues;
        const chain = makeChainRunner({ nextAgent:()=>null,
          stepAgent: id => mode !== 'two-hop' ? null : id === 'writer' ? {agentId:'editor'} : id === 'editor' ? {agentId:'reviewer'} : null });
        const lineRunner = makeLineRunner({ chain, runOnce, newId:()=>kind + '-' + (++seq), now:()=>1 });
        const routed = mode === 'target-change' ? 'editor' : 'writer';
        const entry = kind === 'telegram-bot' ? 'writer' : routed;
        Object.assign(h.scope, { router:{resolveDock:()=>({agentId:routed})}, admit:{resolveDock:()=>({agentId:routed})}, sampleLineScope:'fixture-line' });
        Object.assign(h.scope.hooks, {lineId:()=> 'fixture-line', onRouted:value=>value});
        const resolveAgent = resolve(bag.props, ['resolveAgent'], h.scope).resolveAgent;
        // The legacy bound-bot entry resolved through its secrets closure; preserve that real behavior
        // in the old-source control instead of falsely attributing its absent explicit hook as a bug.
        const secrets = kind === 'telegram-bot' ? resolve(bag.props,['secrets'],h.scope).secrets
          : () => Object.assign({configured:true}, h.snap);
        const hub = makeChannelHub(Object.assign({
          channel:kind, store, runOnce, lineRunner, secrets, classify:()=>true,
          resolveAgent, lineOriginFor:()=>mode === 'two-hop' ? 'fixture-line' : null,
          persona:'CHANNEL-PERSONA', newId:()=>kind + '-' + (++seq), now:()=>1,
          send:async (_chat,text)=>{wire.push(text); return {ok:true};}, textBatchWaitMs:0
        },live));
        opened.push(hub);
        await hub.onInbound({ channel:kind, chatId:'123', chatType:'dm', userId:'fixture-owner', text:'Write the requested answer', messageId:'m1', ts:1 });
        const expected = mode === 'two-hop' ? ['writer','editor','reviewer'] : [entry];
        A.eq(calls.map(o=>o.agentId), expected, kind + '/' + mode + ': exact entry and two downstream targets');
        for (let i=0;i<expected.length;i++) {
          const cfg=h.scope.channelRunConfigFor(expected[i]);
          A.eq(pair(calls[i]), [cfg.provider,cfg.model,i === 0 ? dockSystem(cfg.system,null,true) : cfg.system], kind + '/' + mode + ': target ' + expected[i] + ' owns runtime identity');
        }
        hub.close();
      }
    }
  } finally {
    for (const hub of opened) hub.close();
    fs.rmSync(temporary,{recursive:true,force:true});
  }
  A.report('channels.factory.test');
})().catch(error=>{console.error(error);process.exitCode=1;});
