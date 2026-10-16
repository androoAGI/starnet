#!/usr/bin/env node
/**
 * Convert AML University agent-registry JSON files into StarNet skill markdown
 * (sidecar/skills/catalog.js frontmatter + body).
 *
 * Usage:
 *   node scripts/convert-agent-json-to-skills.mjs
 *   node scripts/convert-agent-json-to-skills.mjs --in D:\AML_University_Training_Hospital\examples\agents --out D:\AML_University_Training_Hospital\starnet-role-skills
 *
 * Output stays on the hospital drive. The platform library may symlink those files so StarNet
 * can load them; the bytes live on D:. Use agent_id slugs in team.dispatch (e.g. dean-g1).
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
function argVal(flag, dflt) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt;
}

const IN_DIR = resolve(argVal('--in', 'D:\\AML_University_Training_Hospital\\examples\\agents'));
const OUT_DIR = resolve(argVal('--out', 'D:\\AML_University_Training_Hospital\\starnet-role-skills'));

const GENOME_SKILL = `---
name: Activate Capability Genome
slug: genome-activate
description: Run the capability-genome activation sequence for an AML University faculty agent. Use when prompted to activate genome or onboard a ward role.
category: AML University
requires: []
license: MIT
default: false
---

When asked to **activate genome** (or this skill is invoked):

1. **Identify** your \`agent_id\` slug and ward from your role skill (not the display name).
2. **State** your mission in one sentence from your system prompt.
3. **List** 3–5 capabilities you own (tools / scopes from registry) and 2 red lines you must not cross.
4. **Emit** a compact JSON object (for the lead/host) with keys:
   \`agent_id\`, \`title\`, \`ward\`, \`capabilities\`, \`red_lines\`, \`ready\` (boolean).
5. **Do not** delegate to yourself. If you are the lead, call \`team.dispatch\` with \`agentId\` set to the exact registry slug.

Keep output under one screen unless \`resultSchema\` requires strict JSON only.
`;

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function listJsonFiles(dir, acc = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) listJsonFiles(p, acc);
    else if (ent.isFile() && ent.name.endsWith('.json')) acc.push(p);
  }
  return acc;
}

function yamlScalar(s) {
  const t = String(s == null ? '' : s).replace(/\r?\n/g, ' ').trim();
  if (!t) return '""';
  if (/[:#\[\]{}|>&*!?,]/.test(t) || t.includes('"')) return JSON.stringify(t);
  return t;
}

function bulletList(items) {
  if (!items || !items.length) return '- (none listed)\n';
  return items.map(x => `- ${x}`).join('\n') + '\n';
}

function agentToSkill(json, relPath) {
  const id = String(json.agent_id || basename(relPath, '.json')).trim();
  const title = String(json.title || id).trim();
  const ward = dirname(relPath).split(/[/\\]/).pop() || 'unknown';
  const slug = slugify(`${id}-role`);

  const tools = Array.isArray(json.tools) ? json.tools : [];
  const toolLines = tools.map(t => {
    const caps = (t.capabilities || []).join(', ') || '—';
    const scopes = (t.scopes || []).join(', ') || '—';
    return `- **${t.name}** — capabilities: ${caps}; scopes: ${scopes}`;
  });

  const redLines = (json.guardrails && json.guardrails.red_lines) || [];
  const kpis = json.kpis || [];
  const overlays = json.reasoning_overlays || [];
  const autonomy = json.autonomy || {};

  const meta = [
    '---',
    `name: ${yamlScalar(`${title} (${id})`)}`,
    `slug: ${slug}`,
    `description: ${yamlScalar(`AML University faculty role for agent_id ${id}. Use when you are ${id} or when dispatch targets this ward agent.`)}`,
    'category: AML University',
    'requires: []',
    'license: MIT',
    'default: false',
    `agent_id: ${id}`,
    `ward: ${ward}`,
    '---',
    '',
  ].join('\n');

  const body = [
    `# ${title}`,
    '',
    `**Registry agent_id (use in team.dispatch):** \`${id}\``,
    `**Ward:** ${ward}`,
    `**Version:** ${json.version || '—'}`,
    '',
    '## System prompt',
    '',
    String(json.system_prompt || '(no system_prompt in registry JSON)'),
    '',
    '## Reasoning overlays',
    '',
    bulletList(overlays),
    '## Autonomy',
    '',
    `- Level: ${autonomy.level != null ? autonomy.level : '—'}`,
    `- ${autonomy.description || ''}`,
    '',
    '## Tools (registry intent)',
    '',
    toolLines.length ? toolLines.join('\n') : '- (none listed)',
    '',
    '## Guardrails — red lines',
    '',
    bulletList(redLines),
    '',
    '## KPIs',
    '',
    bulletList(kpis),
    '',
    '## Genome activation',
    '',
    'When the task is "Activate genome", follow the **genome-activate** skill and cite this role section.',
    '',
    '## Dispatch notes for leads',
    '',
    `- Use \`agentId: "${id}"\` (not display names with spaces).`,
    '- Pass `context` as a short handoff string; optional `resultSchema` only if you need strict JSON.',
    '',
  ].join('\n');

  return { slug, filename: `${slug}.md`, content: meta + body };
}

function main() {
  if (!existsSync(IN_DIR)) {
    console.error('Input directory not found:', IN_DIR);
    console.error('Pass --in <path-to-examples/agents>');
    process.exit(1);
  }
  mkdirSync(OUT_DIR, { recursive: true });

  const files = listJsonFiles(IN_DIR);
  if (!files.length) {
    console.error('No JSON files under', IN_DIR);
    process.exit(1);
  }

  const index = [];
  for (const file of files.sort()) {
    let json;
    try {
      json = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      console.warn('Skip (invalid JSON):', file, e.message);
      continue;
    }
    const rel = relative(IN_DIR, file);
    const skill = agentToSkill(json, rel);
    const outPath = join(OUT_DIR, skill.filename);
    writeFileSync(outPath, skill.content, 'utf8');
    index.push({ agent_id: json.agent_id, slug: skill.slug, file: skill.filename, ward: dirname(rel) });
    console.log('Wrote', outPath);
  }

  writeFileSync(join(OUT_DIR, 'genome-activate.md'), GENOME_SKILL, 'utf8');
  console.log('Wrote', join(OUT_DIR, 'genome-activate.md'));

  const indexPath = join(dirname(OUT_DIR), 'STARNET_ROLE_SKILLS.md');
  mkdirSync(dirname(indexPath), { recursive: true });
  writeFileSync(
    indexPath,
    [
      '# AML University agent skills (generated)',
      '',
      'Generated from agent-registry JSON. **team.dispatch** must use `agent_id` slugs below.',
      '',
      '| agent_id | skill slug | ward |',
      '| --- | --- | --- |',
      ...index.map(r => `| \`${r.agent_id}\` | \`${r.slug}\` | ${r.ward} |`),
      '',
      'Shared skill slug: `genome-activate`.',
      '',
      'Regenerate: `node scripts/convert-agent-json-to-skills.mjs`',
      '',
    ].join('\n'),
    'utf8'
  );
  console.log('Wrote', indexPath);
  console.log('Done:', index.length, 'role skills + genome-activate');
}

main();
