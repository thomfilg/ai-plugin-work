'use strict';

/**
 * Pure helpers extracted from enforce-tdd-on-stop.js.
 *
 * These functions have NO side effects beyond `appendDebugSection` (a
 * best-effort file append that never throws) and close over no module state —
 * every input is passed explicitly. They exist to keep the hook entrypoint
 * under the static-quality line budget.
 *
 * W1 (implement-phase fix design): the legacy auto-record helpers
 * (`applyPhaseTestFlags`, `redPassedMessage`) were removed together with the
 * hook's auto-record path — the stop hook no longer runs tests or records
 * evidence; it blocks with `missingEvidenceMessage` pointing at task-next.js.
 */

const fs = require('fs');
const path = require('path');

// Shared `<WORKTREES_BASE>/<repo>-<ticket>` lookup (same module the
// work-implement-enforce.js hook uses — keeps the two hooks from drifting).
const { isDirectory, conventionWorktreeDir } = require('./worktree-convention');

/**
 * Append a `## <timestamp> — enforce-tdd-on-stop` section to the ticket's
 * debug.md. Best-effort: never throws.
 *
 * @param {string} tasksBase - resolved TASKS_BASE directory
 * @param {string} safeTicket - filesystem-safe ticket id
 * @param {string} body - section body (without trailing newline)
 */
function appendDebugSection(tasksBase, safeTicket, body) {
  try {
    const debugPath = path.join(tasksBase, safeTicket, 'debug.md');
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    fs.appendFileSync(debugPath, `\n## ${timestamp} — enforce-tdd-on-stop\n\n${body}\n`);
  } catch {
    /* best-effort */
  }
}

/**
 * Resolve the worktree directory for Test Strategy resolution (`.envrc`
 * threading in resolveTaskTestExecution). The hook must NOT default blindly
 * to process.cwd() — a SubagentStop hook may run from anywhere.
 *
 * Priority:
 *   1. WORK_WORKTREE_DIR env (explicit override), when it is a directory
 *   2. workState.worktreeDir (persisted by the orchestrator), when a directory
 *   3. Convention: WORKTREES_BASE/<REPO_NAME>-<safeTicket>, when a directory
 *   4. process.cwd() as last resort
 *
 * @param {object|null} workState - parsed .work-state.json (may be null)
 * @param {string} safeTicket - filesystem-safe ticket id
 * @returns {string} an existing directory path
 */
function resolveWorktreeDir(workState, safeTicket) {
  const envDir = process.env.WORK_WORKTREE_DIR;
  if (envDir && isDirectory(envDir)) return path.resolve(envDir);

  const stateDir =
    workState && typeof workState.worktreeDir === 'string' ? workState.worktreeDir : null;
  if (stateDir && isDirectory(stateDir)) return path.resolve(stateDir);

  const candidate = conventionWorktreeDir(safeTicket);
  if (candidate) return candidate;

  return process.cwd();
}

/**
 * Positive developer-agent identification from the SUBAGENT's own transcript
 * (used when the SubagentStop payload carries no `agent_type` — older Claude
 * Code builds). The implement dispatch prompt built by
 * step-enrichments/implement.js `buildSelfPacedPrompt` is the FIRST user
 * message of a developer subagent's transcript and carries two structural
 * markers: the role sentence "self-paced TDD agent" and the single
 * `task-next.js` instruction. Both must match — matching the structural
 * dispatch-prompt marker, not bare agent names, avoids the GH-665 substring
 * pitfall (e.g. an agent whose prompt merely MENTIONS "developer-nodejs-tdd").
 *
 * Only the first user message is inspected: later messages legitimately
 * discuss task-next.js output inside non-developer contexts too.
 *
 * Fail-open to `false` (⇒ the hook allows the stop): an unidentifiable
 * subagent must never be TDD-gated.
 *
 * @param {string|undefined} transcriptPath
 * @returns {boolean}
 */
function _messageText(entry) {
  const content = entry.message && entry.message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((i) => (i && i.text) || '').join(' ');
}

/** Text of the transcript's FIRST user message, or null when unreadable. */
function _firstUserMessageText(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;

  // Codex rollout transcripts (SubagentStop agent_transcript_path on codex):
  // the claude line scan below can't read them — take the FIRST authored user
  // message via the vendored dual-format reader (event_msg/user_message
  // records only; injected context is never mistaken for the dispatch
  // prompt). Payload `agent_type` remains the primary identification — this
  // fallback only runs on payloads without it (see enforce-tdd-on-stop.js).
  const { sniffFormat, readUserMessages } = require(
    path.join(__dirname, '..', '..', 'lib', 'runtime', 'transcript')
  );
  if (sniffFormat(transcriptPath) === 'codex') {
    const messages = readUserMessages(transcriptPath, { count: Number.MAX_SAFE_INTEGER });
    return messages.length > 0 ? messages[0] : null;
  }

  for (const line of fs.readFileSync(transcriptPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry && entry.type === 'user') return _messageText(entry);
  }
  return null;
}

function transcriptIsDeveloperDispatch(transcriptPath) {
  try {
    const text = _firstUserMessageText(transcriptPath);
    // FIRST user message decides — both structural markers must match.
    return Boolean(text) && /self-paced TDD agent/i.test(text) && /task-next\.js/.test(text);
  } catch {
    return false;
  }
}

/**
 * Stderr message shown when a runnable Test Strategy exists but no valid TDD
 * evidence (RED → GREEN cycle) is recorded. The hook blocks the stop and
 * points at the ONE next command — it never runs tests or records evidence
 * itself (the previous auto-record path fabricated evidence with a command
 * that could differ from task-next's and skipped kind-aware gates).
 *
 * @param {string} safeTicket
 * @param {number} taskNum
 * @returns {string}
 */
function missingEvidenceMessage(safeTicket, taskNum) {
  return [
    '',
    `STOP BLOCKED: task ${taskNum} has no valid TDD evidence (RED → GREEN cycle)`,
    'recorded for the implement step.',
    '',
    'This hook will NOT run tests or record evidence for you — fabricated',
    'evidence corrupts the TDD audit trail (see RC-C in the implement-gate',
    'stuckness investigation). If your tests already pass, that is still not',
    'evidence: a failing RED run must be recorded first, and a passing command',
    'in RED means the failing test was never written (or the code was',
    'implemented before recording RED).',
    '',
    'What to do — run the ONE command below; it inspects the real phase state',
    'and tells you precisely which phase you are in and what to do next:',
    `  node $CLAUDE_PLUGIN_ROOT/scripts/workflows/work-implement/task-next.js ${safeTicket} task${taskNum}`,
    '',
  ].join('\n');
}

/**
 * Stderr message shown when a citation-kind `### Test Strategy` task reaches
 * the stop hook without valid peer-citation evidence. Blocks the stop.
 *
 * @param {string} safeTicket
 * @param {number} taskNum
 * @returns {string}
 */
function citationBlockMessage(safeTicket, taskNum) {
  return [
    '',
    `STOP BLOCKED: task ${taskNum} uses a citation-kind \`### Test Strategy\` (no`,
    'runnable command). It is satisfied by peer-citation evidence, which is not',
    'yet recorded.',
    '',
    'What to do:',
    `  Run: node $CLAUDE_PLUGIN_ROOT/scripts/workflows/work-implement/task-next.js ${safeTicket} task${taskNum}`,
    '  It will validate the peer citation and record the green evidence for you.',
    '',
  ].join('\n');
}

module.exports = {
  appendDebugSection,
  resolveWorktreeDir,
  transcriptIsDeveloperDispatch,
  missingEvidenceMessage,
  citationBlockMessage,
};
