#!/usr/bin/env node
'use strict';

/**
 * Initialize a Synapsys memory store.
 *
 *   node synapsys-init.js --kind=<local|worktree|global> [--cwd=<path>]
 *
 * Creates the directory (if missing) and writes a `.synapsys.json` marker.
 * The marker is what makes the directory discoverable by the hooks —
 * synapsys only reads from directories that have the marker.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MARKER, FOLDER, getProjectName, candidateStores } = require(
  path.join(__dirname, '..', 'lib', 'memory-store')
);

function parseArgs(argv) {
  const out = { kind: 'local', cwd: process.cwd() };
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([a-z]+)=(.+)$/);
    if (!m) continue;
    out[m[1]] = m[2];
  }
  return out;
}

const args = parseArgs(process.argv);
const projectName = getProjectName(args.cwd);
const target = candidateStores(args.cwd, projectName).find((c) => c.kind === args.kind);

if (!target) {
  console.error(`unknown kind: ${args.kind} (use local|worktree|global)`);
  process.exit(1);
}

fs.mkdirSync(target.dir, { recursive: true });
const markerPath = path.join(target.dir, MARKER);
const marker = {
  kind: args.kind,
  projectName,
  createdAt: new Date().toISOString(),
  schemaVersion: 1,
};
fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`);

const indexPath = path.join(target.dir, 'INDEX.md');
if (!fs.existsSync(indexPath)) {
  fs.writeFileSync(
    indexPath,
    [
      `# Synapsys memories — ${projectName} (${args.kind})`,
      '',
      'One memory per file. Frontmatter declares triggers + lifecycle events.',
      'Example schema (single-line values only — no nested YAML):',
      '',
      '```',
      '---',
      'name: example',
      'description: one-line summary',
      'events: UserPromptSubmit,PreToolUse',
      'trigger_prompt: \\b(jira|ticket)\\b',
      'trigger_pretool: Bash:git push,Bash:rm -rf',
      'trigger_session: false',
      'inject: summary',
      '---',
      '',
      'Body of the memory…',
      '```',
      '',
    ].join('\n')
  );
}

console.log(
  `initialized synapsys store at ${target.dir} (kind=${args.kind}, project=${projectName})`
);
