/**
 * Integration test for tasks-gate routing on intra-ticket scope conflicts
 * (Task 1 of GH-485).
 *
 * Scenario (verbatim title required by task-next.js RED gate):
 *   - tasks-gate routes to split-in-tasks when intra-ticket conflict is detected
 *
 * Builds a hand-crafted invalid tasks.md, parses it via the real
 * task-parser, runs `validateAll`, and asserts:
 *   - `valid === false`
 *   - at least one error names `components/X.tsx`
 *   - at least one error references both the out-of-scope task number
 *     and the in-scope (owning) task number
 *
 * Uses node:test + node:assert/strict.
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TASK_PARSER_PATH = path.resolve(__dirname, '..', 'lib', 'task-parser');

let tmpDir;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-gate-intra-ticket-test-'));
}

function teardown() {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
}

const INVALID_TASKS_MD = `# Tasks (hand-crafted invalid for intra-ticket scope conflict)

## Task 1 — Add helper A

### Type
chore

### Files in scope
- \`lib/a.ts\`

### Files explicitly out of scope
- \`components/X.tsx\`

### Deliverables
- [ ] 1.1 **GREEN:** add helper A
  - Test: \`helperA()\` returns 1

### Test Command
\`\`\`bash
CHANGED_FILES="lib/a.test.ts" eval "$TEST_UNIT_COMMAND"
\`\`\`

---

## Task 2 — Wire components/X.tsx

### Type
wiring

### Files in scope
- \`components/X.tsx\`

### Deliverables
- [ ] 2.1 **GREEN:** wire X
  - Test: \`<X />\` renders

### Test Command
\`\`\`bash
CHANGED_FILES="components/X.test.tsx" eval "$TEST_UNIT_COMMAND"
\`\`\`
`;

describe('tasks-gate intra-ticket scope routing', () => {
  beforeEach(() => setup());
  afterEach(() => teardown());

  it('tasksGateStep (real step function) routes to RUN split-in-tasks with intra-ticket error', () => {
    // Drives the actual `tasksGateStep` function the workflow engine invokes
    // for the `tasks_gate` step — not just `validateAll`. This catches any
    // future regression where the validator still rejects the document but
    // the gate step accidentally classifies it as DEFER (silent pass).
    fs.writeFileSync(path.join(tmpDir, 'tasks.md'), INVALID_TASKS_MD, 'utf8');

    const tasksGateStep = require('../steps/tasks-gate');
    const STEPS = { tasks_gate: 'tasks_gate' };
    const calls = [];
    const add = (step, decision, agent, reason, opts) =>
      calls.push({ step, decision, agent, reason, opts });

    tasksGateStep(add, { hasTasks: true }, {
      STEPS,
      tasksDir: tmpDir,
      path,
    });

    assert.equal(calls.length, 1, `expected exactly one add() call; got ${JSON.stringify(calls)}`);
    const [c] = calls;
    assert.equal(c.step, 'tasks_gate');
    assert.equal(c.decision, 'RUN', `gate must RUN split-in-tasks, not DEFER; got ${JSON.stringify(c)}`);
    assert.equal(c.agent, '/work-workflow:split-in-tasks');
    assert.match(
      c.reason,
      /components\/X\.tsx/,
      `RUN reason must surface the conflicting file path; got: ${c.reason}`
    );
  });

  it('tasks-gate routes to split-in-tasks when intra-ticket conflict is detected', () => {
    fs.writeFileSync(path.join(tmpDir, 'tasks.md'), INVALID_TASKS_MD, 'utf8');

    const { parseTasks } = require(TASK_PARSER_PATH);
    const { validateAll } = require('../../lib/task-scope');

    const tasks = parseTasks(tmpDir);
    assert.ok(Array.isArray(tasks) && tasks.length === 2, 'invalid tasks.md must parse to 2 tasks');

    const result = validateAll(tasks);
    assert.equal(
      result.valid,
      false,
      `validateAll must report invalid for intra-ticket conflict; got: ${JSON.stringify(result, null, 2)}`
    );

    // At least one error must name `components/X.tsx` AND reference both task numbers.
    const matching = result.errors.filter(
      (e) => /components\/X\.tsx/.test(e) && /\bTask\s*1\b/i.test(e) && /\bTask\s*2\b/i.test(e)
    );
    assert.ok(
      matching.length >= 1,
      `expected at least one error naming components/X.tsx AND both task numbers (1 = out-of-scope declarant, 2 = in-scope owner); got errors: ${JSON.stringify(result.errors, null, 2)}`
    );
  });
});
