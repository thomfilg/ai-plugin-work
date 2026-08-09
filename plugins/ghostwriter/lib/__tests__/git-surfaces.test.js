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

const { scanCommand, hasAuthorshipSurface, parseAuthorSpec } = require('../git-surfaces');

const TOOL = ['Cl', 'aude'].join('');

/** Wrap `inner` in `depth` levels of `bash -c`, quoting correctly each time. */
function nestShell(depth, inner) {
  let command = inner;
  for (let i = 0; i < depth; i++) command = `bash -c ${JSON.stringify(command)}`;
  return command;
}

/** The single surface of a command, asserted to exist. */
function onlySurface(command) {
  const { surfaces } = scanCommand(command);
  assert.equal(surfaces.length, 1, `expected exactly one surface in: ${command}`);
  return surfaces[0];
}

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

  it('keeps an identity env prefix that precedes the wrapper', () => {
    const surface = onlySurface(`GIT_AUTHOR_NAME=${TOOL} env git commit -m x`);
    assert.deepEqual(surface.identities, [{ source: 'GIT_AUTHOR_NAME', name: TOOL, email: '' }]);
  });

  // The idiomatic `env` form puts the assignment AFTER the wrapper word, where
  // a naive "slice from the git token" peel would drop it.
  it('keeps an identity assignment that sits between the wrapper and git', () => {
    const surface = onlySurface(`env GIT_AUTHOR_NAME=${TOOL} git commit -m "feat: x"`);
    assert.deepEqual(surface.identities, [{ source: 'GIT_AUTHOR_NAME', name: TOOL, email: '' }]);
  });

  it('keeps GIT_CONFIG_* pairs that sit between the wrapper and git', () => {
    const surface = onlySurface(
      `env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=user.name GIT_CONFIG_VALUE_0=${TOOL} git commit -m x`
    );
    assert.deepEqual(surface.identities, [{ source: 'GIT_CONFIG_KEY_0', name: TOOL, email: '' }]);
  });

  it('keeps assignments on both sides of the wrapper word', () => {
    const surface = onlySurface(
      `GIT_COMMITTER_NAME=${TOOL} env GIT_AUTHOR_NAME=${TOOL} git commit -m x`
    );
    assert.deepEqual(surface.identities.map((entry) => entry.source).sort(), [
      'GIT_AUTHOR_NAME',
      'GIT_COMMITTER_NAME',
    ]);
  });

  it('sees through an eval payload', () => {
    assert.equal(onlySurface('eval "git commit -m \'feat: x\'"').kind, 'commit');
  });

  it('still ignores a wrapper that runs something else', () => {
    assert.deepEqual(scanCommand('bash -c "npm test"').surfaces, []);
    assert.deepEqual(scanCommand('env FOO=bar ls -la').surfaces, []);
  });

  // A nested payload arrives as `bash -c "git commit …"`, where the character
  // in front of `git` is a QUOTE. A probe that only accepted whitespace missed
  // every payload nested more than one level deep.
  it('sees through nesting more than one level deep', () => {
    for (let depth = 1; depth <= 5; depth++) {
      const command = nestShell(depth, 'git commit -m "feat: x"');
      const { surfaces } = scanCommand(command);
      assert.equal(surfaces.length, 1, `depth ${depth}`);
      assert.deepEqual(surfaces[0].messages, ['feat: x'], `depth ${depth}`);
    }
  });

  // Bounded work is right; giving up must not read as "nothing here".
  it('marks a command buried past the cap as unverifiable, not clean', () => {
    const { surfaces } = scanCommand(nestShell(8, 'git commit -m x'));
    assert.equal(surfaces.length, 1);
    assert.equal(surfaces[0].unverifiable, 'wrapper-depth');
  });

  it('does not mark deep wrappers that run something else', () => {
    assert.deepEqual(scanCommand(nestShell(8, 'ls -la')).surfaces, []);
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

  // git accepts the value attached to the cluster, with no space. A reader
  // that only handles the spaced form never sees this message or file at all.
  it('reads an ATTACHED short-flag value', () => {
    assert.deepEqual(onlySurface('git commit -mhello').messages, ['hello']);
    assert.deepEqual(onlySurface('git commit -amhello').messages, ['hello']);
    assert.deepEqual(onlySurface('git commit -Fmsg.txt').messageFiles, ['msg.txt']);
    assert.deepEqual(onlySurface('git commit -aFmsg.txt').messageFiles, ['msg.txt']);
  });

  it("does not let one attached cluster claim the other flag's value", () => {
    assert.deepEqual(onlySurface('git commit -Fmsg.txt').messages, []);
    assert.deepEqual(onlySurface('git commit -mhello').messageFiles, []);
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
    assert.deepEqual(onlySurface('git -C /other/repo commit -m x').dirs, ['/other/repo']);
    assert.deepEqual(onlySurface('git commit -m x').dirs, []);
  });

  // git COMPOUNDS them: `-C outer -C inner` lands in outer/inner, so keeping
  // only the last would resolve against the wrong directory.
  it('keeps every -C value in order, because they compound', () => {
    assert.deepEqual(onlySurface('git -C outer -C inner commit -m x').dirs, ['outer', 'inner']);
  });

  // `--git-dir` selects the repository whose CONFIG git reads, independently
  // of the process directory — so it decides which identity the commit gets.
  it('records --git-dir and GIT_DIR as the config-bearing target', () => {
    assert.equal(onlySurface('git --git-dir=/other/.git commit -m x').gitDir, '/other/.git');
    assert.equal(onlySurface('git --git-dir /other/.git commit -m x').gitDir, '/other/.git');
    assert.equal(onlySurface('GIT_DIR=/other/.git git commit -m x').gitDir, '/other/.git');
    assert.equal(onlySurface('git commit -m x').gitDir, null);
  });

  it('keeps -C and --git-dir separate — they select different things', () => {
    const surface = onlySurface('git -C sub --git-dir=rel/.git commit -m x');
    assert.deepEqual(surface.dirs, ['sub']);
    assert.equal(surface.gitDir, 'rel/.git');
  });

  it('does not treat --work-tree as config-bearing', () => {
    assert.equal(onlySurface('git --work-tree=/other commit -m x').gitDir, null);
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

  // These point git at DIFFERENT config FILES. The identity in them is the one
  // git uses, so the guard has to read the same files.
  it('records GIT_CONFIG_GLOBAL / GIT_CONFIG_SYSTEM redirects', () => {
    assert.deepEqual(onlySurface('GIT_CONFIG_GLOBAL=/tmp/a.cfg git commit -m x').configSources, {
      GIT_CONFIG_GLOBAL: '/tmp/a.cfg',
    });
    assert.deepEqual(onlySurface('GIT_CONFIG_SYSTEM=/tmp/b.cfg git commit -m x').configSources, {
      GIT_CONFIG_SYSTEM: '/tmp/b.cfg',
    });
    assert.deepEqual(onlySurface('git commit -m x').configSources, {});
  });

  // cherry-pick and `commit -C` copy the SOURCE commit's author, so the
  // configured identity is not the one that lands.
  it('records the commits an author is copied from', () => {
    assert.deepEqual(onlySurface('git cherry-pick abc123').authorRefs, ['abc123']);
    assert.deepEqual(onlySurface('git commit -C abc123').authorRefs, ['abc123']);
    assert.deepEqual(onlySurface('git commit --reuse-message=abc123').authorRefs, ['abc123']);
  });

  it('does not treat a revert as copying an author, because git does not', () => {
    assert.deepEqual(onlySurface('git revert abc123').authorRefs, []);
    assert.deepEqual(onlySurface('git commit -m x').authorRefs, []);
  });

  // `git am` carries its author and its message INSIDE the file, so the file
  // has to be collected — but as a patch, not as a message: only part of it is
  // one, and the rest is a diff.
  it('collects the patches an am would apply', () => {
    assert.deepEqual(onlySurface('git am bot.patch').patchFiles, ['bot.patch']);
    assert.deepEqual(onlySurface('git am -3 a.patch b.patch').patchFiles, ['a.patch', 'b.patch']);
    assert.deepEqual(onlySurface('git am bot.patch').messageFiles, []);
  });

  it('reads a patch fed by a redirect, in either spelling', () => {
    assert.deepEqual(onlySurface('git am < p.mbox').patchFiles, ['p.mbox']);
    assert.deepEqual(onlySurface('git am <p.mbox').patchFiles, ['p.mbox']);
  });

  // Without the value-flag list `build` reads as a patch, and the guard then
  // reports a directory it cannot inspect — a block on a valid command.
  it('does not mistake a flag value for a patch', () => {
    assert.deepEqual(onlySurface('git am --directory build p.mbox').patchFiles, ['p.mbox']);
    assert.deepEqual(onlySurface('git am --exclude=doc/* p.mbox').patchFiles, ['p.mbox']);
  });

  it('collects nothing from the resume and abort forms', () => {
    for (const command of ['git am --continue', 'git am --abort', 'git am --skip']) {
      assert.deepEqual(onlySurface(command).patchFiles, [], command);
    }
  });

  // An am that names no file reads its patch from a pipe. Reporting an empty
  // list would let `cat bot.patch | git am` clear on a clean configured user.
  it('records an am whose patch arrives on stdin', () => {
    for (const command of ['cat bot.patch | git am', 'git am', 'git am -', 'git am <(gen)']) {
      const surface = scanCommand(command).surfaces.find((entry) => entry.kind === 'am');
      assert.equal(surface.patchStdin, true, command);
    }
  });

  it('does not call a named patch or a resume form stdin', () => {
    for (const command of ['git am p.mbox', 'git am < p.mbox', 'git am --continue']) {
      assert.equal(onlySurface(command).patchStdin, false, command);
    }
  });

  it('reads a GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n identity pair', () => {
    const surface = onlySurface(
      `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=user.name GIT_CONFIG_VALUE_0=${TOOL} git commit -m x`
    );
    assert.deepEqual(surface.identities, [{ source: 'GIT_CONFIG_KEY_0', name: TOOL, email: '' }]);
  });

  // `--config-env` takes a value, so a parser that does not know that reads
  // the value as the SUBCOMMAND and loses the surface entirely.
  it('does not lose the subcommand to a two-token --config-env', () => {
    for (const command of [
      'git --config-env=user.name=MYVAR commit -m x',
      'git --config-env user.name=MYVAR commit -m x',
    ]) {
      assert.equal(onlySurface(command).kind, 'commit', command);
    }
  });

  it('resolves --config-env against the command’s own assignment', () => {
    const surface = onlySurface(`MYVAR=${TOOL} git --config-env=user.name=MYVAR commit -m x`);
    assert.deepEqual(surface.identities, [
      { source: '--config-env user.name', name: TOOL, email: '' },
    ]);
  });

  it('records --config-env as a reference when the command does not set it', () => {
    const surface = onlySurface('git --config-env=user.email=MYVAR commit -m x');
    assert.deepEqual(surface.identities, [
      { source: '--config-env user.email', key: 'user.email', envVar: 'MYVAR' },
    ]);
  });

  it('ignores --config-env for keys that are not an identity', () => {
    assert.deepEqual(onlySurface('git --config-env=core.editor=ED commit -m x').identities, []);
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
