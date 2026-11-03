'use strict';
// The host's real constructor dependencies, including its shared factory input. This is
// source extraction for fixtures, not an alternate production configuration resolver.
const fs = require('fs');
const Source = require('./source.js');
const Factory = require('../../sidecar/channels/factory.js');
const SPECS = {
  telegram: ['startTelegram', 'const hub = makeChannelHub(', '\n  });'],
  'telegram-bot': ['startTelegramBot', 'const hub = makeChannelHub(', '\n  });'],
  discord: ['startDiscord', 'hub: ', '\n    },\n    adapter:'],
  slack: ['startGenericChannel', 'hub: ', '\n    },\n    adapter:'],
  matrix: ['startGenericChannel', 'hub: ', '\n    },\n    adapter:'],
  signal: ['startGenericChannel', 'hub: ', '\n    },\n    adapter:'],
  dev: ['getDevHub', 'makeChannelHub(', '\n  });'],
  sample: ['getSampleHub', 'makeChannelHub(', '\n  });'],
  trigger: ['makeTriggerHub', 'makeChannelHub(', '\n  });'],
  handoff: ['makeTriggerHub', 'makeChannelHub(', '\n  });']
};
function hostSource() {
  return process.env.CHANNEL_FACTORY_CONTROL ? fs.readFileSync(process.env.CHANNEL_FACTORY_CONTROL, 'utf8') : Source.readSidecarIndex();
}
function topLevel(text, name) {
  const match = new RegExp('^(?:async )?function ' + name + '\\(', 'm').exec(text);
  if (!match) return '';
  const tail = text.slice(match.index), close = /\n\}/.exec(tail);
  return close ? tail.slice(0, close.index + 2) : '';
}
function productionHubBag(kind, source) {
  const spec = SPECS[kind];
  if (!spec) throw new Error('unknown production hub ' + kind);
  const text = source === undefined ? hostSource() : String(source), fn = topLevel(text, spec[0]);
  // Registry bags now end in `}),` because their common dependencies come from the factory.
  const factory = fn.includes('makeHubDeps(');
  const close = factory ? (spec[1] === 'hub: ' ? '\n    }),\n    adapter:' : '\n  }));') : spec[2];
  const region = Source.callRegion(fn, spec[1], close);
  if (!region) throw new Error('missing production constructor ' + kind);
  const merged = new Map();
  if (factory) {
    const common = Source.callRegion(topLevel(text, 'makeHubDeps'), 'channelHubFactory.makeHubDeps(kind, {', '\n  }, overrides)');
    if (!common) throw new Error('missing host factory common dependencies');
    const manifest = Factory.manifest(kind);
    for (const prop of Source.objectProps(common)) if (manifest[prop.key] && manifest[prop.key].mode === 'wired') merged.set(prop.key, prop);
  }
  for (const prop of Source.objectProps(region)) merged.set(prop.key, prop);
  return { props: [...merged.values()], factory, region, owner: spec[0] };
}
function productionAdapterBag(kind, source) {
  if (!['telegram', 'telegram-bot'].includes(kind)) throw new Error('no direct Telegram adapter constructor for ' + kind);
  const text = source === undefined ? hostSource() : String(source), owner = SPECS[kind][0];
  const fn = topLevel(text, owner), factory = fn.includes('makeAdapterOpts(');
  const region = Source.callRegion(fn, 'const adapter = makeTelegramAdapter(', factory ? '\n  }));' : '\n  });');
  if (!region) throw new Error('missing production adapter constructor ' + kind);
  return { props: Source.objectProps(region), factory, region, owner };
}
function evaluate(props, names, scope) {
  const result = {}, keys = Object.keys(scope || {});
  for (const name of names) {
    const prop = props.find(p => p.key === name);
    result[name] = prop ? new Function(...keys, 'return (' + prop.expr + ');')(...keys.map(k => scope[k])) : undefined;
  }
  return result;
}
module.exports = { productionHubBag, productionAdapterBag, evaluate, hostSource, topLevel };
