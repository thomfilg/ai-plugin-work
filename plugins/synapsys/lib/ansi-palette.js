'use strict';

/**
 * Shared ANSI color palette factory for CLI scripts.
 *
 * When `noColor` is true, returns a Proxy where every getter is an identity
 * function — callers can use the same `C.dim(s)` style without conditionals.
 *
 * @param {boolean} noColor
 * @returns {Record<string, (s: string) => string>}
 */
function makePalette(noColor) {
  if (noColor) return new Proxy({}, { get: () => (s) => String(s) });
  return {
    dim: (s) => `\x1b[2m${s}\x1b[0m`,
    bold: (s) => `\x1b[1m${s}\x1b[0m`,
    cyan: (s) => `\x1b[36m${s}\x1b[0m`,
    green: (s) => `\x1b[32m${s}\x1b[0m`,
    yellow: (s) => `\x1b[33m${s}\x1b[0m`,
    magenta: (s) => `\x1b[35m${s}\x1b[0m`,
    red: (s) => `\x1b[31m${s}\x1b[0m`,
    blue: (s) => `\x1b[34m${s}\x1b[0m`,
    gray: (s) => `\x1b[90m${s}\x1b[0m`,
  };
}

module.exports = { makePalette };
