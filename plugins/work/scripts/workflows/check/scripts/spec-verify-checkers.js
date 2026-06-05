'use strict';

const fs = require('fs');
const path = require('path');
const {
  validatePath,
  validateGlobPattern,
  miniGlob,
  escapeRegex,
  stripComments,
  isInsideString,
  matchImportLayers,
} = require('./spec-verify-helpers');

function checkFileExists(args, root) {
  const [filePath] = args;
  if (!filePath) {
    return {
      type: 'FILE_EXISTS',
      args,
      passed: false,
      reason: 'FILE_EXISTS requires one argument: <path>',
    };
  }
  const validation = validatePath(filePath);
  if (!validation.valid) {
    return { type: 'FILE_EXISTS', args, passed: false, reason: validation.reason };
  }
  const full = path.resolve(root, validation.resolved);
  if (fs.existsSync(full)) {
    return { type: 'FILE_EXISTS', args, passed: true };
  }
  return {
    type: 'FILE_EXISTS',
    args,
    passed: false,
    reason: `Expected file ${filePath} to exist — not found`,
  };
}

function parseGrepPattern(patternStr, args) {
  const match = /^\/(.+)\/([gimsuy]*)$/.exec(patternStr);
  if (!match) {
    return {
      error: {
        type: 'GREP',
        args,
        passed: false,
        reason: `Invalid regex pattern: ${String(patternStr)} — must use /regex/ delimiters`,
      },
    };
  }
  try {
    return { regex: new RegExp(match[1], match[2]) };
  } catch (err) {
    return {
      error: { type: 'GREP', args, passed: false, reason: `Invalid regex: ${err.message}` },
    };
  }
}

function checkGrepGlob(filePath, regex, patternStr, args, root) {
  const patternValidation = validateGlobPattern(filePath);
  if (!patternValidation.valid) {
    return { type: 'GREP', args, passed: false, reason: patternValidation.reason };
  }
  const files = miniGlob(root, filePath);
  for (const file of files) {
    try {
      const fileContent = fs.readFileSync(file, 'utf-8');
      regex.lastIndex = 0;
      if (regex.test(fileContent)) {
        return { type: 'GREP', args, passed: true };
      }
    } catch {
      // Skip unreadable files
    }
  }
  return {
    type: 'GREP',
    args,
    passed: false,
    reason: `no file matching '${filePath}' (${files.length} files scanned) contains ${patternStr}`,
  };
}

function resolveAndRead(filePath, root, type, args) {
  const validation = validatePath(filePath);
  if (!validation.valid) {
    return { error: { type, args, passed: false, reason: validation.reason } };
  }
  const full = path.resolve(root, validation.resolved);
  try {
    return { content: fs.readFileSync(full, 'utf-8') };
  } catch {
    return { error: { type, args, passed: false, reason: `File ${filePath} not found` } };
  }
}

function checkGrepLiteral(filePath, regex, patternStr, args, root) {
  const r = resolveAndRead(filePath, root, 'GREP', args);
  if (r.error) return r.error;
  const content = r.content;
  if (regex.test(content)) {
    return { type: 'GREP', args, passed: true };
  }
  return {
    type: 'GREP',
    args,
    passed: false,
    reason: `Expected pattern ${patternStr} in ${filePath} — no match found`,
  };
}

function checkGrep(args, root) {
  const [filePath, patternStr] = args;
  if (!filePath || !patternStr) {
    return {
      type: 'GREP',
      args,
      passed: false,
      reason: 'GREP requires two arguments: <path> <pattern>',
    };
  }
  const parsed = parseGrepPattern(patternStr, args);
  if (parsed.error) return parsed.error;
  if (filePath.includes('*')) {
    return checkGrepGlob(filePath, parsed.regex, patternStr, args, root);
  }
  return checkGrepLiteral(filePath, parsed.regex, patternStr, args, root);
}

function checkTestCount(args, root) {
  const [globPattern, minStr] = args;
  if (!globPattern || minStr == null) {
    return {
      type: 'TEST_COUNT',
      args,
      passed: false,
      reason: 'TEST_COUNT requires two arguments: <glob-pattern> <minimum>',
    };
  }
  const pathValidation = validateGlobPattern(globPattern);
  if (!pathValidation.valid) {
    return { type: 'TEST_COUNT', args, passed: false, reason: pathValidation.reason };
  }
  const minimum = parseInt(minStr, 10);
  if (isNaN(minimum)) {
    return { type: 'TEST_COUNT', args, passed: false, reason: `Invalid minimum count: ${minStr}` };
  }
  const files = miniGlob(root, globPattern);
  let count = 0;
  const testPattern = /\b(?:it|test)\s*\(/g;
  for (const file of files) {
    try {
      const content = fs.readFileSync(file, 'utf-8');
      const matches = content.match(testPattern);
      if (matches) count += matches.length;
    } catch {
      // Skip unreadable files
    }
  }
  if (count >= minimum) {
    return { type: 'TEST_COUNT', args, passed: true };
  }
  return {
    type: 'TEST_COUNT',
    args,
    passed: false,
    reason: `Expected at least ${minimum} test()/it() calls in ${globPattern} — found ${count}`,
  };
}

function lineMatchesImport(lines, regex) {
  return lines.some((line) => {
    const m = regex.exec(line);
    return m && !isInsideString(line, m.index);
  });
}

function multilineRequireMatches(stripped, escaped) {
  const multilineRegex = new RegExp(`require\\s*\\(\\s*['"][^'"]*${escaped}[^'"]*['"]`, 'sg');
  let match;
  while ((match = multilineRegex.exec(stripped)) !== null) {
    if (!isInsideString(stripped, match.index)) return true;
  }
  return false;
}

function localDefinitionMatches(lines, escaped) {
  const defRegex = new RegExp(
    `(?:function\\s+${escaped}(?![a-zA-Z0-9_$])\\s*\\(|(?:const|let|var)\\s+${escaped}(?![a-zA-Z0-9_$])\\s*[=,;)])`
  );
  return lineMatchesImport(lines, defRegex);
}

function checkReuses(args, root) {
  const [filePath, importPattern] = args;
  if (!filePath || !importPattern) {
    return {
      type: 'REUSES',
      args,
      passed: false,
      reason: 'REUSES requires two arguments: <path> <import-pattern>',
    };
  }
  const r = resolveAndRead(filePath, root, 'REUSES', args);
  if (r.error) return r.error;
  const content = r.content;
  const escaped = escapeRegex(importPattern);
  const importRegex = new RegExp(
    `(import\\s.*${escaped}|${escaped}.*require\\s*\\(|require\\s*\\(.*${escaped})`
  );
  const stripped = stripComments(content);
  const lines = stripped.split(/\r?\n/);
  if (lineMatchesImport(lines, importRegex)) {
    return { type: 'REUSES', args, passed: true };
  }
  if (multilineRequireMatches(stripped, escaped)) {
    return { type: 'REUSES', args, passed: true };
  }
  if (matchImportLayers(stripped, lines, escaped)) {
    return { type: 'REUSES', args, passed: true };
  }
  if (localDefinitionMatches(lines, escaped)) {
    return { type: 'REUSES', args, passed: true };
  }
  return {
    type: 'REUSES',
    args,
    passed: false,
    reason: `Expected import or definition matching "${importPattern}" in ${filePath} — not found (checked: line-by-line import, multi-line import block, multi-line require(), local definition)`,
  };
}

const CHECKERS = {
  FILE_EXISTS: checkFileExists,
  GREP: checkGrep,
  TEST_COUNT: checkTestCount,
  REUSES: checkReuses,
};

function runChecks(markers, root) {
  return markers.map(({ type, args }) => {
    const checker = CHECKERS[type];
    if (!checker) {
      return {
        type,
        args,
        passed: false,
        reason: `Unknown marker type "${type}" — supported types: ${Object.keys(CHECKERS).join(', ')}`,
      };
    }
    return checker(args, root);
  });
}

module.exports = { CHECKERS, runChecks };
