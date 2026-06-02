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
