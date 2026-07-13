// Tests for agents/code-architect.md — hardened prompt with specificity
// constraints and anti-overengineering guards.
//
// Discovered by scripts/run-tests.sh which searches: scripts/workflows/, agents/, skills/
// Manual: node --test agents/__tests__/code-architect.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const AGENT_PATH = path.resolve(__dirname, '..', 'code-architect.md');
const content = fs.readFileSync(AGENT_PATH, 'utf-8');
const lines = content.split('\n');

// ─── Helper: extract YAML frontmatter ────────────────────────────────────────

function parseFrontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fm = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) {
      fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  return fm;
}

const frontmatter = parseFrontmatter(content);

// ─── 1. Frontmatter unchanged ────────────────────────────────────────────────

describe('Frontmatter fields are unchanged', () => {
  it('name is code-architect', () => {
    assert.equal(frontmatter.name, 'code-architect');
  });

  it('tools list is preserved', () => {
    assert.equal(
      frontmatter.tools,
      'Glob, Grep, LS, Read, NotebookRead, WebFetch, TodoWrite, WebSearch, KillShell, BashOutput'
    );
  });

  it('description is preserved', () => {
    assert.ok(frontmatter.description.startsWith('Designs feature architectures'));
  });

  it('model is opus', () => {
    assert.equal(frontmatter.model, 'opus');
  });

  it('color is blue', () => {
    assert.equal(frontmatter.color, 'blue');
  });
});

// ─── 2. Pattern Anchoring section exists after Working Principles ────────────

describe('Pattern Anchoring section', () => {
  it('exists in the document', () => {
    assert.ok(content.includes('### Pattern Anchoring'));
  });

  it('appears after Working Principles', () => {
    const wpIdx = content.indexOf('### Working Principles');
    const paIdx = content.indexOf('### Pattern Anchoring');
    assert.ok(wpIdx > -1 && paIdx > -1);
    assert.ok(paIdx > wpIdx, 'Pattern Anchoring must come after Working Principles');
  });

  it('appears before Output Format', () => {
    const paIdx = content.indexOf('### Pattern Anchoring');
    const ofIdx = content.indexOf('### Output Format');
    assert.ok(paIdx < ofIdx, 'Pattern Anchoring must come before Output Format');
  });
});

// ─── 3. Simplicity Constraint section exists after Pattern Anchoring ─────────

describe('Simplicity Constraint section', () => {
  it('exists in the document', () => {
    assert.ok(content.includes('### Simplicity Constraint'));
  });

  it('appears after Pattern Anchoring', () => {
    const paIdx = content.indexOf('### Pattern Anchoring');
    const scIdx = content.indexOf('### Simplicity Constraint');
    assert.ok(scIdx > paIdx, 'Simplicity Constraint must come after Pattern Anchoring');
  });

  it('mentions "Extending existing modules"', () => {
    assert.ok(content.includes('Extending existing modules'));
  });

  it('mentions "explicit justification"', () => {
    assert.ok(content.includes('explicit justification'));
  });
});

// ─── 4. Strict Specificity Rule section exists after Simplicity Constraint ───

describe('Strict Specificity Rule section', () => {
  it('exists in the document', () => {
    assert.ok(content.includes('### Strict Specificity Rule'));
  });

  it('appears after Simplicity Constraint', () => {
    const scIdx = content.indexOf('### Simplicity Constraint');
    const ssIdx = content.indexOf('### Strict Specificity Rule');
    assert.ok(ssIdx > scIdx, 'Strict Specificity Rule must come after Simplicity Constraint');
  });

  it('contains banned terms list', () => {
    const banned = [
      'handle logic',
      'manage state',
      'connect components',
      'process data',
      'coordinate between',
      'consider',
      'could',
      'might',
      'optionally',
    ];
    for (const term of banned) {
      assert.ok(
        content.includes(`"${term}"`),
        `Banned term "${term}" must appear in Strict Specificity Rule`
      );
    }
  });
});

// ─── 5. Role Boundary section exists after CRITICAL: NEVER CALL YOURSELF ─────

describe('Role Boundary section', () => {
  it('exists in the document', () => {
    assert.ok(content.includes('## Role Boundary'));
  });

  it('appears after CRITICAL: NEVER CALL YOURSELF', () => {
    const critIdx = content.indexOf('## CRITICAL: NEVER CALL YOURSELF');
    const rbIdx = content.indexOf('## Role Boundary');
    assert.ok(rbIdx > critIdx, 'Role Boundary must come after CRITICAL section');
  });

  it('appears before Core Capabilities', () => {
    const rbIdx = content.indexOf('## Role Boundary');
    const ccIdx = content.indexOf('### Core Capabilities');
    assert.ok(rbIdx < ccIdx, 'Role Boundary must come before Core Capabilities');
  });
});

// ─── 6. Working Principles #1 enhanced ───────────────────────────────────────

describe('Working Principles #1 enhancement', () => {
  it('contains "list" and "files" and "inspected" and "line range"', () => {
    // Find the line with principle #1
    const wp1Line = lines.find((l) => l.match(/^1\.\s+\*\*Analyze First/));
    assert.ok(wp1Line, 'Working Principles #1 must exist');
    assert.ok(wp1Line.includes('list'), '#1 must contain "list"');
    assert.ok(wp1Line.includes('files'), '#1 must contain "files"');
    assert.ok(wp1Line.includes('inspected'), '#1 must contain "inspected"');
    assert.ok(wp1Line.includes('line range'), '#1 must contain "line range"');
  });
});

// ─── 7. Working Principles #4 enhanced ───────────────────────────────────────

describe('Working Principles #4 enhancement', () => {
  it('contains "BEFORE" and "AFTER" and "breaking changes"', () => {
    const wp4Line = lines.find((l) => l.match(/^4\.\s+\*\*Map Dependencies/));
    assert.ok(wp4Line, 'Working Principles #4 must exist');
    assert.ok(wp4Line.includes('BEFORE'), '#4 must contain "BEFORE"');
    assert.ok(wp4Line.includes('AFTER'), '#4 must contain "AFTER"');
    assert.ok(wp4Line.includes('breaking changes'), '#4 must contain "breaking changes"');
  });
});

// ─── 8. Output Format item 2 is "Existing Patterns" ─────────────────────────

describe('Output Format item 2', () => {
  it('is "Existing Patterns"', () => {
    const of2Line = lines.find((l) => l.match(/^2\.\s+\*\*Existing Patterns\*\*/));
    assert.ok(of2Line, 'Output Format item 2 must be "Existing Patterns"');
  });

  it('Output Format has 9 items total', () => {
    // Find numbered items only within the "### Output Format" section
    const ofIdx = lines.findIndex((l) => l.includes('### Output Format'));
    assert.ok(ofIdx > -1);
    const nextHeadingOffset = lines.slice(ofIdx + 1).findIndex((l) => l.match(/^###\s+/));
    const sectionEnd = nextHeadingOffset === -1 ? lines.length : ofIdx + 1 + nextHeadingOffset;
    const ofItems = lines.slice(ofIdx, sectionEnd).filter((l) => l.match(/^\d+\.\s+\*\*/));
    assert.equal(ofItems.length, 9, 'Output Format should have 9 items');
  });
});

// ─── 9. Strict Specificity Rule banned terms ─────────────────────────────────
// (covered in test 4 above)

// ─── 10. Simplicity Constraint content ───────────────────────────────────────
// (covered in test 3 above)
