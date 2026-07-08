/**
 * Shared helpers for qa-feature-tester kind-check modules.
 *
 * QA differs from code-checker / completion-checker: the agent is browser-
 * driving (Playwright / claude-in-chrome) and the validators look for
 * recorded test evidence in a `qa-feature.check.md` artifact rather than
 * grepping source files.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const specShared = require('../../../work-spec/lib/kind-checks/shared');

function readFile(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/** Read the agent-produced QA report; empty string if absent. */
function readQaReport(tasksDir) {
  return readFile(path.join(tasksDir, 'qa-feature.check.md')) || '';
}

/** Per-kind section header — e.g. `### Frontend QA`. */
function hasKindSection(reportText, kindLabel) {
  if (!reportText) return false;
  return new RegExp(`^###\\s+${kindLabel}\\s+QA\\b`, 'im').test(reportText);
}

/** Extract checklist items from a kind section. Returns { total, checked }. */
function checklistStats(reportText, kindLabel) {
  if (!reportText) return { total: 0, checked: 0 };
  const re = new RegExp(
    `^###\\s+${kindLabel}\\s+QA\\b([\\s\\S]*?)(?=\\n###\\s|\\n##\\s|$(?![\\s\\S]))`,
    'im'
  );
  const m = reportText.match(re);
  if (!m) return { total: 0, checked: 0 };
  const block = m[1];
  const items = block.match(/^- \[[ xX]\]/gm) || [];
  const checked = block.match(/^- \[[xX]\]/gm) || [];
  return { total: items.length, checked: checked.length };
}

module.exports = {
  readFile,
  readQaReport,
  hasKindSection,
  checklistStats,
  // Re-exports from spec-side shared:
  readBrief: specShared.readBrief,
  readSpec: specShared.readSpec,
  readTasks: specShared.readTasks,
  sliceSection: specShared.sliceSection,
  detectKinds: specShared.detectKinds,
  MalformedTasksError: specShared.MalformedTasksError,
  preflightTasksManifest: specShared.preflightTasksManifest,
  briefForbidsBackend: specShared.briefForbidsBackend,
  isBackendFile: specShared.isBackendFile,
  isFrontendFile: specShared.isFrontendFile,
  isE2eFile: specShared.isE2eFile,
  isDevopsFile: specShared.isDevopsFile,
  KIND_NAMES: specShared.KIND_NAMES,
};
