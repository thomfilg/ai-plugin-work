const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SKILL_PATH = path.resolve(__dirname, '../../..', 'skills/work/SKILL.md');
const content = fs.readFileSync(SKILL_PATH, 'utf8');

describe('SKILL.md task_review documentation', () => {
  it('state machine happy path includes task_review between commit and check', () => {
    // The happy path line should contain commit→task_review→check
    const happyPathMatch = content.match(/Happy path:.*ticket.*complete/);
    assert.ok(happyPathMatch, 'Happy path line must exist');
    assert.ok(
      happyPathMatch[0].includes('commit→task_review→check'),
      `Happy path must include commit→task_review→check, got: ${happyPathMatch[0]}`
    );
  });

  it('task loop includes task_review→implement for review failures', () => {
    assert.ok(
      content.includes('task_review → implement'),
      'Must have task_review → implement edge for review failures'
    );
  });

  it('task loop includes task_review→check for review passed', () => {
    // task_review → check means review passed, proceed
    assert.ok(
      content.includes('task_review → check'),
      'Must have task_review → check edge for review passed'
    );
  });

  it('delegation reference table includes task_review row', () => {
    // Should have a row like: | task_review | skill | ...
    const tableMatch = content.match(/\|\s*`?task_review`?\s*\|.*\|.*\|/);
    assert.ok(tableMatch, 'Delegation table must have a task_review row');
    assert.ok(
      tableMatch[0].includes('skill'),
      `task_review row must use agentType "skill", got: ${tableMatch[0]}`
    );
  });

  it('Rule 10 references task_review in the task cycle', () => {
    // Rule 10 should mention implement → commit → task_review → check
    const rule10Match = content.match(/implement ONE task per[^.]+/);
    assert.ok(rule10Match, 'Rule 10 must exist with "implement ONE task per"');
    assert.ok(
      rule10Match[0].includes('task_review'),
      `Rule 10 cycle must mention task_review, got: ${rule10Match[0]}`
    );
  });
});
