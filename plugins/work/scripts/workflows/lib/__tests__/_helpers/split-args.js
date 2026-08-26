/**
 * Shared test helper: split a command-line string into argv.
 *
 * Why this exists
 * ---------------
 * Several CLI tests read best as one readable command string
 * (`record-green TEST-1 --cmd "${script}"`), but running that string through
 * `execSync` means a shell parses it — and the string is assembled from
 * absolute paths the test never chose (`__dirname`, `os.tmpdir()`). CodeQL
 * flags that as js/shell-command-injection-from-environment, and it is a real
 * footgun: a temp path containing a space or a shell metacharacter silently
 * changes the command.
 *
 * `splitArgs()` does the word splitting the tests actually rely on — the same
 * result a POSIX shell would produce for unquoted words, single quotes
 * (literal) and double quotes (with `\` escaping `"`, `\`, `$` and a
 * backtick) — so callers keep their readable strings while the CLI is spawned
 * with `execFileSync` and no shell at all.
 *
 * It is deliberately NOT a general shell parser: no globbing, no variable
 * expansion, no operators. Anything beyond quoting belongs in the test itself.
 */

'use strict';

const DQ_ESCAPABLE = '"\\$`';

function splitArgs(line) {
  const argv = [];
  let current = null;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (ch === ' ' || ch === '\t' || ch === '\n') {
      if (current !== null) {
        argv.push(current);
        current = null;
      }
      continue;
    }

    if (current === null) current = '';

    if (ch === "'") {
      const close = line.indexOf("'", i + 1);
      const stop = close === -1 ? line.length : close;
      current += line.slice(i + 1, stop);
      i = stop;
    } else if (ch === '"') {
      i++;
      while (i < line.length && line[i] !== '"') {
        if (line[i] === '\\' && i + 1 < line.length && DQ_ESCAPABLE.includes(line[i + 1])) i++;
        current += line[i];
        i++;
      }
    } else if (ch === '\\' && i + 1 < line.length) {
      current += line[i + 1];
      i++;
    } else {
      current += ch;
    }
  }

  if (current !== null) argv.push(current);
  return argv;
}

module.exports = { splitArgs };
