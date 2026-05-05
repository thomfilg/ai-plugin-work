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
  'diff',
  'status',
  'log',
  'show',
  'rev-parse',
  'ls-files',
  'cat-file',
  'describe',
  'shortlog',
  'name-rev',
  'for-each-ref',
]);
// Note: branch, remote, config are handled separately below with flag restrictions

function block(msg) {
  process.stderr.write(`COMMIT-WRITER GUARD: ${msg}\n`);
  process.exit(2);
}

/**
 * Quote-aware shell segment splitter.
 * Splits on && || ; | \n and single & (background) but only outside single/double quotes.
 */
function shellSplitSegments(command) {
  const segments = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      continue;
    }
    if (inSingle || inDouble) {
      current += ch;
      continue;
    }

    // Outside quotes — check for operators
    if (ch === '&' && command[i + 1] === '&') {
      segments.push(current);
      current = '';
      i++;
      continue;
    }
    if (ch === '|' && command[i + 1] === '|') {
      segments.push(current);
      current = '';
      i++;
      continue;
    }
    if (ch === ';' || ch === '\n') {
      segments.push(current);
      current = '';
      continue;
    }
    if (ch === '|') {
      segments.push(current);
      current = '';
      continue;
    }
    if (ch === '&') {
      segments.push(current);
      current = '';
      continue;
    } // single & (background)
    current += ch;
  }
  if (current.trim()) segments.push(current);
  return segments.map((s) => s.trim()).filter(Boolean);
}

/**
 * Quote-aware metacharacter check.
 * Returns true if >, <, backtick, $( or single & appears outside quotes.
 * Allows safe redirections to /dev/null (e.g. 2>/dev/null, >/dev/null).
 */
function hasUnsafeMetachars(s) {
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }

    // Command substitution ($(), backtick) executes even inside double quotes —
    // only single quotes suppress execution, so reject these unless in single quotes.
    if (ch === '`' && !inSingle) return true;
    if (ch === '$' && s[i + 1] === '(' && !inSingle) return true;

    // Remaining metacharacters are safe inside any quotes
    if (inSingle || inDouble) continue;

    // Allow 2>/dev/null or >/dev/null (safe stderr/stdout suppression)
    if (
      (ch === '>' || (ch >= '0' && ch <= '9' && s[i + 1] === '>')) &&
      /^[0-9]?>\s*\/dev\/null/.test(s.slice(i))
    ) {
      i = s.indexOf('/dev/null', i) + 8; // skip past /dev/null
      continue;
    }
    if (ch === '>' || ch === '<') return true;
    if (ch === '&' && s[i - 1] !== '&' && s[i + 1] !== '&') return true;
  }
  return false;
}

function checkSegment(segment) {
  const s = segment.trim();
  if (!s) return; // skip empty segments from splits

  // ── Pre-check: reject shell metacharacters outside quotes ──
  // Block: redirections (> <), command substitution ($() or backtick), single & (background).
  // Quote-aware: characters inside single/double quotes are safe (e.g. grep patterns).
  // Allows safe redirections to /dev/null (e.g. 2>/dev/null).
  if (hasUnsafeMetachars(s)) {
    block(
      `Shell metacharacters (>, <, \`, $(), &) outside quotes are forbidden. Blocked: ${s.slice(0, 100)}`
    );
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
        block(
          `'git commit -a/--all' is not allowed — commit only staged files. Blocked: ${s.slice(0, 100)}`
        );
      }
      if (/\s(-o|--only)\b/.test(s)) {
        block(
          `'git commit --only' is not allowed — commit only staged files. Blocked: ${s.slice(0, 100)}`
        );
      }
      return; // allowed: commit staged files with -m
    }

    // git push — shell metacharacters already rejected by pre-check above; only force-push blocked here
    if (sub === 'push') {
      if (/--force\b|--force-with-lease\b|\s-f\b/.test(s))
        block(`'git push --force/-f' is not allowed. Blocked: ${s.slice(0, 100)}`);
      return; // safe: hasUnsafeMetachars() pre-check above rejects >, <, `, $(), & outside quotes
    }

    // git tag — only listing (no creation, deletion, annotation, signing)
    if (sub === 'tag') {
      // Allow: bare "git tag", "git tag -l [pattern]", "git tag --list [pattern]"
      // Block: any positional tag name (creation), or mutation flags (-a, -d, -s, --delete, -m, etc.)
      const tagArgs = s.replace(/^git\s+tag\s*/, '').trim();
      // Block mutation flags in unquoted portions of args (even after -l)
      // Strip quoted strings before checking so patterns like "v1.0-d" don't false-positive
      const unquotedTagArgs = tagArgs.replace(/"[^"]*"|'[^']*'/g, '""');
      if (/(-a|-d|-s|-f|-m|--delete|--annotate|--sign|--force|--message)\b/.test(unquotedTagArgs)) {
        block(`'git tag' mutation flags are not allowed. Blocked: ${s.slice(0, 100)}`);
        return;
      }
      if (tagArgs === '' || /^(-l|--list)(\s|$)/.test(tagArgs)) {
        return; // allowed: bare listing or explicit -l/--list
      }
      block(`'git tag' only allowed for listing. Blocked: ${s.slice(0, 100)}`);
      return;
    }

    // git branch — listing only; block mutation flags (-d/-D/-m/-M/-c/-C/--set-upstream/--delete)
    if (sub === 'branch') {
      if (
        /\s(-d|-D|-m|-M|-c|-C|--delete|--move|--copy|--set-upstream|--unset-upstream)\b/.test(s)
      ) {
        block(`'git branch' mutation flags are not allowed. Blocked: ${s.slice(0, 100)}`);
      }
      return; // allowed (list only)
    }

    // git remote — strict allowlist: only bare `git remote`, `-v`, `show <name>`, `get-url <name>`
    if (sub === 'remote') {
      const remoteArgs = s.replace(/^git\s+remote\s*/, '').trim();
      if (
        !remoteArgs ||
        /^(-v|--verbose)$/.test(remoteArgs) ||
        /^(show|get-url)\s+\S/.test(remoteArgs)
      ) {
        return; // allowed: list, verbose list, show, get-url
      }
      block(
        `'git remote ${remoteArgs.split(/\s/)[0]}' is not allowed — only list/show/get-url permitted. Blocked: ${s.slice(0, 100)}`
      );
    }

    // git config — read-only queries only
    // Allowed: git config --get <key>, git config --list, git config <section.key> (single positional arg = read)
    // Blocked: write flags, or 2+ positional args (git config <key> <value> = write)
    if (sub === 'config') {
      // Block write/mutation flags
      if (
        /\s(--add|--unset|--unset-all|--remove-section|--rename-section|--global|--system|--worktree|--local|--file|--blob)\b/.test(
          s
        )
      ) {
        block(`'git config' write flags are not allowed. Blocked: ${s.slice(0, 100)}`);
      }
      // Block write form: 2+ positional (non-flag) args means a value is being set
      // e.g. "git config user.email foo@bar.com" → ["user.email","foo@bar.com"] → blocked
      // e.g. "git config user.email"             → ["user.email"]              → allowed (read)
      const positionalArgs = s
        .replace(/^git\s+config/, '')
        .trim()
        .split(/\s+/)
        .filter((a) => a && !a.startsWith('-'));
      if (positionalArgs.length >= 2) {
        block(
          `'git config <key> <value>' (write form) is not allowed. Blocked: ${s.slice(0, 100)}`
        );
      }
      return; // allowed: --get, --list, or single-key read query
    }

    // Read-only subcommands — block --output/-o to prevent filesystem writes
    if (ALLOWED_GIT_READ.has(sub)) {
      if (/\s(--output[\s=]|-o\s)/.test(s))
        block(`'git ${sub} --output/-o' writes files — not allowed. Blocked: ${s.slice(0, 100)}`);
      return; // safe: diff, status, log, show, rev-parse, ls-files, etc.
    }

    // Everything else (reset, rebase, checkout, fetch, pull, add, rm, stash, merge, etc.) — BLOCKED
    block(
      `'git ${sub}' is not allowed. commit-writer only does: git commit, git push, and read-only git commands. Blocked: ${s.slice(0, 100)}`
    );
  }

  // ── grep — commitlint/cz setup detection only (package.json or .commitlintrc) ──
  if (/^grep\b/.test(s)) {
    // Extract non-flag arguments (skip -E, -i, -q, etc. and their values)
    const grepParts = s.replace(/^grep\s+/, '').split(/\s+/);
    const nonFlags = grepParts.filter((a) => !a.startsWith('-'));
    // First non-flag is the pattern, rest are file operands — ALL must be allowed filenames
    const fileArgs = nonFlags.slice(1);
    const allowedFiles = /^(\.\/)?package\.json$|^\.commitlintrc/;
    if (
      fileArgs.length > 0 &&
      fileArgs.every((f) => allowedFiles.test(f)) &&
      !fileArgs.some((f) => f.startsWith('/') || f.includes('..'))
    ) {
      return; // allowed: all file operands are package.json or .commitlintrc variants
    }
    block(
      `grep is only allowed for commitlint/cz setup detection targeting package.json or .commitlintrc. Blocked: ${s.slice(0, 100)}`
    );
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
      block(
        `'echo' with redirections, pipes, or command substitutions is not allowed. Blocked: ${s.slice(0, 100)}`
      );
    }
    return; // allowed
  }

  // ── Everything else is BLOCKED ────────────────────────────────────────────
  block(
    `Command not in whitelist. commit-writer only runs git commit, git push, and read-only git commands. Blocked: ${s.slice(0, 100)}`
  );
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

    // Quote-aware split on shell separators: &&, ||, ;, |, newline, single & (background)
    const segments = shellSplitSegments(command);

    if (segments.length === 0) block('Empty command after parsing.');

    for (const seg of segments) {
      checkSegment(seg);
    }

    process.exit(0); // all segments passed
  }

  // Everything else (Write, Edit, Task, Skill, MultiEdit, etc.) — BLOCKED
  block(
    `Tool '${toolName}' is not allowed. commit-writer only uses: Read, Grep, Glob, and whitelisted Bash commands.`
  );
}

main().catch((err) => {
  process.stderr.write(`COMMIT-WRITER GUARD ERROR: ${err.message}\n`);
  process.exit(2);
});
