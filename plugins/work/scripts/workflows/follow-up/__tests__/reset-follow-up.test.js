/**
 * Tests for reset-follow-up.js (Task 4 / GH-531).
 *
 * Covers the three RED scenarios from tasks.md:
 *   1. reset-follow-up wipes state without tripping protect-state-files
 *   2. reset-follow-up validates ticket id
 *   3. reset-follow-up is idempotent when state files are already gone
 *
 * The module is invoked as a CLI via `child_process.spawn` so we exercise the
 * exit code + stdout/stderr contract surfaced to workflow-engine.js.
 *
 * node:test + node:assert/strict; isolated TASKS_BASE via fs.mkdtempSync.
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MODULE_PATH = path.join(__dirname, '..', 'reset-follow-up.js');

let TASKS_BASE;
let prevTasksBase;
let prevWorktreesBase;

function runReset(args, opts = {}) {
  return spawnSync(process.execPath, [MODULE_PATH, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      TASKS_BASE,
      WORKTREES_BASE: TASKS_BASE,
      ...(opts.env || {}),
    },
  });
}

function seedTicketState(ticketId) {
  const dir = path.join(TASKS_BASE, ticketId);
  fs.mkdirSync(dir, { recursive: true });
  const statePath = path.join(dir, '.follow-up-state.json');
  const commentsPath = path.join(dir, 'follow-up-comments.json');
  fs.writeFileSync(
    statePath,
    JSON.stringify({ ticketId, status: 'blocked', attempt: 40 }, null, 2)
  );
  fs.writeFileSync(commentsPath, JSON.stringify({ comments: [{ id: 1 }] }, null, 2));
  return { dir, statePath, commentsPath };
}

beforeEach(() => {
  TASKS_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-follow-up-'));
  prevTasksBase = process.env.TASKS_BASE;
  prevWorktreesBase = process.env.WORKTREES_BASE;
  process.env.TASKS_BASE = TASKS_BASE;
  process.env.WORKTREES_BASE = TASKS_BASE;
});

afterEach(() => {
  if (prevTasksBase === undefined) delete process.env.TASKS_BASE;
  else process.env.TASKS_BASE = prevTasksBase;
  if (prevWorktreesBase === undefined) delete process.env.WORKTREES_BASE;
  else process.env.WORKTREES_BASE = prevWorktreesBase;
  fs.rmSync(TASKS_BASE, { recursive: true, force: true });
});

describe('reset-follow-up', () => {
  describe('reset-follow-up wipes state without tripping protect-state-files', () => {
    it('removes .follow-up-state.json and follow-up-comments.json, re-inits, exit 0, provenance row appended', () => {
      const ticketId = 'GH-999';
      const { statePath, commentsPath, dir } = seedTicketState(ticketId);

      const result = runReset([ticketId, '--yes']);

      assert.equal(result.status, 0, `exit 0 expected, got ${result.status}: ${result.stderr}`);

      // Stdout is JSON with the documented shape.
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.ok, true);
      assert.equal(payload.ticket, ticketId);
      assert.equal(payload.reinit, true);
      assert.ok(Array.isArray(payload.removed), 'removed must be an array');
      assert.equal(payload.removed.length, 2, 'both files reported as removed');

      // Fresh state file was re-initialized.
      assert.ok(fs.existsSync(statePath), 'fresh state re-initialized at original path');
      const fresh = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      assert.equal(fresh.ticketId, ticketId);
      assert.equal(fresh.attempt, 0);
      assert.equal(fresh.status, 'in_progress');

      // follow-up-comments.json stays gone (idempotent wipe target).
      assert.equal(fs.existsSync(commentsPath), false, 'follow-up-comments.json wiped');

      // Provenance row appended to .work-actions.json.
      const actionsPath = path.join(dir, '.work-actions.json');
      assert.ok(fs.existsSync(actionsPath), '.work-actions.json written');
      const actions = JSON.parse(fs.readFileSync(actionsPath, 'utf8'));
      const rows = Array.isArray(actions) ? actions : actions.actions || actions.rows;
      assert.ok(Array.isArray(rows), '.work-actions.json holds an array of rows');
      const row = rows.find((r) => r && r.kind === 'reset-follow-up');
      assert.ok(row, 'reset-follow-up provenance row present');
      assert.equal(row.ticket, ticketId);
      assert.ok(row.ts, 'ts recorded');
      assert.ok(typeof row.invoker === 'string' && row.invoker.length > 0, 'invoker recorded');
    });
  });

  describe('reset-follow-up validates ticket id', () => {
    it('rejects ../etc/passwd with exit 1, stderr "must match", and no out-of-base writes', () => {
      const result = runReset(['../etc/passwd', '--yes']);

      assert.equal(result.status, 1, `exit 1 expected, got ${result.status}`);
      assert.match(
        result.stderr,
        /must match/,
        `stderr must contain "must match"; got: ${result.stderr}`
      );

      // No file should have been touched outside TASKS_BASE.
      assert.equal(
        fs.existsSync(path.join(TASKS_BASE, '..', 'etc', 'passwd')),
        false,
        'no out-of-base file created'
      );
      // And nothing inside TASKS_BASE either.
      const entries = fs.readdirSync(TASKS_BASE);
      assert.deepEqual(entries, [], 'TASKS_BASE remains empty');
    });

    it('rejects lowercase / non-canonical ids with exit 1 and "must match"', () => {
      const result = runReset(['gh-1', '--yes']);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /must match/);
    });
  });

  describe('reset-follow-up is idempotent when state files are already gone', () => {
    it('exit 0, removed list empty, fresh state still re-initialized', () => {
      const ticketId = 'GH-1234';
      // Note: do NOT seed state — both target files are absent.

      const result = runReset([ticketId, '--yes']);

      assert.equal(result.status, 0, `exit 0 expected, got ${result.status}: ${result.stderr}`);

      const payload = JSON.parse(result.stdout);
      assert.equal(payload.ok, true);
      assert.equal(payload.ticket, ticketId);
      assert.equal(payload.reinit, true);
      assert.ok(Array.isArray(payload.removed), 'removed is an array');
      assert.equal(payload.removed.length, 0, 'nothing pre-existing was removed');

      // Fresh state initialized despite no prior state.
      const statePath = path.join(TASKS_BASE, ticketId, '.follow-up-state.json');
      assert.ok(fs.existsSync(statePath), 'fresh state initialized');
      const fresh = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      assert.equal(fresh.ticketId, ticketId);
      assert.equal(fresh.attempt, 0);
      assert.equal(fresh.status, 'in_progress');
    });
  });

  describe('reset-follow-up preserves saved PR number across reset', () => {
    it('reads prNumber from existing state and re-applies it to the fresh state', () => {
      const ticketId = 'GH-553';
      const dir = path.join(TASKS_BASE, ticketId);
      fs.mkdirSync(dir, { recursive: true });
      const statePath = path.join(dir, '.follow-up-state.json');
      fs.writeFileSync(
        statePath,
        JSON.stringify({ ticketId, status: 'blocked', attempt: 40, prNumber: 553 }, null, 2)
      );

      const result = runReset([ticketId, '--yes']);
      assert.equal(result.status, 0, `exit 0 expected, got ${result.status}: ${result.stderr}`);

      const fresh = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      assert.equal(fresh.ticketId, ticketId);
      assert.equal(fresh.prNumber, 553, 'prNumber preserved across reset');
    });
  });

  describe('reset-follow-up preserves a corrupt .work-actions.json before overwriting', () => {
    it('renames the corrupt file to .corrupt-<ts> and writes a fresh one-row file', () => {
      const ticketId = 'GH-777';
      seedTicketState(ticketId);
      const dir = path.join(TASKS_BASE, ticketId);
      const actionsPath = path.join(dir, '.work-actions.json');
      fs.writeFileSync(actionsPath, '{ this is : not json ]');

      const result = runReset([ticketId, '--yes']);
      assert.equal(result.status, 0, `exit 0 expected, got ${result.status}: ${result.stderr}`);

      // Corrupt sibling preserved
      const siblings = fs
        .readdirSync(dir)
        .filter((f) => f.startsWith('.work-actions.json.corrupt-'));
      assert.equal(siblings.length, 1, 'one corrupt-<ts> sibling must exist');
      assert.equal(
        fs.readFileSync(path.join(dir, siblings[0]), 'utf8'),
        '{ this is : not json ]',
        'corrupt contents must be preserved verbatim'
      );

      // Fresh file contains exactly one provenance row
      const fresh = JSON.parse(fs.readFileSync(actionsPath, 'utf8'));
      assert.ok(Array.isArray(fresh), 'fresh actions file must be an array');
      assert.equal(fresh.length, 1, 'fresh actions file must contain exactly one row');
      assert.equal(fresh[0].kind, 'reset-follow-up');
      assert.equal(fresh[0].ticket, ticketId);
    });
  });
});
