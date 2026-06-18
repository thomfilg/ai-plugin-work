#!/usr/bin/env node
'use strict';

/**
 * maestro-schema.js — manage reusable orchestration schemas.
 *
 * A schema persists the reusable knobs of a `/maestro:orchestrate` run — pool
 * size, per-ticket command, and the compiled stop-condition oracle — so the
 * operator can replay them against a fresh `queue` later. Storage mirrors the
 * synapsys memory store exactly (see lib/schema-store.js): tiered, marker-gated
 * directories holding one markdown-with-frontmatter file per schema.
 *
 * The `queue` is NEVER part of a schema — it is per-run.
 *
 * CLI:
 *   init  <local|worktree|global|shared> [--cwd=<path>]
 *         Create the store dir + .maestro.json marker (idempotent).
 *
 *   save  <name> --tier=<kind>
 *         [--pool=<N>] [--command=/X] [--stop-source="…"] [--stop-oracle="…"]
 *         [--compiled-from="skill@ver (script)"] [--description="…"] [--force]
 *         Write <name>.md into the chosen tier's store. Refuses if the tier has
 *         no marker (run init first) or the name exists (unless --force).
 *
 *   list                  JSON array of every schema across discovered tiers.
 *   show  <name>          JSON for the named schema (errors if ambiguous).
 *   delete <name> [--tier=<kind>]   Remove the schema file.
 *
 * `name` must be kebab-case (letters/digits/dashes). Oracles may contain any
 * shell — they are quoted on write and run verbatim by the conductor.
 */

const fs = require('node:fs');
const path = require('node:path');

const store = require(path.join(__dirname, '..', 'lib', 'schema-store'));
const {
  MARKER,
  getProjectName,
  candidateStores,
  discoverStores,
  serializeFrontmatter,
  listSchemas,
  findSchemaTiers,
} = store;

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const VALID_TIERS = new Set(['local', 'worktree', 'global', 'shared']);

function die(msg, code = 1) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(code);
}

// Parse `--flag=value` (and bare positional args) into { _: [...], flag: value }.
function parseArgs(argv) {
  const out = { _: [] };
  for (const a of argv) {
    const m = a.match(/^--([a-z][a-z-]*)=([\s\S]*)$/);
    if (m) out[m[1]] = m[2];
    else if (a === '--force') out.force = true;
    else out._.push(a);
  }
  return out;
}

function cmdInit(args) {
  const kind = args._[0];
  if (!VALID_TIERS.has(kind)) die(`init needs a tier: local|worktree|global|shared (got '${kind}')`);
  const cwd = args.cwd || process.cwd();
  const projectName = getProjectName(cwd);
  const target = candidateStores(cwd, projectName).find((c) => c.kind === kind);
  if (!target) die(`unknown tier: ${kind}`);

  fs.mkdirSync(target.dir, { recursive: true });
  const marker = {
    kind,
    ...(kind === 'shared' ? {} : { projectName }),
    createdAt: new Date().toISOString(),
    schemaVersion: 1,
  };
  fs.writeFileSync(path.join(target.dir, MARKER), `${JSON.stringify(marker, null, 2)}\n`);

  const indexPath = path.join(target.dir, 'INDEX.md');
  const scope = kind === 'shared' ? 'all projects' : projectName;
  // Exclusive create (`wx`) instead of existsSync-then-write: writes the
  // starter index atomically and leaves an already-present one untouched,
  // without the check-then-write race (CodeQL).
  try {
    fs.writeFileSync(
      indexPath,
      [
        `# Maestro orchestration schemas — ${scope} (${kind})`,
        '',
        'One schema per file. Frontmatter declares the reusable run knobs;',
        '`queue` is never saved (per-run). Example:',
        '',
        '```',
        '---',
        'name: opera1',
        'description: qc-work driven by /follow-up pass oracle, single slot',
        'pool_size: 1',
        'command: /qc-work',
        'stop_source: when /follow-up skill says that it passed',
        'stop_oracle: "node $FOLLOWUP/follow-up-next.js \\"$TICKET\\" --json | jq -e \'.action==\\"complete\\"\'"',
        'compiled_from: follow-up@3.45.2 (follow-up-next.js)',
        '---',
        '```',
        '',
      ].join('\n'),
      { flag: 'wx' }
    );
  } catch (e) {
    if (e.code !== 'EEXIST') throw e; // starter index already present — keep it
  }
  const scopeNote = kind === 'shared' ? 'scope=all projects' : `project=${projectName}`;
  console.log(`initialized maestro schema store at ${target.dir} (tier=${kind}, ${scopeNote})`);
}

function cmdSave(args) {
  const name = args._[0];
  if (!name) die('save needs a <name>');
  if (!NAME_RE.test(name)) die(`name must be kebab-case (got '${name}')`);
  const kind = args.tier;
  if (!VALID_TIERS.has(kind)) die(`save needs --tier=<local|worktree|global|shared> (got '${kind}')`);

  const cwd = args.cwd || process.cwd();
  const target = discoverStores(cwd).find((s) => s.kind === kind);
  if (!target) {
    die(`no maestro store in tier '${kind}' — run: maestro-schema.js init ${kind}`);
  }

  const file = path.join(target.dir, `${name}.md`);
  const meta = {
    name,
    description: args.description || '',
    pool_size: args.pool !== undefined ? parseInt(args.pool, 10) : undefined,
    command: args.command || undefined,
    stop_source: args['stop-source'] || undefined,
    stop_oracle: args['stop-oracle'] || undefined,
    compiled_from: args['compiled-from'] || undefined,
    compiled_at: new Date().toISOString().slice(0, 10),
  };
  const content = serializeFrontmatter(meta, args.body || '');
  // Exclusive create unless --force: `wx` fails atomically when the schema
  // already exists, so there is no existsSync-then-write race (CodeQL). With
  // --force we intentionally overwrite.
  try {
    fs.writeFileSync(file, content, args.force ? undefined : { flag: 'wx' });
  } catch (e) {
    if (e.code === 'EEXIST') {
      die(`schema '${name}' already exists in tier '${kind}' (use --force to overwrite)`);
    }
    throw e;
  }
  console.log(`saved schema '${name}' to ${file} (tier=${kind})`);
}

function cmdList(args) {
  console.log(JSON.stringify(listSchemas(args.cwd || process.cwd()), null, 2));
}

function cmdShow(args) {
  const name = args._[0];
  if (!name) die('show needs a <name>');
  const hits = findSchemaTiers(args.cwd || process.cwd(), name);
  if (hits.length === 0) die(`no schema '${name}' found in any tier`);
  if (hits.length > 1) {
    die(
      `schema '${name}' is ambiguous — exists in tiers: ${hits.map((h) => h.store).join(', ')}. ` +
        `Disambiguate by removing duplicates or reading the file directly.`
    );
  }
  console.log(JSON.stringify(hits[0], null, 2));
}

function cmdDelete(args) {
  const name = args._[0];
  if (!name) die('delete needs a <name>');
  let hits = findSchemaTiers(args.cwd || process.cwd(), name);
  if (args.tier) hits = hits.filter((h) => h.store === args.tier);
  if (hits.length === 0) die(`no schema '${name}'${args.tier ? ` in tier '${args.tier}'` : ''}`);
  if (hits.length > 1) {
    die(`schema '${name}' exists in tiers ${hits.map((h) => h.store).join(', ')}; pass --tier to pick one`);
  }
  fs.unlinkSync(hits[0].file);
  console.log(`deleted schema '${name}' (tier=${hits[0].store})`);
}

function main() {
  const [, , cmd, ...rest] = process.argv;
  const args = parseArgs(rest);
  switch (cmd) {
    case 'init':
      return cmdInit(args);
    case 'save':
      return cmdSave(args);
    case 'list':
      return cmdList(args);
    case 'show':
      return cmdShow(args);
    case 'delete':
      return cmdDelete(args);
    default:
      die('usage: maestro-schema.js <init|save|list|show|delete> ...');
  }
}

if (require.main === module) main();

module.exports = { parseArgs, NAME_RE, VALID_TIERS };
