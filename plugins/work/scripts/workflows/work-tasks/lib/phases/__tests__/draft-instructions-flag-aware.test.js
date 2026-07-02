'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const draft = require('../draft');

function withFlag(value, fn) {
  const prev = process.env.WORK_TEST_STRATEGY_VALIDATOR;
  if (value === undefined) delete process.env.WORK_TEST_STRATEGY_VALIDATOR;
  else process.env.WORK_TEST_STRATEGY_VALIDATOR = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.WORK_TEST_STRATEGY_VALIDATOR;
    else process.env.WORK_TEST_STRATEGY_VALIDATOR = prev;
  }
}

test('draft instructions emit ### Test Strategy template with no flag set', () => {
  const out = withFlag(undefined, () =>
    draft.instructions({ ticket: '#590', tasksDir: '/tmp/draft-instr-test' })
  );
  const joined = typeof out === 'string' ? out : out.join('\n');
  assert.match(joined, /### Test Strategy/, 'expected ### Test Strategy heading');
  assert.doesNotMatch(joined, /### Test Command/, 'legacy template must never be emitted');
});

test('draft instructions emit ### Test Strategy template when flag on', () => {
  const out = withFlag('1', () =>
    draft.instructions({ ticket: '#590', tasksDir: '/tmp/draft-instr-test' })
  );
  const joined = typeof out === 'string' ? out : out.join('\n');
  assert.match(joined, /### Test Strategy/, 'expected ### Test Strategy heading');
  assert.match(joined, /kind:\s*unit/, 'expected kind: unit example');
  assert.match(joined, /entry:/, 'expected entry: key in template');
  assert.match(
    joined,
    /unit\s*\|\s*integration\s*\|\s*e2e\s*\|\s*custom\s*\|\s*verified-by\s*\|\s*wiring-citation/,
    'expected enum listing in the comment block'
  );
  assert.doesNotMatch(joined, /### Test Command/, 'must NOT emit legacy block when flag on');
});

test('legacy env WORK_TEST_STRATEGY_VALIDATOR=0 is ignored (flag removed)', () => {
  const out = withFlag('0', () =>
    draft.instructions({ ticket: '#590', tasksDir: '/tmp/draft-instr-test' })
  );
  const joined = typeof out === 'string' ? out : out.join('\n');
  assert.match(joined, /### Test Strategy/);
  assert.doesNotMatch(joined, /### Test Command/);
});
