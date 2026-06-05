'use strict';

const fs = require('fs');
const path = require('path');

/** Directories to skip during glob traversal to avoid slow/flaky gate checks */
const GLOB_SKIP_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'coverage']);

function checkPathBasics(p, segments) {
  if (typeof p !== 'string' || p.length === 0) {
    return { valid: false, reason: `Missing or invalid path argument: ${p}` };
  }
  if (path.isAbsolute(p)) {
    return { valid: false, reason: `Absolute path rejected: ${p}` };
  }
  if (segments.some((seg) => seg === '..')) {
    return { valid: false, reason: `Path traversal rejected: ${p}` };
  }
  return { valid: true };
}

function validatePath(p) {
  const normalized = typeof p === 'string' ? path.normalize(p) : p;
  const segments = typeof normalized === 'string' ? normalized.split(path.sep) : [];
  const basics = checkPathBasics(p, segments);
  if (!basics.valid) return basics;
  return { valid: true, resolved: normalized };
}

function validateGlobPattern(p) {
  const segments = typeof p === 'string' ? p.split(/[/\\]/) : [];
  return checkPathBasics(p, segments);
}

function matchDoubleStar(dir, parts, entries) {
  const rest = parts.slice(1);
  const results = [];
  results.push(...matchParts(dir, rest));
  for (const entry of entries) {
    if (entry.isDirectory() && !GLOB_SKIP_DIRS.has(entry.name)) {
      const subdir = path.join(dir, entry.name);
      results.push(...matchParts(subdir, parts));
    }
  }
  return [...new Set(results)];
}

function matchLiteralSegment(dir, parts, entries) {
  const [current, ...rest] = parts;
  const globRegex = new RegExp(
    '^' + current.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$'
  );
  const results = [];
  for (const entry of entries) {
    if (!globRegex.test(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (rest.length === 0) {
      if (entry.isFile()) results.push(full);
    } else if (entry.isDirectory() && !GLOB_SKIP_DIRS.has(entry.name)) {
      results.push(...matchParts(full, rest));
    }
  }
  return results;
}

function matchParts(dir, parts) {
  if (parts.length === 0) return [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  if (parts[0] === '**') return matchDoubleStar(dir, parts, entries);
  return matchLiteralSegment(dir, parts, entries);
}

function miniGlob(base, pattern) {
  return matchParts(base, pattern.split(/[/\\]/));
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isRegexContext(output) {
  const trimmed = output.replace(/\s+$/, '');
  if (trimmed.length === 0) return true;
  const last = trimmed[trimmed.length - 1];
  return '=([)!&|?:,;{}~^+-*%<>\n'.includes(last);
}

function consumeString(src, start) {
  const quote = src[start];
  let out = quote;
  let i = start + 1;
  while (i < src.length && src[i] !== quote) {
    if (src[i] === '\\') {
      out += src[i] + (src[i + 1] || '');
      i += 2;
    } else {
      out += src[i];
      i++;
    }
  }
  if (i < src.length) {
    out += src[i];
    i++;
  }
  return { out, next: i };
}

function consumeCharClass(src, start) {
  let out = src[start];
  let i = start + 1;
  while (i < src.length && src[i] !== ']' && src[i] !== '\n') {
    if (src[i] === '\\') {
      out += src[i] + (src[i + 1] || '');
      i += 2;
    } else {
      out += src[i];
      i++;
    }
  }
  return { out, next: i };
}

function consumeRegexBody(src, start) {
  let out = '';
  let i = start;
  while (i < src.length && src[i] !== '/' && src[i] !== '\n') {
    if (src[i] === '\\') {
      out += src[i] + (src[i + 1] || '');
      i += 2;
    } else if (src[i] === '[') {
      const cc = consumeCharClass(src, i);
      out += cc.out;
      i = cc.next;
    } else {
      out += src[i];
      i++;
    }
  }
  return { out, next: i };
}

function consumeRegexFlags(src, start) {
  let out = '';
  let i = start;
  while (i < src.length && /[gimsuy]/.test(src[i])) {
    out += src[i];
    i++;
  }
  return { out, next: i };
}

function consumeRegexLiteral(src, start) {
  const body = consumeRegexBody(src, start + 1);
  let out = src[start] + body.out;
  let i = body.next;
  if (i < src.length && src[i] === '/') {
    out += src[i];
    i++;
    const flags = consumeRegexFlags(src, i);
    out += flags.out;
    i = flags.next;
  }
  return { out, next: i };
}

function consumeLineComment(src, start) {
  let i = start;
  while (i < src.length && src[i] !== '\n') i++;
  return { out: '', next: i };
}

function consumeBlockComment(src, start) {
  let i = start + 2;
  let out = '';
  let emittedNewline = false;
  while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
    if (src[i] === '\n') {
      out += '\n';
      emittedNewline = true;
    }
    i++;
  }
  if (!emittedNewline) out += ' ';
  if (i < src.length) i += 2;
  return { out, next: i };
}

function isStringStart(ch) {
  return ch === "'" || ch === '"' || ch === '`';
}

function consumeSlash(src, i, out) {
  const next = src[i + 1];
  if (next === '/') return consumeLineComment(src, i);
  if (next === '*') return consumeBlockComment(src, i);
  if (isRegexContext(out)) return consumeRegexLiteral(src, i);
  return { out: src[i], next: i + 1 };
}

function stripComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (isStringStart(ch)) {
      const r = consumeString(src, i);
      out += r.out;
      i = r.next;
    } else if (ch === '/') {
      const r = consumeSlash(src, i, out);
      out += r.out;
      i = r.next;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

function skipInterpolationString(src, start) {
  const q = src[start];
  let i = start + 1;
  while (i < src.length && src[i] !== q) {
    if (src[i] === '\\') i++;
    i++;
  }
  return i;
}

function skipRegexInState(src, start) {
  let i = start + 1;
  while (i < src.length && src[i] !== '/' && src[i] !== '\n') {
    if (src[i] === '\\') i++;
    i++;
  }
  return i;
}

function stepInInterpolation(src, i, state) {
  const ch = src[i];
  if (ch === '{') {
    state.braceDepth++;
    return i;
  }
  if (ch === '}') {
    state.braceDepth--;
    return i;
  }
  if (ch === "'" || ch === '"') {
    return skipInterpolationString(src, i);
  }
  return i;
}

function stepInString(src, i, state) {
  const ch = src[i];
  if (ch === '\\') return i + 1;
  if (state.quote === '`' && ch === '$' && src[i + 1] === '{') {
    state.braceDepth = 1;
    return i + 1;
  }
  if (ch === state.quote) {
    state.inString = false;
  }
  return i;
}

function stepInCode(src, i, state) {
  const ch = src[i];
  if (ch === "'" || ch === '"' || ch === '`') {
    state.inString = true;
    state.quote = ch;
    return i;
  }
  if (ch === '/' && isRegexContext(src.slice(0, i))) {
    return skipRegexInState(src, i);
  }
  return i;
}

function isInsideString(src, pos) {
  const state = { inString: false, quote: '', braceDepth: 0 };
  for (let i = 0; i < pos && i < src.length; i++) {
    if (state.inString && state.quote === '`' && state.braceDepth > 0) {
      i = stepInInterpolation(src, i, state);
    } else if (state.inString) {
      i = stepInString(src, i, state);
    } else {
      i = stepInCode(src, i, state);
    }
  }
  return state.inString && !(state.quote === '`' && state.braceDepth > 0);
}

function matchMultilineImport(stripped, escapedSymbol) {
  const re = new RegExp(
    String.raw`import\s*\{[^}]*\b${escapedSymbol}\b[^}]*\}\s*from\s*['"][^'"]*['"]`,
    'sg'
  );
  let m;
  while ((m = re.exec(stripped)) !== null) {
    if (!isInsideString(stripped, m.index)) return true;
  }
  return false;
}

function matchImportLayers(stripped, lines, escapedSymbol) {
  if (matchMultilineImport(stripped, escapedSymbol)) return true;
  const defaultOrNamespaceRegex = new RegExp(
    `import\\s+(?:\\*\\s+as\\s+)?${escapedSymbol}\\s+from\\s*['"]`
  );
  return lines.some((line) => {
    const m = defaultOrNamespaceRegex.exec(line);
    return m && !isInsideString(line, m.index);
  });
}

module.exports = {
  GLOB_SKIP_DIRS,
  validatePath,
  validateGlobPattern,
  miniGlob,
  matchParts,
  escapeRegex,
  isRegexContext,
  stripComments,
  isInsideString,
  matchMultilineImport,
  matchImportLayers,
};
