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
const { spawnSync } = require('node:child_process');

const {
  inspectCommand,
  inspectToolCall,
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
    resolveAccount: () => 'a-human-login',
    resolveCommitInfo: () => ({ ...HUMAN, message: 'feat: clean' }),
    expected: { emails: [], logins: [], configured: false },
    ...overrides,
  });
}

/**
 * A mail-formatted patch, as `git format-patch` writes one.
 *
 * The diff deliberately CONTAINS an attribution trailer: excluding the diff is
 * the behaviour under test, and a reader that inspected the whole file would
 * block every case below — including the ones that must pass.
 */
function patch(overrides) {
  const {
    from = 'Ada Lovelace <ada@example.com>',
    subject = 'feat: a change',
    body = 'Why it changed.',
  } = overrides || {};
  return [
    'From 8a3f4c2e0f9b Mon Sep 17 00:00:00 2001',
    `From: ${from}`,
    'Date: Mon, 2 Jun 2025 10:00:00 +0000',
    `Subject: [PATCH v2 1/2] ${subject}`,
    '',
    body,
    '---',
    ' lib/rules.js | 1 +',
    'diff --git a/lib/rules.js b/lib/rules.js',
    '--- a/lib/rules.js',
    '+++ b/lib/rules.js',
    `+  reject('Co-Authored-By: ${TOOL} <a@b>');`,
    '',
  ].join('\n');
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

  it('resolves the effective identity against --git-dir / GIT_DIR', () => {
    for (const command of [
      'git --git-dir=/other/.git commit -m "feat: x"',
      'GIT_DIR=/other/.git git commit -m "feat: x"',
    ]) {
      const asked = [];
      const verdict = inspect(command, {
        resolveIdentity: (cwd, gitDir) => {
          asked.push([cwd, gitDir]);
          return gitDir === '/other/.git' ? AI_USER : HUMAN;
        },
      });
      assert.deepEqual(asked, [['/repo', '/other/.git']], command);
      assert.equal(verdict.blocked, true, command);
    }
  });

  it('resolves a relative --git-dir against the -C target', () => {
    const asked = [];
    inspect('git -C sub --git-dir=rel/.git commit -m "feat: x"', {
      resolveIdentity: (cwd, gitDir) => {
        asked.push([cwd, gitDir]);
        return HUMAN;
      },
    });
    assert.deepEqual(asked, [['/repo/sub', '/repo/sub/rel/.git']]);
  });

  it('reads a message file named with an attached -F', () => {
    const verdict = inspect('git commit -Fmsg.txt', {
      readMessageFile: () => `feat: x\n\nCo-Authored-By: ${TOOL} <a@b>`,
    });
    assert.equal(verdict.blocked, true);
    assert.equal(verdict.rule, 'aiCoAuthorTrailer');
  });

  it('compounds repeated -C values the way git does', () => {
    const asked = [];
    inspect('git -C outer -C inner commit -m "feat: x"', {
      resolveIdentity: (cwd) => {
        asked.push(cwd);
        return HUMAN;
      },
    });
    assert.deepEqual(asked, ['/repo/outer/inner'], 'the last -C alone is the wrong directory');
  });

  // Nesting re-quotes the payload at every level, so the exact rule that fires
  // depends on how the newlines survive. What must hold at any depth is that
  // the attribution is SEEN.
  it('inspects a commit buried in several levels of shell', () => {
    for (let depth = 1; depth <= 5; depth++) {
      let command = `git commit -m "x\n\nCo-Authored-By: ${TOOL} <a@b>"`;
      for (let i = 0; i < depth; i++) command = `bash -c ${JSON.stringify(command)}`;
      assert.equal(inspect(command).blocked, true, `depth ${depth}`);
    }
  });

  it('refuses a command nested past the traversal cap rather than allowing it', () => {
    let command = 'git commit -m "feat: x"';
    for (let i = 0; i < 9; i++) command = `bash -c ${JSON.stringify(command)}`;
    const verdict = inspect(command);
    assert.equal(verdict.blocked, true);
    assert.equal(verdict.rule, 'unverifiableCommand');
  });

  it('carries an identity assignment into a shell the wrapper spawns', () => {
    // `GIT_AUTHOR_NAME=… bash -c "git commit"` — the spawned shell inherits it.
    const verdict = inspect(`GIT_AUTHOR_NAME=${TOOL} bash -c "git commit -m ok"`);
    assert.equal(verdict.blocked, true);
    assert.equal(verdict.rule, 'aiIdentity');
  });

  it('reads the config file a GIT_CONFIG_GLOBAL redirect points at', () => {
    const seen = [];
    const verdict = inspect('GIT_CONFIG_GLOBAL=/tmp/other.cfg git commit -m "feat: x"', {
      resolveIdentity: (cwd, gitDir, sources) => {
        seen.push(sources);
        return sources && sources.GIT_CONFIG_GLOBAL ? AI_USER : HUMAN;
      },
    });
    assert.deepEqual(seen, [{ GIT_CONFIG_GLOBAL: '/tmp/other.cfg' }]);
    assert.equal(verdict.blocked, true, 'reading the guard-side config would clear this');
  });

  it('blocks an author copied from a bot commit, and allows a human one', () => {
    const BOT = { name: 'proj-botApp[bot]', email: 'x@users.noreply.github.com' };
    for (const command of ['git cherry-pick abc123', 'git commit -C abc123']) {
      const verdict = inspect(command, {
        resolveCommitInfo: () => ({ ...BOT, message: 'feat: clean' }),
      });
      assert.equal(verdict.blocked, true, command);
      assert.equal(verdict.where, 'the author copied from abc123', command);
    }
    assert.deepEqual(inspect('git cherry-pick abc123'), { blocked: false });
  });

  // `commit -C` copies the message as well as the author. Checking one and not
  // the other leaves half the copy uninspected.
  it('blocks an attributed message copied from another commit', () => {
    for (const command of ['git cherry-pick abc123', 'git commit -C abc123']) {
      const verdict = inspect(command, {
        resolveCommitInfo: () => ({
          ...HUMAN,
          message: `feat: x\n\nCo-Authored-By: ${TOOL} <a@b>`,
        }),
      });
      assert.equal(verdict.blocked, true, command);
      assert.equal(verdict.rule, 'aiCoAuthorTrailer', command);
      assert.equal(verdict.where, 'the message copied from abc123', command);
    }
  });

  it('allows a copy whose author and message are both clean', () => {
    assert.deepEqual(
      inspect('git commit -C abc123', {
        resolveCommitInfo: () => ({ ...HUMAN, message: 'feat: a clean subject' }),
      }),
      { blocked: false }
    );
  });

  it('leaves a revert alone — git authors it as the reverter', () => {
    const BOT = { name: 'some-bot', email: 'b@x.com' };
    assert.deepEqual(
      inspect('git revert abc123', {
        resolveCommitInfo: () => ({ ...BOT, message: 'feat: clean' }),
      }),
      {
        blocked: false,
      }
    );
  });

  it('allows an unresolvable ref, which git would reject itself', () => {
    assert.deepEqual(
      inspect('git cherry-pick nope', {
        resolveCommitInfo: () => ({ name: '', email: '', message: '' }),
      }),
      { blocked: false }
    );
  });

  // `git am` names a file and nothing else. Every other pass sees a clean
  // command and a clean configured user; the byline is inside the patch.
  it('blocks a patch authored by a tool', () => {
    const verdict = inspect('git am bot.patch', {
      readMessageFile: () => patch({ from: `${TOOL} <noreply@example.com>` }),
    });
    assert.equal(verdict.blocked, true);
    assert.equal(verdict.where, 'the author in bot.patch');
  });

  it('blocks an attribution trailer in a patch message', () => {
    const verdict = inspect('git am mail.patch', {
      readMessageFile: () => patch({ body: `Fixes the thing.\n\nCo-Authored-By: ${TOOL} <a@b>` }),
    });
    assert.equal(verdict.blocked, true);
    assert.equal(verdict.rule, 'aiCoAuthorTrailer');
    assert.equal(verdict.where, 'the message in mail.patch');
  });

  // The diff below `---` is content. Reading it as a message would block any
  // patch that touches a file discussing these rules — this plugin's own.
  it('ignores the diff, so a patch that edits these rules still applies', () => {
    assert.deepEqual(inspect('git am rules.patch', { readMessageFile: () => patch({}) }), {
      blocked: false,
    });
  });

  // An in-body `From:` is how a patch keeps its author through a mailing list
  // that rewrites the envelope, and git prefers it over the header.
  it('prefers the in-body From: over the mail header, as git does', () => {
    const verdict = inspect('git am relayed.patch', {
      readMessageFile: () =>
        patch({ from: 'Ada <ada@example.com>', body: `From: ${TOOL} <a@b>\n\nreal body` }),
    });
    assert.equal(verdict.blocked, true);
    assert.equal(verdict.where, 'the author in relayed.patch');
  });

  it('checks every patch in an mbox, not just the first', () => {
    const verdict = inspect('git am series.mbox', {
      readMessageFile: () => patch({}) + patch({ from: `${TOOL} <a@b>`, subject: 'feat: second' }),
    });
    assert.equal(verdict.blocked, true);
    assert.equal(verdict.where, 'the author in series.mbox');
  });

  it('leaves a patch from another human alone — that is what am is for', () => {
    const verdict = inspect('git am contributor.patch', {
      expected: { emails: ['ada@example.com'], logins: [], configured: true },
      readMessageFile: () => patch({ from: 'Grace Hopper <grace@example.com>' }),
    });
    assert.deepEqual(verdict, { blocked: false });
  });

  it('allows the resume and abort forms, which apply no patch', () => {
    for (const command of ['git am --continue', 'git am --abort', 'git am --skip']) {
      assert.deepEqual(inspect(command), { blocked: false }, command);
    }
  });

  it('blocks a patch it cannot read, and allows one that is not there', () => {
    const verdict = inspect('git am locked.patch', {
      readMessageFile: () => ({ text: '', unreadable: 'EACCES' }),
    });
    assert.equal(verdict.blocked, true);
    assert.equal(verdict.where, 'the patch locked.patch');
    assert.deepEqual(
      inspect('git am gone.patch', {
        readMessageFile: () => ({ text: '', unreadable: 'ENOENT' }),
      }),
      { blocked: false }
    );
  });

  it('follows a GIT_DIR inherited from the session, not just the command', () => {
    const asked = [];
    inspect('git commit -m "feat: x"', {
      env: { GIT_DIR: '/other/.git' },
      resolveIdentity: (cwd, gitDir) => {
        asked.push(gitDir);
        return HUMAN;
      },
    });
    assert.deepEqual(asked, ['/other/.git']);
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

  it('allows a missing file, which git would reject itself', () => {
    assert.equal(readTextFile(path.join(dir, 'missing.txt'), dir).unreadable, 'ENOENT');
    assert.deepEqual(withRealReader('git commit -F missing.txt'), { blocked: false });
  });

  // A file that is THERE and unreadable is a message nobody saw. Clearing it
  // would make `chmod 000` the cheapest way past every rule in the plugin.
  it('blocks a file that exists but cannot be read', () => {
    const read = { text: '', unreadable: 'EACCES' };
    const verdict = inspect('git commit -F secret.txt', { readMessageFile: () => read });
    assert.equal(verdict.blocked, true);
    assert.equal(verdict.rule, 'unverifiableMessage');
    assert.match(verdict.evidence, /EACCES/);
  });

  // Reading a pipe is worse than useless: it reports size 0, so the check
  // passes on an empty string, and it consumes the bytes git was going to use.
  it('refuses to clear a message that is not a regular file', () => {
    const fifo = path.join(dir, 'fifo');
    const made = spawnSync('mkfifo', [fifo]);
    if (made.status !== 0) return; // no mkfifo here — the unit case above covers it
    assert.equal(readTextFile(fifo, dir).unreadable, 'ENOTREG');
    const verdict = withRealReader(`git commit -F ${fifo}`);
    assert.equal(verdict.blocked, true);
    assert.equal(verdict.rule, 'unverifiableMessage');
  });

  it('treats a directory named as a message file the way git does', () => {
    fs.mkdirSync(path.join(dir, 'notes'), { recursive: true });
    assert.equal(readTextFile(path.join(dir, 'notes'), dir).unreadable, 'EISDIR');
    assert.deepEqual(withRealReader('git commit -F notes'), { blocked: false });
  });

  // End to end on real bytes: the byline is inside the file, and the trailer
  // in the diff below it must not count against the patch.
  it('reads a real patch file, headers only', () => {
    fs.writeFileSync(path.join(dir, 'bot.patch'), patch({ from: `${TOOL} <a@b>` }));
    fs.writeFileSync(path.join(dir, 'ok.patch'), patch({}));
    const verdict = withRealReader('git am bot.patch');
    assert.equal(verdict.blocked, true);
    assert.equal(verdict.where, 'the author in bot.patch');
    assert.deepEqual(withRealReader('git am ok.patch'), { blocked: false });
  });

  it('accepts a plain string from an injected reader', () => {
    const verdict = inspect('git commit -F msg.txt', {
      readMessageFile: () => `feat: x\n\nCo-Authored-By: ${TOOL} <a@b>`,
    });
    assert.equal(verdict.blocked, true);
  });
});

// A commit is not the only thing that gets signed. These cover the prose an
// agent publishes to GitHub, and the account it publishes under.
describe('guard — pull requests, issues and comments', () => {
  const FOOTER = `Looks good.\n\n_Generated by [${TOOL} Code](https://${TOOL.toLowerCase()}.ai/code)_`;

  it('blocks an attribution footer on a gh comment, PR or issue', () => {
    for (const command of [
      `gh pr comment 1 --body "${FOOTER}"`,
      `gh pr create --title x --body "${FOOTER}"`,
      `gh issue comment 1 -b "${FOOTER}"`,
      `gh api repos/o/r/issues/1/comments -f body="${FOOTER}"`,
    ]) {
      const verdict = inspect(command);
      assert.equal(verdict.blocked, true, command);
      assert.equal(verdict.rule, 'aiAttributionLink', command);
    }
  });

  it('blocks the same footer arriving through an MCP tool call', () => {
    const verdict = inspectToolCall(
      'mcp__github__add_issue_comment',
      { issue_number: 1, body: FOOTER },
      { env: {}, resolveAccount: () => 'human' }
    );
    assert.equal(verdict.blocked, true);
    assert.equal(verdict.where, 'mcp__github__add_issue_comment body');
  });

  it('blocks a commit message pushed through the API rather than git', () => {
    const verdict = inspectToolCall(
      'mcp__github__push_files',
      { message: `feat: x\n\nCo-Authored-By: ${TOOL} <a@b>` },
      { env: {} }
    );
    assert.equal(verdict.blocked, true);
    assert.equal(verdict.rule, 'aiCoAuthorTrailer');
  });

  it('allows ordinary posts', () => {
    assert.deepEqual(inspect('gh pr comment 1 --body "Looks good, shipping."'), { blocked: false });
    assert.deepEqual(inspect('gh pr list --limit 5'), { blocked: false });
    assert.deepEqual(
      inspectToolCall(
        'mcp__github__create_pull_request',
        { title: 'feat: x', body: 'Adds it.' },
        {}
      ),
      { blocked: false }
    );
  });

  // A PR that documents this very rule quotes it. Quoting an example is not
  // signing a document, and blocking it would make the plugin undocumentable.
  it('allows attribution quoted inside a code block, but not a real footer', () => {
    const documenting = `Blocks trailers like:\n\n\`\`\`\nCo-Authored-By: ${TOOL} <x>\n\`\`\`\n\nThat is the point.`;
    assert.deepEqual(inspectToolCall('mcp__github__issue_write', { body: documenting }, {}), {
      blocked: false,
    });
    const inlineQuoted = `We reject \`Co-Authored-By: ${TOOL}\` on commits.`;
    assert.deepEqual(inspectToolCall('mcp__github__issue_write', { body: inlineQuoted }, {}), {
      blocked: false,
    });
    assert.equal(inspectToolCall('mcp__github__issue_write', { body: FOOTER }, {}).blocked, true);
  });
});

describe('guard — the posting account', () => {
  it('blocks posting as a bot or tool-named account', () => {
    for (const login of ['my-release-bot', `${TOOL.toLowerCase()}-app`, 'thing[bot]']) {
      const verdict = inspect('gh pr comment 1 --body ok', { resolveAccount: () => login });
      assert.equal(verdict.blocked, true, login);
      assert.match(verdict.where, /the account gh would post as/);
    }
  });

  it('allows posting as a human account', () => {
    assert.deepEqual(inspect('gh pr comment 1 --body ok', { resolveAccount: () => 'ada' }), {
      blocked: false,
    });
  });

  it('blocks a token override, which replaces the account the guard can read', () => {
    const verdict = inspect('GH_TOKEN=xyz gh pr comment 1 --body ok');
    assert.equal(verdict.blocked, true);
    assert.equal(verdict.rule, 'unverifiableAccount');
  });

  it('allows an unreadable account when no human is pinned', () => {
    assert.deepEqual(inspect('gh pr comment 1 --body ok', { resolveAccount: () => '' }), {
      blocked: false,
    });
  });
});

describe('guard — a pinned human identity', () => {
  const pinned = {
    expected: { emails: ['me@example.com'], logins: ['my-login'], configured: true },
  };

  it('accepts the pinned human and refuses anyone else', () => {
    assert.deepEqual(
      inspect('gh pr comment 1 --body ok', { ...pinned, resolveAccount: () => 'my-login' }),
      { blocked: false }
    );
    const other = inspect('gh pr comment 1 --body ok', {
      ...pinned,
      resolveAccount: () => 'someone-else',
    });
    assert.equal(other.rule, 'unexpectedIdentity');
  });

  it('refuses a commit by anyone but the pinned human, bot or not', () => {
    const stranger = inspect('git commit -m "feat: x"', {
      ...pinned,
      resolveIdentity: () => ({ name: 'Someone Else', email: 'other@example.com' }),
    });
    assert.equal(stranger.rule, 'unexpectedIdentity');
    assert.deepEqual(
      inspect('git commit -m "feat: x"', {
        ...pinned,
        resolveIdentity: () => ({ name: 'Me', email: 'me@example.com' }),
      }),
      { blocked: false }
    );
  });

  it('refuses an unreadable account once a human is pinned', () => {
    const verdict = inspect('gh pr comment 1 --body ok', { ...pinned, resolveAccount: () => '' });
    assert.equal(verdict.rule, 'unverifiableAccount');
  });

  // The credential lives in the MCP server, so no inspection of the call can
  // reveal the poster. Pinned mode refuses that gap instead of assuming it.
  it('refuses an MCP post once a human is pinned, since the poster is unknowable', () => {
    const verdict = inspectToolCall('mcp__github__add_issue_comment', { body: 'ok' }, pinned);
    assert.equal(verdict.blocked, true);
    assert.equal(verdict.rule, 'unverifiableAccount');
  });

  it('leaves MCP posts alone when no human is pinned', () => {
    assert.deepEqual(inspectToolCall('mcp__github__add_issue_comment', { body: 'ok' }, {}), {
      blocked: false,
    });
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
