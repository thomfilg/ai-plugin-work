'use strict';

/**
 * lint-cli — shared per-file lint driver for the WP-10 skill-surface lints.
 *
 * Kept in one place so lint-skill-frontmatter / lint-vocab / lint-symlink-paths
 * don't each re-grow the same file-loop + reporting boilerplate (and trip the
 * cross-file duplicate-blocks quality rule doing it).
 */

const path = require('node:path');

const EXIT_OK = 0;
const EXIT_VIOLATIONS = 1;
const EXIT_CONFIG_ERROR = 2;

/**
 * Run `lintFile(file)` (→ array of violation strings) over `files`, printing
 * `OK <rel>` per clean file and `<rel>: <violation>` per finding on stderr.
 *
 * @returns {number} process exit code (0 clean, 1 violations, 2 no files)
 */
function runFileLint({ name, files, lintFile, repoRoot }) {
  if (!Array.isArray(files) || files.length === 0) {
    console.error(`${name}: no files to lint`);
    return EXIT_CONFIG_ERROR;
  }
  const failures = [];
  for (const file of files) {
    const rel = path.relative(repoRoot, file) || file;
    const before = failures.length;
    for (const violation of lintFile(file)) failures.push(`${rel}: ${violation}`);
    if (failures.length === before) console.log(`OK ${rel}`);
  }
  for (const line of failures) console.error(line);
  if (failures.length > 0) {
    console.error(`${name}: ${failures.length} violation(s) across ${files.length} file(s)`);
    return EXIT_VIOLATIONS;
  }
  return EXIT_OK;
}

module.exports = { EXIT_OK, EXIT_VIOLATIONS, EXIT_CONFIG_ERROR, runFileLint };
