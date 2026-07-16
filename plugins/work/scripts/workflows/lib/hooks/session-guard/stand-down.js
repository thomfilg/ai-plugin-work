'use strict';

/**
 * session-guard/stand-down.js — Stop-hook stand-down policy (GH-752,
 * outcome-verification Phase 1.1).
 *
 * The guard's quality function lives in stop-block fires 1–3; everything past
 * that is harm (one GH-690 session collected 226 consecutive "DO NOT STOP"
 * blocks, including while rate-limited). This module decides, per Stop fire,
 * whether the guard should BLOCK (normal) or STAND DOWN (allow the stop and
 * surface one line for the conductor):
 *
 *   - immediately, when the stop is caused by a rate limit / API error
 *     (stop message or transcript tail), or when the workflow looks abandoned
 *     (no state-file progress for WORK_GUARD_ABANDON_MS);
 *   - after WORK_GUARD_STAND_DOWN_CAP identical consecutive blocks — where
 *     "identical" means the workflow-state fingerprint (step, dispatch marker,
 *     current task) has not moved between fires. Any progress re-arms the
 *     guard by resetting the counter.
 *
 * The consecutive-block counter persists in the session store file
 * (`standDown: { fingerprint, count, lastAt }`); every stand-down decision is
 * audited to `.work-actions.json` as an enforcement row
 * (`action: session-guard-stand-down`, `allow: true`).
 */

const fs = require('fs');
const path = require('path');

const getConfig = require(path.join(__dirname, '..', '..', 'get-config'));
const { readTicketArtifact } = require(path.join(__dirname, 'context'));
const { writeSessionAtomic } = require(path.join(__dirname, 'store'));

const STAND_DOWN_CAP = Number.parseInt(process.env.WORK_GUARD_STAND_DOWN_CAP, 10) || 3;
const ABANDON_MS = Number.parseInt(process.env.WORK_GUARD_ABANDON_MS, 10) || 4 * 60 * 60 * 1000;
const TRANSCRIPT_TAIL_BYTES = 8192;

// Rate-limit / API-error markers. Kept deliberately narrow: a stand-down on a
// false positive only ends one stop-block loop; a miss costs three more fires.
const RATE_LIMIT_RE =
  /rate.?limit|overloaded_error|too many requests|quota exceeded|usage limit reached|\b(?:429|529)\b/i;

/** Read the last chunk of a transcript file; '' on any failure. */
function readTranscriptTail(transcriptPath) {
  if (!transcriptPath) return '';
  try {
    const stat = fs.statSync(transcriptPath);
    const start = Math.max(0, stat.size - TRANSCRIPT_TAIL_BYTES);
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const buf = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/** mtime (epoch ms) of a per-ticket artifact, or null when unreadable. */
function ticketArtifactMtime(ticketId, fileName) {
  try {
    const tasksBase = getConfig('TASKS_BASE');
    if (!tasksBase || !ticketId) return null;
    let safeId = ticketId;
    try {
      safeId = require(path.join(__dirname, '..', '..', 'config')).safeTicketId(ticketId);
    } catch {
      /* raw id */
    }
    const resolved = path.resolve(tasksBase, safeId, fileName);
    if (!resolved.startsWith(path.resolve(tasksBase) + path.sep)) return null;
    return fs.statSync(resolved).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Fingerprint of "where the workflow is": while this stays constant across
 * Stop fires the guard is repeating itself; when it moves, progress happened
 * and the counter re-arms. Reads .work-state.json best-effort.
 */
function progressFields(ws) {
  const step = ws?.currentStep ?? '';
  const dispatched = ws?._work2Dispatched ?? '';
  const taskIdx = ws?.tasksMeta?.currentTaskIndex ?? '';
  return `:${step}:${dispatched}:${taskIdx}`;
}

function computeBlockFingerprint(session) {
  const base = `${session.ticketId}:${session.workflow || ''}`;
  try {
    const raw = readTicketArtifact(session.ticketId, '.work-state.json');
    return raw ? base + progressFields(JSON.parse(raw)) : base;
  } catch {
    return base;
  }
}

/**
 * Reasons that stand the guard down on the FIRST fire, without counting:
 * a blocked stop cannot help when the runtime is rate-limited or the
 * workflow has been abandoned.
 */
function detectImmediateReason(hookData, session, now) {
  const stopMessage = String(hookData?.stop_message || '');
  if (RATE_LIMIT_RE.test(stopMessage)) return 'rate-limit';
  if (RATE_LIMIT_RE.test(readTranscriptTail(hookData?.transcript_path))) return 'rate-limit';

  const stateMtime = ticketArtifactMtime(session.ticketId, '.work-state.json');
  if (stateMtime !== null && now - stateMtime > ABANDON_MS) return 'abandoned';
  return null;
}

/**
 * Decide block vs stand-down for one Stop fire and persist the counter.
 * @returns {{ action: 'block'|'stand-down', reason?: string, fingerprint: string, count: number }}
 */
function assessStop(hookData, session, now = Date.now()) {
  const fingerprint = computeBlockFingerprint(session);

  const immediate = detectImmediateReason(hookData, session, now);
  if (immediate) {
    return { action: 'stand-down', reason: immediate, fingerprint, count: 0 };
  }

  const prior = session.standDown;
  const count = prior && prior.fingerprint === fingerprint ? prior.count + 1 : 1;
  try {
    writeSessionAtomic(session.ticketId, {
      ...session,
      standDown: { fingerprint, count, lastAt: new Date(now).toISOString() },
    });
  } catch {
    /* counter persistence is best-effort — never break the hook */
  }

  if (count > STAND_DOWN_CAP) {
    return { action: 'stand-down', reason: 'repeat-cap', fingerprint, count };
  }
  return { action: 'block', fingerprint, count };
}

/**
 * Surface ONE conductor-visible line and audit the stand-down. Never throws.
 */
function surfaceStandDown(verdict, session) {
  const workflow = session.workflow || '/work';
  process.stderr.write(
    `[session-guard] STAND-DOWN (${verdict.reason}): allowing stop for ${session.ticketId} ` +
      `after ${verdict.count} identical block(s). The workflow needs attention — ` +
      `resume with: ${workflow} ${session.ticketId}\n`
  );
  try {
    const { appendEnforcementAudit } = require(
      path.join(__dirname, '..', '..', '..', 'work', 'lib', 'work-actions')
    );
    appendEnforcementAudit(session.ticketId, {
      origin: 'workflow',
      task: null,
      phase: null,
      action: 'session-guard-stand-down',
      allow: true,
      reason: verdict.reason,
      outputPath: null,
      meta: { workflow, fingerprint: verdict.fingerprint, count: verdict.count },
    });
  } catch {
    /* audit is best-effort — the stand-down itself must not fail */
  }
}

module.exports = {
  STAND_DOWN_CAP,
  assessStop,
  computeBlockFingerprint,
  detectImmediateReason,
  surfaceStandDown,
};
