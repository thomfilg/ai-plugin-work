// GH-699 two-direction corpus: reference vs mutation.
//
// Every vector from the ticket (and the transcript-mined friction classes) is
// pinned in BOTH directions — the read/prose/reference form must be ALLOWED,
// and the closest genuinely-mutating counterpart must still be BLOCKED — so
// the structured analyzer can never silently widen into a bypass.
//
// Discovered by plugins/work/scripts/run-tests.sh (searches plugins/heimdall/).
// Manual: node --test plugins/heimdall/lib/__tests__/guard-read-friction.test.js

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildEntries, evaluate } = require(path.resolve(__dirname, '..', 'guard'));

let base; // realpath'd scratch OUTSIDE any temp prefix (temp paths are exempt by design)
let transcriptEmpty;

const LOCKS = [
  { protect: ['packages/ui'], unlockPhrase: 'edit ui' },
  { protect: ['package.json'], unlockPhrase: 'edit package.json' },
  { protect: ['.claude'], unlockPhrase: 'edit .claude', allowedPaths: ['plans'] },
];

before(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.heimdall-gh699-')));
  fs.mkdirSync(path.join(base, 'packages', 'ui'), { recursive: true });
  fs.mkdirSync(path.join(base, 'docs', 'ui'), { recursive: true });
  fs.mkdirSync(path.join(base, '.claude', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(base, 'package.json'), '{}\n');
  fs.writeFileSync(path.join(base, 'packages', 'ui', 'vitest.config.ts'), 'export default {}\n');
  const txDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-gh699-tx-'));
  transcriptEmpty = path.join(txDir, 'empty.jsonl');
  fs.writeFileSync(
    transcriptEmpty,
    JSON.stringify({ type: 'user', message: { content: 'hello' } }) + '\n'
  );
});

after(() => {
  fs.rmSync(base, { recursive: true, force: true });
  fs.rmSync(path.dirname(transcriptEmpty), { recursive: true, force: true });
});

const bash = (command) =>
  evaluate({
    toolName: 'Bash',
    toolInput: { command },
    transcriptPath: transcriptEmpty,
    entries: buildEntries(LOCKS, base),
    cwd: base,
  });

const allow = (command, why) => {
  const r = bash(command);
  assert.equal(r.exitCode, 0, `${why}\ncommand: ${command}\n${r.message}`);
};
const blockCmd = (command, why) => {
  const r = bash(command);
  assert.equal(r.exitCode, 2, `${why}\ncommand: ${command}`);
};

// ─── GH-699 reported vectors (must ALLOW) ────────────────────────────────────

describe('GH-699 vectors: non-mutating references are allowed', () => {
  it('vector 1 — worktree add + find whose OUTPUT would list protected paths', () => {
    allow(
      "git worktree add ../wt-cap-vitest origin/main && find packages -name 'vitest.config.ts'",
      'a read/list command must not block because results will mention packages/ui'
    );
  });

  it('vector 1b — find rooted AT the protected dir without a mutating expression', () => {
    allow("find packages/ui -name '*.config.ts'", 'listing inside a protect-kind lock is a read');
  });

  it('vector 3 — tmux operator message that only MENTIONS the protected path', () => {
    allow(
      'tmux send-keys -t maestro "Please review the diff in packages/ui/vitest.config.ts before merging" Enter',
      'prose typed into another pane is not a write'
    );
  });

  it('vector 4 — gh pr create whose body names protected paths', () => {
    allow(
      'gh pr create --title "chore: cap vitest workers" --body "Touches packages/ui/vitest.config.ts and packages/web/vitest.config.ts"',
      'PR body text is data sent to GitHub, not a local write'
    );
  });

  it('vector 4b — heredoc-composed PR body naming protected paths', () => {
    allow(
      'gh pr create --body "$(cat <<\'EOF\'\nCaps workers in packages/ui/vitest.config.ts\nEOF\n)"',
      'heredoc bodies are data unless fed to an interpreter'
    );
  });

  it('commit message naming the protected path', () => {
    allow(
      'git commit -m "fix(ui): cap workers in packages/ui/vitest.config.ts"',
      'git commit writes the object db, not the protected tree'
    );
  });
});

// ─── Transcript-mined friction classes (must ALLOW) ──────────────────────────

describe('read/build friction classes are allowed', () => {
  it('cd into the protected dir followed by a read/test', () => {
    allow('cd packages/ui && pnpm test', 'cd+read must not block (old cd-template FP)');
    allow('cd packages/ui && cat vitest.config.ts', 'cd+cat is a read');
  });

  it('compound reads referencing the protected path', () => {
    allow('cat packages/ui/vitest.config.ts | head -5 && echo done', 'piped read');
    allow('git diff origin/main -- packages/ui/vitest.config.ts', 'git diff is a read');
    allow(
      'git checkout main && echo "packages/ui"',
      'marker in a different segment than the mutator'
    );
  });

  it('xargs with a read-only child', () => {
    allow('grep -rl workers packages/ui | xargs grep -l threads', 'read|xargs read');
  });

  it('reading the protected package.json', () => {
    allow('cat package.json', 'protect-kind reads are free');
    allow('cat package.json | jq .scripts', 'piped read of a protected file');
    allow(
      `node -e "console.log(require('${path.join(base, 'package.json')}').name)"`,
      'GH-656 interpreter read'
    );
  });

  it('build tools whose text carries the short marker', () => {
    allow('pnpm build', 'GH-642 regression: ui inside build');
    allow('pnpm --filter ui build', 'bare package selector is not a write target');
  });

  it('write ops fully correlated to UNPROTECTED targets', () => {
    allow('echo "packages/ui updated" && rm /tmp/heimdall-scratch.txt', 'rm targets /tmp');
    allow('grep workers packages/ui/vitest.config.ts > /tmp/out.txt', 'redirect to /tmp');
    allow(
      'curl -o /tmp/out.json https://api.example.com/ui/packages',
      'URL mention, output to /tmp'
    );
    allow('rm docs/ui/notes.md', 'same-basename dir elsewhere in the repo is not the entry');
    allow('sed -i s/x/y/ docs/ui/notes.md', 'in-place edit of a different ui dir');
  });

  it('allowedPaths subdir stays writable', () => {
    allow('echo plan > .claude/plans/note.md', 'allowedPaths subdir is exempt');
  });

  it('cp FROM the protected path (source-only read)', () => {
    allow(
      `cp ${path.join(base, 'packages', 'ui', 'vitest.config.ts')} /tmp/backup.ts`,
      'source survives'
    );
  });
});

// ─── Mutation counterparts (must BLOCK) ──────────────────────────────────────

describe('the closest mutating counterparts still block', () => {
  it('direct writes into the protected dir', () => {
    blockCmd('rm -rf packages/ui', 'rm of the entry');
    blockCmd('rm packages/ui/vitest.config.ts', 'rm inside the entry');
    blockCmd('echo x > packages/ui/hack.txt', 'redirect into the entry');
    blockCmd('echo x >packages/ui/hack.txt', 'no-space redirect into the entry');
    blockCmd('cp /tmp/evil packages/ui/vitest.config.ts', 'cp INTO the entry');
    blockCmd('mv packages/ui/vitest.config.ts /tmp/stash.ts', 'mv OUT destroys the source');
    blockCmd('dd if=/dev/zero of=packages/ui/blob', 'dd of= into the entry');
    blockCmd('tee packages/ui/x', 'tee into the entry');
    blockCmd('sed -i s/a/b/ packages/ui/vitest.config.ts', 'in-place edit');
    blockCmd('touch packages/ui/new.ts', 'touch creates inside the entry');
  });

  it('destructive op on an ancestor SPELLED VIA the entry takes it with it', () => {
    // The guard is reference-triggered (parity with main): an unnamed ancestor
    // (`rm -rf packages`) never enters evaluation, but any spelling that names
    // the entry and resolves to an ancestor is caught by resolution.
    blockCmd('rm -rf packages/ui/..', 'dot-dot ancestor rm destroys the protected dir');
  });

  it('cd into the protected dir then a RELATIVE write', () => {
    blockCmd('cd packages/ui && sed -i s/a/b/ vitest.config.ts', 'cwd tracking');
    blockCmd('cd packages/ui && rm vitest.config.ts', 'cwd tracking rm');
  });

  it('execution channels are analyzed recursively', () => {
    blockCmd('tmux send-keys -t x "rm -rf packages/ui" Enter', 'send-keys payload executes');
    blockCmd("sh -c 'rm packages/ui/x'", 'sh -c');
    blockCmd('bash -lc "rm packages/ui/x"', 'clustered -lc');
    blockCmd('eval "rm packages/ui/x"', 'eval');
    blockCmd('echo $(rm packages/ui/x)', 'command substitution executes');
    blockCmd('echo `rm packages/ui/x`', 'backticks execute');
    blockCmd('ssh devbox "rm -rf packages/ui"', 'remote command may hit a mount');
    blockCmd('mycustomrunner rm -rf packages/ui', 'runner-style operand command');
    blockCmd('concurrently "rm packages/ui/x" "tsc -w"', 'quoted operand command');
  });

  it('stdin-fed writers stay fail-closed when the command names the entry', () => {
    blockCmd('grep -l workers packages/ui/* | xargs rm', 'xargs rm with protected input');
    blockCmd("find packages/ui -name '*.log' -delete", 'find -delete rooted at the entry');
    blockCmd("find packages/ui -name '*.log' -exec rm {} \\;", 'mutating find rooted at the entry');
  });

  it('interpreter write APIs referencing the entry', () => {
    blockCmd(`node -e 'require("fs").writeFileSync("packages/ui/x","y")'`, 'node write API');
    blockCmd(`python3 -c "open('packages/ui/x','w').write('y')"`, 'python write API');
  });

  it('git tree-mutating subcommands naming the entry', () => {
    blockCmd('git checkout -- packages/ui', 'checkout pathspec materializes files');
    blockCmd('git clean -fd packages/ui', 'clean deletes inside the entry');
  });

  it('obfuscated writes still block (GH-655 machinery preserved)', () => {
    blockCmd("rm packages/u''i/vitest.config.ts", 'quote-split marker');
    blockCmd('rm packages/{ui,web}/vitest.config.ts', 'brace expansion');
    blockCmd('rm packages/u[i]/vitest.config.ts', 'single-char class');
  });

  it('protected package.json writes', () => {
    blockCmd('sed -i s/x/y/ package.json', 'in-place edit of the protected file');
    blockCmd('tee package.json', 'tee overwrite');
    blockCmd(`mv ${path.join(base, 'package.json')} /tmp/pj.bak`, 'mv out');
  });

  it('unresolvable targets naming the entry stay fail-closed', () => {
    blockCmd('rm $SCRATCH/packages/ui/x', 'variable prefix cannot be resolved');
    blockCmd('cp /tmp/x "$(pwd)/packages/ui/y"', 'substitution prefix cannot be resolved');
  });
});

// ─── Precision: same-basename file elsewhere is not the entry ────────────────

describe('resolve-first precision (both directions)', () => {
  it('a nested package.json is a different file', () => {
    allow('sed -i s/x/y/ docs/package.json', 'nested manifest is not the protected root manifest');
  });

  it('but the protected file blocks via any equivalent spelling', () => {
    blockCmd('sed -i s/x/y/ ./package.json', 'dot-prefixed spelling');
    blockCmd(`sed -i s/x/y/ ${path.join(base, 'package.json')}`, 'absolute spelling');
  });
});
