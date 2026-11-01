/* node test/register-impact.test.js — every host tool DECLARES its impact; register() refuses one that does not
   (authority-census lane, spec step 2; 2026-10-30).

   THE GAP (a5-authority-declaration-census.json, A5-R1): registry.register() called makeTool, which kept an absent or
   unknown impact as-is, so an undeclared host tool registered and impactOfTool guessed its class from its name or
   capability. Eight such guesses fell to external-unknown before trunk declared them (#155: a granted routine could start
   a terminal but never read or stop it); the guessing itself stayed. On 748b0462595 an undeclared tool registers with
   impact null and an invented class ("harmless") registers verbatim.

   THE CONTRACT: a host registration names one of the finite classes in inputpolicy.js IMPACTS or does not register at
   all, with an error naming the tool. Every host tool a run registers declares the class the census snapshot holds
   (test/authority-census.test.js holds the matrix). That is the class impactOfTool gave it on 748b0462595, but for the
   four readers 0.14.2 moved to external-unknown (terminal.read, terminal.status, shell.bg.read, channel.targets), where
   Andrew's A5-Q2/Q3 ruling keeps them. `none` is a declaration, not an exemption. Connector registrations keep their
   translators' fail-closed contract (external-unknown). */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const { impactOfTool, IMPACTS } = require('../sidecar/inputpolicy.js');
const Catalog = require('../sidecar/tools/catalog.js');

(async () => {
  // ---- the refusal ----
  const reg = makeRegistry();
  const refused = (def) => { try { reg.register(def); return null; } catch (e) { return e; } };
  const missing = refused({ name: 'census.undeclared', capability: 'cabinet', scope: 'read', run: async () => '' });
  A.ok(missing && /census\.undeclared/.test(missing.message) && /declare its impact/.test(missing.message), 'a host tool with no impact cannot register, and the refusal names it: ' + (missing && missing.message));
  A.ok(!reg.get('census.undeclared'), '...and nothing was registered');
  const invalid = refused({ name: 'census.invalid', impact: 'harmless', scope: 'read', run: async () => '' });
  A.ok(invalid && /"harmless"/.test(invalid.message) && !reg.get('census.invalid'), 'an impact outside the finite classes is refused');
  A.ok(refused({ name: 'census.fn', impact: () => 'none', scope: 'read', run: async () => '' }) && !reg.get('census.fn'), 'an impact must be a declared class, not a function');
  A.ok(refused({ name: 'census.null', impact: null, scope: 'read', run: async () => '' }), 'a null impact is no declaration');
  A.ok(refused(null), 'no definition at all is refused, never registered as "undefined"');
  for (const cls of Object.keys(IMPACTS).map(k => IMPACTS[k])) {
    const t = reg.register({ name: 'census.' + cls, impact: cls, scope: 'read', run: async () => '' });
    A.eq(t.impact, cls, 'the declared class ' + cls + ' registers as declared');
  }
  A.eq(impactOfTool(reg.get('census.none')), IMPACTS.NONE, 'an explicit none is the effective class (a declaration, not a guess)');
  const conn = reg.register({ name: 'mcp__x__y', capability: 'mcp:x', scope: 'read', run: async () => '' }, { provenance: 'connector' });
  A.eq(conn.provenance, 'connector', 'a connector registration is not a host declaration');
  A.eq(impactOfTool(conn), IMPACTS.EXTERNAL_UNKNOWN, '...and an undeclared connector tool is external-unknown, never a guess in its favour');

  // ---- every host tool a run registers declares the census class: 748b0462595's, but for the one recorded move ----
  const catalog = Catalog.buildCatalog();
  const tools = catalog.list();
  A.ok(tools.length >= 140, 'the declared catalogue holds every host tool a run registers (' + tools.length + ')');
  const snapshot = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'authority-matrix.json'), 'utf8'));
  const history = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', snapshot.history), 'utf8'));
  const MOVED_READERS = ['channel.targets', 'shell.bg.read', 'terminal.read', 'terminal.status'];
  const classOf = (fx, name) => fx.decl[name].split(' ')[0];
  for (const t of tools) {
    A.ok(typeof t.impact === 'string' && Object.keys(IMPACTS).some(k => IMPACTS[k] === t.impact), t.name + ' declares a finite impact class (' + t.impact + ')');
    A.eq(impactOfTool(t), t.impact, t.name + ': the declaration is the effective class');
    if (snapshot.decl[t.name]) A.eq(t.impact, classOf(snapshot, t.name), t.name + ': the class the census snapshot holds');
    if (history.decl[t.name]) {
      A.eq(t.impact, MOVED_READERS.indexOf(t.name) >= 0 ? IMPACTS.EXTERNAL_UNKNOWN : classOf(history, t.name),
        t.name + (MOVED_READERS.indexOf(t.name) >= 0 ? ': external-unknown, 0.14.2\'s class (Andrew\'s A5-Q2/Q3 ruling)' : ': the class 748b0462595 gave it, unchanged'));
    }
  }
  A.eq(Object.keys(history.decl).filter(n => classOf(history, n) !== classOf(snapshot, n)).sort(), MOVED_READERS, 'the classes that moved since 748b0462595 are exactly the four readers');
  // the host-created group-turn closures declare theirs too (group-sessions.js)
  {
    const gs = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'group-sessions.js'), 'utf8');
    A.ok(/const def = \(name, description, properties, required, run\) => \(\{ name, description, capability: 'compute', impact: 'none',/.test(gs), 'a group turn\'s closures declare impact none');
  }
  // the alternate computer.use driver declares the same class
  const cua = makeRegistry();
  require('../sidecar/tools/builtin/cua-computer.js').makeCuaComputerTools({ allowPhysicalInput: false }).register(cua);
  A.eq(cua.get('computer.use').impact, catalog.get('computer.use').impact, 'the cua computer.use declares the same impact as the win32 one');

  A.report('register-impact.test');
})().catch(e => { console.error('FAIL: register-impact.test threw — ' + (e && e.stack || e)); process.exit(1); });
