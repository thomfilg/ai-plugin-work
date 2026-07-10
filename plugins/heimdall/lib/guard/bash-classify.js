'use strict';

/**
 * Per-segment command classification (GH-699). Given one scanned segment,
 * report its WRITE TARGETS, executed nested strings, and matching rules. The
 * command vocabulary is a keyed registry of small handlers so each stays
 * within the repo's per-function complexity budget.
 *
 * `out` shape:
 *   targets            [token]  write-target operands (+ redirect targets)
 *   destructive        bool     also blocks on an ANCESTOR of the entry
 *   nested             [string] strings executed as commands (recurse)
 *   execScripts        [token]  script FILES an interpreter/shell runs
 *   refBlocks          bool     any protected ref in THIS segment blocks
 *   refBlocksGlobal    bool     any protected ref in the whole COMMAND blocks
 *   interpreterInline  bool     apply the inline write-API rule
 *   unparseable        bool     command word itself is dynamic
 */

const path = require('node:path');
const {
  WRAPPERS,
  WRAPPER_VALUE_FLAGS,
  READ_CMDS,
  GIT_READ_SUBS,
  GIT_MUTATING_SUBS,
  GIT_PATHSPEC_WRITE_SUBS,
  GH_DOWNLOAD_VERBS,
  INTERPRETER_INLINE,
  SHELL_CMDS,
  SCRIPT_FILE_RE,
  EXEC_OPERAND_NAMES,
  QUOTED_EXEC_WORD_RE,
} = require('./bash-vocab');

function isFlag(tok) {
  return tok.dq.startsWith('-') && tok.dq !== '-';
}
function operandTokens(tokens) {
  return tokens.slice(1).filter((t) => !isFlag(t));
}

/** Skip leading VAR=VAL assignments and wrapper commands; return the rest. */
function effectiveTokens(tokens) {
  let rest = tokens.slice();
  for (;;) {
    while (rest.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0].dq) && !rest[0].hadQuote) {
      rest = rest.slice(1);
    }
    if (!rest.length) return rest;
    const cmd = path.posix.basename(rest[0].dq).toLowerCase();
    if (!(cmd in WRAPPERS)) return rest;
    rest = rest.slice(skipWrapper(rest, cmd));
  }
}

function skipWrapper(rest, cmd) {
  let j = 1;
  let skipOperands = WRAPPERS[cmd];
  while (j < rest.length) {
    const t = rest[j];
    if (isFlag(t)) {
      j += WRAPPER_VALUE_FLAGS.has(t.dq) ? 2 : 1;
    } else if (cmd === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t.dq)) {
      j += 1;
    } else if (skipOperands > 0) {
      skipOperands -= 1;
      j += 1;
    } else {
      break;
    }
  }
  return j;
}

function flagValueFn(tokens) {
  return (names) => {
    for (let k = 1; k < tokens.length; k += 1) {
      const t = tokens[k].dq;
      for (const n of names) {
        if (t === n && tokens[k + 1]) return tokens[k + 1];
        if (t.startsWith(`${n}=`)) return { ...tokens[k], dq: t.slice(n.length + 1) };
      }
    }
    return null;
  };
}

// ─── Command handlers (each mutates `out`) ───────────────────────────────────

function destructiveAll(out, c) {
  out.targets.push(...c.ops);
  out.destructive = true;
}
function createAll(out, c) {
  out.targets.push(...c.ops);
}
function skipFirstOperand(out, c) {
  out.targets.push(...c.ops.slice(1)); // mode/owner
}
// Destination operand of a copy-like command: -t/--target-directory value, or
// the last positional when there are ≥2 operands (source(s) + dest).
function destTargetToken(c) {
  const t = c.flagValue(['-t', '--target-directory']);
  if (t) return t;
  return c.ops.length >= 2 ? c.ops[c.ops.length - 1] : null;
}
function destOnly(out, c) {
  const t = destTargetToken(c);
  if (t) out.targets.push(t);
}
function linkTarget(out, c) {
  const t = destTargetToken(c);
  if (t) out.targets.push(t);
  else if (c.ops.length === 1) out.targets.push(c.ops[0]); // link named from basename in cwd
}
function classifySed(out, c) {
  if (c.tokens.some((t) => isFlag(t) && (/^-[a-zA-Z]*i/.test(t.dq) || t.dq === '--in-place'))) {
    out.targets.push(...c.ops);
  }
}
function classifyDd(out, c) {
  const of = c.tokens.find((t) => t.dq.startsWith('of='));
  if (of) out.targets.push({ ...of, dq: of.dq.slice(3) });
}
function classifyCurl(out, c) {
  const t = c.flagValue(['-o', '--output', '--output-dir']);
  if (t) out.targets.push(t);
}
function classifyWget(out, c) {
  const t = c.flagValue(['-O', '--output-document', '-P', '--directory-prefix']);
  if (t) out.targets.push(t);
}
function classifyTar(out, c) {
  const dir = c.flagValue(['-C', '--directory']);
  if (dir) out.targets.push(dir);
  if (c.tokens.some((t) => isFlag(t) && /^-[a-zA-Z]*[cru]/.test(t.dq))) {
    const f = c.flagValue(['-f', '--file']);
    if (f) out.targets.push(f);
  }
}
function classifyUnzip(out, c) {
  const t = c.flagValue(['-d']);
  if (t) out.targets.push(t);
}
function gitPathspecWrite(out, c, sub) {
  out.targets.push(...c.ops.slice(1)); // pathspecs after the subcommand
  out.destructive = sub !== 'restore';
}
function gitWorktreeAdd(out, c) {
  if (c.ops[1] && c.ops[1].dq.toLowerCase() === 'add' && c.ops[2]) out.targets.push(c.ops[2]);
}
function classifyGit(out, c) {
  const sub = (c.tokens[1] && !isFlag(c.tokens[1]) && c.tokens[1].dq.toLowerCase()) || '';
  if (GIT_READ_SUBS.has(sub)) return;
  if (GIT_PATHSPEC_WRITE_SUBS.has(sub)) gitPathspecWrite(out, c, sub);
  else if (sub === 'worktree') gitWorktreeAdd(out, c);
  else if (GIT_MUTATING_SUBS.has(sub)) out.refBlocks = true;
}
function classifyGh(out, c) {
  const verb = (c.ops[1] && c.ops[1].dq.toLowerCase()) || '';
  if (!GH_DOWNLOAD_VERBS.has(verb)) return; // API-facing verbs write no local files
  const d = c.flagValue(['-D', '--dir', '-o', '--output']);
  if (d) out.targets.push(d);
  if (verb === 'clone' && c.ops.length >= 4) out.targets.push(c.ops[c.ops.length - 1]);
}
function classifyPerlRuby(out, c) {
  if (c.tokens.some((t) => isFlag(t) && /^-[a-zA-Z]*i/.test(t.dq))) out.targets.push(...c.ops);
  else out.interpreterInline = true;
}
function classifyEval(out, c) {
  out.nested.push(
    c.tokens
      .slice(1)
      .map((t) => t.dq)
      .join(' ')
  );
}
function classifyXargs(out, c) {
  const sub = c.ops[0] ? path.posix.basename(c.ops[0].dq).toLowerCase() : '';
  if (sub && !READ_CMDS.has(sub)) out.refBlocksGlobal = true; // stdin-fed writer
}
function classifyTmux(out, c) {
  const sub = c.tokens[1] ? c.tokens[1].dq.toLowerCase() : '';
  if (sub !== 'send-keys' && sub !== 'send') return;
  const payload = c.ops
    .slice(1)
    .map((t) => t.dq)
    .filter(
      (x) => !/^(?:Enter|Escape|Tab|Space|BSpace|C-[a-zA-Z]|M-[a-zA-Z]|KP[A-Za-z0-9_]*)$/.test(x)
    )
    .join(' ');
  if (payload) out.nested.push(payload);
}
function classifySsh(out, c) {
  const hostIdx = c.tokens.findIndex((t, k) => k > 0 && !isFlag(t));
  if (hostIdx !== -1 && hostIdx + 1 < c.tokens.length) {
    out.nested.push(
      c.tokens
        .slice(hostIdx + 1)
        .map((t) => t.dq)
        .join(' ')
    );
  }
}
function classifyFind(out, c) {
  const { tokens } = c;
  const exprIdx = tokens.findIndex((t, k) => k > 0 && t.dq.startsWith('-'));
  const roots = (exprIdx === -1 ? tokens.slice(1) : tokens.slice(1, exprIdx)).filter(
    (t) => !isFlag(t)
  );
  const exprs = exprIdx === -1 ? [] : tokens.slice(exprIdx);
  const fileExpr = c.flagValue(['-fprint', '-fprintf', '-fls']);
  if (fileExpr) out.targets.push(fileExpr);
  if (!findIsMutating(exprs)) return;
  out.targets.push(...roots);
  out.destructive = true;
  if (!roots.length) out.refBlocksGlobal = true; // implicit `.` root
}
function findIsMutating(exprs) {
  if (exprs.some((t) => t.dq === '-delete')) return true;
  const execIdx = exprs.findIndex((t) => /^-(?:exec|execdir|ok|okdir)$/.test(t.dq));
  if (execIdx === -1) return false;
  const child = exprs[execIdx + 1] ? path.posix.basename(exprs[execIdx + 1].dq).toLowerCase() : '';
  return !READ_CMDS.has(child);
}

const HANDLERS = {
  rm: destructiveAll,
  rmdir: destructiveAll,
  unlink: destructiveAll,
  shred: destructiveAll,
  touch: createAll,
  mkdir: createAll,
  truncate: createAll,
  tee: createAll,
  sponge: createAll,
  patch: createAll,
  chmod: skipFirstOperand,
  chown: skipFirstOperand,
  chgrp: skipFirstOperand,
  cp: destOnly,
  install: destOnly,
  rsync: destOnly,
  scp: destOnly,
  ln: linkTarget,
  mv: destructiveAll,
  sed: classifySed,
  dd: classifyDd,
  curl: classifyCurl,
  wget: classifyWget,
  tar: classifyTar,
  unzip: classifyUnzip,
  git: classifyGit,
  gh: classifyGh,
  perl: classifyPerlRuby,
  ruby: classifyPerlRuby,
  eval: classifyEval,
  xargs: classifyXargs,
  tmux: classifyTmux,
  ssh: classifySsh,
  find: classifyFind,
};

/** Runner-style reach into an unknown command's operands. */
function unknownCommandNested(tokens) {
  const nested = [];
  const rest = tokens.slice(1);
  for (let k = 0; k < rest.length; k += 1) {
    const t = rest[k];
    if (t.hadQuote) {
      if (/\s/.test(t.dq) && QUOTED_EXEC_WORD_RE.test(t.dq)) nested.push(t.dq);
      continue;
    }
    if (isFlag(t) || t.hasSubst) continue;
    if (EXEC_OPERAND_NAMES.has(path.posix.basename(t.dq).toLowerCase())) {
      nested.push(
        rest
          .slice(k)
          .map((x) => x.dq)
          .join(' ')
      );
      break;
    }
  }
  return nested;
}

function classifyShellCmd(out, c) {
  const { tokens, ops } = c;
  const cIdx = tokens.findIndex((t) => isFlag(t) && /^-[a-zA-Z]*c$/.test(t.dq));
  if (cIdx !== -1 && tokens[cIdx + 1]) out.nested.push(tokens[cIdx + 1].dq);
  else if (ops[0] && SCRIPT_FILE_RE.test(ops[0].dq)) out.execScripts.push(ops[0]);
}

function classifyInterpreter(out, c) {
  out.interpreterInline = true;
  const scriptOp = c.ops.find((t) => SCRIPT_FILE_RE.test(t.dq));
  if (scriptOp) out.execScripts.push(scriptOp);
}

function classifySegment(seg) {
  const out = {
    targets: [],
    destructive: false,
    nested: [],
    execScripts: [],
    refBlocks: false,
    refBlocksGlobal: false,
    interpreterInline: false,
    unparseable: false,
  };
  for (const r of seg.redirects) out.targets.push(r.target);

  const tokens = effectiveTokens(seg.tokens);
  if (!tokens.length) return out;
  if (tokens[0].hasSubst) {
    out.unparseable = true; // command word itself is dynamic
    return out;
  }
  const cmd = path.posix.basename(tokens[0].dq).toLowerCase();
  if (READ_CMDS.has(cmd)) return out;

  const c = { tokens, ops: operandTokens(tokens), flagValue: flagValueFn(tokens) };
  const handler = HANDLERS[cmd];
  if (handler) {
    handler(out, c);
  } else if (SHELL_CMDS.has(cmd)) {
    classifyShellCmd(out, c);
  } else if (INTERPRETER_INLINE.has(cmd)) {
    classifyInterpreter(out, c);
  } else {
    out.nested.push(...unknownCommandNested(tokens));
  }
  return out;
}

module.exports = {
  classifySegment,
  effectiveTokens,
  operandTokens,
  isFlag,
  READ_CMDS,
  SHELL_CMDS,
  INTERPRETER_INLINE,
};
