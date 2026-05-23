#!/usr/bin/env node
'use strict';

/**
 * Write a new Synapsys memory file from CLI flags + stdin body.
 *
 * Usage:
 *   echo "<body markdown>" | node synapsys-memorize.js \
 *     --name=<slug> \
 *     --desc=<one-line description> \
 *     --events=<UserPromptSubmit,PreToolUse,SessionStart> \
 *     [--prompt=<regex>] \
 *     [--pretool=<Tool:argRegex,Tool:argRegex>] \
 *     [--session=true|false] \
 *     [--inject=full|summary] \
 *     [--store=<local|worktree|global>] \
 *     [--force]                              # overwrite if exists
 *     [--cwd=<path>]
 *
 * Validates:
 *   - `name` is kebab-case (letters/digits/dashes)
 *   - `events` is a subset of {UserPromptSubmit, PreToolUse, SessionStart}
 *   - If UserPromptSubmit in events, `prompt` must be non-empty
 *   - If PreToolUse in events, `pretool` must be non-empty
 *   - Target store exists (has marker)
 *   - File does not exist unless --force
 *
 * On success prints the path written. Non-zero on validation failure.
 */

const fs = require('node:fs');
const path = require('node:path');
const { discoverStores } = require(path.join(__dirname, '..', 'lib', 'memory-store'));

const args = process.argv.slice(2);
function flag(name) {
  const a = args.find((x) => x === `--${name}` || x.startsWith(`--${name}=`));
  if (!a) return undefined;
  const eq = a.indexOf('=');
  return eq === -1 ? true : a.slice(eq + 1);
}

const cwd = flag('cwd') || process.cwd();
const name = flag('name');
const desc = flag('desc');
const eventsRaw = flag('events');
const prompt = typeof flag('prompt') === 'string' ? flag('prompt') : '';
const pretool = typeof flag('pretool') === 'string' ? flag('pretool') : '';
const session = flag('session') === 'true' || flag('session') === true;
const inject = flag('inject') === 'full' ? 'full' : 'summary';
const storeKind = flag('store');
const force = !!flag('force');

function die(msg, code = 2) {
  console.error(`error: ${msg}`);
  process.exit(code);
}

if (!name) die('--name is required');
if (!desc) die('--desc is required');
if (!eventsRaw) die('--events is required');
if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) die(`--name must be kebab-case (got '${name}')`);

const VALID_EVENTS = new Set(['UserPromptSubmit', 'PreToolUse', 'SessionStart']);
const events = String(eventsRaw)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
for (const e of events)
  if (!VALID_EVENTS.has(e)) die(`unknown event '${e}' (expected: ${[...VALID_EVENTS].join(', ')})`);

if (events.includes('UserPromptSubmit') && !prompt)
  die('--prompt is required when events includes UserPromptSubmit');
if (events.includes('PreToolUse') && !pretool)
  die('--pretool is required when events includes PreToolUse');

const stores = discoverStores(cwd);
if (!stores.length) die('no Synapsys stores installed; run /synapsys:install first', 1);

let target = stores[0];
if (storeKind) {
  const match = stores.find((s) => s.kind === storeKind);
  if (!match)
    die(
      `store kind '${storeKind}' not active (active: ${stores.map((s) => s.kind).join(', ')})`,
      1
    );
  target = match;
}

const outPath = path.join(target.dir, `${name}.md`);
if (fs.existsSync(outPath) && !force)
  die(`memory '${name}' already exists at ${outPath}; pass --force to overwrite`, 1);

let body = '';
if (!process.stdin.isTTY) {
  body = fs.readFileSync(0, 'utf8').trim();
}
if (!body) die('memory body is required on stdin (e.g. `cat body.md | synapsys-memorize.js …`)');

const fm = [
  '---',
  `name: ${name}`,
  `description: ${desc.replace(/\n/g, ' ').trim()}`,
  `events: ${events.join(',')}`,
  `trigger_prompt: ${prompt}`,
  `trigger_pretool: ${pretool}`,
  `trigger_session: ${session ? 'true' : 'false'}`,
  `inject: ${inject}`,
  '---',
  '',
  body,
  '',
].join('\n');

fs.writeFileSync(outPath, fm);
console.log(JSON.stringify({ written: outPath, store: target.kind, name }, null, 2));
