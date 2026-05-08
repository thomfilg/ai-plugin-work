#!/usr/bin/env node
/**
 * follow-up-pr-comments.js
 *
 * Sequential PR comment resolution CLI. Provides subcommands to snapshot
 * PR comments, iterate them one-at-a-time by priority, and build
 * review-accountability.json incrementally.
 *
 * Subcommands:
 *   --snapshot --pr <N>                     Fetch & cache all PR comments
 *   --next-comment                          Return first unsolved comment
 *   --solve-comment <id> <sha> "<desc>"     Mark comment solved
 *   --skip-comment <id> "<reason>"          Mark comment skipped
 *   --status                                Show summary counts
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

    // Fetch resolved thread IDs to exclude
    // getResolvedCommentIds returns { resolved: Set, outdatedThreadIds: Set }
    const resolvedResult = getResolvedCommentIds(repo, prNumber);
    const resolvedIds = resolvedResult?.resolved || new Set();

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
          status: 'unsolved',
          commitSha: null,
          resolution: null,
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
            comments.push({
              id: cm.id,
              hash: computeCommentHash(filePath, body),
              author,
              body,
              path: filePath,
              line: cm.line || cm.original_line || null,
              original_line: cm.original_line || null,
              priority: classifyCommentPriority(author, body),
              status: 'resolved',
              commitSha: null,
              resolution: 'Outdated (code changed since comment)',
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
            status: isResolved ? 'resolved' : 'unsolved',
            commitSha: null,
            resolution: isResolved ? 'Resolved/outdated thread' : null,
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

  const state = loadState();
  if (!state) {
    console.error('Error: No snapshot found. Run --snapshot --pr <N> first.');
    process.exit(1);
  }

  const comment = state.comments.find((c) => String(c.id) === String(commentId));
  if (!comment) {
    console.error(`Error: Comment ID ${commentId} not found in snapshot.`);
    process.exit(1);
  }

  comment.status = 'solved';
  comment.commitSha = commitSha;
  comment.resolution = description;

  saveState(state);
  rebuildAccountability(state);

  console.log(JSON.stringify({ solved: commentId, commitSha }));
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

  const state = loadState();
  if (!state) {
    console.error('Error: No snapshot found. Run --snapshot --pr <N> first.');
    process.exit(1);
  }

  const comment = state.comments.find((c) => String(c.id) === String(commentId));
  if (!comment) {
    console.error(`Error: Comment ID ${commentId} not found in snapshot.`);
    process.exit(1);
  }

  comment.status = 'skipped';
  comment.resolution = reason;

  saveState(state);
  rebuildAccountability(state);

  console.log(JSON.stringify({ skipped: commentId }));
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
  --snapshot --pr <N>                     Fetch & cache all PR comments
  --next-comment                          Return first unsolved comment by priority
  --solve-comment <id> <sha> "<desc>"     Mark comment as solved
  --skip-comment <id> "<reason>"          Mark comment as skipped
  --status                                Show summary counts`);
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

    case '--solve-comment': {
      if (argv.length < 4) {
        console.error('Error: --solve-comment requires <commentId> <commitSha> "<description>"');
        printUsage();
        process.exit(2);
      }
      handleSolveComment(argv[1], argv[2], argv[3]);
      break;
    }

    case '--skip-comment': {
      if (argv.length < 3) {
        console.error('Error: --skip-comment requires <commentId> "<reason>"');
        printUsage();
        process.exit(2);
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

main();
