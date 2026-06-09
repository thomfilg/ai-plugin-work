'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '../../../../../../../..');
const AGENT_PROMPT = path.join(REPO_ROOT, 'plugins/work/agents/pr-post-generator.md');
const WORKFLOW_COPY = path.join(
  REPO_ROOT,
  'plugins/work/scripts/workflows/work-pr/agents/pr-post-generator/pr-post-generator.md'
);

function readResolved(filePath) {
  // fs.readFileSync follows symlinks atomically — no separate stat/readlink
  // step (avoids TOCTOU race flagged by CodeQL).
  return fs.readFileSync(filePath, 'utf8');
}

describe('agent prompt — FABRICATION GUARD', () => {
  test('Agent prompt edits prevent regeneration of fabricated content', () => {
    const content = readResolved(AGENT_PROMPT);
    // The agent prompt must contain the FABRICATION GUARD section, a pending
    // example row, and an explicit prohibition of 10/10 or N/N stability
    // phrasing. Together these prevent the agent from regenerating fabricated
    // test-evidence content.
    assert.match(content, /FABRICATION GUARD/, 'missing FABRICATION GUARD');
    assert.match(content, /\|\s*[^|]+\|\s*pending\s*\|/i, 'missing pending example row');
    const hasProhibition = /10\/10/.test(content) || /N\/N\s+stability/i.test(content);
    assert.ok(hasProhibition, 'missing prohibition of 10/10 or N/N stability phrasing');
    // R16 — workflow-referenced copy must mirror the same content.
    assert.ok(fs.existsSync(WORKFLOW_COPY), 'workflow copy must exist (currently broken symlink)');
    assert.match(
      readResolved(WORKFLOW_COPY),
      /FABRICATION GUARD/,
      'workflow copy missing FABRICATION GUARD'
    );
  });

  test('AC6/R1 — pr-post-generator.md contains FABRICATION GUARD section', () => {
    const content = readResolved(AGENT_PROMPT);
    assert.match(
      content,
      /FABRICATION GUARD/,
      'agent prompt must contain FABRICATION GUARD section'
    );
  });

  test('AC6/R1 — pr-post-generator.md contains a pending example row', () => {
    const content = readResolved(AGENT_PROMPT);
    assert.match(
      content,
      /\|\s*[^|]+\|\s*pending\s*\|/i,
      'agent prompt must include a pending example row demonstrating the correct rewrite'
    );
  });

  test('AC6/R2 — pr-post-generator.md prohibits 10/10 or N/N stability phrasing', () => {
    const content = readResolved(AGENT_PROMPT);
    const hasProhibition = /10\/10/.test(content) || /N\/N\s+stability/i.test(content);
    assert.ok(
      hasProhibition,
      'agent prompt must explicitly prohibit 10/10 or N/N stability phrasing'
    );
  });

  test('R16 — workflow-referenced copy resolves and contains FABRICATION GUARD', () => {
    // File must exist (currently broken symlink) and resolve to content
    assert.ok(
      fs.existsSync(WORKFLOW_COPY),
      `workflow copy must exist at ${WORKFLOW_COPY} (currently a broken symlink)`
    );
    const content = readResolved(WORKFLOW_COPY);
    assert.match(
      content,
      /FABRICATION GUARD/,
      'workflow copy must contain FABRICATION GUARD section (R16)'
    );
  });
});
