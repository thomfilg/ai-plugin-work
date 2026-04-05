/**
 * Tests for check-setup.js reportFolder suffix preservation (GH-181)
 *
 * Verifies that:
 * - When TICKET_ID is provided with a suffix (e.g., GH-181/phase1), the
 *   reportFolder uses it as-is (preserving the / as a subdirectory)
 * - When TICKET_ID is empty, the branch name fallback sanitizes properly
 * - The reportFolder path matches what work.workflow.js passes to validateCheckGate
 *
 * Run: node --test workflows/check/__tests__/check-setup-suffix.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { resolveTicketId, deriveTaskId } = require(path.join(__dirname, '..', 'hooks', 'check-setup.js'));

describe('check-setup suffix preservation (GH-181)', () => {

  it('TICKET_ID with suffix is used as-is (preserves /)', () => {
    const result = resolveTicketId(['GH-181/phase1'], {});
    assert.equal(result, 'GH-181/phase1');
  });

  it('TICKET_ID env with suffix is preserved', () => {
    const result = resolveTicketId([], { TICKET_ID: 'GH-181/phase1' });
    assert.equal(result, 'GH-181/phase1');
  });

  it('suffixed TICKET_ID creates correct reportFolder path (subdirectory)', () => {
    const taskId = deriveTaskId('GH-181/phase1', 'feature/GH-181/phase1');
    const mainWorktree = '/home/user/worktrees/my-repo';
    const reportFolder = path.join(mainWorktree, '..', 'tasks', taskId);
    // The key assertion: reportFolder should resolve to a subdirectory
    assert.equal(
      path.resolve(reportFolder),
      path.resolve('/home/user/worktrees/tasks/GH-181/phase1')
    );
  });

  it('unsuffixed TICKET_ID creates correct reportFolder path', () => {
    const taskId = deriveTaskId('GH-181', 'GH-181-fix-something');
    const mainWorktree = '/home/user/worktrees/my-repo';
    const reportFolder = path.join(mainWorktree, '..', 'tasks', taskId);
    assert.equal(
      path.resolve(reportFolder),
      path.resolve('/home/user/worktrees/tasks/GH-181')
    );
  });

  it('branch name fallback sanitizes special characters via deriveTaskId', () => {
    // When TICKET_ID is empty, deriveTaskId uses branch name with sanitization
    const taskId = deriveTaskId('', 'feature/GH-181/phase1');
    assert.equal(taskId, 'feature-GH-181-phase1');
  });

  it('branch name fallback preserves dots, underscores, and hyphens', () => {
    const taskId = deriveTaskId('', 'GH-181_fix.check-gate');
    assert.equal(taskId, 'GH-181_fix.check-gate');
  });

  it('deriveTaskId prefers ticketId over branchName', () => {
    const taskId = deriveTaskId('GH-181/phase1', 'some-branch');
    assert.equal(taskId, 'GH-181/phase1');
  });

  it('deriveTaskId rejects absolute paths and falls back to branch', () => {
    const taskId = deriveTaskId('/etc/passwd', 'safe-branch');
    assert.equal(taskId, 'safe-branch');
  });

  it('deriveTaskId rejects path traversal and falls back to branch', () => {
    const taskId = deriveTaskId('../../../etc/passwd', 'safe-branch');
    assert.equal(taskId, 'safe-branch');
  });

  it('deriveTaskId rejects nested suffixes (multiple slashes)', () => {
    const taskId = deriveTaskId('GH-181/phase1/extra', 'safe-branch');
    assert.equal(taskId, 'safe-branch');
  });

  it('deriveTaskId rejects unsafe characters in ticketId', () => {
    const taskId = deriveTaskId('GH-181; rm -rf /', 'safe-branch');
    assert.equal(taskId, 'safe-branch');
  });
});
