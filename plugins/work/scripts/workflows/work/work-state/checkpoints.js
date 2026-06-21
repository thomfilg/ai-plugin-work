/**
 * GH-410 checkpoint auto-completion. Extracted from work-state.js (file-size
 * burndown). `autoCompleteCheckpointTasks` is unchanged in behavior — it is
 * decomposed into per-concern helpers (report read, tasks.md re-check, verdict
 * authentication, per-task linkage) to satisfy the complexity gate. The
 * security-sensitive regexes and fail-closed logic are preserved verbatim.
 */

'use strict';

const { fs, path, TASKS_BASE, safeId } = require('./core');

/** Read completion.check.md, or null when absent/unreadable. */
function readCompletionReport(ticketDir) {
  const reportPath = path.join(ticketDir, 'completion.check.md');
  if (!fs.existsSync(reportPath)) return null;
  try {
    return fs.readFileSync(reportPath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Re-verify checkpoint classification against tasks.md (not just persisted
 * state). Without this, an attacker who can write `.work-state.json`
 * directly could flip `kind:"checkpoint"` on a real implementation task
 * and trigger the auto-close path. tasks.md is the source of truth for
 * task classification — `kind_assign` already validates `type` against
 * VALID_KINDS at tasks-step time, so re-parsing here gives us a fresh
 * read of an authority that wasn't reachable via state-file tampering.
 *
 * FAIL-CLOSED: if tasks.md is missing or unparseable, refuse to auto-close
 * anything. The same actor that could tamper with `.work-state.json` could
 * also delete or corrupt tasks.md to skip this re-check, and the remaining
 * gates (verdict + id-in-report) are both writable by them too. tasks.md
 * is the only authority we trust here, so its absence is treated as
 * refusal-to-vouch, not as a green light.
 * @returns {{ readable: boolean, nums: Set<number> }}
 */
function readTasksMdCheckpointNums(ticketDir) {
  try {
    const tasksMdPath = path.join(ticketDir, 'tasks.md');
    if (!fs.existsSync(tasksMdPath)) return { readable: false, nums: new Set() };
    // Lazy require to avoid circular deps at module-load time.
    // eslint-disable-next-line global-require
    const { parseTasks } = require('../lib/task-parser');
    const parsed = parseTasks(ticketDir);
    if (!Array.isArray(parsed)) return { readable: false, nums: new Set() };
    // Trust ONLY the explicit `type: checkpoint` from tasks.md.
    // parseTasks also sets `isCheckpoint` via a title regex
    // (/checkpoint/i.test(title)), but that title-prose path is the
    // same kind of unreliable signal we already rejected for the
    // per-task linkage check — a real implementation task with
    // "checkpoint" in its title would otherwise pass the gate here.
    const nums = new Set(
      parsed
        .filter((t) => t && t.type === 'checkpoint')
        .map((t) => t.num)
        .filter((n) => Number.isInteger(n))
    );
    return { readable: true, nums };
  } catch {
    return { readable: false, nums: new Set() };
  }
}

/**
 * Authenticate the verdict on a line-anchored read. The buildVerdictRegex
 * helper matches anywhere in the document — quoted/example prose like
 * `> Status: APPROVED` or fenced-block text would otherwise pass.
 * Require the matched line to start with `Status:` / `Verdict:` (optional
 * leading whitespace or markdown emphasis) — never as a quote `>` or
 * list marker. The matched verdict here is what flows into the audit
 * `reason` field, so both the gate AND the traceability record key off
 * the same authenticated read (see PR #470 review).
 *
 * Trailing boundary lookahead — `(?![A-Za-z0-9_-])` — prevents the
 * verdict token from matching as a prefix of a longer word or a hyphen-
 * qualified phrase: `Status: COMPLETED`, `Status: COMPLETELY ...`,
 * `Status: APPROVED-WITH-CHANGES`, `Status: APPROVEDISH` must all fail.
 * Whitespace, `]`, `.`, `,`, EOL, em-dash etc. are legitimate
 * terminators; ASCII hyphen and word chars are not.
 * @returns {string|null} matched verdict (uppercased) or null
 */
function matchVerdict(reportContent) {
  const verdictLineRe = new RegExp(
    `^[\\s\\*_]*(?:Status|Verdict)[:\\s*]*\\[?(COMPLETE|APPROVED)(?![A-Za-z0-9_-])\\]?`,
    'im'
  );
  const verdictMatch = verdictLineRe.exec(reportContent);
  return verdictMatch ? verdictMatch[1].toUpperCase() : null;
}

/**
 * Per-task linkage with id-only token-boundary matching. Mutates `state` —
 * flips matched checkpoint tasks to completed and returns the audit entries.
 *
 * We deliberately do NOT match on titles. Titles are free-form prose
 * ("Refactor", "Tests", "Wrap-up") that can collide with unrelated mentions
 * in the report — a checkpoint titled "Refactor" would auto-close on any
 * APPROVED report that happened to mention refactoring. Task ids
 * (`task_1`, `task_2`, ...) are unambiguous synthetic tokens.
 *
 * JS `\b` treats `_` as a word char and so does NOT separate `task_1`
 * from `task_10`; we use an explicit `[^A-Za-z0-9_]` boundary instead so
 * a report naming only `task_10` does not auto-close `task_1`.
 */
function closeMatchingCheckpoints(state, reportContent, matchedVerdict, tasksMdCheckpointNums) {
  const closed = [];
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const idToNum = (id) => {
    const m = /^task_(\d+)$/.exec(String(id || ''));
    return m ? Number(m[1]) : null;
  };
  for (const entry of state.tasksMeta.tasks) {
    if (!entry || entry.kind !== 'checkpoint' || entry.status === 'completed') continue;
    if (!entry.id) continue;
    // Source-of-truth re-check: the task's num MUST appear in the parsed
    // tasks.md set with type=checkpoint (we already bailed if tasks.md was
    // unreadable). This is the gate state-file tampering can't bypass.
    const num = idToNum(entry.id);
    if (num === null || !tasksMdCheckpointNums.has(num)) continue;
    const re = new RegExp(`(^|[^A-Za-z0-9_])${escapeRe(entry.id)}([^A-Za-z0-9_]|$)`);
    if (!re.test(reportContent)) continue;
    entry.status = 'completed';
    closed.push({
      taskId: entry.id,
      title: entry.title || entry.id,
      reason: `${matchedVerdict} completion.check.md names ${entry.id}`,
      timestamp: new Date().toISOString(),
    });
  }
  return closed;
}

/**
 * GH-410: Auto-complete checkpoint tasks that have an APPROVED/COMPLETE
 * completion.check.md report. Mutates `state` in place. Returns the array
 * of audit entries appended (empty if nothing changed).
 *
 * A checkpoint task is a verification-only roll-up with no source deliverables.
 * The check step already verifies its outcome via completion.check.md, so the
 * tasksMeta bookkeeping just needs to follow.
 */
function autoCompleteCheckpointTasks(state, ticketId) {
  const closed = [];
  if (!state || !state.tasksMeta || !Array.isArray(state.tasksMeta.tasks)) return closed;

  const ticketDir = path.join(TASKS_BASE, safeId(ticketId));
  const reportContent = readCompletionReport(ticketDir);
  if (!reportContent) return closed;

  const { readable, nums: tasksMdCheckpointNums } = readTasksMdCheckpointNums(ticketDir);
  if (!readable) return closed;

  const matchedVerdict = matchVerdict(reportContent);
  if (!matchedVerdict) return closed;

  const result = closeMatchingCheckpoints(
    state,
    reportContent,
    matchedVerdict,
    tasksMdCheckpointNums
  );
  closed.push(...result);

  if (closed.length > 0) {
    if (!Array.isArray(state.autoCompleted)) state.autoCompleted = [];
    state.autoCompleted.push(...closed);
  }
  return closed;
}

module.exports = { autoCompleteCheckpointTasks };
