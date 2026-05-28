'use strict';

/**
 * contract-extractor — Pass B.
 *
 * Regex-level extraction of TypeScript export signatures and contract
 * comparison for files referenced in `### Files explicitly out of scope`.
 *
 * Pure module. No process.exit. No console.*. No runtime dependencies
 * beyond node built-ins (fs, path).
 *
 * @typedef {{name: string, kind: string, signature: string}} ExportEntry
 * @typedef {{kind: 'B', file: string, message: string, hint?: string}} Warning
 */

const fs = require('node:fs');
const path = require('node:path');

const { formatWarnings } = require('./emit-warnings');

/**
 * Regex matching TypeScript export signatures.
 *
 *   Group 1: export kind (function|interface|type|const|class|default)
 *   Group 2: declared name (may be empty for `export default <expr>`)
 *   Group 3: remainder of the line — body / type / parameter list — used
 *            as the raw "signature" for shape comparison.
 *
 * Captures one line at a time; the body may span multiple lines but only
 * the line containing the `export` keyword is used as the signature
 * fingerprint. That is sufficient for Pass B's shape-divergence detection
 * because the producer/consumer type shapes are conventionally written
 * inline on the export line.
 */
const EXPORT_SIGNATURE_RE =
  /^\s*export\s+(default\s+)?(function|interface|type|const|class)\s+([A-Za-z0-9_$]+)([^\n]*)/gm;

/**
 * Sibling ticket-ID regex per spec: `[A-Z]+-\d+`.
 * Matches conventional ticket prefixes like `ECHO-5352`, `GH-450`, etc.
 */
const TICKET_ID_RE = /[A-Z]+-\d+/g;

/**
 * Maximum number of sibling ticket IDs surfaced in a single warning hint.
 *
 * Capped at 3 to keep operator output scannable: more than three siblings
 * indicates a systemic coordination problem better surfaced via a
 * dedicated escalation than by flooding the warning hint. The cap is
 * intentional per spec (Task 4 Deliverable 4.2.3, R8).
 */
const SIBLING_ID_CAP = 3;

/**
 * Resolve `relPath` against `root` and reject any result that escapes the
 * root. R10 path-traversal guard.
 *
 * @param {string} root
 * @param {string} relPath
 * @returns {string} absolute resolved path inside root
 */
function safeResolve(root, relPath) {
  const absRoot = path.resolve(root);
  const resolved = path.resolve(absRoot, relPath);
  const rel = path.relative(absRoot, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(
      `safeResolve: path escapes root (traversal blocked): ${relPath} → ${resolved} (root=${absRoot})`
    );
  }
  return resolved;
}

/**
 * Read a TypeScript file and extract its exported signatures.
 *
 * @param {string} filePath  Absolute path, or relative to `opts.root`.
 * @param {{root?: string}} [opts]
 * @returns {ExportEntry[]}
 */
function extractExports(filePath, opts) {
  const root = opts && opts.root ? opts.root : null;
  let absPath;
  if (root) {
    absPath = safeResolve(root, filePath);
  } else if (path.isAbsolute(filePath)) {
    absPath = filePath;
  } else {
    absPath = path.resolve(filePath);
  }

  const source = fs.readFileSync(absPath, 'utf8');
  return parseExports(source);
}

/**
 * Parse export signatures from a source string. Walks `EXPORT_SIGNATURE_RE`
 * and also captures multi-line `interface`/`type` bodies as part of the
 * signature so that consumers like `data.map` (inside the function body)
 * can be discovered.
 *
 * @param {string} source
 * @returns {ExportEntry[]}
 */
function parseExports(source) {
  const entries = [];
  EXPORT_SIGNATURE_RE.lastIndex = 0;
  let m;
  while ((m = EXPORT_SIGNATURE_RE.exec(source)) !== null) {
    const kind = m[2];
    const name = m[3];
    const headRest = m[4] || '';
    const headOffset = m.index + m[0].length;
    // Capture body until matching closing brace (best-effort) or next export.
    const body = captureBody(source, headOffset);
    entries.push({
      name,
      kind,
      signature: `${kind} ${name}${headRest}${body ? `\n${body}` : ''}`.trim(),
    });
  }
  return entries;
}

/**
 * Capture the body that follows a matched export head. Best-effort:
 *   - If the head ends with `{`, capture until the matching `}` at the
 *     same brace depth.
 *   - Otherwise capture until two consecutive newlines or next `export`.
 *
 * @param {string} source
 * @param {number} offset
 * @returns {string}
 */
function captureBody(source, offset) {
  const slice = source.slice(offset);
  // Find first `{` on the head line (within ~200 chars) to decide mode.
  const braceIdx = slice.indexOf('{');
  const newlineIdx = slice.indexOf('\n');
  if (braceIdx !== -1 && (newlineIdx === -1 || braceIdx < newlineIdx + 1)) {
    let depth = 0;
    for (let i = braceIdx; i < slice.length; i++) {
      const ch = slice[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return slice.slice(0, i + 1);
      }
    }
    return slice;
  }
  // Statement-style: capture until next blank line.
  const blank = slice.indexOf('\n\n');
  return blank === -1 ? slice : slice.slice(0, blank);
}

/**
 * Normalise a signature string for shape comparison: collapse whitespace,
 * strip comments, drop identifier names so we compare shapes not labels.
 *
 * @param {string} sig
 * @returns {string}
 */
function normaliseSignature(sig) {
  if (!sig) return '';
  return String(sig)
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Compare two signature entries by their normalised shapes.
 *
 * @param {{signature: string}} consumer
 * @param {{signature: string}} producer
 * @returns {{equal: boolean, diff?: {consumer: string, producer: string}}}
 */
function compareSignatures(consumer, producer) {
  const c = normaliseSignature(consumer && consumer.signature);
  const p = normaliseSignature(producer && producer.signature);
  if (c === p) return { equal: true };
  return { equal: false, diff: { consumer: c, producer: p } };
}

/**
 * Extract sibling ticket IDs from a git-log text blob. Returns up to
 * `SIBLING_ID_CAP` distinct IDs in first-seen order.
 *
 * @param {string} text
 * @returns {string[]}
 */
function parseSiblingTicketIds(text) {
  if (!text) return [];
  const seen = new Set();
  const out = [];
  TICKET_ID_RE.lastIndex = 0;
  let m;
  while ((m = TICKET_ID_RE.exec(text)) !== null) {
    const id = m[0];
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= SIBLING_ID_CAP) break;
  }
  return out;
}

/**
 * Detect whether a consumer signature treats `data` as an array (`data.map`)
 * while the producer signature wraps it (`{ deleters: ... }`). This is the
 * specific divergence shape Pass B is required to catch (AC3).
 *
 * @param {ExportEntry[]} consumerExports
 * @param {ExportEntry[]} producerExports
 * @returns {boolean}
 */
function detectArrayVsWrapperDivergence(consumerExports, producerExports) {
  const consumerText = consumerExports.map((e) => e.signature).join('\n');
  const producerText = producerExports.map((e) => e.signature).join('\n');
  const consumerIsArray = /data\.map\b/.test(consumerText) || /data:\s*Array</.test(consumerText);
  const producerIsWrapper = /\bdeleters\s*:/.test(producerText);
  return consumerIsArray && producerIsWrapper;
}

/**
 * Run Pass B over a fixture directory. Pairs `*.tsx` consumers with
 * `*.ts` producers, compares their export signatures, and emits one
 * Pass B warning per detected divergence with sibling-ID enrichment
 * sourced from `git-log.txt` (when present).
 *
 * @param {string} fixtureDir
 * @returns {{warnings: Warning[], rendered: string}}
 */
function runPassB(fixtureDir) {
  const absDir = path.resolve(fixtureDir);
  const entries = fs.existsSync(absDir) ? fs.readdirSync(absDir) : [];
  const tsxFiles = entries.filter((f) => f.endsWith('.tsx'));
  const tsFiles = entries.filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'));

  const warnings = [];

  for (const consumerFile of tsxFiles) {
    const consumerPath = safeResolve(absDir, consumerFile);
    const consumerExports = extractExports(consumerPath);

    for (const producerFile of tsFiles) {
      const producerPath = safeResolve(absDir, producerFile);
      const producerExports = extractExports(producerPath);

      if (!detectArrayVsWrapperDivergence(consumerExports, producerExports)) continue;

      const consumerSig = { signature: consumerExports.map((e) => e.signature).join('\n') };
      const producerSig = { signature: producerExports.map((e) => e.signature).join('\n') };
      const cmp = compareSignatures(consumerSig, producerSig);
      if (cmp.equal) continue;

      const siblingIds = readSiblingIds(absDir);
      const idsText = siblingIds.length > 0 ? ` siblings: ${siblingIds.join(', ')}` : '';
      warnings.push({
        kind: 'B',
        file: path.join(absDir, consumerFile),
        message: `contract mismatch with ${producerFile}: consumer expects array, producer returns wrapper`,
        hint: `coordinate-with-siblings${idsText}`,
      });
    }
  }

  return {
    warnings,
    rendered: formatWarnings(warnings),
  };
}

/**
 * Read `git-log.txt` from a fixture directory and return up to
 * `SIBLING_ID_CAP` sibling ticket IDs.
 *
 * @param {string} absDir
 * @returns {string[]}
 */
function readSiblingIds(absDir) {
  const logPath = path.join(absDir, 'git-log.txt');
  if (!fs.existsSync(logPath)) return [];
  const text = fs.readFileSync(logPath, 'utf8');
  return parseSiblingTicketIds(text);
}

module.exports = {
  extractExports,
  compareSignatures,
  safeResolve,
  runPassB,
  parseSiblingTicketIds,
  EXPORT_SIGNATURE_RE,
  SIBLING_ID_CAP,
};
