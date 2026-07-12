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
    'utf8'
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
        'no failure record should be pushed'
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
        'observed must include the suffix-candidate hint string'
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
      assert.equal(ctx.failures.filter((f) => f.checkType === 'reuse_audit').length, 0);
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
        'wildcard match must NOT count — `.` must be escaped to a literal dot'
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
        `must not surface a regex SyntaxError; got errors=${JSON.stringify(errs)}`
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
        'errors must include a "parser threw: ..." entry'
      );
      // Parser failure must also be surfaced through the failure-store so
      // report.js can include it in completion-verdict.json.
      const parserFailure = ctx.failures.find(
        (f) => f.checkType === 'reuse_audit' && f.requirementId === 'REUSE-PARSER'
      );
      assert.ok(parserFailure, 'parser failure must be pushed onto ctx.failures');
    } finally {
      cleanup();
    }
  });
});

// --- #629: grammar tolerance + explicit none-marker --------------------------

test.describe('readReuseAudit grammar (#629)', () => {
  const { readReuseAudit } = require('../lib/kind-checks/shared');

  function specDirWith(body) {
    const root = mkTmp();
    const dir = path.join(root, 'tasks', 'GH-629');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'spec.md'), body, 'utf8');
    return { dir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
  }

  test('accepts the parenthesized-path variant `Symbol` (`path`) MUST be reused', () => {
    const { dir, cleanup } = specDirWith(
      [
        '# Spec',
        '',
        '## Reuse Audit',
        '',
        '- `distance` (`plugins/lib/levenshtein.js:46`) MUST be reused — typo suggestions',
        '- `nearest` (`plugins/lib/levenshtein.js:96`) may be reused — mirrored only',
        '',
      ].join('\n')
    );
    try {
      const entries = readReuseAudit(dir);
      assert.equal(entries.length, 2);
      assert.equal(entries[0].symbol, 'distance');
      assert.equal(entries[0].mustReuse, true);
      assert.equal(entries[1].symbol, 'nearest');
      assert.equal(entries[1].mustReuse, false);
    } finally {
      cleanup();
    }
  });

  test('explicit none-marker returns an empty (valid) declaration set', () => {
    const { dir, cleanup } = specDirWith(
      [
        '# Spec',
        '',
        '## Reuse Audit',
        '',
        '- None — no reusable symbols found (see Broad Search Evidence)',
        '',
      ].join('\n')
    );
    try {
      assert.deepEqual(readReuseAudit(dir), []);
    } finally {
      cleanup();
    }
  });

  test('prose-only section still throws with the grammar in the message', () => {
    const { dir, cleanup } = specDirWith(
      [
        '# Spec',
        '',
        '## Reuse Audit',
        '',
        '- `plugins/lib/levenshtein.js:46` and `:96` — pure helpers. Reused directly.',
        '',
      ].join('\n')
    );
    try {
      assert.throws(() => readReuseAudit(dir), /MUST be reused from/);
    } finally {
      cleanup();
    }
  });

  test('none-marker plus real entries keeps the real entries', () => {
    const { dir, cleanup } = specDirWith(
      [
        '# Spec',
        '',
        '## Reuse Audit',
        '',
        '- None of the legacy helpers apply here',
        '- `distance` MUST be reused from `plugins/lib/levenshtein.js:46` — typo suggestions',
        '',
      ].join('\n')
    );
    try {
      const entries = readReuseAudit(dir);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].symbol, 'distance');
    } finally {
      cleanup();
    }
  });
});

// --- GH-607 Task 2: in-place extension + config-file relaxations -------------

test.describe('GH-607 Task 2 — pure helpers (2.1)', () => {
  test('isConfigPath: config extension true; JS/TS extensions and nullish false', () => {
    assert.equal(typeof phase.isConfigPath, 'function', 'isConfigPath must be exported');
    assert.equal(phase.isConfigPath('hooks.json'), true, '.json is a config path');
    assert.equal(phase.isConfigPath('config/settings.yaml'), true, '.yaml is a config path');
    for (const js of ['a.js', 'b.ts', 'c.jsx', 'd.tsx', 'e.mjs', 'f.cjs']) {
      assert.equal(phase.isConfigPath(js), false, `${js} must NOT be a config path`);
    }
    // GH-607 review fix (Greptile P1): extensionless declared paths are never
    // importable JS/TS, so they count as config and take the scoped per-file
    // branch — otherwise Dockerfile/Makefile/CODEOWNERS entries would fall
    // through to the combined-diff importable check and leak from unrelated files.
    for (const cfg of ['Dockerfile', 'Makefile', 'CODEOWNERS', 'path/to/Procfile', '.gitignore']) {
      assert.equal(phase.isConfigPath(cfg), true, `${cfg} (extensionless) must be a config path`);
    }
    assert.equal(phase.isConfigPath(null), false, 'null is not a config path');
    assert.equal(phase.isConfigPath(undefined), false, 'undefined is not a config path');
    assert.equal(phase.isConfigPath(''), false, 'empty string is not a config path');
  });

  test('symbolPresentInBlobsScoped: matches only in the blob whose rel === relPath', () => {
    assert.equal(
      typeof phase.symbolPresentInBlobsScoped,
      'function',
      'symbolPresentInBlobsScoped must be exported'
    );
    const blobs = [
      { rel: 'a.js', content: 'const MATCHED_LABELS = [];\n' },
      { rel: 'b.js', content: 'nothing here\n' },
    ];
    assert.equal(
      phase.symbolPresentInBlobsScoped('MATCHED_LABELS', blobs, 'a.js'),
      true,
      'symbol present in the scoped file returns true'
    );
    const otherOnly = [
      { rel: 'a.js', content: 'nothing here\n' },
      { rel: 'b.js', content: 'const MATCHED_LABELS = [];\n' },
    ];
    assert.equal(
      phase.symbolPresentInBlobsScoped('MATCHED_LABELS', otherOnly, 'a.js'),
      false,
      'symbol present ONLY in another modified file must NOT satisfy the scoped check'
    );
    assert.equal(
      phase.symbolPresentInBlobsScoped('MATCHED_LABELS', otherOnly, 'missing.js'),
      false,
      'no blob matching relPath returns false'
    );
  });
});

test.describe('GH-607 Task 2 — configEntryPresent + guarded branches (2.2)', () => {
  test('configEntryPresent: true only when entry.path in changedSet AND its block on addedLines', () => {
    assert.equal(
      typeof phase.configEntryPresent,
      'function',
      'configEntryPresent must be exported'
    );
    const entry = { symbol: 'my-hook', path: 'hooks.json' };
    const addedLines = '  "my-hook": { "command": "node x.js" }\n';
    const changedSet = new Set(['hooks.json']);
    assert.equal(
      phase.configEntryPresent(entry, addedLines, changedSet),
      true,
      'present when path in changedSet and block on added lines'
    );
    assert.equal(
      phase.configEntryPresent(entry, addedLines, new Set(['other.json'])),
      false,
      'absent when entry.path not in changedSet'
    );
    assert.equal(
      phase.configEntryPresent(entry, 'unrelated added content\n', changedSet),
      false,
      'absent when in changedSet but block not on added lines'
    );
  });

  test('validate: in-place extension of a modified .js symbol (context line) ⇒ 0 missing', async () => {
    const spec = [
      '# Spec',
      '',
      '## Reuse Audit',
      '',
      '- `MATCHED_LABELS` MUST be reused from `lib/labels.js`',
      '',
    ].join('\n');
    // The declaration line is a CONTEXT line (already-present), but the file
    // WAS modified in this change (added a new element). symbolPresentInAdded
    // returns false for the symbol, yet the declaring file is in changedSet
    // with non-empty content → P0.1 relaxation must fire.
    const { ctx, cleanup } = buildCtx({
      spec,
      changedFiles: ['lib/labels.js'],
      fileContents: {
        'lib/labels.js': "const MATCHED_LABELS = ['a', 'b', 'newlyAdded'];\n",
      },
    });
    try {
      const result = await phase.validate(ctx);
      assert.equal(
        result.ok,
        true,
        'in-place extension of a modified .js symbol must pass the audit'
      );
      assert.equal(
        ctx.failures.filter((f) => f.checkType === 'reuse_audit').length,
        0,
        'no failure record for in-place extension'
      );
    } finally {
      cleanup();
    }
  });

  test('validate: hooks.json config MUST-reuse entry present in the change ⇒ 0 missing', async () => {
    const spec = [
      '# Spec',
      '',
      '## Reuse Audit',
      '',
      '- `my-hook` MUST be reused from `hooks.json`',
      '',
    ].join('\n');
    const { ctx, cleanup } = buildCtx({
      spec,
      changedFiles: ['hooks.json'],
      fileContents: {
        'hooks.json': '{\n  "my-hook": { "command": "node x.js" }\n}\n',
      },
    });
    try {
      const result = await phase.validate(ctx);
      assert.equal(result.ok, true, 'config-file entry present in change must pass');
      assert.equal(
        ctx.failures.filter((f) => f.checkType === 'reuse_audit').length,
        0,
        'no failure record for present config entry'
      );
    } finally {
      cleanup();
    }
  });
});

test.describe('GH-607 Task 2 — refined message + regression + negative control (2.3)', () => {
  test('config MUST-reuse entry ABSENT from the change fails', async () => {
    const spec = [
      '# Spec',
      '',
      '## Reuse Audit',
      '',
      '- `my-hook` MUST be reused from `hooks.json`',
      '',
    ].join('\n');
    // hooks.json is NOT in the changed set; an unrelated file changed instead.
    const { ctx, cleanup } = buildCtx({
      spec,
      changedFiles: ['src/other.js'],
      fileContents: {
        'src/other.js': 'const x = 1;\n',
      },
    });
    try {
      const result = await phase.validate(ctx);
      assert.equal(result.ok, false, 'config entry absent from change must fail');
      const rec = ctx.failures.find((f) => f.checkType === 'reuse_audit');
      assert.ok(rec, 'failure record must be pushed for absent config entry');
    } finally {
      cleanup();
    }
  });

  test('NEGATIVE CONTROL: symbol present only in an unmodified file still fails (anti-gaming)', async () => {
    const spec = [
      '# Spec',
      '',
      '## Reuse Audit',
      '',
      '- `MATCHED_LABELS` MUST be reused from `lib/labels.js`',
      '',
    ].join('\n');
    // The symbol lives in lib/labels.js, but that file is NOT in the changed
    // set (an unrelated file was modified). The P0.1 relaxation must NOT fire
    // because the declaring file was not modified — anti-gaming guarantee.
    const { ctx, cleanup } = buildCtx({
      spec,
      changedFiles: ['src/unrelated.js'],
      fileContents: {
        'src/unrelated.js': 'const y = 2;\n',
        'lib/labels.js': "const MATCHED_LABELS = ['a', 'b'];\n",
      },
    });
    try {
      const result = await phase.validate(ctx);
      assert.equal(
        result.ok,
        false,
        'symbol only in an unmodified file must STILL fail (anti-gaming)'
      );
      const rec = ctx.failures.find((f) => f.checkType === 'reuse_audit');
      assert.ok(rec, 'failure record must be pushed for unmodified-only symbol');
    } finally {
      cleanup();
    }
  });

  test('refined observed: "unmodified file" wording when declaring path NOT in changedSet', async () => {
    const spec = [
      '# Spec',
      '',
      '## Reuse Audit',
      '',
      '- `MATCHED_LABELS` MUST be reused from `lib/labels.js`',
      '',
    ].join('\n');
    // Declaring file lib/labels.js is NOT modified; a different file changed.
    const { ctx, cleanup } = buildCtx({
      spec,
      changedFiles: ['src/unrelated.js'],
      fileContents: {
        'src/unrelated.js': 'const y = 2;\n',
        'lib/labels.js': "const MATCHED_LABELS = ['a', 'b'];\n",
      },
    });
    try {
      const result = await phase.validate(ctx);
      assert.equal(result.ok, false);
      const rec = ctx.failures.find((f) => f.checkType === 'reuse_audit');
      assert.ok(rec, 'failure record exists');
      assert.match(
        rec.observed,
        /unmodified file/i,
        'observed must distinguish the unmodified-file miss class'
      );
    } finally {
      cleanup();
    }
  });

  test('refined observed: "no changed file references" wording when no changed file references the symbol', async () => {
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
      assert.equal(result.ok, false);
      const rec = ctx.failures.find((f) => f.checkType === 'reuse_audit');
      assert.ok(rec, 'failure record exists');
      assert.match(
        rec.observed,
        /no changed file references/i,
        'observed must distinguish the no-changed-file-reference miss class'
      );
    } finally {
      cleanup();
    }
  });
});

// --- GH-607 review fix: config-entry match must be scoped to entry.path -------
//
// Regression for the cross-file leak reported on
// reuse_audit_enforcement.js:162 — `addedLines` was the COMBINED `git diff -U0`
// for every changed file, so a config MUST-reuse entry could be satisfied by a
// needle that appears only on the added lines of an UNRELATED changed file. The
// `changedSet.has(entry.path)` gate confirmed the declared path was touched, but
// the block/path content match was not scoped to that file. These tests build a
// real git repo so `readAddedLines` runs and its per-file scoping is exercised.

test.describe('GH-607 review fix — config match scoped to declared file', () => {
  const childProcess = require('node:child_process');

  function git(cwd, args) {
    const r = childProcess.spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (r.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
    }
    return r.stdout;
  }

  // Build a git repo whose base branch (`main`) has an initial commit, then a
  // working tree that has ADDED `hooks.json` (without the needle) and an
  // unrelated changed file (with the needle) relative to that base.
  function buildGitCtx({ spec, hooksJsonAdded, otherFileAdded }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gh607-scoped-'));
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.email', 'test@example.com']);
    git(root, ['config', 'user.name', 'Test']);
    // Base commit: files exist but WITHOUT the added content under test.
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'hooks.json'), '{\n}\n', 'utf8');
    fs.writeFileSync(path.join(root, 'src', 'other.js'), 'const base = 0;\n', 'utf8');
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'base']);
    // Working-tree changes (HEAD is still the base commit; readAddedLines
    // diffs `main...HEAD`, and getDiffBaseCandidates resolves base = current
    // branch's tracked base → 'main'. We instead advance HEAD with a second
    // commit so `main...HEAD` shows the new lines).
    fs.writeFileSync(path.join(root, 'hooks.json'), hooksJsonAdded, 'utf8');
    fs.writeFileSync(path.join(root, 'src', 'other.js'), otherFileAdded, 'utf8');
    // Diff base is 'main'; put the new work on a different branch so main...HEAD
    // is a real ahead-diff.
    git(root, ['checkout', '-q', '-b', 'feature']);
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'work']);

    const tasksDir = path.join(root, 'tasks', 'GH-607');
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(path.join(tasksDir, 'spec.md'), spec, 'utf8');
    fs.writeFileSync(
      path.join(tasksDir, 'pr-context.json'),
      JSON.stringify({ files: ['hooks.json', 'src/other.js'] }, null, 2),
      'utf8'
    );
    return {
      ctx: { tasksDir, worktreeRoot: root, failures: [] },
      cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
    };
  }

  test('needle only in an UNRELATED changed file does NOT satisfy the config entry', async () => {
    const spec = [
      '# Spec',
      '',
      '## Reuse Audit',
      '',
      '- `my-hook` MUST be reused from `hooks.json`',
      '',
    ].join('\n');
    // hooks.json is added-to but WITHOUT the `my-hook` symbol OR the `hooks.json`
    // path string; the `hooks.json` PATH needle appears only on added lines of the
    // unrelated src/other.js. `configEntryPresent` matches EITHER needle (symbol
    // or path), so pre-fix the combined diff let the path needle from the other
    // file satisfy the entry. Post-fix, the per-file scoped read of hooks.json —
    // which contains neither needle — fails it. (We avoid the `my-hook` symbol in
    // the other file so the PRIMARY symbol-in-added check can't confound the test.)
    const { ctx, cleanup } = buildGitCtx({
      spec,
      hooksJsonAdded: '{\n  "unrelated": { "command": "node z.js" }\n}\n',
      otherFileAdded: 'const base = 0;\n// see config in hooks.json for wiring\n',
    });
    try {
      const result = await phase.validate(ctx);
      assert.equal(
        result.ok,
        false,
        'config entry must NOT pass when the needle is only in another changed file'
      );
      const rec = ctx.failures.find((f) => f.checkType === 'reuse_audit');
      assert.ok(rec, 'failure record must be pushed for the leaked config entry');
    } finally {
      cleanup();
    }
  });

  test('needle on the declared file’s own added lines DOES satisfy the config entry', async () => {
    const spec = [
      '# Spec',
      '',
      '## Reuse Audit',
      '',
      '- `my-hook` MUST be reused from `hooks.json`',
      '',
    ].join('\n');
    const { ctx, cleanup } = buildGitCtx({
      spec,
      hooksJsonAdded: '{\n  "my-hook": { "command": "node x.js" }\n}\n',
      otherFileAdded: 'const base = 0;\nconst extra = 1;\n',
    });
    try {
      const result = await phase.validate(ctx);
      assert.equal(
        result.ok,
        true,
        'config entry must pass when its block is on the declared file’s own added lines'
      );
      assert.equal(
        ctx.failures.filter((f) => f.checkType === 'reuse_audit').length,
        0,
        'no failure record when the config block is genuinely present in the declared file'
      );
    } finally {
      cleanup();
    }
  });

  // GH-607 review fix: the spec author writes `./hooks.json` (equivalent
  // repo-relative spelling) but git's --name-only / pr-context list carries the
  // canonical `hooks.json`. Pre-fix the raw `changedSet.has(entry.path)` gate
  // rejected the reuse; post-fix both sides normalize and it is recognized.
  test('`./hooks.json` spec spelling matches canonical `hooks.json` change (config gate)', async () => {
    const spec = [
      '# Spec',
      '',
      '## Reuse Audit',
      '',
      '- `my-hook` MUST be reused from `./hooks.json`',
      '',
    ].join('\n');
    const { ctx, cleanup } = buildGitCtx({
      spec,
      hooksJsonAdded: '{\n  "my-hook": { "command": "node x.js" }\n}\n',
      otherFileAdded: 'const base = 0;\nconst extra = 1;\n',
    });
    try {
      const result = await phase.validate(ctx);
      assert.equal(
        result.ok,
        true,
        '`./hooks.json` spec spelling must be recognized as the reused `hooks.json` change'
      );
      assert.equal(
        ctx.failures.filter((f) => f.checkType === 'reuse_audit').length,
        0,
        'no failure record when the equivalent-spelling config block is genuinely present'
      );
    } finally {
      cleanup();
    }
  });

  // Anti-gaming negative control preserved under the new normalization: the
  // `./hooks.json` spelling still fails when the needle lives only in an
  // unrelated changed file (nothing on hooks.json's own added lines).
  test('`./hooks.json` spelling still fails when needle only in an unrelated file (anti-gaming)', async () => {
    const spec = [
      '# Spec',
      '',
      '## Reuse Audit',
      '',
      '- `my-hook` MUST be reused from `./hooks.json`',
      '',
    ].join('\n');
    const { ctx, cleanup } = buildGitCtx({
      spec,
      hooksJsonAdded: '{\n  "unrelated": { "command": "node z.js" }\n}\n',
      otherFileAdded: 'const base = 0;\n// see config in hooks.json for wiring\n',
    });
    try {
      const result = await phase.validate(ctx);
      assert.equal(
        result.ok,
        false,
        'normalization must not let an unrelated-file needle satisfy the `./hooks.json` entry'
      );
      const rec = ctx.failures.find((f) => f.checkType === 'reuse_audit');
      assert.ok(rec, 'failure record must still be pushed for the leaked config entry');
    } finally {
      cleanup();
    }
  });
});

test.describe('GH-607 — normalizeRepoPath canonicalization', () => {
  test('strips ./ prefix, leading slash, redundant separators, trailing slash', () => {
    assert.equal(phase.normalizeRepoPath('./hooks.json'), 'hooks.json');
    assert.equal(phase.normalizeRepoPath('/hooks.json'), 'hooks.json');
    assert.equal(phase.normalizeRepoPath('src//other.js'), 'src/other.js');
    assert.equal(phase.normalizeRepoPath('.//src/nested.js'), 'src/nested.js');
    assert.equal(phase.normalizeRepoPath('src/dir/'), 'src/dir');
    assert.equal(phase.normalizeRepoPath('src\\win\\path.js'), 'src/win/path.js');
  });

  test('already-canonical paths are unchanged and nullish input is passed through', () => {
    assert.equal(phase.normalizeRepoPath('hooks.json'), 'hooks.json');
    assert.equal(phase.normalizeRepoPath('src/other.js'), 'src/other.js');
    assert.equal(phase.normalizeRepoPath(''), '');
    assert.equal(phase.normalizeRepoPath(null), null);
    assert.equal(phase.normalizeRepoPath(undefined), undefined);
  });

  test('does NOT resolve `..` outside the repo (conservative)', () => {
    // A `..` segment is left intact so an out-of-tree path cannot silently
    // normalize onto an in-tree change-set entry.
    assert.equal(phase.normalizeRepoPath('../hooks.json'), '../hooks.json');
  });
});

// --- GH-607 review fix: P0.1 in-place extension under REAL git ---------------
//
// The tmpdir fixtures in buildCtx are NOT git repos, so `readAddedLines`
// returns null and the phase satisfies a MUST-reuse symbol via the LEGACY
// full-blob proxy (`symbolPresentInBlobs`) — the P0.1 `isInPlaceExtension`
// branch never executes there. These tests build a real git repo so
// `readAddedLines` yields a genuine `main...HEAD` diff whose added lines do
// NOT contain the symbol token (the declaration sits on a context line),
// forcing `symbolPresentInAdded` to return false and making
// `isInPlaceExtension` the ONLY thing that can pass the audit.

test.describe('GH-607 P0.1 — in-place extension under real git', () => {
  const childProcess = require('node:child_process');

  function git(cwd, args) {
    const r = childProcess.spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (r.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
    }
    return r.stdout;
  }

  // `files` maps repo-relative path → { base, head }. The base commit lands on
  // `main`; the working change lands on a `feature` commit so `main...HEAD` is a
  // real ahead-diff. Only `changedFiles` are recorded in pr-context.json.
  function buildInPlaceGitCtx({ spec, files, changedFiles }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gh607-inplace-'));
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.email', 'test@example.com']);
    git(root, ['config', 'user.name', 'Test']);
    for (const [rel, { base }] of Object.entries(files)) {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, base, 'utf8');
    }
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'base']);
    git(root, ['checkout', '-q', '-b', 'feature']);
    for (const [rel, { head }] of Object.entries(files)) {
      fs.writeFileSync(path.join(root, rel), head, 'utf8');
    }
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'work']);

    const tasksDir = path.join(root, 'tasks', 'GH-607');
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(path.join(tasksDir, 'spec.md'), spec, 'utf8');
    fs.writeFileSync(
      path.join(tasksDir, 'pr-context.json'),
      JSON.stringify({ files: changedFiles }, null, 2),
      'utf8'
    );
    return {
      ctx: { tasksDir, worktreeRoot: root, failures: [] },
      cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
    };
  }

  const spec = [
    '# Spec',
    '',
    '## Reuse Audit',
    '',
    '- `MATCHED_LABELS` MUST be reused from `lib/labels.js`',
    '',
  ].join('\n');

  test('symbol on a context line of a genuinely-modified .js file passes via isInPlaceExtension', async () => {
    // Base already declares MATCHED_LABELS across multiple lines; the feature
    // commit only ADDS a new array element. `git diff -U0` therefore contains no
    // MATCHED_LABELS token on a `+` line, so symbolPresentInAdded is false and
    // ONLY the P0.1 branch (declaring file modified + scoped blob) can pass it.
    const { ctx, cleanup } = buildInPlaceGitCtx({
      spec,
      changedFiles: ['lib/labels.js'],
      files: {
        'lib/labels.js': {
          base: "const MATCHED_LABELS = [\n  'a',\n  'b',\n];\n",
          head: "const MATCHED_LABELS = [\n  'a',\n  'b',\n  'c',\n];\n",
        },
      },
    });
    try {
      // Guard: prove the symbol is NOT on an added line, so a green result can
      // only come from isInPlaceExtension — not the primary added-line check.
      const added = phase.symbolPresentInAdded(
        'MATCHED_LABELS',
        // reproduce what validate() passes: the scoped added lines for the file
        require('node:child_process')
          .spawnSync('git', ['diff', '-U0', 'main...HEAD', '--', 'lib/labels.js'], {
            cwd: ctx.worktreeRoot,
            encoding: 'utf8',
          })
          .stdout.split('\n')
          .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
          .map((l) => l.slice(1))
          .join('\n')
      );
      assert.equal(added, false, 'guard: MATCHED_LABELS must NOT appear on an added line');

      const result = await phase.validate(ctx);
      assert.equal(result.ok, true, 'in-place extension under real git must pass via P0.1');
      assert.equal(
        ctx.failures.filter((f) => f.checkType === 'reuse_audit').length,
        0,
        'no failure record for a genuine in-place extension'
      );
    } finally {
      cleanup();
    }
  });

  test('symbol only in an UNMODIFIED declaring file still fails under real git (anti-gaming)', async () => {
    // lib/labels.js is unchanged (base === head) so git omits it from the diff
    // and it is NOT in changedFiles; only an unrelated file changed. The P0.1
    // relaxation must NOT fire and the audit must fail — anti-gaming holds even
    // when git IS available (the exact condition the tmpdir negative control
    // could not reach).
    const { ctx, cleanup } = buildInPlaceGitCtx({
      spec,
      changedFiles: ['src/unrelated.js'],
      files: {
        'lib/labels.js': {
          base: "const MATCHED_LABELS = ['a', 'b'];\n",
          head: "const MATCHED_LABELS = ['a', 'b'];\n",
        },
        'src/unrelated.js': {
          base: 'const base = 0;\n',
          head: 'const base = 0;\nconst extra = 1;\n',
        },
      },
    });
    try {
      const result = await phase.validate(ctx);
      assert.equal(result.ok, false, 'unmodified declaring file must still fail under real git');
      const rec = ctx.failures.find((f) => f.checkType === 'reuse_audit');
      assert.ok(rec, 'failure record must be pushed for the unmodified-only symbol');
      assert.match(
        rec.observed,
        /unmodified file/i,
        'observed must name the unmodified-file miss class'
      );
    } finally {
      cleanup();
    }
  });

  // Greptile P1 (reuse_audit_enforcement.js:282): for a config-path entry the
  // primary symbol check ran against the COMBINED diff before the scoped config
  // check, so the config symbol text added in an UNRELATED file made present=true
  // and skipped isConfigEntryReused(). Here `my-hook` is added in src/other.js
  // while the declared config file hooks.json is UNTOUCHED (byte-identical, not in
  // the change set) — it must stay non-reused; config entries are judged only
  // against their own declared file.
  test('config symbol text in an unrelated changed file does NOT satisfy an untouched config entry (P1)', async () => {
    const cfgSpec = [
      '# Spec',
      '',
      '## Reuse Audit',
      '',
      '- `my-hook` MUST be reused from `hooks.json`',
      '',
    ].join('\n');
    const { ctx, cleanup } = buildInPlaceGitCtx({
      spec: cfgSpec,
      changedFiles: ['src/other.js'],
      files: {
        'hooks.json': { base: '{\n}\n', head: '{\n}\n' },
        'src/other.js': {
          base: 'const base = 0;\n',
          head: 'const base = 0;\nconst wire = "my-hook";\n',
        },
      },
    });
    try {
      // Guard: the combined diff DOES contain the symbol text (the exact bait the
      // pre-fix primary check swallowed), so it is the per-file SCOPING — not an
      // absent needle — that fails the entry.
      const combined = git(ctx.worktreeRoot, ['diff', '-U0', 'main...HEAD', '--', 'src/other.js']);
      assert.match(
        combined,
        /my-hook/,
        'guard: unrelated file added lines must contain the symbol'
      );

      const result = await phase.validate(ctx);
      assert.equal(
        result.ok,
        false,
        'config entry must NOT pass when the symbol text is only in an unrelated changed file'
      );
      const rec = ctx.failures.find((f) => f.checkType === 'reuse_audit');
      assert.ok(rec, 'failure record must be pushed for the leaked config entry');
    } finally {
      cleanup();
    }
  });

  // Greptile P1 (isConfigPath extensionless): an extensionless declared path
  // (Dockerfile/Makefile/CODEOWNERS) must be treated as config and scoped to its
  // own file — otherwise it falls through to the importable-symbol branch and the
  // symbol text in an UNRELATED changed file leaks a false pass. Here `my-target`
  // is added in src/other.js while the declared Dockerfile is untouched.
  test('extensionless config (Dockerfile) symbol in an unrelated file does NOT satisfy an untouched entry', async () => {
    const cfgSpec = [
      '# Spec',
      '',
      '## Reuse Audit',
      '',
      '- `my-target` MUST be reused from `Dockerfile`',
      '',
    ].join('\n');
    const { ctx, cleanup } = buildInPlaceGitCtx({
      spec: cfgSpec,
      changedFiles: ['src/other.js'],
      files: {
        Dockerfile: { base: 'FROM node:22\n', head: 'FROM node:22\n' },
        'src/other.js': {
          base: 'const base = 0;\n',
          head: 'const base = 0;\nconst wire = "my-target";\n',
        },
      },
    });
    try {
      const combined = git(ctx.worktreeRoot, ['diff', '-U0', 'main...HEAD', '--', 'src/other.js']);
      assert.match(
        combined,
        /my-target/,
        'guard: unrelated file added lines must contain the symbol'
      );

      const result = await phase.validate(ctx);
      assert.equal(
        result.ok,
        false,
        'extensionless config entry must NOT pass when the symbol is only in an unrelated file'
      );
      const rec = ctx.failures.find((f) => f.checkType === 'reuse_audit');
      assert.ok(rec, 'failure record must be pushed for the leaked extensionless config entry');
    } finally {
      cleanup();
    }
  });
});
