'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { lint } = require('../../scripts/synapsys-crystallize-lint');

function warningRules(result) {
  return result.warnings.map((w) => w.rule);
}

test('warns on untargeted PostToolUse memory (no targeting trigger)', () => {
  const manifest = {
    memories: [
      {
        name: 'untargeted-posttool',
        events: ['PostToolUse'],
      },
    ],
  };
  const result = lint(manifest);
  const rules = warningRules(result);
  assert.ok(
    rules.includes('R11-untargeted-posttool'),
    `expected R11-untargeted-posttool warning, got: ${JSON.stringify(result.warnings)}`,
  );
});

test('does NOT warn when trigger_posttool_content targets the PostToolUse memory', () => {
  const manifest = {
    memories: [
      {
        name: 'targeted-by-posttool-content',
        events: ['PostToolUse'],
        trigger_posttool_content: ['error'],
      },
    ],
  };
  const result = lint(manifest);
  assert.ok(
    !warningRules(result).includes('R11-untargeted-posttool'),
    `expected no R11 warning, got: ${JSON.stringify(result.warnings)}`,
  );
});

test('does NOT warn when trigger_posttool_exit targets the PostToolUse memory', () => {
  const manifest = {
    memories: [
      {
        name: 'targeted-by-posttool-exit',
        events: ['PostToolUse'],
        trigger_posttool_exit: 'nonzero',
      },
    ],
  };
  const result = lint(manifest);
  assert.ok(
    !warningRules(result).includes('R11-untargeted-posttool'),
    `expected no R11 warning, got: ${JSON.stringify(result.warnings)}`,
  );
});

test('does NOT warn when trigger_pretool targets the PostToolUse memory', () => {
  const manifest = {
    memories: [
      {
        name: 'targeted-by-pretool',
        events: ['PostToolUse'],
        trigger_pretool: ['Bash:git push'],
      },
    ],
  };
  const result = lint(manifest);
  assert.ok(
    !warningRules(result).includes('R11-untargeted-posttool'),
    `expected no R11 warning, got: ${JSON.stringify(result.warnings)}`,
  );
});

test('R10 warns on trigger_posttool_content_not without a positive trigger_posttool_content', () => {
  const manifest = {
    memories: [
      {
        name: 'posttool-neg-without-pos',
        events: ['PostToolUse'],
        trigger_pretool: ['Bash:pnpm test'],
        trigger_posttool_content_not: ['timeout'],
      },
    ],
  };
  const result = lint(manifest);
  const r10 = result.warnings.filter((w) => w.rule === 'R10-neg-without-pos');
  assert.equal(r10.length, 1, `expected one R10 warning, got: ${JSON.stringify(result.warnings)}`);
  assert.match(r10[0].message, /trigger_posttool_content_not/);
  assert.match(r10[0].message, /trigger_posttool_content\b/);
});

test('R10 does NOT warn when trigger_posttool_content_not has a positive trigger_posttool_content', () => {
  const manifest = {
    memories: [
      {
        name: 'posttool-neg-with-pos',
        events: ['PostToolUse'],
        trigger_pretool: ['Bash:pnpm test'],
        trigger_posttool_content: ['FAIL'],
        trigger_posttool_content_not: ['timeout'],
      },
    ],
  };
  const result = lint(manifest);
  assert.ok(
    !warningRules(result).includes('R10-neg-without-pos'),
    `expected no R10 warning, got: ${JSON.stringify(result.warnings)}`,
  );
});

test('does NOT warn when memory has no PostToolUse event', () => {
  const manifest = {
    memories: [
      {
        name: 'no-posttool',
        events: ['UserPromptSubmit'],
      },
    ],
  };
  const result = lint(manifest);
  assert.ok(
    !warningRules(result).includes('R11-untargeted-posttool'),
    `expected no R11 warning, got: ${JSON.stringify(result.warnings)}`,
  );
});
