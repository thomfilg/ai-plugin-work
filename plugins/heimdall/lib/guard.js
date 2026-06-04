'use strict';

/**
 * Heimdall guard engine — public surface.
 *
 * Config-driven generalization of the original ~/.claude/hooks/protect-claude-config.js.
 * A lock block is the tuple { protect: [<dir|file>, ...], unlockPhrase }; each
 * protect path becomes an entry. Files match exactly; directories match by
 * prefix. Implementation is split across ./guard/* to stay within the repo's
 * per-file/per-function quality limits.
 */

const { expandHome, looksLikeFile, buildEntries } = require('./guard/entries');
const { findProtectedTarget, findProtectedPathRef } = require('./guard/paths');
const { bashTargetsProtectedTarget, isReadOnlyBashCommand } = require('./guard/bash');
const { isReadOnlyTaskPrompt } = require('./guard/task');
const { findUnlockedPhrases } = require('./guard/transcript');
const { evaluate, blockMessage } = require('./guard/evaluate');

module.exports = {
  expandHome,
  looksLikeFile,
  buildEntries,
  findProtectedTarget,
  findProtectedPathRef,
  bashTargetsProtectedTarget,
  isReadOnlyBashCommand,
  isReadOnlyTaskPrompt,
  findUnlockedPhrases,
  evaluate,
  blockMessage,
};
