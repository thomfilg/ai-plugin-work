const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const originalEnv = { ...process.env };

function resetEnv() {
  Object.keys(process.env).forEach((key) => {
    if (key.startsWith('TICKET_') || key.startsWith('JIRA_') || key.startsWith('LINEAR_')) {
      delete process.env[key];
    }
  });
}

function freshRequire(mod) {
  const resolved = require.resolve(mod);
  delete require.cache[resolved];
  // Also clear ticket-provider cache since get-ticket-id depends on it
  try {
    const tpResolved = require.resolve('../../lib/ticket-provider');
    delete require.cache[tpResolved];
  } catch {}
  return require(mod);
}

describe('get-ticket-id GH-pattern support', () => {
  beforeEach(() => {
    resetEnv();
  });
  after(() => {
    Object.assign(process.env, originalEnv);
  });

  it('extracts GH-56 from worktree path as GH-56', () => {
    process.env.TICKET_PROVIDER = 'github';
    const { getCurrentTaskId } = freshRequire('../get-ticket-id');
    const result = getCurrentTaskId('/home/user/worktrees/my-project-GH-56');
    assert.equal(result, 'GH-56');
  });

  it('extracts GH-123 from worktree path (case insensitive)', () => {
    process.env.TICKET_PROVIDER = 'github';
    const { getCurrentTaskId } = freshRequire('../get-ticket-id');
    const result = getCurrentTaskId('/home/user/worktrees/my-project-gh-123');
    assert.equal(result, 'GH-123');
  });

  it('still extracts PROJ-123 (Jira) from path when not github provider', () => {
    process.env.TICKET_PROVIDER = 'jira';
    process.env.TICKET_PROJECT_KEY = 'PROJ';
    const { getCurrentTaskId } = freshRequire('../get-ticket-id');
    const result = getCurrentTaskId('/home/user/worktrees/my-project-PROJ-123');
    assert.equal(result, 'PROJ-123');
  });

  it('GH pattern takes priority over bare numeric for github provider paths', () => {
    process.env.TICKET_PROVIDER = 'github';
    const { getCurrentTaskId } = freshRequire('../get-ticket-id');
    // GH-56 should match before the numeric fallback
    const result = getCurrentTaskId('/home/user/worktrees/my-project-GH-56');
    assert.equal(result, 'GH-56');
  });
});
