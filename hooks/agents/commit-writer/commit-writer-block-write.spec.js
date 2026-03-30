#!/usr/bin/env node

/**
 * Spec tests for commit-writer-block-write.js PreToolUse hook.
 *
 * Validates exit code behavior:
 *   exit 0  = allow (no stdout needed)
 *   exit 2  = block (stderr contains reason)
 *
 * Run: node ${CLAUDE_PLUGIN_ROOT}/hooks/agents/commit-writer/commit-writer-block-write.spec.js
 */

const { execSync } = require('child_process');
const path = require('path');
const assert = require('assert');

const HOOK = path.join(__dirname, 'commit-writer-block-write.js');

let pass = 0;
let fail = 0;
const failures = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Pipe JSON input into the hook and return { exitCode, stdout, stderr } */
function execHook(input) {
  const escaped = JSON.stringify(input).replace(/'/g, "'\\''");
  try {
    const stdout = execSync(`echo '${escaped}' | node "${HOOK}"`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { exitCode: 0, stdout: stdout.trim(), stderr: '' };
  } catch (err) {
    return {
      exitCode: err.status,
      stdout: (err.stdout || '').trim(),
      stderr: (err.stderr || '').trim(),
    };
  }
}

/** Pipe raw string input into the hook (for malformed JSON tests) */
function execHookRaw(rawInput) {
  const escaped = rawInput.replace(/'/g, "'\\''");
  try {
    const stdout = execSync(`echo '${escaped}' | node "${HOOK}"`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { exitCode: 0, stdout: stdout.trim(), stderr: '' };
  } catch (err) {
    return {
      exitCode: err.status,
      stdout: (err.stdout || '').trim(),
      stderr: (err.stderr || '').trim(),
    };
  }
}

function describe(suite, fn) {
  console.log(`\n  ${suite}`);
  fn();
}

function it(desc, fn) {
  try {
    fn();
    console.log(`    PASS  ${desc}`);
    pass++;
  } catch (err) {
    console.log(`    FAIL  ${desc}`);
    console.log(`          ${err.message}`);
    fail++;
    failures.push({ desc, error: err.message });
  }
}

// ---------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------

console.log('commit-writer-block-write.js');

describe('read-only tools → exit 0 (allow)', () => {
  for (const tool of ['Read', 'Grep', 'Glob']) {
    it(`should allow ${tool}`, () => {
      const r = execHook({ tool_name: tool, tool_input: {} });
      assert.strictEqual(r.exitCode, 0, `Expected exit 0, got ${r.exitCode}`);
    });
  }
});

describe('safe git commands → exit 0 (allow)', () => {
  const safeCommands = [
    ['git status', 'git status'],
    ['git commit', 'git commit -m "feat: test"'],
    ['git diff', 'git diff --staged'],
    ['git log', 'git log --oneline -5'],
    ['git show', 'git show HEAD'],
    ['git push', 'git push origin main'],
    ['git branch', 'git branch -a'],
    ['git remote', 'git remote -v'],
    ['git config', 'git config user.name'],
    ['git rev-parse', 'git rev-parse HEAD'],
    ['git tag', 'git tag -l'],
    ['git ls-files', 'git ls-files --others'],
    ['git cat-file', 'git cat-file -t HEAD'],
    ['git describe', 'git describe --tags'],
    ['git shortlog', 'git shortlog -sn'],
    ['git name-rev', 'git name-rev HEAD'],
    ['git for-each-ref', 'git for-each-ref refs/heads'],
  ];

  for (const [name, cmd] of safeCommands) {
    it(`should allow ${name}`, () => {
      const r = execHook({ tool_name: 'Bash', tool_input: { command: cmd } });
      assert.strictEqual(r.exitCode, 0, `Expected exit 0, got ${r.exitCode}. stderr: ${r.stderr}`);
    });
  }
});

describe('setup chain commands → exit 0 (allow)', () => {
  it('should allow grep package.json', () => {
    const r = execHook({ tool_name: 'Bash', tool_input: { command: 'grep commitizen package.json' } });
    assert.strictEqual(r.exitCode, 0);
  });

  it('should allow ls .commitlintrc', () => {
    const r = execHook({ tool_name: 'Bash', tool_input: { command: 'ls .commitlintrc' } });
    assert.strictEqual(r.exitCode, 0);
  });
});

describe('unsafe git commands → exit 2 (block)', () => {
  const unsafeCommands = [
    ['git add', 'git add apps/foo.tsx'],
    ['git add (chained)', 'git add . && git commit -m "test"'],
    ['git reset', 'git reset HEAD~1'],
    ['git reset --soft', 'git reset --soft HEAD~1'],
    ['git checkout', 'git checkout -- .'],
    ['git stash', 'git stash pop'],
    ['git rebase', 'git rebase main'],
    ['git revert', 'git revert HEAD'],
    ['git merge', 'git merge feature'],
    ['git clean', 'git clean -fd'],
    ['git rm', 'git rm file.txt'],
    ['git restore', 'git restore --staged .'],
    ['git cherry-pick', 'git cherry-pick abc123'],
    ['git push --force', 'git push --force origin main'],
    ['git push -f', 'git push -f origin main'],
    ['git branch -D', 'git branch -D feature'],
    ['git branch -d', 'git branch -d feature'],
    ['destructive after safe (&&)', 'git diff --staged && git reset --soft HEAD~1'],
    ['destructive after safe (;)', 'git log --oneline; git rebase main'],
    ['git add hidden in chain', 'git commit -m "test" && git add .'],
    ['safe git + non-git (&&)', 'git status && rm -rf /'],
    ['safe git + non-git (;)', 'git push origin main; echo pwned'],
    ['safe git + non-git (|)', 'git log | head -5'],
  ];

  for (const [name, cmd] of unsafeCommands) {
    it(`should block ${name}`, () => {
      const r = execHook({ tool_name: 'Bash', tool_input: { command: cmd } });
      assert.strictEqual(r.exitCode, 2, `Expected exit 2 for "${cmd}", got ${r.exitCode}`);
      assert.match(r.stderr, /COMMIT-WRITER GUARD/, `stderr should contain guard message`);
      assert.match(r.stderr, /[Bb]locked/, `stderr should mention "Blocked"`);
    });
  }
});

describe('non-git Bash commands → exit 2 (block)', () => {
  for (const cmd of ['ls -la', 'cat /etc/passwd', 'echo hello', 'rm -rf /', 'curl http://evil.com']) {
    it(`should block: ${cmd}`, () => {
      const r = execHook({ tool_name: 'Bash', tool_input: { command: cmd } });
      assert.strictEqual(r.exitCode, 2, `Expected exit 2, got ${r.exitCode}`);
      assert.match(r.stderr, /COMMIT-WRITER GUARD/);
    });
  }
});

describe('non-Bash tools → exit 2 (block)', () => {
  for (const tool of ['Write', 'Edit', 'MultiEdit', 'Task', 'Skill', 'NotebookEdit', 'WebFetch']) {
    it(`should block ${tool}`, () => {
      const r = execHook({ tool_name: tool, tool_input: {} });
      assert.strictEqual(r.exitCode, 2, `Expected exit 2, got ${r.exitCode}`);
      assert.match(r.stderr, /COMMIT-WRITER GUARD/);
      assert.match(r.stderr, /not allowed/);
    });
  }
});

describe('malformed input → exit 2 (fail-fast)', () => {
  it('should exit 2 on malformed JSON', () => {
    const r = execHookRaw('{invalid');
    assert.strictEqual(r.exitCode, 2, `Expected exit 2, got ${r.exitCode}`);
    assert.match(r.stderr, /COMMIT-WRITER GUARD/, 'stderr should contain guard message');
    assert.match(r.stderr, /Failed to parse/, 'stderr should mention parse failure');
  });

  it('should exit 2 on empty stdin', () => {
    const r = execHookRaw('');
    assert.strictEqual(r.exitCode, 2, `Expected exit 2, got ${r.exitCode}`);
    assert.match(r.stderr, /COMMIT-WRITER GUARD/, 'stderr should contain guard message');
  });
});

describe('edge cases', () => {
  it('should block empty command', () => {
    const r = execHook({ tool_name: 'Bash', tool_input: { command: '' } });
    assert.strictEqual(r.exitCode, 2);
  });

  it('should block missing tool_input', () => {
    const r = execHook({ tool_name: 'Bash', tool_input: {} });
    assert.strictEqual(r.exitCode, 2);
  });

  it('should block unknown tool name', () => {
    const r = execHook({ tool_name: 'SomethingNew', tool_input: {} });
    assert.strictEqual(r.exitCode, 2);
  });

  it('should allow git command with leading whitespace', () => {
    const r = execHook({ tool_name: 'Bash', tool_input: { command: '  git status' } });
    assert.strictEqual(r.exitCode, 0);
  });

  it('should allow git log with --grep containing destructive keyword', () => {
    const r = execHook({ tool_name: 'Bash', tool_input: { command: 'git log --grep="git reset"' } });
    assert.strictEqual(r.exitCode, 0, `Should not false-positive on argument content. stderr: ${r.stderr}`);
  });

  it('should produce no stdout on allow (clean exit)', () => {
    const r = execHook({ tool_name: 'Read', tool_input: {} });
    assert.strictEqual(r.exitCode, 0);
    assert.strictEqual(r.stdout, '', 'stdout should be empty on allow');
  });

  it('should produce no stdout on block (message goes to stderr only)', () => {
    const r = execHook({ tool_name: 'Write', tool_input: {} });
    assert.strictEqual(r.exitCode, 2);
    assert.strictEqual(r.stdout, '', 'stdout should be empty on block');
    assert.ok(r.stderr.length > 0, 'stderr should contain the block reason');
  });
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('\n' + '='.repeat(50));
console.log(`Results: ${pass} passed, ${fail} failed`);

if (failures.length > 0) {
  console.log('\nFailures:');
  failures.forEach((f, i) => console.log(`  ${i + 1}. ${f.desc}: ${f.error}`));
}

console.log('='.repeat(50));
process.exit(fail > 0 ? 1 : 0);
