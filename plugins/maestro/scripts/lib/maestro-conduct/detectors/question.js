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

const { isCodexPaneDialect } = require('../live-spinner');

// A line shaped like a menu option (cursor or indented "N. text").
const OPTION_LINE_RE = /^(❯|\s+)[ ]*[0-9]+\.\s/;

/**
 * The LAST contiguous run of option-shaped lines — the menu block at the
 * bottom of the pane. The capture carries ~100 lines of scrollback (tmux.js),
 * and numbered prose up there (tool output, a subagent stream) both pollutes
 * the operator-facing options AND flaps the A4 content hash keyed on them —
 * each flap would mint a fresh alert identity and an immediate wake.
 * Trade-off: a wrapped option's indented continuation line breaks contiguity,
 * so very tall menus may surface only their bottom options — acceptable, the
 * block is stable per prompt (which is all the hash needs) and buildUnblockCmd
 * degrades gracefully without a ❯-marked line.
 */
function optionBlock(pane) {
  const lines = pane.split('\n');
  let end = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (OPTION_LINE_RE.test(lines[i])) {
      end = i;
      break;
    }
  }
  if (end === -1) return [];
  let start = end;
  while (start > 0 && OPTION_LINE_RE.test(lines[start - 1])) start -= 1;
  return lines
    .slice(start, end + 1)
    .slice(0, 4)
    .map((l) => l.trim());
}

/** First line matching the permission grammar, whitespace-collapsed, or null.
 *  Carries the prompt's own identity (rule name, file being edited) so two
 *  different permission prompts with identical boilerplate option sets don't
 *  collapse into one A4 content hash (GH-698 review). */
function matchedPromptLine(pane) {
  const line = pane.split('\n').find((l) => PERM_PROMPT_RE.test(l));
  return line ? line.replace(/\s+/g, ' ').trim() : null;
}

function detect({ pane, dialect }) {
  // Codex dialects: the menu/permission grammar below is claude-TUI-only.
  // Exec-mode questions surface as parked-BLOCKED /work state files (C3), and
  // codex TUI prompts are unreadable until fixtures exist — report
  // "unsupported", never a false idle/answer state (WP-09).
  if (isCodexPaneDialect(dialect)) return { hit: false, capability: 'unsupported' };
  if (!pane) return { hit: false };
  const menuFooter = MENU_FOOTER_RE.test(pane);
  const permPrompt = PERM_PROMPT_RE.test(pane);
  const optionCursor = OPTION_CURSOR_RE.test(pane);
  if (!menuFooter && !permPrompt && !optionCursor) return { hit: false };

  return {
    hit: true,
    kind: 'question-pending',
    options: optionBlock(pane),
    promptKind: permPrompt ? 'permission' : 'menu',
    promptLine: permPrompt ? matchedPromptLine(pane) : null,
  };
}

module.exports = { name: 'question', detect, matchedPromptLine, optionBlock };
