'use strict';

/**
 * debug-session.js — deterministic CommonJS helper behind the `/debug` skill.
 *
 * Subcommands (`node debug-session.js <cmd>`):
 *   init "<description>"  seed a `.debug-session.md` at cwd (status: active).
 *   status               print status / active hypothesis / next action; no writes.
 *   list                 list each session with its status + trigger.
 *
 * Design locks:
 *   - Runtime uses ONLY Node built-ins (`fs`, `path`) — zero runtime deps.
 *   - Security: a path argument is rejected if it contains `..` or is
 *     absolute, so `init` only ever writes the cwd-relative session file, and
 *     the trigger's quotes/newlines are escaped so the YAML frontmatter stays
 *     parseable (see `serializeFrontmatter`).
 *   - Fail-safe: a missing session file and malformed frontmatter both print a
 *     clear message and exit non-zero WITHOUT leaking an unhandled stack trace.
 */

const fs = require('node:fs');
const path = require('node:path');

const SESSION_FILE = '.debug-session.md';

/** Closed set of lifecycle statuses; `active` is the default on init. */
const STATUSES = Object.freeze(['active', 'resolved', 'diagnosed', 'abandoned']);
const COMPLETED_STATUSES = Object.freeze(['resolved', 'diagnosed', 'abandoned']);
const DEFAULT_STATUS = 'active';

/** Print `message` and exit non-zero — the single fail path for the CLI. */
function failExit(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/** Today's date as an ISO calendar day (YYYY-MM-DD). */
function isoDate() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Escape a value for a double-quoted YAML scalar so embedded quotes/newlines
 * cannot break out of the frontmatter block. Security-relevant: this keeps a
 * hostile trigger from injecting extra frontmatter keys or a closing fence.
 */
function escapeYaml(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

/**
 * Reject a caller-supplied path target that would escape cwd. Returns the
 * validated relative target, or throws a validation Error. `..` segments and
 * absolute paths are refused so nothing is ever written outside cwd.
 */
function safeRelativeTarget(target) {
  if (path.isAbsolute(target)) {
    throw new Error(`invalid target: absolute paths are not allowed (${target})`);
  }
  const segments = target.split(/[\\/]/);
  if (segments.includes('..')) {
    throw new Error(`invalid target: path traversal ("..") is not allowed (${target})`);
  }
  return target;
}

/** Serialize the session frontmatter + empty section scaffold as one string. */
function serializeSession(trigger, status, created, updated) {
  const frontmatter = [
    '---',
    `status: ${status}`,
    `trigger: "${escapeYaml(trigger)}"`,
    `created: "${created}"`,
    `updated: "${updated}"`,
    '---',
  ].join('\n');

  const body = ['', '## Hypotheses', '', '## Evidence', '', '## Current Focus', ''].join('\n');

  return `${frontmatter}\n${body}`;
}

/**
 * Parse the leading YAML frontmatter block of a session file. Throws a plain
 * Error (caught by the command wrapper) when the block is malformed — e.g. no
 * closing fence — so the CLI can fail safe instead of throwing unhandled.
 */
function parseFrontmatter(content) {
  if (!content.startsWith('---\n')) {
    throw new Error('malformed frontmatter: missing opening fence');
  }
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    throw new Error('malformed frontmatter: could not parse (no closing fence)');
  }

  const fields = Object.create(null);
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (!kv) {
      continue;
    }
    let value = kv[2].trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    }
    fields[kv[1]] = value;
  }

  if (!fields.status || !STATUSES.includes(fields.status)) {
    throw new Error(`malformed frontmatter: invalid or missing status (${fields.status || ''})`);
  }
  return fields;
}

/** Read a markdown section's body (the lines after `## <heading>`). */
function readSection(content, heading) {
  const start = content.indexOf(`## ${heading}`);
  if (start === -1) {
    return '';
  }
  const after = content.slice(start + `## ${heading}`.length);
  const next = after.indexOf('\n## ');
  return (next === -1 ? after : after.slice(0, next)).trim();
}

/** Extract "Active hypothesis" and "Next action" from `## Current Focus`. */
function readCurrentFocus(content) {
  const section = readSection(content, 'Current Focus');
  const field = (label) => {
    const m = section.match(new RegExp(`${label}:\\s*(.+)`, 'i'));
    return m ? m[1].trim() : '';
  };
  return {
    activeHypothesis: field('Active hypothesis'),
    nextAction: field('Next action'),
  };
}

/** Read the cwd session file, or fail safe when it is absent. */
function readSessionOrFail() {
  const filePath = path.join(process.cwd(), SESSION_FILE);
  if (!fs.existsSync(filePath)) {
    failExit(`No debug session found: ${SESSION_FILE} does not exist in this directory.`);
  }
  return fs.readFileSync(filePath, 'utf8');
}

/** `init "<description>"` — seed a valid session file at cwd. */
function cmdInit(args) {
  const trigger = args[0];
  if (!trigger) {
    failExit('init requires a "<description>" argument.');
  }

  const target = args[1] || SESSION_FILE;
  let relTarget;
  try {
    relTarget = safeRelativeTarget(target);
  } catch (err) {
    failExit(err.message);
    return;
  }

  const today = isoDate();
  const content = serializeSession(trigger, DEFAULT_STATUS, today, today);
  fs.writeFileSync(path.join(process.cwd(), relTarget), content, 'utf8');
  process.stdout.write(`Started debug session (${DEFAULT_STATUS}): ${relTarget}\n`);
}

/** `status` — print state without mutating the file. */
function cmdStatus() {
  const content = readSessionOrFail();

  let fields;
  try {
    fields = parseFrontmatter(content);
  } catch (err) {
    failExit(err.message);
    return;
  }

  const focus = readCurrentFocus(content);
  const lines = [
    `status: ${fields.status}`,
    `trigger: ${fields.trigger || ''}`,
    `active hypothesis: ${focus.activeHypothesis || '(none)'}`,
    `next action: ${focus.nextAction || '(none)'}`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

/** `list` — one line per session: status marker + trigger. */
function cmdList() {
  const filePath = path.join(process.cwd(), SESSION_FILE);
  if (!fs.existsSync(filePath)) {
    process.stdout.write('No debug sessions found.\n');
    return;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  let fields;
  try {
    fields = parseFrontmatter(content);
  } catch (err) {
    failExit(err.message);
    return;
  }

  const marker = COMPLETED_STATUSES.includes(fields.status) ? '[done]' : '[active]';
  process.stdout.write(`${marker} ${fields.status} — ${fields.trigger || ''}\n`);
}

const COMMANDS = Object.freeze({
  init: cmdInit,
  status: cmdStatus,
  list: cmdList,
});

/** CLI entrypoint: dispatch argv[2] to a subcommand. */
function main(argv) {
  const [cmd, ...rest] = argv;
  const handler = COMMANDS[cmd];
  if (!handler) {
    failExit(`Unknown command "${cmd || ''}". Usage: debug-session.js <init|status|list>`);
    return;
  }
  handler(rest);
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = {
  escapeYaml,
  safeRelativeTarget,
  serializeSession,
  parseFrontmatter,
  readCurrentFocus,
  main,
  SESSION_FILE,
  STATUSES,
};
