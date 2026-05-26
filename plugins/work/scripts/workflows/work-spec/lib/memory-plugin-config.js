/**
 * Spec-side memory plugin config — re-exports the brief-side loader so the
 * cortex/mem0 detection and env-driven candidate overrides stay in one place.
 *
 * Env vars (inherited from brief side):
 *   BRIEF_MEMORY_DISABLED            = '1' to disable plugin detection entirely
 *   BRIEF_MEMORY_PLUGINS_JSON        = full JSON replacement for candidate list
 *   BRIEF_MEMORY_PLUGIN_DIRS         = colon-sep list of dirs (under $HOME) to scan
 *   BRIEF_MEMORY_<NAME>_RECALL_TOOL  = per-plugin recall tool override
 *   BRIEF_MEMORY_<NAME>_REMEMBER_TOOL
 *   BRIEF_MEMORY_<NAME>_SAVE_TOOL    = 'none' clears
 */

'use strict';

const { loadMemoryPluginCandidates } = require('../../work-brief/lib/memory-plugin-config');

module.exports = { loadMemoryPluginCandidates };
