'use strict';

/**
 * forge-surfaces.js — where an agent publishes prose to GitHub, and under
 * whose account.
 *
 * A commit is not the only thing that gets signed. Pull request descriptions,
 * review comments and issue replies carry the same footers, and an agent
 * reaches them two ways that look nothing alike:
 *
 *   - the `gh` CLI, through the Bash tool: `gh pr comment --body "…"`
 *   - the GitHub MCP tools, as a structured tool call with a `body` field
 *
 * Both are covered. The CLI path rides the shared command walker, so every
 * wrapper already handled for git (`bash -c`, `env`, `sudo`, …) is handled
 * here for free. The MCP path needs no parsing at all — the text arrives as
 * named fields — but it is the one place the guard CANNOT see whose account
 * will do the posting: the credential lives in the MCP server, not the call.
 * That limit is the guard's, and it is reported rather than papered over.
 *
 * Prose surfaces are checked in PROSE mode: a PR that documents an attribution
 * rule quotes it in a code fence, and quoting an example is not signing a
 * document. A footer never sits in a fence.
 */

const { longFlagValue } = require('./shell-tokenize');
const { scanSegments, splitEnvPrefix } = require('./command-scan');

const GH_BINARY_RE = /(?:^|\/)gh$/;

/** `gh` subcommands whose invocation publishes text the caller wrote. */
const GH_POST_COMMANDS = {
  pr: new Set(['create', 'edit', 'comment', 'review', 'merge']),
  issue: new Set(['create', 'edit', 'comment']),
  release: new Set(['create', 'edit']),
  gist: new Set(['create']),
  api: new Set(),
};

/** Flags carrying literal text, and the ones carrying a path to it. */
const TEXT_FLAGS = ['--body', '--title', '--notes', '--subject', '--message'];
const SHORT_TEXT_FLAGS = { '-b': '--body', '-t': '--title', '-n': '--notes', '-m': '--message' };
const FILE_FLAGS = ['--body-file', '--notes-file'];
/**
 * `-F` is `gh`'s short form of `--body-file` on every posting command. Reading
 * only the long form left the idiomatic invocation — `gh pr create -F body.md`
 * — publishing a file nobody opened. (Under `gh api` the same letter means a
 * raw field, which is why that group is read by readApiFields instead.)
 */
const SHORT_FILE_FLAGS = { '-F': '--body-file' };

/** `gh api -f body=…` — a field whose key publishes prose. */
const API_FIELD_FLAGS = ['--field', '--raw-field', '-f', '-F'];
const API_TEXT_FIELD_RE = /^(body|title|message|note|description)=([\s\S]*)$/i;

/**
 * MCP tool-input keys that carry text a human will read as authored. Matched
 * by NAME rather than by tool, so a GitHub tool added tomorrow is covered the
 * moment it uses the same field names.
 */
const MCP_TEXT_FIELDS = new Set([
  'body',
  'title',
  'message',
  'commit_message',
  'commit_title',
  'notes',
  'description',
  'text',
  'summary',
]);

/** Tokens that name an account explicitly rather than using the logged-in one. */
const ACCOUNT_ENV_RE = /^(?:GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN)$/;

function newPost(kind) {
  return { kind, texts: [], textFiles: [], tokenOverride: null };
}

/** Literal text at `argv[i]`: `--body value`, `--body=value`, or `-b value`. */
function readTextArg(argv, i, kind, out) {
  for (const flag of TEXT_FLAGS) {
    const value = longFlagValue(argv, i, flag);
    if (value !== null) out.texts.push({ where: `gh ${kind} ${flag}`, text: value });
  }
  const short = SHORT_TEXT_FLAGS[argv[i]];
  if (short && i + 1 < argv.length)
    out.texts.push({ where: `gh ${kind} ${short}`, text: argv[i + 1] });
}

/** A path to text at `argv[i]`: `--body-file`, `--notes-file`, or `-F`. */
function readTextFileArg(argv, i, kind, out) {
  for (const flag of FILE_FLAGS) {
    const file = longFlagValue(argv, i, flag);
    if (file !== null) out.textFiles.push({ where: `gh ${kind} ${flag}`, file });
  }
  const short = SHORT_FILE_FLAGS[argv[i]];
  if (short && i + 1 < argv.length) {
    out.textFiles.push({ where: `gh ${kind} ${short}`, file: argv[i + 1] });
  }
}

/** Read `--body` / `-b` / `--body-file` style arguments onto a post surface. */
function readPostArgs(argv, start, kind, out) {
  for (let i = start; i < argv.length; i++) {
    readTextArg(argv, i, kind, out);
    readTextFileArg(argv, i, kind, out);
  }
}

/** Read `gh api -f body=…` fields, which bypass every named flag above. */
function readApiFields(argv, start, out) {
  for (let i = start; i < argv.length; i++) {
    for (const flag of API_FIELD_FLAGS) {
      const pair = longFlagValue(argv, i, flag);
      if (pair === null) continue;
      const match = API_TEXT_FIELD_RE.exec(pair);
      if (match) out.texts.push({ where: `gh api ${flag} ${match[1]}`, text: match[2] });
    }
  }
}

/** The first two non-flag words after `gh` — its command group and action. */
function commandWords(argv) {
  const words = [];
  for (let i = 1; i < argv.length && words.length < 2; i++) {
    if (!argv[i].startsWith('-')) words.push({ word: argv[i], index: i });
  }
  return words;
}

/** Locate the `gh` command group and action, skipping global flags. */
function findGhCommand(argv) {
  if (!argv.length || !GH_BINARY_RE.test(argv[0])) return null;
  const [group, action] = commandWords(argv);
  if (!group || !Object.hasOwn(GH_POST_COMMANDS, group.word)) return null;
  if (group.word === 'api') return { kind: 'api', index: group.index };
  if (!action || !GH_POST_COMMANDS[group.word].has(action.word)) return null;
  return { kind: `${group.word} ${action.word}`, index: action.index };
}

/** Build the post surface for one `gh` segment, or null. */
function classifyGhSegment(tokens) {
  const { env, argv } = splitEnvPrefix(tokens);
  const found = findGhCommand(argv);
  if (!found) return null;
  const surface = newPost(found.kind);
  if (found.kind === 'api') readApiFields(argv, found.index + 1, surface);
  else readPostArgs(argv, found.index + 1, found.kind, surface);
  const token = env.find((entry) => ACCOUNT_ENV_RE.test(entry.name));
  if (token) surface.tokenOverride = token.name;
  return surface;
}

/**
 * Every GitHub post a shell command would publish, wrappers included.
 *
 * @param {string} command
 * @returns {{surfaces: Array<object>}}
 */
function scanForgeCommand(command) {
  return {
    surfaces: scanSegments(command, {
      binary: 'gh',
      binaryRe: GH_BINARY_RE,
      classify: classifyGhSegment,
    }),
  };
}

/**
 * Tool-input keys carrying FILE content — a commit made without a working
 * tree, straight through the API. `create_or_update_file` writes one file;
 * `push_files` writes a list. Neither passes through the shell, so nothing the
 * command walker does can see them, and the text they carry lands in the
 * repository exactly as a `git commit` would put it there.
 *
 * @param {string} toolName
 * @param {object} toolInput
 * @returns {Array<{path: string, text: string}>}
 */
function scanToolFiles(toolName, toolInput) {
  if (!isForgeTool(toolName) || !toolInput || typeof toolInput !== 'object') return [];
  const files = [];
  const add = (entry) => {
    if (!entry || typeof entry.content !== 'string' || !entry.content) return;
    files.push({
      path: typeof entry.path === 'string' && entry.path ? entry.path : `${toolName} content`,
      text: entry.content,
    });
  };
  add(toolInput);
  if (Array.isArray(toolInput.files)) toolInput.files.forEach(add);
  return files;
}

/** Is this MCP tool one that publishes to a forge? */
function isForgeTool(toolName) {
  return typeof toolName === 'string' && toolName.startsWith('mcp__github__');
}

/**
 * Text fields of a forge MCP tool call. Returns [] for a read-only call, which
 * is most of them — `get_file_contents` carries no authored prose.
 *
 * @param {string} toolName
 * @param {object} toolInput
 * @returns {{surfaces: Array<object>}}
 */
function scanToolCall(toolName, toolInput) {
  if (!isForgeTool(toolName) || !toolInput || typeof toolInput !== 'object') {
    return { surfaces: [] };
  }
  const surface = newPost(toolName);
  for (const [key, value] of Object.entries(toolInput)) {
    if (!MCP_TEXT_FIELDS.has(key) || typeof value !== 'string' || !value) continue;
    surface.texts.push({ where: `${toolName} ${key}`, text: value });
  }
  return { surfaces: surface.texts.length ? [surface] : [] };
}

module.exports = {
  scanForgeCommand,
  scanToolCall,
  scanToolFiles,
  isForgeTool,
  classifyGhSegment,
  GH_POST_COMMANDS,
  MCP_TEXT_FIELDS,
};
