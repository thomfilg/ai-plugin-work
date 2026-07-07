'use strict';

/**
 * instruction-vocab.js — the work plugin's emission-time vocabulary renderer
 * (design §F, WP-08).
 *
 * Thin plugin-local wrapper over the vendored runtime vocab: it binds the
 * plugin root (for persona/SKILL.md path resolution) and the memoized runtime
 * so every instruction chokepoint (instruction-builder, step enrichments,
 * gate steps, follow-up/check emitters) renders through ONE module.
 *
 * Claude is the load-bearing default: every helper returns its input
 * byte-identical (same reference) when the runtime is not codex, pinned by
 * characterization tests. Codex renderings honor the degradation contract
 * (C1 inline personas, C3 parked question gates, C13 `$skill` mentions).
 */

const path = require('node:path');

const { getRuntime } = require('./runtime');
const { T, renderInstruction, renderDelegate } = require('./runtime/vocab');

// plugins/work — resolved from this file's on-disk location so it holds in
// both the dev tree and a codex cache install (symlinks are dropped there):
// <root>/scripts/workflows/lib → three levels up.
const PLUGIN_ROOT = path.resolve(__dirname, '..', '..', '..');

// C3 notice, verbatim from the degradation contract (design §0).
const PARKED_NOTICE =
  '[work:codex-degraded] interactive gate parked — answer via maestro signal or codex exec resume';

/**
 * Runtime-correct rendering of an instruction delegate with the work plugin
 * root bound for persona/SKILL.md resolution. claude: same reference back.
 * codex: `task` → `inline-agent` (+personaPath/howTo/notices), `skill` gains
 * a mention-based howTo; bash/commit pass through.
 */
function renderDelegateForRuntime(delegate, rt = getRuntime()) {
  return renderDelegate(delegate, rt.name, { pluginRoot: PLUGIN_ROOT });
}

/**
 * Question-gate prose renderer (C3). claude: byte-identical passthrough.
 * codex: AskUserQuestion → request_user_input prose swap; unless the session
 * is known-interactive (`rt.mode() === 'interactive'`, i.e. a payload-bearing
 * hook or AGENT_RUNTIME_MODE=interactive), the parked-gate notice is appended
 * — driver CLIs have no payload, so exec fleets always see it and TUI users
 * can drop it with AGENT_RUNTIME_MODE=interactive.
 */
function renderQuestionText(text, rt = getRuntime()) {
  if (rt.name !== 'codex') return text;
  const rendered = renderInstruction(text, 'codex');
  if (rt.mode() === 'interactive') return rendered;
  return `${rendered}\n${PARKED_NOTICE}`;
}

module.exports = {
  T,
  renderInstruction,
  renderDelegateForRuntime,
  renderQuestionText,
  getRuntime,
  PARKED_NOTICE,
  PLUGIN_ROOT,
};
