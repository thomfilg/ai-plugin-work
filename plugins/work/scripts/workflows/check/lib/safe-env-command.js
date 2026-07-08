'use strict';

/**
 * safe-env-command.js — sanitizer for operator-configured suite command lines
 * (SCRIPT_RUN_AFFECTED_UNIT/INTEGRATION/E2E). They run through a shell, so
 * each is validated against a conservative allowlist before use: words,
 * paths, flags, `=`, quotes and `$VAR`/`${VAR}` expansion are allowed —
 * command chaining/substitution metacharacters (`;` `|` `&` `<` `>`
 * backtick, parens, newline) are not. Invalid commands are ignored (the
 * suite is treated as unconfigured) rather than executed.
 */

const SAFE_ENV_CMD_RE = /^[\w@./:=,'"~^*+ ${}[\]-]+$/;

/**
 * @param {unknown} value - raw env var value
 * @returns {string|null} the trimmed command when safe, else null
 */
function safeEnvCommand(value) {
  const cmd = typeof value === 'string' ? value.trim() : '';
  return cmd && SAFE_ENV_CMD_RE.test(cmd) ? cmd : null;
}

module.exports = { safeEnvCommand, SAFE_ENV_CMD_RE };
