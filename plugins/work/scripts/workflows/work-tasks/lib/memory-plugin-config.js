/**
 * Tasks-side memory plugin config — re-exports the brief-side loader so the
 * cortex/mem0 detection and env-driven candidate overrides stay in one place.
 */

'use strict';

const { loadMemoryPluginCandidates } = require('../../work-brief/lib/memory-plugin-config');

module.exports = { loadMemoryPluginCandidates };
