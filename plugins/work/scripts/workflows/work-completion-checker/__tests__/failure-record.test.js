'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeFailure } = require('../lib/failure-record');

test('makeFailure returns plain object with exactly the expected keys', () => {
  const f = makeFailure({
    requirementId: 'R1',
    checkType: 'reuse_audit',
    expected: 'foo',
    observed: 'bar',
    file: 'a.js',
    line: 12,
  });
  assert.deepEqual(f, {
    requirementId: 'R1',
    checkType: 'reuse_audit',
    expected: 'foo',
    observed: 'bar',
    file: 'a.js',
    line: 12,
  });
  assert.deepEqual(Object.keys(f).sort(), [
    'checkType',
    'expected',
    'file',
    'line',
    'observed',
    'requirementId',
  ]);
});

test('makeFailure defaults file and line to undefined when omitted', () => {
  const f = makeFailure({
    requirementId: 'R2',
    checkType: 'scope',
    expected: 'x',
    observed: 'y',
  });
  assert.equal(f.file, undefined);
  assert.equal(f.line, undefined);
  assert.equal(f.requirementId, 'R2');
  assert.equal(f.checkType, 'scope');
});

for (const key of ['requirementId', 'checkType', 'expected', 'observed']) {
  test(`makeFailure throws TypeError when ${key} missing`, () => {
    const input = {
      requirementId: 'R1',
      checkType: 'reuse_audit',
      expected: 'e',
      observed: 'o',
    };
    delete input[key];
    assert.throws(() => makeFailure(input), {
      name: 'TypeError',
      message: `failure-record: ${key} required`,
    });
  });
}
