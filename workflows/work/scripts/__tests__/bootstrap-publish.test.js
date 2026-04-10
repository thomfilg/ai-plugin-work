const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const path = require('path');
const { buildCommitCommands, buildPrCommands } = require('../bootstrap-publish.js');

const SCRIPT = path.join(__dirname, '..', 'bootstrap-publish.js');

function run(args, env = {}) {
  return execFileSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function runWithError(args, env = {}) {
  try {
    run(args, env);
    assert.fail('Expected process to exit with error');
  } catch (err) {
    return err;
  }
}

describe('bootstrap-publish.js', () => {
  describe('argument validation', () => {
    it('exits 1 with no arguments', () => {
      const err = runWithError([]);
      assert.equal(err.status, 1);
    });

    it('exits 1 with missing arguments', () => {
      const err = runWithError(['--commit', '/tmp']);
      assert.equal(err.status, 1);
    });

    it('exits 1 with unknown mode', () => {
      const err = runWithError(['--unknown', '/tmp', 'branch', 'TICKET-1']);
      assert.equal(err.status, 1);
    });
  });

  describe('--commit mode', () => {
    it('skips when ENABLE_EMPTY_COMMIT is not set', () => {
      const output = run(['--commit', '/tmp', 'branch', 'TICKET-1'], { ENABLE_EMPTY_COMMIT: '' });
      assert.match(output, /skipping/i);
    });
  });

  describe('--pr mode', () => {
    it('skips when ENABLE_DRAFT_PR is not set', () => {
      const output = run(['--pr', '/tmp', 'branch', 'TICKET-1'], {
        ENABLE_EMPTY_COMMIT: '1',
        ENABLE_DRAFT_PR: '',
      });
      assert.match(output, /skipping/i);
    });

    it('skips when ENABLE_EMPTY_COMMIT is not set', () => {
      const output = run(['--pr', '/tmp', 'branch', 'TICKET-1'], {
        ENABLE_EMPTY_COMMIT: '',
        ENABLE_DRAFT_PR: '1',
      });
      assert.match(output, /skipping/i);
    });

    it('skips when both env vars are not set', () => {
      const output = run(['--pr', '/tmp', 'branch', 'TICKET-1'], {
        ENABLE_EMPTY_COMMIT: '',
        ENABLE_DRAFT_PR: '',
      });
      assert.match(output, /skipping/i);
    });
  });

  describe('buildCommitCommands', () => {
    it('returns git commit and push commands', () => {
      const cmds = buildCommitCommands('my-branch', 'PROJ-123');
      assert.equal(cmds.length, 2);

      assert.equal(cmds[0].bin, 'git');
      assert.deepEqual(cmds[0].args, [
        'commit',
        '--allow-empty',
        '-m',
        'chore: bootstrap PROJ-123',
      ]);

      assert.equal(cmds[1].bin, 'git');
      assert.deepEqual(cmds[1].args, ['push', '-u', 'origin', 'my-branch']);
    });

    it('interpolates ticket ID into commit message', () => {
      const cmds = buildCommitCommands('branch', 'ABC-999');
      assert.equal(cmds[0].args[3], 'chore: bootstrap ABC-999');
    });
  });

  describe('buildPrCommands', () => {
    it('returns gh pr create command with --draft flag', () => {
      const cmds = buildPrCommands('PROJ-123');
      assert.equal(cmds.length, 1);
      assert.equal(cmds[0].bin, 'gh');
      assert.ok(cmds[0].args.includes('--draft'));
    });

    it('sets correct PR title with ticket ID', () => {
      const cmds = buildPrCommands('PROJ-123');
      const titleIdx = cmds[0].args.indexOf('--title') + 1;
      assert.equal(cmds[0].args[titleIdx], 'PROJ-123 - chore: bootstrap task');
    });

    it('produces body with real newlines, not escaped \\n', () => {
      const cmds = buildPrCommands('PROJ-123');
      const bodyIdx = cmds[0].args.indexOf('--body') + 1;
      const body = cmds[0].args[bodyIdx];

      assert.ok(body.includes('\n'), 'body should contain real newlines');
      assert.ok(!body.includes('\\n'), 'body should not contain escaped \\n');
    });

    it('includes ticket ID in body summary', () => {
      const cmds = buildPrCommands('PROJ-456');
      const bodyIdx = cmds[0].args.indexOf('--body') + 1;
      const body = cmds[0].args[bodyIdx];

      assert.ok(body.includes('Bootstrap PR for PROJ-456'));
    });

    it('includes status checklist in body', () => {
      const cmds = buildPrCommands('PROJ-123');
      const bodyIdx = cmds[0].args.indexOf('--body') + 1;
      const body = cmds[0].args[bodyIdx];

      assert.ok(body.includes('- [ ] Implementation in progress'));
      assert.ok(body.includes('- [ ] Tests passing'));
      assert.ok(body.includes('- [ ] Ready for review'));
    });
  });
});
