'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ALLOWLIST_FILENAME = '.quality-exceptions';

/**
 * Loads a per-repo allowlist file (`.quality-exceptions`) into a Set of
 * normalized, repo-relative paths.
 *
 * Format:
 *   - One path per line (repo-relative).
 *   - Blank lines and lines starting with `#` are ignored.
 *   - Whitespace is trimmed.
 *   - Absolute paths and entries containing `..` are rejected (security).
 *   - A missing file returns an empty Set (not an error).
 */
const AllowlistLoader = {
  load(repoRoot) {
    const filePath = path.join(repoRoot, ALLOWLIST_FILENAME);
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        return new Set();
      }
      throw err;
    }

    const out = new Set();
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      if (trimmed.startsWith('#')) continue;

      if (path.isAbsolute(trimmed)) {
        throw new Error(
          `AllowlistLoader: absolute paths are not allowed (got "${trimmed}")`
        );
      }
      if (trimmed.split(/[\\/]/).includes('..')) {
        throw new Error(
          `AllowlistLoader: entries containing ".." are not allowed (got "${trimmed}")`
        );
      }

      out.add(path.normalize(trimmed));
    }
    return out;
  },
};

module.exports = { AllowlistLoader, ALLOWLIST_FILENAME };
