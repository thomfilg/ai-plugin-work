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
const { spawnSync } = require('node:child_process');

const specShared = require('../../../work-spec/lib/kind-checks/shared');
const config = require('../../../lib/config');

function readFile(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Get the changed-file list. Prefer the snapshot pr-context.json (written
 * by pr-next.js diff_audit) so completion-checker sees the same diff the
 * PR phase locked in. Fall back to git diff if absent.
 */
function readChangedFiles(ctx) {
  const ctxPath = path.join(ctx.tasksDir, 'pr-context.json');
  if (fs.existsSync(ctxPath)) {
    try {
      const j = JSON.parse(fs.readFileSync(ctxPath, 'utf8'));
      if (Array.isArray(j.files)) return j.files.slice();
    } catch {
      /* fall through */
    }
  }
  const root = ctx.worktreeRoot || process.cwd();
  // Honor BASE_BRANCH / symbolic-ref so dev-based repos don't fall back to
  // origin/main (which is behind merges and surfaces phantom files).
  for (const base of config.getDiffBaseCandidates({ cwd: root })) {
    const r = spawnSync('git', ['diff', '--name-only', `${base}...HEAD`], {
      cwd: root,
      encoding: 'utf8',
    });
    if (r.status === 0) {
      return r.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  return [];
}

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
    for (const line of reqBlock.split('\n')) {
      const m = line.match(/^\s*[-*]\s+([A-Za-z0-9_-]+)\s*$/);
      if (m) {
        rows.push({
          id: m[1],
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
  }
  return rows;
}

/**
 * Parse `## Requirement Coverage` table out of tasks.md.
 * Returns array of { id, description, status, evidence } records.
 * Falls back to per-task `### Requirements Covered` subsections when the
 * top-level table is absent (R4).
 */
// eslint-disable-next-line complexity -- allowlisted pre-existing complexity; see .quality-exceptions
function readRequirementCoverage(tasksDir) {
  const text = specShared.readTasks(tasksDir);
  if (!text) return [];
  const block = specShared.sliceSection(text, /^##\s+Requirement Coverage\b/im);
  const rows = [];
  if (block) {
    for (const line of block.split('\n')) {
      if (!/^\|/.test(line)) continue;
      const cells = line
        .split('|')
        .slice(1, -1)
        .map((c) => c.trim());
      if (cells.length < 2) continue;
      if (/^-+$/.test(cells[0])) continue;
      if (/^(id|requirement|req)$/i.test(cells[0])) continue;
      rows.push({
        id: cells[0],
        description: cells[1] || '',
        status: cells[2] || '',
        evidence: cells[3] || '',
        source: 'table',
      });
    }
  }
  if (rows.length === 0) return readRequirementCoverageFromSubsections(text);
  return rows;
}

/**
 * Pull bullet lines that begin with P0 / P1 markers out of brief.md
 * `## Requirements` section. Used to enumerate must-have requirements.
 */
function readBriefRequirements(tasksDir) {
  const brief = specShared.readBrief(tasksDir);
  if (!brief) return [];
  const block =
    specShared.sliceSection(brief, /^##\s+Requirements\b/im) ||
    specShared.sliceSection(brief, /^##\s+Must.have\b/im);
  if (!block) return [];
  const items = [];
  for (const line of block.split('\n')) {
    const m = line.match(/^\s*[-*]\s+(?:\*\*)?(P[0-2])(?:\*\*)?\s*[:-]?\s*(.+)$/i);
    if (m) items.push({ priority: m[1].toUpperCase(), text: m[2].trim() });
  }
  return items;
}

/**
 * Parse the `## Reuse Audit` section of spec.md and return an array of
 * `{ symbol, line, mustReuse }` records. Returns `null` when the section
 * is absent (signals "spec doesn't declare reuse"). Throws when the
 * section is present but contains no parseable entries (signals
 * malformed authoring rather than absence).
 *
 * Recognized bullet shape:
 *   - `Symbol` MUST be reused from `path/to/file.ext`
 * Soft-reuse lines (without MUST) are captured with `mustReuse: false`.
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
  for (let i = 0; i < blockLines.length; i += 1) {
    const raw = blockLines[i];
    const m = raw.match(
      /^\s*[-*]\s+`([^`]+)`\s+(MUST\s+be\s+reused|be\s+reused|may\s+be\s+reused)/i
    );
    if (!m) continue;
    const mustReuse = /MUST/i.test(m[2]);
    entries.push({
      symbol: m[1],
      // headingLine is the 1-indexed line of `## Reuse Audit`; sliceSection
      // returns text AFTER that heading, so body index 0 corresponds to the
      // line immediately below the heading (`headingLine + 1`). Previous
      // form `headingLine + i` was off-by-one and pointed every entry one
      // line above its actual location in spec.md (review feedback).
      line: headingLine + 1 + i,
      mustReuse,
      // Self-evident, per-entry identifier — Reuse Audit entries in spec.md
      // have no explicit R-ID, so we synthesize one. Used by failure records
      // in lieu of the previously hard-pinned 'R1'.
      requirementId: `REUSE-${entries.length + 1}`,
    });
  }
  if (entries.length === 0) {
    throw new Error(
      `readReuseAudit: '## Reuse Audit' section in ${path.join(specDir, 'spec.md')} contains no parseable entries`
    );
  }
  return entries;
}

/**
 * Collect the union of file paths declared under per-task scope subsections
 * in tasks.md. For each `## Task N` block:
 *   - If `### Files in scope` is present (even with zero bullets), its bullet
 *     list wins (Open Q #3: Files-in-scope is canonical when authored).
 *   - Otherwise, fall back to `### Suggested Scope` bullets.
 * Returns `null` when neither subsection appears in any task.
 *
 * B7 fix: `extractBulletPaths` now returns `[]` for present-but-empty
 * sections and `null` only when the heading is absent. An author who
 * explicitly authors `### Files in scope` with zero bullets ("no files
 * required") is honored instead of silently falling through to the legacy
 * Suggested Scope, which may enforce different files.
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
      continue;
    }
    const suggested = extractBulletPaths(block, /^###\s+Suggested Scope\b/im);
    if (suggested !== null) {
      sawAny = true;
      for (const p of suggested) files.add(p);
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
  // (null). Honors authored intent: empty Files-in-scope means "no files",
  // not "fall back to Suggested Scope".
  return out;
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
  readBriefRequirements,
  readReuseAudit,
  readSuggestedScopeFiles,
  readTestReport,
  // Re-exports from spec-side shared:
  readBrief: specShared.readBrief,
  readSpec: specShared.readSpec,
  readTasks: specShared.readTasks,
  sliceSection: specShared.sliceSection,
  filesInFilesToModify: specShared.filesInFilesToModify,
  detectKinds: specShared.detectKinds,
  MalformedTasksError: specShared.MalformedTasksError,
  preflightTasksManifest: specShared.preflightTasksManifest,
  briefForbidsBackend: specShared.briefForbidsBackend,
  isBackendFile: specShared.isBackendFile,
  isFrontendFile: specShared.isFrontendFile,
  isE2eFile: specShared.isE2eFile,
  isDevopsFile: specShared.isDevopsFile,
  isAppSourceFile: specShared.isAppSourceFile,
  KIND_NAMES: specShared.KIND_NAMES,
};
