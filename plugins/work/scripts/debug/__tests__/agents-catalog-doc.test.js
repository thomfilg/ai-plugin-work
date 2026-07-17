'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// GH-316 Task 4 — pin the AGENTS.md documentation-review outcome:
// the `debugger` agent must be discoverable in the catalog table, and the
// "N specialized agents" count line must match the on-disk agent count.
const workRoot = path.resolve(__dirname, '../../..');
const agentsMdPath = path.join(workRoot, 'AGENTS.md');
const agentsDir = path.join(workRoot, 'agents');

function readAgentsMd() {
  return fs.readFileSync(agentsMdPath, 'utf8');
}

function countAgentFiles() {
  return fs.readdirSync(agentsDir).filter((name) => name.endsWith('.md')).length;
}

test('AGENTS.md catalog table lists a `debugger` row with a one-line description', () => {
  const md = readAgentsMd();
  const rowRe = /^\|\s*`debugger`\s*\|\s*(.+?)\s*\|\s*$/m;
  const match = md.match(rowRe);
  assert.ok(
    match,
    'expected a catalog table row for `debugger` (| `debugger` | <description> |) in AGENTS.md'
  );
  const description = match[1].trim();
  assert.ok(
    description.length > 0,
    'the `debugger` catalog row must carry a non-empty one-line description'
  );
  assert.ok(
    !description.includes('\n'),
    'the `debugger` catalog description must be a single line'
  );
});

test('AGENTS.md "N specialized agents" count equals the number of agents/*.md files', () => {
  const md = readAgentsMd();
  const countMatch = md.match(/(\d+)\s+specialized agents/);
  assert.ok(countMatch, 'expected an "N specialized agents" count line in AGENTS.md');
  const documentedCount = Number(countMatch[1]);
  const onDiskCount = countAgentFiles();
  assert.equal(
    documentedCount,
    onDiskCount,
    `AGENTS.md declares ${documentedCount} specialized agents but agents/ contains ${onDiskCount} *.md files (including debugger.md)`
  );
});
