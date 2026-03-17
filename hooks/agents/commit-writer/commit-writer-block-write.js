#!/usr/bin/env node

/**
 * PreToolUse WHITELIST guard for commit-writer agent.
 *
 * WHITELIST approach: ONLY explicitly allowed commands pass. Everything else is BLOCKED.
 *
 * Allowed Bash commands (per segment after splitting on && || ; | newline):
 *   WRITE: git commit, git push (no --force/-f)
 *   READ:  git diff, git status, git log, git show, git rev-parse,
 *          git ls-files, git cat-file, git describe,
 *          git shortlog, git name-rev, git for-each-ref, git tag (list only)
 *          git branch (list only: no -d/-D/-m/-M/-c/-C), git remote (show/get-url/v only),
 *          git config (read-only: --get/--list/--get-all only, never --global/--system/--add/--unset)
 *   SETUP: grep (package.json / commitlintrc check only), ls (commitlintrc check only)
 *
 * Uses exit codes:
 *   exit 0 = allow
 *   exit 2 = block (stderr message fed back to Claude)
 */

// Allowed git subcommands that are purely read-only and require no further scrutiny
const ALLOWED_GIT_READ = new Set([
  'diff', 'status', 'log', 'show', 'rev-parse',
  'ls-files', 'cat-file', 'describe',
  'shortlog', 'name-rev', 'for-each-ref',
]);
// Note: branch, remote, config are handled separately below with flag restrictions

function block(msg) {
  process.stderr.write(`COMMIT-WRITER GUARD: ${msg}\n`);
  process.exit(2);
}

function checkSegment(segment) {
  const s = segment.trim();
  if (!s) return; // skip empty segments from splits

  // ── Pre-check: reject shell injection features in ALL segments ────────────
  // Block command substitution ($(...), `...`), redirections (>, >>, <, <<), and
  // process substitution (<(...), >(...)) that could execute or write despite an "allowed" prefix
  if (/\$\(|`|>>|<<|>\(|<\(/.test(s) || /(?:^|[^-])>(?!\()/.test(s) || /(?:^|[^<])<(?!\()/.test(s)) {
    block(`Shell injection features (redirections, command/process substitution) are forbidden. Blocked: ${s.slice(0, 100)}`);
  }

  // ── git commands ──────────────────────────────────────────────────────────
  if (/^git\b/.test(s)) {
    const parts = s.split(/\s+/);
    const sub = parts[1]; // git <sub> ...

    if (!sub) block(`Bare 'git' command not allowed. Blocked: ${s.slice(0, 100)}`);

    // git commit — allowed, but restrict flags that stage files or rewrite history
    if (sub === 'commit') {
      if (/--amend\b/.test(s)) {
        block(`'git commit --amend' is not allowed. Blocked: ${s.slice(0, 100)}`);
      }
      if (/\s(-a|--all)\b/.test(s)) {
        block(`'git commit -a/--all' is not allowed — commit only staged files. Blocked: ${s.slice(0, 100)}`);
      }
      if (/\s(-o|--only)\b/.test(s)) {
        block(`'git commit --only' is not allowed — commit only staged files. Blocked: ${s.slice(0, 100)}`);
      }
      return; // allowed: commit staged files with -m
    }

    // git push — allowed, but never --force, --force-with-lease, or -f
    if (sub === 'push') {
      if (/--force\b|--force-with-lease\b|-f\b/.test(s)) {
        block(`'git push --force' is not allowed. Blocked: ${s.slice(0, 100)}`);
      }
      return; // allowed: push to remote
    }

    // git tag — only listing (no -d, -a, -m, no creation)
    if (sub === 'tag') {
      if (!/^git\s+tag\s*(-l|--list)?(\s|$)/.test(s)) {
        block(`'git tag' only allowed for listing. Blocked: ${s.slice(0, 100)}`);
      }
      return; // allowed
    }

    // git branch — listing only; block mutation flags (-d/-D/-m/-M/-c/-C/--set-upstream/--delete)
    if (sub === 'branch') {
      if (/\s(-d|-D|-m|-M|-c|-C|--delete|--move|--copy|--set-upstream|--unset-upstream)\b/.test(s)) {
        block(`'git branch' mutation flags are not allowed. Blocked: ${s.slice(0, 100)}`);
      }
      return; // allowed (list only)
    }

    // git remote — read-only queries only (show, get-url, -v/--verbose); block add/remove/set-url
    if (sub === 'remote') {
      if (/\s(add|remove|rm|rename|set-url|set-head|set-branches|prune)\b/.test(s)) {
        block(`'git remote' mutation subcommands are not allowed. Blocked: ${s.slice(0, 100)}`);
      }
      return; // allowed (show, get-url, -v, etc.)
    }

    // git config — read-only queries only
    // Allowed: git config --get <key>, git config --list, git config <section.key> (single positional arg = read)
    // Blocked: write flags, or 2+ positional args (git config <key> <value> = write)
    if (sub === 'config') {
      // Block write/mutation flags
      if (/\s(--add|--unset|--unset-all|--remove-section|--rename-section|--global|--system|--worktree|--local|--file|--blob)\b/.test(s)) {
        block(`'git config' write flags are not allowed. Blocked: ${s.slice(0, 100)}`);
      }
      // Block write form: 2+ positional (non-flag) args means a value is being set
      // e.g. "git config user.email foo@bar.com" → ["user.email","foo@bar.com"] → blocked
      // e.g. "git config user.email"             → ["user.email"]              → allowed (read)
      const positionalArgs = s.replace(/^git\s+config/, '').trim().split(/\s+/).filter((a) => a && !a.startsWith('-'));
      if (positionalArgs.length >= 2) {
        block(`'git config <key> <value>' (write form) is not allowed. Blocked: ${s.slice(0, 100)}`);
      }
      return; // allowed: --get, --list, or single-key read query
    }

    // All other allowed read-only subcommands
    if (ALLOWED_GIT_READ.has(sub)) {
      return; // allowed
    }

    // Everything else (reset, rebase, checkout, fetch, pull, add, rm, stash, merge, etc.) — BLOCKED
    block(`'git ${sub}' is not allowed. commit-writer only does: git commit, git push, and read-only git commands. Blocked: ${s.slice(0, 100)}`);
  }

  // ── grep — commitlint/cz setup detection only (package.json or .commitlintrc) ──
  if (/^grep\b/.test(s)) {
    // package.json must appear as a standalone word (file target), not just mentioned in a pattern
    // .commitlintrc is allowed anywhere since it's specific enough to not be abusable
    if (/(?:^|\s)package\.json(\s|$)/.test(s) || /\.commitlintrc/.test(s)) {
      return; // allowed
    }
    block(`grep is only allowed for commitlint/cz setup detection in package.json or .commitlintrc. Blocked: ${s.slice(0, 100)}`);
  }

  // ── ls — only for commitlintrc check ─────────────────────────────────────
  if (/^ls\b/.test(s)) {
    if (/commitlintrc/.test(s)) {
      return; // allowed
    }
    block(`'ls' is only permitted for commitlintrc file detection. Blocked: ${s.slice(0, 100)}`);
  }

  // ── echo — only harmless informational output (no redirections or pipes) ─────
  if (/^echo\b/.test(s)) {
    // Block redirections and command substitutions that could write to files or execute commands
    if (/[>|`]/.test(s)) {
      block(`'echo' with redirections, pipes, or command substitutions is not allowed. Blocked: ${s.slice(0, 100)}`);
    }
    return; // allowed
  }

  // ── Everything else is BLOCKED ────────────────────────────────────────────
  block(`Command not in whitelist. commit-writer only runs git commit, git push, and read-only git commands. Blocked: ${s.slice(0, 100)}`);
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let hookData; // parsed JSON from Claude Code hook system (contains tool_name + tool_input)
  try {
    hookData = JSON.parse(input);
  } catch (err) {
    block(`Failed to parse hook input: ${err.message}`);
  }

  const toolName = hookData.tool_name || '';

  // Allow read-only tools unconditionally (LS is the list-directory tool in some hook contexts)
  if (['Read', 'Grep', 'Glob', 'LS', 'Ls'].includes(toolName)) {
    process.exit(0);
  }

  // Bash — apply whitelist per segment
  if (toolName === 'Bash') {
    const command = (hookData.tool_input?.command || '').trim();
    if (!command) block('Empty command.');

    // Split on all shell separators including newlines
    const segments = command
      .split(/&&|\|\||[;|\n]/)
      .map(s => s.trim())
      .filter(Boolean);

    if (segments.length === 0) block('Empty command after parsing.');

    for (const seg of segments) {
      checkSegment(seg);
    }

    process.exit(0); // all segments passed
  }

  // Everything else (Write, Edit, Task, Skill, MultiEdit, etc.) — BLOCKED
  block(`Tool '${toolName}' is not allowed. commit-writer only uses: Read, Grep, Glob, and whitelisted Bash commands.`);
}

main().catch(err => {
  process.stderr.write(`COMMIT-WRITER GUARD ERROR: ${err.message}\n`);
  process.exit(2);
});
