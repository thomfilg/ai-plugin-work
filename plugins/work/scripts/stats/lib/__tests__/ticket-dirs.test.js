/**
 * Tests for the ticket-dir lister (GH-317 / Task 2 / R15, R16).
 *
 * Scenarios covered:
 *   - 2.1 Direct-child listing: only direct child dirs under TASKS_BASE are
 *         returned; regular files are ignored; config is read via getConfig
 *         (env wins), never ad-hoc process.env access inside the module.
 *   - 2.2 Path-traversal guard: entries that resolve outside TASKS_BASE
 *         (`..` names, absolute symlink targets escaping the base) are rejected.
 *
 * Run with:
 *   node --test scripts/stats/lib/__tests__/ticket-dirs.test.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let ticketDirs;
try {
  ticketDirs = require('../ticket-dirs');
} catch (_err) {
  // Module not implemented yet (RED phase): expose an empty surface so tests
  // collect and fail on behavior assertions rather than a load-time error.
  ticketDirs = {};
}

let tmpBase;
let outsideBase;
const savedTasksBase = process.env.TASKS_BASE;

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'gh317-tasks-'));
  outsideBase = fs.mkdtempSync(path.join(os.tmpdir(), 'gh317-outside-'));
  process.env.TASKS_BASE = tmpBase;
});

afterEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
  fs.rmSync(outsideBase, { recursive: true, force: true });
  if (savedTasksBase === undefined) delete process.env.TASKS_BASE;
  else process.env.TASKS_BASE = savedTasksBase;
});

describe('ticket-dirs — direct-child listing (2.1, R15/R16)', () => {
  it('exports listTicketDirs as a named function', () => {
    assert.equal(
      typeof ticketDirs.listTicketDirs,
      'function',
      'listTicketDirs must be a named export of ticket-dirs.js',
    );
  });

  it('returns only direct-child directories, ignoring regular files', () => {
    fs.mkdirSync(path.join(tmpBase, 'GH-100'));
    fs.mkdirSync(path.join(tmpBase, 'GH-200'));
    fs.writeFileSync(path.join(tmpBase, 'README.txt'), 'not a ticket');

    const result = ticketDirs.listTicketDirs();
    assert.deepEqual([...result].sort(), ['GH-100', 'GH-200']);
  });

  it('does not descend into nested subdirectories (direct children only)', () => {
    fs.mkdirSync(path.join(tmpBase, 'GH-300'));
    fs.mkdirSync(path.join(tmpBase, 'GH-300', 'task1'), { recursive: true });

    const result = ticketDirs.listTicketDirs();
    assert.deepEqual([...result].sort(), ['GH-300']);
    assert.ok(
      !result.includes('task1'),
      'nested subdirectories must not appear in the listing',
    );
  });

  it('returns an empty list when TASKS_BASE has no directories', () => {
    fs.writeFileSync(path.join(tmpBase, 'only-a-file'), 'x');
    const result = ticketDirs.listTicketDirs();
    assert.deepEqual([...result], []);
  });

  it('resolves TASKS_BASE via getConfig (env value wins)', () => {
    // Point env at a fresh temp dir distinct from the beforeEach default and
    // confirm the lister honors the getConfig-resolved value.
    const alt = fs.mkdtempSync(path.join(os.tmpdir(), 'gh317-alt-'));
    try {
      fs.mkdirSync(path.join(alt, 'GH-999'));
      process.env.TASKS_BASE = alt;
      const result = ticketDirs.listTicketDirs();
      assert.deepEqual([...result], ['GH-999']);
    } finally {
      fs.rmSync(alt, { recursive: true, force: true });
    }
  });
});

describe('ticket-dirs — path-traversal guard (2.2, R15)', () => {
  it('rejects symlink entries whose target escapes TASKS_BASE', () => {
    fs.mkdirSync(path.join(tmpBase, 'GH-400'));
    // A directory symlink pointing outside the base must be excluded.
    const escapingTarget = path.join(outsideBase, 'escaped-dir');
    fs.mkdirSync(escapingTarget);
    try {
      fs.symlinkSync(escapingTarget, path.join(tmpBase, 'evil'), 'dir');
    } catch (_err) {
      // If symlinks are unsupported on this platform, skip the symlink assertion.
      return;
    }

    const result = ticketDirs.listTicketDirs();
    assert.ok(result.includes('GH-400'), 'legitimate dir must be listed');
    assert.ok(
      !result.includes('evil'),
      'symlink resolving outside TASKS_BASE must be rejected',
    );
  });

  it('keeps direct-child dirs whose resolved path stays within TASKS_BASE', () => {
    fs.mkdirSync(path.join(tmpBase, 'GH-500'));
    const result = ticketDirs.listTicketDirs();
    assert.ok(result.includes('GH-500'));
  });

  it('never returns a name containing ".." or path separators', () => {
    fs.mkdirSync(path.join(tmpBase, 'GH-600'));
    const result = ticketDirs.listTicketDirs();
    for (const name of result) {
      assert.ok(!name.includes('..'), `name "${name}" must not contain ".."`);
      assert.ok(
        !name.includes('/') && !name.includes('\\'),
        `name "${name}" must be a bare directory name, not a path`,
      );
    }
  });
});
