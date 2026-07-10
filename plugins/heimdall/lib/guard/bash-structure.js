'use strict';

/**
 * Structured bash analysis for the protect lane (GH-699) — orchestrator.
 *
 * The legacy matcher blocked on "write-ish token anywhere + protected marker
 * anywhere" over the whole command, so quoted prose (`git commit -m`,
 * `gh pr create --body`, tmux message text), compound reads (`cd ui && test`),
 * and cross-segment coincidences all false-positived (GH-699 vectors 1-4).
 *
 * Pipeline: scan (bash-scan) → classify each segment's write targets/executed
 * strings (bash-classify) → resolve targets against the entry (bash-match),
 * tracking the effective cwd across `cd`. Blocks only when a genuine write
 * target resolves to/under a protected entry (or a script INSIDE it is run).
 *
 * Fail-closed contract: constructs the scanner cannot model return UNPARSEABLE
 * and the caller falls back to the legacy template matcher — the structured
 * path only ever NARROWS false positives on parseable commands, never widens
 * allows. Unresolvable write targets ($VAR/$(…)/unknown cwd) that carry a
 * protected marker stay blocked.
 */

const os = require('node:os');
const path = require('node:path');
const { textReferencesEntry, expandHomePaths, resolvePathSafe } = require('./paths');
const { expandHome } = require('../pathSafe');
const { scanCommand } = require('./bash-scan');
const {
  classifySegment,
  effectiveTokens,
  operandTokens,
  SHELL_CMDS,
  INTERPRETER_INLINE,
} = require('./bash-classify');
const { targetVerdict, ancestorHit, segmentReferencesEntry } = require('./bash-match');

const VERDICT = Object.freeze({ ALLOW: 'allow', BLOCK: 'block', UNPARSEABLE: 'unparseable' });
const MAX_RECURSION_DEPTH = 5;

const INTERPRETER_WRITE_API =
  /(?:writeFileSync|appendFileSync|writeFile\b|createWriteStream|\brmSync|\bunlinkSync|\brenameSync|\bmkdirSync|open\([^)]*,\s*['"][^'"]*(?:[wax]|r[^'"]*\+)|write_text|write_bytes|\.write\(|\.unlink|\.rename|\.replace\(|\.mkdir|shutil\.\w*copy|shutil\.move|shutil\.rmtree|File\.(?:write|delete|rename)|FileUtils)/i;

function block(why) {
  return { verdict: VERDICT.BLOCK, why };
}

/** Update the effective cwd after a `cd` segment; null = unknown from here. */
function cwdAfterCd(eff, segCwd) {
  const op = operandTokens(eff)[0];
  if (!op) return os.homedir();
  if (op.hasSubst || op.hasGlob || op.dq === '-') return null;
  if (segCwd === null) return null;
  const dq = expandHome(expandHomePaths(op.dq));
  return resolvePathSafe(path.isAbsolute(dq) ? dq : path.resolve(segCwd, dq));
}

function isCdSegment(eff) {
  return eff.length && path.posix.basename(eff[0].dq).toLowerCase() === 'cd';
}

/** Executing a script FILE that lives inside a locked entry is edit-gated. */
function execScriptHit(cls, entry, segCwd) {
  for (const scriptTok of cls.execScripts) {
    if (scriptTok.hasSubst || scriptTok.hasGlob || segCwd === null) continue;
    const p = expandHome(expandHomePaths(scriptTok.dq));
    const resolved = resolvePathSafe(path.isAbsolute(p) ? p : path.resolve(segCwd, p));
    if (resolved !== entry.dir && !resolved.startsWith(entry.dir + path.sep)) continue;
    const trusted = (entry.trustedSubdirs || []).some((sub) =>
      resolved.startsWith(path.join(entry.dir, sub) + path.sep)
    );
    if (!trusted) return true; // GH-637 trustedSubdirs stay execute-trusted
  }
  return false;
}

/** Explicit write-target operands (and destructive-ancestor) checks. */
function targetHit(cls, entry, segCwd) {
  for (const target of cls.targets) {
    if (targetVerdict(target, entry, segCwd) === 'hit') {
      return block('write target resolves to protected path');
    }
    if (cls.destructive && ancestorHit(target, entry, segCwd)) {
      return block('destructive op on an ancestor of the protected path');
    }
  }
  return null;
}

/** Reference-scoped checks (script exec, unmodelable mutators, inline APIs). */
function refHit(seg, cls, entry, segCwd, wholeRefs) {
  if (execScriptHit(cls, entry, segCwd)) {
    return block('executes a script inside the protected path');
  }
  if (cls.refBlocks && segmentReferencesEntry(seg, entry)) {
    return block('unmodelable mutating command references protected path');
  }
  if (cls.refBlocksGlobal && (wholeRefs || segmentReferencesEntry(seg, entry))) {
    return block('stdin-fed writer with protected path referenced in command');
  }
  if (!cls.interpreterInline) return null;
  const segText = seg.tokens.map((t) => t.dq).join(' ');
  if (INTERPRETER_WRITE_API.test(segText) && segmentReferencesEntry(seg, entry)) {
    return block('inline interpreter write API references protected path');
  }
  return null;
}

/** Non-recursive checks for one classified segment. Returns a block or null. */
function segmentVerdict(seg, cls, entry, segCwd, wholeRefs) {
  return targetHit(cls, entry, segCwd) || refHit(seg, cls, entry, segCwd, wholeRefs);
}

/** Recurse into executed nested strings + exec-style heredoc bodies. */
function recurseInto(seg, cls, eff, entry, segCwd, wholeRefs, depth) {
  const childCwd = segCwd === null ? undefined : segCwd;
  for (const nestedCmd of cls.nested) {
    const sub = structuredEntryMatch(
      nestedCmd,
      entry,
      { cwd: childCwd, _wholeRefs: wholeRefs },
      depth + 1
    );
    if (sub.verdict !== VERDICT.ALLOW) return sub;
  }
  if (!seg.heredocs.length) return null;
  const cmdName = eff.length ? path.posix.basename(eff[0].dq).toLowerCase() : '';
  if (!SHELL_CMDS.has(cmdName) && !INTERPRETER_INLINE.has(cmdName)) return null;
  for (const h of seg.heredocs) {
    const sub = structuredEntryMatch(
      h.body,
      entry,
      { cwd: childCwd, _wholeRefs: wholeRefs },
      depth + 1
    );
    if (sub.verdict !== VERDICT.ALLOW) return sub;
  }
  return null;
}

const UNPARSEABLE_R = Object.freeze({ verdict: VERDICT.UNPARSEABLE });
const ALLOW_R = Object.freeze({ verdict: VERDICT.ALLOW });

// Whole-command reference flag for stdin-fed writers (xargs, rootless find):
// computed on the OUTERMOST text so `find <protected> | xargs rm` blocks even
// though the xargs segment never names the entry itself.
function resolveWholeRefs(ctx, text, entry) {
  if (ctx && ctx._wholeRefs !== undefined) return ctx._wholeRefs;
  return textReferencesEntry(expandHomePaths(text), entry);
}

/** One segment: cd-tracking, direct verdict, then recursion. Mutates state.segCwd. */
function handleSegment(seg, entry, state) {
  const cls = classifySegment(seg);
  if (cls.unparseable) return UNPARSEABLE_R;
  const eff = effectiveTokens(seg.tokens);
  if (isCdSegment(eff)) {
    state.segCwd = cwdAfterCd(eff, state.segCwd);
    return null;
  }
  return (
    segmentVerdict(seg, cls, entry, state.segCwd, state.wholeRefs) ||
    recurseInto(seg, cls, eff, entry, state.segCwd, state.wholeRefs, state.depth)
  );
}

/**
 * Structured verdict for one command string against one entry.
 * ctx: { cwd } — the tool call's working directory.
 */
function structuredEntryMatch(text, entry, ctx, depth = 0) {
  if (depth > MAX_RECURSION_DEPTH) return UNPARSEABLE_R;
  const scanned = scanCommand(text);
  if (!scanned) return UNPARSEABLE_R;

  const state = {
    segCwd: ctx && ctx.cwd ? ctx.cwd : process.cwd(),
    wholeRefs: resolveWholeRefs(ctx, text, entry),
    depth,
  };
  for (const seg of scanned.segments) {
    const r = handleSegment(seg, entry, state);
    if (r) return r;
  }
  // Top-level $(…)/backtick substitutions execute too.
  return scanTopNested(scanned, entry, state, depth) || ALLOW_R;
}

function scanTopNested(scanned, entry, state, depth) {
  const cwd = state.segCwd === null ? undefined : state.segCwd;
  for (const nestedCmd of scanned.nested) {
    const sub = structuredEntryMatch(
      nestedCmd,
      entry,
      { cwd, _wholeRefs: state.wholeRefs },
      depth + 1
    );
    if (sub.verdict !== VERDICT.ALLOW) return sub;
  }
  return null;
}

module.exports = { scanCommand, classifySegment, structuredEntryMatch, VERDICT };
