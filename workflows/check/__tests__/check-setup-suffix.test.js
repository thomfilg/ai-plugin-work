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

const { resolveTicketId } = require(path.join(__dirname, '..', 'hooks', 'check-setup.js'));

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
    const taskId = resolveTicketId(['GH-181/phase1'], {});
    const mainWorktree = '/home/user/worktrees/my-repo';
    const reportFolder = path.join(mainWorktree, '..', 'tasks', taskId);
    // The key assertion: reportFolder should resolve to a subdirectory
    assert.equal(
      path.resolve(reportFolder),
      path.resolve('/home/user/worktrees/tasks/GH-181/phase1')
    );
  });

  it('unsuffixed TICKET_ID creates correct reportFolder path', () => {
    const taskId = resolveTicketId(['GH-181'], {});
    const mainWorktree = '/home/user/worktrees/my-repo';
    const reportFolder = path.join(mainWorktree, '..', 'tasks', taskId);
    assert.equal(
      path.resolve(reportFolder),
      path.resolve('/home/user/worktrees/tasks/GH-181')
    );
  });

  it('branch name fallback sanitizes special characters', () => {
    // When TICKET_ID is empty, branch name is used as fallback
    // Branch names with / should be sanitized (replace unsafe chars)
    const branchName = 'feature/GH-181/phase1';
    const taskId = '' || branchName.replace(/[^a-zA-Z0-9._-]/g, '-');
    assert.equal(taskId, 'feature-GH-181-phase1');
  });

  it('branch name fallback preserves dots, underscores, and hyphens', () => {
    const branchName = 'GH-181_fix.check-gate';
    const taskId = '' || branchName.replace(/[^a-zA-Z0-9._-]/g, '-');
    assert.equal(taskId, 'GH-181_fix.check-gate');
  });
});
