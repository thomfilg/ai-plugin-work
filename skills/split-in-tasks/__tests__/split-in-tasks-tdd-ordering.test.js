const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SKILL_PATH = path.resolve(__dirname, '..', 'SKILL.md');
const content = fs.readFileSync(SKILL_PATH, 'utf-8'); // discoverable via scripts/run-tests.sh (skills/ included)

describe('split-in-tasks SKILL.md — TDD ordering enforcement', () => {

  it('contains Rule 10 with TDD ordering requirement after Rule 9', () => {
    const rule9Idx = content.indexOf('**Rule 9');
    const rule10Idx = content.indexOf('**Rule 10');
    assert.ok(rule9Idx > -1, 'SKILL.md must contain Rule 9');
    assert.ok(rule10Idx > -1, 'SKILL.md must contain Rule 10');
    assert.ok(rule9Idx < rule10Idx, 'Rule 10 must appear after Rule 9');
    assert.match(content.slice(rule10Idx), /TDD/i,
      'Rule 10 must reference TDD ordering');
  });

  it('contains phase-labeled deliverables template with RED, GREEN, REFACTOR prefixes', () => {
    // Scope assertion to the Deliverables template section only
    const deliverablesSection = content.match(/### Deliverables[\s\S]*?(?=###\s)/);
    assert.ok(deliverablesSection, 'Deliverables template section must exist');
    const section = deliverablesSection[0];
    assert.match(section, /\*\*RED:\*\*/,
      'Deliverables template must include **RED:** prefix');
    assert.match(section, /\*\*GREEN:\*\*/,
      'Deliverables template must include **GREEN:** prefix');
    assert.match(section, /\*\*REFACTOR:\*\*/,
      'Deliverables template must include **REFACTOR:** prefix (ordering verified below)');
    // Verify ordering: RED before GREEN before REFACTOR
    const redIdx = section.indexOf('**RED:**');
    const greenIdx = section.indexOf('**GREEN:**');
    const refactorIdx = section.indexOf('**REFACTOR:**');
    assert.ok(redIdx < greenIdx, 'RED must appear before GREEN in deliverables template');
    assert.ok(greenIdx < refactorIdx, 'GREEN must appear before REFACTOR in deliverables template');
  });

  it('contains TDD protocol metadata line in file header template', () => {
    const headerSection = content.match(/### Full file structure[\s\S]*?(?=### |$)/);
    assert.ok(headerSection, 'Full file structure section must exist');
    assert.match(headerSection[0], /TDD Protocol/,
      'File header template must include TDD Protocol metadata');
  });

  it('contains TDD ordering check in Step 5 quality review', () => {
    // Step 5 section must mention TDD ordering validation
    const step5Match = content.match(/### Step 5[\s\S]*?(?=### Step 6|$)/);
    assert.ok(step5Match, 'Step 5 section must exist');
    assert.match(step5Match[0], /TDD ordering/i,
      'Step 5 must include a TDD ordering check');
    assert.match(step5Match[0], /RED.*GREEN.*REFACTOR/i,
      'Step 5 TDD check must reference RED, GREEN, REFACTOR phases');
  });

  it('contains format rules documenting phase prefix convention', () => {
    const formatRulesMatch = content.match(/### Format rules[\s\S]*$/);
    assert.ok(formatRulesMatch, 'Format rules section must exist');
    assert.match(formatRulesMatch[0], /\*\*RED:\*\*/,
      'Format rules must document **RED:** prefix');
    assert.match(formatRulesMatch[0], /\*\*GREEN:\*\*/,
      'Format rules must document **GREEN:** prefix');
    assert.match(formatRulesMatch[0], /\*\*REFACTOR:\*\*/,
      'Format rules must document **REFACTOR:** prefix');
  });

  it('contains exception for checkpoint/config-only tasks', () => {
    // Scope assertion to Rule 10 section only
    const rule10Section = content.match(/\*\*Rule 10[\s\S]*?(?=\*\*(?:Rule|Anti-patterns))/);
    assert.ok(rule10Section, 'Rule 10 section must exist');
    assert.match(rule10Section[0], /checkpoint.*exempt|config.only.*exempt|exempt.*checkpoint|exempt.*config/i,
      'Rule 10 must include exception for checkpoint and config-only tasks');
  });

  it('contains multi-behavior triplet guidance', () => {
    // Scope assertion to Rule 10 section only
    const rule10Section = content.match(/\*\*Rule 10[\s\S]*?(?=\*\*(?:Rule|Anti-patterns))/);
    assert.ok(rule10Section, 'Rule 10 section must exist');
    assert.match(rule10Section[0], /triplet|multiple behaviors[\s\S]*?RED[\s\S]*?GREEN[\s\S]*?REFACTOR|each behavior[\s\S]*?own/i,
      'Rule 10 section must include guidance for multi-behavior triplets');
  });

});
