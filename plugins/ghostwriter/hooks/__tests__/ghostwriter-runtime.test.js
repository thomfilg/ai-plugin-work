'use strict';

/**
 * Runtime tests for hooks/ghostwriter.js — the hook is judged by its exit code
 * and its stderr bytes, so it is spawned as a real process with a real payload
 * on stdin. 0 allows the tool call, 2 blocks it.
 *
 * A throwaway git repository backs the identity pass: `git init` plus a LOCAL
 * `user.name` pins the effective identity regardless of whatever global config
 * the machine running the suite happens to carry.
 *
 * Run with: node --test plugins/ghostwriter/hooks/__tests__/ghostwriter-runtime.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK_PATH = path.resolve(__dirname, '..', 'ghostwriter.js');
const TOOL = ['Cl', 'aude'].join('');

let repoDir;

/** A git repo whose LOCAL identity is a human, so pass 5 stays quiet. */
function makeRepo(name, email) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostwriter-test-'));
  spawnSync('git', ['init', '-q', dir], { encoding: 'utf8' });
  spawnSync('git', ['-C', dir, 'config', 'user.name', name], { encoding: 'utf8' });
  spawnSync('git', ['-C', dir, 'config', 'user.email', email], { encoding: 'utf8' });
  return dir;
}

function runHook(command, { cwd = repoDir, env = {}, payload } = {}) {
  const merged = { ...process.env, ...env };
  if (!('GHOSTWRITER_ALLOW_ATTRIBUTION' in env)) delete merged.GHOSTWRITER_ALLOW_ATTRIBUTION;
  const body = payload || {
    session_id: 'gw-1',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    cwd,
  };
  const result = spawnSync(process.execPath, [HOOK_PATH], {
    input: typeof body === 'string' ? body : JSON.stringify(body),
    encoding: 'utf8',
    timeout: 20000,
    env: merged,
  });
  return { code: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

before(() => {
  repoDir = makeRepo('Ada Lovelace', 'ada@example.com');
});

after(() => {
  if (repoDir) fs.rmSync(repoDir, { recursive: true, force: true });
});

describe('ghostwriter hook — allows', () => {
  it('exits 0 silently on a clean commit', () => {
    const result = runHook('git commit -m "feat(hooks): add the guard (#12)"');
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
  });

  it('exits 0 on a bare product mention', () => {
    assert.equal(runHook(`git commit -m "feat: add ${TOOL.toLowerCase()} adapter (#12)"`).code, 0);
  });

  it('exits 0 on commands that touch no git authorship', () => {
    for (const command of ['ls -la', 'git status', `echo "Co-Authored-By: ${TOOL} <a@b>"`]) {
      assert.equal(runHook(command).code, 0, command);
    }
  });

  it('exits 0 on a non-Bash tool call', () => {
    const payload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: '/etc/hosts' },
      cwd: repoDir,
    };
    assert.equal(runHook(null, { payload }).code, 0);
  });

  it('fails open on empty and malformed stdin', () => {
    assert.equal(runHook(null, { payload: '' }).code, 0);
    assert.equal(runHook(null, { payload: '{' }).code, 0);
    assert.equal(runHook(null, { payload: {} }).code, 0);
  });
});

describe('ghostwriter hook — blocks', () => {
  it('exits 2 with the offending trailer quoted', () => {
    const result = runHook(`git commit -m "feat: x\n\nCo-Authored-By: ${TOOL} <a@b>"`);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /ghostwriter: this command would sign the work as an AI/);
    assert.match(result.stderr, /aiCoAuthorTrailer/);
    assert.match(result.stderr, /Co-Authored-By:/);
  });

  it('exits 2 on a heredoc footer the tokenizer cannot open', () => {
    const command = `git commit -F- <<'EOF'\nfeat: x\n\nGenerated with ${TOOL} Code\nEOF`;
    const result = runHook(command);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /aiGeneratedPhrase/);
  });

  it('exits 2 when the command sets a tool identity', () => {
    const result = runHook(`git config --global user.name "${TOOL}"`);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /aiIdentity/);
  });

  it('exits 2 when the repo identity is a tool, even for a clean message', () => {
    const aiRepo = makeRepo(TOOL, 'noreply@example.com');
    try {
      const result = runHook('git commit -m "feat: x (#12)"', { cwd: aiRepo });
      assert.equal(result.code, 2);
      assert.match(result.stderr, /the configured git identity/);
    } finally {
      fs.rmSync(aiRepo, { recursive: true, force: true });
    }
  });

  it('never writes an empty stderr when it blocks', () => {
    const result = runHook(`git commit -m "feat: x\n\nCo-Authored-By: ${TOOL} <a@b>"`);
    assert.equal(result.code, 2);
    assert.ok(result.stderr.trim().length > 0, 'an empty stderr can flip exit 2 to fail-open');
  });
});

describe('ghostwriter hook — the operator override', () => {
  const dirty = `git commit -m "feat: x\n\nCo-Authored-By: ${TOOL} <a@b>"`;

  it('honours GHOSTWRITER_ALLOW_ATTRIBUTION=1 from the hook environment', () => {
    const result = runHook(dirty, { env: { GHOSTWRITER_ALLOW_ATTRIBUTION: '1' } });
    assert.equal(result.code, 0);
  });

  it('refuses an override the command sets for itself', () => {
    const result = runHook(`GHOSTWRITER_ALLOW_ATTRIBUTION=1 ${dirty}`, {
      env: { GHOSTWRITER_ALLOW_ATTRIBUTION: '1' },
    });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /ignored/);
  });
});
