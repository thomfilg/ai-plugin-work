/**
 * Tests for policies/command-matching.js
 *
 * Pure unit tests — no spawn, no FS state required.
 * Run: node --test workflows/lib/hooks/policies/__tests__/command-matching.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  NODE_INVOKE_PATTERN_SRC,
  getNodeInvocations,
  buildCommandIndex,
  matchToolToStep,
  isExempt,
  parseTransition,
} = require('../command-matching');

describe('command-matching: getNodeInvocations', () => {
  it('returns empty array for non-node commands', () => {
    assert.deepEqual(getNodeInvocations('ls -la'), []);
  });

  it('matches a simple node invocation', () => {
    const matches = getNodeInvocations('node script.js');
    assert.equal(matches.length, 1);
    const captured = matches[0][1] || matches[0][2] || matches[0][3];
    assert.equal(captured, 'script.js');
  });

  it('matches node with quoted path', () => {
    const matches = getNodeInvocations('node "path with space.js"');
    assert.equal(matches.length, 1);
    const captured = matches[0][1] || matches[0][2] || matches[0][3];
    assert.equal(captured, 'path with space.js');
  });

  it('matches multiple chained node calls', () => {
    const matches = getNodeInvocations('node a.js && node b.js');
    assert.equal(matches.length, 2);
  });

  it('handles env var prefixes before node', () => {
    const matches = getNodeInvocations('FOO=bar node script.js');
    assert.equal(matches.length, 1);
    const captured = matches[0][1] || matches[0][2] || matches[0][3];
    assert.equal(captured, 'script.js');
  });

  it('treats a newline as a command separator (cd on its own line)', () => {
    const matches = getNodeInvocations('cd /some/dir\nnode script.js');
    assert.equal(matches.length, 1);
    const captured = matches[0][1] || matches[0][2] || matches[0][3];
    assert.equal(captured, 'script.js');
  });

  it('treats CRLF as a command separator', () => {
    const matches = getNodeInvocations('cd /some/dir\r\nnode script.js');
    assert.equal(matches.length, 1);
  });

  it('matches node calls on separate lines', () => {
    const matches = getNodeInvocations('node a.js\nnode b.js');
    assert.equal(matches.length, 2);
  });

  it('exposes a stable pattern source string', () => {
    assert.equal(typeof NODE_INVOKE_PATTERN_SRC, 'string');
    assert.ok(NODE_INVOKE_PATTERN_SRC.length > 10);
  });
});

describe('command-matching: buildCommandIndex / matchToolToStep', () => {
  const commandMap = [
    { tool: 'Bash', field: 'command', pattern: /^echo hi$/, step: 'first' },
    { tool: ['Edit', 'Write'], field: 'file_path', pattern: /\.txt$/, step: 'edit' },
    { tool: 'Skill', field: null, step: 'always' },
    { verify: () => false, step: 'verify-only' }, // no tool — must be skipped by index
  ];

  it('skips verify-only entries with no tool', () => {
    const idx = buildCommandIndex(commandMap);
    // verify-only entries should not appear in the index
    for (const tool of Object.keys(idx)) {
      for (const m of idx[tool]) {
        assert.notEqual(m.step, 'verify-only');
      }
    }
  });

  it('indexes tool arrays into multiple keys', () => {
    const idx = buildCommandIndex(commandMap);
    assert.ok(idx.Edit);
    assert.ok(idx.Write);
    assert.equal(idx.Edit[0].step, 'edit');
  });

  it('matches a Bash command with pattern', () => {
    const idx = buildCommandIndex(commandMap);
    const step = matchToolToStep('Bash', { command: 'echo hi' }, idx);
    assert.equal(step, 'first');
  });

  it('returns null when nothing matches', () => {
    const idx = buildCommandIndex(commandMap);
    assert.equal(matchToolToStep('Bash', { command: 'echo bye' }, idx), null);
  });

  it('matches tool-only mappings (field === null)', () => {
    const idx = buildCommandIndex(commandMap);
    assert.equal(matchToolToStep('Skill', { skill: 'foo' }, idx), 'always');
  });

  it('coerces non-string field values via JSON.stringify', () => {
    const map = [{ tool: 'Bash', field: 'command', pattern: /\["a"\]/, step: 'arr' }];
    const idx = buildCommandIndex(map);
    assert.equal(matchToolToStep('Bash', { command: ['a'] }, idx), 'arr');
  });

  it('handles missing tool entry in index', () => {
    const idx = buildCommandIndex(commandMap);
    assert.equal(matchToolToStep('Unknown', {}, idx), null);
  });
});

describe('command-matching: isExempt', () => {
  it('returns false for non-Bash tools', () => {
    assert.equal(isExempt('Edit', { command: 'rm -rf' }, [/.*/]), false);
  });

  it('returns false when no patterns match', () => {
    assert.equal(isExempt('Bash', { command: 'pwd' }, [/^echo /]), false);
  });

  it('returns true when any pattern matches', () => {
    assert.equal(isExempt('Bash', { command: 'echo hi' }, [/^echo /, /^ls/]), true);
  });

  it('handles missing command safely', () => {
    assert.equal(isExempt('Bash', {}, [/^echo /]), false);
  });
});

describe('command-matching: parseTransition', () => {
  // Use a regex with two capture groups: ticket and step
  const pattern = /work\.workflow\.js\s+transition\s+(\S+)\s+(\S+)/;

  // Stub provider that just echoes the ticket back
  const sanitize = (id) => id;

  it('returns isTransition: false for non-Bash', () => {
    const r = parseTransition('Edit', { command: 'transition' }, pattern, sanitize);
    assert.equal(r.isTransition, false);
  });

  it('parses a transition command', () => {
    const cmd = 'node work.workflow.js transition GH-1 plan';
    const r = parseTransition('Bash', { command: cmd }, pattern, sanitize);
    assert.equal(r.isTransition, true);
    assert.equal(r.ticket, 'GH-1');
    assert.equal(r.targetStep, 'plan');
    assert.equal(r.raw, cmd);
  });

  it('returns isTransition: false when pattern does not match', () => {
    const r = parseTransition('Bash', { command: 'echo hi' }, pattern, sanitize);
    assert.equal(r.isTransition, false);
  });

  it('applies sanitizer to ticket id', () => {
    const cmd = 'node work.workflow.js transition #123 plan';
    const r = parseTransition(
      'Bash',
      { command: cmd },
      pattern,
      (id) => `GH-${id.replace('#', '')}`
    );
    assert.equal(r.ticket, 'GH-123');
  });
});
