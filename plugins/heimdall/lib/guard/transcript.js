'use strict';

/**
 * Transcript inspection: find which unlock phrases the user has TYPED in their
 * recent messages. Speaking a phrase lifts the lock for entries that share it,
 * for a short window of subsequent tool calls.
 *
 * SECURITY: only genuine user-authored text is trusted — string message
 * content and `text` content blocks. `tool_result` content is deliberately
 * ignored: a guarded agent could otherwise self-unlock by emitting the phrase
 * as tool output (e.g. `echo "edit .claude"`, or even a forged
 * `"...="edit .claude""` AskUserQuestion-looking string), which lands in the
 * transcript as a tool_result on a user-type turn. Tool output is
 * agent-controlled and must never authorize an unlock. As a consequence,
 * AskUserQuestion answers (also recorded as tool_results) do NOT unlock — the
 * user must type the phrase, which the agent cannot fabricate.
 */

const fs = require('node:fs');

/** Genuine user-typed text from a content item; '' for tool_result/other. */
function userAuthoredText(item) {
  if (item && item.type === 'text') return item.text || '';
  return '';
}

function messagesFromLine(line) {
  const out = [];
  try {
    const parsed = JSON.parse(line);
    if (parsed.type !== 'user' || !parsed.message) return out;
    const mc = parsed.message.content;
    if (typeof mc === 'string') {
      out.push(mc);
      return out;
    }
    if (!Array.isArray(mc)) return out;
    for (const item of mc) {
      const text = userAuthoredText(item);
      if (text) out.push(text);
    }
  } catch {
    /* skip malformed line */
  }
  return out;
}

function getRecentUserMessages(transcriptPath, count = 20) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return [];
  try {
    const lines = fs.readFileSync(transcriptPath, 'utf8').trim().split('\n').filter(Boolean);
    const userMessages = [];
    for (const line of lines) userMessages.push(...messagesFromLine(line));
    return userMessages.slice(-count);
  } catch {
    return [];
  }
}

function stripSystemTags(text) {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, '')
    .replace(/<command-name>[\s\S]*?<\/command-name>/g, '')
    .replace(/<command-args>[\s\S]*?<\/command-args>/g, '')
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '')
    .trim();
}

/** Set of unlock phrases (lowercased) the user typed in recent messages. */
function findUnlockedPhrases(transcriptPath, entries) {
  const phrases = new Set(entries.map((e) => (e.unlockPhrase || '').toLowerCase()).filter(Boolean));
  const unlocked = new Set();
  for (const msg of getRecentUserMessages(transcriptPath, 20)) {
    const normalized = stripSystemTags(msg).replace(/\s+/g, ' ').toLowerCase();
    if (!normalized) continue;
    for (const phrase of phrases) {
      // The user's own message must contain the phrase as a standalone token.
      if (
        normalized === phrase ||
        new RegExp(`(?:^|\\s)${escapeRe(phrase)}(?:$|\\s|[.!?])`).test(normalized)
      ) {
        unlocked.add(phrase);
      }
    }
  }
  return unlocked;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isEntryUnlocked(entry, unlockedPhrases) {
  return unlockedPhrases.has((entry.unlockPhrase || '').toLowerCase());
}

module.exports = { getRecentUserMessages, findUnlockedPhrases, isEntryUnlocked };
