const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SKILL_PATH = path.resolve(__dirname, '..', 'SKILL.md');
const content = fs.readFileSync(SKILL_PATH, 'utf-8');

describe('split-in-tasks SKILL.md — bookend task enforcement (Rule 12)', () => {
  it('Rule 12 exists and appears after Rule 11', () => {
    const rule11Idx = content.indexOf('**Rule 11');
    const rule12Idx = content.indexOf('**Rule 12');
    assert.ok(rule11Idx > -1, 'SKILL.md must contain Rule 11');
    assert.ok(rule12Idx > -1, 'SKILL.md must contain Rule 12');
    assert.ok(rule11Idx < rule12Idx, 'Rule 12 must appear after Rule 11');
    const rule12Section = content.match(/\*\*Rule 12[\s\S]*?(?=\*\*(?:Rule|Anti-patterns))/);
    assert.ok(rule12Section, 'Rule 12 section must exist');
    const section = rule12Section[0];
    assert.match(section, /first task/i, 'Rule 12 must reference "first task"');
    assert.match(section, /last task/i, 'Rule 12 must reference "last task"');
  });

  it('Rule 12 requires first task to be type test with Gherkin reference', () => {
    const rule12Section = content.match(/\*\*Rule 12[\s\S]*?(?=\*\*(?:Rule|Anti-patterns))/);
    assert.ok(rule12Section, 'Rule 12 section must exist');
    const section = rule12Section[0];
    assert.match(
      section,
      /first task[\s\S]*?\btype\s+`test`|type\s+`test`[\s\S]*?first task/i,
      'Rule 12 must specify the first task is type "test"'
    );
    assert.match(
      section,
      /[Gg]herkin|[Gg]iven.*[Ww]hen.*[Tt]hen/,
      'Rule 12 must reference Gherkin or Given-When-Then scenarios from spec.md'
    );
  });

  it('Rule 12 requires last task to be verification checkpoint', () => {
    const rule12Section = content.match(/\*\*Rule 12[\s\S]*?(?=\*\*(?:Rule|Anti-patterns))/);
    assert.ok(rule12Section, 'Rule 12 section must exist');
    const section = rule12Section[0];
    assert.match(
      section,
      /last task[\s\S]*?type[\s\S]*?[`"]?checkpoint[`"]?|type[\s\S]*?[`"]?checkpoint[`"]?[\s\S]*?last task/i,
      'Rule 12 must specify the last task is type "checkpoint"'
    );
    assert.match(
      section,
      /run all tests|run.*tests|verify.*tests/i,
      'Rule 12 must specify the last task runs all tests'
    );
    assert.match(
      section,
      /depends on all|depend.*all.*preceding|depend.*prior/i,
      'Rule 12 must specify the last task depends on all preceding tasks'
    );
  });

  it('Rule 12 addresses edge case when spec has no Gherkin scenarios', () => {
    const rule12Section = content.match(/\*\*Rule 12[\s\S]*?(?=\*\*(?:Rule|Anti-patterns))/);
    assert.ok(rule12Section, 'Rule 12 section must exist');
    const section = rule12Section[0];
    assert.match(
      section,
      /no [Gg]herkin|without [Gg]herkin|[Gg]herkin.*not.*present|no.*scenarios/i,
      'Rule 12 must include fallback guidance for specs without Gherkin scenarios'
    );
    assert.match(
      section,
      /test scaffolding|acceptance criteria|test harness/i,
      'Fallback must mention test scaffolding or acceptance criteria'
    );
  });

  it('Step 5 quality review includes first/last task bookend check', () => {
    const step5Match = content.match(/### Step 5[\s\S]*?(?=### Step 6|$)/);
    assert.ok(step5Match, 'Step 5 section must exist');
    const section = step5Match[0];
    assert.match(
      section,
      /first.task[\s\S]*?last.task|last.task[\s\S]*?first.task|bookend/i,
      'Step 5 must include a check for first-task and last-task constraints'
    );
    assert.match(
      section,
      /first task[\s\S]*?last task|last task[\s\S]*?first task/i,
      'Step 5 must explicitly include checks for both first-task and last-task constraints'
    );
    assert.match(section, /Rule 12/i, 'Step 5 first/last task check must reference Rule 12');
  });

  it('Rule 11 specifies second-to-last instead of last', () => {
    const rule11Section = content.match(/\*\*Rule 11[\s\S]*?(?=\*\*(?:Rule 12|Anti-patterns))/);
    assert.ok(rule11Section, 'Rule 11 section must exist');
    const section = rule11Section[0];
    assert.match(section, /second-to-last/i, 'Rule 11 must say "second-to-last"');
    assert.doesNotMatch(
      section,
      /should be the last task/i,
      'Rule 11 must NOT say "should be the last task"'
    );
  });

  it('Rule 12 specifies intermediate tasks ordered between bookend tasks', () => {
    const rule12Section = content.match(/\*\*Rule 12[\s\S]*?(?=\*\*(?:Rule|Anti-patterns))/);
    assert.ok(rule12Section, 'Rule 12 section must exist');
    const section = rule12Section[0];
    assert.match(
      section,
      /intermediate|implementation.*between|between.*first.*last|ordered between/i,
      'Rule 12 must mention intermediate/implementation tasks between first and last'
    );
  });
});
