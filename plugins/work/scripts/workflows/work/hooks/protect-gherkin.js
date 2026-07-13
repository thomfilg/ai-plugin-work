#!/usr/bin/env node

/**
 * PreToolUse hook: Protect gherkin.feature from edits outside the spec step.
 *
 * GH-350 Task 6: Blocks Edit/Write/MultiEdit/Bash writes to gherkin.feature
 * when the current workflow step is NOT `spec`. Fail-open on errors.
 *
 * GH-392 Task 6 (P0 #5): During `implement`, Edit/MultiEdit operations that
 * touch ONLY tag lines (e.g. `@wip` → `@regression`) are allowed. Semantic
 * edits (Scenario/Given/When/Then/Feature) remain blocked, and the block
 * message ends with a `BYPASS:` line referencing the `spec_gate` recovery
 * path. Ambiguous diffs (mixed tag + semantic line) default-block to
 * preserve the security invariant.
 *
 * GH-487: TAG_LINE_RE accepts `/` and `.` so path-bearing tags
 * (e.g. `@test:plugins/work/.../foo.test.js`) — auto-stamped onto every
 * scenario by tasks_gate — are recognised as tag lines. Without this the
 * existing `implement` allow-path is broken for any tasks_gate-stamped
 * scenario.
 *
 * Allowed steps: spec
 * All other steps: blocked (exit 2)
 * No workflow active: allowed (exit 0, fail-open)
 */

const fs = require('fs');
const path = require('path');
const { runHook } = require(path.join(__dirname, '..', '..', 'lib', 'hookEntrypoint'));
const { createArtifactProtector } = require('../../lib/protect-artifact-files');

/** Tag line: zero or more whitespace, then one or more `@token` tokens. */
const TAG_LINE_RE = /^\s*(@[\w:./-]+\s*)+$/;

/**
 * Detect if an Edit/MultiEdit diff of gherkin.feature touches ONLY tag lines.
 *
 * Spec reference: spec.md §P0#5 — tag-only edits (e.g. `@wip` → `@regression`)
 * should be permitted during `implement` so that agents can re-classify
 * scenarios without rewinding the state machine. Semantic edits (Scenario,
 * Given/When/Then/And, Feature) must continue to be blocked.
 *
 * Security note (default-block on uncertainty): we split both strings by
 * newline and zip-align by line index. Insertions/deletions count as
 * differing lines. The function returns true ONLY when every differing line
 * — on both sides — matches the tag-line regex. Any ambiguity (mixed tag +
 * semantic change, line count mismatch with non-tag insertions, missing
 * inputs) defaults to `false` (block).
 *
 * @param {string} oldString
 * @param {string} newString
 * @returns {boolean} true if every differing line is tag-only
 */
/**
 * A single zip-aligned line pair is "tag-safe" when every present side is a
 * tag-only line. Insertion (old missing) checks the new line; deletion (new
 * missing) checks the old line; modification checks both.
 *
 * @param {string|null} o old-side line (null = absent)
 * @param {string|null} n new-side line (null = absent)
 * @returns {boolean}
 */
function isTagSafeLinePair(o, n) {
  if (o !== null && !TAG_LINE_RE.test(o)) return false;
  if (n !== null && !TAG_LINE_RE.test(n)) return false;
  return true;
}

function isTagOnlyGherkinEdit(oldString, newString) {
  if (typeof oldString !== 'string' || typeof newString !== 'string') return false;
  if (oldString === newString) return false; // No diff — let normal flow handle

  const oldLines = oldString.split('\n');
  const newLines = newString.split('\n');
  const maxLen = Math.max(oldLines.length, newLines.length);

  let sawDiff = false;
  for (let i = 0; i < maxLen; i++) {
    const o = i < oldLines.length ? oldLines[i] : null;
    const n = i < newLines.length ? newLines[i] : null;
    if (o === n) continue;
    sawDiff = true;
    if (!isTagSafeLinePair(o, n)) return false;
  }
  return sawDiff;
}

/**
 * Get the ticket ID from TICKET_ID env var or derive from branch/cwd.
 * Reuses the canonical getCurrentTaskId from get-ticket-id.js.
 * @param {object} [hookData]
 * @returns {string|null}
 */
function getTicketId(hookData) {
  const raw =
    process.env.TICKET_ID ||
    (() => {
      try {
        const { getCurrentTaskId } = require(
          path.join(__dirname, '..', '..', 'lib', 'scripts', 'get-ticket-id')
        );
        return getCurrentTaskId() || null;
      } catch {
        return null;
      }
    })();
  if (!raw) return null;
  // Normalize (e.g., #99 -> GH-99)
  let ticketId;
  try {
    ticketId = require(path.join(__dirname, '..', '..', 'lib', 'config')).safeTicketId(raw);
  } catch {
    ticketId = raw;
  }
  // Fail-open: if work state doesn't exist, return null (no ticket context -> allow)
  try {
    const getConfig = require(path.join(__dirname, '..', '..', 'lib', 'get-config'));
    const tasksBase = getConfig.require('TASKS_BASE');
    const statePath = path.join(tasksBase, ticketId, '.work-state.json');
    if (!fs.existsSync(statePath)) return null;
  } catch {
    return null;
  }
  return ticketId;
}

/**
 * Get the current in_progress step from .work-state.json.
 * @param {string} ticketId
 * @returns {string|null}
 */
function getStepInProgress(ticketId) {
  try {
    const getConfig = require(path.join(__dirname, '..', '..', 'lib', 'get-config'));
    const tasksBase = getConfig('TASKS_BASE');
    if (!tasksBase) return null;

    const statePath = path.join(tasksBase, ticketId, '.work-state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const stepStatus = state.stepStatus || {};

    for (const [step, status] of Object.entries(stepStatus)) {
      if (status === 'in_progress') {
        return step;
      }
    }
    return null;
  } catch {
    // Fail-open by design: if workflow state is unreadable
    // or no step is in_progress, allow the edit rather than block legitimate work.
    return null;
  }
}

// Allow edits during `spec` (initial authoring), `spec_gate` (recovery
// path: spec_gate's validator failed against gherkin.feature and the
// agent needs to fix the tags / structure in-place without rewinding the
// state machine), AND `tasks` / `tasks_gate` (so the agent can add
// `@task:N` / `@test:<path>` tags that the tasks_gate cross-validator
// requires — without these the gate would block forever).
const protector = createArtifactProtector({
  artifacts: [
    {
      basename: 'gherkin.feature',
      step: 'spec',
      allowedSteps: ['spec_gate', 'tasks', 'tasks_gate'],
    },
  ],
  getStepInProgress,
  getTicketId,
});

const BYPASS_LINE =
  'BYPASS: edit gherkin.feature via /work spec_gate — re-enter spec_gate to recover and fix structural Gherkin changes.';

/**
 * Normalise an Edit/MultiEdit tool input into the list of {old_string,
 * new_string} edits to diff-check. MultiEdit carries an `edits` array; a plain
 * Edit is a single pair.
 *
 * @param {string} toolName
 * @param {object} toolInput
 * @returns {Array<{old_string: string, new_string: string}>}
 */
function collectGherkinEdits(toolName, toolInput) {
  if (toolName === 'MultiEdit' && Array.isArray(toolInput.edits)) return toolInput.edits;
  return [{ old_string: toolInput.old_string, new_string: toolInput.new_string }];
}

/**
 * True only when the tool call targets gherkin.feature during `implement`.
 * Gates the tag-only allow-path so the diff check runs only in that context.
 *
 * @param {string} toolName
 * @param {object} toolInput
 * @param {object} [hookData]
 * @returns {boolean}
 */
function isImplementGherkinEdit(toolName, toolInput, hookData) {
  if (toolName !== 'Edit' && toolName !== 'MultiEdit') return false;
  const filePath = toolInput?.file_path || '';
  if (!filePath || path.basename(filePath) !== 'gherkin.feature') return false;
  const ticketId = getTicketId(hookData);
  return !!ticketId && getStepInProgress(ticketId) === 'implement';
}

/**
 * Tag-only allow-path (GH-392 P0 #5): during `implement`, Edit/MultiEdit diffs
 * that touch ONLY tag lines on gherkin.feature are permitted. Default-block on
 * uncertainty: return true ONLY when we can positively prove the diff is
 * tag-only. Any other case returns false so `main` falls through to the
 * protector.
 *
 * @param {string} toolName
 * @param {object} toolInput
 * @param {object} [hookData]
 * @returns {boolean}
 */
function isTagOnlyAllowPath(toolName, toolInput, hookData) {
  if (!isImplementGherkinEdit(toolName, toolInput, hookData)) return false;
  const edits = collectGherkinEdits(toolName, toolInput);
  return edits.length > 0 && edits.every((e) => isTagOnlyGherkinEdit(e.old_string, e.new_string));
}

function main(hookData) {
  const toolName = hookData.tool_name;
  const toolInput = hookData.tool_input || {};

  if (isTagOnlyAllowPath(toolName, toolInput, hookData)) {
    process.exit(0);
  }

  const result = protector.check(toolName, toolInput, hookData);
  if (result.blocked) {
    // Ensure stderr ends with a BYPASS: line referencing spec_gate recovery (P0 #5).
    let message = result.message;
    if (!message.endsWith('\n')) message += '\n';
    message += BYPASS_LINE + '\n';
    process.stderr.write(message);
    process.exit(2);
  }
  process.exit(0);
}

// runHook reads + parses stdin (malformed JSON → {}), runs the handler, and on
// an uncaught throw logs the error and exits 0 (fail-open). Intentional blocks
// exit 2 from inside main().
runHook(main, { file: __filename });

module.exports = { isTagOnlyGherkinEdit };
