/**
 * task-parser-strategy.js
 *
 * GH-590: ### Test Strategy + ### Test Command extraction helpers, split out
 * of task-parser.js to satisfy the static-quality gate (max-lines /
 * cognitive-complexity). No I/O; pure parsing of task-body strings.
 */

'use strict';

const STRATEGY_KEY_HANDLERS = Object.freeze({
  kind: (out, value) => {
    out.kind = value;
  },
  entry: (out, value) => {
    out.entry = value;
  },
  peer: (out, value) => {
    out.peer = value;
  },
  cites: (out, value) => {
    out.cites = value;
  },
  command: (out, value) => {
    out.command = value;
  },
  'verified-by': (out, value) => {
    out.verifiedBy = value;
  },
  verifiedby: (out, value) => {
    out.verifiedBy = value;
  },
});

function _parseStrategyLine(line, out) {
  const stripped = line
    .trim()
    .replace(/^[-*+]\s+/, '')
    .trim();
  if (!stripped) return;
  const m = stripped.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.+?)\s*$/);
  if (!m) return;
  const key = m[1].toLowerCase();
  const handler = STRATEGY_KEY_HANDLERS[key];
  if (!handler) return;
  const value = m[2].replace(/^`+|`+$/g, '').trim();
  if (!value) return;
  handler(out, value);
}

function _parseStrategyKeys(body) {
  const out = { kind: null, entry: null, peer: null, cites: null, command: null, verifiedBy: null };
  for (const raw of body.split('\n')) {
    _parseStrategyLine(raw, out);
  }
  return out;
}

function _extractFencedBlocks(body) {
  const out = [];
  let inFence = false;
  let lang = '';
  let buf = [];
  for (const raw of body.split('\n')) {
    const fenceMatch = raw.match(/^\s*```(\S*)\s*$/);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        lang = fenceMatch[1] || '';
        buf = [];
      } else {
        out.push({ lang, content: buf.join('\n') });
        inFence = false;
        lang = '';
        buf = [];
      }
      continue;
    }
    if (inFence) buf.push(raw);
  }
  return out;
}

function _parseFromFences(fences) {
  const parsed = _parseStrategyKeys(fences[0].content);
  let customBody = null;
  if (fences.length > 1) {
    customBody = fences
      .slice(1)
      .map((f) => f.content.trim())
      .filter(Boolean)
      .join('\n');
    if (!customBody) customBody = null;
  }
  return { parsed, customBody };
}

function _buildStrategyResult(parsed, customBody) {
  const { kind, entry, peer, cites, command, verifiedBy } = parsed;
  if (!kind) return null;
  const resolvedCommand = command || customBody || null;
  const resolvedPeer = peer || verifiedBy || null;
  return {
    kind,
    entry,
    peer: resolvedPeer,
    cites,
    command: resolvedCommand,
    verifiedBy: verifiedBy || peer || null,
    customBody: resolvedCommand,
  };
}

function extractTestStrategy(taskBody, extractSectionByHeading) {
  if (typeof taskBody !== 'string' || !taskBody) return null;
  const section = extractSectionByHeading(taskBody, '### Test Strategy');
  if (!section) return null;
  const fences = _extractFencedBlocks(section[1]);
  const { parsed, customBody } =
    fences.length === 0
      ? { parsed: _parseStrategyKeys(section[1]), customBody: null }
      : _parseFromFences(fences);
  return _buildStrategyResult(parsed, customBody);
}

const BARE_INTERPRETER_RE = /^(?:bash|sh|zsh|fish|node|python|python3)\s*$/i;

function _isCommandLine(stripped) {
  if (!stripped) return false;
  if (stripped.startsWith('#')) return false;
  if (BARE_INTERPRETER_RE.test(stripped)) return false;
  if (/^[`]+$/.test(stripped)) return false;
  const bulletStripped = stripped.replace(/^[-*+]\s+/, '').trim();
  if (/^_[^_]*_\s*$/.test(bulletStripped)) return false;
  if (/^_/.test(bulletStripped) && /_$/.test(bulletStripped)) return false;
  if (/^-{3,}$|^\*{3,}$|^_{3,}$/.test(stripped)) return false;
  return true;
}

function _normalizeCommandLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const stripped = trimmed.replace(/^`+|`+$/g, '').trim();
  return _isCommandLine(stripped) ? stripped : null;
}

function extractTestCommand(taskBody) {
  const headingMatch = taskBody.match(
    /### Test Command[^\n]*\n([\s\S]*?)(?=\n### |\n## |\n---\s*\n|$)/
  );
  if (!headingMatch) return null;
  const cmdLines = [];
  let inFence = false;
  for (const raw of headingMatch[1].split('\n')) {
    const line = raw.trimEnd();
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    const stripped = _normalizeCommandLine(line);
    if (!stripped) continue;
    cmdLines.push(stripped);
    if (!stripped.endsWith('\\')) break;
  }
  if (cmdLines.length === 0) return null;
  return cmdLines.map((l) => l.replace(/\\$/, '').trim()).join(' ');
}

module.exports = {
  extractTestStrategy,
  extractTestCommand,
  _parseStrategyKeys,
  _extractFencedBlocks,
};
