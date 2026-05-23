// GH-286 Task 8 — Skill doc wiring for follow-up-pr agent loop.
// Asserts scripts/workflows/work/skills/follow-up-pr.md documents:
//   - per-comment verifyComment invocation
//   - the new disposition vocabulary (R5)
//   - the iteration cap env var (R1)
//   - the batch-fix-then-push discipline (R6)
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SKILL_PATH = path.resolve(
  __dirname,
  '..',
  'skills',
  'follow-up-pr.md'
);

function readSkill() {
  // realpath resolves the symlink target so a broken symlink fails loudly.
  const real = fs.realpathSync(SKILL_PATH);
  return fs.readFileSync(real, 'utf8');
}

describe('scripts/workflows/work/skills/follow-up-pr.md (GH-286 Task 8)', () => {
  it('skill file (or its symlink target) exists and is readable', () => {
    assert.doesNotThrow(() => readSkill(), 'follow-up-pr.md must resolve to a real file');
  });

  it('documents per-comment verifyComment invocation', () => {
    const text = readSkill();
    assert.match(text, /verifyComment/, 'mentions verifyComment API');
  });

  it('documents new disposition vocabulary (R5)', () => {
    const text = readSkill();
    assert.match(text, /RESOLVED_BY_CODE_CHANGE/, 'mentions RESOLVED_BY_CODE_CHANGE');
    assert.match(text, /STILL_BLOCKING/, 'mentions STILL_BLOCKING');
    assert.match(text, /DEFERRED_TO_HUMAN/, 'mentions DEFERRED_TO_HUMAN');
    assert.match(text, /NOT_APPLICABLE/, 'mentions NOT_APPLICABLE');
    assert.match(text, /RESOLVED_BY_AGENT/, 'mentions RESOLVED_BY_AGENT');
  });

  it('documents iteration cap env var FOLLOW_UP_PR_MAX_ROUNDS', () => {
    const text = readSkill();
    assert.match(text, /FOLLOW_UP_PR_MAX_ROUNDS/, 'mentions FOLLOW_UP_PR_MAX_ROUNDS');
  });

  it('documents batch-fix-then-push discipline (one push per round)', () => {
    const text = readSkill();
    assert.match(
      text,
      /batch[- ]fix[- ]then[- ]push/i,
      'mentions batch-fix-then-push discipline'
    );
    assert.match(text, /one push per round/i, 'states one push per round');
  });

  it('documents bot reviewer dismissal + final-gate re-request', () => {
    const text = readSkill();
    assert.match(text, /dismiss/i, 'mentions dismissal behavior');
    assert.match(text, /re-?request/i, 'mentions re-request on final gate');
  });

  it('documents the Tier 2 LLM verify opt-in flag', () => {
    const text = readSkill();
    assert.match(text, /FOLLOW_UP_PR_ENABLE_LLM_VERIFY/, 'mentions LLM verify flag');
  });
});
