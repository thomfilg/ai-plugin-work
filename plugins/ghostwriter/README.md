# ghostwriter

**The agent writes. The person signs.**

A standalone plugin with exactly one job, applied everywhere an agent can sign something: an AI tool may not credit itself for the work, and may not do the work under a machine's account.

That covers two questions at every surface:

- **What it says** — no co-author trailers, no "Generated with …" footers, no product links, no session stamps. In commit messages, and in pull requests, issues and comments.
- **Who it says wrote it** — no committing or commenting as a tool-named or bot account instead of the person's own.

Naming a product is not attribution. `feat: add <vendor> adapter` is ordinary engineering and always ships.

## How it enforces

| Layer | Covers | Where |
|---|---|---|
| `PreToolUse` on `Bash` | git authorship, and `gh` posts to PRs and issues | `hooks/ghostwriter.js` |
| `PreToolUse` on `mcp__github__*` | PR, issue and comment text posted through MCP | same hook |
| `commit-msg` git hook (opt-in) | commits from a terminal, a script, an editor | `/ghostwriter:install` |
| CLI | checking a message by hand or from CI | `scripts/ghostwriter-check.js` |

The PreToolUse hooks are always on once the plugin is installed. The git hook is opt-in because it writes into the repository's hooks directory.

## Pinning the human (optional)

By default the identity rules are a blocklist: they catch tool names and bot-shaped accounts (`…[bot]`, `release-bot`, `github-actions`). That cannot catch a plainly-named app account, and it cannot tell one person from another. Set the expected human and the question becomes exact — everything must be signed by them:

```bash
export GHOSTWRITER_HUMAN_EMAIL=me@example.com
export GHOSTWRITER_HUMAN_LOGIN=my-github-login
```

With a human pinned, anything else is refused, including an identity the guard simply cannot read.

## What gets blocked

Five rules, applied in that order so the sharpest evidence wins:

| Rule | Example |
|---|---|
| `aiCoAuthorTrailer` | `Co-Authored-By: <tool> <noreply@…>` |
| `aiGeneratedPhrase` | `🤖 Generated with [<tool> Code](…)` |
| `aiAttributionLink` | a product attribution URL in the body |
| `aiSessionTrailer` | `<Tool>-Session: https://…` |
| `aiIdentity` | `user.name`, `--author=`, `GIT_AUTHOR_NAME` naming a tool |

## The five passes

A command that authors a git object is inspected five ways, and the first finding blocks:

1. **message arguments** — `-m` / `--message` values
2. **message files** — `-F` / `--file` contents
3. **identity literals** — `--author`, `GIT_AUTHOR_NAME=…`, `git config user.*`
4. **the raw command** — heredoc bodies, unquoted `$(…)`, chained writes
5. **the repo identity** — what `git config user.name/user.email` resolves to

Pass 4 is why quoting tricks do not help: the same shape-specific rules run over the whole command text. Pass 5 is why setting the identity in an earlier session does not help either — a clean message committed as a tool is still attribution.

Commands that author nothing are never inspected. `echo "Co-Authored-By: …"`, `git status` and `grep -r "git commit"` all fall straight through, and the repo identity is not even read.

A block looks like this:

```
ghostwriter: this command would sign the work as an AI.

  rule      aiCoAuthorTrailer
  where     git commit message
  problem   an authorship trailer credits an AI tool
  evidence  Co-Authored-By: … <noreply@…>

↳ Fix: Delete the trailer — the commit belongs to the person who ran the tool.

The change belongs to the person who asked for it. Tools do not get a byline.
```

## What the PreToolUse layer cannot see

The hook inspects a command **before** the shell runs it, so it reads the command as written, not as expanded. Anything whose content only exists after expansion is invisible to it:

```bash
git commit -m "feat: x

$(cat footer.txt)"        # the footer is not in the command text
git commit -m "$FOOTER"   # neither is the variable's value
cat footer.txt | git commit -F -
```

This is not a gap that can be closed by better parsing — evaluating those would mean executing the command, which a guard must never do. Forms whose content *is* in the command text are covered: heredoc bodies, `$(cat <<'EOF' … EOF)`, `< file` redirects, and `echo "…" | git commit -F -` all get inspected.

**The `commit-msg` hook is the layer that closes this.** Git hands it the final message, after every expansion, so it sees exactly what would be committed. If you want the guarantee to hold against evasion rather than accident, run `/ghostwriter:install` — the PreToolUse hook gives fast feedback at the point of the mistake, and the git hook is the backstop that cannot be talked around.

Identity is treated more strictly than message text, because there are fewer ways to write it: `--config-env=user.name=VAR` is resolved from the command's own assignments or the guard's environment, and a value the guard genuinely cannot read blocks as `unverifiableIdentity` rather than passing. Message files too large to read in full block as `unverifiableMessage`. A partial check is never reported as a pass.

## Failure policy

Two tiers, because the right answer differs by how much is at stake:

- **fail-open** for anything that is not a git authorship command. A guard that bricks the shell when it has a bug is worse than the attribution it prevents.
- **fail-closed** once the command is known to author a commit. Silently allowing an unchecked commit is the one outcome this plugin exists to prevent, so inspection errors there block with the reason on stderr.

## The escape hatch

`GHOSTWRITER_ALLOW_ATTRIBUTION=1` lifts every rule — but only from the hook's **own** environment. If the string appears inside the command being inspected, the override is refused and the block message says so. An override a command grants itself is not an override; it is the thing the guard exists to prevent, spelled differently.

Export it from the shell that launches your session when you genuinely need it — quoting a trailer in a docs commit, or committing as a person whose real name collides with the vocabulary.

## Commands

```bash
# check a message, a file, or the identity a commit would carry
node scripts/ghostwriter-check.js --message "feat: add the guard (#12)"
node scripts/ghostwriter-check.js .git/COMMIT_EDITMSG
node scripts/ghostwriter-check.js --identity .

# git-level enforcement
node scripts/install-commit-msg-hook.js --status
node scripts/install-commit-msg-hook.js
node scripts/install-commit-msg-hook.js --uninstall
```

Exit codes: `0` clean, `1` attribution found, `2` usage error.

Skills: `/ghostwriter:check` and `/ghostwriter:install`.

## The vocabulary

Tool names live in `lib/attribution.js`, assembled from string fragments so the file carries no contiguous tool-name literal — the rules run over sources, diffs and whole shell commands, and a blocklist that matches itself makes every audit a false positive. A test asserts that property holds.

Names that collide with common words or common surnames are deliberately excluded. A guard that rejects a real person because of their surname is worse than the attribution it prevents; for the collisions that remain, the escape hatch is the answer.

## Layout

```
ghostwriter/
├── hooks/
│   ├── hooks.json              PreToolUse registration (matcher: Bash)
│   └── ghostwriter.js          the guard
├── lib/
│   ├── attribution.js          the rules — attribution vs identity
│   ├── git-surfaces.js         quote-aware command reader
│   ├── git-identity.js         effective git identity
│   ├── guard.js                the five-pass decision
│   ├── hookEntrypoint/         vendored from factories/ (do not edit)
│   └── runtime/                vendored from factories/ (do not edit)
├── scripts/
│   ├── ghostwriter-check.js    the CLI
│   └── install-commit-msg-hook.js
└── skills/{check,install}/SKILL.md
```

## Tests

```bash
node --test plugins/ghostwriter/lib/__tests__/*.test.js
node --test plugins/ghostwriter/hooks/__tests__/*.test.js
node --test plugins/ghostwriter/scripts/__tests__/*.test.js
```

The hook and CLI tests spawn real processes and assert exit codes, and the installer test drives a real `git commit` through the installed hook — the exit code is the contract, so it is tested as one.

## Relationship to the `work` plugin

`work` enforces a whole commit contract (semantic format, ticket id, imperative mood, no attribution) but only along its own sanctioned commit path. ghostwriter enforces one rule, everywhere, with no workflow attached. Running both is fine: they agree on this rule, and ghostwriter also covers `--author`, environment identity overrides, `git config` writes, tags, merges and notes.
