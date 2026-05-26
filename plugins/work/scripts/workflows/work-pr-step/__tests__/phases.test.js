'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const descDraft = require('../lib/phases/description_draft');
const validateDesc = require('../lib/phases/validate_description');
const createOrUpdate = require('../lib/phases/create_or_update');
const attachments = require('../lib/phases/attachments');

function mk(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-step-'));
  const tasksDir = path.join(root, 'ECHO-X');
  fs.mkdirSync(tasksDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    if (name.includes('/')) {
      fs.mkdirSync(path.join(tasksDir, path.dirname(name)), { recursive: true });
    }
    fs.writeFileSync(path.join(tasksDir, name), content);
  }
  return { root, tasksDir };
}

test('description_draft blocks when pr-body.md is missing', () => {
  const { root, tasksDir } = mk({});
  const r = descDraft.validate({ tasksDir });
  assert.equal(r.ok, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('description_draft passes when pr-body.md has substantial content', () => {
  const { root, tasksDir } = mk({
    'pr-body.md':
      '## Summary\n\nThis PR does X to fix Y. Details below.\n\n## Test plan\n\n- run pnpm test\n',
  });
  const r = descDraft.validate({ tasksDir });
  assert.equal(r.ok, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('validate_description blocks when Summary or Test plan missing', () => {
  const { root, tasksDir } = mk({
    'pr-body.md': '## Notes\n\nThis is not a summary.\n',
  });
  const r = validateDesc.validate({ tasksDir });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /Summary/.test(e)));
  fs.rmSync(root, { recursive: true, force: true });
});

test('validate_description requires Screenshots section when diff touches UI', () => {
  const { root, tasksDir } = mk({
    'pr-body.md': '## Summary\n\nfoo\n\n## Test plan\n\n- ok\n',
    'pr-context.json': JSON.stringify({ files: ['components/Foo.tsx'] }),
  });
  const r = validateDesc.validate({ tasksDir });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /Screenshots/.test(e)));
  fs.rmSync(root, { recursive: true, force: true });
});

test('validate_description passes when all required sections present', () => {
  const { root, tasksDir } = mk({
    'pr-body.md':
      '## Summary\n\nfoo\n\n## Test plan\n\n- ok\n\n## Screenshots\n\n[needs screenshots]\n',
    'pr-context.json': JSON.stringify({ files: ['components/Foo.tsx'] }),
  });
  const r = validateDesc.validate({ tasksDir });
  assert.equal(r.ok, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('create_or_update blocks when prNumber missing from context', () => {
  const { root, tasksDir } = mk({
    'pr-context.json': JSON.stringify({ files: ['a.ts'] }),
  });
  const r = createOrUpdate.validate({ tasksDir });
  assert.equal(r.ok, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('create_or_update passes when prNumber is set', () => {
  const { root, tasksDir } = mk({
    'pr-context.json': JSON.stringify({ files: ['a.ts'], prNumber: 1234 }),
  });
  const r = createOrUpdate.validate({ tasksDir });
  assert.equal(r.ok, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('attachments auto-passes when no QA artifacts exist', () => {
  const { root, tasksDir } = mk({ 'pr-body.md': '## Summary\n\nx\n' });
  const r = attachments.validate({ tasksDir });
  assert.equal(r.ok, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('attachments BLOCKS when screenshots exist but pr-body.md does not reference them', () => {
  const { root, tasksDir } = mk({
    'pr-body.md': '## Summary\n\nfoo (no mention of attachments)\n',
    'screenshots/img1.png': 'fakebytes',
  });
  const r = attachments.validate({ tasksDir });
  assert.equal(r.ok, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('attachments passes when pr-body.md references screenshots', () => {
  const { root, tasksDir } = mk({
    'pr-body.md': '## Summary\n\nfoo\n\n## Screenshots\n\nSee `screenshots/img1.png`.\n',
    'screenshots/img1.png': 'fakebytes',
  });
  const r = attachments.validate({ tasksDir });
  assert.equal(r.ok, true);
  fs.rmSync(root, { recursive: true, force: true });
});
