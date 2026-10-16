'use strict';
/**
 * Two objectives, one station.
 * Hospital faculty own the D: hospital tree. The original StarNet crew owns platform repair.
 * A hospital agent must not carry platform-mechanical skills. A platform agent must not carry a hospital role.
 */

const HOSPITAL_ROOT = 'D:\\AML_University_Training_Hospital';
const HOSPITAL_SKILLS = HOSPITAL_ROOT + '\\starnet-role-skills';
const HOSPITAL_AGENTS = HOSPITAL_ROOT + '\\examples\\agents';

const PLATFORM_IDS = Object.freeze([
  'agent',
  'support',
  'strategist',
  'custom-governance-custodian',
  'custom-evidence-auditor'
]);

const PLATFORM_MECHANICAL = Object.freeze([
  'systematic-debugging',
  'test-driven-development',
  'simplify-code',
  'code-review',
  'adversarial-ux-test',
  'support-replies',
  'inbox-triage'
]);

const PLATFORM_SET = new Set(PLATFORM_IDS);
const MECHANICAL_SET = new Set(PLATFORM_MECHANICAL);

function objectiveFor(agentId) {
  return PLATFORM_SET.has(String(agentId || '')) ? 'platform' : 'hospital';
}

function hospitalSkillsFor(agentId) {
  return [String(agentId || '') + '-role', 'genome-activate'];
}

function conflicts(agent) {
  const id = String(agent && agent.id || '');
  const skills = Array.isArray(agent && agent.skills) ? agent.skills : [];
  const objective = agent && agent.objective ? agent.objective : objectiveFor(id);
  if (objective === 'hospital') return skills.some(s => MECHANICAL_SET.has(s));
  return skills.some(s => s === 'genome-activate' || /-role$/.test(String(s)));
}

module.exports = {
  HOSPITAL_ROOT,
  HOSPITAL_SKILLS,
  HOSPITAL_AGENTS,
  PLATFORM_IDS,
  PLATFORM_MECHANICAL,
  objectiveFor,
  hospitalSkillsFor,
  conflicts
};
