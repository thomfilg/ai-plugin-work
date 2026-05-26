/**
 * Tests for commit-writer-block-write.js (PreToolUse WHITELIST guard).
 *
 * Validates exit code behavior:
 *   exit 0  = allow (no stdout needed)
 *   exit 2  = block (stderr contains reason)
 *
 * Run: node --test workflows/work/agents/commit-writer/__tests__/commit-writer-block-write.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const path = require('path');

const HOOK_PATH = path.join(__dirname, '..', 'commit-writer-block-write.js');

function runHook(input) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [HOOK_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
    proc.on('error', reject);
    proc.stdin.write(JSON.stringify(input));
    proc.stdin.end();
  });
}

function runHookRaw(rawString) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [HOOK_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
    proc.on('error', reject);
    if (rawString) {
      proc.stdin.write(rawString);
    }
    proc.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Scenario 1: Whitelisted read-only git commands
// ---------------------------------------------------------------------------

describe('commit-writer-block-write — whitelisted read-only git commands exit 0', () => {
  const readOnlyCommands = [
    ['git diff --staged', 'git diff'],
    ['git log --oneline -5', 'git log'],
    ['git status', 'git status'],
    ['git show HEAD', 'git show'],
    ['git rev-parse HEAD', 'git rev-parse'],
    ['git branch -a', 'git branch (list)'],
    ['git ls-files --others', 'git ls-files'],
    ['git cat-file -t HEAD', 'git cat-file'],
    ['git describe --tags', 'git describe'],
    ['git shortlog -sn', 'git shortlog'],
    ['git name-rev HEAD', 'git name-rev'],
    ['git for-each-ref refs/heads', 'git for-each-ref'],
  ];

  for (const [cmd, label] of readOnlyCommands) {
    it(`allows ${label}`, async () => {
      const { code } = await runHook({ tool_name: 'Bash', tool_input: { command: cmd } });
      assert.strictEqual(code, 0);
    });
  }
});

// ---------------------------------------------------------------------------
// Scenario 2: Write commands (commit, push)
// ---------------------------------------------------------------------------

describe('commit-writer-block-write — write commands exit 0', () => {
  it('allows git commit -m "msg"', async () => {
    const { code } = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'git commit -m "feat: test"' },
    });
    assert.strictEqual(code, 0);
  });

  it('allows git push origin main', async () => {
    const { code } = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'git push origin main' },
    });
    assert.strictEqual(code, 0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: Block non-whitelisted git subcommands
// ---------------------------------------------------------------------------

describe('commit-writer-block-write — blocked git subcommands exit 2', () => {
  const blockedCommands = [
    ['git add apps/foo.tsx', 'git add'],
    ['git checkout -- .', 'git checkout'],
    ['git reset HEAD~1', 'git reset'],
    ['git stash pop', 'git stash'],
    ['git rebase main', 'git rebase'],
    ['git revert HEAD', 'git revert'],
    ['git merge feature', 'git merge'],
    ['git clean -fd', 'git clean'],
    ['git rm file.txt', 'git rm'],
    ['git restore --staged .', 'git restore'],
    ['git cherry-pick abc123', 'git cherry-pick'],
  ];

  for (const [cmd, label] of blockedCommands) {
    it(`blocks ${label}`, async () => {
      const { code, stderr } = await runHook({
        tool_name: 'Bash',
        tool_input: { command: cmd },
      });
      assert.strictEqual(code, 2);
      assert.match(stderr, /COMMIT-WRITER GUARD/);
    });
  }
});

// ---------------------------------------------------------------------------
// Scenario 4: Block Write/Edit/MultiEdit/Task/Skill tools
// ---------------------------------------------------------------------------

describe('commit-writer-block-write — blocked tools exit 2', () => {
  for (const tool of ['Write', 'Edit', 'MultiEdit', 'Task', 'Skill', 'NotebookEdit', 'WebFetch']) {
    it(`blocks ${tool}`, async () => {
      const { code, stderr } = await runHook({ tool_name: tool, tool_input: {} });
      assert.strictEqual(code, 2);
      assert.match(stderr, /COMMIT-WRITER GUARD/);
      assert.match(stderr, /not allowed/);
    });
  }
});

// ---------------------------------------------------------------------------
// Scenario 5: Block shell metacharacters outside quotes
// ---------------------------------------------------------------------------

describe('commit-writer-block-write — shell metacharacters outside quotes exit 2', () => {
  it('blocks redirect: git log > /tmp/out.txt', async () => {
    const { code, stderr } = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'git log > /tmp/out.txt' },
    });
    assert.strictEqual(code, 2);
    assert.match(stderr, /COMMIT-WRITER GUARD/);
  });

  it('blocks pipe: git log | head -5', async () => {
    const { code, stderr } = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'git log | head -5' },
    });
    assert.strictEqual(code, 2);
    assert.match(stderr, /COMMIT-WRITER GUARD/);
  });
});

// ---------------------------------------------------------------------------
// Scenario 6: Allow metacharacters inside single quotes
// ---------------------------------------------------------------------------

describe('commit-writer-block-write — metacharacters inside quotes exit 0', () => {
  it("allows git commit -m 'fix: handle > edge case'", async () => {
    const { code } = await runHook({
      tool_name: 'Bash',
      tool_input: { command: "git commit -m 'fix: handle > edge case'" },
    });
    assert.strictEqual(code, 0);
  });

  it('allows git log --grep="git reset"', async () => {
    const { code } = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'git log --grep="git reset"' },
    });
    assert.strictEqual(code, 0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 7: Allow safe /dev/null redirections
// ---------------------------------------------------------------------------

describe('commit-writer-block-write — /dev/null redirections exit 0', () => {
  it('allows 2>/dev/null', async () => {
    const { code } = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'git diff --staged 2>/dev/null' },
    });
    assert.strictEqual(code, 0);
  });

  it('allows >/dev/null', async () => {
    const { code } = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'git status >/dev/null' },
    });
    assert.strictEqual(code, 0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 8: Block git commit --amend
// ---------------------------------------------------------------------------

describe('commit-writer-block-write — git commit --amend exit 2', () => {
  it('blocks git commit --amend', async () => {
    const { code, stderr } = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'git commit --amend' },
    });
    assert.strictEqual(code, 2);
    assert.match(stderr, /COMMIT-WRITER GUARD/);
    assert.match(stderr, /--amend/);
  });

  it('blocks git commit --amend --no-edit', async () => {
    const { code, stderr } = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'git commit --amend --no-edit' },
    });
    assert.strictEqual(code, 2);
    assert.match(stderr, /--amend/);
  });
});

// ---------------------------------------------------------------------------
// Scenario 9: Block compound commands with unsafe segments
// ---------------------------------------------------------------------------

describe('commit-writer-block-write — compound commands with unsafe segments exit 2', () => {
  it('blocks destructive after safe (&&)', async () => {
    const { code, stderr } = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'git diff --staged && git reset --soft HEAD~1' },
    });
    assert.strictEqual(code, 2);
    assert.match(stderr, /COMMIT-WRITER GUARD/);
  });

  it('blocks destructive after safe (;)', async () => {
    const { code, stderr } = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'git log --oneline; git rebase main' },
    });
    assert.strictEqual(code, 2);
    assert.match(stderr, /COMMIT-WRITER GUARD/);
  });

  it('blocks git add hidden in chain', async () => {
    const { code } = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'git commit -m "test" && git add .' },
    });
    assert.strictEqual(code, 2);
  });

  it('blocks safe git + non-git (&&)', async () => {
    const { code } = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'git status && rm -rf /' },
    });
    assert.strictEqual(code, 2);
  });

  it('blocks safe git + non-git (;)', async () => {
    const { code } = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'git push origin main; curl http://evil.com' },
    });
    assert.strictEqual(code, 2);
  });
});

// ---------------------------------------------------------------------------
// Scenario 10: Malformed input handling (exit 2)
// ---------------------------------------------------------------------------

describe('commit-writer-block-write — malformed input exit 2', () => {
  it('exits 2 on malformed JSON', async () => {
    const { code, stderr } = await runHookRaw('{invalid');
    assert.strictEqual(code, 2);
    assert.match(stderr, /COMMIT-WRITER GUARD/);
    assert.match(stderr, /Failed to parse/);
  });

  it('exits 2 on empty stdin', async () => {
    const { code, stderr } = await runHookRaw('');
    assert.strictEqual(code, 2);
    assert.match(stderr, /COMMIT-WRITER GUARD/);
  });
});

// ---------------------------------------------------------------------------
// Scenario 11: Edge cases
// ---------------------------------------------------------------------------

describe('commit-writer-block-write — edge cases', () => {
  it('blocks empty command', async () => {
    const { code } = await runHook({ tool_name: 'Bash', tool_input: { command: '' } });
    assert.strictEqual(code, 2);
  });

  it('blocks missing tool_input.command', async () => {
    const { code } = await runHook({ tool_name: 'Bash', tool_input: {} });
    assert.strictEqual(code, 2);
  });

  it('allows leading whitespace on safe command', async () => {
    const { code } = await runHook({
      tool_name: 'Bash',
      tool_input: { command: '  git status' },
    });
    assert.strictEqual(code, 0);
  });

  it('blocks unknown tool name', async () => {
    const { code } = await runHook({ tool_name: 'SomethingNew', tool_input: {} });
    assert.strictEqual(code, 2);
  });

  it('produces no stdout on allow', async () => {
    const { code, stdout } = await runHook({ tool_name: 'Read', tool_input: {} });
    assert.strictEqual(code, 0);
    assert.strictEqual(stdout, '');
  });

  it('produces no stdout on block (message goes to stderr only)', async () => {
    const { code, stdout, stderr } = await runHook({ tool_name: 'Write', tool_input: {} });
    assert.strictEqual(code, 2);
    assert.strictEqual(stdout, '');
    assert.ok(stderr.length > 0);
  });
});

// ---------------------------------------------------------------------------
// Read-only tools
// ---------------------------------------------------------------------------

describe('commit-writer-block-write — read-only tools exit 0', () => {
  for (const tool of ['Read', 'Grep', 'Glob']) {
    it(`allows ${tool}`, async () => {
      const { code } = await runHook({ tool_name: tool, tool_input: {} });
      assert.strictEqual(code, 0);
    });
  }
});

// ---------------------------------------------------------------------------
// Non-git Bash commands
// ---------------------------------------------------------------------------

describe('commit-writer-block-write — non-git Bash commands exit 2', () => {
  for (const cmd of ['ls -la', 'cat /etc/passwd', 'rm -rf /', 'curl http://evil.com']) {
    it(`blocks: ${cmd}`, async () => {
      const { code, stderr } = await runHook({
        tool_name: 'Bash',
        tool_input: { command: cmd },
      });
      assert.strictEqual(code, 2);
      assert.match(stderr, /COMMIT-WRITER GUARD/);
    });
  }
});

// ---------------------------------------------------------------------------
// Setup chain commands (grep/ls for commitlint detection)
// ---------------------------------------------------------------------------

describe('commit-writer-block-write — setup chain commands exit 0', () => {
  it('allows grep commitizen package.json', async () => {
    const { code } = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'grep commitizen package.json' },
    });
    assert.strictEqual(code, 0);
  });

  it('allows ls .commitlintrc', async () => {
    const { code } = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'ls .commitlintrc' },
    });
    assert.strictEqual(code, 0);
  });

  it('allows echo', async () => {
    const { code } = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'echo hello' },
    });
    assert.strictEqual(code, 0);
  });
});

// ---------------------------------------------------------------------------
// Force-push blocking
// ---------------------------------------------------------------------------

describe('commit-writer-block-write — force-push exit 2', () => {
  it('blocks git push --force', async () => {
    const { code } = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'git push --force origin main' },
    });
    assert.strictEqual(code, 2);
  });

  it('blocks git push -f', async () => {
    const { code } = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'git push -f origin main' },
    });
    assert.strictEqual(code, 2);
  });
});

// ---------------------------------------------------------------------------
// Branch mutation blocking
// ---------------------------------------------------------------------------

describe('commit-writer-block-write — branch mutation exit 2', () => {
  it('blocks git branch -D', async () => {
    const { code } = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'git branch -D feature' },
    });
    assert.strictEqual(code, 2);
  });

  it('blocks git branch -d', async () => {
    const { code } = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'git branch -d feature' },
    });
    assert.strictEqual(code, 2);
  });
});

// ---------------------------------------------------------------------------
// Tag mutation blocking
// ---------------------------------------------------------------------------

describe('commit-writer-block-write — tag mutation exit 2', () => {
  it('blocks git tag v1.0.0 (tag creation)', async () => {
    const { code, stderr } = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'git tag v1.0.0' },
    });
    assert.strictEqual(code, 2);
    assert.match(stderr, /COMMIT-WRITER GUARD/);
  });

  it('blocks git tag -d v1.0.0 (tag deletion)', async () => {
    const { code, stderr } = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'git tag -d v1.0.0' },
    });
    assert.strictEqual(code, 2);
    assert.match(stderr, /COMMIT-WRITER GUARD/);
  });

  it('blocks git tag -a v1.0.0 -m "release" (annotated tag)', async () => {
    const { code, stderr } = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'git tag -a v1.0.0 -m "release"' },
    });
    assert.strictEqual(code, 2);
    assert.match(stderr, /COMMIT-WRITER GUARD/);
  });

  it('blocks git tag --delete v1.0.0', async () => {
    const { code, stderr } = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'git tag --delete v1.0.0' },
    });
    assert.strictEqual(code, 2);
    assert.match(stderr, /COMMIT-WRITER GUARD/);
  });

  it('blocks git tag -s v1.0.0 (signed tag)', async () => {
    const { code, stderr } = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'git tag -s v1.0.0' },
    });
    assert.strictEqual(code, 2);
    assert.match(stderr, /COMMIT-WRITER GUARD/);
  });

  it('blocks git tag -l -d v1.0.0 (mutation after list flag)', async () => {
    const { code, stderr } = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'git tag -l -d v1.0.0' },
    });
    assert.strictEqual(code, 2);
    assert.match(stderr, /COMMIT-WRITER GUARD/);
  });

  it('blocks git tag --list --delete v1.0.0 (mutation after list flag)', async () => {
    const { code, stderr } = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'git tag --list --delete v1.0.0' },
    });
    assert.strictEqual(code, 2);
    assert.match(stderr, /COMMIT-WRITER GUARD/);
  });
});

// ---------------------------------------------------------------------------
// Tag listing allowed
// ---------------------------------------------------------------------------

describe('commit-writer-block-write — tag listing exit 0', () => {
  it('allows git tag (bare, lists tags)', async () => {
    const { code } = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'git tag' },
    });
    assert.strictEqual(code, 0);
  });

  it('allows git tag -l', async () => {
    const { code } = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'git tag -l' },
    });
    assert.strictEqual(code, 0);
  });

  it('allows git tag --list', async () => {
    const { code } = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'git tag --list' },
    });
    assert.strictEqual(code, 0);
  });

  it('allows git tag -l "v1.*" (list with pattern)', async () => {
    const { code } = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'git tag -l "v1.*"' },
    });
    assert.strictEqual(code, 0);
  });

  it('allows git tag --list "v1.*" (list with pattern)', async () => {
    const { code } = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'git tag --list "v1.*"' },
    });
    assert.strictEqual(code, 0);
  });

  it('allows git tag -l "v1.0-d" (pattern containing flag-like substring)', async () => {
    const { code } = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'git tag -l "v1.0-d"' },
    });
    assert.strictEqual(code, 0);
  });
});
