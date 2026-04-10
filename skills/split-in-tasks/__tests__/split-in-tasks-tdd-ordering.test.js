const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SKILL_PATH = path.resolve(__dirname, '..', 'SKILL.md');
const content = fs.readFileSync(SKILL_PATH, 'utf-8');

describe('split-in-tasks SKILL.md — TDD ordering enforcement', () => {

  it('contains Rule 10 with TDD ordering requirement', () => {
    assert.match(content, /Rule 10.*TDD/i,
      'SKILL.md must contain Rule 10 referencing TDD ordering');
  });

  it('contains phase-labeled deliverables template with RED, GREEN, REFACTOR prefixes', () => {
    assert.match(content, /\*\*RED:\*\*/,
      'Deliverables template must include **RED:** prefix');
    assert.match(content, /\*\*GREEN:\*\*/,
      'Deliverables template must include **GREEN:** prefix');
    assert.match(content, /\*\*REFACTOR:\*\*/,
      'Deliverables template must include **REFACTOR:** prefix');
  });

  it('contains TDD protocol metadata line in file header template', () => {
    assert.match(content, /TDD Protocol/,
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
    assert.match(content, /checkpoint.*exempt|config.only.*exempt|exempt.*checkpoint|exempt.*config/i,
      'Rule 10 must include exception for checkpoint and config-only tasks');
  });

  it('contains multi-behavior triplet guidance', () => {
    assert.match(content, /triplet|multiple behaviors.*RED.*GREEN.*REFACTOR|each behavior.*own/i,
      'Rule 10 must include guidance for multi-behavior triplets');
  });

});
