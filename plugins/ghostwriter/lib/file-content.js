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
 * ANNOUNCED. A caller with somewhere to report — the scanner CLI — names every
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
/**
 * `@@ -12,7 +9,5 @@` — and crucially, how long the hunk is. Both counts
 * default to 1 when omitted, which is what git writes for a single line.
 */
const DIFF_HUNK_RE = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

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
 * So headers are told apart from content by WHERE THEY ARE, and a hunk says
 * exactly where it ends: `@@ -a,b +c,d @@` declares how many lines of each
 * side follow, and every body line spends one of them. While a hunk still owes
 * lines, EVERY line in it is content — `--- x`, `+++ y`, even `diff --git a/z
 * b/z` — because that is what the format says they are. Nothing about a line's
 * shape can end a hunk early, so nothing about its shape can be forged into a
 * structural boundary.
 *
 * That matters because the shapes really do collide. Under `-U0`, deleting a
 * source line that starts `-- ` next to adding one that starts `++ ` puts
 * `--- old` and `+++ Generated with <tool>` adjacent with nothing between them.
 * Counting is what tells those apart from the real pair.
 *
 * Outside a hunk, `+++ b/path` is a header only directly after the
 * `--- a/path` that always precedes it.
 *
 * @param {string} text
 * @param {(line: string, at: {prev: string, inHunk: boolean}) =>
 *   {path: string|null}|null} readHeader - the path a following block lands
 *   in; `null` when the line is not a header, and a null `path` for a header
 *   that names no destination (a deletion).
 * @returns {Array<{path: string, text: string}>}
 */
/** Open a hunk, taking its declared length from its own header. */
function beginHunk(at, line) {
  const hunk = DIFF_HUNK_RE.exec(line);
  if (!hunk) return;
  at.oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
  at.newLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
}

/**
 * Spend one line of what the hunk owes. A context line belongs to both sides,
 * an addition only to the new one, a deletion only to the old. The `\` marker
 * for a missing final newline belongs to neither and is free.
 *
 * Anything else — which a well-formed diff does not contain — is counted as
 * context, so a malformed hunk still terminates rather than swallowing the
 * rest of the input.
 */
function consumeHunkLine(at, line) {
  if (line[0] === '\\') return;
  if (line[0] !== '+') at.oldLeft = Math.max(0, at.oldLeft - 1);
  if (line[0] !== '-') at.newLeft = Math.max(0, at.newLeft - 1);
}

/** Advance the position past one line. */
function advance(at, line) {
  if (at.inHunk) consumeHunkLine(at, line);
  else beginHunk(at, line);
  at.inHunk = at.oldLeft > 0 || at.newLeft > 0;
  at.prev = line;
}

function additions(text, readHeader) {
  if (typeof text !== 'string') return [];
  const files = [];
  let current = null;
  const at = { prev: '', inHunk: false, oldLeft: 0, newLeft: 0 };
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
