/**
 * Tests for work-next.js PR-merged short-circuit (Task 8 of GH-398).
 *
 * Acceptance Criteria:
 *   - When `gh pr view --json state` returns `{ state: "MERGED" }`,
 *     work-next.js advances to `complete` via the supported transition path
 *     regardless of intermediate gate state.
 *   - When `gh` exits non-zero / network failure: fall back to existing
 *     behavior. No block on gh errors (fail-open).
 *
 * Strategy: A PATH shim directory provides a fake `gh` executable; the test
 * supplies either a MERGED JSON payload or a non-zero exit to validate
 * both branches.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const pathMod = require('node:path');

const WORK_NEXT = pathMod.join(__dirname, '..', 'work-next.js');

function makeShimDir(tmpRoot, shScript) {
  const shimDir = fs.mkdtempSync(pathMod.join(tmpRoot, 'shim-'));
  const ghPath = pathMod.join(shimDir, 'gh');
  fs.writeFileSync(ghPath, shScript, { mode: 0o755 });
  fs.chmodSync(ghPath, 0o755);
  return shimDir;
}

function runWorkNext(ticket, tmpBase, shimDir) {
  const env = {
    ...process.env,
    TASKS_BASE: tmpBase,
    SESSION_GUARD_ENABLED: '0',
    TICKET_PROVIDER: 'jira',
    TICKET_PROJECT_KEY: 'ECHO',
    PATH: `${shimDir}:${process.env.PATH || ''}`,
  };
  delete env.CLAUDE_PLUGIN_ROOT;
  const res = spawnSync(process.execPath, [WORK_NEXT, ticket], {
    encoding: 'utf8',
    timeout: 15000,
    env,
  });
  const stdout = String(res.stdout || '');
  const objects = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < stdout.length; i++) {
    const ch = stdout[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        objects.push(stdout.slice(start, i + 1));
        start = -1;
      }
    }
  }
  const last = objects[objects.length - 1];
  const parsed = last ? JSON.parse(last) : null;
  return { res, stdout, stderr: String(res.stderr || ''), parsed };
}

/**
 * Write an in_progress state for a non-terminal step. Without the PR-merged
 * short-circuit, work-next will NOT return action:complete here. With it,
 * a MERGED gh response advances to complete.
 */
function writeInProgressState(tmpBase, ticket) {
  const ticketDir = pathMod.join(tmpBase, ticket);
  fs.mkdirSync(ticketDir, { recursive: true });
  const state = {
    ticketId: ticket,
    ticketBase: ticket,
    ticketSuffix: null,
    ticketSeparator: '-',
    description: 'test',
    currentStep: 12,
    status: 'in_progress',
    stepStatus: {
      ticket: 'completed',
      bootstrap: 'completed',
      brief: 'completed',
      brief_gate: 'completed',
      spec: 'completed',
      spec_gate: 'completed',
      tasks: 'completed',
      tasks_gate: 'completed',
      implement: 'completed',
      commit: 'completed',
      task_review: 'completed',
      check: 'completed',
      pr: 'in_progress',
      ready: 'pending',
      follow_up: 'pending',
      ci: 'pending',
      cleanup: 'pending',
      reports: 'pending',
      complete: 'pending',
    },
    checkProgress: {},
    errors: [],
    startTime: new Date().toISOString(),
  };
  fs.writeFileSync(pathMod.join(ticketDir, '.work-state.json'), JSON.stringify(state, null, 2));
  return state;
}

describe('work-next.js — PR-merged short-circuit (Task 8)', () => {
  it('advances to complete when gh pr view reports MERGED', () => {
    const tmpBase = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'work-next-pr-merged-'));
    try {
      writeInProgressState(tmpBase, 'ECHO-8001');
      // ECHO-5218 fix: short-circuit now requires ci-phase.json currentPhase === 'done'
      fs.writeFileSync(
        pathMod.join(tmpBase, 'ECHO-8001', 'ci-phase.json'),
        JSON.stringify({ currentPhase: 'done', phases: { done: { recordedAt: 'x' } } })
      );
      const shScript = `#!/usr/bin/env bash
# Fake gh: emit MERGED state regardless of args
echo '{"state":"MERGED"}'
exit 0
`;
      const shimDir = makeShimDir(tmpBase, shScript);
      // The probe requires the worktree dir to exist — create it so the
      // PR-merged short-circuit runs against the shimmed `gh` rather than
      // being skipped.
      const worktreesBase = pathMod.join(tmpBase, 'worktrees');
      const repoName = 'fake-repo';
      fs.mkdirSync(pathMod.join(worktreesBase, `${repoName}-ECHO-8001`), { recursive: true });
      const prevWB = process.env.WORKTREES_BASE;
      const prevRN = process.env.REPO_NAME;
      process.env.WORKTREES_BASE = worktreesBase;
      process.env.REPO_NAME = repoName;
      let parsed, stderr;
      try {
        ({ parsed, stderr } = runWorkNext('ECHO-8001', tmpBase, shimDir));
      } finally {
        if (prevWB === undefined) delete process.env.WORKTREES_BASE;
        else process.env.WORKTREES_BASE = prevWB;
        if (prevRN === undefined) delete process.env.REPO_NAME;
        else process.env.REPO_NAME = prevRN;
      }
      assert.ok(parsed, `expected JSON output, got stderr: ${stderr}`);
      assert.equal(
        parsed.action,
        'complete',
        `expected action=complete, got: ${JSON.stringify(parsed)}`
      );
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it('skips gh pr view probe entirely when worktree dir does not exist', () => {
    const tmpBase = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'work-next-pr-merged-no-wt-'));
    try {
      writeInProgressState(tmpBase, 'ECHO-8003');
      // Point WORKTREES_BASE at a directory where the expected
      // `${REPO_NAME}-${safeBase}` folder definitively does NOT exist.
      const fakeWorktreesBase = pathMod.join(tmpBase, 'no-worktrees-here');
      fs.mkdirSync(fakeWorktreesBase, { recursive: true });

      // Shim gh to ALWAYS return MERGED. If the probe runs (i.e. the
      // process.cwd() fallback path is taken), the state would be mutated
      // to completed. With the fix, the probe is skipped and state stays
      // as in_progress with PR step still in_progress.
      const callLog = pathMod.join(tmpBase, 'gh-calls.log');
      const shScript = `#!/usr/bin/env bash
echo "$@" >> ${JSON.stringify(callLog)}
echo '{"state":"MERGED"}'
exit 0
`;
      const shimDir = makeShimDir(tmpBase, shScript);

      const env = {
        ...process.env,
        TASKS_BASE: tmpBase,
        WORKTREES_BASE: fakeWorktreesBase,
        REPO_NAME: 'fake-repo-no-such-worktree',
        SESSION_GUARD_ENABLED: '0',
        TICKET_PROVIDER: 'jira',
        TICKET_PROJECT_KEY: 'ECHO',
        PATH: `${shimDir}:${process.env.PATH || ''}`,
      };
      delete env.CLAUDE_PLUGIN_ROOT;
      spawnSync(process.execPath, [WORK_NEXT, 'ECHO-8003'], {
        encoding: 'utf8',
        timeout: 15000,
        env,
      });

      // Probe must not have called `gh pr view`. The log file may have
      // entries from OTHER gh calls in work-next (e.g. unrelated provider
      // probes), so assert specifically that no `pr view` invocation exists.
      const log = fs.existsSync(callLog) ? fs.readFileSync(callLog, 'utf8') : '';
      assert.ok(
        !/\bpr\s+view\b/.test(log),
        `expected no \`gh pr view\` invocation when worktree missing; gh call log was:\n${log}`
      );

      // State must NOT have been mutated to completed.
      const stateAfter = JSON.parse(
        fs.readFileSync(pathMod.join(tmpBase, 'ECHO-8003', '.work-state.json'), 'utf8')
      );
      assert.notEqual(
        stateAfter.status,
        'completed',
        'PR-merged probe should not have mutated state when worktree dir is missing'
      );
      assert.notEqual(
        stateAfter.stepStatus.pr,
        'completed',
        'pr step should remain in_progress when probe is skipped'
      );
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it('does NOT short-circuit when ci-phase.json is missing (ECHO-5218 fix)', () => {
    const tmpBase = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'work-next-pr-merged-no-phase-'));
    try {
      writeInProgressState(tmpBase, 'ECHO-8101');
      const shScript = `#!/usr/bin/env bash
echo '{"state":"MERGED"}'
exit 0
`;
      const shimDir = makeShimDir(tmpBase, shScript);
      const worktreesBase = pathMod.join(tmpBase, 'worktrees');
      const repoName = 'fake-repo';
      fs.mkdirSync(pathMod.join(worktreesBase, `${repoName}-ECHO-8101`), { recursive: true });
      const env = {
        ...process.env,
        TASKS_BASE: tmpBase,
        WORKTREES_BASE: worktreesBase,
        REPO_NAME: repoName,
        SESSION_GUARD_ENABLED: '0',
        TICKET_PROVIDER: 'jira',
        TICKET_PROJECT_KEY: 'ECHO',
        PATH: `${shimDir}:${process.env.PATH || ''}`,
      };
      delete env.CLAUDE_PLUGIN_ROOT;
      const res = spawnSync(process.execPath, [WORK_NEXT, 'ECHO-8101'], {
        encoding: 'utf8',
        timeout: 15000,
        env,
      });
      const stateAfter = JSON.parse(
        fs.readFileSync(pathMod.join(tmpBase, 'ECHO-8101', '.work-state.json'), 'utf8')
      );
      assert.notEqual(
        stateAfter.status,
        'completed',
        `short-circuit must NOT fire without ci-phase.json done (stderr=${res.stderr})`
      );
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it('does NOT short-circuit when ci-phase.json currentPhase !== done', () => {
    const tmpBase = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'work-next-pr-merged-wait-phase-'));
    try {
      writeInProgressState(tmpBase, 'ECHO-8102');
      // Simulate the orchestrator paused inside ci sub-workflow at wait_merge
      fs.writeFileSync(
        pathMod.join(tmpBase, 'ECHO-8102', 'ci-phase.json'),
        JSON.stringify({ currentPhase: 'wait_merge', phases: {} })
      );
      const shScript = `#!/usr/bin/env bash
echo '{"state":"MERGED"}'
exit 0
`;
      const shimDir = makeShimDir(tmpBase, shScript);
      const worktreesBase = pathMod.join(tmpBase, 'worktrees');
      const repoName = 'fake-repo';
      fs.mkdirSync(pathMod.join(worktreesBase, `${repoName}-ECHO-8102`), { recursive: true });
      const env = {
        ...process.env,
        TASKS_BASE: tmpBase,
        WORKTREES_BASE: worktreesBase,
        REPO_NAME: repoName,
        SESSION_GUARD_ENABLED: '0',
        TICKET_PROVIDER: 'jira',
        TICKET_PROJECT_KEY: 'ECHO',
        PATH: `${shimDir}:${process.env.PATH || ''}`,
      };
      delete env.CLAUDE_PLUGIN_ROOT;
      spawnSync(process.execPath, [WORK_NEXT, 'ECHO-8102'], {
        encoding: 'utf8',
        timeout: 15000,
        env,
      });
      const stateAfter = JSON.parse(
        fs.readFileSync(pathMod.join(tmpBase, 'ECHO-8102', '.work-state.json'), 'utf8')
      );
      assert.notEqual(
        stateAfter.status,
        'completed',
        'short-circuit must NOT fire when ci sub-workflow is mid-flight (wait_merge)'
      );
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it('DOES short-circuit when ci-phase.json currentPhase === done AND PR MERGED', () => {
    const tmpBase = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'work-next-pr-merged-done-phase-'));
    try {
      writeInProgressState(tmpBase, 'ECHO-8103');
      fs.writeFileSync(
        pathMod.join(tmpBase, 'ECHO-8103', 'ci-phase.json'),
        JSON.stringify({ currentPhase: 'done', phases: { done: { recordedAt: 'x' } } })
      );
      const shScript = `#!/usr/bin/env bash
echo '{"state":"MERGED"}'
exit 0
`;
      const shimDir = makeShimDir(tmpBase, shScript);
      const worktreesBase = pathMod.join(tmpBase, 'worktrees');
      const repoName = 'fake-repo';
      fs.mkdirSync(pathMod.join(worktreesBase, `${repoName}-ECHO-8103`), { recursive: true });
      const prevWB = process.env.WORKTREES_BASE;
      const prevRN = process.env.REPO_NAME;
      process.env.WORKTREES_BASE = worktreesBase;
      process.env.REPO_NAME = repoName;
      let parsed, stderr;
      try {
        ({ parsed, stderr } = runWorkNext('ECHO-8103', tmpBase, shimDir));
      } finally {
        if (prevWB === undefined) delete process.env.WORKTREES_BASE;
        else process.env.WORKTREES_BASE = prevWB;
        if (prevRN === undefined) delete process.env.REPO_NAME;
        else process.env.REPO_NAME = prevRN;
      }
      assert.ok(parsed, `expected JSON output, got stderr: ${stderr}`);
      assert.equal(
        parsed.action,
        'complete',
        `expected action=complete when phase=done AND merged; got: ${JSON.stringify(parsed)}`
      );
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it('falls back to existing behavior when gh exits non-zero (fail-open)', () => {
    const tmpBase = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'work-next-pr-merged-fail-'));
    try {
      writeInProgressState(tmpBase, 'ECHO-8002');
      const shScript = `#!/usr/bin/env bash
# Fake gh: simulate auth missing / network failure
echo "gh: authentication required" 1>&2
exit 4
`;
      const shimDir = makeShimDir(tmpBase, shScript);
      const { parsed } = runWorkNext('ECHO-8002', tmpBase, shimDir);
      assert.ok(parsed, 'expected JSON output');
      // gh failed → no short-circuit; action must NOT be 'complete'.
      // (Existing behavior would emit a plan instruction for the in-progress step,
      // typically action='delegate'/'blocked'/etc. — anything BUT 'complete'.)
      assert.notEqual(
        parsed.action,
        'complete',
        `expected non-complete fall-through on gh failure, got: ${JSON.stringify(parsed)}`
      );
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });
});
