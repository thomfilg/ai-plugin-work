/**
 * detectors/question.js
 *
 * Detect a pending question that blocks the agent:
 *   - menu prompts ending with "Enter to select · ↑/↓ to navigate · Esc to cancel"
 *   - permission prompts ("Permission rule Bash(rm:*) requires confirmation")
 *
 * orchestrate NEVER auto-answers. We just track pending duration so the
 * main loop can escalate to a maestro alert when it sits too long.
 *
 * The "first-seen" time is tracked by the main loop via state markers;
 * this detector only reports whether a question is currently showing
 * and surfaces a short summary (selected line / options).
 */
function detect({ pane }) {
  if (!pane) return { hit: false };
  // Menu footer is the strongest signal — when present, an option menu IS open
  // even if the ❯ cursor + option list scrolled off the visible viewport.
  // (Empirically observed: tall menus render >24 rows and capture-pane only
  // sees the bottom slice.)
  const menuFooter = /Enter to select.*(navigate|cancel)|to navigate · Esc to cancel/.test(pane);
  const permPrompt = /Permission rule .+ requires confirmation|Do you want to proceed\?/.test(pane);
  if (!menuFooter && !permPrompt) return { hit: false };

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
