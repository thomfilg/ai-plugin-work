'use strict';

/**
 * `max-lines` rule.
 *
 * Flags any non-excluded file whose source exceeds the threshold (default 400).
 * Excludes test files (`*.test.js`, `*.spec.js`) and markdown (`*.md`).
 *
 * Pure function: depends only on the passed `filePath` and `source` arguments.
 * Performs no filesystem I/O.
 */

const DEFAULT_THRESHOLD = 400;
const EXCLUDED_PATTERN = /(\.test\.js|\.spec\.js|\.md)$/i;

function isExcluded(filePath) {
  return EXCLUDED_PATTERN.test(filePath);
}

function countLines(source) {
  if (!source) return 0;
  return source.split('\n').length;
}

function check(filePath, source) {
  if (isExcluded(filePath)) return [];

  const lines = countLines(source);
  if (lines <= DEFAULT_THRESHOLD) return [];

  return [
    {
      line: 1,
      message: `max-lines > ${DEFAULT_THRESHOLD} (${lines} lines)`,
    },
  ];
}

module.exports = {
  id: 'max-lines',
  defaultThreshold: DEFAULT_THRESHOLD,
  check,
};
