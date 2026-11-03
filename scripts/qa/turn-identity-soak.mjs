// Read-only release evidence. This script never changes modes or resets the ledger.
import { pathToFileURL } from 'node:url';
export function criteria(soak, release, includeReleases = []) {
  const checks = [], add = (name, pass, detail) => checks.push({ name, pass: !!pass, detail });
  add('ledger open', soak?.state === 'open', soak?.state || 'missing');
  // Version ordering cannot prove source ancestry. Additional buckets are an explicit owner assertion.
  const selected = new Set([release, ...includeReleases].filter(s => typeof s === 'string' && s.length > 0));
  const included = s => typeof s === 'string' && selected.has(s);
  const releases = (Array.isArray(soak?.releases) ? soak.releases : []).filter(r => included(r.app) && r.boots > 0);
  const first = releases.length ? Math.min(...releases.map(r => r.firstAt)) : NaN;
  const last = releases.length ? Math.max(...releases.map(r => r.lastAt)) : NaN;
  add('release boot span at least seven days', Number.isFinite(first) && Number.isFinite(last) && last - first >= 7 * 24 * 60 * 60 * 1000 && soak.resetAt <= first,
    `${releases.length} release buckets; ${Number.isFinite(last - first) ? last - first : 0} ms; reset ${soak?.resetAt ?? 'unknown'}`);
  const groups = Object.entries(soak?.agg || {}).filter(([app]) => included(app)).flatMap(([, entries]) => Object.entries(entries));
  const total = (pick) => groups.reduce((n, [, row]) => n + Number(pick(row) || 0), 0);
  const desk = groups.filter(([key]) => key === 'window.shadow.desk').reduce((n, [, row]) => n + Number(row.compared || 0), 0);
  add('at least 100 shadow desk comparisons', desk >= 100, desk);
  add('no unexplained divergence', total(r => r.byClass?.unexplained) === 0, total(r => r.byClass?.unexplained));
  add('no ordering divergence', total(r => r.byClass?.order) === 0, total(r => r.byClass?.order));
  add('no unexplained byte divergence', total(r => r.bytesBySub?.unexplained) === 0, total(r => r.bytesBySub?.unexplained));
  const depth = groups.reduce((n, [, row]) => Math.max(n, Number(row.fitBoundaryMaxDepth || 0)), 0);
  add('fit boundary depth at most five', depth <= 5, depth);
  add('no ledger write failures', soak?.writeFailures === 0, soak?.writeFailures ?? 'unknown');
  add('no unexplained degraded send', total(r => r.degraded?.unexplained) === 0, total(r => r.degraded?.unexplained));
  return checks;
}
export function parseArgs(argv) {
  const args = { includeReleases: [] };
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--base', '--release', '--include-release', '--token'].includes(argv[i]) || !argv[i + 1]) throw new Error('usage: --base <url> --release <app version> [--include-release <owner-vouched version>] [--token <API token>]');
    if (argv[i] === '--include-release') args.includeReleases.push(argv[i + 1]);
    else args[argv[i].slice(2)] = argv[i + 1];
  }
  if (!args.base || !args.release) throw new Error('--base and --release are required');
  args.includeReleases = [...new Set(args.includeReleases)].filter(value => value !== args.release);
  return args;
}
async function main(argv) {
  const args = parseArgs(argv);
  const token = args.token || process.env.STARNET_API_TOKEN || process.env.SKYNET_API_TOKEN || '';
  const response = await fetch(new URL('/api/turn-identity', args.base), { headers: token ? { 'X-StarNet-Token': token } : {}, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('turn identity GET returned HTTP ' + response.status);
  const checks = criteria((await response.json()).soak, args.release, args.includeReleases);
  console.log('Exact release selection: ' + JSON.stringify({ release: args.release, ownerDeclaredAdditionalReleases: args.includeReleases }));
  console.log('Release inclusion and commits 1-12 ancestry are owner assertions, not verified by this ledger. No later version is included automatically.');
  for (const check of checks) console.log(`${check.pass ? 'PASS' : 'FAIL'} ${check.name}: ${check.detail}`);
  console.log('This checks selected durable criterion 1 and degraded criterion 5 evidence only; nightly/property/browser and landed-commit evidence remain required. A passing report does not approve cutover.');
  if (checks.some(check => !check.pass)) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).catch(error => { console.error('FAIL soak evidence: ' + error.message); process.exitCode = 1; });
