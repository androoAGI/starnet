/* node test/hospital-platform-split.test.js
   The hospital faculty and the StarNet platform crew have separate objectives.
   Fixture checks always run. When the D: hospital tree and the local station save
   are present, the same rules are checked against those files. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const B = require('../scripts/hospital-platform-boundary.js');
const catalog = require('../sidecar/skills/catalog.js');

{
  A.eq(B.objectiveFor('agent'), 'platform', 'IMHOTEP is platform');
  A.eq(B.objectiveFor('strategist'), 'platform', 'THE MECHANIC is platform');
  A.eq(B.objectiveFor('dean-g1'), 'hospital', 'DEAN G1 is hospital');
  A.eq(B.hospitalSkillsFor('dean-g1').join(','), 'dean-g1-role,genome-activate', 'hospital skills are the role plus genome activation');
  A.eq(B.conflicts({ id: 'engineer-c2', skills: ['systematic-debugging', 'engineer-c2-role'] }), true, 'a hospital agent with a platform repair skill conflicts');
  A.eq(B.conflicts({ id: 'engineer-c2', skills: B.hospitalSkillsFor('engineer-c2') }), false, 'a hospital agent on its role skill does not conflict');
  A.eq(B.conflicts({ id: 'support', skills: ['support-replies', 'inbox-triage'] }), false, 'platform support skills stay with the platform crew');
  A.eq(B.conflicts({ id: 'agent', skills: ['dean-g1-role'] }), true, 'a platform agent must not carry a hospital role');
}

const hospitalJson = B.HOSPITAL_AGENTS;
const skillDir = B.HOSPITAL_SKILLS;
if (!fs.existsSync(hospitalJson) || !fs.existsSync(skillDir)) {
  A.report('hospital-platform-split.test');
}

function listJson(dir, acc) {
  acc = acc || [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) listJson(p, acc);
    else if (ent.isFile() && ent.name.endsWith('.json')) acc.push(p);
  }
  return acc;
}

const ids = [];
for (const file of listJson(hospitalJson)) {
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  const id = String(json.agent_id || path.basename(file, '.json'));
  ids.push(id);
  A.eq(B.objectiveFor(id), 'hospital', id + ' from the hospital tree is a hospital objective');
  A.eq(B.conflicts({ id: id, skills: B.hospitalSkillsFor(id) }), false, id + ' role assignment does not conflict');
}
A.eq(ids.length, 12, 'the hospital example tree has the twelve faculty profiles');
for (const id of B.PLATFORM_IDS) A.ok(ids.indexOf(id) < 0, id + ' is not a hospital faculty profile');

const skills = catalog.loadDir(skillDir, fs, path);
const by = {};
for (const s of skills) by[s.slug] = s;
A.ok(by['genome-activate'], 'genome-activate lives with the hospital skills');
A.eq(by['genome-activate'].default, false, 'genome-activate is off until an agent is granted it');
for (const id of ids) {
  const slug = id + '-role';
  A.ok(by[slug], slug + ' was generated on D:');
  A.eq(by[slug].default, false, slug + ' is not a station-wide default');
  A.ok(by[slug].body.indexOf(id) >= 0, slug + ' names its agent_id');
}

const lib = path.join(__dirname, '..', 'sidecar', 'skills', 'library');
for (const id of ids.concat(['genome-activate'])) {
  const name = (id === 'genome-activate' ? id : id + '-role') + '.md';
  const link = path.join(lib, name);
  A.ok(fs.existsSync(link), name + ' is visible to the platform skill loader');
  const stat = fs.lstatSync(link);
  A.ok(stat.isSymbolicLink(), name + ' is a link, the bytes stay on D:');
  const target = fs.readlinkSync(link);
  A.ok(target.indexOf(skillDir) >= 0, name + ' points at the hospital skill folder');
}

const savePath = path.join(process.env.LOCALAPPDATA || '', 'StarNet', 'workspaces', 'agent.save.json');
if (fs.existsSync(savePath)) {
  const save = JSON.parse(fs.readFileSync(savePath, 'utf8'));
  const agents = (save.doc && save.doc.agents) || [];
  for (const a of agents) {
    A.eq(B.conflicts(a), false, a.id + ' live skills match its objective');
    if (B.objectiveFor(a.id) === 'hospital') {
      A.eq((a.skills || []).join(','), B.hospitalSkillsFor(a.id).join(','), a.id + ' carries only its hospital skills');
      A.ok(String(a.docs && a.docs.context || '').indexOf(B.HOSPITAL_ROOT) >= 0, a.id + ' context points at the hospital drive');
    }
  }
}

const projectsPath = path.join(process.env.LOCALAPPDATA || '', 'StarNet', 'workspaces', 'projects.json');
if (fs.existsSync(projectsPath)) {
  const projects = JSON.parse(fs.readFileSync(projectsPath, 'utf8'));
  const roots = (projects.projects || []).map(p => p.root);
  A.ok(roots.indexOf(B.HOSPITAL_ROOT) >= 0, 'the hospital drive is an approved project folder');
}

A.report('hospital-platform-split.test');
