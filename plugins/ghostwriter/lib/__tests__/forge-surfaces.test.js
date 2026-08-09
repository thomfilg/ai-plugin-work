/**
 * Unit tests for lib/forge-surfaces.js — where prose gets published to GitHub.
 *
 * Two routes that look nothing alike have to end up at the same rules: the
 * `gh` CLI (text buried in shell arguments) and the GitHub MCP tools (text
 * arriving as named fields). The negative cases matter as much: reading a PR
 * publishes nothing, and neither does a tool call with no text field.
 *
 * Run with: node --test plugins/ghostwriter/lib/__tests__/forge-surfaces.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { scanForgeCommand, scanToolCall, isForgeTool } = require('../forge-surfaces');

/** The single post surface of a command, asserted to exist. */
function onlyPost(command) {
  const { surfaces } = scanForgeCommand(command);
  assert.equal(surfaces.length, 1, `expected exactly one post surface in: ${command}`);
  return surfaces[0];
}

/** Every text value a command would publish. */
function texts(command) {
  return onlyPost(command).texts.map((entry) => entry.text);
}

describe('scanForgeCommand — what publishes nothing', () => {
  it('ignores read-only gh commands', () => {
    for (const command of [
      'gh pr list',
      'gh pr view 784',
      'gh issue list --state open',
      'gh repo clone o/r',
      'gh auth status',
    ]) {
      assert.deepEqual(scanForgeCommand(command).surfaces, [], command);
    }
  });

  it('ignores non-gh commands and a command that merely mentions gh', () => {
    assert.deepEqual(scanForgeCommand('git commit -m x').surfaces, []);
    assert.deepEqual(scanForgeCommand('echo "gh pr comment --body hi"').surfaces, []);
    assert.deepEqual(scanForgeCommand('').surfaces, []);
    assert.deepEqual(scanForgeCommand(null).surfaces, []);
  });
});

describe('scanForgeCommand — the gh CLI', () => {
  it('reads --body across pr, issue and release', () => {
    assert.deepEqual(texts('gh pr comment 1 --body "hello"'), ['hello']);
    assert.deepEqual(texts('gh pr create --body "hello"'), ['hello']);
    assert.deepEqual(texts('gh issue comment 1 --body "hello"'), ['hello']);
    assert.deepEqual(texts('gh release create v1 --notes "hello"'), ['hello']);
  });

  it('reads the short flags', () => {
    assert.deepEqual(texts('gh pr comment 1 -b "hello"'), ['hello']);
    assert.deepEqual(texts('gh issue create -t "a title"').sort(), ['a title']);
  });

  it('reads a title and a body from one command', () => {
    assert.deepEqual(texts('gh pr create --title "a title" --body "a body"').sort(), [
      'a body',
      'a title',
    ]);
  });

  it('reads --body-file as a file to open', () => {
    const surface = onlyPost('gh pr comment 1 --body-file note.md');
    assert.deepEqual(
      surface.textFiles.map((entry) => entry.file),
      ['note.md']
    );
  });

  it('reads gh api fields, which bypass every named flag', () => {
    assert.deepEqual(texts('gh api repos/o/r/issues/1/comments -f body="hello"'), ['hello']);
    assert.deepEqual(texts('gh api x --raw-field body=hello'), ['hello']);
  });

  it('ignores gh api fields that publish nothing', () => {
    assert.deepEqual(onlyPost('gh api x -f body=hi -f state=closed').texts.length, 1);
  });

  it('sees through wrappers, exactly as the git scanner does', () => {
    assert.deepEqual(texts('bash -c "gh pr comment 1 --body hello"'), ['hello']);
    assert.deepEqual(texts('env gh pr comment 1 --body hello'), ['hello']);
  });

  it('records a token override, which replaces the logged-in account', () => {
    assert.equal(onlyPost('GH_TOKEN=xyz gh pr comment 1 --body hi').tokenOverride, 'GH_TOKEN');
    assert.equal(onlyPost('gh pr comment 1 --body hi').tokenOverride, null);
  });
});

describe('scanToolCall — the GitHub MCP tools', () => {
  it('reads every text-bearing field of a call', () => {
    const { surfaces } = scanToolCall('mcp__github__create_pull_request', {
      title: 'a title',
      body: 'a body',
      owner: 'o',
      repo: 'r',
    });
    assert.equal(surfaces.length, 1);
    assert.deepEqual(surfaces[0].texts.map((entry) => entry.text).sort(), ['a body', 'a title']);
  });

  it('reads commit messages written through the API, not through git', () => {
    const { surfaces } = scanToolCall('mcp__github__push_files', { message: 'feat: x' });
    assert.deepEqual(
      surfaces[0].texts.map((entry) => entry.text),
      ['feat: x']
    );
  });

  it('reports the tool and field as the location', () => {
    const { surfaces } = scanToolCall('mcp__github__add_issue_comment', { body: 'hi' });
    assert.equal(surfaces[0].texts[0].where, 'mcp__github__add_issue_comment body');
  });

  it('finds nothing in a read-only call', () => {
    assert.deepEqual(scanToolCall('mcp__github__get_file_contents', { path: 'a' }).surfaces, []);
    assert.deepEqual(scanToolCall('mcp__github__list_pull_requests', {}).surfaces, []);
  });

  it('ignores non-forge tools and malformed input', () => {
    assert.deepEqual(scanToolCall('Bash', { command: 'x' }).surfaces, []);
    assert.deepEqual(scanToolCall('mcp__github__x', null).surfaces, []);
    assert.deepEqual(scanToolCall(null, { body: 'hi' }).surfaces, []);
  });

  it('ignores non-string and empty field values', () => {
    const { surfaces } = scanToolCall('mcp__github__issue_write', { body: '', title: 42 });
    assert.deepEqual(surfaces, []);
  });
});

describe('isForgeTool', () => {
  it('recognises the github MCP namespace only', () => {
    assert.equal(isForgeTool('mcp__github__add_issue_comment'), true);
    assert.equal(isForgeTool('mcp__linear__create_issue'), false);
    assert.equal(isForgeTool('Bash'), false);
    assert.equal(isForgeTool(undefined), false);
  });
});
