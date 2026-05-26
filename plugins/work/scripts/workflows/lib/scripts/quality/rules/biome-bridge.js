'use strict';

/**
 * `biome-bridge` rule.
 *
 * Shells out to `npx biome lint --reporter=json <files...>` and folds the
 * `complexity/noExcessiveCognitiveComplexity` diagnostics into the shared
 * violation shape used by the rule engine.
 *
 * Owns the cognitive-complexity dimension (default threshold 15). Other
 * cognitive concerns are handled by sibling rules (cyclomatic, max-depth,
 * etc.). All other Biome lint rules are expected to be disabled in
 * `biome.json` so this bridge does not surface unrelated diagnostics.
 *
 * Spawn is injectable for unit tests via `options.spawnSync`. Production
 * callers omit the option and the rule uses `child_process.spawnSync`.
 *
 * Failure modes:
 *   - spawn could not start (status null + error)        → throws
 *   - stdout is not valid JSON                           → throws
 * Both are config-grade errors that callers should treat as exit 2.
 */

const childProcess = require('node:child_process');

const RULE_ID = 'biome-bridge';
const OUTPUT_RULE_ID = 'cognitive-complexity';
const DEFAULT_THRESHOLD = 15;
const TARGET_CATEGORY = 'lint/complexity/noExcessiveCognitiveComplexity';

function runBiome(files, spawnSync) {
  const args = ['biome', 'lint', '--reporter=json', ...files];
  const result = spawnSync('npx', args, { encoding: 'buffer' });
  if (!result || result.error || result.status === null) {
    const reason = result && result.error ? result.error.message : 'unknown spawn failure';
    throw new Error(`biome-bridge: failed to spawn npx biome: ${reason}`);
  }
  const stdout = result.stdout ? result.stdout.toString('utf8') : '';
  return stdout;
}

function parseBiomeJson(stdout) {
  const trimmed = (stdout || '').trim();
  if (!trimmed) return { diagnostics: [] };
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`biome-bridge: malformed JSON from biome: ${err.message}`);
  }
}

function diagnosticFile(diag) {
  const loc = diag && diag.location;
  if (!loc) return null;
  if (loc.path && typeof loc.path === 'object' && typeof loc.path.file === 'string') {
    return loc.path.file;
  }
  if (typeof loc.path === 'string') return loc.path;
  return null;
}

function diagnosticLine(diag, fileSourceByPath) {
  const loc = diag && diag.location;
  if (!loc) return 1;
  if (typeof loc.line === 'number') return loc.line;
  if (Array.isArray(loc.span) && typeof loc.span[0] === 'number') {
    const file = diagnosticFile(diag);
    const source = file ? fileSourceByPath.get(file) : null;
    if (source) return offsetToLine(source, loc.span[0]);
  }
  return 1;
}

function offsetToLine(source, offset) {
  const bound = Math.min(offset, source.length);
  let line = 1;
  for (let i = 0; i < bound; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

function parseComplexityFromDescription(description) {
  if (typeof description !== 'string') return { value: null, name: null };
  const valueMatch = description.match(/Complexity of (\d+)/i) || description.match(/\((\d+)\)/);
  const nameMatch = description.match(/in (?:function|method)\s+([A-Za-z_$][\w$]*)/i)
    || description.match(/\bin\s+([A-Za-z_$][\w$]*)/);
  return {
    value: valueMatch ? Number(valueMatch[1]) : null,
    name: nameMatch ? nameMatch[1] : null,
  };
}

function foldDiagnostic(diag, fileSourceByPath) {
  if (!diag) return null;
  if (diag.category !== TARGET_CATEGORY) return null;
  const file = diagnosticFile(diag);
  if (!file) return null;
  const line = diagnosticLine(diag, fileSourceByPath);
  const { value, name } = parseComplexityFromDescription(diag.description);
  const complexityPart = value !== null ? ` (${value})` : '';
  const namePart = name ? ` in ${name}` : '';
  return {
    rule: OUTPUT_RULE_ID,
    file,
    line,
    severity: 'error',
    message: `cognitive-complexity > ${DEFAULT_THRESHOLD}${complexityPart}${namePart}`,
  };
}

function checkAll(files, options) {
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return [];

  const spawnSync = (options && options.spawnSync) || childProcess.spawnSync;
  const filePaths = list
    .map((f) => f && f.path)
    .filter((p) => typeof p === 'string' && p.length > 0);
  if (filePaths.length === 0) return [];

  const fileSourceByPath = new Map();
  for (const f of list) {
    if (f && typeof f.path === 'string') {
      fileSourceByPath.set(f.path, typeof f.source === 'string' ? f.source : '');
    }
  }

  const stdout = runBiome(filePaths, spawnSync);
  const parsed = parseBiomeJson(stdout);
  const diagnostics = Array.isArray(parsed.diagnostics) ? parsed.diagnostics : [];

  const violations = [];
  for (const diag of diagnostics) {
    const v = foldDiagnostic(diag, fileSourceByPath);
    if (v) violations.push(v);
  }
  return violations;
}

function check(_filePath, _source) {
  // This rule operates on the whole batch via `checkAll`.
  return [];
}

module.exports = {
  id: RULE_ID,
  defaultThreshold: DEFAULT_THRESHOLD,
  check,
  checkAll,
};
