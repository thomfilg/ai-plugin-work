'use strict';

/**
 * Transcript inspection: find which unlock phrases the user has TYPED in their
 * recent messages. Speaking a phrase lifts the lock for entries that share it,
 * for a short window of subsequent tool calls.
 *
 * Reading is delegated to the vendored dual-format reader (../runtime/transcript)
 * with `authoredOnly: true`, which enforces the security invariant on BOTH
 * runtimes: only genuine user-authored text is trusted. On claude that means
 * string message content and `text` content blocks — `tool_result` content is
 * deliberately ignored: a guarded agent could otherwise self-unlock by emitting
 * the phrase as tool output (e.g. `echo "edit .claude"`, or even a forged
 * `"...="edit .claude""` AskUserQuestion-looking string), which lands in the
 * transcript as a tool_result on a user-type turn. On codex rollouts only
 * `event_msg`/`user_message` records count — `response_item` user-role rows can
 * carry injected AGENTS.md/skill/hook context and `function_call_output` is
 * agent-controlled; neither may ever authorize an unlock.
 */

const { readUserMessages, sniffFormat, stripInjected } = require('../runtime/transcript');

/** Last `count` user-authored messages from either transcript format. */
function getRecentUserMessages(transcriptPath, count = 20) {
  return readUserMessages(transcriptPath, { count, authoredOnly: true });
}

/** Set of unlock phrases (lowercased) the user typed in recent messages. */
function findUnlockedPhrases(transcriptPath, entries) {
  const phrases = new Set(entries.map((e) => (e.unlockPhrase || '').toLowerCase()).filter(Boolean));
  const unlocked = new Set();
  const format = sniffFormat(transcriptPath);
  for (const msg of getRecentUserMessages(transcriptPath, 20)) {
    const normalized = stripInjected(msg, format).replace(/\s+/g, ' ').toLowerCase();
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
