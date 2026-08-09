# ghostwriter

**The agent writes. The person signs.**

A standalone plugin with exactly one job, applied everywhere an agent can sign something: an AI tool may not credit itself for the work, and may not do the work under a machine's account.

That covers three questions at every surface:

- **What it says** — no co-author trailers, no "Generated with …" footers, no product links, no session stamps. In commit messages, and in pull requests, issues and comments.
- **What it carries** — none of the above written into the files themselves, where a footer ships in the diff, shows up in the pull request, and stays in the tree after both are forgotten.
- **Who it says wrote it** — no committing or commenting as a tool-named or bot account instead of the person's own, and no committing under no identity at all.

Naming a product is not attribution. `feat: add <vendor> adapter` is ordinary engineering and always ships.

## How it enforces

| Layer | Covers | Where |
|---|---|---|
| `PreToolUse` on `Bash` | git authorship, and `gh` posts to PRs and issues | `hooks/ghostwriter.js` |
| `PreToolUse` on write tools | attribution written into a file | same hook |
| `PreToolUse` on `mcp__github__*` | PR, issue and comment text, and files committed through the API | same hook |
| `commit-msg` git hook (opt-in) | the final message, after the shell expanded it | `/ghostwriter:install` |
| `pre-commit` git hook (opt-in) | what a commit adds to the files, whoever wrote the lines | `/ghostwriter:install` |
| CI | the whole branch, and the pull request's own description | `scripts/ghostwriter-scan.js` |

The PreToolUse hooks are always on once the plugin is installed. The git hooks are opt-in because they write into the repository's hooks directory.

Each layer exists because the one above it cannot see something. The tool hooks see only what the agent does through its own tools; the git hooks see anything committed on that machine; CI sees what actually arrived, from wherever it came.

## Pinning the human (optional)

By default the identity rules are a blocklist: they catch tool names and bot-shaped accounts (`…[bot]`, `release-bot`, `github-actions`). That cannot catch a plainly-named app account, and it cannot tell one person from another. Set the expected human and the question becomes exact — everything must be signed by them:

```bash
export GHOSTWRITER_HUMAN_EMAIL=me@example.com
export GHOSTWRITER_HUMAN_LOGIN=my-github-login
```

With a human pinned, anything else is refused, including an identity the guard simply cannot read.

### Who a post is published as

Independently of pinning, a `gh` post is refused when the account cannot be named: a `GH_TOKEN` supplied by the command (which replaces the logged-in account), or a `gh` that answers without a login. Both are the anonymous form of the same rule — the identity checks cannot run on nothing.

A command that NAMES an account (`gh --account …`) is judged on that one, not on the login `gh` would otherwise use. The named account has answered the question the resolver was about to go and ask, and answering it with the default would clear a human while the post went out as somebody else.

The account is read from `gh auth status`, falling back to `gh api user` when the wording of that status has moved between versions. A machine with no `gh` at all is left alone: the command posts nothing and explains itself better than a guard would.

**A forge MCP call is the one place this cannot be answered.** The credential lives in the MCP server, so no reading of the call reveals who it will post as. That gap is refused only when a human is pinned — the strong mode is opt-in on purpose, because refusing every MCP post by default would make the plugin something people uninstall, and a guard nobody keeps enabled prevents nothing.

## What gets blocked

Five rules, applied in that order so the sharpest evidence wins:

| Rule | Example |
|---|---|
| `aiCoAuthorTrailer` | `Co-Authored-By: <tool> <noreply@…>` |
| `aiGeneratedPhrase` | `🤖 Generated with [<tool> Code](…)` |
| `aiAttributionLink` | a product attribution URL in the body |
| `aiSessionTrailer` | `<Tool>-Session: https://…` |
| `aiIdentity` | `user.name`, `--author=`, `GIT_AUTHOR_NAME` naming a tool |
| `botIdentity` | committing or posting as `…[bot]`, `release-bot`, `github-actions` |
| `missingIdentity` | a repository with no `user.name` / `user.email` — git invents `user@hostname` and the commit lands under a machine |
| `hookBypass` | `--no-verify` or `-c core.hooksPath=` while our `commit-msg` hook is installed |

An `unverifiable*` rule is not a sixth kind of offence — it is the guard reporting that it could not read something, and refusing rather than assuming. An oversized or unreadable message file, an identity behind a variable nobody can see, a patch arriving on a pipe, an account replaced by a token.

## The passes

A command that authors a git object is inspected in order, and the first finding blocks:

1. **message arguments** — `-m` / `--message` values
2. **message files** — `-F` / `--file` contents, read in full
3. **identity literals** — `--author`, `GIT_AUTHOR_NAME=…`, `git config user.*`
4. **the raw command** — heredoc bodies, unquoted `$(…)`, chained writes
5. **published prose** — `gh` bodies, titles, notes, `gh api -f body=` fields
6. **the posting account** — the account `gh` would publish as
7. **copied commits** — the author AND message a `cherry-pick` or `commit -C` brings along
8. **imported patches** — the `From:` header and body of a `git am`
9. **the repo identity** — what git would stamp, in the repository actually targeted
10. **the backstop** — whether the command switches the repository's hooks off

Pass 4 is why quoting tricks do not help: the same shape-specific rules run over the whole command text. Pass 9 is why setting the identity in an earlier session does not help either — a clean message committed as a tool is still attribution — and it resolves against `-C`, `--git-dir` and `GIT_DIR`, so committing into another repository does not help.

## Reading a file is not reading a message

The file rules are the same rules with two adjustments, because the same sentence means different things in different places:

- **Documentation is read as prose**, source strictly. A file explaining a tool footer quotes it in a fence; a comment is not a fence.
- **`author:` and `committer:` are dropped** for file content. They are trailer keys in a message and ordinary property names everywhere else — `author: '<some-bot>'` in a fixture is data about who reviewed something, not a commit signed by it.
- **A trailer in a file wears the local comment syntax.** `// Signed-off-by:`, `# Generated-by:`, ` * Authored-by:` are all the same signature.

Run over this repository's own 2084 files, that ruleset flags exactly one: the `work` plugin's commit-message rules, whose comments quote the footer they reject. It is listed in `.ghostwriterignore`.

A file that must carry an attribution string — a policy document, a fixture, a changelog quoting what it removed — goes in `.ghostwriterignore` at the repository root, one path or glob per line:

```
docs/attribution-policy.md
vendor/**
*.snap
```

That exempts a path from the FILE rules only. No path excuses a commit message, a pull request body, or a committing identity.

Two properties keep the list from becoming the hole in the guard:

- **Every exemption applied is announced.** The scanner names each path it skipped, so an exemption is visible in the check output, not only in the diff. A silent skip and a working rule look identical.
- **CI reads the list from the base revision** (`--ignore-from`), so a change cannot add an attribution-bearing file and the line exempting it in the same breath. A new exemption takes effect once it is merged — reviewing the permission separately from the file it covers is how an allowlist is supposed to work. Locally the list is the working tree's own, which is what makes it editable at all.

Locating a `gh` command group depends on knowing which of that tool's options consume the token after them, and an enumeration of another tool's flags goes stale every time it grows one — three review rounds found three. So the TEXT check does not depend on that knowledge: any invocation of `gh` is enough to read the command for attribution, whatever its options do. The precise classification still drives the account and per-argument checks, where a false positive would cost something; the text net cannot cost more than refusing a command whose own text credits a tool.

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

Which is why `--no-verify` and `-c core.hooksPath=` are refused **when that hook is installed**, and only then: skipping somebody else's slow pre-commit linter is ordinary work, and a rule that punished it is a rule people learn to route around.

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
node scripts/ghostwriter-check.js --prose -      # a PR body, on stdin

# check what a CHANGE adds — additions only, so removing a footer always passes
node scripts/ghostwriter-scan.js --staged        # what this commit would add
node scripts/ghostwriter-scan.js --diff main     # what this branch adds
node scripts/ghostwriter-scan.js --commits main  # who signed each commit, and what each says
node scripts/ghostwriter-scan.js --files src/a.js

# git-level enforcement
node scripts/install-git-hooks.js --status
node scripts/install-git-hooks.js
node scripts/install-git-hooks.js --uninstall
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
│   ├── hooks.json              PreToolUse registration (Bash, write tools, forge MCP)
│   └── ghostwriter.js          the guard
├── lib/
│   ├── attribution.js          the text rules — what a change says
│   ├── identity-rules.js       the identity rules — who it says wrote it
│   ├── file-content.js         the file rules — what a change carries
│   ├── ignore.js               .ghostwriterignore
│   ├── git-surfaces.js         quote-aware command reader
│   ├── git-identity-args.js    every way a command can name its author
│   ├── git-bypass.js           every way a command can skip the hooks
│   ├── git-identity.js         effective git identity, and the installed hook
│   ├── git-guard.js            the passes that judge a git command
│   ├── forge-surfaces.js       where prose and files reach GitHub
│   ├── forge-guard.js          the passes that judge a post
│   ├── guard.js                the decision — which passes, in what order
│   ├── report.js               how a refusal reads
│   ├── policy.js               the override, and the hook marker
│   ├── hookEntrypoint/         vendored from factories/ (do not edit)
│   └── runtime/                vendored from factories/ (do not edit)
├── scripts/
│   ├── ghostwriter-check.js    check a message or an identity
│   ├── ghostwriter-scan.js     check what a change adds
│   └── install-git-hooks.js
└── skills/{check,install}/SKILL.md
```

## Tests

```bash
node --test plugins/ghostwriter/lib/__tests__/*.test.js
node --test plugins/ghostwriter/hooks/__tests__/*.test.js
node --test plugins/ghostwriter/scripts/__tests__/*.test.js
```

The hook and CLI tests spawn real processes and assert exit codes; the installer test drives a real `git commit` through the installed hooks; the scanner tests run against real repositories and real `git diff` output. The exit code is the contract, so it is tested as one — and whether bytes and config reach the rules is not a question a stubbed reader can answer.

## Relationship to the `work` plugin

`work` enforces a whole commit contract (semantic format, ticket id, imperative mood, no attribution) but only along its own sanctioned commit path. ghostwriter enforces one rule, everywhere, with no workflow attached. Running both is fine: they agree on this rule, and ghostwriter also covers `--author`, environment identity overrides, `git config` writes, tags, merges and notes.
