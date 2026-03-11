const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// Save original env
const originalEnv = { ...process.env };

// Helper to reset env
function resetEnv() {
  // Remove all TICKET_ and JIRA_ vars
  Object.keys(process.env).forEach(key => {
    if (key.startsWith('TICKET_') || key.startsWith('JIRA_') || key.startsWith('LINEAR_')) {
      delete process.env[key];
    }
  });
}

// Re-import module fresh each time (clear require cache)
function freshRequire(mod) {
  const resolved = require.resolve(mod);
  delete require.cache[resolved];
  return require(mod);
}

describe('ticket-provider', () => {
  beforeEach(() => {
    resetEnv();
  });

  after(() => {
    Object.assign(process.env, originalEnv);
  });

  describe('normalizeRemoteUrl', () => {
    it('normalizes SSH URLs', () => {
      const tp = freshRequire('../ticket-provider');
      assert.equal(tp.normalizeRemoteUrl('git@github.com:org/repo.git'), 'github.com/org/repo');
    });

    it('normalizes HTTPS URLs', () => {
      const tp = freshRequire('../ticket-provider');
      assert.equal(tp.normalizeRemoteUrl('https://github.com/org/repo.git'), 'github.com/org/repo');
    });

    it('returns null for null input', () => {
      const tp = freshRequire('../ticket-provider');
      assert.equal(tp.normalizeRemoteUrl(null), null);
    });
  });

  describe('getProviderConfig', () => {
    it('returns jira config from TICKET_PROVIDER env', () => {
      process.env.TICKET_PROVIDER = 'jira';
      process.env.TICKET_PROJECT_KEY = 'MYPROJ';
      const tp = freshRequire('../ticket-provider');
      const config = tp.getProviderConfig({ skipPrompt: true });
      assert.deepEqual(config, {
        provider: 'jira',
        projectKey: 'MYPROJ',
        baseUrl: 'your-org.atlassian.net',
      });
    });

    it('returns linear config from TICKET_PROVIDER env', () => {
      process.env.TICKET_PROVIDER = 'linear';
      process.env.TICKET_PROJECT_KEY = 'ENG';
      const tp = freshRequire('../ticket-provider');
      const config = tp.getProviderConfig({ skipPrompt: true });
      assert.deepEqual(config, {
        provider: 'linear',
        projectKey: 'ENG',
        teamId: '',
      });
    });

    it('returns github config from TICKET_PROVIDER env', () => {
      process.env.TICKET_PROVIDER = 'github';
      const tp = freshRequire('../ticket-provider');
      const config = tp.getProviderConfig({ skipPrompt: true });
      assert.deepEqual(config, {
        provider: 'github',
        projectKey: '',
      });
    });

    it('returns none config', () => {
      process.env.TICKET_PROVIDER = 'none';
      const tp = freshRequire('../ticket-provider');
      const config = tp.getProviderConfig({ skipPrompt: true });
      assert.deepEqual(config, { provider: 'none' });
    });

    it('falls back to JIRA_PROJECT_KEY for legacy compat', () => {
      process.env.JIRA_PROJECT_KEY = 'LEGACY';
      process.env.JIRA_BASE_URL = 'legacy.atlassian.net';
      const tp = freshRequire('../ticket-provider');
      const config = tp.getProviderConfig({ skipPrompt: true });
      assert.deepEqual(config, {
        provider: 'jira',
        projectKey: 'LEGACY',
        baseUrl: 'legacy.atlassian.net',
      });
    });

    it('TICKET_PROVIDER env takes precedence over JIRA_PROJECT_KEY', () => {
      process.env.TICKET_PROVIDER = 'linear';
      process.env.JIRA_PROJECT_KEY = 'OLD';
      process.env.TICKET_PROJECT_KEY = 'NEW';
      const tp = freshRequire('../ticket-provider');
      const config = tp.getProviderConfig({ skipPrompt: true });
      assert.equal(config.provider, 'linear');
      assert.equal(config.projectKey, 'NEW');
    });

    it('returns null when unconfigured', () => {
      const tp = freshRequire('../ticket-provider');
      const config = tp.getProviderConfig({ skipPrompt: true });
      assert.equal(config, null);
    });
  });

  describe('ticketUrl', () => {
    it('generates Jira browse URL', () => {
      const tp = freshRequire('../ticket-provider');
      const url = tp.ticketUrl('PROJ-123', { provider: 'jira', baseUrl: 'org.atlassian.net' });
      assert.equal(url, 'https://org.atlassian.net/browse/PROJ-123');
    });

    it('generates Linear URL', () => {
      const tp = freshRequire('../ticket-provider');
      const url = tp.ticketUrl('ENG-456', { provider: 'linear' });
      assert.equal(url, 'https://linear.app/issue/ENG-456');
    });

    it('generates GitHub issue reference', () => {
      const tp = freshRequire('../ticket-provider');
      const url = tp.ticketUrl('#42', { provider: 'github' });
      assert.equal(url, '#42');
    });

    it('returns null for none provider', () => {
      const tp = freshRequire('../ticket-provider');
      assert.equal(tp.ticketUrl('X', { provider: 'none' }), null);
    });
  });

  describe('prefixTicketId', () => {
    it('prefixes numeric input for jira', () => {
      const tp = freshRequire('../ticket-provider');
      assert.equal(tp.prefixTicketId('123', { provider: 'jira', projectKey: 'PROJ' }), 'PROJ-123');
    });

    it('prefixes numeric input for linear', () => {
      const tp = freshRequire('../ticket-provider');
      assert.equal(tp.prefixTicketId('456', { provider: 'linear', projectKey: 'ENG' }), 'ENG-456');
    });

    it('prefixes numeric input for github with #', () => {
      const tp = freshRequire('../ticket-provider');
      assert.equal(tp.prefixTicketId('42', { provider: 'github' }), '#42');
    });

    it('returns uppercase for non-numeric jira input', () => {
      const tp = freshRequire('../ticket-provider');
      assert.equal(tp.prefixTicketId('proj-123', { provider: 'jira', projectKey: 'PROJ' }), 'PROJ-123');
    });
  });

  describe('getTicketPattern', () => {
    it('returns alpha-numeric pattern for jira/linear', () => {
      const tp = freshRequire('../ticket-provider');
      const pattern = tp.getTicketPattern({ provider: 'jira' });
      assert.equal(pattern.test('PROJ-123'), true);
      assert.equal(pattern.test('#42'), false);
    });

    it('returns numeric pattern for github', () => {
      const tp = freshRequire('../ticket-provider');
      const pattern = tp.getTicketPattern({ provider: 'github' });
      assert.equal(pattern.test('42'), true);
      assert.equal(pattern.test('#42'), true);
    });
  });

  describe('getFetchTicketPrompt', () => {
    it('returns Jira MCP prompt', () => {
      const tp = freshRequire('../ticket-provider');
      const prompt = tp.getFetchTicketPrompt('PROJ-1', { provider: 'jira' });
      assert.ok(prompt.includes('mcp__atlassian__jira_get_issue'));
    });

    it('returns Linear MCP prompt', () => {
      const tp = freshRequire('../ticket-provider');
      const prompt = tp.getFetchTicketPrompt('ENG-1', { provider: 'linear' });
      assert.ok(prompt.includes('mcp__linear__get_issue'));
    });

    it('returns gh CLI prompt for github', () => {
      const tp = freshRequire('../ticket-provider');
      const prompt = tp.getFetchTicketPrompt('#42', { provider: 'github' });
      assert.ok(prompt.includes('gh issue view'));
    });

    it('returns null for none', () => {
      const tp = freshRequire('../ticket-provider');
      assert.equal(tp.getFetchTicketPrompt('X', { provider: 'none' }), null);
    });
  });

  describe('getTransitionPrompt', () => {
    it('returns Jira transition prompt', () => {
      const tp = freshRequire('../ticket-provider');
      const prompt = tp.getTransitionPrompt('PROJ-1', 'In Development', { provider: 'jira' });
      assert.ok(prompt.includes('mcp__atlassian__jira_transition_issue'));
    });

    it('returns Linear save prompt', () => {
      const tp = freshRequire('../ticket-provider');
      const prompt = tp.getTransitionPrompt('ENG-1', 'In Progress', { provider: 'linear' });
      assert.ok(prompt.includes('mcp__linear__save_issue'));
    });

    it('returns null for github (no transitions)', () => {
      const tp = freshRequire('../ticket-provider');
      assert.equal(tp.getTransitionPrompt('#42', 'closed', { provider: 'github' }), null);
    });
  });

  describe('getAllowedMcpTools', () => {
    it('returns Jira MCP tools', () => {
      const tp = freshRequire('../ticket-provider');
      const tools = tp.getAllowedMcpTools({ provider: 'jira' });
      assert.ok(tools.includes('mcp__atlassian__jira_get_issue'));
    });

    it('returns Linear MCP tools', () => {
      const tp = freshRequire('../ticket-provider');
      const tools = tp.getAllowedMcpTools({ provider: 'linear' });
      assert.ok(tools.includes('mcp__linear__get_issue'));
      assert.ok(tools.includes('mcp__linear__save_issue'));
    });

    it('returns empty for github', () => {
      const tp = freshRequire('../ticket-provider');
      assert.deepEqual(tp.getAllowedMcpTools({ provider: 'github' }), []);
    });
  });

  describe('getCreateTicketAgentType', () => {
    it('returns jira-task-creator for jira', () => {
      const tp = freshRequire('../ticket-provider');
      assert.equal(tp.getCreateTicketAgentType({ provider: 'jira' }), 'jira-task-creator');
    });

    it('returns general-purpose for linear', () => {
      const tp = freshRequire('../ticket-provider');
      assert.equal(tp.getCreateTicketAgentType({ provider: 'linear' }), 'general-purpose');
    });

    it('returns null for none', () => {
      const tp = freshRequire('../ticket-provider');
      assert.equal(tp.getCreateTicketAgentType({ provider: 'none' }), null);
    });
  });
});
