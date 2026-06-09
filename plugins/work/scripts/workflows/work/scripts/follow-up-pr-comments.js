#!/usr/bin/env node
/**
 * follow-up-pr-comments.js
 *
 * Sequential PR comment resolution CLI. This tool performs
 * local tracking only by default: it snapshots PR comments, iterates
 * them one-at-a-time by priority, and builds review-accountability.json
 * incrementally — without ever touching the GitHub conversation threads.
 *
 * Subcommands:
 *   --snapshot --pr <N>                            Fetch & cache all PR comments
 *   --next-comment                                 Return first unsolved comment
 *   --mark-locally-solved <id> <sha> "<desc>"      Mark comment solved (local only)
 *   --mark-locally-skipped <id> "<reason>"         Mark comment skipped (local only)
 *   --status                                       Show summary counts
 *
 * Deprecated aliases:
 *   --solve-comment <id> <sha> "<desc>"     Deprecated alias of
 *                                           --mark-locally-solved. Still
 *                                           works for a 2-3 release
 *                                           window; emits a one-line
 *                                           stderr deprecation warning.
 *   --skip-comment <id> "<reason>"          Deprecated alias of
 *                                           --mark-locally-skipped. Same
 *                                           deprecation warning behavior.
 *
 * Usage: node follow-up-pr-comments.js <subcommand> [args]
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Lazy-load heavy dependencies to avoid crashing on require errors
// (e.g. missing `gh` CLI in CI). This ensures arg-parsing still works
// and subcommands produce clear errors when dependencies are unavailable.
let _followUpPr;
function getFollowUpPr() {
  if (!_followUpPr) {
    try {
      _followUpPr = require('./follow-up-pr');
    } catch (err) {
      console.error(`Error: Failed to load follow-up-pr module: ${err.message}`);
      process.exit(1);
    }
  }
  return _followUpPr;
}

const getConfig = require('../../lib/get-config');
const { getCurrentTaskId } = require('../../lib/scripts/get-ticket-id');
const { gitHunkChangedSince } = require('../../follow-up/lib/git-hunk-changed');

const COPILOT_AUTHORS = new Set([
  'copilot-pull-request-reviewer',
  'copilot-pull-request-reviewer[bot]',
  'github-copilot[bot]',
  'copilot',
]);

function isCopilotAuthor(login) {
  if (!login) return false;
  return COPILOT_AUTHORS.has(String(login).toLowerCase());
}

/**
 * Classify a Copilot review thread that GitHub marks as outdated
 * (line === null, position === null but original_position !== null,
 * and/or position_outdated === true).
 *
 * Returns { status, resolution } where:
 *   - status === 'resolved' when `gitHunkChangedSince` confirms the
 *     originally-commented line actually changed since `created_at`
 *     (R1 — Copilot stale-thread heuristic);
 *   - status === 'unsolved', resolution null when the hunk has NOT
 *     changed since `created_at` (AC5 — no false positives).
 *
 * For non-Copilot threads the heuristic is NOT applied — callers fall
 * back to the existing "Outdated (code changed since comment)" path.
 *
 * `previousStatus` lets us preserve any prior recorded state (so a
 * thread the user already marked solved/skipped stays that way).
 *
 * @param {object} cm GitHub PR review comment payload.
 * @param {{ previousStatus?: {status:string,resolution:string,commitSha?:string}|null, logger?: (msg:string)=>void }} [opts]
 * @returns {{ status: 'resolved'|'unsolved', resolution: string|null, applied: boolean }}
 */
function classifyOutdatedCopilotThread(cm, opts = {}) {
  const { previousStatus = null, logger = console.error } = opts;
  if (previousStatus && previousStatus.status) {
    return {
      status: previousStatus.status,
      resolution: previousStatus.resolution || null,
      applied: false,
    };
  }
  const author = cm?.user?.login || '';
  if (!isCopilotAuthor(author)) {
    return { status: 'resolved', resolution: null, applied: false };
  }
  const filePath = cm?.path || null;
  const originalLine = cm?.original_line || null;
  const createdAt = cm?.created_at || null;
  if (!filePath || !originalLine || !createdAt) {
    return { status: 'unsolved', resolution: null, applied: false };
  }
  let changed = false;
  try {
    changed = gitHunkChangedSince(filePath, originalLine, createdAt, {});
  } catch (err) {
    logger(
      `[follow-up-pr-comments] gitHunkChangedSince failed for ${filePath}:${originalLine} — ${err.message}`
    );
    return { status: 'unsolved', resolution: null, applied: false };
  }
  if (changed) {
    logger(
      `[follow-up-pr-comments] Copilot stale-thread heuristic fired for comment ${cm.id} (${filePath}:${originalLine})`
    );
    return {
      status: 'resolved',
      resolution: 'Outdated (Copilot stale-thread heuristic — code changed since created_at)',
      applied: true,
    };
  }
  return { status: 'unsolved', resolution: null, applied: false };
}

// ── Deprecation warnings (Task 3, GH-537) ────────────────────────────────────
// Legacy flag aliases keep working for a 2-3 release window but must emit
// exactly one stderr line that names the replacement and clarifies that
// the default is local-only (no GitHub thread is resolved).
const DEPRECATION_SOLVE_MSG =
  'warning: --solve-comment is renamed to --mark-locally-solved ' +
  '(no GitHub thread is resolved).';
const DEPRECATION_SKIP_MSG =
  'warning: --skip-comment is renamed to --mark-locally-skipped ' +
  '(no GitHub thread is resolved). Skips are local-only audit trail.';

// ── Config & Paths ───────────────────────────────────────────────────────────

let _safeTicketId;

function loadSafeTicketId() {
  if (_safeTicketId) return _safeTicketId;
  try {
    const config = require('../../lib/config');
    const ticketId = getCurrentTaskId();
    if (!ticketId) {
      console.error('Error: Could not determine ticket ID from cwd or branch.');
      process.exit(2);
    }
    _safeTicketId = config.safeTicketId(ticketId);
  } catch {
    // Fallback: use raw ticket ID if config.safeTicketId is unavailable
    _safeTicketId = getCurrentTaskId();
    if (!_safeTicketId) {
      console.error('Error: Could not determine ticket ID from cwd or branch.');
      process.exit(2);
    }
  }
  return _safeTicketId;
}

function getTaskDir() {
  const tasksBase = getConfig('TASKS_BASE');
  if (!tasksBase) {
    console.error('Error: TASKS_BASE not configured.');
    process.exit(2);
  }
  const ticketId = loadSafeTicketId();
  return path.join(tasksBase, ticketId);
}

function getStateFilePath() {
  return path.join(getTaskDir(), 'follow-up-comments.json');
}

function getAccountabilityFilePath() {
  return path.join(getTaskDir(), 'review-accountability.json');
}

// ── State Helpers ────────────────────────────────────────────────────────────

function loadState() {
  const stateFile = getStateFilePath();
  try {
    const raw = fs.readFileSync(stateFile, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveState(state) {
  const stateFile = getStateFilePath();
  const dir = path.dirname(stateFile);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

// ── Accountability Builder ───────────────────────────────────────────────────

/**
 * Rebuild review-accountability.json from current state.
 * Only includes solved and skipped comments.
 * Format must match: { id, author, path, comment, disposition, reason }
 */
function rebuildAccountability(state) {
  const entries = state.comments
    .filter((c) => c.status === 'solved' || c.status === 'skipped' || c.status === 'resolved')
    .map((c) => ({
      id: c.id,
      author: c.author || 'unknown',
      path: c.path || null,
      comment: (c.body || '').slice(0, 120),
      disposition:
        c.status === 'solved' ? 'addressed' : c.status === 'resolved' ? 'outdated' : 'acknowledged',
      reason:
        c.resolution ||
        (c.status === 'solved'
          ? 'Addressed during follow-up'
          : c.status === 'resolved'
            ? 'Resolved/outdated thread'
            : 'Acknowledged'),
    }));

  const filePath = getAccountabilityFilePath();
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(entries, null, 2));
  return entries;
}

// ── Input Validation ─────────────────────────────────────────────────────────

function validateCommentId(raw) {
  if (!raw || String(raw).trim() === '') return null;
  // Accept both numeric IDs (inline comments) and string IDs (review-level, e.g. PRR_kwDO...)
  const trimmed = String(raw).trim();
  const asNum = Number(trimmed);
  if (Number.isFinite(asNum) && asNum > 0 && Math.floor(asNum) === asNum) {
    return asNum;
  }
  return trimmed;
}

function validateCommitSha(raw) {
  if (!raw || typeof raw !== 'string') return null;
  // Hex string, 7-40 characters
  if (!/^[0-9a-f]{7,40}$/i.test(raw)) return null;
  return raw;
}

function truncate(str, maxLen = 500) {
  if (!str || typeof str !== 'string') return '';
  return str.slice(0, maxLen);
}

// ── Priority Ordering ────────────────────────────────────────────────────────

const PRIORITY_ORDER = Object.create(null);
PRIORITY_ORDER['high'] = 0;
PRIORITY_ORDER['medium'] = 1;
PRIORITY_ORDER['low'] = 2;

function priorityRank(priority) {
  const rank = PRIORITY_ORDER[priority];
  return rank !== undefined ? rank : 3;
}

// ── Subcommand: --snapshot ───────────────────────────────────────────────────

function handleSnapshot(prNumber) {
  if (!prNumber) {
    console.error('Error: --snapshot requires --pr <number>');
    process.exit(2);
  }

  const { ghExec, getResolvedCommentIds, computeCommentHash, classifyCommentPriority } =
    getFollowUpPr();

  try {
    // Get repo info
    const repoInfo = ghExec('repo view --json nameWithOwner');
    const repo = repoInfo.nameWithOwner;
    if (!repo) {
      console.error('Error: Could not determine repository.');
      process.exit(2);
    }

    // Fetch resolved thread IDs to exclude.
    // getResolvedCommentIds returns:
    //   { resolved: Set, outdatedThreadIds: Array, commentIdToThreadId: Map }
    // commentIdToThreadId is persisted onto comment.threadId for
    // forward-compatibility. The field is currently dormant — the opt-in
    // GitHub-resolve flag that originally consumed it was withdrawn.
    const resolvedResult = getResolvedCommentIds(repo, prNumber);
    const resolvedIds = resolvedResult?.resolved || new Set();
    const commentIdToThreadId = resolvedResult?.commentIdToThreadId || new Map();

    // Preserve solved/skipped state from previous snapshot to avoid
    // re-presenting comments that were already addressed (GH-358).
    const previousState = loadState();
    const previousStatusMap = new Map();
    if (previousState?.comments) {
      for (const c of previousState.comments) {
        if (c.status === 'solved' || c.status === 'skipped') {
          previousStatusMap.set(String(c.id), {
            status: c.status,
            commitSha: c.commitSha || null,
            resolution: c.resolution || null,
            threadId: c.threadId || null,
          });
        } else if (c.threadId) {
          // Preserve threadId for non-terminal statuses too, so a transient
          // GraphQL miss in commentIdToThreadId doesn't wipe a previously
          // recorded threadId on subsequent snapshots.
          previousStatusMap.set(String(c.id), {
            threadId: c.threadId,
          });
        }
      }
    }

    const seenHashes = new Set();
    const comments = [];

    // 1) Fetch review-level comments via gh pr view
    try {
      const prData = ghExec(`pr view ${prNumber} --json reviews`);
      const reviews = prData.reviews || [];
      for (const review of reviews) {
        if (!review.body || !review.body.trim()) continue;
        const author = review.author?.login || 'unknown';
        const body = (review.body || '').trim();

        // Skip bot summary comments (Bugbot, Copilot summaries) — not actionable code issues
        if (/<!-- BUGBOT_REVIEW -->|<!-- BUGBOT_FIX_ALL -->|BUGBOT_AUTOFIX/i.test(body)) continue;
        if (/<!-- copilot_review_start -->|copilot-pull-request-reviewer/i.test(body)) continue;

        const hash = computeCommentHash(null, body);
        if (seenHashes.has(hash)) continue;
        seenHashes.add(hash);

        comments.push({
          id: review.id || comments.length + 1,
          hash,
          author,
          body,
          path: null,
          line: null,
          original_line: null,
          priority: classifyCommentPriority(author, body),
          status: previousStatusMap.get(String(review.id))?.status
            ? previousStatusMap.get(String(review.id)).status
            : 'unsolved',
          commitSha: previousStatusMap.get(String(review.id))?.commitSha || null,
          resolution: previousStatusMap.get(String(review.id))?.resolution || null,
          // Review-level comments are not GraphQL review threads, so no threadId.
          threadId: null,
        });
      }
    } catch (err) {
      console.error(`Warning: Failed to fetch review-level comments: ${err.message}`);
    }

    // 2) Fetch inline comments with pagination
    let rawInlineCount = 0;
    try {
      const perPage = 100;
      let page = 1;
      while (true) {
        const pageData = ghExec([
          'api',
          `repos/${repo}/pulls/${prNumber}/comments?per_page=${perPage}&page=${page}`,
        ]);
        if (!Array.isArray(pageData) || pageData.length === 0) break;
        rawInlineCount += pageData.length;

        for (const cm of pageData) {
          const isResolved = resolvedIds.has(cm.id);
          const author = cm.user?.login || 'unknown';
          const body = (cm.body || '').trim();
          const filePath = cm.path || null;

          // Skip replies (only process top-level comments)
          if (cm.in_reply_to_id) continue;

          // Skip outdated comments (code changed since comment was posted)
          // position === null means the diff context is gone
          if (cm.position === null && cm.original_position !== null) {
            // Mark as resolved so it counts but doesn't iterate
            const hashKey = String(cm.id);
            if (seenHashes.has(hashKey)) continue;
            seenHashes.add(hashKey);

            // R1 — Copilot stale-thread heuristic: for Copilot-authored
            // threads with line:null + position_outdated semantics, only
            // declare the thread resolved when the originally-commented
            // hunk has actually changed since `created_at`. Non-Copilot
            // threads fall through to the legacy unconditional 'resolved'.
            const previousStatus = previousStatusMap.get(String(cm.id)) || null;
            let defaultStatus = 'resolved';
            let defaultResolution = 'Outdated (code changed since comment)';
            const classification = classifyOutdatedCopilotThread(cm, {
              previousStatus,
            });
            if (classification.applied) {
              defaultStatus = classification.status;
              defaultResolution = classification.resolution;
            } else if (isCopilotAuthor(author) && !previousStatus?.status) {
              // Copilot author but helper said not-applied AND no prior
              // status — that means the hunk did NOT change since
              // created_at (AC5: no false positives). Keep the comment
              // surfaced as unsolved instead of auto-resolving.
              defaultStatus = classification.status; // 'unsolved'
              defaultResolution = classification.resolution; // null
            }

            comments.push({
              id: cm.id,
              hash: computeCommentHash(filePath, body),
              author,
              body,
              path: filePath,
              line: cm.line || cm.original_line || null,
              original_line: cm.original_line || null,
              priority: classifyCommentPriority(author, body),
              status: previousStatus?.status || defaultStatus,
              commitSha: previousStatus?.commitSha || null,
              resolution: previousStatus?.resolution || defaultResolution,
              threadId: commentIdToThreadId.get(cm.id) || previousStatus?.threadId || null,
            });
            continue;
          }

          // Key on comment ID to preserve all distinct comments
          const hashKey = String(cm.id);
          if (seenHashes.has(hashKey)) continue;
          seenHashes.add(hashKey);

          comments.push({
            id: cm.id,
            hash: computeCommentHash(filePath, body),
            author,
            body,
            path: filePath,
            line: cm.line || null,
            original_line: cm.original_line || null,
            priority: classifyCommentPriority(author, body),
            status: previousStatusMap.get(String(cm.id))?.status
              ? previousStatusMap.get(String(cm.id)).status
              : isResolved
                ? 'resolved'
                : 'unsolved',
            commitSha: previousStatusMap.get(String(cm.id))?.commitSha || null,
            resolution:
              previousStatusMap.get(String(cm.id))?.resolution ||
              (isResolved ? 'Resolved/outdated thread' : null),
            threadId:
              commentIdToThreadId.get(cm.id) ||
              previousStatusMap.get(String(cm.id))?.threadId ||
              null,
          });
        }

        if (pageData.length < perPage) break;
        page++;
      }
    } catch (err) {
      // Emit stderr warning per spec -- don't silently swallow
      console.error(`Warning: Failed to fetch inline comments: ${err.message}`);
    }

    const state = {
      snapshotAt: new Date().toISOString(),
      prNumber: Number(prNumber),
      repo,
      strictCommentCount: rawInlineCount,
      comments,
    };

    saveState(state);
    console.log(
      JSON.stringify({
        message: 'Snapshot complete',
        total: comments.length,
        strictCommentCount: rawInlineCount,
      })
    );
    process.exit(0);
  } catch (err) {
    console.error(`Error: Snapshot failed: ${err.message}`);
    process.exit(2);
  }
}

// ── Subcommand: --next-comment ───────────────────────────────────────────────

function handleNextComment() {
  const state = loadState();
  if (!state) {
    console.error('Error: No snapshot found. Run --snapshot --pr <N> first.');
    process.exit(1);
  }

  const unsolved = state.comments
    .filter((c) => c.status === 'unsolved')
    .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority));

  if (unsolved.length === 0) {
    console.log(JSON.stringify({ done: true }));
    process.exit(0);
  }

  const comment = unsolved[0];
  let codeContext = null;
  if (comment.path && comment.line) {
    const { getCodeContext } = getFollowUpPr();
    codeContext = getCodeContext(comment.path, comment.line, 3);
  }

  console.log(
    JSON.stringify({
      id: comment.id,
      author: comment.author,
      body: comment.body,
      path: comment.path,
      line: comment.line,
      priority: comment.priority,
      codeContext: codeContext || null,
    })
  );
  process.exit(0);
}

// ── Helpers: solveLocally / skipLocally ──────────────────────────────────────
//
// These helpers update the local follow-up-comments.json snapshot for a
// single comment. They are pure side-effecting functions (no argv parsing,
// no process.exit) so the CLI handlers below and any new flag aliases can
// share them. See GH-537 / Task 1.

/**
 * Mark a comment as solved in the local snapshot.
 * @param {string|number} commentId - The comment id (already validated).
 * @param {string} commitSha - The commit sha that addresses the comment (already validated).
 * @param {string} description - Free-form resolution note (already truncated).
 * @returns {{ solved: string|number, commitSha: string }} payload safe to serialize.
 * @throws {Error} when the snapshot is missing or the comment id is not present.
 */
function solveLocally(commentId, commitSha, description) {
  const state = loadState();
  if (!state) {
    const err = new Error('No snapshot found. Run --snapshot --pr <N> first.');
    err.code = 'NO_SNAPSHOT';
    throw err;
  }

  const comment = state.comments.find((c) => String(c.id) === String(commentId));
  if (!comment) {
    const err = new Error(`Comment ID ${commentId} not found in snapshot.`);
    err.code = 'COMMENT_NOT_FOUND';
    throw err;
  }

  comment.status = 'solved';
  comment.commitSha = commitSha;
  comment.resolution = description;

  saveState(state);
  rebuildAccountability(state);

  return { solved: commentId, commitSha };
}

/**
 * Mark a comment as skipped in the local snapshot.
 * @param {string|number} commentId - The comment id (already validated).
 * @param {string} reason - Free-form skip reason (already truncated).
 * @returns {{ skipped: string|number }} payload safe to serialize.
 * @throws {Error} when the snapshot is missing or the comment id is not present.
 */
function skipLocally(commentId, reason) {
  const state = loadState();
  if (!state) {
    const err = new Error('No snapshot found. Run --snapshot --pr <N> first.');
    err.code = 'NO_SNAPSHOT';
    throw err;
  }

  const comment = state.comments.find((c) => String(c.id) === String(commentId));
  if (!comment) {
    const err = new Error(`Comment ID ${commentId} not found in snapshot.`);
    err.code = 'COMMENT_NOT_FOUND';
    throw err;
  }

  comment.status = 'skipped';
  comment.resolution = reason;

  saveState(state);
  rebuildAccountability(state);

  return { skipped: commentId };
}

// ── Subcommand: --solve-comment ──────────────────────────────────────────────

function handleSolveComment(rawId, rawSha, rawDesc) {
  const commentId = validateCommentId(rawId);
  if (commentId === null) {
    console.error('Error: Invalid comment ID. Must be a non-empty value.');
    process.exit(1);
  }

  const commitSha = validateCommitSha(rawSha);
  if (commitSha === null) {
    console.error('Error: Invalid commit SHA. Must be a hex string of 7-40 characters.');
    process.exit(1);
  }

  const description = truncate(rawDesc);

  let payload;
  try {
    payload = solveLocally(commentId, commitSha, description);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  console.log(JSON.stringify(payload));
  process.exit(0);
}

// ── Subcommand: --skip-comment ───────────────────────────────────────────────

function handleSkipComment(rawId, rawReason) {
  const commentId = validateCommentId(rawId);
  if (commentId === null) {
    console.error('Error: Invalid comment ID. Must be a non-empty value.');
    process.exit(1);
  }

  const reason = truncate(rawReason);

  let payload;
  try {
    payload = skipLocally(commentId, reason);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  console.log(JSON.stringify(payload));
  process.exit(0);
}

// ── Subcommand: --status ─────────────────────────────────────────────────────

function handleStatus() {
  const state = loadState();
  if (!state) {
    console.log(
      JSON.stringify({
        total: 0,
        solved: 0,
        skipped: 0,
        remaining: 0,
        strictCommentCount: 0,
      })
    );
    process.exit(0);
  }

  const total = state.comments.length;
  const solved = state.comments.filter((c) => c.status === 'solved').length;
  const skipped = state.comments.filter((c) => c.status === 'skipped').length;
  const resolved = state.comments.filter((c) => c.status === 'resolved').length;
  const remaining = total - solved - skipped - resolved;

  console.log(
    JSON.stringify({
      total,
      solved,
      skipped,
      remaining,
      strictCommentCount: state.strictCommentCount ?? total,
    })
  );
  process.exit(0);
}

// ── Usage ────────────────────────────────────────────────────────────────────

function printUsage() {
  console.error(`Usage: node follow-up-pr-comments.js <subcommand> [args]

Subcommands:
  --snapshot --pr <N>                            Fetch & cache all PR comments
  --next-comment                                 Return first unsolved comment by priority
  --mark-locally-solved <id> <sha> "<desc>"      Mark comment solved (local only)
  --mark-locally-skipped <id> "<reason>"         Mark comment skipped (local only)
  --status                                       Show summary counts

Deprecated aliases (still accepted, but emit a warning):
  --solve-comment <id> <sha> "<desc>"     Deprecated alias of --mark-locally-solved
  --skip-comment <id> "<reason>"          Deprecated alias of --mark-locally-skipped`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const argv = process.argv.slice(2);

  if (argv.length === 0) {
    printUsage();
    process.exit(2);
  }

  const subcommand = argv[0];

  switch (subcommand) {
    case '--snapshot': {
      let prNumber = null;
      for (let i = 1; i < argv.length; i++) {
        if (argv[i] === '--pr' && argv[i + 1]) {
          prNumber = argv[i + 1];
          i++;
        }
      }
      if (!prNumber) {
        console.error('Error: --snapshot requires --pr <number>');
        process.exit(2);
      }
      handleSnapshot(prNumber);
      break;
    }

    case '--next-comment':
      handleNextComment();
      break;

    case '--solve-comment':
    case '--mark-locally-solved': {
      if (argv.length < 4) {
        console.error(`Error: ${subcommand} requires <commentId> <commitSha> "<description>"`);
        printUsage();
        process.exit(2);
      }
      if (subcommand === '--solve-comment') {
        console.error(DEPRECATION_SOLVE_MSG);
      }
      handleSolveComment(argv[1], argv[2], argv[3]);
      break;
    }

    case '--skip-comment':
    case '--mark-locally-skipped': {
      if (argv.length < 3) {
        console.error(`Error: ${subcommand} requires <commentId> "<reason>"`);
        printUsage();
        process.exit(2);
      }
      if (subcommand === '--skip-comment') {
        console.error(DEPRECATION_SKIP_MSG);
      }
      handleSkipComment(argv[1], argv[2]);
      break;
    }

    case '--status':
      handleStatus();
      break;

    default:
      console.error(`Error: Unknown subcommand: ${subcommand}`);
      printUsage();
      process.exit(2);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  solveLocally,
  skipLocally,
  classifyOutdatedCopilotThread,
  isCopilotAuthor,
  handleSnapshot,
};
