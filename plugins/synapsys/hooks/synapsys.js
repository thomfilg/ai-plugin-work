#!/usr/bin/env node
'use strict';

/**
 * Synapsys dispatcher hook.
 *
 * Usage (registered in hooks.json):
 *   node synapsys.js <Event>
 *
 * Stdin: Claude Code hook JSON payload.
 * Stdout: Injected text (becomes a <system-reminder> in the conversation)
 *         when one or more memories match the event + trigger pattern.
 *
 * Fail-open: any error → exit 0 with no output. Memory injection must
 * never block the user's prompt or tool call.
 */

const path = require('node:path');
const { listMemories, discoverStores } = require(path.join(__dirname, '..', 'lib', 'memory-store'));
const { selectForEvent } = require(path.join(__dirname, '..', 'lib', 'matcher'));

const VALID_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse']);
const MAX_INJECT_CHARS = 8000;

async function readStdin() {
  if (process.stdin.isTTY) return '';
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(''));
  });
}

function parsePayload(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function formatMemory(m) {
  const header = `[synapsys:${m.store.kind}] ${m.name} — ${m.description || '(no description)'}`;
  if (m.inject === 'full') {
    return `${header}\n\n${m.body.trim()}`;
  }
  return `${header}\n  source: ${m.file}`;
}

(async () => {
  try {
    const event = process.argv[2];
    if (!VALID_EVENTS.has(event)) process.exit(0);

    const raw = await readStdin();
    const payload = parsePayload(raw);

    const cwd = payload.cwd || process.cwd();
    const memories = listMemories(cwd);

    // SessionStart fallback hints: nudge the user toward /synapsys:install or
    // /synapsys:crystallize when the plugin is loaded but not yet configured.
    // Only fires once per session (it's the SessionStart event itself), so it's
    // not noisy. Disable with SYNAPSYS_NO_SETUP_HINT=1.
    if (event === 'SessionStart' && process.env.SYNAPSYS_NO_SETUP_HINT !== '1') {
      const stores = discoverStores(cwd);
      if (!stores.length) {
        process.stdout.write(
          '[synapsys:setup-required] No Synapsys memory store is configured for this repo/worktree.\n\n' +
            'AGENT: As your FIRST action this session, surface this to the user and offer to run `/synapsys:install`. Recommend the kind based on context:\n' +
            '  - If `git worktree list` shows >1 entry → recommend `worktree` (shared across all worktrees of this repo)\n' +
            '  - Otherwise → recommend `local`\n' +
            '  - Mention `global` as an option that survives worktree deletion\n\n' +
            'Do NOT install without asking — present the recommendation via `AskUserQuestion` so the user can confirm or choose differently. If the user declines, set SYNAPSYS_NO_SETUP_HINT=1 to silence this prompt for future sessions.'
        );
        process.exit(0);
      }
      if (!memories.length) {
        const dirs = stores.map((s) => `${s.kind} (${s.dir})`).join(', ');
        process.stdout.write(
          `[synapsys:empty-store] Memory store(s) ready: ${dirs}. No memories yet.\n\n` +
            'AGENT: Mention this to the user and offer two paths:\n' +
            "  - `/synapsys:crystallize` — import Claude's existing auto-memories (if any exist for this repo)\n" +
            '  - `/synapsys:memorize "<what to remember>"` — add a memory manually\n\n' +
            'Do not auto-run either — let the user pick. If they decline, set SYNAPSYS_NO_SETUP_HINT=1 to silence.'
        );
        process.exit(0);
      }
    }

    if (!memories.length) process.exit(0);

    const matched = selectForEvent(memories, event, payload);
    if (!matched.length) process.exit(0);

    const blocks = matched.map(formatMemory);
    let out = blocks.join('\n\n---\n\n');
    if (out.length > MAX_INJECT_CHARS) {
      out = `${out.slice(0, MAX_INJECT_CHARS)}\n\n[synapsys: output truncated at ${MAX_INJECT_CHARS} chars]`;
    }
    process.stdout.write(out);
    process.exit(0);
  } catch {
    process.exit(0);
  }
})();
