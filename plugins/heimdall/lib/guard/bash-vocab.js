'use strict';

/**
 * Command vocabulary tables for the structured bash analyzer (GH-699).
 * Split out of bash-classify.js so the classifier's logic stays under the
 * per-file line budget; these are pure data.
 */

// Wrapper commands that prefix another command. Value = extra non-flag
// operands to skip before the wrapped command starts.
const WRAPPERS = {
  sudo: 0,
  doas: 0,
  command: 0,
  nohup: 0,
  time: 0,
  setsid: 0,
  ionice: 0,
  'xvfb-run': 0,
  nice: 0,
  timeout: 1,
  stdbuf: 0,
  env: 0,
  busybox: 0,
};
const WRAPPER_VALUE_FLAGS = new Set(['-u', '-g', '-n', '-o', '-e', '-i', '-C', '--chdir']);

// No filesystem-write semantics: operands are never write targets. A same-
// segment redirect target is still analyzed by the caller.
// `awk` writing requires `> "file"` INSIDE the program (a quoted operand of a
// read command) — out of scope exactly like the legacy matcher.
const READ_CMDS = new Set([
  'cat', 'head', 'tail', 'less', 'more', 'wc', 'stat', 'file', 'ls', 'dir',
  'grep', 'egrep', 'fgrep', 'rg', 'ag', 'diff', 'cmp', 'comm', 'md5sum',
  'sha1sum', 'sha256sum', 'shasum', 'readlink', 'realpath', 'du', 'df',
  'sort', 'uniq', 'tr', 'cut', 'jq', 'yq', 'strings', 'xxd', 'hexdump', 'od',
  'pwd', 'echo', 'printf', 'which', 'type', 'basename', 'dirname', 'tree',
  'date', 'whoami', 'id', 'uname', 'true', 'false', ':', 'test', '[', 'seq',
  'sleep', 'wait', 'column', 'nl', 'tac', 'awk', 'paste', 'join', 'expr',
  'printenv', 'hostname', 'uptime', 'free', 'nproc', 'getent',
]); // biome-ignore format: keep the vocabulary compact (line-budget)

const GIT_READ_SUBS = new Set([
  'status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'ls-remote',
  'ls-tree', 'describe', 'blame', 'shortlog', 'cat-file', 'merge-base',
  'grep', 'reflog', 'var', 'count-objects', 'cherry', 'whatchanged',
]); // biome-ignore format: keep the vocabulary compact (line-budget)

// Materialize files whose paths aren't statically derivable (patch/merge/
// stash results): a protected ref in the segment blocks (segment-scoped).
const GIT_MUTATING_SUBS = new Set([
  'clone', 'checkout', 'pull', 'apply', 'am', 'cherry-pick', 'switch',
  'merge', 'rebase', 'revert', 'stash', 'reset',
]); // biome-ignore format: keep the vocabulary compact (line-budget)

const GIT_PATHSPEC_WRITE_SUBS = new Set(['rm', 'mv', 'restore', 'clean']);
const GH_DOWNLOAD_VERBS = new Set(['clone', 'download']);

const INTERPRETER_INLINE = new Set([
  'node', 'python', 'python2', 'python3', 'perl', 'ruby', 'deno', 'bun',
]); // biome-ignore format: keep the vocabulary compact (line-budget)
const SHELL_CMDS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const SCRIPT_FILE_RE = /\.(?:js|mjs|cjs|py|rb|pl|sh)$/i;

// Names that, as an operand of an UNKNOWN command, mean "a command follows"
// (runner style: `mycustomrunner rm -rf x`, `concurrently "rm x" "tsc -w"`).
const EXEC_OPERAND_NAMES = new Set([
  'rm', 'rmdir', 'unlink', 'shred', 'mv', 'cp', 'install', 'rsync', 'ln',
  'tee', 'sponge', 'patch', 'dd', 'sed', 'touch', 'mkdir', 'chmod', 'chown',
  'chgrp', 'truncate', 'curl', 'wget', 'tar', 'unzip',
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'eval', 'xargs', 'find', 'git', 'gh',
  'tmux', 'ssh', 'node', 'python', 'python2', 'python3', 'perl', 'ruby',
]); // biome-ignore format: keep the vocabulary compact (line-budget)

const QUOTED_EXEC_WORD_RE =
  /(?:^|[\s;|&])(?:rm|rmdir|unlink|shred|mv|cp|install|rsync|ln|tee|sponge|patch|dd|sed|touch|mkdir|chmod|chown|truncate|sh|bash|zsh|dash|eval|xargs|find|git)(?:$|[\s;|&])/;

module.exports = {
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
};
