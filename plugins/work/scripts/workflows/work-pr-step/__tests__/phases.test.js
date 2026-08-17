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

// `worktreeRoot` points at the sandbox — outside any git repo — for the phases
// that fall back to `gh pr view`. Without it they would inherit the process cwd
// and could pick up THIS repo's real PR, making the assertion depend on whether
// `gh` happens to be installed and authenticated. See runner-owns-writes.test.js
// for the stubbed-`gh` coverage of those fallbacks.
test('description_draft blocks when pr-body.md is missing', () => {
  const { root, tasksDir } = mk({});
  const r = descDraft.validate({ tasksDir, worktreeRoot: root });
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

// ─── validate_description ↔ pr-generator template agreement ────────────────
// The gate used to demand `## Summary` + `## Test plan` literally, while the
// pr-generator's own TEMPLATE TO COMPLETE emits `## Existing Behavior` +
// `## Testing Plan / Demo`. `## Testing Plan / Demo` can never match
// `Test plan` ("Test" is followed by "ing", not whitespace), so the gate
// rejected every PR body the plugin's own template produced.

const PR_GENERATOR_MD = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'agents',
  'pr-generator.md'
);

/** The literal ```markdown block under `## TEMPLATE TO COMPLETE`. */
function prGeneratorTemplate() {
  const md = fs.readFileSync(PR_GENERATOR_MD, 'utf8');
  const m = md.match(/## TEMPLATE TO COMPLETE\n```markdown\n([\s\S]*?)\n```/);
  assert.ok(m, `could not locate the TEMPLATE TO COMPLETE block in ${PR_GENERATOR_MD}`);
  return m[1];
}

test('validate_description accepts the pr-generator template verbatim', () => {
  const { root, tasksDir } = mk({ 'pr-body.md': prGeneratorTemplate() });
  const r = validateDesc.validate({ tasksDir });
  assert.equal(r.ok, true, `template rejected: ${JSON.stringify(r.errors)}`);
  fs.rmSync(root, { recursive: true, force: true });
});

test('pr-generator template still emits the headings the gate accepts', () => {
  const tpl = prGeneratorTemplate();
  const headings = tpl.split('\n').filter((l) => /^## /.test(l));
  assert.ok(
    headings.includes('## Existing Behavior'),
    `template lost its overview heading: ${headings.join(' | ')}`
  );
  assert.ok(
    headings.includes('## Testing Plan / Demo'),
    `template lost its test-plan heading: ${headings.join(' | ')}`
  );
});

test('validate_description accepts `## Testing Plan / Demo` as the test plan', () => {
  const { root, tasksDir } = mk({
    'pr-body.md': '## Existing Behavior\n\nfoo\n\n## Testing Plan / Demo\n\n- run it\n',
  });
  const r = validateDesc.validate({ tasksDir });
  assert.equal(r.ok, true, `rejected: ${JSON.stringify(r.errors)}`);
  fs.rmSync(root, { recursive: true, force: true });
});

test('validate_description still blocks a body with neither spelling', () => {
  const { root, tasksDir } = mk({ 'pr-body.md': '## Notes\n\nnothing useful here.\n' });
  const r = validateDesc.validate({ tasksDir });
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 2);
  assert.ok(r.errors.some((e) => /Summary.*Existing Behavior/.test(e)));
  assert.ok(r.errors.some((e) => /Test plan.*Testing Plan/.test(e)));
  fs.rmSync(root, { recursive: true, force: true });
});

test('create_or_update blocks when prNumber missing from context', () => {
  const { root, tasksDir } = mk({
    'pr-context.json': JSON.stringify({ files: ['a.ts'] }),
  });
  const r = createOrUpdate.validate({ tasksDir, worktreeRoot: root });
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
