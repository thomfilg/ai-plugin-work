#!/usr/bin/env node
'use strict';

/**
 * lint-vocab — CI ratchet against NEW un-rendered Claude tool-name literals
 * in the emitted-instruction code paths (WP-10, design §F.5).
 *
 * The instruction vocabulary (factories/runtime/vocab.js, vendored per
 * plugin) fixes the RENDERER, not the many files that mention Claude tool
 * names in personas/docs. This lint pins the chokepoint files that HAVE
 * adopted the vocabulary (WP-08): any string literal they emit containing
 * `Task(` / `AskUserQuestion` / `TodoWrite` / `Monitor(` / `/plugin:skill`
 * must flow through a renderer call (`T`, `renderInstruction`,
 * `renderQuestionText`, `renderDelegateForRuntime`) or be a documented
 * exception below. Comments are ignored; only string/template literals count.
 *
 * Documented exceptions (do NOT "fix" these):
 *   - work-pr.workflow.js plan-table `command` labels — `Task(pr-generator)`,
 *     `Task(pr-post-generator)`, `internal + AskUserQuestion` are DISPLAY
 *     METADATA (design §F.4): the step registry keys stay stable, and the one
 *     behavior-bearing label (screenshot gate) is already `T('tool.question')`.
 *   - phase1-agents.js blocked-path recovery text — "write the report
 *     yourself with the Write tool": the vocab has no `Write` token (on codex
 *     the Write hook lane alias-fires for apply_patch, and the reason string
 *     is operator-recovery prose, not a tool dispatch). Not in the flagged
 *     pattern set; recorded here so the decision is auditable (WP-10).
 *
 * Newly vocabulary-adopting files: add their repo-relative path to SCOPE.
 *
 * Usage: node scripts/lint-vocab.js
 * Exit codes: 0 clean, 1 violations, 2 config error.
 */

const path = require('node:path');
const fs = require('node:fs');

const { runFileLint } = require('./lib/lint-cli');
const { scanStrings } = require('./lib/js-strings');

const REPO_ROOT = path.join(__dirname, '..');

// Emitted-instruction chokepoints that adopted the vocabulary (WP-08 surface).
const SCOPE = [
  'plugins/work/scripts/workflows/work/lib/instruction-builder.js',
  'plugins/work/scripts/workflows/work/lib/step-enrichments/implement.js',
  'plugins/work/scripts/workflows/work/lib/step-enrichments/implement-gate/planner-hold.js',
  'plugins/work/scripts/workflows/work/steps/brief-gate.js',
  'plugins/work/scripts/workflows/work/steps/task-review.js',
  'plugins/work/scripts/workflows/work-pr/work-pr.workflow.js',
  'plugins/work/scripts/workflows/follow-up/lib/steps/fix-reviews.js',
  'plugins/work/scripts/workflows/follow-up/lib/steps/fix-ci.js',
  'plugins/work/scripts/workflows/check/lib/steps/phase1-agents.js',
  'plugins/work/scripts/workflows/check/lib/steps/phase2-consensus.js',
];

// Calls whose string arguments are runtime-rendered (any enclosing frame).
const RENDER_FNS = new Set([
  'T',
  'renderInstruction',
  'renderQuestionText',
  'renderDelegateForRuntime',
]);

const PATTERNS = [
  { label: 'Task(', re: /\bTask\(/ },
  { label: 'AskUserQuestion', re: /\bAskUserQuestion\b/ },
  { label: 'TodoWrite', re: /\bTodoWrite\b/ },
  { label: 'Monitor(', re: /\bMonitor\(/ },
  { label: '/plugin:skill', re: /(?:^|[\s(`'"])\/[a-z][a-z0-9-]*:[a-z][a-z0-9-]*\b/ },
];

// file (repo-relative) → exact substrings allowed in that file's literals.
const EXCEPTIONS = {
  'plugins/work/scripts/workflows/work-pr/work-pr.workflow.js': [
    'Task(pr-generator)', // plan-table display label (design §F.4)
    'Task(pr-post-generator)', // plan-table display label (design §F.4)
    'internal + AskUserQuestion', // plan-table display label (design §F.4)
  ],
};

function isExcepted(rel, content) {
  const allowed = EXCEPTIONS[rel] || [];
  return allowed.some((snippet) => content.includes(snippet));
}

function excerpt(content) {
  const flat = content.replace(/\s+/g, ' ').trim();
  return flat.length > 60 ? `${flat.slice(0, 57)}…` : flat;
}

function lintFile(file) {
  const rel = path.relative(REPO_ROOT, file).split(path.sep).join('/');
  let source;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return [`unreadable: ${err.message}`];
  }
  const violations = [];
  for (const str of scanStrings(source)) {
    if (str.calls.some((c) => RENDER_FNS.has(c))) continue;
    if (isExcepted(rel, str.content)) continue;
    for (const { label, re } of PATTERNS) {
      if (re.test(str.content)) {
        violations.push(
          `line ${str.line}: un-rendered "${label}" literal in emitted string — route it through the instruction vocab (T/renderInstruction/renderQuestionText) or document an exception in scripts/lint-vocab.js: "${excerpt(str.content)}"`
        );
      }
    }
  }
  return violations;
}

function main() {
  const files = SCOPE.map((rel) => path.join(REPO_ROOT, rel));
  const missing = files.filter((f) => !fs.existsSync(f));
  if (missing.length > 0) {
    console.error(
      `lint-vocab: SCOPE file(s) missing — update SCOPE in scripts/lint-vocab.js:\n${missing.map((f) => `  ${path.relative(REPO_ROOT, f)}`).join('\n')}`
    );
    process.exit(2);
  }
  process.exit(runFileLint({ name: 'lint-vocab', files, lintFile, repoRoot: REPO_ROOT }));
}

if (require.main === module) main();

module.exports = { lintFile, SCOPE, PATTERNS, EXCEPTIONS };
