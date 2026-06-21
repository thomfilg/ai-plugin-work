'use strict';

/**
 * Task 7 / R7 — too-broad-trigger rule.
 *
 * Split out of `scripts/synapsys-lint.js` (GH-534) for the file-size cap.
 */

const { STOP_WORDS } = require('../lint-stopwords');

const TOO_BROAD_MAX_TOKEN_LEN = 4;

/**
 * extractGroupTokens — collect lowercased word-ish tokens from every
 * parenthesised group in a regex source, INCLUDING single-token groups
 * (unlike `extractAlternationTokens` which skips them).
 */
function extractGroupTokens(src) {
  if (typeof src !== 'string' || src.length === 0) return [];
  const tokens = [];
  const groupRe = /\(([^()]+)\)/g;
  let m;
  while ((m = groupRe.exec(src)) !== null) {
    for (const raw of m[1].split('|')) {
      const t = raw.trim();
      if (/^[A-Za-z0-9_-]+$/.test(t)) tokens.push(t.toLowerCase());
    }
  }
  return tokens;
}

/**
 * isTooBroadTrigger — predicate. Returns `{ broad: false }` or
 * `{ broad: true, reason: string }`.
 */
function isTooBroadTrigger(triggerSource) {
  if (typeof triggerSource !== 'string' || triggerSource.length === 0) {
    return { broad: false };
  }
  const tokens = extractGroupTokens(triggerSource);
  if (!tokens || tokens.length === 0) return { broad: false };

  const allShort = tokens.every((t) => t.length <= TOO_BROAD_MAX_TOKEN_LEN);
  if (allShort) {
    return {
      broad: true,
      reason: `all alternation tokens are ≤${TOO_BROAD_MAX_TOKEN_LEN} chars: [${tokens.join(', ')}]`,
    };
  }

  const allStop = tokens.every((t) => STOP_WORDS.has(t));
  if (allStop) {
    return {
      broad: true,
      reason: `all alternation tokens are STOP_WORDS: [${tokens.join(', ')}]`,
    };
  }

  return { broad: false };
}

/**
 * computeBroadTriggers — walk each memory once and surface broad triggers.
 */
function computeBroadTriggers(memories, onlyInvolving) {
  const out = [];
  for (const m of memories) {
    if (onlyInvolving && m.name !== onlyInvolving) continue;
    const { broad, reason } = isTooBroadTrigger(m.triggerPrompt || '');
    if (!broad) continue;
    out.push({
      name: m.name,
      rule: 'too-broad-trigger',
      severity: 'medium',
      reason,
    });
  }
  return out;
}

module.exports = { isTooBroadTrigger, computeBroadTriggers, extractGroupTokens };
