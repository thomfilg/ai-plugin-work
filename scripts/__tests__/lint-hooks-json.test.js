/**
 * Tests for scripts/lint-hooks-json.js (WP-01 — hooks.json hygiene + matcher batch)
 *
 * Proves:
 *   - the lint passes on all 4 real plugin hooks.json files
 *   - the WP-01 edit is EXACTLY: work loses the top-level `description` key +
 *     the enumerated matcher rewrites; heimdall `Task` → `Task|Agent`;
 *     synapsys/maestro untouched (JSON-parse snapshot vs checked-in baselines)
 *   - no matcher contains `apply_patch`
 *   - the lint catches each forbidden shape (self-test on temp files)
 *
 * Run with: node --test scripts/__tests__/lint-hooks-json.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const LINT_PATH = path.join(REPO_ROOT, 'scripts', 'lint-hooks-json.js');
const FIXTURES_DIR = path.join(REPO_ROOT, 'tests', 'fixtures', 'hooks-json');
const PLUGINS = ['heimdall', 'maestro', 'synapsys', 'work'];

function hooksJsonPath(plugin) {
  return path.join(REPO_ROOT, 'plugins', plugin, 'hooks', 'hooks.json');
}

function baselinePath(plugin) {
  return path.join(FIXTURES_DIR, `${plugin}.hooks.baseline.json`);
}

function runLint(args = []) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [LINT_PATH, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
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
  });
}

function writeTempHooksJson(doc) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-hooks-json-test-'));
  const file = path.join(dir, 'hooks.json');
  fs.writeFileSync(file, typeof doc === 'string' ? doc : JSON.stringify(doc, null, 2));
  return file;
}

function minimalDoc(overrides = {}) {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: 'node hook.js', timeout: 30 }],
        },
      ],
    },
    ...overrides,
  };
}

// Applies the exact WP-01 transformation to a parsed baseline and returns the
// number of matcher rewrites performed per source string.
function applyWp01Transform(doc, matcherMap) {
  const counts = {};
  delete doc.description;
  for (const groups of Object.values(doc.hooks)) {
    for (const group of groups) {
      if (group.matcher !== undefined && matcherMap[group.matcher] !== undefined) {
        counts[group.matcher] = (counts[group.matcher] || 0) + 1;
        group.matcher = matcherMap[group.matcher];
      }
    }
  }
  return counts;
}

describe('lint-hooks-json — real plugin files', () => {
  it('passes on all 4 plugin hooks.json files', async () => {
    const { code, stdout, stderr } = await runLint();
    assert.strictEqual(code, 0, `stderr: ${stderr}`);
    for (const plugin of PLUGINS) {
      assert.ok(stdout.includes(`OK plugins/${plugin}/hooks/hooks.json`));
    }
  });

  it('every plugin hooks.json has "hooks" as its only top-level key', () => {
    for (const plugin of PLUGINS) {
      const doc = JSON.parse(fs.readFileSync(hooksJsonPath(plugin), 'utf8'));
      assert.deepStrictEqual(Object.keys(doc), ['hooks'], plugin);
    }
  });

  it('no matcher in any plugin contains apply_patch', () => {
    for (const plugin of PLUGINS) {
      const raw = fs.readFileSync(hooksJsonPath(plugin), 'utf8');
      assert.ok(!raw.includes('apply_patch'), `${plugin} hooks.json mentions apply_patch`);
    }
  });
});

describe('lint-hooks-json — WP-01 structural snapshot vs baselines', () => {
  it('work: only the description key removal + the enumerated matcher rewrites', () => {
    const baseline = JSON.parse(fs.readFileSync(baselinePath('work'), 'utf8'));
    assert.ok(baseline.description, 'baseline must carry the pre-WP-01 description key');
    const counts = applyWp01Transform(baseline, {
      'Task|Skill': 'Task|Skill|Agent',
      'Task|Skill|Bash': 'Task|Skill|Agent|Bash',
      AskUserQuestion: 'AskUserQuestion|request_user_input',
    });
    assert.deepStrictEqual(counts, {
      'Task|Skill': 3,
      'Task|Skill|Bash': 1,
      AskUserQuestion: 1,
    });
    const current = JSON.parse(fs.readFileSync(hooksJsonPath('work'), 'utf8'));
    assert.deepStrictEqual(current, baseline);
  });

  it('heimdall: only Task → Task|Agent', () => {
    const baseline = JSON.parse(fs.readFileSync(baselinePath('heimdall'), 'utf8'));
    const counts = applyWp01Transform(baseline, { Task: 'Task|Agent' });
    assert.deepStrictEqual(counts, { Task: 1 });
    const current = JSON.parse(fs.readFileSync(hooksJsonPath('heimdall'), 'utf8'));
    assert.deepStrictEqual(current, baseline);
  });

  it('synapsys and maestro: byte-identical to their baselines (untouched)', () => {
    for (const plugin of ['synapsys', 'maestro']) {
      const baseline = fs.readFileSync(baselinePath(plugin), 'utf8');
      const current = fs.readFileSync(hooksJsonPath(plugin), 'utf8');
      assert.strictEqual(current, baseline, plugin);
    }
  });
});

describe('lint-hooks-json — violation detection (self-test)', () => {
  it('accepts a minimal valid file', async () => {
    const file = writeTempHooksJson(minimalDoc());
    const { code } = await runLint([file]);
    assert.strictEqual(code, 0);
  });

  it('rejects a top-level description key (C17)', async () => {
    const file = writeTempHooksJson(minimalDoc({ description: 'kills the file on codex' }));
    const { code, stderr } = await runLint([file]);
    assert.strictEqual(code, 1);
    assert.ok(stderr.includes('top-level keys other than "hooks"'));
    assert.ok(stderr.includes('description'));
  });

  it('rejects a top-level disabledHooks key', async () => {
    const file = writeTempHooksJson(minimalDoc({ disabledHooks: {} }));
    const { code, stderr } = await runLint([file]);
    assert.strictEqual(code, 1);
    assert.ok(stderr.includes('disabledHooks'));
  });

  it('rejects apply_patch in a matcher', async () => {
    const doc = minimalDoc();
    doc.hooks.PreToolUse[0].matcher = 'Write|Edit|apply_patch';
    const file = writeTempHooksJson(doc);
    const { code, stderr } = await runLint([file]);
    assert.strictEqual(code, 1);
    assert.ok(stderr.includes('apply_patch'));
  });

  it('rejects an unknown tool name in an exact-alternation matcher', async () => {
    const doc = minimalDoc();
    doc.hooks.PreToolUse[0].matcher = 'Task|Skil';
    const file = writeTempHooksJson(doc);
    const { code, stderr } = await runLint([file]);
    assert.strictEqual(code, 1);
    assert.ok(stderr.includes('unknown tool name "Skil"'));
  });

  it('accepts mcp__ tool names in exact-alternation matchers', async () => {
    const doc = minimalDoc();
    doc.hooks.PreToolUse[0].matcher = 'mcp__atlassian__jira_get_issue|mcp__linear__get_issue';
    const file = writeTempHooksJson(doc);
    const { code } = await runLint([file]);
    assert.strictEqual(code, 0);
  });

  it('rejects an invalid regex matcher', async () => {
    const doc = minimalDoc();
    doc.hooks.PreToolUse[0].matcher = '([unclosed';
    const file = writeTempHooksJson(doc);
    const { code, stderr } = await runLint([file]);
    assert.strictEqual(code, 1);
    assert.ok(stderr.includes('invalid regex'));
  });

  it('rejects lookahead (valid JS, invalid Rust regex)', async () => {
    const doc = minimalDoc();
    doc.hooks.PreToolUse[0].matcher = '^(?!Bash).*';
    const file = writeTempHooksJson(doc);
    const { code, stderr } = await runLint([file]);
    assert.strictEqual(code, 1);
    assert.ok(stderr.includes('not valid Rust regex'));
  });

  it('rejects async:true handlers', async () => {
    const doc = minimalDoc();
    doc.hooks.PreToolUse[0].hooks[0].async = true;
    const file = writeTempHooksJson(doc);
    const { code, stderr } = await runLint([file]);
    assert.strictEqual(code, 1);
    assert.ok(stderr.includes('async:true'));
  });

  it('rejects a non-numeric timeout', async () => {
    const doc = minimalDoc();
    doc.hooks.PreToolUse[0].hooks[0].timeout = '30';
    const file = writeTempHooksJson(doc);
    const { code, stderr } = await runLint([file]);
    assert.strictEqual(code, 1);
    assert.ok(stderr.includes('timeout must be an integer number of seconds'));
  });

  it('rejects a milliseconds-looking timeout', async () => {
    const doc = minimalDoc();
    doc.hooks.PreToolUse[0].hooks[0].timeout = 30000;
    const file = writeTempHooksJson(doc);
    const { code, stderr } = await runLint([file]);
    assert.strictEqual(code, 1);
    assert.ok(stderr.includes('looks like milliseconds'));
  });

  it('rejects a non-command handler type', async () => {
    const doc = minimalDoc();
    doc.hooks.PreToolUse[0].hooks[0].type = 'prompt';
    const file = writeTempHooksJson(doc);
    const { code, stderr } = await runLint([file]);
    assert.strictEqual(code, 1);
    assert.ok(stderr.includes('handler type must be "command"'));
  });

  it('rejects invalid JSON', async () => {
    const file = writeTempHooksJson('{ not json');
    const { code, stderr } = await runLint([file]);
    assert.strictEqual(code, 1);
    assert.ok(stderr.includes('invalid JSON'));
  });

  it('rejects an unknown event name', async () => {
    const doc = minimalDoc();
    doc.hooks.PreToolsUse = doc.hooks.PreToolUse;
    delete doc.hooks.PreToolUse;
    const file = writeTempHooksJson(doc);
    const { code, stderr } = await runLint([file]);
    assert.strictEqual(code, 1);
    assert.ok(stderr.includes('hooks.PreToolsUse: unknown event name'));
  });
});
