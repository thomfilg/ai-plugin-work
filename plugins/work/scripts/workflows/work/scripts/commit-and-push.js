#!/usr/bin/env node

'use strict';

/**
 * commit-and-push.js — the ONE sanctioned path for an agent to create a commit
 * (GH-539). The `enforce-agent-usage` PreToolUse hook BLOCKS a raw commit and
 * forces every agent through this script, so no agent has the option to bypass
 * the commit contract.
 *
 * The session agent authors the message; this script is the guard that:
 *   1. auto-formats it mechanically (CRLF/whitespace normalization, one blank
 *      line after the header, body lines wrapped at the validator's limit) so
 *      agents are never bounced for formatting they could not predict;
 *   2. validates it against the shared rules (`commit-msg-rules.js`) — semantic
 *      format, no AI attribution, ticket ID, <=72 header, imperative mood, ...;
 *   3. rejects an AI git identity (claude/codex/gemini/...) via `git-identity.js`;
 *   4. stages everything, commits under the human identity, and pushes.
 *
 * Runs non-interactively: there is no confirmation/approval step.
 *
 * Usage (no temp file needed — git-style repeated -m):
 *   node commit-and-push.js -m "feat(scope): add thing (#123)"
 *   node commit-and-push.js -m "feat(scope): add thing (#123)" -m "body paragraph" -m "another"
 *   node commit-and-push.js --header "fix(scope): patch thing (#123)" -m "body paragraph"
 *   node commit-and-push.js -F <message-file>      (or `-F -` to read stdin)
 *   node commit-and-push.js "feat(scope): add thing (#123)"   (positional)
 * Flags: --cwd <dir> (default cwd), --no-push (commit only).
 *
 * Exit codes: 0 success | 1 usage/validation/identity failure | 2 git failure.
 * Zero runtime dependencies: Node built-ins + in-repo modules only.
 */

const fs = require('fs');
const { execFileSync } = require('child_process');
const {
  validateMessage,
  ALLOWED_TYPES,
  MAX_TITLE_LEN,
  MAX_BODY_LINE_LEN,
} = require('../hooks/commit-msg-rules');
const { getProviderConfig } = require('../../lib/ticket-provider');
const { resolveGitUser, isAiIdentity } = require('../../lib/git-identity');

const USAGE =
  'usage: commit-and-push.js -m "<header>" [-m "<body paragraph>" ...] [--cwd <dir>] [--no-push]';

// The full message contract, printed with every usage/validation failure so an
// agent can compose a passing message on the FIRST retry instead of probing
// the rules one rejection at a time.
const FORMAT_HELP = [
  'Message contract (validated; whitespace/wrapping is auto-formatted):',
  `  header : type(scope): imperative summary (#123) — MAX ${MAX_TITLE_LEN} chars, no trailing period, no emoji`,
  `  types  : ${[...ALLOWED_TYPES].join(' | ')}`,
  '  ticket : a ticket ref for the configured provider (e.g. "(#123)") must appear in the message',
  `  body   : optional — repeat -m once per paragraph; lines are auto-wrapped at ${MAX_BODY_LINE_LEN} chars`,
  '',
  'Input forms (inline — no temp file; runs non-interactively, no approval step):',
  '  -m "<header>" [-m "<body paragraph>" ...]        git-style: the FIRST -m is the header',
  '  --header "<header>" [-m "<body paragraph>" ...]  explicit header form',
  '  -F <file> | -F -                                 full message from a file or stdin',
  'Flags: --cwd <dir>   --no-push (commit only)',
].join('\n');

/** Read a `-F` message file; `-` reads stdin so no temp file is ever needed. */
function readFileArg(file) {
  if (file === '-') return fs.readFileSync(0, 'utf8');
  return fs.readFileSync(file, 'utf8');
}

// Flags that consume the next argv token.
const VALUE_FLAGS = {
  '-m': (opts, v) => opts.parts.push(v),
  '--message': (opts, v) => opts.parts.push(v),
  '--header': (opts, v) => {
    opts.header = v;
  },
  '--title': (opts, v) => {
    opts.header = v;
  },
  '-F': (opts, v) => {
    opts.fileText = readFileArg(v);
  },
  '--file': (opts, v) => {
    opts.fileText = readFileArg(v);
  },
  '--cwd': (opts, v) => {
    opts.cwd = v;
  },
};

/** A bare first token is the header (legacy positional form). */
function isFirstPositional(opts) {
  return opts.fileText === null && opts.header === null && opts.parts.length === 0;
}

/**
 * Apply the argv token at `i` to `opts`, returning the (possibly advanced)
 * index so flags that consume a value skip it on the next iteration.
 */
function applyArg(argv, i, opts) {
  const arg = argv[i];
  const handler = VALUE_FLAGS[arg];
  if (handler) {
    const value = argv[++i];
    if (value === undefined) throw new Error(`${arg} needs a value\n${USAGE}\n\n${FORMAT_HELP}`);
    handler(opts, value);
    return i;
  }
  if (arg === '--no-push') {
    opts.push = false;
    return i;
  }
  if (!arg.startsWith('-') && isFirstPositional(opts)) opts.parts.push(arg);
  return i;
}

/** Join header + `-m` body paragraphs (or take the `-F` text verbatim). */
function assembleMessage(opts) {
  if (opts.fileText !== null) {
    if (opts.header !== null || opts.parts.length) {
      throw new Error(`-F carries the full message — do not mix it with -m/--header\n${USAGE}`);
    }
    return opts.fileText;
  }
  const parts = [...opts.parts];
  const header = opts.header !== null ? opts.header : parts.shift();
  if (!header || !header.trim()) throw new Error(`${USAGE}\n\n${FORMAT_HELP}`);
  return [header, ...parts].join('\n\n');
}

/** Greedy word-wrap of one body line at `max`, keeping an indent/bullet prefix. */
function wrapLine(line, max) {
  if (line.length <= max) return [line];
  const prefix = (line.match(/^\s*(?:[-*]\s+)?/) || [''])[0];
  const cont = ' '.repeat(prefix.length);
  const words = line.slice(prefix.length).split(/\s+/);
  const out = [];
  let cur = prefix + words[0];
  for (const word of words.slice(1)) {
    const joined = `${cur} ${word}`;
    if (joined.length > max) {
      out.push(cur);
      cur = cont + word;
    } else {
      cur = joined;
    }
  }
  out.push(cur);
  return out;
}

/**
 * Mechanical auto-format so agents are never bounced for whitespace they could
 * not predict: CRLF→LF, trailing-space strip, collapsed header whitespace,
 * exactly one blank line between header and body, single blank line between
 * paragraphs, body lines wrapped at the validator's limit. The HEADER is never
 * rewritten beyond whitespace — shortening a semantic title is lossy, so an
 * over-long header still rejects (with the contract printed).
 */
function formatMessage(raw) {
  const lines = String(raw)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''));
  while (lines.length && !lines[0]) lines.shift();
  const header = (lines.shift() || '').replace(/\s+/g, ' ').trim();
  const body = [];
  let pendingBlank = false;
  for (const line of lines) {
    if (!line) {
      pendingBlank = true;
      continue;
    }
    if (pendingBlank && body.length) body.push('');
    pendingBlank = false;
    body.push(...wrapLine(line, MAX_BODY_LINE_LEN));
  }
  return body.length ? `${header}\n\n${body.join('\n')}` : header;
}

/** Parse argv into `{ message, cwd, push }`. Throws a usage error on bad input. */
function parseArgs(argv) {
  const opts = { parts: [], header: null, fileText: null, cwd: process.cwd(), push: true };
  for (let i = 0; i < argv.length; i++) {
    i = applyArg(argv, i, opts);
  }
  return { message: formatMessage(assembleMessage(opts)), cwd: opts.cwd, push: opts.push };
}

/** Render a rule-validation failure into the two-line stderr block. */
function formatValidationFailure(result) {
  const reason = result.reason ? ` (${result.reason})` : '';
  return `commit rejected: ${result.rule}${reason}\n↳ Hint: ${result.hint}\n`;
}

/** Render the AI-identity rejection. */
function formatIdentityFailure(user) {
  return (
    `commit rejected: git ${user.source} identity "${user.name} <${user.email}>" looks like an AI tool\n` +
    `↳ Hint: commit under a real human user — set git user.name/user.email ` +
    `(claude/codex/gemini/etc. are rejected).\n`
  );
}

/**
 * Validate the message + committer identity. Returns an actionable error string
 * to print, or `null` when both pass.
 */
function validate(message, cwd) {
  const providerConfig = getProviderConfig({ skipPrompt: true });
  const result = validateMessage(message, { providerConfig });
  if (!result.ok) return formatValidationFailure(result);
  const user = resolveGitUser(cwd);
  if (isAiIdentity(user)) return formatIdentityFailure(user);
  return null;
}

/** Run a git subcommand in `cwd`, inheriting stdio. Throws on non-zero exit. */
function git(cwd, args) {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'inherit' });
}

/** Stage everything, commit the message, and (unless disabled) push. */
function commitAndPush({ message, cwd, push }) {
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-m', message]);
  // `-u origin HEAD` publishes the branch under its own name and sets
  // tracking. A bare `git push` dies in fresh /bootstrap worktrees, whose
  // branch is created tracking origin/<base> (GH-697); this form is
  // idempotent for branches already tracking their same-name remote branch.
  if (push) git(cwd, ['push', '-u', 'origin', 'HEAD']);
}

/** CLI entry point. */
function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
    return;
  }

  const failure = validate(opts.message, opts.cwd);
  if (failure) {
    process.stderr.write(`${failure}\n${FORMAT_HELP}\n`);
    process.exit(1);
    return;
  }

  try {
    commitAndPush(opts);
  } catch {
    // git already wrote its own diagnostics to the inherited stderr.
    process.exit(2);
    return;
  }
  process.stdout.write(
    `✅ committed${opts.push ? ' and pushed' : ''}: ${opts.message.split('\n')[0]}\n`
  );
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  formatMessage,
  wrapLine,
  validate,
  formatValidationFailure,
  formatIdentityFailure,
  FORMAT_HELP,
};
