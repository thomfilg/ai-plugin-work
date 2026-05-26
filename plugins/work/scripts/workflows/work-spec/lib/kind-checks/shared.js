/**
 * Shared helpers for kind-check modules.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

function readFile(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function sliceSection(text, headerRe) {
  if (!text) return '';
  const m = text.match(headerRe);
  if (!m) return '';
  const after = text.slice(m.index + m[0].length);
  const next = after.match(/^##\s/m);
  return next ? after.slice(0, next.index) : after;
}

/** Returns the raw text of brief.md, or '' if absent. */
function readBrief(tasksDir) {
  return readFile(path.join(tasksDir, 'brief.md')) || '';
}

/** Returns the raw text of spec.md, or '' if absent. */
function readSpec(tasksDir) {
  return readFile(path.join(tasksDir, 'spec.md')) || '';
}

/** Returns the raw text of tasks.md (if produced), or '' if absent. */
function readTasks(tasksDir) {
  return readFile(path.join(tasksDir, 'tasks.md')) || '';
}

/**
 * Pull file paths out of the `## Files to Create/Modify` section of spec.md.
 * Greps backticked paths AND bare-word paths that look like
 * filename-with-extension or `slash/separated/paths`.
 */
function filesInFilesToModify(specText) {
  const block = sliceSection(specText, /^##\s+Files to Create\/Modify(?=\s|$)/im);
  if (!block) return [];
  const out = new Set();
  // Backticked paths.
  const re1 = /`([^`\n]+)`/g;
  let m;
  while ((m = re1.exec(block)) !== null) {
    const t = m[1].trim();
    if (
      /^[\w./@-]+\.(?:ts|tsx|js|jsx|json|md|yml|yaml|sql|sh|prisma|mjs|cjs)$/i.test(t) ||
      /\//.test(t)
    ) {
      out.add(t);
    }
  }
  // Bullets with obvious paths.
  const re2 = /(?:^|\s)([a-zA-Z][\w./@-]*\/[\w./@-]+(?:\.[a-zA-Z0-9]+)?)/g;
  while ((m = re2.exec(block)) !== null) {
    out.add(m[1].trim());
  }
  return [...out];
}

/**
 * Best-effort detection of which task kinds are present. Scans spec.md
 * AND tasks.md for explicit kind markers like:
 *   - "### Task 1 (frontend)"
 *   - "kind: backend"
 *   - "@frontend" / "@backend" / "@e2e" tags
 *   - any of "frontend", "backend", "wiring", "e2e", "devops", "fullstack"
 *     mentioned as a stand-alone label.
 */
const KIND_NAMES = ['frontend', 'backend', 'wiring', 'e2e', 'devops', 'fullstack'];

function detectKinds(tasksDir) {
  const text = `${readSpec(tasksDir)}\n${readTasks(tasksDir)}`.toLowerCase();
  const present = new Set();
  for (const k of KIND_NAMES) {
    const re = new RegExp(`(?:^|[^a-z])${k}(?![a-z])`, 'i');
    if (re.test(text)) present.add(k);
  }
  return [...present];
}

/** True if brief.md explicitly forbids backend changes. */
function briefForbidsBackend(briefText) {
  if (!briefText) return false;
  return /no\s+backend\s+changes/i.test(briefText);
}

/** Heuristic: is a file path "backend-like"? */
function isBackendFile(p) {
  return (
    /(^|\/)app\/api\//.test(p) ||
    /(^|\/)lib\/.*\/schemas?\.(ts|js)$/.test(p) ||
    /(^|\/)prisma\//.test(p) ||
    /(^|\/)server\//.test(p)
  );
}

/** Heuristic: is a file path "frontend-like"? */
function isFrontendFile(p) {
  return (
    /(^|\/)components\//.test(p) ||
    /(^|\/)app\/.*\.(tsx|jsx)$/.test(p) ||
    /(^|\/)hooks\//.test(p) ||
    /(^|\/)pages\//.test(p)
  );
}

/** Heuristic: is a file path "e2e-like"? */
function isE2eFile(p) {
  return /(^|\/)tests\/e2e\//.test(p) || /\.spec\.(ts|tsx|js|jsx)$/.test(p);
}

/** Heuristic: is a file path "devops/infra-like"? */
function isDevopsFile(p) {
  return (
    /^\.github\//.test(p) ||
    /(^|\/)scripts\//.test(p) ||
    /(^|\/)\.?ci\//.test(p) ||
    /\.(yml|yaml)$/.test(p) ||
    /(^|\/)Dockerfile/.test(p)
  );
}

/** Heuristic: is a file path an "app-source" path (so devops should NOT touch it)? */
function isAppSourceFile(p) {
  return /(^|\/)app\//.test(p) || /(^|\/)lib\//.test(p) || /(^|\/)components\//.test(p);
}

module.exports = {
  readBrief,
  readSpec,
  readTasks,
  sliceSection,
  filesInFilesToModify,
  detectKinds,
  briefForbidsBackend,
  isBackendFile,
  isFrontendFile,
  isE2eFile,
  isDevopsFile,
  isAppSourceFile,
  KIND_NAMES,
};
