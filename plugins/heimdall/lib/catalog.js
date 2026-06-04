'use strict';

/**
 * Default protection catalog — mirrors the passphrase-style protectors that
 * live in ~/.claude/hooks today, so a fresh install suggests the same things
 * the user already guards by hand.
 *
 * Only phrase-unlock protectors are represented. The agent-authorization gates
 * (protect-report-files, protect-task-folders, protect-coverage-enforcement)
 * and the git-commit gate (protect-claude-git) don't fit Heimdall's
 * "speak a phrase to unlock" model and are intentionally omitted.
 *
 * Each target has an `anchor`:
 *   'repo' → resolved against the repo root; suggested for any store kind, but
 *            ONLY when it actually exists in the repository.
 *   'home' → resolved against the home dir; suggested for the `global` kind
 *            only (a home path is not "in the repository", so local/worktree
 *            installs never suggest it).
 */

const CATALOG = [
  {
    id: 'claude-config',
    label: 'Claude config directory',
    description: 'Hooks, settings, agents, commands (mirror of protect-claude-config.js)',
    defaultPhrase: 'edit .claude',
    allowedPaths: ['plans', 'dev', 'projects', 'external_scripts', 'plugins'],
    trustedSubdirs: ['hooks', 'plugins', 'external_scripts'],
    targets: [
      { path: '.claude', anchor: 'repo' },
      { path: '~/.claude', anchor: 'home' },
    ],
  },
  {
    id: 'root-package-json',
    label: 'Root package.json',
    description:
      'Workspace scripts, dependencies, lockfile surface (mirror of protect-package-json.js)',
    defaultPhrase: 'edit package.json',
    targets: [{ path: 'package.json', anchor: 'repo' }],
  },
  {
    id: 'packages-ui',
    label: 'Shared UI package',
    description: 'packages/ui shared component library (mirror of protect-ui-package.js)',
    defaultPhrase: 'edit ui',
    targets: [{ path: 'packages/ui', anchor: 'repo' }],
  },
  {
    id: 'github-dir',
    label: '.github directory',
    description: 'CI workflows, actions, CODEOWNERS, templates (mirror of protect-github-dir.js)',
    defaultPhrase: 'edit .github',
    targets: [{ path: '.github', anchor: 'repo' }],
  },
];

module.exports = { CATALOG };
