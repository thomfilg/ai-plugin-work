'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const phase = require('../lib/phases/reuse_audit_enforcement');

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gh282-task4-'));
}

/**
 * Build a fixture ctx with tasksDir + worktreeRoot. Writes spec.md if provided
 * and writes a pr-context.json file list so readChangedFiles is deterministic.
 */
function buildCtx({ spec, changedFiles = [], fileContents = {} }) {
  const root = mkTmp();
  const tasksDir = path.join(root, 'tasks', 'GH-282');
  fs.mkdirSync(tasksDir, { recursive: true });
  if (spec !== undefined) {
    fs.writeFileSync(path.join(tasksDir, 'spec.md'), spec, 'utf8');
  }
  // Lock the changed-file list via pr-context.json so we don't depend on git.
  fs.writeFileSync(
    path.join(tasksDir, 'pr-context.json'),
    JSON.stringify({ files: changedFiles }, null, 2),
    'utf8',
  );
  // Write content for each changed file under worktreeRoot
  for (const [rel, body] of Object.entries(fileContents)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, 'utf8');
  }
  return {
    ctx: {
      tasksDir,
      worktreeRoot: root,
      failures: [],
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test.describe('reuse_audit_enforcement phase', () => {
  test('Reuse Audit "MUST be reused" component missing from diff fails completion', async () => {
    const spec = [
      '# Spec',
      '',
      '## Reuse Audit',
      '',
      '- `ContentPageToolbar` MUST be reused from `apps/web/src/components/ContentPageToolbar.tsx`',
      '',
    ].join('\n');
    const { ctx, cleanup } = buildCtx({
      spec,
      changedFiles: ['apps/web/src/pages/Other.tsx'],
      fileContents: {
        'apps/web/src/pages/Other.tsx': 'import { SomethingElse } from "./x";\n',
      },
    });
    try {
      const result = await phase.validate(ctx);
      assert.equal(result.ok, false, 'phase must fail when MUST-reuse symbol absent');
      assert.ok(Array.isArray(result.errors), 'errors array on failure');
      assert.ok(result.errors.length > 0);
      const rec = ctx.failures.find((f) => f.checkType === 'reuse_audit');
      assert.ok(rec, 'a reuse_audit failure record must be pushed');
      assert.equal(rec.expected, 'ContentPageToolbar imported');
      assert.match(rec.observed, /imported instead|not found/);
    } finally {
      cleanup();
    }
  });

  test('Reuse Audit "MUST be reused" component present in diff passes', async () => {
    const spec = [
      '# Spec',
      '',
      '## Reuse Audit',
      '',
      '- `ContentPageToolbar` MUST be reused from `apps/web/src/components/ContentPageToolbar.tsx`',
      '',
    ].join('\n');
    const { ctx, cleanup } = buildCtx({
      spec,
      changedFiles: ['apps/web/src/pages/Page.tsx'],
      fileContents: {
        'apps/web/src/pages/Page.tsx':
          'import { ContentPageToolbar } from "../components/ContentPageToolbar";\n',
      },
    });
    try {
      const result = await phase.validate(ctx);
      assert.equal(result.ok, true, 'phase must pass when MUST-reuse symbol present');
      assert.equal(
        ctx.failures.filter((f) => f.checkType === 'reuse_audit').length,
        0,
        'no failure record should be pushed',
      );
    } finally {
      cleanup();
    }
  });

  test('Spec without a Reuse Audit section is skipped (backward compatible)', async () => {
    const spec = '# Spec\n\n## Architecture\n\nblah\n';
    const { ctx, cleanup } = buildCtx({
      spec,
      changedFiles: ['some/file.ts'],
      fileContents: { 'some/file.ts': 'x' },
    });
    try {
      const result = await phase.validate(ctx);
      assert.equal(result.ok, true);
      assert.match(String(result.summary || ''), /no Reuse Audit section/i);
      assert.match(String(result.summary || ''), /skipped/i);
    } finally {
      cleanup();
    }
  });

  test('Reuse mismatch hint surfaces similarly-named alternative (P1)', async () => {
    const spec = [
      '# Spec',
      '',
      '## Reuse Audit',
      '',
      '- `ContentPageToolbar` MUST be reused from `apps/web/src/components/ContentPageToolbar.tsx`',
      '',
    ].join('\n');
    const { ctx, cleanup } = buildCtx({
      spec,
      changedFiles: ['apps/web/src/pages/Explore.tsx'],
      fileContents: {
        'apps/web/src/pages/Explore.tsx':
          'import { ExploreBulkToolbar } from "../components/ExploreBulkToolbar";\n',
      },
    });
    try {
      const result = await phase.validate(ctx);
      assert.equal(result.ok, false);
      const rec = ctx.failures.find((f) => f.checkType === 'reuse_audit');
      assert.ok(rec, 'failure record exists');
      assert.match(
        rec.observed,
        /found ExploreBulkToolbar in diff — did you mean to extend ContentPageToolbar\?/,
        'observed must include the suffix-candidate hint string',
      );
    } finally {
      cleanup();
    }
  });

  test('extractSuffixCandidates returns [] for camelCase symbols (no false-positive hints)', () => {
    const diff = [
      'const changedFiles = readChangedFiles(ctx);',
      'const allFiles = listAll();',
    ].join('\n');
    const candidates = phase.extractSuffixCandidates('readChangedFiles', diff);
    assert.deepEqual(candidates, [], 'camelCase symbol must produce no suffix candidates');
  });

  test('symbol with regex metacharacter (`Object.create`) is matched literally — passes when present', async () => {
    const spec = [
      '# Spec',
      '',
      '## Reuse Audit',
      '',
      '- `Object.create` MUST be reused from `lib/x.js`',
      '',
    ].join('\n');
    const { ctx, cleanup } = buildCtx({
      spec,
      changedFiles: ['lib/x.js'],
      fileContents: {
        'lib/x.js': 'const o = Object.create(null);\n',
      },
    });
    try {
      const result = await phase.validate(ctx);
      assert.equal(result.ok, true, 'literal Object.create in diff must satisfy the audit');
      assert.equal(
        ctx.failures.filter((f) => f.checkType === 'reuse_audit').length,
        0,
      );
    } finally {
      cleanup();
    }
  });

  test('symbol with regex metacharacter (`Object.create`) does NOT match wildcard token `ObjectXcreate`', async () => {
    const spec = [
      '# Spec',
      '',
      '## Reuse Audit',
      '',
      '- `Object.create` MUST be reused from `lib/x.js`',
      '',
    ].join('\n');
    const { ctx, cleanup } = buildCtx({
      spec,
      changedFiles: ['lib/x.js'],
      fileContents: {
        'lib/x.js': 'const o = ObjectXcreate(null);\n',
      },
    });
    try {
      const result = await phase.validate(ctx);
      assert.equal(
        result.ok,
        false,
        'wildcard match must NOT count — `.` must be escaped to a literal dot',
      );
      const rec = ctx.failures.find((f) => f.checkType === 'reuse_audit');
      assert.ok(rec, 'failure record should be pushed for missing literal symbol');
    } finally {
      cleanup();
    }
  });

  test('symbol containing `[`/`]` does not throw SyntaxError (regex metachar escaped)', async () => {
    const spec = [
      '# Spec',
      '',
      '## Reuse Audit',
      '',
      '- `foo[bar]` MUST be reused from `lib/y.js`',
      '',
    ].join('\n');
    const { ctx, cleanup } = buildCtx({
      spec,
      changedFiles: ['lib/y.js'],
      fileContents: {
        'lib/y.js': 'const v = foo[bar];\n',
      },
    });
    try {
      const result = await phase.validate(ctx);
      // The key assertion: validate did not crash with a SyntaxError caught
      // by the fail-closed handler (which would surface "parser threw:"
      // and silently bypass enforcement). Either ok:true (literal match
      // succeeded) is acceptable; what must NOT happen is a parser-threw
      // SyntaxError from an unescaped `[`.
      const errs = Array.isArray(result.errors) ? result.errors : [];
      assert.ok(
        !errs.some((e) => /SyntaxError|Invalid regular expression/i.test(String(e))),
        `must not surface a regex SyntaxError; got errors=${JSON.stringify(errs)}`,
      );
    } finally {
      cleanup();
    }
  });

  test('(e) parser throws on malformed Reuse Audit block ⇒ ok:false with parser threw error (fail-closed)', async () => {
    // Reuse Audit heading present but body is empty/unparseable → readReuseAudit throws.
    const spec = '# Spec\n\n## Reuse Audit\n\n\n## Next\nx\n';
    const { ctx, cleanup } = buildCtx({
      spec,
      changedFiles: [],
      fileContents: {},
    });
    try {
      const result = await phase.validate(ctx);
      assert.equal(result.ok, false, 'must fail-closed on parser throw');
      assert.ok(Array.isArray(result.errors));
      assert.ok(
        result.errors.some((e) => /^parser threw:/.test(String(e))),
        'errors must include a "parser threw: ..." entry',
      );
      // Parser failure must also be surfaced through the failure-store so
      // report.js can include it in completion-verdict.json.
      const parserFailure = ctx.failures.find(
        (f) => f.checkType === 'reuse_audit' && f.requirementId === 'REUSE-PARSER',
      );
      assert.ok(parserFailure, 'parser failure must be pushed onto ctx.failures');
    } finally {
      cleanup();
    }
  });
});
