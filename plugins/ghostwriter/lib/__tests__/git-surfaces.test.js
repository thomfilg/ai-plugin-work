/**
 * Unit tests for lib/git-surfaces.js — the quote-aware reader that decides
 * which parts of a shell command author a git object.
 *
 * The two properties worth the most here are the negative ones: talking ABOUT
 * a commit (`echo "git commit …"`) is not a commit, and a git command that
 * writes nothing authored (`git status`) is not a surface. Everything the
 * guard does downstream is scoped by these answers.
 *
 * Run with: node --test plugins/ghostwriter/lib/__tests__/git-surfaces.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { tokenize, scanCommand, hasAuthorshipSurface, parseAuthorSpec } = require('../git-surfaces');

const TOOL = ['Cl', 'aude'].join('');

/** The single surface of a command, asserted to exist. */
function onlySurface(command) {
  const { surfaces } = scanCommand(command);
  assert.equal(surfaces.length, 1, `expected exactly one surface in: ${command}`);
  return surfaces[0];
}

describe('tokenize', () => {
  it('splits on control operators outside quotes', () => {
    assert.deepEqual(tokenize('npm test && git status'), [
      ['npm', 'test'],
      ['git', 'status'],
    ]);
    assert.deepEqual(tokenize('a; b | c'), [['a'], ['b'], ['c']]);
  });

  it('keeps operators that live inside quotes', () => {
    assert.deepEqual(tokenize('echo "a && b"'), [['echo', 'a && b']]);
    assert.deepEqual(tokenize("echo 'x; y'"), [['echo', 'x; y']]);
  });

  it('keeps newlines inside a quoted message', () => {
    const [segment] = tokenize('git commit -m "line one\n\nline two"');
    assert.deepEqual(segment, ['git', 'commit', '-m', 'line one\n\nline two']);
  });

  it('keeps a heredoc body that rides inside a quoted substitution', () => {
    const command = 'git commit -m "$(cat <<\'EOF\'\nfeat: x\n\nfooter\nEOF\n)"';
    const [segment] = tokenize(command);
    assert.ok(segment[3].includes('footer'), 'heredoc body must survive tokenizing');
  });

  it('honours backslash escapes and unterminated quotes', () => {
    assert.deepEqual(tokenize('echo a\\ b'), [['echo', 'a b']]);
    assert.deepEqual(tokenize('echo "unterminated'), [['echo', 'unterminated']]);
  });
});

describe('scanCommand — what is not a surface', () => {
  it('ignores a command that merely talks about committing', () => {
    assert.deepEqual(scanCommand(`echo "Co-Authored-By: ${TOOL}"`).surfaces, []);
    assert.deepEqual(scanCommand('grep -r "git commit" .').surfaces, []);
  });

  it('ignores read-only git commands', () => {
    for (const command of ['git status', 'git log --oneline', 'git diff HEAD']) {
      assert.deepEqual(scanCommand(command).surfaces, [], command);
    }
  });

  it('ignores non-git commands and empty input', () => {
    assert.deepEqual(scanCommand('ls -la').surfaces, []);
    assert.deepEqual(scanCommand('').surfaces, []);
    assert.deepEqual(scanCommand(null).surfaces, []);
  });

  it('ignores a git config write that is not an identity write', () => {
    assert.deepEqual(scanCommand('git config core.editor vim').surfaces, []);
  });

  // A read authors nothing. `git config --get <name> <value-pattern>` is the
  // sharp edge: the trailing pattern reads like a value being written.
  it('ignores read-only and removing git config actions', () => {
    for (const command of [
      `git config --get user.name ${TOOL.toLowerCase()}`,
      'git config --get-all user.email',
      'git config --get-regexp user.*',
      'git config --list',
      'git config -l',
      'git config --unset user.name',
      'git config --remove-section user',
    ]) {
      assert.deepEqual(scanCommand(command).surfaces, [], command);
    }
  });
});

describe('scanCommand — wrappers', () => {
  it('sees through a shell -c payload', () => {
    for (const shell of ['bash', 'sh', 'zsh', '/bin/bash']) {
      const { surfaces } = scanCommand(`${shell} -c "git commit -m 'feat: x'"`);
      assert.equal(surfaces.length, 1, shell);
      assert.equal(surfaces[0].kind, 'commit', shell);
      assert.deepEqual(surfaces[0].messages, ['feat: x'], shell);
    }
  });

  it('sees through argv wrappers, keeping their env prefix', () => {
    for (const command of [
      'env git commit -m "feat: x"',
      'command git commit -m "feat: x"',
      'sudo -u someone git commit -m "feat: x"',
      'timeout 30 git commit -m "feat: x"',
      'xargs -n1 git commit -m "feat: x"',
      'nice -n 10 git commit -m "feat: x"',
    ]) {
      const { surfaces } = scanCommand(command);
      assert.equal(surfaces.length, 1, command);
      assert.deepEqual(surfaces[0].messages, ['feat: x'], command);
    }
  });

  it('keeps an identity env prefix across the wrapper', () => {
    const surface = onlySurface(`GIT_AUTHOR_NAME=${TOOL} env git commit -m x`);
    assert.deepEqual(surface.identities, [{ source: 'GIT_AUTHOR_NAME', name: TOOL, email: '' }]);
  });

  it('sees through an eval payload', () => {
    assert.equal(onlySurface('eval "git commit -m \'feat: x\'"').kind, 'commit');
  });

  it('still ignores a wrapper that runs something else', () => {
    assert.deepEqual(scanCommand('bash -c "npm test"').surfaces, []);
    assert.deepEqual(scanCommand('env FOO=bar ls -la').surfaces, []);
  });

  it('stops peeling at a bounded depth rather than recursing forever', () => {
    const deep = 'bash -c "bash -c \'bash -c \\"bash -c git commit -m x\\"\'"';
    assert.doesNotThrow(() => scanCommand(deep));
  });
});

describe('scanCommand — message surfaces', () => {
  it('reads -m, --message and --message=', () => {
    assert.deepEqual(onlySurface('git commit -m "feat: x"').messages, ['feat: x']);
    assert.deepEqual(onlySurface('git commit --message "feat: x"').messages, ['feat: x']);
    assert.deepEqual(onlySurface('git commit --message=feat').messages, ['feat']);
  });

  it('reads a combined short flag such as -am', () => {
    assert.deepEqual(onlySurface('git commit -am "fix: y"').messages, ['fix: y']);
  });

  it('reads repeated -m paragraphs', () => {
    assert.deepEqual(onlySurface('git commit -m subject -m body').messages, ['subject', 'body']);
  });

  it('reads -F / --file message files', () => {
    assert.deepEqual(onlySurface('git commit -F msg.txt').messageFiles, ['msg.txt']);
    assert.deepEqual(onlySurface('git commit --file=msg.txt').messageFiles, ['msg.txt']);
  });

  // `-F -` reads the message from stdin, and a redirect is where stdin comes
  // from — so the redirect target is a message file like any other.
  it('reads a `<` redirect target as a message file', () => {
    assert.ok(onlySurface('git commit -F - < msg.txt').messageFiles.includes('msg.txt'));
    assert.ok(onlySurface('git commit -F - <msg.txt').messageFiles.includes('msg.txt'));
  });

  it('records the -C target so later checks follow the right repository', () => {
    assert.equal(onlySurface('git -C /other/repo commit -m x').dir, '/other/repo');
    assert.equal(onlySurface('git commit -m x').dir, null);
  });

  it('sees through git global flags', () => {
    const surface = onlySurface('git -C /tmp/repo --no-pager commit -m "feat: x"');
    assert.equal(surface.kind, 'commit');
    assert.deepEqual(surface.messages, ['feat: x']);
  });

  it('recognises an absolute git binary path', () => {
    assert.equal(onlySurface('/usr/bin/git commit -m x').kind, 'commit');
  });

  it('covers annotated tags, merges and notes', () => {
    for (const [command, kind] of [
      ['git tag -a v1 -m "release"', 'tag'],
      ['git merge --no-ff -m "merge"', 'merge'],
      ['git notes add -m "note"', 'notes'],
    ]) {
      const surface = onlySurface(command);
      assert.equal(surface.kind, kind);
      assert.equal(surface.writesMessage, true);
    }
  });

  it('finds the commit inside a chained command', () => {
    const { surfaces } = scanCommand('npm test && git add -A && git commit -m "feat: x"');
    assert.equal(surfaces.length, 1);
    assert.deepEqual(surfaces[0].messages, ['feat: x']);
  });
});

describe('scanCommand — identity surfaces', () => {
  it('reads --author in both spellings', () => {
    const spaced = onlySurface(`git commit --author "${TOOL} <a@b.com>" -m x`);
    assert.deepEqual(spaced.identities, [{ source: '--author', name: TOOL, email: 'a@b.com' }]);
    const equals = onlySurface(`git commit --author=${TOOL} -m x`);
    assert.deepEqual(equals.identities, [{ source: '--author', name: TOOL, email: '' }]);
  });

  it('reads GIT_AUTHOR_* / GIT_COMMITTER_* env prefixes', () => {
    const surface = onlySurface(`GIT_AUTHOR_NAME=${TOOL} GIT_AUTHOR_EMAIL=a@b.com git commit -m x`);
    assert.deepEqual(surface.identities, [
      { source: 'GIT_AUTHOR_NAME', name: TOOL, email: '' },
      { source: 'GIT_AUTHOR_EMAIL', name: '', email: 'a@b.com' },
    ]);
  });

  it('ignores unrelated env prefixes', () => {
    assert.deepEqual(onlySurface('FOO=bar git commit -m x').identities, []);
  });

  it('reads a per-invocation `-c user.name=…` override', () => {
    const surface = onlySurface(`git -c user.name=${TOOL} -c user.email=a@b.com commit -m x`);
    assert.equal(surface.kind, 'commit', 'the -c pair must not hide the subcommand');
    assert.deepEqual(surface.identities, [
      { source: '-c user.name', name: TOOL, email: '' },
      { source: '-c user.email', name: '', email: 'a@b.com' },
    ]);
  });

  it('ignores `-c` overrides for keys that are not an identity', () => {
    assert.deepEqual(onlySurface('git -c core.editor=vim commit -m x').identities, []);
  });

  it('reads a GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n identity pair', () => {
    const surface = onlySurface(
      `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=user.name GIT_CONFIG_VALUE_0=${TOOL} git commit -m x`
    );
    assert.deepEqual(surface.identities, [{ source: 'GIT_CONFIG_KEY_0', name: TOOL, email: '' }]);
  });

  it('ignores GIT_CONFIG_* pairs for keys that are not an identity', () => {
    const surface = onlySurface(
      'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.editor GIT_CONFIG_VALUE_0=vim git commit -m x'
    );
    assert.deepEqual(surface.identities, []);
  });

  it('ignores a GIT_CONFIG_KEY_n with no matching value', () => {
    assert.deepEqual(onlySurface('GIT_CONFIG_KEY_0=user.name git commit -m x').identities, []);
  });

  it('reads git config identity writes at any scope', () => {
    const local = onlySurface(`git config user.name "${TOOL}"`);
    assert.equal(local.kind, 'config');
    assert.deepEqual(local.identities, [{ source: 'user.name', name: TOOL, email: '' }]);
    const global = onlySurface('git config --global user.email a@b.com');
    assert.deepEqual(global.identities, [{ source: 'user.email', name: '', email: 'a@b.com' }]);
  });

  it('marks commit-writing subcommands so the repo identity gets checked', () => {
    for (const command of ['git commit -m x', 'git revert HEAD', 'git cherry-pick abc123']) {
      assert.equal(onlySurface(command).writesCommit, true, command);
    }
  });
});

describe('hasAuthorshipSurface / parseAuthorSpec', () => {
  it('answers the cheap question the hook asks on its error path', () => {
    assert.equal(hasAuthorshipSurface('git commit -m x'), true);
    assert.equal(hasAuthorshipSurface('git status'), false);
  });

  it('splits an author spec into name and email', () => {
    assert.deepEqual(parseAuthorSpec('Ada Lovelace <ada@example.com>'), {
      name: 'Ada Lovelace',
      email: 'ada@example.com',
    });
    assert.deepEqual(parseAuthorSpec('Ada'), { name: 'Ada', email: '' });
  });
});
