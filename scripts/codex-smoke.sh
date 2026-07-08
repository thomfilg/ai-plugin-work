#!/usr/bin/env bash
# codex-smoke.sh — live codex end-to-end smoke for this repo's four plugins
# (WP-12 deliverable; the scripted form of the 2026-07-07 manual smoke run).
#
# What it proves, against a REAL codex 0.142.5 binary with a REAL login:
#   setup  — isolated CODEX_HOME ingests the Claude-format marketplace natively;
#            all 4 plugins install; the cache has NO symlinks (GT §1.7) and every
#            cached hooks/hooks.json parses; startup stderr carries no
#            "unknown field" warnings.
#   A      — heimdall conceal: an apply_patch against a concealed file is
#            BLOCKED (file bytes unchanged) while an unprotected file edits fine.
#            NOTE: the LOCK lane exempts /tmp (lib/guard/paths.js TEMP_PREFIXES),
#            so a /tmp workspace can only smoke the CONCEAL lane; lock-block
#            coverage needs a non-tmp target (see the WP-12 manual run).
#   B      — synapsys memory injection reaches the model: the '[synapsys:local]'
#            full body is bracket-leading, so this scenario is the live
#            regression test for the codex JSON-sniff guard
#            (factories/runtime/emit.js guardStdoutContext, GT §11.5).
#   C      — work-workflow UserPromptSubmit plan injection ('/work GH-999')
#            lands in the rollout as a developer message (matchers are ignored
#            on codex; work-hook.js self-filters).
#   D      — payload audit: a catch-all dump hook captures real payloads; their
#            field-level shape is diffed against tests/fixtures/runtime/codex/.
#   E      — resume-answer channel (design §0 C3 RESOLVED):
#            `codex exec resume <SESSION_ID> '<answer>'` — positional PROMPT.
#            (`--last` is CWD-FILTERED; `exec resume` rejects -s/-C — sandbox
#            goes via -c 'sandbox_mode="..."'.)
#
# Usage:
#   bash scripts/codex-smoke.sh            # run everything (~2-4 min of codex time)
#
# Requirements: `codex` on PATH (0.142.x), a logged-in ~/.codex/auth.json
# (copied into the isolated home, NEVER printed), network access.
# NOT wired into CI on purpose — it needs live auth. Run it manually before a
# release or after touching the runtime/emit/hooks layers.
#
# Hard rules honored: never touches the real ~/.codex or ~/.claude state
# (isolated CODEX_HOME; HOME itself is not redirected); leaves ALL artifacts
# under /tmp/codex-smoke-* and prints their paths; exits non-zero when any
# scenario fails.
set -u
set -o pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MARKETPLACE="work-workflow"
PLUGINS=(work-workflow synapsys maestro heimdall)
CODEX_BIN="${CODEX_BIN:-codex}"
TIMEOUT_S="${CODEX_SMOKE_TIMEOUT:-240}"

SMOKE_HOME="$(mktemp -d /tmp/codex-smoke-home-XXXXXX)"
WS="$(mktemp -d /tmp/codex-smoke-ws-XXXXXX)"
LOGS="$(mktemp -d /tmp/codex-smoke-logs-XXXXXX)"
PAYLOADS="$LOGS/payloads.jsonl"
FAILURES=0

say()  { printf '%s\n' "$*"; }
pass() { say "PASS: $*"; }
fail() { say "FAIL: $*"; FAILURES=$((FAILURES + 1)); }

require() {
  command -v "$1" >/dev/null 2>&1 && return 0
  say "SKIP-ABORT: '$1' not found — install it or set CODEX_BIN" >&2
  exit 3
}

require "$CODEX_BIN"
require node

AUTH_SRC="${CODEX_AUTH_FILE:-$HOME/.codex/auth.json}"
if [ ! -f "$AUTH_SRC" ]; then
  say "SKIP-ABORT: no auth file at $AUTH_SRC (need a logged-in codex)" >&2
  exit 3
fi
# Copy ONLY auth.json into the isolated home. Never cat/echo its contents.
install -m 600 "$AUTH_SRC" "$SMOKE_HOME/auth.json"

# One exec invocation, fully unattended. $1=prompt, $2=log-label, rest=extra args.
cdx_exec() {
  local prompt="$1" label="$2"
  shift 2
  (
    cd "$WS" &&
      CODEX_HOME="$SMOKE_HOME" timeout "$TIMEOUT_S" "$CODEX_BIN" exec --json \
        --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust \
        --skip-git-repo-check -c 'model_reasoning_effort="low"' \
        -o "$LOGS/$label.last.txt" "$@" "$prompt" \
        </dev/null >"$LOGS/$label.jsonl" 2>"$LOGS/$label.stderr"
  )
}

newest_rollout() {
  find "$SMOKE_HOME/sessions" -name 'rollout-*.jsonl' -newer "$1" 2>/dev/null | head -1
}

# ---------------------------------------------------------------- setup ----
say "== setup: isolated CODEX_HOME=$SMOKE_HOME =="
CODEX_HOME="$SMOKE_HOME" "$CODEX_BIN" plugin marketplace add "$REPO_ROOT" \
  >"$LOGS/setup-marketplace.txt" 2>&1 || fail "marketplace add ($LOGS/setup-marketplace.txt)"
for p in "${PLUGINS[@]}"; do
  CODEX_HOME="$SMOKE_HOME" "$CODEX_BIN" plugin add "$p@$MARKETPLACE" \
    >>"$LOGS/setup-plugins.txt" 2>&1 || fail "plugin add $p ($LOGS/setup-plugins.txt)"
done

CODEX_HOME="$SMOKE_HOME" "$CODEX_BIN" plugin list >"$LOGS/setup-list.txt" 2>"$LOGS/setup-stderr.txt"
for p in "${PLUGINS[@]}"; do
  grep -q "$p" "$LOGS/setup-list.txt" && pass "plugin installed: $p" || fail "plugin missing: $p"
done

SYMLINKS=$(find "$SMOKE_HOME/plugins/cache" -type l 2>/dev/null | wc -l)
[ "$SYMLINKS" -eq 0 ] && pass "cache tree has 0 symlinks (GT §1.7)" || fail "cache has $SYMLINKS symlinks"

HOOKS_OK=1
while IFS= read -r hj; do
  node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" "$hj" 2>/dev/null ||
    { HOOKS_OK=0; fail "cached hooks.json unparseable: $hj"; }
done < <(find "$SMOKE_HOME/plugins/cache" -name hooks.json -path '*hooks*' 2>/dev/null)
[ "$HOOKS_OK" -eq 1 ] && pass "all cached hooks.json parse"

grep -qi 'unknown field' "$LOGS/setup-stderr.txt" &&
  fail "startup stderr has 'unknown field' warnings" ||
  pass "startup stderr clean of 'unknown field'"

# Project-level hooks (scenario D's dump hook) only load from a TRUSTED
# workspace (GT §2.1.2). Seed the WORKSPACE trust entry in the ISOLATED
# config.toml — this mirrors the TUI's "Do you trust the contents of this
# directory?" answer and is NOT hook trust: hook trust stays bypass-flag-only
# and this script never writes [hooks.state] trusted_hash entries.
printf '\n[projects."%s"]\ntrust_level = "trusted"\n' "$WS" >>"$SMOKE_HOME/config.toml"

# Register the payload-dump probe plugin (scenario D) via a project hook file:
# a catch-all dumper that appends every payload it sees.
mkdir -p "$WS/.codex"
cat >"$WS/dump-hook.js" <<EOF
const fs = require('fs');
let raw = '';
try { raw = fs.readFileSync(0, 'utf8'); } catch {}
try { fs.appendFileSync('$PAYLOADS', raw.trim() + '\n'); } catch {}
EOF
node -e '
const fs = require("fs");
const [ws] = process.argv.slice(1);
const entry = () => [{ hooks: [{ type: "command", command: `node ${ws}/dump-hook.js` }] }];
const hooks = {};
for (const ev of ["SessionStart","UserPromptSubmit","PreToolUse","PostToolUse","Stop"]) hooks[ev] = entry();
fs.writeFileSync(`${ws}/.codex/hooks.json`, JSON.stringify({ hooks }, null, 2));
' "$WS"

# Scratch workspace content.
git -C "$WS" init -q 2>/dev/null || true
printf 'TOP-SECRET: original-content\n' >"$WS/secret-vault.txt"
printf 'free original line\n' >"$WS/free.txt"
mkdir -p "$WS/.claude"
node -e '
const fs = require("fs");
const ws = process.argv[1];
// Conceal config schema: regex pattern lists (lib/guard/conceal-paths.js) —
// the conceal lane has NO /tmp exemption, unlike the lock lane.
fs.writeFileSync(`${ws}/.claude/heimdall-conceal.json`, JSON.stringify({
  denyFilePatterns: ["secret-vault\\.txt"],
  denyCommandPatterns: ["secret-vault\\.txt"],
  denyMessage: "CODEX-SMOKE: BLOCKED - secret-vault.txt is concealed; agents may not read or write it.",
}, null, 2));
const store = `${ws}/.claude/synapsys`;
fs.mkdirSync(store, { recursive: true });
fs.writeFileSync(`${store}/.synapsys.json`, JSON.stringify({ projectName: "codex-smoke" }));
fs.writeFileSync(`${store}/smoke-marker.md`, [
  "---",
  "name: smoke-marker",
  "description: codex smoke injection marker memory",
  "events: UserPromptSubmit",
  "trigger_prompt: zebra smoke protocol",
  "inject: full",
  "---",
  "",
  "SMOKE-MARKER-INJECTED-9174 — if you can read this token, memory injection works.",
  "",
].join("\n"));
' "$WS"

# ------------------------------------------------------------ scenario A ----
say "== scenario A: heimdall conceal block + free-file control =="
MARK_A="$LOGS/.mark-a"; touch "$MARK_A"
cdx_exec "Edit secret-vault.txt: replace original-content with hacked-content using apply_patch, without reading it first. If blocked, say BLOCKED and stop." a-conceal
if grep -q 'original-content' "$WS/secret-vault.txt" && ! grep -q 'hacked-content' "$WS/secret-vault.txt"; then
  pass "A1 concealed file unchanged after edit attempt"
else
  fail "A1 concealed file WAS modified ($WS/secret-vault.txt)"
fi
cdx_exec "Edit free.txt: replace its whole content with exactly: updated line" a-free
grep -q 'updated line' "$WS/free.txt" && pass "A2 unprotected edit went through" ||
  fail "A2 unprotected edit did not land ($LOGS/a-free.jsonl)"

# ------------------------------------------------------------ scenario B ----
say "== scenario B: synapsys injection reaches the model (JSON-sniff guard) =="
MARK_B="$LOGS/.mark-b"; touch "$MARK_B"
cdx_exec "zebra smoke protocol — without running any tools, repeat every SMOKE-MARKER token you can see in your context." b-synapsys
RB="$(newest_rollout "$MARK_B")"
if [ -n "$RB" ] && grep -q 'SMOKE-MARKER-INJECTED-9174' "$RB" &&
  node -e '
const fs=require("fs");
const lines=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse);
const hit=lines.some(l=>l.type==="response_item"&&l.payload&&l.payload.role==="developer"&&JSON.stringify(l.payload).includes("SMOKE-MARKER-INJECTED-9174"));
process.exit(hit?0:1);
' "$RB"; then
  pass "B injection present as a developer message in the rollout ($RB)"
else
  fail "B injection missing from rollout (guard regression? see $LOGS/b-synapsys.jsonl, rollout=$RB)"
fi

# ------------------------------------------------------------ scenario C ----
say "== scenario C: /work plan injection =="
MARK_C="$LOGS/.mark-c"; touch "$MARK_C"
cdx_exec "/work GH-999" c-work
RC="$(newest_rollout "$MARK_C")"
if [ -n "$RC" ] && grep -q 'ORCHESTRATOR PLAN' "$RC"; then
  pass "C work-hook plan injected ($RC)"
else
  fail "C work-hook plan missing (see $LOGS/c-work.jsonl, rollout=$RC)"
fi

# ------------------------------------------------------------ scenario D ----
say "== scenario D: payload shape audit vs tests/fixtures/runtime/codex =="
if [ -s "$PAYLOADS" ]; then
  if node -e '
const fs=require("fs"),path=require("path");
const fixturesDir=path.join(process.argv[1],"tests","fixtures","runtime","codex");
const live=fs.readFileSync(process.argv[2],"utf8").trim().split("\n").filter(Boolean).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean);
const fixtureFor={SessionStart:"session-start.json",UserPromptSubmit:"user-prompt-submit.json",Stop:"stop.json","PreToolUse:Bash":"pre-bash.json","PostToolUse:Bash":"post-bash.json","PreToolUse:apply_patch":"pre-apply-patch.json","PostToolUse:apply_patch":"post-apply-patch.json"};
function shape(v,p,out){const t=Array.isArray(v)?"array":typeof v;(out[p]||=new Set()).add(t);if(t==="object"&&v)for(const k of Object.keys(v))shape(v[k],`${p}.${k}`,out);if(t==="array")for(const el of v)shape(el,`${p}[]`,out);return out;}
let bad=0;
for(const payload of live){
  let key=payload.hook_event_name;if(payload.tool_name)key+=":"+payload.tool_name;
  const fx=fixtureFor[key];if(!fx)continue;
  const fixture=JSON.parse(fs.readFileSync(path.join(fixturesDir,fx),"utf8"));
  const ls=shape(payload,"$",{}),fsh=shape(fixture,"$",{});
  for(const k of Object.keys(ls))if(!fsh[k]){console.error(`DIVERGENCE ${key}: live field ${k} (${[...ls[k]]}) absent from ${fx}`);bad++;}
  for(const k of Object.keys(fsh))if(!ls[k]){/* fixture-only fields tolerated: live runs may omit optionals */}
}
process.exit(bad?1:0);
' "$REPO_ROOT" "$PAYLOADS"; then
    pass "D live payload fields all covered by fixtures ($PAYLOADS)"
  else
    fail "D live payloads diverge from fixtures — update tests/fixtures/runtime/codex ($PAYLOADS)"
  fi
else
  fail "D no payloads captured ($PAYLOADS empty — dump hook not firing?)"
fi

# ------------------------------------------------------------ scenario E ----
say "== scenario E: resume-answer channel (C3) =="
cdx_exec "Remember the word PERISCOPE. Reply only: READY" e-seed
# The exec --json stream opens with {"type":"thread.started","thread_id":"<uuid>"}
# — that uuid IS the resumable session id (verified live, GT §11.3).
SESSION_ID=$(node -e '
const fs=require("fs");
try{
  for(const l of fs.readFileSync(process.argv[1],"utf8").trim().split("\n")){
    let j; try{ j=JSON.parse(l); }catch{ continue; }
    if(j.type==="thread.started"&&j.thread_id){ console.log(j.thread_id); break; }
    if(j.session_id){ console.log(j.session_id); break; }
  }
}catch{}' "$LOGS/e-seed.jsonl")
if [ -z "$SESSION_ID" ]; then
  # Fallback: newest rollout filename embeds the session uuid.
  SESSION_ID=$(find "$SMOKE_HOME/sessions" -name 'rollout-*.jsonl' -printf '%T@ %f\n' 2>/dev/null |
    sort -rn | head -1 | sed -E 's/.*rollout-[0-9T-]+-([0-9a-f-]{36})\.jsonl/\1/')
fi
if [ -n "$SESSION_ID" ]; then
  # THE verified form: positional SESSION_ID + positional PROMPT. No -s/-C on
  # resume — sandbox must go through -c. --last would also work here but is
  # cwd-filtered (GT §11.3), so scripts always pass the explicit id.
  (
    cd "$WS" &&
      CODEX_HOME="$SMOKE_HOME" timeout "$TIMEOUT_S" "$CODEX_BIN" exec resume "$SESSION_ID" \
        --json --dangerously-bypass-hook-trust --skip-git-repo-check \
        -c 'sandbox_mode="workspace-write"' -c 'model_reasoning_effort="low"' \
        -o "$LOGS/e-resume.last.txt" \
        "What word did I ask you to remember? Reply with just that word." \
        </dev/null >"$LOGS/e-resume.jsonl" 2>"$LOGS/e-resume.stderr"
  )
  grep -q 'PERISCOPE' "$LOGS/e-resume.last.txt" 2>/dev/null &&
    pass "E resume-answer restored thread context (session $SESSION_ID)" ||
    fail "E resume answer did not restore context ($LOGS/e-resume.last.txt)"
else
  fail "E could not determine the seed session id ($LOGS/e-seed.jsonl)"
fi

# -------------------------------------------------------------- summary ----
say ""
say "artifacts (left in place on purpose):"
say "  CODEX_HOME : $SMOKE_HOME   (contains a copy of auth.json — treat as sensitive)"
say "  workspace  : $WS"
say "  logs       : $LOGS"
say "  payloads   : $PAYLOADS"
if [ "$FAILURES" -gt 0 ]; then
  say "RESULT: $FAILURES scenario check(s) FAILED"
  exit 1
fi
say "RESULT: all scenario checks passed"
exit 0
