/**
 * Integration test for tasks-gate routing on unique-ownership conflicts
 * (Task 2 of GH-516).
 *
 * Scenario (verbatim title required by task-next.js RED gate):
 *   - tasks-gate routes to split-in-tasks when same path is in scope for two
 *     peer tasks
 *
 * Mirrors `tasks-gate-intra-ticket.integration.test.js:84` — stages a
 * hand-crafted invalid tasks.md (Task 1 and Task 2 both declare
 * `components/X.tsx` under `### Files in scope`), drives the real
 * `tasksGateStep`, and asserts the gate routes to `/work-workflow:split-in-tasks`
 * with the conflicting path surfaced in the reason.
 *
 * Uses node:test + node:assert/strict.
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpDir;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-gate-unique-ownership-test-'));
}

function teardown() {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
}

// Two peer tasks BOTH claim `components/X.tsx` under `### Files in scope`.
// `validateUniqueOwnership` must flag this and tasks-gate must route to
// split-in-tasks (RUN), not silently DEFER.
const INVALID_TASKS_MD = `# Tasks (hand-crafted invalid for unique-ownership conflict)

## Task 1 — Render component X

### Type
frontend

### Files in scope
- \`components/X.tsx\`

### Deliverables
- [ ] 1.1 **GREEN:** render X
  - Test: \`<X />\` renders

### Test Command
\`\`\`bash
CHANGED_FILES="components/X.test.tsx" eval "$TEST_UNIT_COMMAND"
\`\`\`

---

## Task 2 — Style component X

### Type
frontend

### Files in scope
- \`components/X.tsx\`

### Deliverables
- [ ] 2.1 **GREEN:** style X
  - Test: \`<X />\` has class

### Test Command
\`\`\`bash
CHANGED_FILES="components/X.test.tsx" eval "$TEST_UNIT_COMMAND"
\`\`\`
`;

describe('tasks-gate unique-ownership routing', () => {
  beforeEach(() => setup());
  afterEach(() => teardown());

  it('tasks-gate routes to split-in-tasks when same path is in scope for two peer tasks', () => {
    fs.writeFileSync(path.join(tmpDir, 'tasks.md'), INVALID_TASKS_MD, 'utf8');

    const tasksGateStep = require('../steps/tasks-gate');
    const STEPS = { tasks_gate: 'tasks_gate' };
    const calls = [];
    const add = (step, decision, agent, reason, opts) =>
      calls.push({ step, decision, agent, reason, opts });

    tasksGateStep(
      add,
      { hasTasks: true },
      {
        STEPS,
        tasksDir: tmpDir,
        path,
      }
    );

    assert.equal(calls.length, 1, `expected exactly one add() call; got ${JSON.stringify(calls)}`);
    const [c] = calls;
    assert.equal(c.step, 'tasks_gate');
    assert.equal(
      c.decision,
      'RUN',
      `gate must RUN split-in-tasks for unique-ownership conflict, not DEFER; got ${JSON.stringify(c)}`
    );
    assert.equal(c.agent, '/work-workflow:split-in-tasks');
    assert.match(
      c.reason,
      /components\/X\.tsx/,
      `RUN reason must surface the conflicting file path; got: ${c.reason}`
    );
    assert.match(
      c.reason,
      /\bTask\s*1\b/i,
      `RUN reason must name Task 1 (peer owner A); got: ${c.reason}`
    );
    assert.match(
      c.reason,
      /\bTask\s*2\b/i,
      `RUN reason must name Task 2 (peer owner B); got: ${c.reason}`
    );
    // The reason must invoke the unique-ownership rule by name. Task 1's
    // validator emits the doc anchor as `Unique-ownership rule` (hyphenated,
    // capitalized); accept either hyphen or space and any case.
    assert.match(
      c.reason,
      /unique[-\s]ownership/i,
      `RUN reason must invoke the unique-ownership rule by name; got: ${c.reason}`
    );
  });
});
