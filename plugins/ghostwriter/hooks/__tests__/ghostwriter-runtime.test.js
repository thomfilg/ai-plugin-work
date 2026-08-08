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

  // Two real repositories: the shell sits in the clean one and commits into
  // the other. Reading the identity from the cwd would clear this.
  it('exits 2 when another repository is targeted and ITS identity is a tool', () => {
    const aiRepo = makeRepo(TOOL, 'noreply@example.com');
    const aiGitDir = path.join(aiRepo, '.git');
    try {
      for (const command of [
        `git --git-dir=${aiGitDir} --work-tree=${aiRepo} commit -m "feat: x (#12)"`,
        `GIT_DIR=${aiGitDir} git commit -m "feat: x (#12)"`,
      ]) {
        const result = runHook(command, { cwd: repoDir });
        assert.equal(result.code, 2, command);
        assert.match(result.stderr, /the configured git identity/);
      }
      // ...and the clean repo it is standing in still commits fine.
      assert.equal(runHook('git commit -m "feat: x (#12)"', { cwd: repoDir }).code, 0);
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

// A repository with no `user.email` does not refuse the commit — git invents
// `user@hostname` and the change lands under a machine's byline. These run
// against REAL repositories with the ambient global config detached, because
// whether the guard reads the repository it was pointed at is not a question a
// stubbed resolver can answer.
describe('ghostwriter hook — commits with no author', () => {
  const DETACHED = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  let bare;

  before(() => {
    bare = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostwriter-bare-'));
    spawnSync('git', ['init', '-q', bare], { encoding: 'utf8' });
  });

  after(() => {
    if (bare) fs.rmSync(bare, { recursive: true, force: true });
  });

  it('blocks a commit in a repository that configures no identity', () => {
    const result = runHook('git commit -m "feat: x"', { cwd: bare, env: DETACHED });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /missingIdentity/);
    assert.match(result.stderr, /user\.name/);
    assert.match(result.stderr, /user\.email/);
  });

  it('blocks when only half the identity is set', () => {
    spawnSync('git', ['-C', bare, 'config', 'user.name', 'Ada Lovelace'], { encoding: 'utf8' });
    const result = runHook('git commit -m "feat: x"', { cwd: bare, env: DETACHED });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /missingIdentity/);
    assert.match(result.stderr, /user\.email/);
  });

  it('allows the commit once both halves name a person', () => {
    spawnSync('git', ['-C', bare, 'config', 'user.email', 'ada@example.com'], { encoding: 'utf8' });
    const result = runHook('git commit -m "feat: x"', { cwd: bare, env: DETACHED });
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
  });

  it('stays out of the way where there is no repository to ask', () => {
    const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostwriter-norepo-'));
    try {
      const result = runHook('git commit -m "feat: x"', { cwd: notARepo, env: DETACHED });
      assert.equal(result.code, 0, 'git refuses this itself — the guard adds nothing');
    } finally {
      fs.rmSync(notARepo, { recursive: true, force: true });
    }
  });
});

describe('ghostwriter hook — pull requests and comments', () => {
  const FOOTER = `Looks good.\n\n_Generated by [${TOOL} Code](https://${TOOL.toLowerCase()}.ai/code)_`;

  it('exits 2 on a gh comment carrying an attribution footer', () => {
    const result = runHook(`gh pr comment 1 --body "${FOOTER}"`);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /gh pr comment --body/);
  });

  it('exits 2 on the same footer arriving through an MCP tool call', () => {
    const payload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'mcp__github__add_issue_comment',
      tool_input: { issue_number: 1, body: FOOTER },
      cwd: repoDir,
    };
    const result = runHook(null, { payload });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /mcp__github__add_issue_comment body/);
  });

  it('exits 0 on ordinary posts and on read-only forge calls', () => {
    assert.equal(runHook('gh pr comment 1 --body "Looks good, shipping."').code, 0);
    assert.equal(runHook('gh pr list --limit 5').code, 0);
    const readOnly = {
      hook_event_name: 'PreToolUse',
      tool_name: 'mcp__github__get_file_contents',
      tool_input: { owner: 'o', repo: 'r', path: 'README.md' },
      cwd: repoDir,
    };
    assert.equal(runHook(null, { payload: readOnly }).code, 0);
  });
});

// A footer in a source file is the attribution that lasts: it ships in the
// diff, shows up in the pull request, and stays in the tree after the message
// and the description are both forgotten. Nothing in the message passes sees
// it, because it is not a message.
describe('ghostwriter hook — file content', () => {
  function runWrite(toolName, toolInput, cwd = repoDir) {
    return runHook(null, {
      payload: {
        session_id: 'gw-1',
        hook_event_name: 'PreToolUse',
        tool_name: toolName,
        tool_input: toolInput,
        cwd,
      },
    });
  }

  it('blocks a generated-with footer written into a source file', () => {
    const result = runWrite('Write', {
      file_path: 'src/index.js',
      content: `// Generated with ${TOOL} Code\nmodule.exports = 1;\n`,
    });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /aiGeneratedPhrase/);
    assert.match(result.stderr, /src\/index\.js/);
  });

  it('blocks a trailer added by an Edit', () => {
    const result = runWrite('Edit', {
      file_path: 'src/index.js',
      old_string: 'x',
      new_string: `x\n// Co-Authored-By: ${TOOL} <a@b>`,
    });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /aiCoAuthorTrailer/);
  });

  it('allows ordinary code that merely names a product', () => {
    const result = runWrite('Write', {
      file_path: 'src/index.js',
      content: `// ${TOOL} adapter\nmodule.exports = 1;\n`,
    });
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
  });

  it('allows a document quoting the trailer it documents', () => {
    const result = runWrite('Write', {
      file_path: 'docs/policy.md',
      content: `# Policy\n\nRejected:\n\n\`\`\`\nCo-Authored-By: ${TOOL}\n\`\`\`\n`,
    });
    assert.equal(result.code, 0);
  });

  it('leaves a read alone', () => {
    assert.equal(runWrite('Read', { file_path: 'src/index.js' }).code, 0);
  });

  it('blocks file content committed through an MCP call', () => {
    // No shell, no working tree — the command walker never sees this one.
    const result = runWrite('mcp__github__create_or_update_file', {
      owner: 'o',
      repo: 'r',
      path: 'src/a.js',
      content: `// Generated with ${TOOL} Code`,
      message: 'feat: add a',
    });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /aiGeneratedPhrase/);
  });

  it('blocks one dirty file inside a multi-file MCP push', () => {
    const result = runWrite('mcp__github__push_files', {
      owner: 'o',
      repo: 'r',
      branch: 'main',
      message: 'feat: add two files',
      files: [
        { path: 'a.js', content: 'const a = 1;' },
        { path: 'b.js', content: `/* Written by ${TOOL} */` },
      ],
    });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /b\.js/);
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
