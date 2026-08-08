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
 * @param {Array<{path: string, text: string}>} files
 * @param {{cwd?: string}} [opts]
 * @returns {{blocked: false}|object}
 */
function inspectFileWrites(files, opts) {
  const cwd = (opts && opts.cwd) || process.cwd();
  for (const file of files || []) {
    if (!file || isIgnored(file.path, cwd)) continue;
    const hit = checkFileText(file.path, file.text);
    if (hit) return hit;
  }
  return ALLOW;
}

const PATCH_HEADER_RE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/;
const PATCH_MOVE_RE = /^\*\*\* Move to: (.+)$/;

/**
 * Split a codex `apply_patch` payload into the lines each file GAINS.
 *
 * The runtime's `extractWriteContent` returns every added line as one blob,
 * which loses the association between a line and the file it lands in — and
 * that association is the whole input to the prose/strict decision. A markdown
 * paragraph read strictly and a source comment read as prose are both wrong
 * answers, arrived at by throwing away information the patch already carries.
 *
 * @param {string} patchText
 * @returns {Array<{path: string, text: string}>}
 */
function patchAdditions(patchText) {
  if (typeof patchText !== 'string') return [];
  const files = [];
  let current = null;
  for (const line of patchText.split('\n')) {
    const header = PATCH_HEADER_RE.exec(line) || PATCH_MOVE_RE.exec(line);
    if (header) {
      current = { path: header[1].trim(), lines: [] };
      files.push(current);
      continue;
    }
    // `+++`/`---` are diff furniture, not content. A real added line that
    // begins with `+` keeps it: `++i;` arrives as `+++i;` and slicing one
    // character leaves it intact.
    if (current && line.startsWith('+') && !line.startsWith('+++'))
      current.lines.push(line.slice(1));
  }
  return files.map((file) => ({ path: file.path, text: file.lines.join('\n') }));
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
  checkFileText,
  patchAdditions,
  isProseFile,
  PROSE_EXTENSIONS,
};
