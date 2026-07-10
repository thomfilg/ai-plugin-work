'use strict';

/**
 * Task/agent-prompt lane (GH-699 rework).
 *
 * OLD contract: any prompt REFERENCING a protected path was blocked unless it
 * looked read-only to word heuristics ("create"/"update"/"fix"/bare `>` all
 * counted as writes), so real delegation prompts — "create the PR for the
 * diff touching packages/ui/…" — always tripped it, bricking orchestrator→
 * subagent handoffs (GH-699 vector 2).
 *
 * NEW contract: prose references are ALLOWED. Enforcement happens at ACT
 * time: the subagent's own Edit/Write/Bash calls run under this same
 * PreToolUse hook on both runtimes (claude Task sidechains and codex
 * spawn_agent streams — codex ground truth §11.1: "the subagent runs its own
 * hook stream"). Blocking the description of work adds no protection over
 * blocking the work itself.
 *
 * The ONE thing a prompt can do that act-time enforcement cannot catch is
 * SMUGGLE AN UNLOCK PHRASE: the prompt lands as a user-type record in the
 * subagent's transcript, which the unlock reader trusts — a parent agent
 * could mint an unlock no user ever typed. So a prompt carrying the unlock
 * phrase of a STILL-LOCKED entry is blocked. Once the user has genuinely
 * typed the phrase in the parent session, forwarding it to a subagent is
 * allowed — that is the sanctioned way to delegate an unlocked edit, and a
 * nested dispatch chain cannot launder it (every dispatch re-checks against
 * its own transcript, where only genuine user text counts).
 */

/**
 * Does `text` (a JSON-stringified tool input) contain `phrase` as a
 * standalone token? At least as permissive as the transcript reader's
 * matcher, so anything the reader would accept as an unlock is caught here:
 * JSON escapes are flattened to spaces and whitespace runs collapsed before
 * matching.
 */
function promptSmugglesPhrase(text, phrase) {
  const p = String(phrase || '')
    .trim()
    .toLowerCase();
  if (!p) return false;
  const hay = String(text)
    .replace(/\\[ntr]/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();
  const esc = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9])${esc}(?:$|[^a-z0-9])`).test(hay);
}

module.exports = { promptSmugglesPhrase };
