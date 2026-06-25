---
name: init-worktree
description: Scaffold a worktree-wrapper directory around a git repo. Use when the user says "init worktree", "/init-worktree", "set up worktrees for this repo", "create the w-<repo> wrapper", or wants the standard worktrees/ + tasks/ + scripts/ + .envrc layout so /work and maestro can create per-ticket worktrees.
---

# init-worktree

Wraps an existing git repository in a parent "workspace" directory so that the
main checkout and every per-ticket feature worktree live side-by-side under a
single `worktrees/` folder, with shared `tasks/`, `scripts/`, and a `.envrc`
that `/work` + maestro read.

## Target layout

For a repo named `<repo>`, the skill produces:

```
w-<repo>/
├── .envrc                      # WORKTREES_BASE / TASKS_BASE / provider config
├── <repo>.code-workspace       # VS Code workspace (worktrees/ + tasks/ + scripts/)
├── worktrees/
│   ├── <repo>/                 # main branch checkout (the wrapped repo)
│   └── <repo>-<ticket>/        # feature-branch worktrees (added later)
├── tasks/
│   └── _archived/
└── scripts/
    └── new-worktree.sh         # helper to add a <repo>-<ticket> worktree
```

A `<repo>.code-workspace` is written at the wrapper root (only if absent, like
`.envrc`) with folders pointing at `worktrees/`, `tasks/`, and `scripts/`.

This differs from the older flat convention (main + worktrees as direct
children of the wrapper): here everything checked-out lives under `worktrees/`,
keeping the wrapper root clean (`.envrc`, `tasks/`, `scripts/` only).

## How to run

The work is done by `init-worktree.sh` next to this file. Resolve its path from
the skill directory and call it. Default mode **moves** the existing checkout
into `worktrees/<repo>` (preserving git history and uncommitted changes).

```bash
bash "$SKILL_DIR/init-worktree.sh" [REPO_PATH] [--base <branch>] [--clone] [--name <repo>] [--org <org>] [--gh-user <login>] [--git-name <name> --git-email <email>] [--dry-run]
```

- `REPO_PATH` — path to the repo to wrap (default: current directory).
- `--base <branch>` — base branch (default: repo's current/default branch).
- `--clone` — instead of moving, clone the origin fresh into `worktrees/<repo>`
  and leave the original checkout untouched.
- `--name` / `--org` — override the derived repo name / GitHub org.
- `--gh-user <login>` — pin gh/git auth to this GitHub account: emits a
  `GH_TOKEN` block in `.envrc` that runs `gh auth token -u <login>` and unsets
  (never exports empty) + warns loudly via `log_status` if it fails. Omit to
  skip the block.
- `--git-name <name> --git-email <email>` — hardcode the commit identity
  (`GIT_AUTHOR_*` / `GIT_COMMITTER_*`) in `.envrc`. Pass BOTH or neither; with
  neither, `.envrc` resolves the identity dynamically from `git config`.
- `--dry-run` — print the plan without touching disk.

**Before running, ASK the user** (use `AskUserQuestion`):
1. Which GitHub account to pin gh/git auth to → `--gh-user`. Default the
   recommended option to the current `gh auth status` login. If they have one gh
   account or decline, run without it (no block).
2. Which git commit identity to use → `--git-name` / `--git-email`. Offer the
   `git config user.name`/`user.email` values as the default, or a different
   identity (e.g. a personal vs work email). If they accept the default, omit
   the flags so `.envrc` stays dynamic.

### Important: moving the active repo

Default mode (`move`) relocates `REPO_PATH` to
`<parent>/w-<repo>/worktrees/<repo>`. If you (or an editor/terminal) are sitting
**inside** that directory, the move pulls the floor out — the old path stops
existing. After a move:

1. Tell the user the new path: `w-<repo>/worktrees/<repo>`.
2. They must `cd` there (and reopen any editor/Claude session rooted at the old
   path) before continuing.

If relocating the active checkout is undesirable, use `--clone` (origin must be
pushed) so the original stays put.

## Adding a ticket worktree later

From inside `worktrees/<repo>`:

```bash
bash ../../scripts/new-worktree.sh <ticket> [kebab-desc] [base-branch]
# creates worktrees/<repo>-<ticket> on branch <ticket>-<kebab-desc>
```

## After scaffolding

- `cd w-<repo>` and run `direnv allow` (if direnv is used) so `.envrc` loads.
- The generated `.envrc` is a starting point — review `REPO_NAME`,
  `BASE_BRANCH`, `GITHUB_ORG`, `TICKET_PROVIDER`, and the test-command vars;
  they're guesses derived from the repo, not authoritative.
- `.envrc` is written only if absent; an existing one is never overwritten.
