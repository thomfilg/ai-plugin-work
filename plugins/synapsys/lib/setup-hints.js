'use strict';

/**
 * SessionStart setup hints.
 *
 * Pure helpers extracted from `hooks/synapsys.js` to keep the dispatcher under
 * the static-gate line budget. The hint constants stay Claude literals; the
 * emission point renders them through the shared vocabulary layer —
 * `renderInstruction` is the identity on claude (byte-identical output) and
 * swaps `/plugin:skill` / AskUserQuestion tokens on codex (design §F, C13).
 *
 * @module lib/setup-hints
 */

const { renderInstruction } = require('./runtime/vocab');

const SETUP_REQUIRED_HINT =
  '[synapsys:setup-required] No Synapsys memory store is configured for this repo/worktree.\n\n' +
  'AGENT: As your FIRST action this session, surface this to the user and offer to run `/synapsys:install`. Recommend the kind based on context:\n' +
  '  - If `git worktree list` shows >1 entry → recommend `worktree` (shared across all worktrees of this repo)\n' +
  '  - Otherwise → recommend `local`\n' +
  '  - Mention `global` (per-project, survives worktree deletion) and `shared` (one store reused across ALL projects) as options\n\n' +
  'Do NOT install without asking — present the recommendation via `AskUserQuestion` so the user can confirm or choose differently. If the user declines, set SYNAPSYS_NO_SETUP_HINT=1 to silence this prompt for future sessions.';

function emptyStoreHint(stores) {
  const dirs = stores.map((s) => `${s.kind} (${s.dir})`).join(', ');
  return (
    `[synapsys:empty-store] Memory store(s) ready: ${dirs}. No memories yet.\n\n` +
    'AGENT: Mention this to the user and offer two paths:\n' +
    "  - `/synapsys:crystallize` — import Claude's existing auto-memories (if any exist for this repo)\n" +
    '  - `/synapsys:memorize "<what to remember>"` — add a memory manually\n\n' +
    'Do not auto-run either — let the user pick. If they decline, set SYNAPSYS_NO_SETUP_HINT=1 to silence.'
  );
}

// Returns a hint string when SessionStart fires with no store or no memories.
// Returns null when no hint should be emitted (hint disabled or store + memories present).
// `runtime` defaults to 'claude', where renderInstruction returns the hint
// unchanged (same reference — provably inert).
function getSessionStartHint(event, stores, memories, runtime = 'claude') {
  if (event !== 'SessionStart') return null;
  if (process.env.SYNAPSYS_NO_SETUP_HINT === '1') return null;
  if (!stores.length) return renderInstruction(SETUP_REQUIRED_HINT, runtime);
  if (!memories.length) return renderInstruction(emptyStoreHint(stores), runtime);
  return null;
}

module.exports = { SETUP_REQUIRED_HINT, emptyStoreHint, getSessionStartHint };
