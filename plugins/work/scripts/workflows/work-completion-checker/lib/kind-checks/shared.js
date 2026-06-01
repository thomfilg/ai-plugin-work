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

module.exports = {
  readFile,
  readChangedFiles,
  readRequirementCoverage,
  readBriefRequirements,
  // Re-exports from spec-side shared:
  readBrief: specShared.readBrief,
  readSpec: specShared.readSpec,
  readTasks: specShared.readTasks,
  sliceSection: specShared.sliceSection,
  filesInFilesToModify: specShared.filesInFilesToModify,
  detectKinds: specShared.detectKinds,
  briefForbidsBackend: specShared.briefForbidsBackend,
  isBackendFile: specShared.isBackendFile,
  isFrontendFile: specShared.isFrontendFile,
  isE2eFile: specShared.isE2eFile,
  isDevopsFile: specShared.isDevopsFile,
  isAppSourceFile: specShared.isAppSourceFile,
  KIND_NAMES: specShared.KIND_NAMES,
};
