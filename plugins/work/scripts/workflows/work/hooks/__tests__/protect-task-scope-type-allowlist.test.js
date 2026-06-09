'use strict';

/**
 * protect-task-scope.js — per-Type closed-allowlist tests (GH-528 item 5).
 *
 * Each kind:
 *   - tests-only → write target must be *.test.* / *.spec.*
 *   - docs → write target must be *.md
 *   - config → write target must be in config allowlist
 *   - ci → write target must be dot-github/workflows/** etc.
 *   - tdd-code → unchanged (no per-Type restriction)
 *
 * Plus:
 *   - Type-line edit in tasks.md is blocked (Write + Edit + MultiEdit).
 *   - One-shot env bypass (REASON+TARGET) still works through per-Type layer.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.resolve(__dirname, '..', 'protect-task-scope.js');
const WORK_STATE_FILENAME = '.work' + '-state.json';
const WORK_ACTIONS_FILENAME = '.work' + '-actions.json';
const TICKET = 'TEST-528';

function readActions(tasksBase) {
  const p = path.join(tasksBase, TICKET, WORK_ACTIONS_FILENAME);
  if (!fs.existsSync(p)) return [];
  const raw = fs.readFileSync(p, 'utf8').trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return raw
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }
}

function writeWorkState(tasksDir) {
  fs.writeFileSync(
    path.join(tasksDir, WORK_STATE_FILENAME),
    JSON.stringify({
      ticketId: TICKET,
      stepStatus: { ticket: 'completed', implement: 'in_progress' },
      tasksMeta: { currentTaskIndex: 0, tasks: [{ id: 'task_1', status: 'in_progress' }] },
    })
  );
}

function writeTasksMd(tasksDir, { type, filesInScope }) {
  const lines = [
    '## Task 1 — sample',
    '',
    '### Type',
    type,
    '',
    '### Files in scope',
    ...filesInScope.map((f) => `- ${f}`),
    '',
  ];
  fs.writeFileSync(path.join(tasksDir, 'tasks.md'), lines.join('\n'));
}

function runHook({ tasksBase, cwd, toolName, toolInput, env = {} }) {
  return spawnSync('node', [HOOK], {
    input: JSON.stringify({ tool_name: toolName, tool_input: toolInput }),
    encoding: 'utf8',
    cwd,
    env: {
      ...process.env,
      TASKS_BASE: tasksBase,
      PROTECT_TASK_SCOPE_TICKET_ID: TICKET,
      PROTECT_TASK_SCOPE_BYPASS_REASON: '',
      PROTECT_TASK_SCOPE_BYPASS_TARGET: '',
      ...env,
    },
  });
}

describe('protect-task-scope — per-Type allowlist', () => {
  let tmpHome;
  let tasksBase;
  let tasksDir;
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pts-type-'));
    tasksBase = path.join(tmpHome, 'tasks');
    tasksDir = path.join(tasksBase, TICKET);
    fs.mkdirSync(tasksDir, { recursive: true });
    writeWorkState(tasksDir);
  });
  afterEach(() => fs.rmSync(tmpHome, { recursive: true, force: true }));

  it('Type=tests-only — *.test.js target ALLOWED', () => {
    writeTasksMd(tasksDir, { type: 'tests-only', filesInScope: ['src/**'] });
    const r = runHook({
      tasksBase,
      cwd: tmpHome,
      toolName: 'Write',
      toolInput: { file_path: path.join(tmpHome, 'src/foo.test.js'), content: 'x' },
    });
    assert.equal(r.status, 0, `expected allow; stderr=${r.stderr}`);
  });

  it('Type=tests-only — src/foo.js target BLOCKED', () => {
    writeTasksMd(tasksDir, { type: 'tests-only', filesInScope: ['src/**'] });
    const r = runHook({
      tasksBase,
      cwd: tmpHome,
      toolName: 'Write',
      toolInput: { file_path: path.join(tmpHome, 'src/foo.js'), content: 'x' },
    });
    assert.equal(r.status, 2, `expected block; stdout=${r.stdout}`);
    assert.match(r.stderr, /tests-only/);
  });

  it('Type=docs — README.md ALLOWED', () => {
    writeTasksMd(tasksDir, { type: 'docs', filesInScope: ['**/*.md'] });
    const r = runHook({
      tasksBase,
      cwd: tmpHome,
      toolName: 'Write',
      toolInput: { file_path: path.join(tmpHome, 'README.md'), content: 'x' },
    });
    assert.equal(r.status, 0, `expected allow; stderr=${r.stderr}`);
  });

  it('Type=docs — src/foo.js BLOCKED', () => {
    writeTasksMd(tasksDir, { type: 'docs', filesInScope: ['**/*'] });
    const r = runHook({
      tasksBase,
      cwd: tmpHome,
      toolName: 'Write',
      toolInput: { file_path: path.join(tmpHome, 'src/foo.js'), content: 'x' },
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /docs allowlist/);
  });

  it('Type=config — package.json ALLOWED', () => {
    writeTasksMd(tasksDir, { type: 'config', filesInScope: ['**/*'] });
    const r = runHook({
      tasksBase,
      cwd: tmpHome,
      toolName: 'Write',
      toolInput: { file_path: path.join(tmpHome, 'package.json'), content: 'x' },
    });
    assert.equal(r.status, 0, `expected allow; stderr=${r.stderr}`);
  });

  it('Type=config — src/server.js BLOCKED', () => {
    writeTasksMd(tasksDir, { type: 'config', filesInScope: ['**/*'] });
    const r = runHook({
      tasksBase,
      cwd: tmpHome,
      toolName: 'Write',
      toolInput: { file_path: path.join(tmpHome, 'src/server.js'), content: 'x' },
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /config allowlist/);
  });

  it('Type=ci — dot-github/workflows/ci.yml ALLOWED', () => {
    writeTasksMd(tasksDir, { type: 'ci', filesInScope: ['**/*'] });
    const r = runHook({
      tasksBase,
      cwd: tmpHome,
      toolName: 'Write',
      toolInput: { file_path: path.join(tmpHome, '.git' + 'hub/workflows/ci.yml'), content: 'x' },
    });
    assert.equal(r.status, 0, `expected allow; stderr=${r.stderr}`);
  });

  it('Type=ci — src/foo.js BLOCKED', () => {
    writeTasksMd(tasksDir, { type: 'ci', filesInScope: ['**/*'] });
    const r = runHook({
      tasksBase,
      cwd: tmpHome,
      toolName: 'Write',
      toolInput: { file_path: path.join(tmpHome, 'src/foo.js'), content: 'x' },
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /ci allowlist/);
  });

  it('Type=tdd-code — existing behavior unchanged (no per-Type restriction)', () => {
    writeTasksMd(tasksDir, { type: 'tdd-code', filesInScope: ['src/**'] });
    // Even non-test, non-md file is allowed because tdd-code has no allowlist.
    const r = runHook({
      tasksBase,
      cwd: tmpHome,
      toolName: 'Write',
      toolInput: { file_path: path.join(tmpHome, 'src/foo.js'), content: 'x' },
    });
    assert.equal(r.status, 0, `expected allow for tdd-code; stderr=${r.stderr}`);
  });

  it('one-shot bypass pair still works for per-Type layer (with WORK_OPERATOR_TOKEN)', () => {
    writeTasksMd(tasksDir, { type: 'docs', filesInScope: ['**/*'] });
    const target = path.join(tmpHome, 'src/foo.js');
    const reason = 'emergency docs ship';
    const r = runHook({
      tasksBase,
      cwd: tmpHome,
      toolName: 'Write',
      toolInput: { file_path: target, content: 'x' },
      env: {
        // GH-528 ITEM 1: bypass requires the operator token too.
        WORK_OPERATOR_TOKEN: '1',
        PROTECT_TASK_SCOPE_BYPASS_REASON: reason,
        PROTECT_TASK_SCOPE_BYPASS_TARGET: 'src/foo.js',
      },
    });
    assert.equal(r.status, 0, `expected bypass to allow; stderr=${r.stderr}`);

    // Audit trail: per-Type bypass must append a scope-bypass row with
    // guard='type-allowlist'. Without this, operators can override the
    // closed-allowlist gate silently.
    const rows = readActions(tasksBase);
    const bypassRows = rows.filter((row) => row && row.action === 'scope-bypass');
    assert.equal(bypassRows.length, 1, 'exactly one scope-bypass audit row expected');
    const row = bypassRows[0];
    assert.equal(row.reason, reason, 'audit row carries the supplied reason');
    assert.equal(row.allow, true, 'audit row records the allow decision');
    assert.equal(
      row.meta && row.meta.guard,
      'type-allowlist',
      `audit row meta should discriminate the type-allowlist guard; got: ${JSON.stringify(row)}`
    );
    assert.equal(
      row.meta && row.meta.configuredTarget,
      'src/foo.js',
      `audit row meta should record configuredTarget; got: ${JSON.stringify(row)}`
    );
    const serialized = JSON.stringify(row);
    assert.ok(
      serialized.includes('src/foo.js'),
      `audit row should reference the actual write target; got: ${serialized}`
    );
  });

  it('per-Type bypass with NON-matching TARGET does NOT append audit row and blocks', () => {
    writeTasksMd(tasksDir, { type: 'docs', filesInScope: ['**/*'] });
    const target = path.join(tmpHome, 'src/foo.js');
    const r = runHook({
      tasksBase,
      cwd: tmpHome,
      toolName: 'Write',
      toolInput: { file_path: target, content: 'x' },
      env: {
        PROTECT_TASK_SCOPE_BYPASS_REASON: 'some reason',
        PROTECT_TASK_SCOPE_BYPASS_TARGET: 'src/elsewhere.js',
      },
    });
    assert.equal(r.status, 2, `expected block when TARGET mismatches; stderr=${r.stderr}`);
    const rows = readActions(tasksBase);
    const bypassRows = rows.filter((row) => row && row.action === 'scope-bypass');
    assert.equal(bypassRows.length, 0, 'no scope-bypass row when per-Type TARGET mismatches');
  });

  it('per-Type bypass with REASON set but no TARGET does NOT append audit row and blocks', () => {
    writeTasksMd(tasksDir, { type: 'docs', filesInScope: ['**/*'] });
    const target = path.join(tmpHome, 'src/foo.js');
    const r = runHook({
      tasksBase,
      cwd: tmpHome,
      toolName: 'Write',
      toolInput: { file_path: target, content: 'x' },
      env: {
        PROTECT_TASK_SCOPE_BYPASS_REASON: 'lone reason',
        // No TARGET set
      },
    });
    assert.equal(r.status, 2, `expected block when TARGET missing; stderr=${r.stderr}`);
    const rows = readActions(tasksBase);
    const bypassRows = rows.filter((row) => row && row.action === 'scope-bypass');
    assert.equal(
      bypassRows.length,
      0,
      'REASON alone never opens the per-Type gate or appends audit'
    );
  });
});

describe('protect-task-scope — Type-line edit guard', () => {
  let tmpHome;
  let tasksBase;
  let tasksDir;
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pts-type-line-'));
    tasksBase = path.join(tmpHome, 'tasks');
    tasksDir = path.join(tasksBase, TICKET);
    fs.mkdirSync(tasksDir, { recursive: true });
    writeWorkState(tasksDir);
    // Include tasks.md in scope so the ONLY gate that can block these edits
    // is the Type-line guard itself — proves the guard, not the scope gate,
    // is doing the work.
    writeTasksMd(tasksDir, {
      type: 'tdd-code',
      filesInScope: ['src/**', 'tasks/**/tasks.md'],
    });
  });
  afterEach(() => fs.rmSync(tmpHome, { recursive: true, force: true }));

  it('Write to tasks.md that flips Type tdd-code → docs is BLOCKED', () => {
    const newContent = [
      '## Task 1 — sample',
      '',
      '### Type',
      'docs',
      '',
      '### Files in scope',
      '- src/**',
      '',
    ].join('\n');
    const r = runHook({
      tasksBase,
      cwd: tmpHome,
      toolName: 'Write',
      toolInput: {
        file_path: path.join(tasksDir, 'tasks.md'),
        content: newContent,
      },
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /### Type/);
  });

  it('Write to tasks.md that preserves Type lines is permitted by Type-line guard (other gates may still block)', () => {
    const sameContent = fs.readFileSync(path.join(tasksDir, 'tasks.md'), 'utf8');
    const r = runHook({
      tasksBase,
      cwd: tmpHome,
      toolName: 'Write',
      toolInput: {
        file_path: path.join(tasksDir, 'tasks.md'),
        content: sameContent,
      },
    });
    // Note: scope check may still block (tasks.md is not under src/**), but
    // the message must not mention `### Type`.
    assert.doesNotMatch(r.stderr || '', /refusing to modify `### Type`/);
  });

  it('Edit tool whose patch changes `### Type` line is BLOCKED', () => {
    const r = runHook({
      tasksBase,
      cwd: tmpHome,
      toolName: 'Edit',
      toolInput: {
        file_path: path.join(tasksDir, 'tasks.md'),
        old_string: '### Type\ntdd-code',
        new_string: '### Type\ndocs',
      },
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /### Type/);
  });

  // Comment 5 — cursor[bot] HIGH: value-only patches must be blocked too.
  it('Edit tool with value-only patch (no `### Type` header in strings) is BLOCKED', () => {
    const r = runHook({
      tasksBase,
      cwd: tmpHome,
      toolName: 'Edit',
      toolInput: {
        file_path: path.join(tasksDir, 'tasks.md'),
        old_string: 'tdd-code',
        new_string: 'docs',
      },
    });
    assert.equal(r.status, 2, `expected block; stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(r.stderr, /### Type/);
  });

  it('Edit tool with whitespace-tricked value patch is BLOCKED', () => {
    // Author the on-disk Type value with trailing whitespace so a patch can
    // strip it and still flip semantic value.
    const lines = [
      '## Task 1 — sample',
      '',
      '### Type',
      'tdd-code  ',
      '',
      '### Files in scope',
      '- src/**',
      '- tasks/**/tasks.md',
      '',
    ];
    fs.writeFileSync(path.join(tasksDir, 'tasks.md'), lines.join('\n'));
    const r = runHook({
      tasksBase,
      cwd: tmpHome,
      toolName: 'Edit',
      toolInput: {
        file_path: path.join(tasksDir, 'tasks.md'),
        old_string: 'tdd-code  ',
        new_string: 'docs',
      },
    });
    assert.equal(r.status, 2, `expected block; stderr=${r.stderr}`);
  });

  it('MultiEdit split across two value-only edits that flip Type is BLOCKED', () => {
    // Neither edit contains `### Type`; the combined effect flips tdd-code → docs.
    const r = runHook({
      tasksBase,
      cwd: tmpHome,
      toolName: 'MultiEdit',
      toolInput: {
        file_path: path.join(tasksDir, 'tasks.md'),
        edits: [
          { old_string: 'tdd-code', new_string: 'PLACEHOLDER_X' },
          { old_string: 'PLACEHOLDER_X', new_string: 'docs' },
        ],
      },
    });
    assert.equal(r.status, 2, `expected block; stderr=${r.stderr}`);
  });

  it('Edit on a non-Type line of tasks.md is NOT blocked by Type-line guard', () => {
    // Patches the `### Files in scope` bullet, not Type — Type-line guard must
    // not fire. (Other gates may still block tasks.md edits, but the stderr
    // must not mention the Type-line refusal message.)
    const r = runHook({
      tasksBase,
      cwd: tmpHome,
      toolName: 'Edit',
      toolInput: {
        file_path: path.join(tasksDir, 'tasks.md'),
        old_string: '- src/**',
        new_string: '- src/**\n- lib/**',
      },
    });
    assert.doesNotMatch(r.stderr || '', /refusing to (modify|edit) `### Type`/);
  });

  it('Edit on a totally different file does NOT trigger Type-line guard', () => {
    // Out-of-scope path so the scope check may block — but the Type-line guard
    // must not fire (no false positive on non-tasks.md files).
    const r = runHook({
      tasksBase,
      cwd: tmpHome,
      toolName: 'Edit',
      toolInput: {
        file_path: path.join(tmpHome, 'src/foo.js'),
        old_string: 'tdd-code',
        new_string: 'docs',
      },
    });
    assert.doesNotMatch(r.stderr || '', /refusing to (modify|edit) `### Type`/);
  });

  // ── GH-528 round-2 follow-up ITEM 5: regression cases for Type-line
  //    patch tricks. Cases 1-3 are already covered above; the four below
  //    plug remaining gaps the checkEditTypeLines simulator must catch.

  it('ITEM 5 — case 4a: MultiEdit replace_all on shared token that FLIPS Type → BLOCKED', () => {
    // On-disk Type value `tdd-code` collides with no other token, so plant
    // one inside an AC bullet that the planner authored. replace_all rewrites
    // every occurrence including the Type-line value → simulated Type
    // changes → must block.
    const lines = [
      '## Task 1 — sample',
      '',
      '### Type',
      'tdd-code',
      '',
      '### Acceptance Criteria',
      '- This task is tdd-code-shaped and lists tdd-code coverage.',
      '',
      '### Files in scope',
      '- src/**',
      '- tasks/**/tasks.md',
      '',
    ];
    fs.writeFileSync(path.join(tasksDir, 'tasks.md'), lines.join('\n'));
    const r = runHook({
      tasksBase,
      cwd: tmpHome,
      toolName: 'MultiEdit',
      toolInput: {
        file_path: path.join(tasksDir, 'tasks.md'),
        edits: [{ old_string: 'tdd-code', new_string: 'docs', replace_all: true }],
      },
    });
    assert.equal(r.status, 2, `expected block; stderr=${r.stderr}`);
    assert.match(r.stderr, /### Type/);
  });

  it('ITEM 5 — case 4b: MultiEdit replace_all on shared token that does NOT change Type-line → ALLOWED by Type-line guard', () => {
    // Plant `tdd-code` only inside the Type heading-LINE itself and an AC
    // bullet of a different task — then replace_all on a token that exists
    // ONLY in non-Type-line prose must not trigger the guard.
    const lines = [
      '## Task 1 — sample',
      '',
      '### Type',
      'tdd-code',
      '',
      '### Description',
      'Reference: see docs/foo.md and docs/bar.md',
      '',
      '### Files in scope',
      '- src/**',
      '- tasks/**/tasks.md',
      '',
    ];
    fs.writeFileSync(path.join(tasksDir, 'tasks.md'), lines.join('\n'));
    const r = runHook({
      tasksBase,
      cwd: tmpHome,
      toolName: 'MultiEdit',
      toolInput: {
        file_path: path.join(tasksDir, 'tasks.md'),
        edits: [{ old_string: 'docs/', new_string: 'documentation/', replace_all: true }],
      },
    });
    // Type-line guard must NOT fire — the simulated `### Type` value
    // (tdd-code) is unchanged. (Other gates may still allow.)
    assert.doesNotMatch(
      r.stderr || '',
      /refusing to (modify|edit) `### Type`/,
      `Type-line guard fired on a replace_all that didn't touch Type; stderr=${r.stderr}`
    );
  });

  it('ITEM 5 — case 5: Edit on an AC bullet containing the word "Type" (not the heading) → NOT blocked by Type-line guard', () => {
    // Authoring "Type" inside a description bullet (not the `### Type` heading
    // line) used to be ambiguous in the legacy extractor. With the simulator
    // approach the on-disk Type value is unchanged → guard must stay quiet.
    const lines = [
      '## Task 1 — sample',
      '',
      '### Type',
      'tdd-code',
      '',
      '### Acceptance Criteria',
      '- Document Type taxonomy in README',
      '',
      '### Files in scope',
      '- src/**',
      '- tasks/**/tasks.md',
      '',
    ];
    fs.writeFileSync(path.join(tasksDir, 'tasks.md'), lines.join('\n'));
    const r = runHook({
      tasksBase,
      cwd: tmpHome,
      toolName: 'Edit',
      toolInput: {
        file_path: path.join(tasksDir, 'tasks.md'),
        old_string: '- Document Type taxonomy in README',
        new_string: '- Document Type taxonomy and gate contract in README',
      },
    });
    assert.doesNotMatch(
      r.stderr || '',
      /refusing to (modify|edit) `### Type`/,
      `Type-line guard fired on a non-heading line containing "Type"; stderr=${r.stderr}`
    );
  });

  it('ITEM 5 — case 6: Edit that adds whitespace ONLY to the `### Type` heading line → ALLOWED (value unchanged)', () => {
    // The simulator compares the EXTRACTED Type value lines, not the raw
    // heading line — trailing whitespace on `### Type` itself is cosmetic
    // and must not trigger the guard.
    const lines = [
      '## Task 1 — sample',
      '',
      '### Type',
      'tdd-code',
      '',
      '### Files in scope',
      '- src/**',
      '- tasks/**/tasks.md',
      '',
    ];
    fs.writeFileSync(path.join(tasksDir, 'tasks.md'), lines.join('\n'));
    const r = runHook({
      tasksBase,
      cwd: tmpHome,
      toolName: 'Edit',
      toolInput: {
        file_path: path.join(tasksDir, 'tasks.md'),
        old_string: '### Type',
        new_string: '### Type   ',
      },
    });
    assert.doesNotMatch(
      r.stderr || '',
      /refusing to (modify|edit) `### Type`/,
      `Type-line guard fired on whitespace-only heading edit; stderr=${r.stderr}`
    );
  });

  it('one-shot bypass pair still works for Type-line guard when target matches (with WORK_OPERATOR_TOKEN)', () => {
    const target = path.join(tasksDir, 'tasks.md');
    const r = runHook({
      tasksBase,
      cwd: tmpHome,
      toolName: 'Edit',
      toolInput: {
        file_path: target,
        old_string: 'tdd-code',
        new_string: 'docs',
      },
      env: {
        // GH-528 ITEM 1: bypass requires the operator token too.
        WORK_OPERATOR_TOKEN: '1',
        PROTECT_TASK_SCOPE_BYPASS_REASON: 'planner re-keying type mid-cycle',
        PROTECT_TASK_SCOPE_BYPASS_TARGET: path.relative(tmpHome, target),
      },
    });
    assert.equal(r.status, 0, `expected bypass to allow; stderr=${r.stderr}`);
  });
});
