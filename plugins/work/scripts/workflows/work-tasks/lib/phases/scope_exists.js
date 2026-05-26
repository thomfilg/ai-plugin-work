/**
 * scope_exists.js — tasks-phase validator that catches placeholder paths
 * and non-existent files in `### Files in scope` BEFORE the implement
 * gate gets wedged trying to match `CHANGED_FILES` against them.
 *
 * Rules per entry in `### Files in scope`:
 *   - Placeholder syntax in the path → always block.
 *     Examples: `<ci-file>.yml`, `{component}.tsx`, `path/TBD/foo.ts`, `XXX`, `???`.
 *   - No marker (default = MODIFY) → file MUST exist at repo root.
 *   - `(NEW)` marker → file does not need to exist (creating it).
 *   - `(DELETE)` marker → file MUST exist (gate verifies before allowing removal).
 *
 * Glob paths (containing `*`, `?`, `[`, `]`, `{`, `}`) are accepted when
 * the non-glob directory prefix exists.
 *
 * Checkpoint tasks ship no code; their `### Files in scope` is informational
 * and skipped here.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { TASKS_PHASES } = require('../../tasks-phase-registry');

const PLACEHOLDER_RE = /<[^>]+>|\{[^}]+\}|\bTBD\b|\bXXX\b|\?\?\?/;
const GLOB_CHAR_RE = /[*?[\]{}]/;
const VALID_MARKERS = new Set(['NEW', 'DELETE']);

function readFile(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Parse one `### Files in scope` section's bullet list. Each bullet looks
 * like:
 *   - `path/to/file.ts` (NEW) — optional trailing prose
 *   - `path/to/file.ts` — modified file (default MODIFY)
 *   - `path/to/file.ts`
 *
 * @param {string} scopeSectionText
 * @returns {{path:string, marker:('NEW'|'DELETE'|null)}[]}
 */
function parseScopeEntries(scopeSectionText) {
  if (!scopeSectionText) return [];
  const out = [];
  const lineRe = /^\s*-\s+`([^`\n]+)`([^\n]*)$/gm;
  let m;
  while ((m = lineRe.exec(scopeSectionText)) !== null) {
    const filePath = m[1].trim();
    const tail = m[2] || '';
    const markerMatch = tail.match(/\((NEW|DELETE)\)/i);
    const marker = markerMatch ? markerMatch[1].toUpperCase() : null;
    out.push({ path: filePath, marker });
  }
  return out;
}

/**
 * Parse `## Task N` blocks from tasks.md.
 *
 * @param {string} text
 * @returns {{num:number, type:(string|null), entries:Array}[]}
 */
function parseTaskBlocks(text) {
  if (!text) return [];
  const out = [];
  const parts = text.split(/^##\s+Task\s+(\d+)/m);
  for (let i = 1; i < parts.length; i += 2) {
    const num = Number(parts[i]);
    const body = (parts[i + 1] || '').replace(/\n## (?!Task\s)\S[\s\S]*$/, '');
    const scopeMatch = body.match(
      /###\s+Files in scope[^\n]*\n([\s\S]*?)(?=\n###\s|\n## |$(?![\s\S]))/
    );
    const typeMatch = body.match(/###\s+Type\s*\n([^\n#]+)/);
    const type = typeMatch ? typeMatch[1].trim().toLowerCase() : null;
    const entries = parseScopeEntries(scopeMatch ? scopeMatch[1] : '');
    out.push({ num, type, entries });
  }
  return out;
}

/**
 * Check whether a path (or its non-glob directory prefix) exists at repoRoot.
 *
 * @param {string} p
 * @param {string} repoRoot
 * @returns {boolean}
 */
function pathOrPrefixExists(p, repoRoot) {
  if (!p || !repoRoot) return false;
  const norm = String(p).replace(/^\.\//, '');
  if (GLOB_CHAR_RE.test(norm)) {
    const firstGlob = norm.search(GLOB_CHAR_RE);
    let prefix = norm.slice(0, firstGlob);
    const slash = prefix.lastIndexOf('/');
    prefix = slash >= 0 ? prefix.slice(0, slash) : '';
    // Top-level glob (`*.md`) can't be verified — accept.
    if (!prefix) return true;
    try {
      return fs.statSync(path.join(repoRoot, prefix)).isDirectory();
    } catch {
      return false;
    }
  }
  try {
    fs.statSync(path.join(repoRoot, norm));
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate a single parsed task block.
 *
 * @param {{num:number, type:(string|null), entries:Array}} b
 * @param {string} repoRoot
 * @returns {string[]} error messages
 */
function validateBlock(b, repoRoot) {
  const errors = [];
  if (b.type === 'checkpoint') return errors;
  for (const e of b.entries) {
    if (PLACEHOLDER_RE.test(e.path)) {
      errors.push(
        `Task ${b.num} \`### Files in scope\` has placeholder path \`${e.path}\` — ` +
          'resolve the exact filename now (no `<...>`, `{...}`, `TBD`, `XXX`, `???`). ' +
          'Inspect the codebase and write the real path before advancing.'
      );
      continue;
    }
    if (e.marker === 'NEW') continue;
    if (e.marker === 'DELETE') {
      if (!pathOrPrefixExists(e.path, repoRoot)) {
        errors.push(
          `Task ${b.num} \`### Files in scope\` marks \`${e.path}\` as \`(DELETE)\` ` +
            'but the file does not exist at repo root — either correct the path or drop the entry.'
        );
      }
      continue;
    }
    if (!pathOrPrefixExists(e.path, repoRoot)) {
      errors.push(
        `Task ${b.num} \`### Files in scope\` lists \`${e.path}\` which does not exist at repo root. ` +
          'Either (a) add the `(NEW)` marker if you are creating it, ' +
          '(b) add the `(DELETE)` marker if removing it, or (c) fix the path.'
      );
    }
  }
  return errors;
}

/**
 * Validate `tasks.md` at `tasksDir` against `repoRoot`.
 *
 * @param {string} tasksDir
 * @param {string} repoRoot
 * @returns {string[]} flat list of error messages (empty when valid)
 */
function validateArtifacts(tasksDir, repoRoot) {
  const errors = [];
  const text = readFile(path.join(tasksDir, 'tasks.md'));
  if (!text) {
    errors.push(`Missing ${path.join(tasksDir, 'tasks.md')}.`);
    return errors;
  }
  const blocks = parseTaskBlocks(text);
  if (!blocks.length) {
    errors.push('No `## Task N` blocks — re-run draft phase first.');
    return errors;
  }
  for (const b of blocks) errors.push(...validateBlock(b, repoRoot));
  return errors;
}

function validate(ctx) {
  const repoRoot = ctx.worktreeRoot || ctx.repoRoot || ctx.tasksDir;
  const errors = validateArtifacts(ctx.tasksDir, repoRoot);
  if (errors.length) return { ok: false, errors };
  return { ok: true };
}

function instructions(ctx) {
  return [
    '# tasks-next — Phase 6 of 9: SCOPE EXISTS',
    `Ticket: ${ctx.ticket}`,
    '',
    '### What I check',
    '- Every path under `### Files in scope` either exists at the repo root,',
    '  or carries an explicit `(NEW)` / `(DELETE)` marker.',
    '- Reject placeholder paths: `<...>`, `{...}`, `TBD`, `XXX`, `???`.',
    '- Glob paths accepted when the non-glob directory prefix exists.',
    '- Checkpoint tasks are skipped (they ship no code).',
    '',
    '### Marker convention',
    '- `` `path/to/file.ts` `` — file must exist (MODIFY, default)',
    '- `` `path/to/file.ts` (NEW) `` — file does not exist yet (creating it)',
    '- `` `path/to/file.ts` (DELETE) `` — file must exist; will be removed',
    '',
    'When validation fails, fix `tasks.md` paths and re-run me.',
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(TASKS_PHASES.scope_exists, {
    next: TASKS_PHASES.gherkin_link,
    validate,
    instructions,
  });
};

// Exports for tests + reuse
module.exports.parseScopeEntries = parseScopeEntries;
module.exports.parseTaskBlocks = parseTaskBlocks;
module.exports.pathOrPrefixExists = pathOrPrefixExists;
module.exports.validateBlock = validateBlock;
module.exports.validateArtifacts = validateArtifacts;
module.exports.PLACEHOLDER_RE = PLACEHOLDER_RE;
module.exports.VALID_MARKERS = VALID_MARKERS;
