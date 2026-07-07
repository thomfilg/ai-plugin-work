#!/usr/bin/env node
'use strict';

/**
 * lint-skill-frontmatter — strict YAML gate for every `SKILL.md` frontmatter
 * (WP-10, design §G "Frontmatter hygiene").
 *
 * Codex parses SKILL.md frontmatter with a REAL YAML parser and SILENTLY
 * SKIPS the whole skill on any parse error (no warning — GT §3.1: unquoted
 * inner colon, tab indent, missing closing `---`). That is the worst failure
 * mode a skill can have, so this lint enforces a strict single-line-scalar
 * subset that both runtimes' parsers accept:
 *
 *   - line 1 is exactly `---`, and a closing `---` line exists
 *   - no TAB characters anywhere in the frontmatter
 *   - every line is `key: value` (keys `[A-Za-z][A-Za-z0-9_-]*`, no
 *     duplicates, no multi-line/block scalars)
 *   - `name` and `description` are present (codex requires both)
 *   - quoted values are single fully-closed scalars
 *   - plain (unquoted) values must be quoted when they contain `:`, `|`,
 *     `[`, or ` #`, end with `:`, or start with a YAML indicator character
 *
 * Usage:
 *   node scripts/lint-skill-frontmatter.js [--fix] [files...]
 *     default file set: every plugins/<plugin>/skills/**\/SKILL.md
 *     --fix: rewrite offending plain values as quoted scalars in place
 *
 * Exit codes: 0 clean, 1 violations, 2 config error.
 */

const fs = require('node:fs');

const { REPO_ROOT, listSkillFiles } = require('./lib/skill-files');
const { runFileLint } = require('./lib/lint-cli');

const KEY_LINE_RE = /^([A-Za-z][A-Za-z0-9_-]*):(.*)$/;
const REQUIRED_KEYS = ['name', 'description'];

// Chars that make a PLAIN scalar unsafe for the strict cross-runtime subset.
// `:`/`|`/`[` are the design §G quote-list; ` #` starts a YAML comment.
const PLAIN_UNSAFE_RE = /[:|[]| #/;
// YAML indicator characters that must not START a plain scalar.
const PLAIN_BAD_START_RE = /^[-?:,[\]{}#&*!|>'"%@`]/;

/**
 * Split raw file content into frontmatter lines + the rest.
 * Returns { lines, endIndex } or { error } when the fence is broken.
 */
function extractFrontmatter(raw) {
  const lines = raw.split('\n');
  if (lines[0] !== '---') return { error: 'first line must be exactly "---" (frontmatter open)' };
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') return { lines: lines.slice(1, i), endIndex: i };
  }
  return { error: 'missing closing "---" — codex silently skips the whole skill' };
}

/** Is `value` one single fully-quoted scalar (quote closed at end of line)? */
function isClosedQuoted(value) {
  // Single-quoted YAML: the only escape is '' (doubled quote).
  if (value[0] === "'") return /^'(?:[^']|'')*'$/.test(value);
  // Double-quoted YAML: backslash escapes.
  return /^"(?:[^"\\]|\\.)*"$/.test(value);
}

function lintPlainValue(key, value) {
  if (PLAIN_BAD_START_RE.test(value)) {
    return `${key}: plain value starts with YAML indicator "${value[0]}" — quote it`;
  }
  if (PLAIN_UNSAFE_RE.test(value) || value.endsWith(':')) {
    return `${key}: plain value contains ':', '|', '[', or ' #' — quote it (codex drops the skill on strict-YAML errors)`;
  }
  return null;
}

function lintValue(key, value) {
  if (value === '') return `${key}: empty value`;
  if (value[0] === '"' || value[0] === "'") {
    return isClosedQuoted(value) ? null : `${key}: unterminated/malformed quoted value`;
  }
  return lintPlainValue(key, value);
}

function lintFrontmatterLine(line, lineNo, seen, violations) {
  if (line.includes('\t')) {
    violations.push(`line ${lineNo}: TAB character in frontmatter (invalid YAML indentation)`);
  }
  const m = line.match(KEY_LINE_RE);
  if (!m) {
    violations.push(
      `line ${lineNo}: not a single-line "key: value" pair (multi-line/block scalars are outside the strict subset)`
    );
    return;
  }
  const [, key, rawValue] = m;
  if (seen.has(key)) violations.push(`line ${lineNo}: duplicate key "${key}"`);
  seen.add(key);
  if (rawValue !== '' && !rawValue.startsWith(' ')) {
    violations.push(`line ${lineNo}: missing space after "${key}:"`);
    return;
  }
  const problem = lintValue(key, rawValue.trim());
  if (problem) violations.push(`line ${lineNo}: ${problem}`);
}

function lintContent(raw) {
  const fm = extractFrontmatter(raw);
  if (fm.error) return [fm.error];
  const violations = [];
  const seen = new Set();
  fm.lines.forEach((line, i) => {
    if (line.trim() === '') return;
    lintFrontmatterLine(line, i + 2, seen, violations);
  });
  for (const key of REQUIRED_KEYS) {
    if (!seen.has(key)) violations.push(`required key "${key}" is missing`);
  }
  return violations;
}

function lintFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return [`unreadable: ${err.message}`];
  }
  return lintContent(raw);
}

/** Quote a plain scalar: single-quoted unless it contains ', else double. */
function quoteScalar(value) {
  if (!value.includes("'")) return `'${value}'`;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function fixLine(line) {
  const m = line.match(KEY_LINE_RE);
  if (!m) return line;
  const [, key, rawValue] = m;
  const value = rawValue.trim();
  if (value === '' || value[0] === '"' || value[0] === "'") return line;
  if (!lintPlainValue(key, value)) return line;
  return `${key}: ${quoteScalar(value)}`;
}

/** Rewrite quotable plain-value offenders in place. Returns true if changed. */
function fixFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const fm = extractFrontmatter(raw);
  if (fm.error) return false;
  const lines = raw.split('\n');
  let changed = false;
  for (let i = 1; i < fm.endIndex; i++) {
    const fixed = fixLine(lines[i]);
    if (fixed !== lines[i]) {
      lines[i] = fixed;
      changed = true;
    }
  }
  if (changed) fs.writeFileSync(file, lines.join('\n'));
  return changed;
}

function main() {
  const args = process.argv.slice(2);
  const fix = args.includes('--fix');
  const fileArgs = args.filter((a) => a !== '--fix');
  const files = fileArgs.length > 0 ? fileArgs : listSkillFiles();
  if (fix) {
    for (const file of files) {
      if (fixFile(file)) console.log(`fixed ${file}`);
    }
  }
  const code = runFileLint({
    name: 'lint-skill-frontmatter',
    files,
    lintFile,
    repoRoot: REPO_ROOT,
  });
  process.exit(code);
}

if (require.main === module) main();

module.exports = { lintContent, lintFile, fixFile, quoteScalar };
