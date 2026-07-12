/**
 * Shared helpers for completion-checker kind-check modules.
 *
 * Most utilities are thin re-exports of work-spec's kind-checks shared
 * helpers (same fs reads, same kind detection). Completion-specific helpers
 * (changed-files reader, requirement table parser) live below.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const specShared = require('../../../work-spec/lib/kind-checks/shared');
const {
  readFile,
  readChangedFiles,
  specSharedReexports,
} = require('../../../lib/kind-checks-shared-base');
const { extractRequirementIdsFromBulletBlock } = require('../../../lib/requirement-ids');

/**
 * Walk `## Task N — <title>` blocks and synthesize coverage rows from each
 * block's `### Requirements Covered` bullet list. Used as a fallback when
 * the top-level `## Requirement Coverage` table is absent. Synthesized rows
 * default to status='DELIVERED' and evidence='tasks.md:Task N' (R10).
 */
function readRequirementCoverageFromSubsections(tasksText) {
  if (!tasksText) return [];
  const rows = [];
  const taskHeader = /^##\s+Task\s+(\d+)\b/gim;
  let match;
  while ((match = taskHeader.exec(tasksText)) !== null) {
    const taskNum = match[1];
    const after = tasksText.slice(match.index + match[0].length);
    const nextTop = after.match(/^##\s/m);
    const block = nextTop ? after.slice(0, nextTop.index) : after;
    const reqMatch = block.match(/^###\s+Requirements Covered\b/im);
    if (!reqMatch) continue;
    const reqAfter = block.slice(reqMatch.index + reqMatch[0].length);
    const nextHeading = reqAfter.match(/^#{2,3}\s/m);
    const reqBlock = nextHeading ? reqAfter.slice(0, nextHeading.index) : reqAfter;
    // #498: parse with the SAME canonical grammar the tasks-phase generator
    // uses (shared lib/requirement-ids.js), so comma-separated bullets like
    // `- R1, R6, R7` synthesize one row per ID instead of silently yielding
    // zero rows and re-triggering the requirement_coverage_missing deadlock.
    for (const id of extractRequirementIdsFromBulletBlock(reqBlock)) {
      rows.push({
        id,
        description: '',
        status: 'DELIVERED',
        evidence: `tasks.md:Task ${taskNum}`,
        // Tag synthesized rows so downstream gates (test_pass_crossref B2)
        // can avoid forcing test citations on the R4 fallback, which has
        // no concept of per-row test evidence by design.
        source: 'subsection',
      });
    }
  }
  return rows;
}

/**
 * Parse one `| id | desc | status | evidence |` table line into a coverage
 * row, or null for non-row lines (separators, headers, prose).
 */
function parseCoverageTableRow(line) {
  if (!/^\|/.test(line)) return null;
  const cells = line
    .split('|')
    .slice(1, -1)
    .map((c) => c.trim());
  if (cells.length < 2) return null;
  if (/^-+$/.test(cells[0])) return null;
  if (/^(id|requirement|req)$/i.test(cells[0])) return null;
  return {
    id: cells[0],
    description: cells[1] || '',
    status: cells[2] || '',
    evidence: cells[3] || '',
    source: 'table',
  };
}

/**
 * Parse `## Requirement Coverage` table out of tasks.md.
 * Returns array of { id, description, status, evidence } records.
 * Falls back to per-task `### Requirements Covered` subsections when the
 * top-level table is absent (R4).
 */
function readRequirementCoverage(tasksDir) {
  const text = specShared.readTasks(tasksDir);
  if (!text) return [];
  const block = specShared.sliceSection(text, /^##\s+Requirement Coverage\b/im);
  const rows = (block ? block.split('\n') : []).map(parseCoverageTableRow).filter(Boolean);
  if (rows.length === 0) return readRequirementCoverageFromSubsections(text);
  return rows;
}

/**
 * Parse brief-writer's canonical MoSCoW headings (`### Must Have (P0)`,
 * `### Should Have (P1)`, `### Could Have (P2)`) into requirement items.
 * Items may be numbered (`1. …`) or bulleted (`- …`). The explicit `(P0)`
 * tag wins; otherwise Must→P0, Should→P1, Could→P2.
 *
 * ECHO-5530/ECHO-5145: the brief-writer agent emits exactly this format,
 * but requirements_extract only recognized `- P0:` bullets — so the runner
 * reported "No requirements found" against its own sibling agent's output.
 */
function parseMoscowRequirements(brief) {
  const items = [];
  const headingRe = /^###\s+.*\b(must|should|could)[-\s]haves?\b.*$/gim;
  const fallbackPriority = { must: 'P0', should: 'P1', could: 'P2' };
  let m;
  while ((m = headingRe.exec(brief)) !== null) {
    const tag = m[0].match(/\((P[0-2])\)/i);
    const priority = (tag ? tag[1] : fallbackPriority[m[1].toLowerCase()]).toUpperCase();
    const after = brief.slice(m.index + m[0].length);
    const next = after.match(/^#{1,3}\s/m);
    const block = next ? after.slice(0, next.index) : after;
    for (const line of block.split('\n')) {
      const im = line.match(/^\s*(?:[-*]|\d+[.)])\s+(?:\*\*)?(.+?)(?:\*\*)?\s*$/);
      if (im) items.push({ priority, text: im[1].trim() });
    }
  }
  return items;
}

/**
 * Pull bullet lines that begin with P0 / P1 markers out of brief.md
 * `## Requirements` section. Used to enumerate must-have requirements.
 * Falls back to the brief-writer's canonical MoSCoW headings
 * (`### Must Have (P0)` with numbered/bulleted items) when no `- P0:`
 * bullets are found.
 */
function readBriefRequirements(tasksDir) {
  const brief = specShared.readBrief(tasksDir);
  if (!brief) return [];
  const block =
    specShared.sliceSection(brief, /^##\s+Requirements\b/im) ||
    specShared.sliceSection(brief, /^##\s+Must.have\b/im);
  const items = [];
  for (const line of (block || '').split('\n')) {
    const m = line.match(/^\s*[-*]\s+(?:\*\*)?(P[0-2])(?:\*\*)?\s*[:-]?\s*(.+)$/i);
    if (m) items.push({ priority: m[1].toUpperCase(), text: m[2].trim() });
  }
  if (items.length) return items;
  return parseMoscowRequirements(brief);
}

/**
 * GH-607 (R7): pick the declared source path from a Reuse Audit bullet match.
 * Three path orderings are captured by `readReuseAudit`'s regex — pre-verb
 * `from \`path\`` (group 2), pre-verb parenthesized `(\`path\`)` (group 3),
 * and post-verb `from \`path\`` (group 5) — falling back to `null` when the
 * bullet declares no path. (Group 4 is the verb phrase itself, from which
 * `mustReuse` is derived — never a path.) Extracted so the disjunction lives
 * outside `readReuseAudit` (keeps its cyclomatic complexity within the gate).
 */
function pickDeclaredReusePath(match) {
  return match[2] || match[3] || match[5] || null;
}

/**
 * Parse the `## Reuse Audit` section of spec.md and return an array of
 * `{ symbol, line, mustReuse }` records. Returns `null` when the section
 * is absent (signals "spec doesn't declare reuse"), and `[]` when the
 * section carries an explicit none-marker bullet (`- None — ...`), which
 * declares "audited, nothing reusable found". Throws when the section is
 * present but contains no parseable entries (signals malformed authoring
 * rather than absence).
 *
 * Recognized bullet shapes (#629 — grammar must match what spec-writer is
 * instructed to emit; see agents/spec-writer.md "Reuse Declarations"):
 *   - `Symbol` MUST be reused from `path/to/file.ext` — reason
 *   - `Symbol` from `path/to/file.ext` MUST be reused — reason (path between
 *     the symbol backticks and the verb — spec-writer emits this ordering too)
 *   - `Symbol` (`path/to/file.ext`) MUST be reused — reason
 *   - `Symbol` may be reused from `path` — reason (soft, mustReuse: false;
 *     MUST/may match case-insensitively in every ordering)
 *   - None — no reusable symbols found (explicit empty declaration)
 */
function readReuseAudit(specDir) {
  const text = specShared.readSpec(specDir);
  if (!text) return null;
  const headingRe = /^##\s+Reuse Audit\b/im;
  const headingMatch = text.match(headingRe);
  if (!headingMatch) return null;
  const block = specShared.sliceSection(text, headingRe);
  // Map heading position to a line index so per-entry line numbers are
  // absolute within spec.md (useful for downstream error messages).
  const headingOffset = headingMatch.index;
  const headingLine = text.slice(0, headingOffset).split('\n').length;
  const entries = [];
  const blockLines = (block || '').split('\n');
  let sawNoneMarker = false;
  for (let i = 0; i < blockLines.length; i += 1) {
    const raw = blockLines[i];
    if (/^\s*[-*]\s+None\b/i.test(raw)) {
      sawNoneMarker = true;
      continue;
    }
    // Optional path between the symbol and the verb tolerates both the
    // `` `Symbol` (`path`) MUST be reused `` ordering (#629) and the
    // `` `Symbol` from `path` MUST be reused `` ordering spec-writer also
    // emits (GH-282 follow-up: the canonical shape puts `from \`path\``
    // AFTER the verb, but the parser must accept either side).
    //
    // GH-607 (R7): the declared source path is additionally CAPTURED (not just
    // tolerated) into an additive `path` field so downstream consumers can
    // classify config-file entries without re-parsing. Three path orderings
    // are captured — pre-verb `from \`path\`` (group 2), pre-verb
    // parenthesized `(\`path\`)` (group 3), and post-verb `from \`path\``
    // (group 5) — falling back to `null` when the bullet declares no path.
    // The verb phrase is its OWN capture group (group 4) so `mustReuse` is
    // derived from the verb alone — testing the whole match (`m[0]`) would
    // mis-classify a `may be reused` bullet as MUST whenever the symbol name
    // or declared path merely contains the substring "must" (e.g.
    // `MustacheRenderer`, `must-reuse-helper.js`).
    const m = raw.match(
      /^\s*[-*]\s+`([^`]+)`\s*(?:from\s+`([^`]+)`\s*|\(`([^`]+)`\)\s*|\([^)]*\)\s*)?(MUST\s+be\s+reused|be\s+reused|may\s+be\s+reused)(?:\s+from\s+`([^`]+)`)?/i
    );
    if (!m) continue;
    const mustReuse = /MUST/i.test(m[4]);
    const declaredPath = pickDeclaredReusePath(m);
    entries.push({
      symbol: m[1],
      // headingLine is the 1-indexed line of `## Reuse Audit`; sliceSection
      // returns text AFTER that heading, so body index 0 corresponds to the
      // line immediately below the heading (`headingLine + 1`). Previous
      // form `headingLine + i` was off-by-one and pointed every entry one
      // line above its actual location in spec.md (review feedback).
      line: headingLine + 1 + i,
      mustReuse,
      // GH-607 (R7): declared source path (or `null`). Additive — no existing
      // field is renamed or removed; existing consumers are unaffected.
      path: declaredPath,
      // Self-evident, per-entry identifier — Reuse Audit entries in spec.md
      // have no explicit R-ID, so we synthesize one. Used by failure records
      // in lieu of the previously hard-pinned 'R1'.
      requirementId: `REUSE-${entries.length + 1}`,
    });
  }
  if (entries.length === 0) {
    if (sawNoneMarker) return entries; // audited, nothing reusable — valid empty
    throw new Error(
      `readReuseAudit: '## Reuse Audit' section in ${path.join(specDir, 'spec.md')} contains no parseable entries. ` +
        'Expected bullets shaped `- \\`Symbol\\` MUST be reused from \\`path\\` — reason` ' +
        '(or `may be reused` for mirrored patterns), or `- None — no reusable symbols found`.'
    );
  }
  return entries;
}

/**
 * Collect the union of file paths declared under each `## Task N` block's
 * `### Files in scope` bullet list — the only recognized scope heading.
 * Returns `null` when no task declares the subsection.
 *
 * B7 fix: `extractBulletPaths` returns `[]` for present-but-empty sections
 * and `null` only when the heading is absent, so an author who explicitly
 * writes `### Files in scope` with zero bullets ("no files required") is
 * honored.
 */
function readSuggestedScopeFiles(tasksDir) {
  const text = specShared.readTasks(tasksDir);
  if (!text) return null;
  const taskHeader = /^##\s+Task\s+(\d+)\b/gim;
  const files = new Set();
  let sawAny = false;
  let m;
  while ((m = taskHeader.exec(text)) !== null) {
    const after = text.slice(m.index + m[0].length);
    const nextTop = after.match(/^##\s/m);
    const block = nextTop ? after.slice(0, nextTop.index) : after;
    const filesInScope = extractBulletPaths(block, /^###\s+Files in scope\b/im);
    if (filesInScope !== null) {
      sawAny = true;
      for (const p of filesInScope) files.add(p);
    }
  }
  if (!sawAny) return null;
  return Array.from(files);
}

function extractBulletPaths(block, headingRe) {
  const h = block.match(headingRe);
  if (!h) return null;
  const after = block.slice(h.index + h[0].length);
  const nextHeading = after.match(/^#{2,3}\s/m);
  const sub = nextHeading ? after.slice(0, nextHeading.index) : after;
  const out = [];
  for (const line of sub.split('\n')) {
    const m = line.match(/^\s*[-*]\s+`([^`]+)`/);
    if (m) out.push(m[1]);
  }
  // Present-but-empty: return [] so the caller distinguishes it from absent
  // (null). Honors authored intent: empty Files-in-scope means "no files".
  return out;
}

/**
 * Return EVERY `###`-bounded block whose heading matches `headingRe`.
 *
 * Unlike work-spec's `sliceSection` (which captures from the matched heading
 * all the way to the next `## ` h2 — correct for h2 sections, but for an h3
 * heading it swallows every sibling h3 subsection that follows), each
 * returned block ends at the NEXT `###` OR `## ` heading. And unlike
 * `sliceSection` it walks the whole document (global), not just the first
 * match — one block per matching task subsection.
 *
 * GH-408 / ECHO-5357 / ECHO-5813: `parseFilesOutOfScope` sliced Task 1's
 * `### Files explicitly out of scope` up to `## Task 2`, so backticked
 * tokens in the sibling `### Deliverables` / `### Test Command` /
 * `### Suggested Scope` subsections leaked into the out-of-scope set — and
 * only the first task's block was ever read.
 */
function sliceSubsections(text, headingRe) {
  if (!text) return [];
  const flags = headingRe.flags.includes('g') ? headingRe.flags : `${headingRe.flags}g`;
  const re = new RegExp(headingRe.source, flags);
  const blocks = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const after = text.slice(m.index + m[0].length);
    const next = after.match(/^#{2,3}\s/m);
    blocks.push(next ? after.slice(0, next.index) : after);
    if (re.lastIndex === m.index) re.lastIndex += 1; // zero-width safety
  }
  return blocks;
}

/**
 * Read the optional `tests.check.md` report produced by the tests-review
 * step. Returns `{ exists: true, content }` when present, otherwise
 * `{ exists: false }`. Callers decide whether absence is fatal.
 */
function readTestReport(tasksDir) {
  const p = path.join(tasksDir, 'tests.check.md');
  if (!fs.existsSync(p)) return { exists: false };
  const content = fs.readFileSync(p, 'utf8');
  return { exists: true, content };
}

module.exports = {
  readFile,
  readChangedFiles,
  readRequirementCoverage,
  parseCoverageTableRow,
  readBriefRequirements,
  parseMoscowRequirements,
  readReuseAudit,
  readSuggestedScopeFiles,
  readTestReport,
  sliceSubsections,
  // Re-exports from spec-side shared:
  ...specSharedReexports(specShared),
};
