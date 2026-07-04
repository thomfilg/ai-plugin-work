#!/usr/bin/env node
'use strict';

/**
 * Write a new Synapsys memory file from CLI flags + stdin body.
 *
 * Usage:
 *   echo "<body markdown>" | node synapsys-memorize.js \
 *     --name=<slug> \
 *     --desc=<one-line description> \
 *     --events=<UserPromptSubmit,PreToolUse,PostToolUse,SessionStart,Stop> \
 *     [--prompt=<regex>] \
 *     [--pretool=<Tool:argRegex,Tool:argRegex>] \
 *     [--stop-response=<regex>]               # trigger_stop_response (Stop)
 *     [--fire-mode=<always|once|occasionally>] \
 *     [--fire-cadence=<n>]                    # positive integer, for occasionally
 *     [--domain=<csv>]                        # domain gate list
 *     [--enforce=<advise|suggest|block>]      # per-memory enforce mode (GH-520)
 *     [--enforce-classifier=<name>]           # symbol-shape | first-edit-of-session
 *     [--enforce-satisfied-by=<regex>]        # satisfier tool-name regex (first-edit)
 *     [--session=true|false] \
 *     [--inject=full|summary] \
 *     [--store=<local|worktree|global|shared>] \
 *     [--force]                              # overwrite if exists
 *     [--cwd=<path>]
 *
 * Validates:
 *   - `name` is kebab-case (letters/digits/dashes)
 *   - `events` is a subset of {UserPromptSubmit, PreToolUse, PostToolUse,
 *     SessionStart, Stop}
 *   - If UserPromptSubmit in events, `prompt` must be non-empty
 *   - If PreToolUse or PostToolUse in events, `pretool` must be non-empty
 *   - If Stop in events, `stop-response` must be non-empty (a Stop memory
 *     without trigger_stop_response never fires)
 *   - `fire-mode` / `fire-cadence` / `domain` mirror memory-store's
 *     normalization rules (invalid values are rejected here instead of
 *     silently falling back at read time)
 *   - Target store exists (has marker)
 *   - File does not exist unless --force
 *
 * On success prints the path written. Non-zero on validation failure.
 */

const { fs, path, discoverStores, setupCli } = require('../lib/script-bootstrap');

const { flag, cwd } = setupCli();
const name = typeof flag('name') === 'string' ? flag('name') : '';
const desc = typeof flag('desc') === 'string' ? flag('desc') : '';
const eventsRaw = typeof flag('events') === 'string' ? flag('events') : '';
const prompt = typeof flag('prompt') === 'string' ? flag('prompt') : '';
const pretool = typeof flag('pretool') === 'string' ? flag('pretool') : '';
const stopResponse = typeof flag('stop-response') === 'string' ? flag('stop-response') : '';
const fireMode = typeof flag('fire-mode') === 'string' ? flag('fire-mode') : '';
const fireCadenceRaw = flag('fire-cadence');
const domainRaw = typeof flag('domain') === 'string' ? flag('domain') : '';
const enforceRaw = typeof flag('enforce') === 'string' ? flag('enforce') : '';
const enforceClassifier =
  typeof flag('enforce-classifier') === 'string' ? flag('enforce-classifier') : '';
const enforceSatisfiedBy =
  typeof flag('enforce-satisfied-by') === 'string' ? flag('enforce-satisfied-by') : '';
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

const VALID_EVENTS = new Set([
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'SessionStart',
  'Stop',
]);
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
if (events.includes('PostToolUse') && !pretool)
  die('--pretool is required when events includes PostToolUse');
// A Stop memory without trigger_stop_response never fires (the matcher
// returns no-stop-response-configured), so refuse to author a dead memory.
if (events.includes('Stop') && !stopResponse)
  die('--stop-response is required when events includes Stop');

// Mirror memory-store's normalization rules (parseFireMode / parseFireCadence /
// toList) — but reject invalid values here instead of silently falling back at
// read time.
const VALID_FIRE_MODES = new Set(['always', 'once', 'occasionally']);
if (fireMode && !VALID_FIRE_MODES.has(fireMode))
  die(`--fire-mode must be one of ${[...VALID_FIRE_MODES].join(', ')} (got '${fireMode}')`);
let fireCadence = null;
if (fireCadenceRaw !== undefined && fireCadenceRaw !== null && fireCadenceRaw !== '') {
  const n = Number(String(fireCadenceRaw).trim());
  if (!Number.isInteger(n) || n <= 0)
    die(`--fire-cadence must be a positive integer (got '${fireCadenceRaw}')`);
  fireCadence = n;
}
// GH-520 enforce flags. Mirrors memory-store's parseEnforce values but rejects
// invalid input here instead of silently normalizing to advise at read time.
const VALID_ENFORCE = new Set(['advise', 'suggest', 'block']);
if (enforceRaw && !VALID_ENFORCE.has(enforceRaw))
  die(`--enforce must be one of ${[...VALID_ENFORCE].join(', ')} (got '${enforceRaw}')`);
// suggest/block only act on the trigger_pretool ladder — without at least one
// trigger_pretool spec the enforce level is dead weight, so refuse to author it.
if ((enforceRaw === 'block' || enforceRaw === 'suggest') && !pretool)
  die(`--enforce=${enforceRaw} requires --pretool (at least one trigger_pretool spec)`);
if (enforceClassifier) {
  const { CLASSIFIER_NAMES } = require('../lib/enforce-classifiers');
  if (!CLASSIFIER_NAMES.includes(enforceClassifier))
    die(
      `--enforce-classifier must be one of ${CLASSIFIER_NAMES.join(', ')} (got '${enforceClassifier}')`
    );
}

const domains = String(domainRaw)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

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

const fmLines = [
  '---',
  `name: ${name}`,
  `description: ${desc.replace(/\n/g, ' ').trim()}`,
  `events: ${events.join(',')}`,
  `trigger_prompt: ${prompt}`,
  `trigger_pretool: ${pretool}`,
];
if (stopResponse) fmLines.push(`trigger_stop_response: ${stopResponse}`);
fmLines.push(`trigger_session: ${session ? 'true' : 'false'}`, `inject: ${inject}`);
if (fireMode) fmLines.push(`fire_mode: ${fireMode}`);
if (fireCadence !== null) fmLines.push(`fire_cadence: ${fireCadence}`);
if (domains.length) fmLines.push(`domain: ${domains.join(',')}`);
if (enforceRaw) fmLines.push(`enforce: ${enforceRaw}`);
if (enforceClassifier) fmLines.push(`enforce_classifier: ${enforceClassifier}`);
if (enforceSatisfiedBy) fmLines.push(`enforce_satisfied_by: ${enforceSatisfiedBy}`);
const fm = [...fmLines, '---', '', body, ''].join('\n');

fs.writeFileSync(outPath, fm);

// R11 / AC-G6: after writing, run `synapsys lint` scoped to pairs involving
// the new memory and warn on high-severity collisions via stderr. Always a
// warning — never a block: exit code is unaffected by the lint result.
try {
  const { lintStore } = require('./synapsys-lint');
  const result = lintStore({ cwd, scope: 'all', onlyInvolving: name });
  const highPairs = (result && Array.isArray(result.pairs) ? result.pairs : []).filter(
    (p) => p.severity === 'high'
  );
  for (const p of highPairs) {
    const colliding = p.a === name ? p.b : p.a;
    console.error(
      `warn: synapsys memorize: new memory '${name}' creates a high severity ${p.rule} pair with '${colliding}'`
    );
  }
} catch (err) {
  // Lint failure must never block memorize; surface a soft note on stderr.
  console.error(
    `warn: synapsys memorize: post-write lint skipped (${err && err.message ? err.message : err})`
  );
}

console.log(JSON.stringify({ written: outPath, store: target.kind, name }, null, 2));
