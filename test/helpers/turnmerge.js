'use strict';
// Existing byte/content regression fixtures keep exercising the frozen legacy mode after its shared-owner move.
const TurnMerge = require('../../frontend/app/turnmerge.js');
function source(name) { return TurnMerge.legacyMerge.toString().replace('function legacyMerge', 'function ' + (name || 'mergeCanonicalHistory')); }
module.exports = { TurnMerge, legacyMerge: TurnMerge.legacyMerge, source };
