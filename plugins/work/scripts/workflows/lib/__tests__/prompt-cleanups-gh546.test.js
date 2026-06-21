/**
 * GH-590 Task 15 — Authoring docs + prompt cleanups (GH-546 fold-in).
 *
 * Asserts that:
 *   (a) `pnpm dev:check` does NOT appear in the four prompt files named in AC18
 *       - plugins/work/agents/quality-checker.md
 *       - plugins/work/agents/pr-generator.md
 *       - plugins/work/skills/work-implement/SKILL.md
 *       - plugins/work/skills/split-in-tasks/docs/decomposition-rules.md
 *   (b) plugins/work/skills/split-in-tasks/docs/test-strategy.md EXISTS and
 *       mentions all five `kind:` values (unit, integration, e2e, custom,
 *       verified-by).
 *   (c) plugins/work/skills/split-in-tasks/docs/test-command.md does NOT exist
 *       (folded into test-strategy.md).
 *   (d) plugins/work/docs/test-strategy-kinds.md (P2.2 short explainer) EXISTS
 *       and mentions all five `kind:` values.
 *
 * Run: node --test scripts/workflows/lib/__tests__/prompt-cleanups-gh546.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Repo root is four levels up from this test file:
//   plugins/work/scripts/workflows/lib/__tests__/  → repo root
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..', '..');

function repoPath(rel) {
  return path.join(REPO_ROOT, rel);
}

function readIfExists(rel) {
  const abs = repoPath(rel);
  if (!fs.existsSync(abs)) return null;
  return fs.readFileSync(abs, 'utf8');
}

const AC18_PROMPT_FILES = [
  'plugins/work/agents/quality-checker.md',
  'plugins/work/agents/pr-generator.md',
  'plugins/work/skills/work-implement/SKILL.md',
  'plugins/work/skills/split-in-tasks/docs/decomposition-rules.md',
];

const FIVE_KINDS = ['unit', 'integration', 'e2e', 'custom', 'verified-by'];

test('AC18: pnpm dev:check is stripped from all four prompt files', () => {
  for (const rel of AC18_PROMPT_FILES) {
    const content = readIfExists(rel);
    assert.ok(content !== null, `expected prompt file to exist: ${rel}`);
    assert.ok(
      !/pnpm\s+dev:check/.test(content),
      `${rel} still contains "pnpm dev:check" — strip per AC18`,
    );
  }
});

test('AC1: skills/split-in-tasks/docs/test-strategy.md exists and mentions all five kinds', () => {
  const rel = 'plugins/work/skills/split-in-tasks/docs/test-strategy.md';
  const content = readIfExists(rel);
  assert.ok(content !== null, `expected ${rel} to exist`);
  for (const kind of FIVE_KINDS) {
    assert.ok(
      content.includes(kind),
      `${rel} must mention kind "${kind}"`,
    );
  }
});

test('AC1: skills/split-in-tasks/docs/test-command.md is deleted (folded into test-strategy.md)', () => {
  const rel = 'plugins/work/skills/split-in-tasks/docs/test-command.md';
  const abs = repoPath(rel);
  assert.ok(
    !fs.existsSync(abs),
    `${rel} must be deleted (folded into test-strategy.md)`,
  );
});

test('P2.2: docs/test-strategy-kinds.md explainer exists and mentions all five kinds', () => {
  const rel = 'plugins/work/docs/test-strategy-kinds.md';
  const content = readIfExists(rel);
  assert.ok(content !== null, `expected ${rel} to exist`);
  for (const kind of FIVE_KINDS) {
    assert.ok(
      content.includes(kind),
      `${rel} must mention kind "${kind}"`,
    );
  }
});
