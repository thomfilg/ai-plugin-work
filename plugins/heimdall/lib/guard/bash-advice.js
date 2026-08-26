'use strict';

/**
 * Remediation advice for the coarse `bash-absolute-path-write` fallback.
 *
 * That lane fires ONLY when the structured scanner could not model the command
 * and the whole-string heuristic then saw a write token *somewhere* and the
 * protected dir *somewhere*, with no way to prove they are the same operand.
 * The usual cause is command SHAPE, not intent: a script that merely LIVES
 * under the protected dir (running one is normally allowed — trustedSubdirs)
 * wrapped in constructs the scanner does not model.
 *
 * Emitting the bare "ask the user to UNLOCK this path" there is wrong twice:
 * the write may not exist at all, and an unlock would not make the command
 * parseable. So the block names the fragment that failed to parse and the
 * construct that broke it, asks for a re-issue in a parseable shape first, and
 * keeps the unlock instruction gated behind that retry.
 */

const os = require('node:os');
const { scanCommand, MAX_COMMAND_LENGTH } = require('./bash-scan');
const { classifySegment, effectiveTokens } = require('./bash-classify');

const MAX_FRAGMENT = 160;

/** True when the structured lane models this text end to end. */
function parses(text) {
  const scanned = scanCommand(text);
  if (!scanned) return false;
  return scanned.segments.every((seg) => !classifySegment(seg).unparseable);
}

/**
 * Narrowest piece we can PROVE the scanner rejects: a single line when the
 * command is multi-line, else the whole command. null when the literal command
 * parses (the fallback was then triggered by a de-quoted / brace-expanded
 * variant — see shell-normalize — and there is no fragment to point at).
 */
function failingFragment(command) {
  if (parses(command)) return null;
  const lines = command
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length > 1) {
    for (const line of lines) {
      if (!parses(line)) return line;
    }
  }
  return command.trim();
}

/** Odd count of a quote char, ignoring backslash-escaped occurrences. */
function unbalanced(text, quote) {
  const stripped = text.replace(/\\./g, '');
  return (stripped.split(quote).length - 1) % 2 === 1;
}

function heredocCount(text) {
  return (text.match(/<<-?\s*['"]?[A-Za-z_]\w*/g) || []).length;
}

/** Constructs bash-scan.js returns DONE on, in the order they are reported. */
const SCAN_STOPPERS = [
  [(t) => /<\(|>\(/.test(t), 'process substitution `<(…)` / `>(…)`'],
  [(t) => /\$\(\(/.test(t), 'arithmetic expansion `$((…))`'],
  [(t) => heredocCount(t) > 1, 'more than one heredoc in a command'],
  [(t) => unbalanced(t, '"') || unbalanced(t, "'") || unbalanced(t, '`'), 'an unbalanced quote'],
  [(t) => /(?:>>|>\||>|&>>|&>|<)\s*$/.test(t), 'a redirect with no target'],
  [(t) => t.length > MAX_COMMAND_LENGTH, `a command over ${MAX_COMMAND_LENGTH} characters`],
];

/** Command words that come from `$VAR` / `$(…)` — classify cannot resolve them. */
function dynamicCommandWords(text) {
  const scanned = scanCommand(text);
  if (!scanned) return [];
  const words = [];
  for (const seg of scanned.segments) {
    if (!classifySegment(seg).unparseable) continue;
    const first = effectiveTokens(seg.tokens)[0];
    if (first) words.push(first.raw);
  }
  return words;
}

/** Everything in `fragment` that stops the structured scanner. */
function causesFor(fragment) {
  const causes = [];
  for (const [detect, label] of SCAN_STOPPERS) {
    if (detect(fragment)) causes.push(label);
  }
  for (const word of dynamicCommandWords(fragment)) {
    causes.push(`a command word that is a substitution (\`${word}\`)`);
  }
  return causes;
}

function truncate(text) {
  const oneLine = text.replace(/\s*\n+\s*/g, ' ');
  return oneLine.length > MAX_FRAGMENT ? `${oneLine.slice(0, MAX_FRAGMENT)}…` : oneLine;
}

const RETRY_BLOCK =
  `\nRE-ISSUE IT IN A SHAPE HEIMDALL CAN SCOPE — same work, same arguments:\n` +
  `  • drop \`<(…)\`, \`>(…)\` and \`$((…))\`; use a temp file or plain arithmetic\n` +
  `  • name the program literally — a command word from \`$VAR\`/\`$(…)\` cannot be resolved\n` +
  `  • one heredoc per command, and balance every quote\n` +
  `  • run the program directly instead of burying it in another command's quoted\n` +
  `    string (\`bash -c "…"\`, \`ssh host "…"\`, \`tmux new-session "…"\`) — the wrapper\n` +
  `    hides the real operands\n` +
  `  • split a chained command into one Bash call per command and drop redirects you\n` +
  `    do not need (\`> file 2>&1\`, \`2>/dev/null\`)\n` +
  `This is about parseability, not about doing less: keep the arguments identical.\n`;

/**
 * Block-message body for the coarse fallback. `entry` supplies the protected
 * dir so the message states exactly which path the whole-string check saw.
 */
function unparseableAdvice(command, entry) {
  const dir = entry ? entry.dir.replace(os.homedir(), '~') : 'the protected path';
  const fragment = failingFragment(String(command || ''));
  const causes = causesFor(fragment === null ? String(command || '') : fragment);
  let msg =
    `\nWHY THIS FIRED — likely a FALSE POSITIVE, fix the command before asking to unlock:\n` +
    `heimdall could not parse this command, so it fell back to a whole-string check: it\n` +
    `saw a write token somewhere and ${dir} somewhere, and cannot tell whether they are\n` +
    `the same operand. READING or RUNNING a script that merely lives under a protected\n` +
    `path is normally allowed — this blocked on the command's shape, not on what it does.\n`;
  if (fragment === null) {
    msg += `The literal command parses; a de-quoted/brace-expanded form of it does not.\n`;
  } else {
    msg += `Could not parse:\n  ${truncate(fragment)}\n`;
  }
  if (causes.length) msg += `Unmodeled here: ${causes.join('; ')}.\n`;
  return msg + RETRY_BLOCK;
}

module.exports = { unparseableAdvice, failingFragment, causesFor };
