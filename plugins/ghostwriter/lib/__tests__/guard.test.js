/**
 * Unit tests for lib/guard.js — the five-pass decision.
 *
 * All I/O is injected, so these tests prove the decision logic without a git
 * repository: `readMessageFile` and `resolveIdentity` are fakes, and `env` is
 * a literal. The pass ORDER is asserted too — a finding on the `-m` value must
 * win over one on the repo identity, because the sharper evidence is the one
 * the operator can act on.
 *
 * Run with: node --test plugins/ghostwriter/lib/__tests__/guard.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { inspectCommand, renderBlock, OVERRIDE_ENV } = require('../guard');

const TOOL = ['Cl', 'aude'].join('');
const HUMAN = { name: 'Ada Lovelace', email: 'ada@example.com' };
const AI_USER = { name: TOOL, email: 'noreply@example.com' };

/** Inspect with fully-faked I/O; overrides merge over a clean default. */
function inspect(command, overrides = {}) {
  return inspectCommand(command, {
    cwd: '/repo',
    env: {},
    readMessageFile: () => '',
    resolveIdentity: () => HUMAN,
    ...overrides,
  });
}

describe('guard — commands with nothing at stake', () => {
  it('allows a command with no git authorship surface', () => {
    assert.deepEqual(inspect(`echo "Co-Authored-By: ${TOOL} <a@b>"`), { blocked: false });
    assert.deepEqual(inspect('git status'), { blocked: false });
  });

  it('never resolves the repo identity for a non-authoring command', () => {
    let calls = 0;
    inspect('git status', {
      resolveIdentity: () => {
        calls += 1;
        return AI_USER;
      },
    });
    assert.equal(calls, 0, 'identity lookup must be scoped to authoring commands');
  });

  it('allows a clean commit under a human identity', () => {
    assert.deepEqual(inspect('git commit -m "feat: add the guard (#12)"'), { blocked: false });
  });

  it('allows a bare product mention', () => {
    assert.deepEqual(inspect(`git commit -m "feat: add ${TOOL.toLowerCase()} adapter (#12)"`), {
      blocked: false,
    });
  });
});

describe('guard — the five passes', () => {
  it('pass 1: blocks an attribution trailer in a -m value', () => {
    const verdict = inspect(`git commit -m "feat: x\n\nCo-Authored-By: ${TOOL} <a@b>"`);
    assert.equal(verdict.blocked, true);
    assert.equal(verdict.rule, 'aiCoAuthorTrailer');
    assert.equal(verdict.where, 'git commit message');
  });

  it('pass 2: blocks attribution inside a -F message file', () => {
    const verdict = inspect('git commit -F msg.txt', {
      readMessageFile: () => `feat: x\n\nGenerated with ${TOOL} Code`,
    });
    assert.equal(verdict.blocked, true);
    assert.equal(verdict.rule, 'aiGeneratedPhrase');
    assert.equal(verdict.where, 'git commit message file msg.txt');
  });

  it('pass 2: skips an unreadable or stdin message file without blocking', () => {
    assert.deepEqual(inspect('git commit -F -'), { blocked: false });
  });

  it('pass 3: blocks an --author that names a tool', () => {
    const verdict = inspect(`git commit --author="${TOOL} <a@b>" -m "feat: x"`);
    assert.equal(verdict.blocked, true);
    assert.equal(verdict.rule, 'aiIdentity');
    assert.equal(verdict.where, '--author on git commit');
  });

  it('pass 3: blocks setting the git identity to a tool', () => {
    const verdict = inspect(`git config --global user.name "${TOOL}"`);
    assert.equal(verdict.blocked, true);
    assert.equal(verdict.where, 'user.name on git config');
  });

  it('pass 3: blocks a per-invocation `-c user.name=…` override', () => {
    // The stored config stays human, so pass 5 would never see this one.
    const verdict = inspect(`git -c user.name=${TOOL} commit -m "feat: x"`);
    assert.equal(verdict.blocked, true);
    assert.equal(verdict.rule, 'aiIdentity');
    assert.equal(verdict.where, '-c user.name on git commit');
  });

  it('pass 4: blocks a heredoc body the tokenizer cannot open', () => {
    const command = `git commit -F- <<'EOF'\nfeat: x\n\nCo-Authored-By: ${TOOL} <a@b>\nEOF`;
    const verdict = inspect(command);
    assert.equal(verdict.blocked, true);
    assert.equal(verdict.where, 'the command text');
  });

  it('pass 5: blocks a clean message committed under a tool identity', () => {
    const verdict = inspect('git commit -m "feat: x"', { resolveIdentity: () => AI_USER });
    assert.equal(verdict.blocked, true);
    assert.equal(verdict.rule, 'aiIdentity');
    assert.equal(verdict.where, 'the configured git identity');
  });

  it('prefers the sharpest evidence when several passes would fire', () => {
    const verdict = inspect(`git commit -m "feat: x\n\nCo-Authored-By: ${TOOL} <a@b>"`, {
      resolveIdentity: () => AI_USER,
    });
    assert.equal(verdict.where, 'git commit message');
  });
});

describe('guard — the operator override', () => {
  const dirty = `git commit -m "feat: x\n\nCo-Authored-By: ${TOOL} <a@b>"`;

  it('honours the override from the hook environment', () => {
    assert.deepEqual(inspect(dirty, { env: { [OVERRIDE_ENV]: '1' } }), { blocked: false });
  });

  it('ignores any value other than "1"', () => {
    assert.equal(inspect(dirty, { env: { [OVERRIDE_ENV]: 'true' } }).blocked, true);
  });

  it('refuses an override the command grants itself', () => {
    const selfGranting = `${OVERRIDE_ENV}=1 ${dirty}`;
    const verdict = inspect(selfGranting, { env: { [OVERRIDE_ENV]: '1' } });
    assert.equal(verdict.blocked, true);
    assert.equal(verdict.selfGranted, true);
  });
});

describe('renderBlock', () => {
  it('quotes the rule, the location, the evidence and the fix', () => {
    const verdict = inspect(`git commit -m "feat: x\n\nCo-Authored-By: ${TOOL} <a@b>"`);
    const text = renderBlock(verdict);
    assert.ok(text.startsWith('ghostwriter:'));
    for (const part of [
      verdict.rule,
      verdict.where,
      verdict.reason,
      verdict.evidence,
      verdict.hint,
    ]) {
      assert.ok(text.includes(part), `block message must include ${JSON.stringify(part)}`);
    }
    assert.ok(text.endsWith('\n'), 'stderr block must end with a newline');
  });

  it('explains why an inline override was ignored', () => {
    const verdict = inspect(`${OVERRIDE_ENV}=1 git commit -m "x\n\nCo-Authored-By: ${TOOL} <a@b>"`);
    assert.ok(renderBlock(verdict).includes(OVERRIDE_ENV));
  });
});
