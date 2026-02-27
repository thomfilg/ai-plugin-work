/**
 * Tests for enforce-screenshot-requirement.js
 *
 * Run with: node --test hooks/__tests__/enforce-screenshot-requirement.test.js
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const HOOK_PATH = path.join(__dirname, '..', 'enforce-screenshot-requirement.js');
const MARKER_DIR = '/tmp';

function runHook(hookData, hookType = 'PreToolUse') {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [HOOK_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CLAUDE_HOOK_TYPE: hookType },
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => resolve({ stdout, stderr, code }));
    proc.on('error', reject);

    proc.stdin.write(JSON.stringify(hookData));
    proc.stdin.end();
  });
}

function getTicketId() {
  try {
    const { execSync } = require('child_process');
    const branch = execSync('git branch --show-current 2>/dev/null', { encoding: 'utf8' }).trim();
    const match = branch.match(/[A-Z]+-\d+/);
    return match ? match[0] : null;
  } catch {
    return null;
  }
}

function skipMarkerPath(ticketId) {
  return path.join(MARKER_DIR, `check-skip-screenshots-${ticketId}`);
}

function cleanupMarker(ticketId) {
  try { fs.unlinkSync(skipMarkerPath(ticketId)); } catch { /* */ }
}

function createFakeScreenshot(ticketId) {
  const dir = `/home/node/worktrees/tasks/${ticketId}/screenshots`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'test.png'), 'fake');
  return dir;
}

function cleanupScreenshots(ticketId) {
  const dir = `/home/node/worktrees/tasks/${ticketId}/screenshots`;
  try {
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
      fs.rmdirSync(dir);
    }
  } catch { /* */ }
}

describe('enforce-screenshot-requirement', () => {
  const ticketId = getTicketId();

  beforeEach(() => {
    if (ticketId) {
      cleanupMarker(ticketId);
      cleanupScreenshots(ticketId);
    }
  });

  afterEach(() => {
    if (ticketId) {
      cleanupMarker(ticketId);
      cleanupScreenshots(ticketId);
    }
  });

  // ─── Blocking tests (require being on a ticket branch with TSX changes) ───

  describe('PreToolUse — blocks QA agents', () => {
    it('blocks pr-generator', async () => {
      if (!ticketId) return;
      const r = await runHook({ tool_name: 'Task', tool_input: { subagent_type: 'pr-generator', prompt: 'create PR' } });
      assert.equal(r.code, 2);
      assert.match(r.stderr, /BLOCKED/);
    });

    it('does NOT block completion-checker (code quality, not screenshots)', async () => {
      if (!ticketId) return;
      const r = await runHook({ tool_name: 'Task', tool_input: { subagent_type: 'completion-checker', prompt: 'verify' } });
      assert.equal(r.code, 0);
    });

    it('blocks qa-feature-tester', async () => {
      if (!ticketId) return;
      const r = await runHook({ tool_name: 'Task', tool_input: { subagent_type: 'qa-feature-tester', prompt: 'test' } });
      assert.equal(r.code, 2);
    });

    it('blocks pr-post-generator', async () => {
      if (!ticketId) return;
      const r = await runHook({ tool_name: 'Task', tool_input: { subagent_type: 'pr-post-generator', prompt: 'post' } });
      assert.equal(r.code, 2);
    });

    it('blocks work-pr skill', async () => {
      if (!ticketId) return;
      const r = await runHook({ tool_name: 'Skill', tool_input: { skill: 'work-pr', args: '' } });
      assert.equal(r.code, 2);
    });

    it('blocks check-qa skill', async () => {
      if (!ticketId) return;
      const r = await runHook({ tool_name: 'Skill', tool_input: { skill: 'check-qa', args: '' } });
      assert.equal(r.code, 2);
    });

    it('blocks check-browser skill', async () => {
      if (!ticketId) return;
      const r = await runHook({ tool_name: 'Skill', tool_input: { skill: 'check-browser', args: '' } });
      assert.equal(r.code, 2);
    });

    it('allows prompt matching "requirements verif" (not screenshot-related)', async () => {
      if (!ticketId) return;
      const r = await runHook({ tool_name: 'Task', tool_input: { subagent_type: 'general-purpose', prompt: 'requirements verification' } });
      assert.equal(r.code, 0);
    });

    it('blocks prompt matching "screenshot"', async () => {
      if (!ticketId) return;
      const r = await runHook({ tool_name: 'Task', tool_input: { subagent_type: 'general-purpose', prompt: 'take screenshot of the app' } });
      assert.equal(r.code, 2);
    });
  });

  // ─── Pass-through tests ───

  describe('PreToolUse — allows non-QA agents', () => {
    it('allows developer-nodejs-tdd', async () => {
      const r = await runHook({ tool_name: 'Task', tool_input: { subagent_type: 'developer-nodejs-tdd', prompt: 'implement' } });
      assert.equal(r.code, 0);
    });

    it('allows code-checker', async () => {
      const r = await runHook({ tool_name: 'Task', tool_input: { subagent_type: 'code-checker', prompt: 'review' } });
      assert.equal(r.code, 0);
    });

    it('allows commit-writer', async () => {
      const r = await runHook({ tool_name: 'Task', tool_input: { subagent_type: 'commit-writer', prompt: 'commit' } });
      assert.equal(r.code, 0);
    });

    it('allows unrelated skills', async () => {
      const r = await runHook({ tool_name: 'Skill', tool_input: { skill: 'commit', args: '' } });
      assert.equal(r.code, 0);
    });

    it('allows non-Task/Skill tools', async () => {
      const r = await runHook({ tool_name: 'Bash', tool_input: { command: 'echo hi' } });
      assert.equal(r.code, 0);
    });
  });

  describe('PreToolUse — allows when screenshots exist', () => {
    it('allows pr-generator when screenshots present', async () => {
      if (!ticketId) return;
      createFakeScreenshot(ticketId);
      const r = await runHook({ tool_name: 'Task', tool_input: { subagent_type: 'pr-generator', prompt: 'create PR' } });
      assert.equal(r.code, 0);
    });
  });

  describe('PreToolUse — allows when skip marker exists', () => {
    it('allows pr-generator when skip marker present', async () => {
      if (!ticketId) return;
      fs.writeFileSync(skipMarkerPath(ticketId), JSON.stringify({ ticketId }));
      const r = await runHook({ tool_name: 'Task', tool_input: { subagent_type: 'pr-generator', prompt: 'create PR' } });
      assert.equal(r.code, 0);
    });
  });

  // ─── PostToolUse — AskUserQuestion unblock ───

  describe('PostToolUse — skip detection', () => {
    it('writes skip marker for "Skip screenshots"', async () => {
      if (!ticketId) return;
      const r = await runHook({ tool_name: 'AskUserQuestion', tool_input: {}, tool_output: 'Skip screenshots' }, 'PostToolUse');
      assert.equal(r.code, 0);
      assert.match(r.stderr, /Skip-screenshots marker/);
      assert.ok(fs.existsSync(skipMarkerPath(ticketId)));
    });

    it('writes skip marker for "SKIP SCREENSHOTS"', async () => {
      if (!ticketId) return;
      const r = await runHook({ tool_name: 'AskUserQuestion', tool_input: {}, tool_output: 'SKIP SCREENSHOTS' }, 'PostToolUse');
      assert.ok(fs.existsSync(skipMarkerPath(ticketId)));
    });

    it('writes skip marker from JSON-structured output', async () => {
      if (!ticketId) return;
      const r = await runHook({ tool_name: 'AskUserQuestion', tool_input: {}, tool_output: { selected: 'Skip screenshots' } }, 'PostToolUse');
      assert.ok(fs.existsSync(skipMarkerPath(ticketId)));
    });

    it('writes skip marker from tool_result fallback', async () => {
      if (!ticketId) return;
      const r = await runHook({ tool_name: 'AskUserQuestion', tool_input: {}, tool_result: 'Skip screenshots' }, 'PostToolUse');
      assert.ok(fs.existsSync(skipMarkerPath(ticketId)));
    });

    it('writes skip marker from tool_response fallback', async () => {
      if (!ticketId) return;
      const r = await runHook({ tool_name: 'AskUserQuestion', tool_input: {}, tool_response: 'skip the screenshot step' }, 'PostToolUse');
      assert.ok(fs.existsSync(skipMarkerPath(ticketId)));
    });

    it('does NOT write marker for "Capture screenshots now"', async () => {
      if (!ticketId) return;
      await runHook({ tool_name: 'AskUserQuestion', tool_input: {}, tool_output: 'Capture screenshots now' }, 'PostToolUse');
      assert.ok(!fs.existsSync(skipMarkerPath(ticketId)));
    });

    it('does NOT write marker for "Abort"', async () => {
      if (!ticketId) return;
      await runHook({ tool_name: 'AskUserQuestion', tool_input: {}, tool_output: 'Abort' }, 'PostToolUse');
      assert.ok(!fs.existsSync(skipMarkerPath(ticketId)));
    });
  });

  // ─── Edge cases ───

  describe('Edge cases', () => {
    it('handles missing tool_input', async () => {
      const r = await runHook({ tool_name: 'Task' });
      assert.equal(r.code, 0);
    });

    it('handles empty hookData', async () => {
      const r = await runHook({});
      assert.equal(r.code, 0);
    });

    it('ignores PostToolUse on non-AskUserQuestion', async () => {
      const r = await runHook({ tool_name: 'Bash', tool_input: { command: 'test' } }, 'PostToolUse');
      assert.equal(r.code, 0);
    });
  });
});
