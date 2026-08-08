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

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  inspectCommand,
  renderBlock,
  readTextFile,
  OVERRIDE_ENV,
  MAX_MESSAGE_FILE_BYTES,
} = require('../guard');

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

// Every case here was a reachable bypass before the fix that follows it: the
// guard saw no surface at all, or checked the wrong repository, so nothing
// downstream ever ran.
describe('guard — bypasses that must stay closed', () => {
  it('inspects a git command reached through a shell wrapper', () => {
    const verdict = inspect(`bash -c "git commit -m 'x\n\nCo-Authored-By: ${TOOL} <a@b>'"`);
    assert.equal(verdict.blocked, true);
    assert.equal(verdict.rule, 'aiCoAuthorTrailer');
  });

  it('inspects a git command reached through env / sudo / timeout', () => {
    for (const wrapper of ['env', 'sudo -u someone', 'timeout 30']) {
      const verdict = inspect(`${wrapper} git commit --author="${TOOL} <a@b>" -m "feat: x"`);
      assert.equal(verdict.blocked, true, wrapper);
      assert.equal(verdict.rule, 'aiIdentity', wrapper);
    }
  });

  it('blocks a --config-env identity, wherever the value comes from', () => {
    const fromCommand = inspect(`MYVAR=${TOOL} git --config-env=user.name=MYVAR commit -m "x"`);
    assert.equal(fromCommand.blocked, true);
    assert.equal(fromCommand.rule, 'aiIdentity');

    const fromEnv = inspect('git --config-env=user.name=MYVAR commit -m "x"', {
      env: { MYVAR: TOOL },
    });
    assert.equal(fromEnv.blocked, true);
    assert.equal(fromEnv.rule, 'aiIdentity');
  });

  it('blocks a --config-env identity it cannot read rather than assuming it is clean', () => {
    const verdict = inspect('git --config-env=user.name=UNSEEN commit -m "x"');
    assert.equal(verdict.blocked, true);
    assert.equal(verdict.rule, 'unverifiableIdentity');
    assert.match(verdict.reason, /UNSEEN/);
  });

  it('allows a --config-env identity that resolves to a person', () => {
    const verdict = inspect('git --config-env=user.name=WHO commit -m "feat: x"', {
      env: { WHO: 'Ada Lovelace' },
    });
    assert.deepEqual(verdict, { blocked: false });
  });

  it('blocks an identity assignment carried by the wrapper itself', () => {
    const verdict = inspect(`env GIT_AUTHOR_NAME=${TOOL} git commit -m "feat: x"`);
    assert.equal(verdict.blocked, true);
    assert.equal(verdict.where, 'GIT_AUTHOR_NAME on git commit');
  });

  it('blocks a GIT_CONFIG_KEY_n identity injection', () => {
    const command =
      `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=user.name GIT_CONFIG_VALUE_0=${TOOL} ` +
      'git commit -m "feat: x"';
    const verdict = inspect(command);
    assert.equal(verdict.blocked, true);
    assert.equal(verdict.where, 'GIT_CONFIG_KEY_0 on git commit');
  });

  it('resolves the effective identity against the -C target', () => {
    const asked = [];
    const verdict = inspect('git -C other/repo commit -m "feat: x"', {
      resolveIdentity: (cwd) => {
        asked.push(cwd);
        return cwd === '/repo/other/repo' ? AI_USER : HUMAN;
      },
    });
    assert.deepEqual(asked, ['/repo/other/repo'], 'the shell cwd is not the committing repo');
    assert.equal(verdict.blocked, true);
  });

  it('resolves a relative message file against the -C target', () => {
    const asked = [];
    inspect('git -C other/repo commit -F msg.txt', {
      readMessageFile: (file, cwd) => {
        asked.push([file, cwd]);
        return '';
      },
    });
    assert.deepEqual(asked, [['msg.txt', '/repo/other/repo']]);
  });

  it('reads the message from a `<` redirect feeding `-F -`', () => {
    const verdict = inspect('git commit -F - < msg.txt', {
      readMessageFile: () => `feat: x\n\nCo-Authored-By: ${TOOL} <a@b>`,
    });
    assert.equal(verdict.blocked, true);
    assert.equal(verdict.where, 'git commit message file msg.txt');
  });

  it('allows read-only config queries that author nothing', () => {
    for (const command of [
      `git config --get user.name ${TOOL.toLowerCase()}`,
      'git config --list',
      'git config --unset user.name',
    ]) {
      assert.deepEqual(inspect(command), { blocked: false }, command);
    }
  });
});

// These run against the REAL reader and real files: the whole question is
// whether bytes on disk reach the rules, which a fake reader cannot answer.
describe('guard — message files are read in full', () => {
  let dir;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostwriter-files-'));
  });

  after(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  function withRealReader(command) {
    return inspectCommand(command, {
      cwd: dir,
      env: {},
      readMessageFile: readTextFile,
      resolveIdentity: () => HUMAN,
    });
  }

  it('finds attribution buried in the middle of a large message', () => {
    const file = path.join(dir, 'big.txt');
    const filler = `${'x'.repeat(99)}\n`.repeat(6000); // ~600 KB either side
    fs.writeFileSync(file, `feat: x\n\n${filler}Co-Authored-By: ${TOOL} <a@b>\n${filler}`);
    assert.ok(fs.statSync(file).size > 1024 * 1024, 'fixture must exceed any sampling window');
    const verdict = withRealReader(`git commit -F ${file}`);
    assert.equal(verdict.blocked, true, 'a sampled read would have missed this');
    assert.equal(verdict.rule, 'aiCoAuthorTrailer');
  });

  it('clears a large clean message', () => {
    const file = path.join(dir, 'big-clean.txt');
    fs.writeFileSync(file, `feat: x\n\n${`${'x'.repeat(99)}\n`.repeat(20000)}`);
    assert.deepEqual(withRealReader(`git commit -F ${file}`), { blocked: false });
  });

  it('blocks a file too large to inspect rather than assuming it is clean', () => {
    const file = path.join(dir, 'huge.txt');
    fs.writeFileSync(file, 'feat: x\n');
    fs.truncateSync(file, MAX_MESSAGE_FILE_BYTES + 1); // sparse — no bytes written
    const read = readTextFile(file, dir);
    assert.equal(read.truncated, true);
    const verdict = withRealReader(`git commit -F ${file}`);
    assert.equal(verdict.blocked, true);
    assert.equal(verdict.rule, 'unverifiableMessage');
  });

  it('treats an unreadable file as empty, not as a block', () => {
    assert.deepEqual(readTextFile(path.join(dir, 'missing.txt'), dir), {
      text: '',
      truncated: false,
    });
    assert.deepEqual(withRealReader('git commit -F missing.txt'), { blocked: false });
  });

  it('accepts a plain string from an injected reader', () => {
    const verdict = inspect('git commit -F msg.txt', {
      readMessageFile: () => `feat: x\n\nCo-Authored-By: ${TOOL} <a@b>`,
    });
    assert.equal(verdict.blocked, true);
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
