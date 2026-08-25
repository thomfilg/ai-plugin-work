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

// ─── Glob-surface basename must not match every bold markdown line ──────────
//
// A sibling surface is often declared as a glob (`components/pulse/**`). Its
// basename is `**`, so a naive `lineText.includes(basename)` matched ANY line
// containing bold markdown and reported ordinary prose as a sibling-file
// reference — hard-blocking the spec phase.

const GLOB_SURF = 'components/pulse/pulse-content/**';
const REAL_SURF = 'lib/explore/explore.schemas.ts';

test('bold markdown does not count as a reference to a glob-declared surface', () => {
  const { root, tasksDir } = makeFixture({
    briefContent: ['# Brief', '', '**Goal:** expose `PulseNavRow` in the sidebar.', ''].join('\n'),
    specContent: null,
    surfaceFilePath: null,
    surfaceFileContent: null,
  });
  const manifest = { worktreeRoot: root, siblings: [{ id: 'ECHO-5689', surfaces: [GLOB_SURF] }] };
  const { errors, warnings } = surfaceAudit.auditArtifacts(tasksDir, manifest);
  assert.deepEqual(errors, [], `bold prose must not block, got: ${JSON.stringify(errors)}`);
  assert.ok(
    warnings.some((w) => w.includes('PulseNavRow')),
    `expected a warning for the unresolved identifier, got: ${JSON.stringify(warnings)}`
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('a genuine sibling-file reference still BLOCKS alongside a glob surface', () => {
  // Both surfaces present: the glob must stay inert while the concrete path
  // still produces a blocking error. A fix that merely disabled the gate would
  // fail this half.
  const { root, tasksDir } = makeFixture({
    briefContent: [
      '# Brief',
      '',
      '**Goal:** ship the thing.',
      '',
      `- Project \`workbookId\` from \`${REAL_SURF}\` (P0).`,
      '',
    ].join('\n'),
    specContent: null,
    surfaceFilePath: REAL_SURF,
    surfaceFileContent: 'export const exploreItemSchema = {};\n',
  });
  const manifest = {
    worktreeRoot: root,
    siblings: [
      { id: 'ECHO-5689', surfaces: [GLOB_SURF] },
      { id: 'ECHO-4470', surfaces: [REAL_SURF] },
    ],
  };
  const { errors } = surfaceAudit.auditArtifacts(tasksDir, manifest);
  assert.ok(
    errors.some((e) => e.includes('workbookId') && e.includes(REAL_SURF)),
    `expected a blocking error naming the real surface, got: ${JSON.stringify(errors)}`
  );
  fs.rmSync(root, { recursive: true, force: true });
});

// ─── Evidence prose is not a surface claim ──────────────────────────────────
//
// `brief-next.js` phase `draft` REQUIRES a `Searched:` annotation on every open
// question. Those annotations name env vars, MCP tools, JSON fields and grep
// patterns in backticks — evidence of what was consulted, not claims that a
// sibling exposes them. Auditing that text made `draft` and `surface_audit`
// contradict each other: the brief could not pass one without failing the other.

test('Searched: annotations under Open Questions do not block', () => {
  const SURF = 'docker/Dockerfile';
  const { root, tasksDir } = makeFixture({
    briefContent: [
      '# Brief',
      '',
      '## Open Questions',
      '',
      '- Should the seed run in CI?',
      `  Searched: \`${SURF}\` documents \`SEED_DATABASE\` as a build arg; Linear MCP unavailable (\`mcp__linear__get_issue\` → "No such tool available").`,
      '',
    ].join('\n'),
    specContent: null,
    surfaceFilePath: SURF,
    surfaceFileContent: 'FROM node:22\n',
  });
  const manifest = { worktreeRoot: root, relatedTo: [{ id: 'CHAR-8177', surfaces: [SURF] }] };
  const { errors, warnings } = surfaceAudit.auditArtifacts(tasksDir, manifest);
  assert.deepEqual(errors, [], `evidence prose must not block, got: ${JSON.stringify(errors)}`);
  assert.deepEqual(warnings, [], `evidence prose must not even warn, got: ${JSON.stringify(warnings)}`);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a Searched: annotation outside Open Questions is skipped too', () => {
  const SURF = 'lib/explore/explore.schemas.ts';
  const { root, tasksDir } = makeFixture({
    briefContent: [
      '# Brief',
      '',
      '## Constraints',
      `- Searched: \`${SURF}\` for \`legacyFlag\` → not present.`,
      '',
    ].join('\n'),
    specContent: null,
    surfaceFilePath: SURF,
    surfaceFileContent: '// empty\n',
  });
  const manifest = { worktreeRoot: root, siblings: [{ id: 'ECHO-4470', surfaces: [SURF] }] };
  const { errors } = surfaceAudit.auditArtifacts(tasksDir, manifest);
  assert.deepEqual(errors, [], `got: ${JSON.stringify(errors)}`);
  fs.rmSync(root, { recursive: true, force: true });
});

test('stripEvidenceProse blanks the right lines and preserves line numbers', () => {
  const src = [
    '## Requirements', // 1
    '- keep `alpha`', // 2
    '## Open Questions', // 3
    '- drop `beta`', // 4
    '  Searched: `gamma`', // 5
    '## Constraints', // 6
    '- keep `delta`', // 7
    '- Searched: `epsilon`', // 8
  ].join('\n');
  const out = surfaceAudit.stripEvidenceProse(src);
  assert.equal(out.split('\n').length, 8, 'line count must be preserved');
  const tokens = surfaceAudit.extractBacktickIdentifiers(out);
  assert.deepEqual(
    tokens.map((t) => [t.token, t.line]),
    [
      ['alpha', 2],
      ['delta', 7],
    ]
  );
});

// ─── Sibling attribution must align on path boundaries ──────────────────────
//
// `tasks/CHAR-8178/ticket.json` (this ticket's own file) and sibling surface
// `tasks/CHAR-8177/ticket.json` share the basename `ticket.json` and nothing
// else. Bare-basename containment tied every identifier on that line to the
// sibling. Generic filenames make the collision routine.

test('same basename under a different directory is not a sibling reference', () => {
  const SURF = 'tasks/CHAR-8177/ticket.json';
  const { root, tasksDir } = makeFixture({
    briefContent: [
      '# Brief',
      '',
      '## Constraints',
      '- This ticket reads `tasks/CHAR-8178/ticket.json` to resolve `relatedTo`.',
      '',
    ].join('\n'),
    specContent: null,
    surfaceFilePath: SURF,
    surfaceFileContent: '{"id":"CHAR-8177"}\n',
  });
  const manifest = { worktreeRoot: root, relatedTo: [{ id: 'CHAR-8177', surfaces: [SURF] }] };
  const { errors, warnings } = surfaceAudit.auditArtifacts(tasksDir, manifest);
  assert.deepEqual(errors, [], `different directory must not block, got: ${JSON.stringify(errors)}`);
  assert.ok(
    warnings.some((w) => w.includes('relatedTo')),
    `expected a non-blocking warning, got: ${JSON.stringify(warnings)}`
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('the sibling path itself still BLOCKS (attribution keeps its teeth)', () => {
  const SURF = 'tasks/CHAR-8177/ticket.json';
  const { root, tasksDir } = makeFixture({
    briefContent: [
      '# Brief',
      '',
      '## Constraints',
      `- Read \`${SURF}\` to resolve \`relatedTo\`.`,
      '',
    ].join('\n'),
    specContent: null,
    surfaceFilePath: SURF,
    surfaceFileContent: '{"id":"CHAR-8177"}\n',
  });
  const manifest = { worktreeRoot: root, relatedTo: [{ id: 'CHAR-8177', surfaces: [SURF] }] };
  const { errors } = surfaceAudit.auditArtifacts(tasksDir, manifest);
  assert.ok(
    errors.some((e) => e.includes('relatedTo') && e.includes(SURF)),
    `expected a blocking error naming the sibling surface, got: ${JSON.stringify(errors)}`
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('lineRefersToFile: suffix alignment, globs, and near-misses', () => {
  const f = surfaceAudit.lineRefersToFile;
  assert.equal(f('see `lib/explore/explore.schemas.ts` here', 'lib/explore/explore.schemas.ts'), true);
  assert.equal(f('see `explore.schemas.ts` here', 'lib/explore/explore.schemas.ts'), true);
  assert.equal(f('see `other/explore.schemas.ts`', 'lib/explore/explore.schemas.ts'), false);
  assert.equal(f('tasks/CHAR-8178/ticket.json', 'tasks/CHAR-8177/ticket.json'), false);
  assert.equal(f('`components/pulse/pulse-content/row.tsx`', 'components/pulse/pulse-content/**'), true);
  assert.equal(f('`components/other/row.tsx`', 'components/pulse/pulse-content/**'), false);
  assert.equal(f('**Goal:** expose the row', 'components/pulse/pulse-content/**'), false);
});
