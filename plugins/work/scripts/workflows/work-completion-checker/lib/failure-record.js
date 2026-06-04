'use strict';

/**
 * @typedef {Object} FailureRecord
 * @property {string} requirementId
 * @property {string} checkType
 * @property {string} expected
 * @property {string} observed
 * @property {string|undefined} file
 * @property {number|undefined} line
 */

/**
 * Build a normalized failure record for completion-checker phases.
 *
 * @param {{ requirementId: string, checkType: string, expected: string, observed: string, file?: string, line?: number }} input
 * @returns {FailureRecord}
 * @throws {TypeError} when any of requirementId/checkType/expected/observed is missing.
 */
function makeFailure(input) {
  const src = input || {};
  if (src.requirementId === undefined || src.requirementId === null) {
    throw new TypeError('failure-record: requirementId required');
  }
  if (src.checkType === undefined || src.checkType === null) {
    throw new TypeError('failure-record: checkType required');
  }
  if (src.expected === undefined || src.expected === null) {
    throw new TypeError('failure-record: expected required');
  }
  if (src.observed === undefined || src.observed === null) {
    throw new TypeError('failure-record: observed required');
  }
  return {
    requirementId: src.requirementId,
    checkType: src.checkType,
    expected: src.expected,
    observed: src.observed,
    file: src.file,
    line: src.line,
  };
}

module.exports = { makeFailure };
