/**
 * detectors/question.js
 *
 * Detect a pending question that blocks the agent:
 *   - menu prompts ending with "Enter to select · ↑/↓ to navigate · Esc to cancel"
 *   - permission prompts ("Permission rule Bash(rm:*) requires confirmation",
 *     "Do you want to proceed?", "Do you want to allow …?")
 *   - a visible selected-option cursor (`❯ 1. Yes …`) — tall prompts scroll
 *     the footer out of the capture window, and permission prompts for plain
 *     bash commands have been observed sitting 44+ minutes undetected because
 *     neither legacy pattern was visible.
 *
 * orchestrate NEVER auto-answers. We just track pending duration so the
 * main loop can escalate to a maestro alert when it sits too long.
 *
 * The "first-seen" time is tracked by the main loop via state markers;
 * this detector only reports whether a question is currently showing
 * and surfaces a short summary (selected line / options).
 */
const MENU_FOOTER_RE = /Enter to select.*(navigate|cancel)|to navigate · Esc to cancel/;
const PERM_PROMPT_RE =
  /Permission rule .+ requires confirmation|Do you want to (proceed|allow|make this edit|create|run)/;
// A cursor sitting on a numbered option is an open menu even when the footer
// and question text scrolled off. Anchored to line start so prose mentioning
// "❯ 1." mid-sentence can't false-positive.
const OPTION_CURSOR_RE = /^\s*❯\s*[0-9]+\.\s/m;

function detect({ pane }) {
  if (!pane) return { hit: false };
  const menuFooter = MENU_FOOTER_RE.test(pane);
  const permPrompt = PERM_PROMPT_RE.test(pane);
  const optionCursor = OPTION_CURSOR_RE.test(pane);
  if (!menuFooter && !permPrompt && !optionCursor) return { hit: false };

  const optionLines = pane
    .split('\n')
    .filter((l) => /^(❯|\s+)[ ]*[0-9]+\.\s/.test(l))
    .slice(0, 4)
    .map((l) => l.trim());

  return {
    hit: true,
    kind: 'question-pending',
    options: optionLines,
    promptKind: permPrompt ? 'permission' : 'menu',
  };
}

module.exports = { name: 'question', detect };
