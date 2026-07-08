'use strict';

// Shared regex compile-or-null helper. Used by matcher.js and
// matcher-excludes.js so the fail-closed behavior on invalid patterns
// stays defined in exactly one place. Default flag is `i` to match the
// case-insensitive convention used across synapsys trigger/exclude regexes.
function safeRegex(pattern, flags = 'i') {
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

module.exports = { safeRegex };
