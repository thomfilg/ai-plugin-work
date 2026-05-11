// Tests for GH-323 — agent prompt hardening: red flags tables in developer
// agents, Verification Iron Law in quality agents, and testing anti-patterns
// reference file.
//
// Discovered by scripts/run-tests.sh which searches: scripts/workflows/, agents/, skills/
// Manual: node --test agents/__tests__/agent-prompt-hardening.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const AGENTS_DIR = path.resolve(__dirname, '..');
const ROOT_DIR = path.resolve(__dirname, '..', '..');

// ─── Agent file loaders ──────────────────────────────────────────────────────

/** Read agent file content by name. */
function readAgent(name) {
  return fs.readFileSync(path.join(AGENTS_DIR, `${name}.md`), 'utf-8');
}

/** Extract YAML frontmatter key-value pairs from markdown text. */
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

/**
 * Extract markdown table rows (excluding header row and separator row).
 * Returns an array of arrays, one per data row, with cell text trimmed.
 */
function extractTableRows(text, headerPattern) {
  const lines = text.split('\n');
  const headerIdx = lines.findIndex((l) => l.includes(headerPattern));
  if (headerIdx === -1) return [];

  const rows = [];
  // Skip header row (headerIdx) and separator row (headerIdx + 1)
  for (let i = headerIdx + 2; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('|')) break;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

// ─── Agent groups ────────────────────────────────────────────────────────────

const DEVELOPER_AGENTS = [
  'developer-nodejs-tdd',
  'developer-react-senior',
  'developer-react-ui-architect',
  'commit-writer',
];

// Only the three developer-* agents must cross-reference testing-anti-patterns.md (R10).
// commit-writer is a developer agent for red-flags purposes but not for cross-ref.
const CROSS_REF_AGENTS = [
  'developer-nodejs-tdd',
  'developer-react-senior',
  'developer-react-ui-architect',
];

const QUALITY_AGENTS = ['completion-checker', 'quality-checker', 'code-checker', 'pr-reviewer'];

const ALL_MODIFIED_AGENTS = [...DEVELOPER_AGENTS, ...QUALITY_AGENTS];

// Pre-load content and frontmatter for all agents under test.
const agentContent = Object.create(null);
const agentFrontmatter = Object.create(null);
for (const name of ALL_MODIFIED_AGENTS) {
  agentContent[name] = readAgent(name);
  agentFrontmatter[name] = parseFrontmatter(agentContent[name]);
}

// ─── 1. Red flags tables in developer agents ────────────────────────────────

describe('Red flags tables in developer agents', () => {
  const RED_FLAGS_HEADER = '| Red Flag';

  for (const agent of DEVELOPER_AGENTS) {
    it(`${agent} contains a red flags table`, () => {
      assert.ok(
        agentContent[agent].includes(RED_FLAGS_HEADER),
        `${agent}.md must contain a red flags table with header starting "| Red Flag"`
      );
    });

    it(`${agent} red flags table has at least 3 data rows`, () => {
      const rows = extractTableRows(agentContent[agent], RED_FLAGS_HEADER);
      assert.ok(
        rows.length >= 3,
        `${agent}.md red flags table must have >= 3 rows, found ${rows.length}`
      );
    });
  }

  it('all developer agents use consistent column headings', () => {
    const headingSets = [];
    for (const agent of DEVELOPER_AGENTS) {
      const lines = agentContent[agent].split('\n');
      const headerLine = lines.find((l) => l.includes(RED_FLAGS_HEADER));
      if (headerLine) headingSets.push(headerLine.trim());
    }
    // All agents that have the table should share the same header row
    assert.ok(headingSets.length > 0, 'At least one agent must have a red flags table');
    const unique = new Set(headingSets);
    assert.equal(
      unique.size,
      1,
      `All developer agents must use the same red flags column headings. Found: ${[...unique].join(' vs ')}`
    );
  });
});

// ─── 2. Verification Iron Law in quality agents ─────────────────────────────

describe('Verification Iron Law in quality agents', () => {
  const IRON_LAW_STEPS = ['IDENTIFY', 'RUN', 'READ', 'VERIFY', 'ONLY THEN'];

  for (const agent of QUALITY_AGENTS) {
    it(`${agent} contains Verification Iron Law section`, () => {
      assert.ok(
        agentContent[agent].includes('Verification Iron Law'),
        `${agent}.md must contain "Verification Iron Law"`
      );
    });

    it(`${agent} contains all 5 Iron Law steps`, () => {
      for (const step of IRON_LAW_STEPS) {
        assert.ok(
          agentContent[agent].includes(step),
          `${agent}.md must contain Iron Law step "${step}"`
        );
      }
    });
  }

  it('all quality agents use consistent Iron Law text', () => {
    // Extract the Iron Law section from each agent and compare
    const sections = [];
    for (const agent of QUALITY_AGENTS) {
      const content = agentContent[agent];
      // Find the full heading line (e.g., "## Verification Iron Law")
      const headingMatch = content.match(/^(#{1,3})\s+Verification Iron Law/m);
      if (!headingMatch) continue;
      const headingLevel = headingMatch[1].length;
      const startIdx = content.indexOf(headingMatch[0]);

      // Extract the core Iron Law text (heading through "Violations:" paragraph)
      // Agent-specific addenda after the core section are allowed to differ
      const afterStart = content.slice(startIdx);
      const violationsEnd = afterStart.search(/\*\*Violations:\*\*[^\n]*\n/);
      if (violationsEnd === -1) {
        sections.push(afterStart.trim());
      } else {
        const endOfViolations = afterStart.indexOf('\n', violationsEnd + 1);
        const core = endOfViolations === -1 ? afterStart : afterStart.slice(0, endOfViolations);
        sections.push(core.trim());
      }
    }

    assert.ok(sections.length > 0, 'At least one quality agent must have Iron Law section');
    const unique = new Set(sections);
    assert.equal(
      unique.size,
      1,
      'All quality agents must use identical Verification Iron Law text'
    );
  });
});

// ─── 3. Testing anti-patterns reference file ────────────────────────────────

describe('Testing anti-patterns reference file', () => {
  const ANTI_PATTERNS_PATH = path.join(ROOT_DIR, 'references', 'testing-anti-patterns.md');

  it('references/testing-anti-patterns.md exists', () => {
    assert.ok(fs.existsSync(ANTI_PATTERNS_PATH), 'references/testing-anti-patterns.md must exist');
  });

  it('contains at least 5 anti-pattern sections', () => {
    const exists = fs.existsSync(ANTI_PATTERNS_PATH);
    if (!exists) {
      assert.fail('Cannot check sections — file does not exist');
      return;
    }
    const text = fs.readFileSync(ANTI_PATTERNS_PATH, 'utf-8');
    // Count second-level headings (## Anti-pattern: ... or ## N. ...)
    const sectionHeadings = text.split('\n').filter((l) => l.match(/^##\s+/));
    assert.ok(
      sectionHeadings.length >= 5,
      `Must have >= 5 anti-pattern sections (## headings), found ${sectionHeadings.length}`
    );
  });

  it('each anti-pattern section contains a gate function', () => {
    const exists = fs.existsSync(ANTI_PATTERNS_PATH);
    if (!exists) {
      assert.fail('Cannot check gate functions — file does not exist');
      return;
    }
    const text = fs.readFileSync(ANTI_PATTERNS_PATH, 'utf-8');
    // Split on ## headings; first element is the preamble (before any ##), skip it
    const sections = text.split(/^## /m).filter((s) => s.trim());
    const antiPatternSections = sections.slice(1);
    for (const section of antiPatternSections) {
      const title = section.split('\n')[0].trim();
      assert.ok(
        /gate/i.test(section),
        `Anti-pattern section "${title}" must contain a gate function`
      );
    }
  });
});

// ─── 4. Developer agents cross-reference anti-patterns ──────────────────────

describe('Developer agents cross-reference testing-anti-patterns.md', () => {
  for (const agent of CROSS_REF_AGENTS) {
    it(`${agent} references testing-anti-patterns.md`, () => {
      assert.ok(
        agentContent[agent].includes('testing-anti-patterns.md'),
        `${agent}.md must cross-reference references/testing-anti-patterns.md`
      );
    });
  }
});

// ─── 5. Frontmatter preservation ────────────────────────────────────────────

describe('YAML frontmatter is preserved on all agent files', () => {
  for (const agent of ALL_MODIFIED_AGENTS) {
    it(`${agent} has valid frontmatter with name field`, () => {
      const fm = agentFrontmatter[agent];
      assert.ok(fm.name, `${agent}.md must have a "name" field in frontmatter`);
      assert.equal(
        fm.name,
        agent,
        `${agent}.md frontmatter name must be "${agent}", got "${fm.name}"`
      );
    });

    it(`${agent} has description in frontmatter`, () => {
      const content = agentContent[agent];
      // Check raw frontmatter block for description key (handles multi-line YAML values)
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      assert.ok(fmMatch, `${agent}.md must have YAML frontmatter`);
      assert.ok(
        fmMatch[1].includes('description:'),
        `${agent}.md frontmatter must contain "description:" key`
      );
    });
  }
});
