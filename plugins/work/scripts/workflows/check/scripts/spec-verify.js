#!/usr/bin/env node
/**
 * spec-verify.js — Deterministic spec verification checklist runner (GH-169)
 *
 * Parses a `## Verification Checklist` section from a spec.md file and runs
 * machine-checkable assertions. Supports FILE_EXISTS, GREP, TEST_COUNT, REUSES.
 *
 * Usage: node spec-verify.js <spec-path> [--json] [--root <worktree-dir>]
 * Exit codes: 0 = pass (or no checklist), 1 = failures, 2 = script error
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { runChecks } = require('./spec-verify-checkers');

function getWorktreeRoot(specPath) {
  const cwd = path.dirname(path.resolve(specPath));
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return cwd;
  }
}

function parseMarkerLine(line) {
  const spaceIdx = line.indexOf(' ');
  if (spaceIdx === -1) return { type: line, args: [] };
  const type = line.slice(0, spaceIdx);
  const rest = line.slice(spaceIdx + 1).trim();
  if (type === 'GREP') {
    const regexStart = rest.indexOf(' /');
    if (regexStart !== -1) {
      const filePath = rest.slice(0, regexStart);
      const regexPart = rest.slice(regexStart + 1);
      return { type, args: [filePath.trim(), regexPart] };
    }
  }
  return { type, args: rest.split(/\s+/) };
}

function parseChecklistLine(line, markers) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('- ')) return;
  let content = trimmed.slice(2);
  const commentIdx = content.indexOf(' # ');
  if (commentIdx !== -1) content = content.slice(0, commentIdx);
  content = content.trim();
  if (!content) return;
  markers.push(parseMarkerLine(content));
}

function parseChecklist(content) {
  const lines = content.split(/\r?\n/);
  let inChecklist = false;
  const markers = [];
  for (const line of lines) {
    if (/^##\s+Verification Checklist\s*$/.test(line)) {
      inChecklist = true;
      continue;
    }
    if (inChecklist && /^##\s+/.test(line)) break;
    if (!inChecklist) continue;
    parseChecklistLine(line, markers);
  }
  return { hasChecklist: inChecklist, markers };
}

function parseCliArgs(argv) {
  const args = argv.slice(2);
  const jsonMode = args.includes('--json');
  const rootIdx = args.indexOf('--root');
  const explicitRoot = rootIdx !== -1 ? args[rootIdx + 1] : null;
  const skipIndices = new Set(rootIdx !== -1 ? [rootIdx, rootIdx + 1] : []);
  const specPath = args.find((a, i) => !skipIndices.has(i) && a !== '--json');
  return { jsonMode, explicitRoot, specPath };
}

function emitNoChecklist(jsonMode) {
  const result = { hasChecklist: false, checks: [], passed: 0, failed: 0, total: 0, success: true };
  if (jsonMode) console.log(JSON.stringify(result));
  else console.log('No Verification Checklist found — passing (fail-open).');
  process.exit(0);
}

function emitEmptyChecklist(jsonMode) {
  const result = {
    hasChecklist: true,
    checks: [
      {
        type: 'EMPTY_CHECKLIST',
        args: [],
        passed: false,
        reason: 'Verification Checklist header found but contains no markers',
      },
    ],
    passed: 0,
    failed: 1,
    total: 1,
    success: false,
  };
  if (jsonMode) console.log(JSON.stringify(result));
  else console.log('Verification Checklist header found but contains no markers — failing.');
  process.exit(1);
}

function printChecksHuman(checks, passed, failed, total) {
  for (const check of checks) {
    const status = check.passed ? '[PASS]' : '[FAIL]';
    console.log(`${status} ${check.type} ${check.args.join(' ')}`);
    if (!check.passed && check.reason) console.log(`  ${check.reason}`);
    if (check.warning) console.log(`  Warning: unknown marker type`);
  }
  console.log(
    `\nResult: ${passed}/${total} checks passed${failed > 0 ? `, ${failed} failed` : ''}`
  );
}

function emitChecks(checks, jsonMode) {
  const passed = checks.filter((c) => c.passed).length;
  const failed = checks.filter((c) => !c.passed).length;
  const total = checks.length;
  const success = failed === 0;
  if (jsonMode) {
    console.log(JSON.stringify({ hasChecklist: true, checks, passed, failed, total, success }));
  } else {
    printChecksHuman(checks, passed, failed, total);
  }
  process.exit(success ? 0 : 1);
}

function readSpec(specPath) {
  try {
    return fs.readFileSync(specPath, 'utf-8');
  } catch {
    process.stderr.write(`Error: cannot read spec file: ${specPath}\n`);
    process.exit(2);
  }
}

function main() {
  const { jsonMode, explicitRoot, specPath } = parseCliArgs(process.argv);
  if (!specPath) {
    process.stderr.write('Usage: node spec-verify.js <spec-path> [--json] [--root <dir>]\n');
    process.exit(2);
  }
  const content = readSpec(specPath);
  const root = explicitRoot ? path.resolve(explicitRoot) : getWorktreeRoot(specPath);
  const { hasChecklist, markers } = parseChecklist(content);
  if (!hasChecklist) emitNoChecklist(jsonMode);
  if (markers.length === 0) emitEmptyChecklist(jsonMode);
  emitChecks(runChecks(markers, root), jsonMode);
}

main();
