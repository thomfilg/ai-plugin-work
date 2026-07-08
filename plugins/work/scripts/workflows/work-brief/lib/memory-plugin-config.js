/**
 * Memory-plugin configuration for brief-next.js.
 *
 * Detection candidates are normally hardcoded (cortex, mem0). This module
 * exposes the same defaults but lets operators override them through env
 * vars without editing source. Useful for: (a) adding a new plugin in
 * a worktree without forking the codebase, (b) renaming tool identifiers
 * if a plugin's MCP namespace changes, (c) disabling the memorize phase
 * outright.
 *
 * Env contract (all optional):
 *
 *   BRIEF_MEMORY_DISABLED=1
 *     Hard-disable. `loadMemoryPluginCandidates()` returns [] and
 *     `detectMemoryPlugin()` returns null regardless of installed plugins.
 *
 *   BRIEF_MEMORY_PLUGINS_JSON='[{"name":"X","probe":"X","recallTool":"...","rememberTool":"..."}, ...]'
 *     Full replacement. Parsed as a JSON array of candidate descriptors.
 *     `probe` is compiled as a case-insensitive RegExp. `manifestGlob`
 *     defaults to the standard plugin dirs if omitted. Invalid JSON →
 *     warn on stderr, fall back to defaults.
 *
 *   BRIEF_MEMORY_PLUGIN_DIRS='dirA:dirB'
 *     Colon-separated list of directories (relative to $HOME) to scan
 *     instead of `.claude/plugins/marketplaces:.claude/plugins/cache`.
 *     Applied to every candidate that doesn't specify its own
 *     `manifestGlob`.
 *
 *   BRIEF_MEMORY_<NAME>_RECALL_TOOL=...
 *   BRIEF_MEMORY_<NAME>_REMEMBER_TOOL=...
 *   BRIEF_MEMORY_<NAME>_SAVE_TOOL=...
 *     Per-plugin tool-name overrides. <NAME> is the upper-cased plugin
 *     name (CORTEX, MEM0). `_SAVE_TOOL=none` clears the save tool.
 */

'use strict';

const DEFAULT_MANIFEST_GLOB = Object.freeze([
  '.claude/plugins/marketplaces',
  '.claude/plugins/cache',
]);

const DEFAULT_CANDIDATES = Object.freeze([
  Object.freeze({
    name: 'cortex',
    probe: /cortex/i,
    manifestGlob: DEFAULT_MANIFEST_GLOB,
    recallTool: 'mcp__plugin_cortex_cortex__cortex_recall',
    rememberTool: 'mcp__plugin_cortex_cortex__cortex_remember',
    saveTool: 'mcp__plugin_cortex_cortex__cortex_save',
  }),
  Object.freeze({
    name: 'mem0',
    probe: /mem0/i,
    manifestGlob: DEFAULT_MANIFEST_GLOB,
    recallTool: 'mem0_recall',
    rememberTool: 'mem0_remember',
    saveTool: null,
  }),
]);

function getEnv(name, env) {
  const v = env ? env[name] : process.env[name];
  return typeof v === 'string' ? v.trim() : '';
}

function isTruthy(v) {
  return /^(1|true|yes|on)$/i.test(String(v || '').trim());
}

function parseManifestGlob(envValue) {
  if (!envValue) return null;
  const parts = envValue
    .split(':')
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : null;
}

function compileProbe(probeSrc) {
  if (probeSrc instanceof RegExp) return probeSrc;
  if (typeof probeSrc !== 'string' || !probeSrc) return null;
  try {
    return new RegExp(probeSrc, 'i');
  } catch {
    return null;
  }
}

/**
 * Apply per-plugin env overrides (BRIEF_MEMORY_<NAME>_RECALL_TOOL etc.)
 * Mutates a shallow clone and returns it.
 */
function applyEnvOverrides(candidate, env) {
  const upper = String(candidate.name || '').toUpperCase();
  if (!upper) return candidate;
  const recall = getEnv(`BRIEF_MEMORY_${upper}_RECALL_TOOL`, env);
  const remember = getEnv(`BRIEF_MEMORY_${upper}_REMEMBER_TOOL`, env);
  const save = getEnv(`BRIEF_MEMORY_${upper}_SAVE_TOOL`, env);
  const out = { ...candidate };
  if (recall) out.recallTool = recall;
  if (remember) out.rememberTool = remember;
  if (save) out.saveTool = save.toLowerCase() === 'none' ? null : save;
  return out;
}

function parseCustomCandidates(jsonSrc, defaultManifestGlob) {
  let parsed;
  try {
    parsed = JSON.parse(jsonSrc);
  } catch (err) {
    process.stderr.write(
      `brief-next: BRIEF_MEMORY_PLUGINS_JSON is not valid JSON (${err.message}); falling back to defaults.\n`
    );
    return null;
  }
  if (!Array.isArray(parsed)) {
    process.stderr.write(
      `brief-next: BRIEF_MEMORY_PLUGINS_JSON must be a JSON array; falling back to defaults.\n`
    );
    return null;
  }
  const out = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const probe = compileProbe(entry.probe);
    if (!entry.name || !probe || !entry.recallTool || !entry.rememberTool) {
      process.stderr.write(
        `brief-next: BRIEF_MEMORY_PLUGINS_JSON entry missing required fields (name/probe/recallTool/rememberTool); skipping.\n`
      );
      continue;
    }
    out.push({
      name: String(entry.name),
      probe,
      manifestGlob: Array.isArray(entry.manifestGlob) ? entry.manifestGlob : defaultManifestGlob,
      recallTool: String(entry.recallTool),
      rememberTool: String(entry.rememberTool),
      saveTool: entry.saveTool ? String(entry.saveTool) : null,
    });
  }
  return out;
}

/**
 * Compute the active candidate list, applying env overrides.
 *
 * @param {object} [env] — defaults to process.env; pass an explicit object
 *   for tests to avoid touching the live environment.
 * @returns {Array<{name, probe: RegExp, manifestGlob: string[], recallTool, rememberTool, saveTool}>}
 */
function loadMemoryPluginCandidates(env = process.env) {
  if (isTruthy(getEnv('BRIEF_MEMORY_DISABLED', env))) return [];

  const customManifestGlob =
    parseManifestGlob(getEnv('BRIEF_MEMORY_PLUGIN_DIRS', env)) || DEFAULT_MANIFEST_GLOB;

  const jsonSrc = getEnv('BRIEF_MEMORY_PLUGINS_JSON', env);
  let base;
  if (jsonSrc) {
    const custom = parseCustomCandidates(jsonSrc, customManifestGlob);
    base = custom !== null ? custom : DEFAULT_CANDIDATES;
  } else {
    base = DEFAULT_CANDIDATES;
  }

  return base.map((c) => {
    const withGlob = {
      ...c,
      manifestGlob:
        c.manifestGlob && c.manifestGlob !== DEFAULT_MANIFEST_GLOB
          ? c.manifestGlob
          : customManifestGlob,
    };
    return applyEnvOverrides(withGlob, env);
  });
}

module.exports = {
  loadMemoryPluginCandidates,
  DEFAULT_CANDIDATES,
  DEFAULT_MANIFEST_GLOB,
  // exported for tests
  parseCustomCandidates,
  applyEnvOverrides,
};
