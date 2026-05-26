'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const surfaceAudit = require('../lib/phases/surface_audit');

function makeFixture({ briefContent, specContent, surfaceFileContent, surfaceFilePath }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'surface-audit-'));
  const tasksDir = path.join(root, 'tasks', 'ECHO-9999');
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(path.join(tasksDir, 'brief.md'), briefContent);
  if (specContent != null) fs.writeFileSync(path.join(tasksDir, 'spec.md'), specContent);
  if (surfaceFileContent != null) {
    const sp = path.join(root, surfaceFilePath);
    fs.mkdirSync(path.dirname(sp), { recursive: true });
    fs.writeFileSync(sp, surfaceFileContent);
  }
  return { root, tasksDir };
}

test('extractBacktickIdentifiers pulls every backticked token with line refs', () => {
  const out = surfaceAudit.extractBacktickIdentifiers('line `foo` and `bar.baz` here\n`qux`');
  const tokens = out.map((o) => o.token);
  assert.deepEqual(tokens, ['foo', 'bar.baz', 'qux']);
});

test('normalizeIdentifier unwraps generics and dots, filters built-ins', () => {
  assert.equal(surfaceAudit.normalizeIdentifier('workbookId'), 'workbookId');
  assert.deepEqual(surfaceAudit.normalizeIdentifier('exploreItemSchema.workbookId'), [
    'exploreItemSchema',
    'workbookId',
  ]);
  assert.deepEqual(surfaceAudit.normalizeIdentifier("RouterOutputs['explore']['list']"), [
    'RouterOutputs',
    'explore',
    'list',
  ]);
  assert.equal(surfaceAudit.normalizeIdentifier('string'), null);
  assert.equal(surfaceAudit.normalizeIdentifier('null'), null);
  assert.equal(surfaceAudit.normalizeIdentifier('Date'), null);
  // Code noise filtered out.
  assert.equal(surfaceAudit.normalizeIdentifier('foo()'), null);
});

test('audit BLOCKS on ECHO-4579-style miss when bullet names sibling file', () => {
  // Brief mentions `workbookId` in a bullet that references the sibling file
  // — but the file does NOT export `workbookId`.
  const SURF = 'lib/explore/explore.schemas.ts';
  const { root, tasksDir } = makeFixture({
    briefContent: [
      '# Brief',
      '## Out of scope (sibling-owned)',
      `- Sibling ECHO-4470 owns \`${SURF}\`, including \`exploreItemSchema\`.`,
      '## Requirements',
      `- Project \`workbookId\` from \`${SURF}\` (P0).`,
      '',
    ].join('\n'),
    specContent: null,
    surfaceFilePath: SURF,
    surfaceFileContent: [
      'export const exploreItemSchema = z.object({',
      '  id: z.string(),',
      '  title: z.string(),',
      '});',
    ].join('\n'),
  });
  const manifest = {
    worktreeRoot: root,
    siblings: [{ id: 'ECHO-4470', surfaces: [SURF] }],
  };
  const { errors } = surfaceAudit.auditArtifacts(tasksDir, manifest);
  assert.ok(errors.length > 0, 'expected at least one blocking error');
  assert.ok(
    errors.some((e) => e.includes('workbookId')),
    `expected error mentioning "workbookId", got: ${JSON.stringify(errors)}`
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('audit PASSES when the surface file does contain the identifier', () => {
  const SURF = 'lib/explore/explore.schemas.ts';
  const { root, tasksDir } = makeFixture({
    briefContent: ['# Brief', `- Project \`workbookId\` from \`${SURF}\`.`, ''].join('\n'),
    specContent: null,
    surfaceFilePath: SURF,
    surfaceFileContent: [
      'export const exploreItemSchema = z.object({',
      '  workbookId: z.string().nullable(),',
      '});',
    ].join('\n'),
  });
  const manifest = {
    worktreeRoot: root,
    siblings: [{ id: 'ECHO-4470', surfaces: [SURF] }],
  };
  const r = surfaceAudit.auditArtifacts(tasksDir, manifest);
  assert.equal(r.errors.length, 0, `expected no errors, got: ${JSON.stringify(r.errors)}`);
  assert.ok(r.verified.some((v) => v.identifier === 'workbookId'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('identifier mentioned without naming a sibling file → warning, not error', () => {
  const SURF = 'lib/explore/explore.schemas.ts';
  const { root, tasksDir } = makeFixture({
    briefContent: [
      '# Brief',
      `- Some component uses \`internalThing\` (no sibling file reference here).`,
      '',
    ].join('\n'),
    specContent: null,
    surfaceFilePath: SURF,
    surfaceFileContent: '// empty',
  });
  const manifest = {
    worktreeRoot: root,
    siblings: [{ id: 'ECHO-4470', surfaces: [SURF] }],
  };
  const r = surfaceAudit.auditArtifacts(tasksDir, manifest);
  assert.equal(r.errors.length, 0);
  assert.ok(r.warnings.length > 0, 'expected at least one warning');
  fs.rmSync(root, { recursive: true, force: true });
});

test('renderVerifiedBlock and upsertVerifiedSection roundtrip', () => {
  const block = surfaceAudit.renderVerifiedBlock([
    { file: 'a.ts', identifier: 'foo' },
    { file: 'b.ts', identifier: 'bar' },
  ]);
  assert.ok(block.includes('## Verified sibling surface'));
  assert.ok(block.includes('`a.ts::foo`'));

  const initial = '# Spec\n\nSome content.\n';
  const withBlock = surfaceAudit.upsertVerifiedSection(initial, block);
  assert.ok(withBlock.includes('## Verified sibling surface'));
  // Idempotent (upsert replaces, doesn't duplicate).
  const second = surfaceAudit.upsertVerifiedSection(withBlock, block);
  const occurrences = (second.match(/Verified sibling surface/g) || []).length;
  assert.equal(occurrences, 1);
});

test('no manifest → validate auto-passes (no siblings to check)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'surface-audit-'));
  const tasksDir = path.join(root, 'tasks', 'ECHO-9999');
  fs.mkdirSync(tasksDir, { recursive: true });
  const r = surfaceAudit.validate({
    tasksDir,
    manifest: null,
    worktreeRoot: root,
    linkedIds: [],
    memory: null,
  });
  assert.equal(r.ok, true);
  fs.rmSync(root, { recursive: true, force: true });
});
