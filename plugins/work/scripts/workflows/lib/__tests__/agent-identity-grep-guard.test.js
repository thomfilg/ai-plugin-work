'use strict';

/**
 * Grep-guard for the agent-identity module boundary (GH-767, Task 6).
 *
 * Self-scanning suite: walks plugins/work/scripts/**\/*.js (skipping
 * __tests__ and fixture folders) and fails when an identity-detection
 * primitive appears outside lib/agent-identity.js and its sanctioned
 * internal legs.
 *
 * Burn-down allowlist policy (mirrors .quality-exceptions):
 *   - Every allowlist entry MUST currently match at least one forbidden
 *     pattern — a stale entry fails the suite until it is removed.
 *   - The allowlist may only SHRINK: MAX_ALLOWLIST_SIZE below may only be
 *     decreased, never increased. Adding a new entry fails the size check.
 *
 * Run: node --test plugins/work/scripts/workflows/lib/__tests__/agent-identity-grep-guard.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// __tests__ → lib → workflows → scripts → work → plugins → repo root
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..', '..');
const SCAN_ROOT = path.join(REPO_ROOT, 'plugins', 'work', 'scripts');

// ─── Forbidden identity primitives (line-level regexes) ─────────────────────

const FORBIDDEN_PATTERNS = Object.freeze([
  {
    name: 'process.env.CLAUDE_CURRENT_AGENT',
    re: /process\.env\.CLAUDE_CURRENT_AGENT/,
    suggestion: 'use envAgentName() from lib/agent-identity',
  },
  {
    name: '.agent_type',
    re: /\.agent_type\b/,
    suggestion: 'use payloadAgentName(hookData) / classifyIdentity() from lib/agent-identity',
  },
  {
    name: '.agent_name',
    re: /\.agent_name\b/,
    suggestion: 'use payloadAgentName(hookData) / classifyIdentity() from lib/agent-identity',
  },
  {
    name: '.subagent_type',
    re: /\.subagent_type\b/,
    suggestion: 'use dispatchTargetAgent(toolInput) from lib/agent-identity',
  },
  {
    name: 'attributionAgent',
    re: /\battributionAgent\b/,
    suggestion: 'use classifyIdentity() from lib/agent-identity',
  },
  {
    name: 'isSidechain',
    re: /\bisSidechain\b/,
    suggestion: 'use isSubagentContext() from lib/agent-identity',
  },
  {
    name: 'readFileSync(transcript)',
    re: /readFileSync\(.*transcript/,
    suggestion: 'use classifyIdentity() / readInitialMarkers() from lib/agent-identity',
  },
]);

// ─── Burn-down allowlist ────────────────────────────────────────────────────
// { file, reason } — `file` is repo-root-relative (posix). A trailing '/'
// marks a directory prefix (every file under it is covered).
//
// BURN-DOWN: this list may only shrink. Do NOT add entries — migrate the new
// call site to lib/agent-identity.js instead.

const LIB = 'plugins/work/scripts/workflows/lib';
const WF = 'plugins/work/scripts/workflows';

const ALLOWLIST = Object.freeze([
  // ── Module boundary (the module itself + sanctioned internal legs) ──
  { file: `${LIB}/agent-identity.js`, reason: 'module boundary — the identity module entry point' },
  {
    file: `${LIB}/agent-detection.js`,
    reason: 'module boundary — re-export shim / sanctioned leg',
  },
  { file: `${LIB}/transcript-markers.js`, reason: 'module boundary — sanctioned internal leg' },
  { file: `${LIB}/runtime/`, reason: 'module boundary — sanctioned internal legs (GH-696-locked)' },
  // ── Excluded-with-reason consumers (spec.md migration manifest) ──
  {
    file: `${LIB}/hooks/policies/evidence-recorder.js`,
    reason: 'label-only telemetry read (logged, not branched)',
  },
  {
    file: `${LIB}/hooks/policies/hook-telemetry.js`,
    reason: 'label-only telemetry snapshot (logged, not branched)',
  },
  {
    file: `${WF}/work/hooks/capture-usage.js`,
    reason: 'label-only usage-attribution read (logged, not branched)',
  },
  {
    file: `${LIB}/hooks/policies/step-gate.js`,
    reason: 'label-only command description for the gate log (logged, not branched)',
  },
  {
    file: `${LIB}/hooks/policies/workflow-loop-rules.js`,
    reason: 'label-only Task action-log label (logged, not branched)',
  },
  {
    file: `${LIB}/phase-runner/create-phase-runner.js`,
    reason: 'env label read; GH-763/GH-764 deletion pending — no new coupling',
  },
  {
    file: `${WF}/work-implement/task-next.js`,
    reason: 'env label read; GH-764 deletion-slated consumer',
  },
  {
    file: `${WF}/work/hooks/work-require-implement.js`,
    reason: 'dispatch-record history query over transcript, not self-identity',
  },
  {
    file: `${WF}/work-implement/hooks/enforce-developer-detect.js`,
    reason:
      'dispatch-record history query over transcript (was a developer invoked), not self-identity',
  },
  {
    file: `${LIB}/hooks/enforce-env-start-failure.js`,
    reason: 'transcript read for tool output / user answer, not identity',
  },
  {
    file: `${WF}/work/hooks/enforce-coverage-fix.js`,
    reason: 'transcript read for recent tool output, not identity',
  },
]);

// BURN-DOWN: may only DECREASE. Never raise this number — fix the code.
const MAX_ALLOWLIST_SIZE = 15;

// ─── Scanner ────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(['__tests__', '__fixtures__', 'fixtures', 'node_modules']);

function isCommentLine(line) {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

/** Recursively collect .js files under `dir`, skipping test/fixture folders. */
function collectJsFiles(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collectJsFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

function toRel(absFile, root) {
  return path.relative(root, absFile).split(path.sep).join('/');
}

function isAllowlisted(relFile, allowlist) {
  return allowlist.some((entry) =>
    entry.file.endsWith('/') ? relFile.startsWith(entry.file) : relFile === entry.file
  );
}

function formatViolation(v) {
  return `${v.file}:${v.line} matches forbidden pattern [${v.pattern}] — ${v.suggestion}`;
}

/**
 * Scan a tree for forbidden identity primitives.
 * @returns {{ violations: Array<{file,line,pattern,suggestion,text}>,
 *             staleEntries: string[] }}
 *   violations  — non-allowlisted matches (relative paths against `relRoot`)
 *   staleEntries — allowlist entries with zero live matches (burn-down)
 */
function scanTree(scanRoot, allowlist, relRoot = REPO_ROOT) {
  const violations = [];
  const liveEntries = new Set();

  for (const absFile of collectJsFiles(scanRoot)) {
    const relFile = toRel(absFile, relRoot);
    const lines = fs.readFileSync(absFile, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (isCommentLine(line)) continue;
      for (const pattern of FORBIDDEN_PATTERNS) {
        if (!pattern.re.test(line)) continue;
        const entry = allowlist.find((e) =>
          e.file.endsWith('/') ? relFile.startsWith(e.file) : relFile === e.file
        );
        if (entry) {
          liveEntries.add(entry.file);
        } else {
          violations.push({
            file: relFile,
            line: i + 1,
            pattern: pattern.name,
            suggestion: pattern.suggestion,
            text: line.trim(),
          });
        }
      }
    }
  }

  const staleEntries = allowlist.map((e) => e.file).filter((f) => !liveEntries.has(f));
  return { violations, staleEntries };
}

// ─── Suite ──────────────────────────────────────────────────────────────────

function withTempTree(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grep-guard-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('agent-identity grep-guard — walker unit behavior', () => {
  it('reports a synthetic violation with file, line, and pattern', () => {
    withTempTree(
      { 'hooks/bad.js': "'use strict';\nconst who = process.env.CLAUDE_CURRENT_AGENT;\n" },
      (dir) => {
        const { violations } = scanTree(dir, [], dir);
        assert.equal(violations.length, 1);
        assert.equal(violations[0].file, 'hooks/bad.js');
        assert.equal(violations[0].line, 2);
        assert.equal(violations[0].pattern, 'process.env.CLAUDE_CURRENT_AGENT');
      }
    );
  });

  it('detects every forbidden pattern class', () => {
    const samples = [
      'const a = process.env.CLAUDE_CURRENT_AGENT;',
      'const b = hookData.agent_type;',
      'const c = hookData.agent_name;',
      'const d = toolInput.subagent_type;',
      'const e = attributionAgent(x);',
      'if (entry.isSidechain) {}',
      "const f = fs.readFileSync(transcriptPath, 'utf8');",
    ];
    withTempTree({ 'all.js': samples.join('\n') }, (dir) => {
      const { violations } = scanTree(dir, [], dir);
      assert.equal(violations.length, FORBIDDEN_PATTERNS.length);
    });
  });

  it('skips __tests__ and fixture directories', () => {
    withTempTree(
      {
        '__tests__/t.js': 'const x = hookData.agent_type;',
        'fixtures/f.js': 'const x = hookData.agent_type;',
        '__fixtures__/g.js': 'const x = hookData.agent_type;',
      },
      (dir) => {
        const { violations } = scanTree(dir, [], dir);
        assert.deepEqual(violations, []);
      }
    );
  });

  it('ignores pure comment lines (mentions are not detection)', () => {
    withTempTree(
      { 'ok.js': '// hookData.tool_input.subagent_type names the target\nconst x = 1;\n' },
      (dir) => {
        const { violations } = scanTree(dir, [], dir);
        assert.deepEqual(violations, []);
      }
    );
  });

  it('failure message names file, line, pattern, and the accessor to use instead', () => {
    withTempTree({ 'bad.js': 'const who = process.env.CLAUDE_CURRENT_AGENT;\n' }, (dir) => {
      const { violations } = scanTree(dir, [], dir);
      const msg = formatViolation(violations[0]);
      assert.match(msg, /bad\.js/);
      assert.match(msg, /:1\b/);
      assert.match(msg, /process\.env\.CLAUDE_CURRENT_AGENT/);
      assert.match(msg, /use envAgentName\(\) from lib\/agent-identity/);
    });
  });

  it('reports a stale allowlist entry (file with no live match) for removal', () => {
    withTempTree({ 'clean.js': 'const x = 1;\n' }, (dir) => {
      const stale = [{ file: 'clean.js', reason: 'no longer needed' }];
      const { staleEntries } = scanTree(dir, stale, dir);
      assert.deepEqual(staleEntries, ['clean.js']);
    });
  });
});

describe('agent-identity grep-guard — real tree', () => {
  const result = scanTree(SCAN_ROOT, ALLOWLIST, REPO_ROOT);

  it('has zero identity primitives outside the module boundary + allowlist', () => {
    const report = result.violations.map(formatViolation).join('\n');
    assert.deepEqual(
      result.violations,
      [],
      `Inline identity heuristics found outside lib/agent-identity.js:\n${report}\n` +
        'Do NOT add these files to the allowlist (burn-down: it may only shrink) — ' +
        'migrate the call site to lib/agent-identity.js instead.'
    );
  });

  it('every allowlist entry is live — stale entries must be removed (burn-down)', () => {
    assert.deepEqual(
      result.staleEntries,
      [],
      `Stale allowlist entries (no forbidden pattern matches anymore): ` +
        `${result.staleEntries.join(', ')}. Remove them — the allowlist may only shrink.`
    );
  });

  it('the allowlist may only shrink (size is capped at the burn-down maximum)', () => {
    assert.ok(
      ALLOWLIST.length <= MAX_ALLOWLIST_SIZE,
      `Allowlist grew to ${ALLOWLIST.length} entries (max ${MAX_ALLOWLIST_SIZE}). ` +
        'The allowlist may only shrink — migrate the new consumer to lib/agent-identity.js. ' +
        'Never raise MAX_ALLOWLIST_SIZE.'
    );
    assert.equal(
      ALLOWLIST.length,
      new Set(ALLOWLIST.map((e) => e.file)).size,
      'Duplicate allowlist entries'
    );
  });

  it('every allowlist entry carries a one-line reason', () => {
    for (const entry of ALLOWLIST) {
      assert.ok(
        typeof entry.reason === 'string' && entry.reason.length > 0 && !entry.reason.includes('\n'),
        `Allowlist entry ${entry.file} must have a one-line reason`
      );
    }
  });

  it('session-guard and scope-protection files are scanned, not allowlisted', () => {
    const covered = [
      `${LIB}/hooks/session-guard.js`,
      `${LIB}/hooks/session-guard/hook-handlers.js`,
      `${LIB}/hooks/policies/scope-protection.js`,
    ];
    for (const rel of covered) {
      assert.ok(fs.existsSync(path.join(REPO_ROOT, rel)), `Expected scanned file to exist: ${rel}`);
      assert.ok(!isAllowlisted(rel, ALLOWLIST), `${rel} must NOT be allowlisted`);
    }
  });
});
