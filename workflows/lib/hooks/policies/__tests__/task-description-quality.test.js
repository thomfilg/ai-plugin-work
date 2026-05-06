/**
 * Tests for policies/task-description-quality.js
 *
 * Run: node --test workflows/lib/hooks/policies/__tests__/task-description-quality.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { validateTaskDescriptions, getBlockedPatterns } = require('../task-description-quality');

/**
 * Build a minimal tasks.md content wrapping test content in proper Task sections.
 * @param {number} taskNum
 * @param {string} description
 * @param {string} [deliverables]
 * @returns {string}
 */
function buildTaskContent(taskNum, description, deliverables) {
  let content = `## Task ${taskNum} — Test Task\n\n### Description\n${description}\n`;
  if (deliverables) {
    content += `\n### Deliverables\n${deliverables}\n`;
  }
  return content;
}

// ---------------------------------------------------------------------------
// validateTaskDescriptions — blocking patterns
// ---------------------------------------------------------------------------

describe('validateTaskDescriptions: blocking patterns', () => {
  it('blocks literal placeholder "TBD" in task description', () => {
    const content = '## Task 1 — TBD\n### Description\nTBD';
    const result = validateTaskDescriptions(content);

    assert.equal(result.blocked, true);
    assert.ok(result.violations.length >= 1);

    const v = result.violations.find((v) => v.task.includes('1'));
    assert.ok(v, 'violation should identify Task 1');
    assert.ok(v.pattern.includes('TBD'), 'pattern should mention TBD');
    assert.ok(v.hint.length > 0, 'hint should suggest expanding the placeholder');
  });

  it('blocks "TODO" case-insensitively', () => {
    const content = buildTaskContent(1, 'todo: figure this out later');
    const result = validateTaskDescriptions(content);

    assert.equal(result.blocked, true);
    assert.ok(result.violations.length >= 1);

    const v = result.violations[0];
    assert.ok(v.pattern.toUpperCase().includes('TODO'), 'pattern label should match TODO');
  });

  it('blocks unqualified "Handle edge cases"', () => {
    const content = buildTaskContent(1, 'Core implementation', '- Handle edge cases');
    const result = validateTaskDescriptions(content);

    assert.equal(result.blocked, true);
    assert.ok(result.violations.length >= 1);

    const v = result.violations[0];
    assert.ok(
      v.hint.toLowerCase().includes('edge case'),
      'hint should suggest specifying which edge cases'
    );
  });

  it('blocks "Similar to Task N" cross-references', () => {
    const content = buildTaskContent(2, 'Implement feature', '- Similar to Task 2');
    const result = validateTaskDescriptions(content);

    assert.equal(result.blocked, true);
    assert.ok(result.violations.length >= 1);

    const v = result.violations[0];
    assert.ok(
      v.hint.toLowerCase().includes('repeat') || v.hint.toLowerCase().includes('actual'),
      'hint should suggest repeating the actual steps'
    );
  });

  it('blocks "Same as Task N" cross-references', () => {
    const content = buildTaskContent(2, 'Implement feature', '- Same as Task 1');
    const result = validateTaskDescriptions(content);
    assert.equal(result.blocked, true);
    assert.ok(result.violations.length >= 1);
    const v = result.violations[0];
    assert.ok(
      v.hint.toLowerCase().includes('repeat') || v.hint.toLowerCase().includes('actual'),
      'hint should suggest repeating the actual steps'
    );
  });

  it('blocks "tbd" lowercase variant (case-insensitive)', () => {
    const content = buildTaskContent(1, 'tbd');
    const result = validateTaskDescriptions(content);
    assert.equal(result.blocked, true);
  });

  it('blocks "Add appropriate error handling" without specifics', () => {
    const content = buildTaskContent(1, 'Build parser', '- Add appropriate error handling');
    const result = validateTaskDescriptions(content);

    assert.equal(result.blocked, true);
    assert.ok(result.violations.length >= 1);

    const v = result.violations[0];
    assert.ok(
      v.hint.toLowerCase().includes('error') || v.hint.toLowerCase().includes('specif'),
      'hint should suggest specifying error types and handling strategy'
    );
  });

  it('blocks "Add tests" without specifying scenarios', () => {
    const content = buildTaskContent(1, 'Implement module', '- Add tests');
    const result = validateTaskDescriptions(content);

    assert.equal(result.blocked, true);
    assert.ok(result.violations.length >= 1);

    const v = result.violations[0];
    assert.ok(
      v.hint.toLowerCase().includes('scenario') || v.hint.toLowerCase().includes('test'),
      'hint should suggest listing specific test scenarios'
    );
  });

  it('blocks standalone "implement later"', () => {
    const content = buildTaskContent(1, 'implement later');
    const result = validateTaskDescriptions(content);

    assert.equal(result.blocked, true);
    assert.ok(result.violations.length >= 1);
  });

  it('blocks "to be determined"', () => {
    const content = buildTaskContent(1, 'to be determined');
    const result = validateTaskDescriptions(content);

    assert.equal(result.blocked, true);
    assert.ok(result.violations.length >= 1);
  });

  it('blocks "to be determined" even with qualifying detail after it (non-qualifiable)', () => {
    const content = buildTaskContent(
      1,
      'to be determined once the spec is reviewed and the architecture is finalized'
    );
    const result = validateTaskDescriptions(content);

    assert.equal(
      result.blocked,
      true,
      '"to be determined" is a pure deferral and must always block'
    );
    assert.ok(result.violations.length >= 1);
    const v = result.violations[0];
    assert.equal(v.pattern, 'to be determined');
  });
});

// ---------------------------------------------------------------------------
// validateTaskDescriptions — false-positive avoidance
// ---------------------------------------------------------------------------

describe('validateTaskDescriptions: false-positive avoidance', () => {
  it('allows qualified edge case description', () => {
    const content = buildTaskContent(
      1,
      'Handle the edge case where user ID is null by returning a 400 error'
    );
    const result = validateTaskDescriptions(content);

    assert.equal(result.blocked, false);
  });

  it('allows specific error handling description', () => {
    const content = buildTaskContent(
      1,
      'Implementation details',
      '- Add error handling for network timeouts by retrying with exponential backoff, max 3 retries'
    );
    const result = validateTaskDescriptions(content);

    assert.equal(result.blocked, false);
  });

  it('allows "implement later" as substring in a qualified sentence', () => {
    const content = buildTaskContent(
      1,
      'Do not implement later phases in this task; only implement the parser'
    );
    const result = validateTaskDescriptions(content);

    assert.equal(result.blocked, false);
  });

  it('does not flag TDD prefix "**RED:** Add tests for validation edge cases"', () => {
    const content = buildTaskContent(
      1,
      'Implement parser',
      '- **RED:** Add tests for validation edge cases'
    );
    const result = validateTaskDescriptions(content);

    assert.equal(result.blocked, false);
  });

  it('does not flag TDD prefix with checkbox and task number "- [ ] 1.1.1 **RED:** Add tests"', () => {
    const content = buildTaskContent(1, 'Implement auth module', '- [ ] 1.1.1 **RED:** Add tests');
    const result = validateTaskDescriptions(content);

    assert.equal(result.blocked, false, 'checkbox-prefixed TDD lines should be exempt');
  });

  it('does not flag TDD prefix with checked checkbox "- [x] 2.3 **GREEN:** Add error handling"', () => {
    const content = buildTaskContent(
      1,
      'Implement timeout handler',
      '- [x] 2.3 **GREEN:** Add error handling'
    );
    const result = validateTaskDescriptions(content);

    assert.equal(result.blocked, false, 'checked checkbox TDD lines should be exempt');
  });

  it('does not scan Requirement Coverage table', () => {
    const taskContent = buildTaskContent(1, 'Implement the parser with full error handling');
    const coverageTable =
      '\n## Requirement Coverage\n\n| Requirement | Covered By |\n|---|---|\n| R1 | Task 1, Task 2 |\n| R2 | Task 3 |\n';
    const content = taskContent + coverageTable;
    const result = validateTaskDescriptions(content);

    assert.equal(result.blocked, false);
  });
});

// ---------------------------------------------------------------------------
// validateTaskDescriptions — multi-violation reporting
// ---------------------------------------------------------------------------

describe('validateTaskDescriptions: deduplication', () => {
  it('emits only one violation per (task, pattern) pair even when pattern appears on multiple lines', () => {
    // TBD appears in both the header line and the description body
    const content = '## Task 1 — TBD\n### Description\nTBD\n';
    const result = validateTaskDescriptions(content);

    assert.equal(result.blocked, true);
    // Count how many TBD violations exist for Task 1
    const tbdViolations = result.violations.filter(
      (v) => v.task === 'Task 1' && v.pattern === 'TBD'
    );
    assert.equal(
      tbdViolations.length,
      1,
      `expected exactly 1 TBD violation for Task 1, got ${tbdViolations.length}`
    );
  });

  it('still reports distinct patterns in the same task', () => {
    // Task has both TBD and TODO — these are different patterns, both should be reported
    const content = '## Task 1 — TBD\n### Description\ntodo: figure it out\n';
    const result = validateTaskDescriptions(content);

    assert.equal(result.blocked, true);
    assert.equal(result.violations.length, 2, 'should report TBD and TODO as separate violations');
    const labels = result.violations.map((v) => v.pattern);
    assert.ok(labels.includes('TBD'), 'should include TBD');
    assert.ok(labels.includes('TODO'), 'should include TODO');
  });

  it('deduplicates across header and body for same pattern', () => {
    // "implement later" in header and body
    const content = '## Task 1 — implement later\n### Description\nWe will implement later\n';
    const result = validateTaskDescriptions(content);

    assert.equal(result.blocked, true);
    const implLaterViolations = result.violations.filter(
      (v) => v.task === 'Task 1' && v.pattern === 'implement later'
    );
    assert.equal(
      implLaterViolations.length,
      1,
      `expected exactly 1 "implement later" violation for Task 1, got ${implLaterViolations.length}`
    );
  });
});

describe('validateTaskDescriptions: multi-violation reporting', () => {
  it('reports multiple violations with task numbers', () => {
    const content =
      '## Task 1 — TBD\n### Description\nTBD\n\n## Task 2 — Good Task\n### Description\nFully specified implementation with details\n\n## Task 3 — Edge Cases\n### Description\nCore work\n### Deliverables\n- Handle edge cases\n';
    const result = validateTaskDescriptions(content);

    assert.equal(result.blocked, true);
    assert.ok(result.violations.length >= 2, 'should report at least 2 violations');

    const taskNums = result.violations.map((v) => v.task);
    assert.ok(
      taskNums.some((t) => t.includes('1')),
      'should identify Task 1'
    );
    assert.ok(
      taskNums.some((t) => t.includes('3')),
      'should identify Task 3'
    );

    for (const v of result.violations) {
      assert.ok(v.task, 'each violation must have task');
      assert.ok(v.pattern, 'each violation must have pattern');
      assert.ok(v.hint, 'each violation must have hint');
    }
  });
});

// ---------------------------------------------------------------------------
// extractTaskSections — Extracted Requirements before Task sections
// ---------------------------------------------------------------------------

describe('validateTaskDescriptions: Extracted Requirements precedes tasks', () => {
  it('scans task sections even when preceded by Extracted Requirements', () => {
    const content = [
      '# Tasks',
      '',
      '## Extracted Requirements',
      '- R1 — some requirement',
      '',
      '---',
      '',
      '## Task 1 — Test Task',
      '',
      '### Description',
      'TBD',
      '',
    ].join('\n');
    const result = validateTaskDescriptions(content);
    assert.equal(result.blocked, true, 'Should detect TBD in task after Extracted Requirements');
  });
});

// ---------------------------------------------------------------------------
// contentGuard integration placeholder
// ---------------------------------------------------------------------------

describe('validateTaskDescriptions: contentGuard integration', () => {
  it('policy function is callable from protect-artifact-files context', () => {
    // This is a placeholder verifying the policy function can be called
    // with the same signature the contentGuard adapter would use.
    const content = buildTaskContent(1, 'Fully specified task with concrete details');
    const result = validateTaskDescriptions(content);

    assert.equal(typeof result.blocked, 'boolean');
    assert.equal(result.blocked, false);
  });
});

// ---------------------------------------------------------------------------
// getBlockedPatterns
// ---------------------------------------------------------------------------

describe('getBlockedPatterns', () => {
  it('returns at least 6 patterns, each with RegExp, label, and hint', () => {
    const patterns = getBlockedPatterns();

    assert.ok(Array.isArray(patterns), 'should return an array');
    assert.ok(patterns.length >= 6, `should have at least 6 patterns, got ${patterns.length}`);

    for (const p of patterns) {
      assert.ok(p.pattern instanceof RegExp, `pattern should be a RegExp, got ${typeof p.pattern}`);
      assert.ok(
        typeof p.label === 'string' && p.label.length > 0,
        'label should be a non-empty string'
      );
      assert.ok(
        typeof p.hint === 'string' && p.hint.length > 0,
        'hint should be a non-empty string'
      );
    }
  });
});

// ---------------------------------------------------------------------------
// SKILL.md consolidation
// ---------------------------------------------------------------------------

describe('SKILL.md consolidation', () => {
  it('references task-description-quality as canonical source', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const skillPath = path.resolve(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      '..',
      'skills',
      'split-in-tasks',
      'SKILL.md'
    );
    const content = fs.readFileSync(skillPath, 'utf8');
    assert.ok(
      content.includes('task-description-quality'),
      'SKILL.md should reference task-description-quality policy'
    );
  });
});
