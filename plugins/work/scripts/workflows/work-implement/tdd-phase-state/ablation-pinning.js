'use strict';

/**
 * tdd-phase-state/ablation-pinning.js
 *
 * GH-570 ablation-cycle integrity helpers, extracted from ablation.js
 * (static-quality max-lines split — same lineage as the GH-610
 * decomposition):
 *
 *   - `scopeTestFiles`: in-scope test files on disk + it()/test() block
 *     count (mirrors resume-completed condition b).
 *   - `computeTestFileStateSha`: content-pins the in-scope test files at
 *     RED; GREEN requires byte-identical state so the fail→pass flip is
 *     attributable to the reverted source mutation, never a test edit.
 *   - `extractFailingTestNames`: best-effort `failingTest` parsing from
 *     runner output (null when unparseable — the shas remain the
 *     replayable evidence).
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * Find the in-scope test files on disk plus their it()/test() block count.
 * Lazy-requires task-next.js (same shared helpers the resume-completed
 * recorder uses — findTestFilesInScope / countTestBlocksInFiles) to avoid a
 * top-level require cycle.
 */
function scopeTestFiles(repoRoot, scope) {
  const taskNext = require('../task-next.js');
  const files = [...taskNext.findTestFilesInScope(repoRoot, scope)].sort();
  const { totalBlocks } = taskNext.countTestBlocksInFiles(files);
  return { files, totalBlocks };
}

/**
 * Hash the in-scope test files' on-disk content (sorted rel-path + bytes)
 * into one sha256. Recorded at RED as `testFileStateSha`; GREEN recomputes
 * and requires byte-identical state so a test edited between RED and GREEN
 * (e.g. a sabotaged-then-restored assertion) voids the cycle.
 */
function computeTestFileStateSha(repoRoot, scope) {
  const { files } = scopeTestFiles(repoRoot, scope);
  const h = crypto.createHash('sha256');
  const relFiles = [];
  for (const f of files) {
    const rel = path.relative(repoRoot, f);
    relFiles.push(rel);
    h.update(rel);
    h.update('\0');
    try {
      h.update(fs.readFileSync(f));
    } catch {
      h.update('<unreadable>');
    }
    h.update('\0');
  }
  return { sha: h.digest('hex'), files: relFiles };
}

// GH-570 — best-effort failing-test-name extraction from runner output.
// One line-anchored pattern per runner family; unmatched output yields null.
const FAILING_TEST_LINE_RES = [
  /^not ok\s+\d+\s*(?:-\s*)?(.+)$/, // TAP (node --test default reporter)
  /^\s*✖\s+(.+?)(?:\s+\([\d.]+m?s\))?$/, // node:test spec reporter
  /^\s*✕\s+(.+?)(?:\s+\(\d+\s*m?s\))?$/, // jest
  /^\s*\d+\)\s+(.+)$/, // mocha epilogue
];

/**
 * Parse failing test name(s) from a runner's combined output. Best-effort
 * (GH-570 asked for `failingTest`): returns a deduped array of names, or
 * null when nothing recognizable was found.
 */
function extractFailingTestNames(output) {
  const names = new Set();
  for (const line of String(output || '').split('\n')) {
    for (const re of FAILING_TEST_LINE_RES) {
      const m = re.exec(line);
      if (m && m[1] && m[1].trim()) {
        names.add(m[1].trim());
        break;
      }
    }
    if (names.size >= 20) break;
  }
  return names.size > 0 ? [...names] : null;
}

module.exports = {
  scopeTestFiles,
  computeTestFileStateSha,
  extractFailingTestNames,
};
