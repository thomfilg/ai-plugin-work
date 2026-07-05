'use strict';

/**
 * work-implement-enforce.js × GH-570 ablation-RED (W1×W8 interaction).
 *
 * The registered RED-phase file gate ("only .test or .spec files during
 * RED") would deadlock `red-mode: ablation` tasks, whose RED evidence is
 * produced by TEMPORARILY mutating an in-scope SOURCE file. The hook must
 * allow that mutation — machine-verified from planner-owned tasks.md via
 * the SHARED implement-gate resolver, scope-limited to the task's
 * `### Files in scope`, and audit-logged — while a non-ablation task's
 * source edit during RED stays blocked.
 *
 * Run with:
 *   node --test scripts/workflows/work-implement/__tests__/work-implement-enforce-ablation.integration.test.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'work-implement-enforce.js');
const TICKET = 'TEST-ABLHOOK';

let tempBase;
let ticketDir;
let worktreeDir;
let transcriptPath;

function writeWorkState() {
  fs.writeFileSync(
    path.join(ticketDir, '.work' + '-state.json'),
    JSON.stringify({
      ticketId: TICKET,
      status: 'in_progress',
      currentStep: 4,
      stepStatus: { bootstrap: 'completed', implement: 'in_progress' },
    })
  );
}

function writeTasksMd({ redMode }) {
  fs.writeFileSync(
    path.join(ticketDir, 'tasks.md'),
    [
      '## Task 1 — Pin existing feature behavior',
      '',
      '### Type',
      'tdd-code',
      '',
      '### Files in scope',
      '- src/feature.js',
      '- src/feature.test.js',
      '',
      '### Test Strategy',
      '```',
      'kind: custom',
      'command: node check.js',
      ...(redMode ? [`red-mode: ${redMode}`] : []),
      '```',
      '',
    ].join('\n')
  );
}

function writeRedPhaseState() {
  const taskDir = path.join(ticketDir, 'task1');
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(
    path.join(taskDir, 'tdd' + '-phase.json'),
    JSON.stringify({ currentPhase: 'red', currentCycle: 1, cycles: [] })
  );
}

function readAuditRows() {
  const p = path.join(ticketDir, '.work' + '-actions.json');
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function runHook(filePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [HOOK_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        TASKS_BASE: tempBase,
        TICKET_ID: TICKET,
        WORK_TASK_NUM: '1',
        WORK_WORKTREE_DIR: worktreeDir,
      },
    });
    let stderr = '';
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('close', (code) => resolve({ code, stderr }));
    proc.on('error', reject);
    proc.stdin.write(
      JSON.stringify({
        tool_name: 'Edit',
        tool_input: { file_path: filePath },
        transcript_path: transcriptPath,
      })
    );
    proc.stdin.end();
  });
}

describe('work-implement-enforce — ablation-RED source-edit allowance (W1×W8)', () => {
  beforeEach(() => {
    tempBase = fs.mkdtempSync(path.join(os.tmpdir(), 'wie-abl-'));
    ticketDir = path.join(tempBase, TICKET);
    fs.mkdirSync(ticketDir, { recursive: true });
    worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wie-abl-wt-'));
    fs.mkdirSync(path.join(worktreeDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(worktreeDir, 'src', 'feature.js'), 'module.exports = () => 1;\n');
    transcriptPath = path.join(tempBase, 'transcript.jsonl');
    fs.writeFileSync(transcriptPath, '"subagent_type": "developer-nodejs-tdd"\n');
    writeWorkState();
    writeRedPhaseState();
  });

  afterEach(() => {
    fs.rmSync(tempBase, { recursive: true, force: true });
    fs.rmSync(worktreeDir, { recursive: true, force: true });
  });

  it('allows an in-scope source edit during RED for an ablation task (audited)', async () => {
    writeTasksMd({ redMode: 'ablation' });
    const { code, stderr } = await runHook(path.join(worktreeDir, 'src', 'feature.js'));
    assert.equal(code, 0, `expected allow, got exit ${code}: ${stderr}`);

    const rows = readAuditRows().filter(
      (r) => r && r.allow === true && String(r.reason || '').includes('ABLATION_RED_SOURCE_EDIT')
    );
    assert.equal(rows.length, 1, 'the fired allowance must be audit-logged');
  });

  it('still blocks the same source edit during RED for a non-ablation task', async () => {
    writeTasksMd({ redMode: null });
    const { code, stderr } = await runHook(path.join(worktreeDir, 'src', 'feature.js'));
    assert.equal(code, 2, 'non-ablation RED source edit must stay blocked');
    assert.match(stderr, /RED phase/);
  });

  it('blocks an OUT-of-scope source edit during RED even for an ablation task', async () => {
    writeTasksMd({ redMode: 'ablation' });
    fs.writeFileSync(path.join(worktreeDir, 'src', 'other.js'), 'module.exports = 2;\n');
    const { code, stderr } = await runHook(path.join(worktreeDir, 'src', 'other.js'));
    assert.equal(code, 2, 'the allowance is scope-limited to Files in scope');
    assert.match(stderr, /RED phase/);
  });

  it('blocks edits outside the worktree even for an ablation task', async () => {
    writeTasksMd({ redMode: 'ablation' });
    const outside = path.join(os.tmpdir(), 'wie-abl-outside-src', 'feature.js');
    fs.mkdirSync(path.dirname(outside), { recursive: true });
    fs.writeFileSync(outside, 'x\n');
    const { code } = await runHook(outside);
    assert.equal(code, 2, 'paths that do not resolve inside the worktree stay blocked');
    fs.rmSync(path.dirname(outside), { recursive: true, force: true });
  });
});
