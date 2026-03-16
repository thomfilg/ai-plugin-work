#!/usr/bin/env node

/**
 * bootstrap-publish.js
 *
 * Two modes, called separately from /bootstrap steps 7 and 8:
 *
 *   --commit: Empty commit + push branch (skips if ENABLE_EMPTY_COMMIT is not set)
 *   --pr:     Create draft PR (skips if ENABLE_EMPTY_COMMIT or ENABLE_DRAFT_PR is not set)
 *
 * Usage:
 *   node bootstrap-publish.js --commit <worktree-path> <branch-name> <ticket-id>
 *   node bootstrap-publish.js --pr <worktree-path> <branch-name> <ticket-id>
 */

const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
const mode = args[0];
const [worktreePath, branchName, ticketId] = args.slice(1);

if (!mode || !worktreePath || !branchName || !ticketId) {
  console.error('Usage: bootstrap-publish.js --commit|--pr <worktree-path> <branch-name> <ticket-id>');
  process.exit(1);
}

function run(bin, cmdArgs) {
  console.log(`$ ${bin} ${cmdArgs.join(' ')}`);
  execFileSync(bin, cmdArgs, { cwd: worktreePath, stdio: 'inherit' });
}

if (mode === '--commit') {
  if (!process.env.ENABLE_EMPTY_COMMIT) {
    console.log('ENABLE_EMPTY_COMMIT not set, skipping');
    process.exit(0);
  }
  run('git', ['commit', '--allow-empty', '-m', `chore: bootstrap ${ticketId}`]);
  run('git', ['push', '-u', 'origin', branchName]);
} else if (mode === '--pr') {
  // Both required: without a commit there's no pushed branch to create a PR from
  if (!process.env.ENABLE_EMPTY_COMMIT || !process.env.ENABLE_DRAFT_PR) {
    console.log('ENABLE_EMPTY_COMMIT or ENABLE_DRAFT_PR not set, skipping');
    process.exit(0);
  }
  const body = [
    '## Summary',
    `Bootstrap PR for ${ticketId}`,
    '',
    '## Status',
    '- [ ] Implementation in progress',
    '- [ ] Tests passing',
    '- [ ] Ready for review',
  ].join('\n');
  run('gh', ['pr', 'create', '--title', `${ticketId} - chore: bootstrap task`, '--body', body, '--draft']);
} else {
  console.error(`Unknown mode: ${mode}. Use --commit or --pr`);
  process.exit(1);
}
