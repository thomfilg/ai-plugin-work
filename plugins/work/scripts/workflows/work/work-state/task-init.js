/**
 * GH-410 task-init descriptor ingestion from stdin. Extracted from
 * work-state.js (file-size burndown). Behavior is unchanged — the stdin
 * hardening (size cap + idle timeout) and stdin-only trust boundary are
 * preserved verbatim; `readTaskInitDescriptors` delegates JSON parsing to a
 * helper to satisfy the complexity gate.
 *
 * Returns the parsed array (with auto-assigned `num` when missing) on success,
 * `{ error }` on malformed JSON, or `null` when no descriptors were supplied
 * (legacy count-mode).
 *
 * Stdin is the only accepted channel. Earlier drafts also honored a
 * TASK_INIT_DESCRIPTORS env var — that was dropped as a security hardening
 * (security review on PR #470): env vars leak across subprocess hops too
 * freely, and any hook or subagent that could set it could re-classify real
 * implementation tasks as kind:"checkpoint" and bypass the TDD gate via the
 * auto-complete path. Stdin requires being the direct parent process, which
 * is a much narrower trust boundary.
 *
 * Stdin hardening for readTaskInitDescriptors: cap the read size (defends
 * against an unbounded pipe OOMing this subprocess) and add an idle timeout
 * (defends against a caller that opens stdio:'pipe' but forgets to .end() —
 * the read would otherwise wait forever). Both bounds are well above the
 * realistic descriptor payload (a few hundred tasks * a couple-hundred bytes).
 * Resolves to the raw string, or `{ __readError }` on overflow/timeout.
 */

'use strict';

const TASK_INIT_STDIN_MAX_BYTES = 1024 * 1024; // 1 MiB
const TASK_INIT_STDIN_IDLE_TIMEOUT_MS = 5000;
const TASK_INIT_MAX_TITLE_LEN = 256;

function readStdinPayload() {
  return new Promise((resolve, reject) => {
    let buf = '';
    let overflowed = false;
    let timer = null;
    const resetIdle = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        process.stdin.removeAllListeners('data');
        process.stdin.removeAllListeners('end');
        reject(new Error(`stdin idle for ${TASK_INIT_STDIN_IDLE_TIMEOUT_MS}ms`));
      }, TASK_INIT_STDIN_IDLE_TIMEOUT_MS);
    };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      if (overflowed) return;
      buf += c;
      if (buf.length > TASK_INIT_STDIN_MAX_BYTES) {
        overflowed = true;
        process.stdin.removeAllListeners('data');
        process.stdin.removeAllListeners('end');
        if (timer) clearTimeout(timer);
        reject(new Error(`stdin exceeded ${TASK_INIT_STDIN_MAX_BYTES} bytes`));
        return;
      }
      resetIdle();
    });
    process.stdin.on('end', () => {
      if (timer) clearTimeout(timer);
      resolve(buf);
    });
    resetIdle();
  }).catch((err) => ({ __readError: err.message }));
}

// Schema-normalize descriptors: auto-assign num by 1-based position when
// missing (coercing to integer, rejecting strings like "1") and bound title
// length so a malicious title can't bloat tasksMeta.
function normalizeTaskDescriptors(parsed) {
  return parsed.map((d, i) => {
    if (!d || typeof d !== 'object') return d;
    const out = { ...d };
    if (typeof out.num !== 'number' || !Number.isInteger(out.num)) {
      out.num = i + 1;
    }
    if (typeof out.title === 'string' && out.title.length > TASK_INIT_MAX_TITLE_LEN) {
      out.title = out.title.slice(0, TASK_INIT_MAX_TITLE_LEN);
    }
    return out;
  });
}

// Parse the raw stdin string into a normalized descriptor array, or an
// `{ error }` object on malformed / non-array JSON.
function parseDescriptorPayload(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { error: `task-init: malformed JSON descriptor input: ${e.message}` };
  }
  if (!Array.isArray(parsed)) {
    return { error: 'task-init: descriptor input must be a JSON array' };
  }
  return normalizeTaskDescriptors(parsed);
}

async function readTaskInitDescriptors(secondArg) {
  // Any positional arg → legacy path (let parseInt + initTasksMeta validate).
  // Without this guard, a malformed count like "-1" or "abc" would fall through
  // to the stdin read below and block forever when stdin is an open pipe
  // (e.g. child_process.spawn with stdio: ['pipe', ...]).
  if (secondArg !== undefined && secondArg !== '') {
    return null;
  }

  const raw = process.stdin.isTTY ? null : await readStdinPayload();
  if (raw && typeof raw === 'object' && raw.__readError) {
    return { error: `task-init: stdin read failed: ${raw.__readError}` };
  }
  if (!raw || !raw.trim()) return null;

  return parseDescriptorPayload(raw);
}

module.exports = {
  readStdinPayload,
  normalizeTaskDescriptors,
  readTaskInitDescriptors,
};
