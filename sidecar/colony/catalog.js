'use strict';

// Capability templates are shared; agent identities, notebooks and jobs are not.
const ROLES = Object.freeze({
  research: 'Recherche/Analyse', editorial: 'Redaktion', design: 'Gestaltung',
  product: 'Produkt/Katalog', web: 'Web/Affiliate', review: 'Qualitätsreview', fixer: 'Eskalations-Fixer'
});
const Processes = require('./processes.js');
const BRANDS = Object.freeze({
  lifestruct: { name: 'Lifestruct', facts: ['Der Guide kostet laut Nutzerangabe 59 EUR.'], focus: 'KI, Alltag, Struktur und Ziele' },
  ashveil: { name: 'Ashveil', facts: ['Digitale STL-Produkte sind keine physischen Drucke.'], focus: 'Dark Fantasy Cosplay; kuratierte eigene Assets' },
  homestackr: { name: 'HomeStackR', facts: ['Keine erfundenen Provisionen oder Conversion-Gewinner.'], focus: 'Verständliche Entscheidungshilfen und belegte Affiliate-Empfehlungen' }
});
const definitions = [
  ['L01', 'lifestruct', 'Pinterest', ['research', 'editorial', 'review'], ['sources', 'targets', 'boards', 'metrics'], ['provide', 'export', 'upload', 'publish']],
  ['L02a', 'lifestruct', 'Einstiegskurs', ['editorial', 'review'], ['mails_1_to_7', 'sequence', 'sources'], ['send']],
  ['L02b', 'lifestruct', 'Newsletter', ['research', 'editorial', 'review'], ['sources', 'audience', 'schedule'], ['send']],
  ['L03', 'lifestruct', 'Produktvorschläge', ['research', 'product', 'review'], ['demand_evidence'], []],
  ['A01', 'ashveil', 'Etsy-Entwurf', ['product', 'editorial', 'review'], ['product_record', 'print_evidence', 'price', 'license'], ['listing']],
  ['A02', 'ashveil', 'STL-Katalog', ['product', 'review'], ['file_inventory', 'print_evidence'], []],
  ['A03', 'ashveil', 'Social Content', ['design', 'editorial', 'review'], ['owned_assets', 'rights', 'channels'], ['publish']],
  ['A04', 'ashveil', 'Paketpflege', ['product', 'editorial', 'review'], ['product_record', 'dependencies'], ['listing']],
  ['H01', 'homestackr', 'Seiteninventar', ['web', 'review'], ['page_inventory'], []],
  ['H02', 'homestackr', 'Einnahmewege', ['research', 'web', 'review'], ['page_inventory', 'metrics'], ['deploy']],
  ['H03', 'homestackr', 'Pinterest', ['research', 'editorial', 'review'], ['sources', 'targets', 'boards'], ['provide', 'export', 'upload', 'publish']],
  ['H04', 'homestackr', 'Affiliate-Pflege', ['web', 'review'], ['affiliate_inventory'], ['deploy']],
  ['H05', 'homestackr', 'Seitenqualität', ['web', 'review'], ['change_package', 'page_inventory'], ['deploy']]
];
const PROCESSES = Object.freeze(Object.fromEntries(definitions.map(([id, businessUnitId, name, roles, prerequisites, actions]) => [id,
    Object.freeze({ id, businessUnitId, name, roles, prerequisites, actions, version: 3, criteriaVersion: 3,
    implemented: true, enabled: false, internalOnly: true, contractVersion: 3,
    goal: Processes.definition(id).goal, outputKind: Processes.definition(id).kind,
    inputs: Processes.definition(id).inputs, producerRole: Processes.definition(id).producer,
     qualityLoop: { producerRole: Processes.definition(id).producer, reviewerRole: 'review', fixerRole: 'fixer', maxRevisions: 3, noProgressLimit: 2, escalation: 'fixer_then_independent_review', independentReview: true },
     optionalRoles: ['fixer'],
    outputFields: Processes.definition(id).fields || null,
    steps: roles.map((role, i) => ({ role, label: Processes.labels[id][i], brief: Processes.roleBrief(id, role), hands: role === 'review' ? 'Geprüftes aktuelles Paket mit konkreten Befunden; manuelle Freigabe bleibt offen.' : role === 'research' ? 'Quellenbasiertes Faktenpaket mit Unsicherheiten und Datenlücken.' : 'Versioniertes Arbeitsergebnis für ' + name + '; keine Außenaktion.' })) })])));
const LEGACY = Object.freeze({ agent: 'lifestruct', life_content: 'lifestruct', life_review: 'lifestruct',
  hsr_research: 'homestackr', hsr_writer: 'homestackr', hsr_editor: 'homestackr',
  hsr_pin_analysis: 'homestackr', hsr_pin_content: 'homestackr', hsr_pin_review: 'homestackr',
  hsr_audit: 'homestackr', hsr_update: 'homestackr', hsr_quality: 'homestackr' });
function agentBrand(id) {
  if (Object.hasOwn(LEGACY, id)) return LEGACY[id];
  for (const brand of Object.keys(BRANDS)) if (id === 'colony_' + brand + '_owner' ||
    Object.keys(ROLES).some(role => id === 'colony_' + brand + '_' + role)) return brand;
  return null;
}
function agents() {
  return Object.keys(BRANDS).flatMap(businessUnitId => ['owner', ...Object.keys(ROLES)].map(role => ({
    id: 'colony_' + businessUnitId + '_' + role, businessUnitId, role, roleVersion: 3,
    purpose: role === 'owner' ? 'Markenverantwortung für ' + BRANDS[businessUnitId].name + '. Eigenständiger Koordinationspfad noch offen.' : BRANDS[businessUnitId].name + ': ' + ROLES[role] + '. Versionierte Fachaufträge, enges Quellenpaket, konkrete Ergebnisverträge und unabhängiger Review. Keine Selbstfreigabe oder Außenaktion.',
    name: BRANDS[businessUnitId].name + ' · ' + (ROLES[role] || 'Markenverantwortung')
  }))).concat([{ id: 'colony_coordinator', businessUnitId: null, role: 'lead', roleVersion: 1, name: 'Hauptorchestrator' },
    { id: 'colony_kvp', businessUnitId: null, role: 'kvp', roleVersion: 1, name: 'KVP' }]);
}
module.exports = { BRANDS, ROLES, PROCESSES, agentBrand, agents };
