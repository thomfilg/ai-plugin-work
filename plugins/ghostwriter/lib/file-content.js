'use strict';

/**
 * file-content.js — attribution inside the FILES a change carries.
 *
 * The commit message and the pull request body are the loud places a tool
 * signs itself, and they are also the transient ones: a message scrolls away,
 * a description gets edited. A footer written into a source file is the one
 * that lasts. `// Generated with <tool>` at the top of a module, an
 * `Authored-by: <tool>` line in a header block, an attribution link dropped
 * into a README — each ships in the diff, appears in the pull request, and
 * stays in the tree afterwards. None of them is a commit message, so none of
 * the message passes ever sees them.
 *
 * The rules are the same ones. What differs is the READING:
 *
 *   - Documentation is read as PROSE (code fences and inline spans blanked).
 *     A file explaining a tool footer quotes it; the quote is the subject of
 *     the sentence, not a signature on the document.
 *   - Everything else is read STRICTLY. A comment is not a code fence, and an
 *     attribution sitting in one is a signature by any reading.
 *
 * Paths listed in `.ghostwriterignore` are exempt (see ignore.js). Nothing
 * else is: a file rule cannot be argued out of by where the file lives.
 */

const path = require('node:path');

const { checkText } = require('./attribution');
const { finding } = require('./finding');
const { isIgnored } = require('./ignore');
const { extractWriteTargets, extractWriteContent } = require('./runtime/tools');

/**
 * Extensions read as prose. Deliberately short: the cost of reading a source
 * file as prose is a missed footer, while the cost of reading a document
 * strictly is a blocked sentence about attribution — and documents are where
 * such sentences belong.
 */
const PROSE_EXTENSIONS = new Set(['.md', '.mdx', '.markdown', '.rst', '.adoc', '.txt', '.text']);

const ALLOW = Object.freeze({ blocked: false });

function isProseFile(filePath) {
  return PROSE_EXTENSIONS.has(path.extname(String(filePath || '')).toLowerCase());
}

/**
 * Check the text one file would carry.
 *
 * @param {string} filePath - used for the reading mode and the report label.
 * @param {string} text - the content being written, or the added lines of it.
 * @returns {null|object} a finding, or null when the text is clean.
 */
function checkFileText(filePath, text) {
  if (typeof text !== 'string' || !text) return null;
  const result = checkText(text, { prose: isProseFile(filePath), file: true });
  return result.ok ? null : finding(result, `${filePath || 'the written content'}`);
}

/**
 * Check every file a write would touch, stopping at the first finding.
 *
 * `onExempt` exists because an exemption that nobody sees is indistinguishable
 * from a rule that does not work. `.ghostwriterignore` is read from the tree
 * being checked — which is the point, since an exemption belongs in the diff
 * with the file it covers — but that only holds up if the exemption is
 * ANNOUNCED. A caller with somewhere to report (the CI scanner) names every
 * path it skipped; the PreToolUse hook passes nothing, because a hook that
 * writes to stderr while allowing a call breaks the fail-open contract.
 *
 * @param {Array<{path: string, text: string}>} files
 * @param {{cwd?: string, onExempt?: (path: string) => void, ignoreFrom?: string}} [opts]
 * @returns {{blocked: false}|object}
 */
/** Is this file exempt — and if so, say so before letting it past. */
function isExempt(file, cwd, ignoreFrom, onExempt) {
  if (!isIgnored(file.path, cwd, ignoreFrom)) return false;
  if (onExempt) onExempt(file.path);
  return true;
}

function inspectFileWrites(files, opts) {
  const { cwd = process.cwd(), onExempt, ignoreFrom } = opts || {};
  for (const file of files || []) {
    if (!file || isExempt(file, cwd, ignoreFrom, onExempt)) continue;
    const hit = checkFileText(file.path, file.text);
    if (hit) return hit;
  }
  return ALLOW;
}

const PATCH_HEADER_RE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/;
const PATCH_MOVE_RE = /^\*\*\* Move to: (.+)$/;
/** `+++ b/path` — git's own name for the file a hunk lands in. */
const DIFF_HEADER_RE = /^\+\+\+ (?:b\/)?(.+)$/;
/** The line that always precedes it. A `+++` anywhere else is content. */
const DIFF_OLD_FILE_RE = /^--- /;
/** `diff --git a/x b/x` — opens a file's header block. */
const DIFF_FILE_RE = /^diff --git /;
/** `@@ -1 +1 @@` — closes it. Everything after is hunk content. */
const DIFF_HUNK_RE = /^@@ /;

/**
 * The lines each file GAINS, in either patch dialect.
 *
 * Additions only, deliberately. A change that DELETES an attribution shows the
 * offending line with a `-`, and reading the whole patch would block the very
 * cleanup this plugin exists to encourage. Context lines are the same story:
 * attribution already in the tree is a fact about history, and this reads what
 * a change proposes to add to it.
 *
 * Split per file rather than flattened, because the association between a line
 * and the file it lands in is the whole input to the prose/strict decision — a
 * markdown paragraph read strictly and a source comment read as prose are both
 * wrong answers, arrived at by discarding what the patch already says.
 *
 * EVERY added line counts, including one that begins with `+`. A source line
 * of `++i;` arrives in the diff as `+++i;`, and a reader that skips anything
 * starting with `+++` drops it — which is a way to write an attribution the
 * scanner never sees.
 *
 * So headers are told apart from content by WHERE THEY ARE, and position here
 * means two things, because either alone can be forged:
 *
 *   - the header BLOCK: `diff --git` opens it, the first `@@` closes it.
 *     Inside a hunk, `--- x` and `+++ y` are a deleted line and an added line
 *     whose text happens to start with `--` and `++`. Under `-U0` those two
 *     land adjacent with nothing between them.
 *   - the PAIR: within that block, `+++ b/path` is a header only directly
 *     after the `--- a/path` that always precedes it.
 *
 * This assumes git's own output, which always emits `diff --git` per file.
 * A hand-rolled `diff -u` with several files concatenated and no such line
 * would have only the second guard, which is the weaker one — nothing this
 * plugin runs produces that, and every caller here shells out to git.
 *
 * @param {string} text
 * @param {(line: string, at: {prev: string, inHunk: boolean}) =>
 *   {path: string|null}|null} readHeader - the path a following block lands
 *   in; `null` when the line is not a header, and a null `path` for a header
 *   that names no destination (a deletion).
 * @returns {Array<{path: string, text: string}>}
 */
/** Advance the header/hunk position past one line. */
function advance(at, line) {
  if (DIFF_FILE_RE.test(line)) at.inHunk = false;
  else if (DIFF_HUNK_RE.test(line)) at.inHunk = true;
  at.prev = line;
}

function additions(text, readHeader) {
  if (typeof text !== 'string') return [];
  const files = [];
  let current = null;
  const at = { prev: '', inHunk: false };
  for (const line of text.split('\n')) {
    const header = readHeader(line, at);
    advance(at, line);
    if (header) {
      current = header.path ? { path: header.path, lines: [] } : null;
      if (current) files.push(current);
    } else if (current && line.startsWith('+')) {
      // The leading `+` is the diff's, and only the first one: `+++i;` is the
      // line `++i;`, not furniture.
      current.lines.push(line.slice(1));
    }
  }
  return files.map((file) => ({ path: file.path, text: file.lines.join('\n') }));
}

/** Codex `apply_patch` payloads (`*** Add File: …`). */
function patchAdditions(patchText) {
  return additions(patchText, (line) => {
    const header = PATCH_HEADER_RE.exec(line) || PATCH_MOVE_RE.exec(line);
    return header ? { path: header[1].trim() } : null;
  });
}

/** Unified diffs — `git diff`, `git diff --cached`, a mailed patch. */
function unifiedAdditions(diffText) {
  return additions(diffText, (line, at) => {
    if (at.inHunk || !DIFF_OLD_FILE_RE.test(at.prev)) return null;
    const header = DIFF_HEADER_RE.exec(line);
    if (!header) return null;
    const name = header[1].trim();
    // `/dev/null` is a deletion: the file gains nothing because it is gone.
    return { path: name === '/dev/null' ? null : name };
  });
}

/**
 * The files one write-tool call would author, as `{path, text}` pairs.
 *
 * Claude's write tools name a single target and carry its new text in a field;
 * codex `apply_patch` carries several files in one payload, so it is split
 * rather than flattened — see patchAdditions.
 *
 * @param {string} rawToolName
 * @param {object} toolInput
 * @returns {Array<{path: string, text: string}>}
 */
function writeFiles(rawToolName, toolInput) {
  if (rawToolName === 'apply_patch') return patchAdditions(toolInput && toolInput.command);
  const [target] = extractWriteTargets(rawToolName, toolInput || {}, 'claude');
  if (!target) return [];
  return extractWriteContent(rawToolName, toolInput).map((text) => ({ path: target.path, text }));
}

module.exports = {
  inspectFileWrites,
  writeFiles,
  unifiedAdditions,
  checkFileText,
  patchAdditions,
  isProseFile,
  PROSE_EXTENSIONS,
};
