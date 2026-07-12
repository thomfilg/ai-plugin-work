'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const shared = require('../lib/kind-checks/shared');

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gh282-task2-'));
}

function writeSpec(dir, content) {
  fs.writeFileSync(path.join(dir, 'spec.md'), content, 'utf8');
}

function writeTasks(dir, content) {
  fs.writeFileSync(path.join(dir, 'tasks.md'), content, 'utf8');
}

test.describe('readReuseAudit(specDir)', () => {
  test('returns [{ symbol, line, mustReuse: true }] for spec with one MUST-reuse entry', () => {
    const dir = mkTmp();
    try {
      writeSpec(
        dir,
        [
          '# Spec',
          '',
          '## Reuse Audit',
          '',
          '- `ContentPageToolbar` MUST be reused from `apps/web/src/components/ContentPageToolbar.tsx`',
          '',
          '## Other',
          'unrelated',
          '',
        ].join('\n')
      );
      assert.equal(typeof shared.readReuseAudit, 'function', 'readReuseAudit must be exported');
      const result = shared.readReuseAudit(dir);
      assert.ok(Array.isArray(result), 'expected an array');
      assert.equal(result.length, 1);
      assert.equal(result[0].symbol, 'ContentPageToolbar');
      assert.equal(result[0].mustReuse, true);
      assert.equal(typeof result[0].line, 'number');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns null sentinel when no `## Reuse Audit` heading exists', () => {
    const dir = mkTmp();
    try {
      writeSpec(dir, '# Spec\n\n## Architecture\n\nsome text\n');
      assert.equal(typeof shared.readReuseAudit, 'function', 'readReuseAudit must be exported');
      const result = shared.readReuseAudit(dir);
      assert.equal(result, null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('parses the path-before-verb ordering: `Symbol` from `path` MUST be reused', () => {
    const dir = mkTmp();
    try {
      writeSpec(
        dir,
        [
          '# Spec',
          '',
          '## Reuse Audit',
          '',
          '- `readReuseAudit` from `lib/kind-checks/shared.js` MUST be reused — parser entry point',
          '- `dispatcherShape` from `lib/dispatcher-helpers.js` may be reused — mirrored, not imported',
          '',
          '## Other',
          'unrelated',
          '',
        ].join('\n')
      );
      const result = shared.readReuseAudit(dir);
      assert.ok(Array.isArray(result), 'expected an array');
      assert.equal(result.length, 2);
      assert.equal(result[0].symbol, 'readReuseAudit');
      assert.equal(result[0].mustReuse, true);
      assert.equal(result[1].symbol, 'dispatcherShape');
      assert.equal(result[1].mustReuse, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('canonical and path-before-verb orderings parse identically, MUST/may case-insensitive', () => {
    const dir = mkTmp();
    try {
      writeSpec(
        dir,
        [
          '# Spec',
          '',
          '## Reuse Audit',
          '',
          '- `AlphaHelper` must be reused from `src/alpha.js` — lowercase must, canonical order',
          '- `BetaHelper` from `src/beta.js` must be reused — lowercase must, path first',
          '- `GammaPattern` MAY be reused from `src/gamma.js` — uppercase may, canonical order',
          '- `DeltaPattern` from `src/delta.js` MAY be reused — uppercase may, path first',
          '',
        ].join('\n')
      );
      const result = shared.readReuseAudit(dir);
      assert.equal(result.length, 4);
      assert.deepEqual(
        result.map((e) => [e.symbol, e.mustReuse]),
        [
          ['AlphaHelper', true],
          ['BetaHelper', true],
          ['GammaPattern', false],
          ['DeltaPattern', false],
        ]
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('throws when the Reuse Audit section exists but is empty/unparseable', () => {
    const dir = mkTmp();
    try {
      writeSpec(dir, '# Spec\n\n## Reuse Audit\n\n\n## Next\nx\n');
      assert.equal(typeof shared.readReuseAudit, 'function', 'readReuseAudit must be exported');
      assert.throws(() => shared.readReuseAudit(dir));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // R7 (Task 1) — the declared source `path` is threaded through each record as
  // an additive field so the config-file branch (Task 2) can classify entries
  // without re-parsing. Covers all three path-bearing bullet orderings plus the
  // no-path case (`path: null`).
  test('threads declared `path` for the canonical ordering: `Symbol` MUST be reused from `path`', () => {
    const dir = mkTmp();
    try {
      writeSpec(
        dir,
        [
          '# Spec',
          '',
          '## Reuse Audit',
          '',
          '- `readReuseAudit` MUST be reused from `plugins/work/scripts/workflows/work-completion-checker/lib/kind-checks/shared.js` — parser entry point',
          '',
        ].join('\n')
      );
      const result = shared.readReuseAudit(dir);
      assert.equal(result.length, 1);
      assert.equal(result[0].symbol, 'readReuseAudit');
      assert.equal(
        result[0].path,
        'plugins/work/scripts/workflows/work-completion-checker/lib/kind-checks/shared.js'
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('threads declared `path` for the path-before-verb ordering: `Symbol` from `path` MUST be reused', () => {
    const dir = mkTmp();
    try {
      writeSpec(
        dir,
        [
          '# Spec',
          '',
          '## Reuse Audit',
          '',
          '- `readReuseAudit` from `lib/kind-checks/shared.js` MUST be reused — parser entry point',
          '',
        ].join('\n')
      );
      const result = shared.readReuseAudit(dir);
      assert.equal(result.length, 1);
      assert.equal(result[0].symbol, 'readReuseAudit');
      assert.equal(result[0].path, 'lib/kind-checks/shared.js');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('threads declared `path` for the parenthesized ordering: `Symbol` (`path`) MUST be reused', () => {
    const dir = mkTmp();
    try {
      writeSpec(
        dir,
        [
          '# Spec',
          '',
          '## Reuse Audit',
          '',
          '- `hooks` (`plugins/work/hooks/hooks.json`) MUST be reused — config entry',
          '',
        ].join('\n')
      );
      const result = shared.readReuseAudit(dir);
      assert.equal(result.length, 1);
      assert.equal(result[0].symbol, 'hooks');
      assert.equal(result[0].path, 'plugins/work/hooks/hooks.json');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('sets `path: null` when the bullet declares no source path', () => {
    const dir = mkTmp();
    try {
      writeSpec(
        dir,
        [
          '# Spec',
          '',
          '## Reuse Audit',
          '',
          '- `SomePattern` MUST be reused — mirrored pattern, no explicit path',
          '',
        ].join('\n')
      );
      const result = shared.readReuseAudit(dir);
      assert.equal(result.length, 1);
      assert.equal(result[0].symbol, 'SomePattern');
      assert.equal(result[0].path, null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test.describe('readSuggestedScopeFiles(tasksDir)', () => {
  test('legacy `### Suggested Scope` blocks are ignored (heading removed)', () => {
    const dir = mkTmp();
    try {
      writeTasks(
        dir,
        [
          '# Tasks',
          '',
          '## Task 1 — alpha',
          '',
          '### Suggested Scope',
          '- `path/to/a.js`',
          '- `path/to/b.js`',
          '',
          '## Task 2 — beta',
          '',
          '### Suggested Scope',
          '- `path/to/c.js`',
          '',
        ].join('\n')
      );
      assert.equal(
        typeof shared.readSuggestedScopeFiles,
        'function',
        'readSuggestedScopeFiles must be exported'
      );
      const result = shared.readSuggestedScopeFiles(dir);
      assert.equal(result, null, 'legacy-only tasks.md declares no recognized scope');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('`### Files in scope` wins when both are present (spec Open Q #3)', () => {
    const dir = mkTmp();
    try {
      writeTasks(
        dir,
        [
          '# Tasks',
          '',
          '## Task 1 — alpha',
          '',
          '### Suggested Scope',
          '- `legacy/old.js`',
          '',
          '### Files in scope',
          '- `new/path.js`',
          '',
        ].join('\n')
      );
      assert.equal(
        typeof shared.readSuggestedScopeFiles,
        'function',
        'readSuggestedScopeFiles must be exported'
      );
      const result = shared.readSuggestedScopeFiles(dir);
      assert.ok(Array.isArray(result));
      assert.ok(result.includes('new/path.js'), 'Files in scope should win');
      assert.ok(
        !result.includes('legacy/old.js'),
        'Suggested Scope should not appear when Files in scope is present'
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('present-but-empty `### Files in scope` wins over Suggested Scope (B7: honors authored intent)', () => {
    const dir = mkTmp();
    try {
      writeTasks(
        dir,
        [
          '# Tasks',
          '',
          '## Task 1 — alpha',
          '',
          '### Files in scope',
          '',
          '### Suggested Scope',
          '- `path/to/fallback.js`',
          '',
        ].join('\n')
      );
      const result = shared.readSuggestedScopeFiles(dir);
      assert.ok(Array.isArray(result));
      // B7: an explicitly empty Files-in-scope means "no files required" and
      // must NOT silently fall back to the legacy Suggested Scope, which may
      // enforce different files.
      assert.deepEqual(result, []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns null when no Suggested Scope / Files in scope subsection exists in any task', () => {
    const dir = mkTmp();
    try {
      writeTasks(
        dir,
        ['# Tasks', '', '## Task 1 — alpha', '', '### Requirements Covered', '- R1', ''].join('\n')
      );
      assert.equal(
        typeof shared.readSuggestedScopeFiles,
        'function',
        'readSuggestedScopeFiles must be exported'
      );
      const result = shared.readSuggestedScopeFiles(dir);
      assert.equal(result, null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test.describe('readTestReport(tasksDir)', () => {
  test('returns { exists: true, content } when tests.check.md exists', () => {
    const dir = mkTmp();
    try {
      const body = '# tests.check.md\n\n- test_R1 PASS\n- test_R2 FAIL\n';
      fs.writeFileSync(path.join(dir, 'tests.check.md'), body, 'utf8');
      assert.equal(typeof shared.readTestReport, 'function', 'readTestReport must be exported');
      const result = shared.readTestReport(dir);
      assert.equal(result.exists, true);
      assert.equal(result.content, body);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns { exists: false } when tests.check.md is absent', () => {
    const dir = mkTmp();
    try {
      assert.equal(typeof shared.readTestReport, 'function', 'readTestReport must be exported');
      const result = shared.readTestReport(dir);
      assert.equal(result.exists, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test.describe('readBriefRequirements(tasksDir) — MoSCoW headings (ECHO-5530/ECHO-5145)', () => {
  function writeBrief(dir, content) {
    fs.writeFileSync(path.join(dir, 'brief.md'), content, 'utf8');
  }

  test('parses `### Must Have (P0)` numbered items from the brief-writer canonical format', () => {
    const dir = mkTmp();
    try {
      writeBrief(
        dir,
        [
          '# Brief',
          '',
          '## Requirements',
          '',
          '### Must Have (P0)',
          '',
          '1. First must-have thing',
          '2. Second must-have thing',
          '',
          '### Should Have (P1)',
          '',
          '1. A should-have thing',
          '',
          '### Could Have (P2)',
          '',
          '- A could-have thing',
          '',
          '## Out of Scope',
          '- other',
          '',
        ].join('\n')
      );
      const reqs = shared.readBriefRequirements(dir);
      const p0 = reqs.filter((r) => r.priority === 'P0');
      const p1 = reqs.filter((r) => r.priority === 'P1');
      const p2 = reqs.filter((r) => r.priority === 'P2');
      assert.equal(p0.length, 2, `expected 2 P0s, got ${JSON.stringify(reqs)}`);
      assert.equal(p1.length, 1);
      assert.equal(p2.length, 1);
      assert.equal(p0[0].text, 'First must-have thing');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('MoSCoW headings without explicit (P0) tags map Must/Should/Could → P0/P1/P2', () => {
    const dir = mkTmp();
    try {
      writeBrief(
        dir,
        [
          '# Brief',
          '',
          '### Must-have',
          '- do the thing',
          '',
          '### Should have',
          '- maybe the thing',
          '',
        ].join('\n')
      );
      const reqs = shared.readBriefRequirements(dir);
      assert.deepEqual(
        reqs.map((r) => r.priority),
        ['P0', 'P1']
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('legacy `- P0:` bullets still take precedence when present', () => {
    const dir = mkTmp();
    try {
      writeBrief(
        dir,
        [
          '# Brief',
          '',
          '## Requirements',
          '- P0: legacy bullet requirement',
          '',
          '### Must Have (P0)',
          '1. moscow item that must NOT double-count',
          '',
        ].join('\n')
      );
      const reqs = shared.readBriefRequirements(dir);
      assert.equal(reqs.length, 1, 'legacy bullets win; MoSCoW is a fallback only');
      assert.equal(reqs[0].text, 'legacy bullet requirement');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns [] when brief has neither bullets nor MoSCoW headings', () => {
    const dir = mkTmp();
    try {
      writeBrief(dir, '# Brief\n\n## Context\n\nfree prose only\n');
      assert.deepEqual(shared.readBriefRequirements(dir), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test.describe('sliceSubsections(text, headingRe) — GH-408 h3 bounding', () => {
  const doc = [
    '## Task 1',
    '### Files explicitly out of scope',
    '- `components/**`',
    '### Deliverables',
    '- `z.union` in `lib/schema.ts`',
    '',
    '## Task 2',
    '### Files explicitly out of scope',
    '- `tests/e2e/**`',
    '',
  ].join('\n');

  test('bounds each block at the next ### (h3), not only ## (h2)', () => {
    const blocks = shared.sliceSubsections(doc, /^###\s+Files explicitly out of scope\b/im);
    assert.equal(blocks.length, 2);
    assert.ok(blocks[0].includes('components/**'));
    assert.ok(!blocks[0].includes('z.union'), 'sibling ### Deliverables must not be swallowed');
  });

  test('returns every matching block, not just the first', () => {
    const blocks = shared.sliceSubsections(doc, /^###\s+Files explicitly out of scope\b/im);
    assert.ok(blocks[1].includes('tests/e2e/**'));
  });

  test('returns [] for empty text or no match', () => {
    assert.deepEqual(shared.sliceSubsections('', /^###\s+Nope\b/im), []);
    assert.deepEqual(shared.sliceSubsections(doc, /^###\s+Nope\b/im), []);
  });

  test('last block runs to end of document', () => {
    const blocks = shared.sliceSubsections('## T\n### Head\n- `a/b.ts`', /^###\s+Head\b/im);
    assert.equal(blocks.length, 1);
    assert.ok(blocks[0].includes('a/b.ts'));
  });
});
