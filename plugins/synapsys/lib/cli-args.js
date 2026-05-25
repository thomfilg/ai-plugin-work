'use strict';

/**
 * Shared CLI flag parser for synapsys scripts.
 *
 * Usage:
 *   const { makeFlag } = require('../lib/cli-args');
 *   const flag = makeFlag(process.argv.slice(2));
 *   const json = !!flag('json');
 *   const kind = flag('kind');  // string value or undefined
 *
 * Recognised forms: `--name`, `--name=value`.
 */

function makeFlag(args) {
  return function flag(name) {
    const a = args.find((x) => x === `--${name}` || x.startsWith(`--${name}=`));
    if (!a) return undefined;
    const eq = a.indexOf('=');
    return eq === -1 ? true : a.slice(eq + 1);
  };
}

module.exports = { makeFlag };
