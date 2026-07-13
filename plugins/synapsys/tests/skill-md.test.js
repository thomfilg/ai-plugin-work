'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SKILL_PATH = path.join(__dirname, '..', 'skills', 'crystallize', 'SKILL.md');

function readSkill() {
  return fs.readFileSync(SKILL_PATH, 'utf8');
}

test('SKILL.md no longer hardcodes the default events line', () => {
  const skill = readSkill();
  assert.ok(
    !skill.includes('Every memory uses `events: UserPromptSubmit,PreToolUse`'),
    'SKILL.md must not contain the hardcoded default-events phrase'
  );
});

test('SKILL.md contains a Classifier matrix heading', () => {
  const skill = readSkill();
  assert.match(skill, /Classifier matrix/);
});

test('SKILL.md step 8 references synapsys-crystallize-lint.js', () => {
  const skill = readSkill();
  assert.match(skill, /synapsys-crystallize-lint\.js/);
});

test('SKILL.md step 8 references synapsys-crystallize-write.js', () => {
  const skill = readSkill();
  assert.match(skill, /synapsys-crystallize-write\.js/);
});

test('SKILL.md contains AskUserQuestion gate with the three options', () => {
  const skill = readSkill();
  assert.match(skill, /AskUserQuestion/);
  assert.match(skill, /Proceed despite warnings/);
  assert.match(skill, /Fix and retry/);
  assert.match(skill, /Cancel/);
});

test('SKILL.md specifies Proceed-despite-warnings is hidden when errors exist', () => {
  const skill = readSkill();
  assert.match(skill, /errors\.length\s*>\s*0/);
});

test('SKILL.md TODO block lists synapsys-replay.js', () => {
  const skill = readSkill();
  assert.match(
    skill,
    /## TODO \(out of scope, deferred\)[\s\S]*synapsys-replay\.js/i,
    'TODO block must name synapsys-replay.js'
  );
});

test('SKILL.md TODO block lists trigger_negative', () => {
  const skill = readSkill();
  assert.match(
    skill,
    /## TODO \(out of scope, deferred\)[\s\S]*trigger_negative/i,
    'TODO block must name trigger_negative'
  );
});

test('SKILL.md TODO block lists LLM-based standalone classifier', () => {
  const skill = readSkill();
  assert.match(
    skill,
    /## TODO \(out of scope, deferred\)[\s\S]*LLM-based standalone classifier/i,
    'TODO block must name LLM-based standalone classifier'
  );
});

test('SKILL.md TODO block lists backwards migration', () => {
  const skill = readSkill();
  assert.match(
    skill,
    /## TODO \(out of scope, deferred\)[\s\S]*backwards migration/i,
    'TODO block must name backwards migration'
  );
});
