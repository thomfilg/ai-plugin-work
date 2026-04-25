#!/usr/bin/env node
/**
 * follow-up-pr.js — CI & Review Monitor
 *
 * Polls PR CI checks and reviews in a loop, reports failures fast,
 * and persists state across runs.
 *
 * Usage:
 *   node scripts/follow-up-pr.js              # auto-detect PR, loop mode
 *   node scripts/follow-up-pr.js --pr 25      # specify PR
 *   node scripts/follow-up-pr.js --once       # single check, no loop
 *   node scripts/follow-up-pr.js --no-reviews # skip review polling
 *
 * Exit codes:
 *   0 — all CI passes, no actionable reviews, no conflicts
 *   1 — failures remain (CI failed, actionable reviews, or conflicts)
 *   2 — error (no PR found, gh CLI failed, etc.)
 */

const { execSync, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Colors ──────────────────────────────────────────────────────────────────

const isColorEnabled = process.stdout.isTTY === true && !process.env.NO_COLOR;
const c = {
  red: (s) => (isColorEnabled ? `\x1b[31m${s}\x1b[0m` : s),
  green: (s) => (isColorEnabled ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s) => (isColorEnabled ? `\x1b[33m${s}\x1b[0m` : s),
  cyan: (s) => (isColorEnabled ? `\x1b[36m${s}\x1b[0m` : s),
  bold: (s) => (isColorEnabled ? `\x1b[1m${s}\x1b[0m` : s),
  dim: (s) => (isColorEnabled ? `\x1b[2m${s}\x1b[0m` : s),
};

// ── CLI Argument Parsing ────────────────────────────────────────────────────

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    pr: null,
    maxAttempts: 40,
    interval: null, // null = adaptive (auto); set explicitly via --interval to override
    once: false,
    noReviews: false,
  };

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--pr':
        args.pr = parseInt(argv[++i], 10);
        if (isNaN(args.pr)) {
          console.error('Error: --pr requires a number');
          process.exit(2);
        }
        break;
      case '--max-attempts':
        args.maxAttempts = parseInt(argv[++i], 10);
        if (isNaN(args.maxAttempts) || args.maxAttempts < 1) {
          console.error('Error: --max-attempts requires a positive number');
          process.exit(2);
        }
        break;
      case '--interval':
        args.interval = parseInt(argv[++i], 10);
        if (isNaN(args.interval) || args.interval < 1) {
          console.error('Error: --interval requires a positive number (seconds)');
          process.exit(2);
        }
        break;
      case '--once':
        args.once = true;
        break;
      case '--no-reviews':
        // REMOVED: --no-reviews flag disabled. Reviews must always be checked.
        // args.noReviews = true;
        break;
      case '--help':
      case '-h':
        console.log(`Usage: node scripts/follow-up-pr.js [options]

Options:
  --pr <number>         PR number (default: auto-detect from branch)
  --max-attempts <n>    Max polling attempts (default: 40)
  --interval <seconds>  Fixed wait between attempts (default: adaptive)
  --once                Single check, no loop (for manual debugging only)
  --no-reviews          (disabled — reviews are always checked)
  -h, --help            Show this help`);
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${argv[i]}`);
        process.exit(2);
    }
  }

  return args;
}

// ── gh CLI Wrapper ──────────────────────────────────────────────────────────

function ghExec(ghArgs, { json = true, allowNonZero = false } = {}) {
  const args = typeof ghArgs === 'string' ? ghArgs.split(/\s+/) : ghArgs;
  try {
    const result = execFileSync('gh', args, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
    });
    return json ? JSON.parse(result) : result.trim();
  } catch (err) {
    if (allowNonZero && err.stdout) {
      const stdout = err.stdout.toString().trim();
      if (json && stdout) {
        try {
          return JSON.parse(stdout);
        } catch {
          /* fall through */
        }
      }
      if (!json && stdout) return stdout;
    }
    const stderr = err.stderr ? err.stderr.toString().trim() : '';
    throw new Error(`gh command failed: gh ${args.join(' ')}\n${stderr}`);
  }
}

// ── PR Info ─────────────────────────────────────────────────────────────────

function getPRInfo(prNumber) {
  const prArg = prNumber ? `${prNumber}` : '';
  const fields = 'number,title,url,headRefName,mergeable,mergeStateStatus,state';
  const data = ghExec(`pr view ${prArg} --json ${fields}`);
  return {
    number: data.number,
    title: data.title,
    url: data.url,
    branch: data.headRefName,
    mergeable: data.mergeable,
    mergeStateStatus: data.mergeStateStatus,
    state: data.state,
  };
}

// ── CI Check Categorization ─────────────────────────────────────────────────

const CHECK_CATEGORIES = [
  { name: 'lint', pattern: /lint|eslint|prettier|format/i },
  { name: 'types', pattern: /typecheck|typescript|tsc|type.?error/i },
  { name: 'tests', pattern: /test|vitest|jest|mocha/i },
  { name: 'coverage', pattern: /coverage|vitest-coverage/i },
  { name: 'build', pattern: /build|compile|bundle|webpack|vite/i },
  { name: 'security', pattern: /gitguardian|security|snyk|dependabot/i },
  { name: 'workflow', pattern: /workflow|action/i },
];

function categorizeCheck(checkName) {
  for (const cat of CHECK_CATEGORIES) {
    if (cat.pattern.test(checkName)) return cat.name;
  }
  return 'unknown';
}

// ── CI Status ───────────────────────────────────────────────────────────────

function checkCI(prNumber) {
  const prArg = prNumber ? `${prNumber}` : '';
  // gh pr checks --json fields: bucket, completedAt, description, event, link, name, startedAt, state, workflow
  // bucket: pass | fail | pending | skipping | cancel
  let raw;
  let usedFallback = false;
  try {
    raw = ghExec(`pr checks ${prArg} --json name,bucket,state,link,workflow`, {
      allowNonZero: true,
    });
  } catch (err) {
    // gh pr checks exits 1 when checks fail, exit 8 when pending
    // Try to extract JSON from stderr/stdout
    if (err.message) {
      // Fallback: use pr view --json statusCheckRollup
      try {
        usedFallback = true;
        const data = ghExec(`pr view ${prArg} --json statusCheckRollup`);
        raw = (data.statusCheckRollup || []).map((check) => {
          let bucket;
          if (check.status !== 'COMPLETED') {
            bucket = 'pending';
          } else {
            switch (check.conclusion) {
              case 'SUCCESS':
                bucket = 'pass';
                break;
              case 'NEUTRAL':
                bucket = 'neutral';
                break;
              case 'FAILURE':
              case 'TIMED_OUT':
              case 'ACTION_REQUIRED':
              case 'STALE':
                bucket = 'fail';
                break;
              case 'SKIPPED':
                bucket = 'skipping';
                break;
              case 'CANCELLED':
                bucket = 'cancel';
                break;
              default:
                bucket = 'fail';
                break;
            }
          }
          return {
            name: check.name || check.context || 'unknown',
            bucket,
            state: check.status || '',
            link: check.detailsUrl || check.targetUrl || null,
          };
        });
      } catch {
        throw err;
      }
    } else {
      throw err;
    }
  }

  if (!Array.isArray(raw)) raw = [];

  // Enrich with conclusion data from statusCheckRollup to detect NEUTRAL checks
  // (gh pr checks --json maps NEUTRAL to 'pass' bucket, losing the distinction)
  // Skip when fallback path already handles NEUTRAL correctly
  let neutralNames = new Set();
  if (!usedFallback)
    try {
      const rollup = ghExec(`pr view ${prArg} --json statusCheckRollup`);
      if (rollup && rollup.statusCheckRollup) {
        for (const check of rollup.statusCheckRollup) {
          if (check.conclusion === 'NEUTRAL') {
            neutralNames.add(check.name || check.context || '');
          }
        }
      }
    } catch {
      // If rollup fetch fails, proceed without neutral detection
    }

  const checks = raw.map((check) => {
    let bucket = (check.bucket || 'pending').toLowerCase();
    // Reclassify pass → neutral if statusCheckRollup says NEUTRAL
    if (bucket === 'pass' && neutralNames.has(check.name || 'unknown')) {
      bucket = 'neutral';
    }
    return {
      name: check.name || 'unknown',
      bucket,
      state: check.state || '',
      category: categorizeCheck(check.name || ''),
      url: check.link || null,
    };
  });

  const failed = checks.filter((ck) => ck.bucket === 'fail');
  const running = checks.filter((ck) => ck.bucket === 'pending');
  const passed = checks.filter((ck) => ck.bucket === 'pass' || ck.bucket === 'skipping');
  const neutral = checks.filter((ck) => ck.bucket === 'neutral');
  const cancelled = checks.filter((ck) => ck.bucket === 'cancel');

  let status;
  if (failed.length > 0) status = 'failing';
  else if (running.length > 0) status = 'pending';
  else if (checks.length === 0) status = 'no-checks';
  else if (cancelled.length > 0) status = 'cancelled';
  else status = 'passing';

  return { status, checks, failed, running, passed, neutral, cancelled, total: checks.length };
}

// ── Reviews ─────────────────────────────────────────────────────────────────

// Aliases for each bot are in botLoginAliases (see getReviews)
const DEFAULT_BOT_REVIEWERS =
  'copilot-pull-request-reviewer,cursor-ai[bot],chatgpt-codex-connector[bot]';

function getBotReviewers() {
  const env = process.env.FOLLOW_UP_PR_BOT_REVIEWERS;
  const raw = env !== undefined ? env : DEFAULT_BOT_REVIEWERS;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Determine whether an author login belongs to a known bot reviewer.
 * Uses case-insensitive matching against configured bot reviewers,
 * hardcoded aliases (copilot, cursor-ai[bot]), and fuzzy [bot]-stripping.
 *
 * @param {string} author - GitHub login
 * @param {string[]} [botReviewers] - optional pre-fetched list (defaults to getBotReviewers())
 * @returns {boolean}
 */
function isBotAuthorLogin(author, botReviewers) {
  const reviewers = (botReviewers || getBotReviewers()).map((b) => b.toLowerCase());
  const lower = (author || '').toLowerCase();
  // Exact match against configured bot reviewers (case-insensitive)
  if (reviewers.includes(lower)) return true;
  // Match known aliases used by classifyCommentPriority
  if (lower === 'copilot' || lower === 'cursor-ai[bot]') return true;
  // Fuzzy match: strip [bot] suffix from configured names
  return reviewers.some((bot) => bot.includes('[bot]') && lower === bot.replace('[bot]', ''));
}

// ── Bot Comment Deduplication ────────────────────────────────────────────────
//
// After a force-push (rebase), bot reviewers (Copilot, Cursor) re-review
// the entire PR and post brand-new comments with current commit SHAs.
// Without dedup, these re-posted comments are treated as fresh blocking
// reviews — causing an infinite fix loop.
//
// We track addressed bot comments by content hash (body + file path).
// On subsequent runs, if a bot comment matches a previously-addressed one,
// it is moved from blocking to nonBlocking instead of blocking the PR.

/**
 * Compute a stable fingerprint for a review comment based on its file path
 * and body text. Used to detect re-posted bot comments after force-push.
 */
function computeCommentHash(filePath, body) {
  const normalizedPath = (filePath || '').trim();
  const normalizedBody = (body || '').trim();
  // Hash is path + body only. Line numbers are NOT included because
  // they shift after force-push, which would break dedup matching.
  return crypto
    .createHash('sha256')
    .update(`${normalizedPath}\0${normalizedBody}`)
    .digest('hex')
    .slice(0, 16); // 16 hex chars = 64 bits — sufficient for dedup
}

/**
 * Move previously-seen bot comments from blocking to nonBlocking.
 * Single-generation dedup: only hashes from the immediately previous run
 * are candidates. Human comments are NEVER deduplicated.
 *
 * @param {Array} blocking - current blocking items
 * @param {Array} nonBlocking - current non-blocking items
 * @param {string[]} previousRunBotHashes - hash strings from previous run
 * @returns {{ blocking: Array, nonBlocking: Array }}
 */
function deduplicateBlockingBotComments(
  blocking,
  nonBlocking,
  previousRunBotHashes,
  { currentHead = null } = {}
) {
  if (!previousRunBotHashes || previousRunBotHashes.length === 0) {
    return { blocking, nonBlocking };
  }

  const addressedHashes = new Set(previousRunBotHashes);
  const botReviewers = getBotReviewers();

  const stillBlocking = [];
  const movedToNonBlocking = [];

  for (const item of blocking) {
    if (!isBotAuthorLogin(item.author, botReviewers)) {
      // Human comments are NEVER deduplicated
      stillBlocking.push(item);
      continue;
    }
    // Review-level items (CHANGES_REQUESTED, COMMENTED) lack a path.
    // Skip dedup for these — body-only hashes risk false matches.
    if (!item.path) {
      stillBlocking.push(item);
      continue;
    }
    // Fresh reviews against current HEAD are NOT deduped — they are new
    // reviews posted against the code we just pushed, not stale re-posts.
    if (currentHead && item.commit_id === currentHead) {
      stillBlocking.push(item);
      continue;
    }
    const hash = computeCommentHash(item.path, item.body);
    if (addressedHashes.has(hash)) {
      movedToNonBlocking.push({ ...item, deduplicated: true });
    } else {
      stillBlocking.push(item);
    }
  }

  console.log(
    c.dim(
      `  Dedup: ${movedToNonBlocking.length} re-posted bot comment(s) moved to non-blocking, ${stillBlocking.length} kept blocking`
    )
  );

  return {
    blocking: stillBlocking,
    nonBlocking: [...nonBlocking, ...movedToNonBlocking],
  };
}

/**
 * Get file paths changed between two commits.
 * @param {string|null} fromRef - base commit SHA
 * @param {string} toRef - head commit SHA
 * @returns {Set<string>|null} set of changed file paths, or null on error
 */
function getChangedPaths(fromRef, toRef) {
  if (!fromRef || !toRef) return null;
  // Validate refs as hex SHAs to prevent command injection from state file
  const shaPattern = /^[0-9a-f]{7,40}$/i;
  if (!shaPattern.test(fromRef) || !shaPattern.test(toRef)) return null;
  try {
    const output = execSync(`git diff --name-only ${fromRef}..${toRef}`, { encoding: 'utf8' });
    const paths = output.trim().split('\n').filter(Boolean);
    return new Set(paths);
  } catch {
    return null;
  }
}

// ── Review Priority Classification ──────────────────────────────────────────
//
// Priority levels: 'high' | 'medium' | 'low'
// Blocking = high or medium (requires agent to fix before PR is ready)
// Non-blocking = low (nitpicks, suggestions — shown but don't block)
//
// Cursor (cursor-ai[bot]):  uses **severity**: <level> in comment body
//   high/critical/major → high (blocking)
//   medium/moderate     → medium (blocking)
//   minor/low/nitpick/trivial/suggestion → low (non-blocking)
//
// Copilot (copilot-pull-request-reviewer): uses [nitpick] tag
//   [nitpick] present  → low (non-blocking)
//   no tag             → medium (blocking)
//
// Human reviewers: always high (blocking)

/**
 * Read a few lines of code context around a specific line number.
 * Returns formatted string with line numbers, or null if file can't be read.
 * @param {string} filePath — relative file path from repo root
 * @param {number} line — 1-based line number
 * @param {number} [contextLines=3] — lines to show before and after
 * @returns {string|null}
 */
// In-memory cache for file contents (avoids re-reading the same file for multiple comments)
const _fileCache = new Map();

function getCodeContext(filePath, line, contextLines = 3) {
  try {
    // Reject absolute paths and path traversal
    if (path.isAbsolute(filePath) || filePath.includes('..')) return null;

    // Resolve relative to repo root (cwd) and verify it stays inside
    const resolved = path.resolve(filePath);
    const cwd = process.cwd();
    if (!resolved.startsWith(cwd + path.sep) && resolved !== cwd) return null;

    let content = _fileCache.get(resolved);
    if (content === undefined) {
      content = fs.readFileSync(resolved, 'utf8');
      _fileCache.set(resolved, content);
    }
    const lines = content.split(/\r?\n/);
    const start = Math.max(0, line - 1 - contextLines);
    const end = Math.min(lines.length, line + contextLines);
    const result = [];
    for (let i = start; i < end; i++) {
      const lineNum = i + 1;
      const marker = lineNum === line ? '>>>' : '   ';
      result.push(`${marker} ${String(lineNum).padStart(4)}: ${lines[i]}`);
    }
    return result.join('\n');
  } catch {
    return null;
  }
}

function classifyCommentPriority(author, body) {
  const lower = (body || '').toLowerCase();

  // Copilot: [severity] tags at the START of the comment body (from copilot-instructions.md)
  // IMPORTANT: Only match tags at the beginning to avoid false matches from tag mentions in body text
  if (author === 'copilot-pull-request-reviewer' || author === 'Copilot') {
    const tagMatch = (body || '').match(/^\s*\[(\w+)\]/i);
    if (tagMatch) {
      const tag = tagMatch[1].toLowerCase();
      if (tag === 'nitpick' || tag === 'low') return 'low';
      if (tag === 'critical' || tag === 'high') return 'high';
      if (tag === 'medium') return 'medium';
    }
    // No recognized severity tag at start of comment — default to medium (blocking)
    return 'medium';
  }

  // Cursor: parse **severity**: <level> pattern (can appear anywhere in body, unlike Copilot tags)
  if (author === 'cursor-ai[bot]') {
    const severityMatch = lower.match(
      /\*{0,2}severity\*{0,2}\s*[:：]\s*(critical|high|major|medium|moderate|minor|low|nitpick|trivial|suggestion)/
    );
    if (severityMatch) {
      const level = severityMatch[1];
      if (['critical', 'high', 'major'].includes(level)) return 'high';
      if (['medium', 'moderate'].includes(level)) return 'medium';
      return 'low'; // minor, low, nitpick, trivial, suggestion
    }
    // No severity marker found — default to medium (blocking)
    return 'medium';
  }

  // Codex (chatgpt-codex-connector[bot]): parse P-level badges
  if (author === 'chatgpt-codex-connector[bot]' || author === 'chatgpt-codex-connector') {
    const badgeMatch = (body || '').match(/!\[P(\d+)/);
    if (badgeMatch) {
      const level = parseInt(badgeMatch[1], 10);
      if (level <= 1) return 'high';
      if (level <= 2) return 'medium';
      return 'low';
    }
    // No P-badge: default to low (non-blocking). Codex header/announcement comments
    // and unbadged inline suggestions are treated as non-blocking.
    // Inline comments WITH P-badges are classified by badge level.
    return 'low';
  }

  // Human reviewers: always blocking
  return 'high';
}

function isBlockingPriority(priority) {
  return priority === 'high' || priority === 'medium';
}

function getResolvedCommentIds(repo, prNumber, execFn = ghExec) {
  const resolved = new Set();
  const outdatedThreadIds = []; // thread IDs that are outdated but not yet resolved
  try {
    const [owner, name] = repo.split('/');
    const query = `query($owner:String!,$name:String!,$pr:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$pr){reviewThreads(first:100,after:$cursor){pageInfo{hasNextPage endCursor}nodes{id isResolved isOutdated comments(first:100){totalCount nodes{databaseId}}}}}}}`;
    let cursor = null;
    do {
      const args = [
        'api',
        'graphql',
        '-f',
        `query=${query}`,
        '-f',
        `owner=${owner}`,
        '-f',
        `name=${name}`,
        '-F',
        `pr=${prNumber}`,
      ];
      if (cursor) {
        args.push('-f', `cursor=${cursor}`);
      }
      const graphqlResult = execFn(args);
      const hasErrors = graphqlResult?.errors?.length > 0;
      const hasData = Boolean(graphqlResult?.data);
      if (hasErrors && !hasData) {
        throw new Error(graphqlResult.errors[0].message || 'GraphQL error');
      }
      if (hasErrors && hasData) {
        console.error(
          c.dim(
            `  ⚠ GraphQL partial error: ${graphqlResult.errors[0].message || 'unknown'} — continuing with available data`
          )
        );
      }
      const threadData = graphqlResult?.data?.repository?.pullRequest?.reviewThreads;
      const threads = threadData?.nodes || [];
      for (const thread of threads) {
        if (thread.isResolved || thread.isOutdated) {
          const comments = thread.comments || {};
          const nodes = comments.nodes || [];
          for (const comment of nodes) {
            if (comment?.databaseId) resolved.add(comment.databaseId);
          }
          if (comments.totalCount > nodes.length) {
            console.error(
              c.dim(
                `  ⚠ Resolved thread has ${comments.totalCount} comments (fetched ${nodes.length}) — some may not be filtered`
              )
            );
          }
          // Track outdated-but-not-resolved threads for optional dismissal
          if (thread.isOutdated && !thread.isResolved && thread.id) {
            outdatedThreadIds.push(thread.id);
          }
        }
      }
      const pageInfo = threadData?.pageInfo;
      cursor = pageInfo?.hasNextPage ? pageInfo.endCursor : null;
    } while (cursor);
  } catch (err) {
    console.error(
      c.dim(
        `  ⚠ GraphQL thread query failed: ${err.message || 'unknown'} — falling back to REST-only filtering`
      )
    );
    resolved.clear();
    outdatedThreadIds.length = 0;
  }
  return { resolved, outdatedThreadIds };
}

/**
 * Resolve outdated review threads on GitHub via GraphQL mutation.
 * Only called when ENABLE_RESOLVE_OUTDATED_COMMENTS=true.
 */
function resolveOutdatedThreads(threadIds, execFn = ghExec) {
  let dismissed = 0;
  for (const threadId of threadIds) {
    try {
      const mutation = `mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{isResolved}}}`;
      execFn(['api', 'graphql', '-f', `query=${mutation}`, '-f', `threadId=${threadId}`]);
      dismissed++;
    } catch (err) {
      console.error(c.dim(`  ⚠ Failed to resolve thread ${threadId}: ${err.message || 'unknown'}`));
    }
  }
  if (dismissed > 0) {
    console.error(c.dim(`  ✓ Resolved ${dismissed} outdated review thread(s)`));
  }
  return dismissed;
}

function getReviews(prNumber) {
  const prArg = prNumber ? `${prNumber}` : '';
  const data = ghExec(`pr view ${prArg} --json reviews,statusCheckRollup`);
  const reviews = (data.reviews || []).map((r) => ({
    id: r.id,
    author: r.author?.login || 'unknown',
    state: r.state, // APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED, PENDING
    body: (r.body || '').trim(),
    submittedAt: r.submittedAt,
  }));

  // Get review comments (inline comments) with pagination
  let comments = [];
  let branchCommits = new Set();
  try {
    const repoData = ghExec('repo view --json nameWithOwner');
    const repo = repoData.nameWithOwner;

    // Get current branch commit SHAs to detect stale comments from force-pushes
    try {
      const prData = ghExec(['pr', 'view', String(prNumber), '--json', 'commits']);
      if (prData.commits) {
        for (const commit of prData.commits) branchCommits.add(commit.oid);
      }
    } catch (err) {
      console.error(c.dim(`  (could not fetch branch commits: ${err.message?.slice(0, 80)})`));
    }

    // Get resolved/outdated thread comment IDs via GraphQL
    // REST API doesn't expose thread resolution status
    const { resolved: resolvedCommentIds, outdatedThreadIds } = getResolvedCommentIds(
      repo,
      prNumber
    );

    // Optionally resolve outdated threads on GitHub
    if (process.env.ENABLE_RESOLVE_OUTDATED_COMMENTS === 'true' && outdatedThreadIds.length > 0) {
      resolveOutdatedThreads(outdatedThreadIds);
    }

    const isVisibleComment = (cm) => {
      // Only filter resolved/dismissed comments.
      // All other comments visible on the PR are included.
      if (resolvedCommentIds.has(cm.id)) return false;
      return true;
    };

    const perPage = 100;
    let page = 1;
    while (true) {
      const pageData = ghExec([
        'api',
        `repos/${repo}/pulls/${prNumber}/comments?per_page=${perPage}&page=${page}`,
      ]);
      if (!Array.isArray(pageData) || pageData.length === 0) break;
      const visibleComments = pageData.filter(isVisibleComment);
      comments.push(
        ...visibleComments.map((cm) => ({
          id: cm.id,
          author: cm.user?.login || 'unknown',
          body: (cm.body || '').trim(),
          path: cm.path || null,
          line: cm.line || null,
          original_line: cm.original_line || null,
          commit_id: cm.commit_id || null,
          state: 'COMMENTED',
        }))
      );
      if (pageData.length < perPage) break;
      page++;
    }
  } catch {
    // Non-critical — inline comments are supplementary
  }

  // Detect pending bot reviews via GitHub REST API (requested_reviewers)
  // gh pr view --json reviewRequests doesn't reliably include bots,
  // so we use the REST API which correctly lists pending bot reviewers.
  const botReviewers = getBotReviewers();
  let pendingBots = [];
  try {
    const repoInfo = ghExec('repo view --json nameWithOwner');
    const repo = repoInfo.nameWithOwner;
    const requested = ghExec(['api', `repos/${repo}/pulls/${prNumber}/requested_reviewers`]);
    const requestedLogins = (requested.users || []).map((u) => u.login.toLowerCase());
    // Map known bot display names to their reviewer login names
    const botLoginAliases = {
      'copilot-pull-request-reviewer': ['copilot', 'copilot-pull-request-reviewer'],
      'cursor-ai[bot]': ['cursor-ai[bot]', 'cursor-ai'],
      'chatgpt-codex-connector[bot]': ['chatgpt-codex-connector'],
      'chatgpt-codex-connector': ['chatgpt-codex-connector[bot]'],
    };
    for (const bot of botReviewers) {
      const aliases = botLoginAliases[bot] || [bot.toLowerCase()];
      const isPending = requestedLogins.some((login) =>
        aliases.some((alias) => login === alias || login.includes(alias))
      );
      if (isPending) {
        pendingBots.push(bot);
      }
    }
  } catch {
    // Fallback: use the old heuristic (CI still running + bot hasn't reviewed)
    const reviewedByBots = new Set(reviews.map((r) => r.author));
    const checksRunning = (data.statusCheckRollup || []).some((ck) => ck.status !== 'COMPLETED');
    for (const bot of botReviewers) {
      if (!reviewedByBots.has(bot) && checksRunning) {
        pendingBots.push(bot);
      }
    }
  }

  // Actionable reviews:
  // - CHANGES_REQUESTED: always actionable (human or bot)
  // - COMMENTED with body: actionable for humans, but bot COMMENTED reviews
  //   are typically informational summaries (not action items) — skip them.
  // - Also detect bot reviews by HTML comment markers (e.g. <!-- BUGBOT_REVIEW -->)
  // Bot author detection: match configured bot reviewers (case-insensitive) and
  // known bot login variants used by classifyCommentPriority (Copilot, cursor-ai[bot]).
  const botReviewersLower = botReviewers.map((b) => b.toLowerCase());
  const BOT_BODY_MARKERS = /<!--\s*(BUGBOT_REVIEW|COPILOT_REVIEW)\s*-->/;
  const isBotReview = (r) =>
    isBotAuthorLogin(r.author, botReviewersLower) || BOT_BODY_MARKERS.test(r.body || '');
  const isActionableReview = (r) =>
    r.state === 'CHANGES_REQUESTED' || (r.state === 'COMMENTED' && r.body && !isBotReview(r));
  const actionable = reviews.filter(isActionableReview).map((r) => {
    const priority = classifyCommentPriority(r.author, r.body);
    // CHANGES_REQUESTED is always at least medium (blocking), regardless of severity tags
    const effectivePriority =
      r.state === 'CHANGES_REQUESTED' && priority === 'low' ? 'medium' : priority;
    return { ...r, priority: effectivePriority };
  });

  // Classify inline comments by priority
  const classifiedComments = comments.map((cm) => ({
    ...cm,
    priority: classifyCommentPriority(cm.author, cm.body),
  }));

  // Mark stale comments as non-blocking
  for (const item of [...actionable, ...classifiedComments]) {
    const isOutdated = item.line === null && item.original_line != null;
    const isOldCommit =
      branchCommits.size > 0 && item.commit_id && !branchCommits.has(item.commit_id);
    if (isOutdated || isOldCommit) {
      item.priority = 'low';
      item.stale = true;
    }
  }

  // Split into blocking (medium/high) and non-blocking (low/nitpick)
  const allItems = [...actionable, ...classifiedComments];
  let blocking = allItems.filter((item) => isBlockingPriority(item.priority));
  let nonBlocking = allItems.filter((item) => !isBlockingPriority(item.priority));

  return {
    all: reviews,
    comments: classifiedComments,
    actionable,
    blocking,
    nonBlocking,
    pendingBots,
    hasBlocking: blocking.length > 0,
    hasActionable: actionable.length > 0 || classifiedComments.length > 0,
  };
}

// ── State Persistence ───────────────────────────────────────────────────────

function getRepoSlug() {
  try {
    const result = execFileSync(
      'gh',
      ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
      {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      }
    ).trim();
    return result.replace(/[^\w.-]/g, '_');
  } catch {
    return 'local';
  }
}

function stateFilePath(prNumber) {
  return path.join(os.tmpdir(), '.claude', `follow-up-pr-${getRepoSlug()}-${prNumber}.json`);
}

function loadState(prNumber) {
  const filePath = stateFilePath(prNumber);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function saveState(state) {
  const filePath = stateFilePath(state.prNumber);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2) + '\n');
}

function initState(prInfo) {
  // Schema for state file at stateFilePath(prInfo.number)
  return {
    prNumber: prInfo.number,
    prUrl: prInfo.url,
    branch: prInfo.branch,
    startTime: new Date().toISOString(),
    attempts: [],
    finalStatus: null,
    previousRunBotHashes: [],
    headAtLastExit: null,
  };
}

// ── Report Formatting ───────────────────────────────────────────────────────

function formatNonBlockingItems(items, lines) {
  for (const item of items) {
    const loc = item.path ? ` ${c.dim(item.path + (item.line ? ':' + item.line : ''))}` : '';
    const priorityTag = item.deduplicated
      ? `[${(item.priority || 'low').toUpperCase()}→DEDUPED]`
      : '[LOW]';
    lines.push(`  ${c.dim('○')} ${c.cyan('@' + item.author)} ${c.dim(priorityTag)}${loc}`);
    if (item.body) {
      const normalized = item.body.replace(/\s+/g, ' ');
      const preview = normalized.length > 80 ? normalized.slice(0, 77) + '...' : normalized;
      lines.push(`    ${c.dim('"' + preview + '"')}`);
    }
  }
}

function formatReport(prInfo, ci, reviews, attempt, maxAttempts, opts) {
  const lines = [];

  lines.push(c.bold('=== Follow-up PR Monitor ==='));
  lines.push(`PR: ${c.cyan('#' + prInfo.number)} — ${prInfo.title}`);
  lines.push(`Branch: ${c.dim(prInfo.branch)} | Attempt: ${attempt}/${maxAttempts}`);
  lines.push('');

  // CI status
  if (ci.status === 'failing') {
    const failFastNote =
      ci.running.length > 0 ? ' (fail-fast — not waiting for remaining checks)' : '';
    lines.push(c.red(`CI: FAILING${failFastNote}`));
    for (const ck of ci.failed) {
      lines.push(`  ${c.red('✗')} ${ck.name} ${c.dim(`[${ck.category}]`)} — FAILED`);
    }
    for (const ck of ci.running) {
      lines.push(`  ${c.yellow('⏳')} ${ck.name} — running`);
    }
    for (const ck of ci.passed) {
      lines.push(`  ${c.green('✓')} ${ck.name} — passed`);
    }
    for (const ck of ci.neutral) {
      lines.push(`  ${c.dim('○')} ${ck.name} — neutral`);
    }

    // Coverage special case
    const hasCoverageFailure = ci.failed.some((ck) => ck.category === 'coverage');
    if (hasCoverageFailure) {
      lines.push('');
      lines.push(c.yellow('⚠ COVERAGE FAILURE: Run /test-coordination before pushing'));
      try {
        const getTicketId = require('../../lib/scripts/get-ticket-id.js');
        const ticketId = getTicketId.getCurrentTaskId();
        if (ticketId) {
          lines.push(`→ Skill(test-coordination): ${ticketId}`);
        }
      } catch {
        // get-ticket-id not available, skip
      }
    }
  } else if (ci.status === 'pending') {
    lines.push(c.yellow(`CI: PENDING (${ci.running.length} running, ${ci.passed.length} passed)`));
    for (const ck of ci.running) {
      lines.push(`  ${c.yellow('⏳')} ${ck.name} — running`);
    }
    for (const ck of ci.passed) {
      lines.push(`  ${c.green('✓')} ${ck.name} — passed`);
    }
    for (const ck of ci.neutral) {
      lines.push(`  ${c.dim('○')} ${ck.name} — neutral`);
    }
  } else if (ci.status === 'passing') {
    lines.push(c.green(`CI: PASSED (all ${ci.total} checks)`));
    for (const ck of ci.passed) {
      lines.push(`  ${c.green('✓')} ${ck.name} — passed`);
    }
    for (const ck of ci.neutral) {
      lines.push(`  ${c.dim('○')} ${ck.name} — neutral`);
    }
  } else if (ci.status === 'cancelled') {
    lines.push(
      c.yellow(`CI: CANCELLED (${ci.cancelled.length} cancelled, ${ci.passed.length} passed)`)
    );
    for (const ck of ci.cancelled) {
      lines.push(`  ${c.yellow('⊘')} ${ck.name} — cancelled`);
    }
    for (const ck of ci.passed) {
      lines.push(`  ${c.green('✓')} ${ck.name} — passed`);
    }
    for (const ck of ci.neutral) {
      lines.push(`  ${c.dim('○')} ${ck.name} — neutral`);
    }
  } else {
    lines.push(c.dim('CI: No checks found'));
  }

  // Merge status
  const isConflicting = prInfo.mergeable === 'CONFLICTING' || prInfo.mergeStateStatus === 'DIRTY';
  const isMergeReady =
    prInfo.mergeable === 'MERGEABLE' &&
    (!prInfo.mergeStateStatus ||
      prInfo.mergeStateStatus === 'CLEAN' ||
      prInfo.mergeStateStatus === 'HAS_HOOKS' ||
      prInfo.mergeStateStatus === 'UNSTABLE');
  if (isConflicting) {
    lines.push('');
    lines.push(c.red('CONFLICTS: Merge conflicts detected — rebase required'));
  } else if (!isMergeReady) {
    lines.push('');
    lines.push(
      c.yellow(
        `MERGE STATUS: ${prInfo.mergeable || 'UNKNOWN'} (${prInfo.mergeStateStatus || 'UNKNOWN'}) — not yet mergeable`
      )
    );
  }

  // Reviews
  if (!opts.noReviews) {
    lines.push('');
    if (reviews.pendingBots.length > 0) {
      lines.push(c.yellow('Reviews: Awaiting bot reviews'));
      for (const bot of reviews.pendingBots) {
        lines.push(`  ${c.yellow('⏳')} ${bot} — review pending`);
      }
    } else if (reviews.hasBlocking) {
      lines.push(c.red(`Reviews: ${reviews.blocking.length} BLOCKING`));
      for (const item of reviews.blocking) {
        const priorityTag = item.priority === 'high' ? c.red('[HIGH]') : c.yellow('[MEDIUM]');
        const loc = item.path ? ` ${c.dim(item.path + (item.line ? ':' + item.line : ''))}` : '';
        lines.push(`  ${c.red('✗')} ${c.cyan('@' + item.author)} ${priorityTag}${loc}`);
        if (item.body) {
          const normalized = item.body.replace(/\s+/g, ' ');
          const preview = normalized.length > 80 ? normalized.slice(0, 77) + '...' : normalized;
          lines.push(`    ${c.dim('"' + preview + '"')}`);
        }
        // Code context omitted — use follow-up-pr-comments.js --next-comment for full details
      }
      lines.push('');
      lines.push(
        c.yellow(
          '  → Use node follow-up-pr-comments.js --snapshot --pr <N> then --next-comment to process each comment ONE AT A TIME'
        )
      );
      lines.push(
        c.yellow(
          '  → SOLVE ALL COMMENTS BEFORE PUSHING. Do NOT push after each comment. Do NOT use gh api to read'
        )
      );
      lines.push(
        c.yellow(
          '    comments directly. The --next-comment loop is the ONLY way to process comments — it tracks'
        )
      );
      lines.push(
        c.yellow(
          '    state so nothing is missed or duplicated. Pushing mid-loop causes snapshot invalidation,'
        )
      );
      lines.push(
        c.yellow(
          '    line-number drift, and dedup confusion.'
        )
      );
      if (reviews.nonBlocking.length > 0) {
        lines.push(
          `  + ${reviews.nonBlocking.length} non-blocking (nitpick/low — assess whether to address):`
        );
        formatNonBlockingItems(reviews.nonBlocking, lines);
      }
    } else if (reviews.nonBlocking.length > 0) {
      lines.push(
        c.green(`Reviews: CLEAR`) +
          ` (${reviews.nonBlocking.length} non-blocking — assess whether to address):`
      );
      formatNonBlockingItems(reviews.nonBlocking, lines);
    } else {
      lines.push(c.green('Reviews: CLEAR'));
    }
  }

  // Action hint — order matches fail-fast exit priority
  lines.push('');
  const ciAcceptable = ci.status === 'passing' || ci.status === 'no-checks';
  if (ci.status === 'failing') {
    lines.push(`→ Fix the failure, push, then re-run: ${c.dim('node scripts/follow-up-pr.js')}`);
  } else if (isConflicting) {
    lines.push(`→ Resolve conflicts, push, then re-run: ${c.dim('node scripts/follow-up-pr.js')}`);
  } else if (ci.status === 'cancelled') {
    lines.push(
      `→ CI was cancelled. Re-push or re-run the workflow: ${c.dim('gh run rerun <run-id>')}`
    );
  } else if (!opts.noReviews && reviews.hasBlocking && reviews.pendingBots.length > 0) {
    const blockCount = reviews.blocking ? reviews.blocking.length : 0;
    lines.push(
      `→ Waiting ${opts.interval}s for bot reviews (${blockCount} blocking comment${blockCount !== 1 ? 's' : ''} may become stale)... (attempt ${attempt}/${maxAttempts})`
    );
  } else if (!opts.noReviews && reviews.hasBlocking) {
    lines.push(
      `→ Address blocking reviews, push, then re-run: ${c.dim('node scripts/follow-up-pr.js')}`
    );
  } else if (
    ciAcceptable &&
    (!reviews.hasBlocking || opts.noReviews) &&
    reviews.pendingBots.length === 0 &&
    isMergeReady
  ) {
    // Non-blocking comments report (before the banner)
    if (reviews.nonBlocking && reviews.nonBlocking.length > 0) {
      lines.push('');
      lines.push(c.bold('--- Non-Blocking Comments Report ---'));
      reviews.nonBlocking.forEach((item, i) => {
        const loc = item.path ? `${item.path}${item.line ? ':' + item.line : ''}` : 'N/A';
        const briefBody = (item.body || '').trim().replace(/\n/g, ' ').substring(0, 80);
        const status = item.deduplicated ? c.cyan('DEDUPED') : c.dim('NOT ADDRESSED');
        lines.push(`  Comment ${i + 1}: [${status}] @${item.author} ${loc} — ${briefBody}`);
      });
      lines.push('');
      lines.push(c.dim('---'));
    }
    lines.push('');
    lines.push(c.green('═══════════════════════════════════════'));
    lines.push(c.green('  PR READY TO REVIEW'));
    lines.push(c.green('═══════════════════════════════════════'));
    lines.push('');
    const ciLabel = ci.status === 'no-checks' ? 'NO CHECKS' : 'PASSED';
    lines.push(
      c.green(`CI: ${ciLabel} | Reviews: ${opts.noReviews ? 'SKIPPED' : 'CLEAR'} | Conflicts: NONE`)
    );
    lines.push(c.green(`PR #${prInfo.number} is ready for review/merge!`));
  } else if (ci.status === 'pending') {
    lines.push(`→ Waiting ${opts.interval}s for checks... (attempt ${attempt}/${maxAttempts})`);
  } else if (!opts.noReviews && reviews.pendingBots.length > 0) {
    lines.push(
      `→ Waiting ${opts.interval}s for bot reviews... (attempt ${attempt}/${maxAttempts})`
    );
  } else if (!isMergeReady) {
    lines.push(`→ Merge status not ready (${prInfo.mergeable || 'UNKNOWN'}). Waiting...`);
  }

  return lines.join('\n');
}

// ── Decision Logic ──────────────────────────────────────────────────────────

/**
 * Pure function that decides the next action based on current PR state.
 * Returns { action, finalStatus, waitReason? }
 *   action: 'exit-fail' | 'exit-success' | 'poll'
 *   finalStatus: string for state persistence
 *   waitReason: human-readable reason when action is 'poll'
 */
function decideNextAction(ciStatus, prInfo, reviews, noReviews) {
  const isConflicting = prInfo.mergeable === 'CONFLICTING' || prInfo.mergeStateStatus === 'DIRTY';
  const isMergeReady =
    prInfo.mergeable === 'MERGEABLE' &&
    (!prInfo.mergeStateStatus ||
      prInfo.mergeStateStatus === 'CLEAN' ||
      prInfo.mergeStateStatus === 'HAS_HOOKS' ||
      prInfo.mergeStateStatus === 'UNSTABLE');
  const ciAcceptable = ciStatus === 'passing' || ciStatus === 'no-checks';
  const ciFinished = ciAcceptable || ciStatus === 'cancelled';
  const reviewsClear = noReviews || (!reviews.hasBlocking && reviews.pendingBots.length === 0);

  // Fail-fast exits (ordered by priority)
  // Only CI failures, conflicts, and cancelled CI cause immediate exit.
  // Reviews never cause fail-fast while CI is pending — wait for CI to finish first,
  // since stale/outdated comments may be invalidated by new pushes.
  if (ciStatus === 'failing') {
    return { action: 'exit-fail', finalStatus: 'ci-failing' };
  }
  if (isConflicting) {
    return { action: 'exit-fail', finalStatus: 'conflicting' };
  }
  if (ciStatus === 'cancelled') {
    return { action: 'exit-fail', finalStatus: 'ci-cancelled' };
  }
  // Only exit on blocking reviews AFTER CI has fully completed (not pending).
  // When CI is still running, stale review comments may become outdated.
  // When bots are still reviewing, old blocking comments may become stale after the new review.
  if (!noReviews && reviews.hasBlocking && reviews.pendingBots.length === 0 && ciFinished) {
    return { action: 'exit-fail', finalStatus: 'reviews-blocking' };
  }

  // Success — CI acceptable (passing or no-checks), reviews clear, merge ready
  if (ciAcceptable && reviewsClear && isMergeReady) {
    return { action: 'exit-success', finalStatus: 'ready' };
  }

  // Still polling — build list of reasons (tested in follow-up-pr.test.js)
  const reasons = [];
  if (!ciFinished) reasons.push('CI checks pending');
  if (!noReviews && reviews.pendingBots.length > 0) reasons.push('bot reviews pending');
  if (!noReviews && reviews.hasBlocking && !ciFinished)
    reasons.push('waiting for CI to finish before evaluating reviews');
  if (!noReviews && reviews.hasBlocking && reviews.pendingBots.length > 0)
    reasons.push('blocking reviews may become stale after bot review');
  if (!isMergeReady && !isConflicting)
    reasons.push(`merge status: ${prInfo.mergeStateStatus || 'UNKNOWN'}`);

  return {
    action: 'poll',
    finalStatus: 'timeout',
    waitReason: reasons.join(', ') || 'unknown',
  };
}

// ── Adaptive Polling ────────────────────────────────────────────────────────

/**
 * Compute poll interval based on attempt number and CI completion progress.
 *
 * Strategy:
 *   - Attempt 1: 10s (quick check for obvious issues like conflicts)
 *   - Until ~80% of CI steps complete:
 *       >5 total steps → 60s polls
 *       ≤5 total steps → 30s polls
 *   - After 80% completion: 20s polls (finish line)
 *
 * Returns interval in seconds.
 */
function getAdaptiveInterval(attempt, ci) {
  // First poll: quick sanity check
  if (attempt === 1) return 10;

  const total = ci.total || 0;
  const completed =
    (ci.passed ? ci.passed.length : 0) +
    (ci.neutral ? ci.neutral.length : 0) +
    (ci.failed ? ci.failed.length : 0) +
    (ci.cancelled ? ci.cancelled.length : 0);
  const completionRatio = total > 0 ? completed / total : 0;

  // Finish line — most steps done, poll faster
  if (completionRatio >= 0.8) return 20;

  // Bulk wait — longer polls for many steps, shorter for few
  return total > 5 ? 60 : 30;
}

// ── Sleep ───────────────────────────────────────────────────────────────────

function sleep(seconds) {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();

  // Get PR info
  let prInfo;
  try {
    prInfo = getPRInfo(opts.pr);
  } catch (err) {
    console.error(c.red('Error: Could not find PR.'));
    console.error(c.dim(err.message));
    console.error('');
    console.error('Tips:');
    console.error('  • Push your branch first: git push -u origin HEAD');
    console.error('  • Create a PR first (use pr-generator agent or gh CLI)');
    console.error('  • Specify manually: node scripts/follow-up-pr.js --pr <number>');
    process.exit(2);
  }

  if (prInfo.state === 'CLOSED' || prInfo.state === 'MERGED') {
    console.log(
      c.dim(`PR #${prInfo.number} is ${prInfo.state.toLowerCase()}. Nothing to monitor.`)
    );
    process.exit(0);
  }

  // Load or init state
  let state = loadState(prInfo.number) || initState(prInfo);
  state.prUrl = prInfo.url;
  state.branch = prInfo.branch;

  // SIGINT handler — save state before exiting
  let interrupted = false;
  process.on('SIGINT', () => {
    if (interrupted) process.exit(2);
    interrupted = true;
    console.log(c.dim('\nInterrupted. Saving state...'));
    state.finalStatus = 'interrupted';
    saveState(state);
    console.log(c.dim(`State saved to ${stateFilePath(prInfo.number)}`));
    process.exit(2);
  });

  const maxAttempts = opts.once ? 1 : opts.maxAttempts;
  let ci;
  let reviews = {
    all: [],
    comments: [],
    actionable: [],
    blocking: [],
    nonBlocking: [],
    pendingBots: [],
    hasBlocking: false,
    hasActionable: false,
  };

  // Single-generation dedup: capture previous run's bot hashes (backward compat with old state files)
  const previousRunBotHashes = (
    state.previousRunBotHashes && state.previousRunBotHashes.length > 0
      ? state.previousRunBotHashes
      : (state.addressedBotComments || []).map((a) => a.hash)
  ).slice();

  // Obtain current HEAD SHA for fresh-review detection in dedup.
  // Local HEAD is correct here: the script runs locally after a push,
  // so local HEAD === the PR head SHA that bot reviewers target.
  let currentHead = null;
  try {
    currentHead = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    // Non-fatal: dedup will proceed without the currentHead guard
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Refresh PR info each attempt (mergeable status may change)
    try {
      prInfo = getPRInfo(prInfo.number);
    } catch {
      // Use cached info if refresh fails
    }

    // Check CI
    try {
      ci = checkCI(prInfo.number);
    } catch (err) {
      console.error(c.red(`Error checking CI: ${err.message}`));
      process.exit(2);
    }

    // Check reviews (unless --no-reviews)
    reviews = {
      all: [],
      comments: [],
      actionable: [],
      blocking: [],
      nonBlocking: [],
      pendingBots: [],
      hasBlocking: false,
      hasActionable: false,
    };
    if (!opts.noReviews) {
      try {
        reviews = getReviews(prInfo.number);
        // Apply single-generation dedup after fetching reviews
        if (previousRunBotHashes.length > 0) {
          const deduped = deduplicateBlockingBotComments(
            reviews.blocking,
            reviews.nonBlocking,
            previousRunBotHashes,
            { currentHead }
          );
          reviews.blocking = deduped.blocking;
          reviews.nonBlocking = deduped.nonBlocking;
          reviews.hasBlocking = reviews.blocking.length > 0;
        }
      } catch (err) {
        console.error(c.yellow(`Warning: Could not fetch reviews: ${err.message}`));
      }
    }

    // Record attempt
    state.attempts.push({
      number: attempt,
      timestamp: new Date().toISOString(),
      ciStatus: ci.status,
      failedChecks: ci.failed.map((ck) => ({ name: ck.name, category: ck.category })),
      pendingReviews: reviews.pendingBots,
      blockingReviews: reviews.blocking.map((r) => ({
        id: r.id,
        author: r.author,
        priority: r.priority,
      })),
      nonBlockingReviews: reviews.nonBlocking.length,
    });

    saveState(state);

    // Use explicit --interval if set, otherwise compute adaptive interval
    const interval = opts.interval !== null ? opts.interval : getAdaptiveInterval(attempt, ci);

    // Print report
    console.log('');
    console.log(formatReport(prInfo, ci, reviews, attempt, maxAttempts, { ...opts, interval }));
    console.log('');

    // Decide next action using extracted pure function
    const decision = decideNextAction(ci.status, prInfo, reviews, opts.noReviews);

    // Compute changed paths once for both exit-fail and exit-success branches
    // changedPaths: null = error/no-data (record all), empty Set = no changes (record all).
    // An empty Set means headAtLastExit === currentHead (re-run without push) — fall back
    // to recording all hashes so dedup still works on the next run.
    const rawChangedPaths = getChangedPaths(state.headAtLastExit || null, currentHead);
    const changedPaths = rawChangedPaths && rawChangedPaths.size === 0 ? null : rawChangedPaths;

    if (decision.action === 'exit-fail') {
      // Single-generation dedup: record current blocking bot hashes on
      // reviews-blocking exit. REPLACE (not append) to prevent accumulation.
      // Only record hashes for comments whose file was actually modified
      // (so we don't falsely promote unaddressed comments next run).
      if (decision.finalStatus === 'reviews-blocking' && reviews.hasBlocking) {
        const botReviewersForRecord = getBotReviewers();
        state.previousRunBotHashes = reviews.blocking
          .filter((item) => isBotAuthorLogin(item.author, botReviewersForRecord) && item.path)
          .filter((item) => !changedPaths || changedPaths.has(item.path))
          .map((item) => computeCommentHash(item.path, item.body));
      }
      state.headAtLastExit = currentHead;
      state.finalStatus = decision.finalStatus;
      saveState(state);

      // GH-248: Show brief comment previews (80 chars) for ALL comments on exit
      // so the agent has context. Non-blocking comments must be evaluated too.
      const allExitComments = [
        ...(reviews.blocking || []).map((item) => ({ ...item, _section: 'BLOCKING' })),
        ...(reviews.nonBlocking || []).map((item) => ({ ...item, _section: 'NON-BLOCKING' })),
      ];
      if (allExitComments.length > 0) {
        console.log('');
        console.log(c.bold('--- Brief Comment Bodies (All Reviews) ---'));
        let currentSection = '';
        allExitComments.forEach((item, i) => {
          if (item._section !== currentSection) {
            currentSection = item._section;
            console.log('');
            console.log(c.bold(`  [${currentSection}]`));
          }
          const loc = item.path ? `${item.path}${item.line ? ':' + item.line : ''}` : 'N/A';
          const priority = (item.priority || 'unknown').toUpperCase();
          const staleTag = item.stale ? c.dim(' (stale)') : '';
          const dedupTag = item.deduplicated ? c.dim(' (deduped)') : '';
          const briefBody = (item.body || '').trim().replace(/\n/g, ' ').substring(0, 80);
          console.log(
            `  ${c.cyan(`Comment ${i + 1}:`)} [${priority}] @${item.author}${staleTag}${dedupTag} ${loc} — ${briefBody}`
          );
        });
        console.log('');
      }

      process.exit(1);
    }

    if (decision.action === 'exit-success') {
      // Guard against GitHub API eventual consistency: after bot review
      // status clears, new comments may take a few seconds to appear.
      // Re-fetch reviews after a brief delay to catch late-arriving comments.
      // Skip recheck when --no-reviews (reviews aren't being polled).
      if (!opts.noReviews) {
        await sleep(10);
        let recheck;
        try {
          recheck = getReviews(prInfo.number);
          // Apply dedup to recheck results too
          if (previousRunBotHashes.length > 0) {
            const deduped = deduplicateBlockingBotComments(
              recheck.blocking,
              recheck.nonBlocking,
              previousRunBotHashes,
              { currentHead }
            );
            recheck.blocking = deduped.blocking;
            recheck.nonBlocking = deduped.nonBlocking;
            recheck.hasBlocking = recheck.blocking.length > 0;
          }
        } catch {
          // If recheck fails, proceed with exit-success — the primary check passed.
          recheck = { hasBlocking: false };
        }
        if (recheck.hasBlocking) {
          reviews = recheck;
          console.log('');
          console.log(
            formatReport(prInfo, ci, reviews, attempt, maxAttempts, { ...opts, interval })
          );
          console.log('');
          // Record blocking bot hashes for late-arriving comments
          // Only record hashes for comments on files that were actually modified.
          const recheckBotReviewers = getBotReviewers();
          state.previousRunBotHashes = recheck.blocking
            .filter((item) => isBotAuthorLogin(item.author, recheckBotReviewers) && item.path)
            .filter((item) => !changedPaths || changedPaths.has(item.path))
            .map((item) => computeCommentHash(item.path, item.body));
          state.headAtLastExit = currentHead;
          state.finalStatus = 'reviews-blocking';
          saveState(state);
          process.exit(1);
        }
      }
      // Clear hashes on success
      state.previousRunBotHashes = [];
      state.headAtLastExit = currentHead;
      state.finalStatus = decision.finalStatus;
      saveState(state);

      // Write review-accountability.json so enforce-step-workflow verify gate passes
      try {
        const getConfig = require(path.join(__dirname, '..', '..', 'lib', 'get-config'));
        const tasksBase = getConfig('TASKS_BASE');
        const getTicketId = require(
          path.join(__dirname, '..', '..', 'lib', 'scripts', 'get-ticket-id.js')
        );
        const ticketId = getTicketId.getCurrentTaskId();
        if (tasksBase && ticketId) {
          // Include inline PR comments to match strictCommentCount (GH-276)
          const inlineComments = [];
          try {
            const repo = ghExec('repo view --json nameWithOwner').nameWithOwner;
            const ids = ghExec(
              [
                'api',
                '--paginate',
                `repos/${repo}/pulls/${prInfo.number}/comments?per_page=100`,
                '--jq',
                '.[].id',
              ],
              { json: false }
            );
            const inlineIds = new Set((ids || '').split('\n').filter(Boolean));
            const existing = new Set(
              [...(reviews.blocking || []), ...(reviews.nonBlocking || [])].map((c) => String(c.id))
            );
            for (const id of inlineIds) {
              if (!existing.has(id))
                inlineComments.push({ id: Number(id) || id, author: 'inline', body: '' });
            }
          } catch (inlineErr) {
            process.stderr.write(
              `WARNING: Failed to fetch inline comment IDs: ${inlineErr.message}\n`
            );
          }
          const entries = buildAccountabilityEntries(reviews.blocking || [], [
            ...(reviews.nonBlocking || []),
            ...inlineComments,
          ]);
          let safeTicketId = ticketId;
          try {
            safeTicketId = require(path.join(__dirname, '..', '..', 'lib', 'config')).safeTicketId(
              ticketId
            );
          } catch {}
          const accountabilityPath = path.join(
            tasksBase,
            safeTicketId,
            'review-accountability.json'
          );
          fs.mkdirSync(path.dirname(accountabilityPath), { recursive: true });
          fs.writeFileSync(accountabilityPath, JSON.stringify(entries, null, 2));
        }
      } catch (err) {
        const errMsg = String(err && err.message ? err.message : err);
        process.stderr.write(
          `WARNING: Failed to write review-accountability.json: ${errMsg}\n` +
            `The follow_up → ci transition gate will block until this file exists.\n`
        );
      }

      process.exit(0);
    }

    // Continue polling with adaptive interval
    if (attempt < maxAttempts) {
      await sleep(interval);
    }
  }

  // Exhausted attempts — report what we were waiting on
  const lastDecision = decideNextAction(ci.status, prInfo, reviews, opts.noReviews);
  console.log(
    c.yellow(
      `Max attempts (${maxAttempts}) reached. Still waiting: ${lastDecision.waitReason || 'unknown'}`
    )
  );
  state.finalStatus = 'timeout';
  saveState(state);
  process.exit(1);
}

/**
 * isPRGateReady — workflow gate function (single source of truth).
 *
 * Called by workflow-definition.js verify() to determine if the follow_up step
 * is complete. Encapsulates the same logic as the main loop:
 *   1. Fetch PR info, CI, and reviews
 *   2. Apply bot-comment deduplication using persisted state
 *   3. Run decideNextAction with the deduped reviews
 *   4. Fail-closed on transient errors (unlike getReviews which is lenient)
 *
 * @returns {{ ready: boolean, reviews: Object, decision: Object }}
 */
function isPRGateReady() {
  const prInfo = getPRInfo();
  if (!prInfo || !prInfo.number) return { ready: false };
  if (prInfo.state === 'CLOSED') return { ready: false };
  // Merged PRs have passed all gates — allow transition (GH-276)
  if (prInfo.state === 'MERGED')
    return {
      ready: true,
      reviews: {},
      decision: { action: 'exit-success', finalStatus: 'merged' },
      strictCommentCount: 0,
      prInfo,
    };

  const ci = checkCI(prInfo.number);
  const reviews = getReviews(prInfo.number);

  // Strict comment count: fail-closed if inline comments cannot be fetched.
  // getReviews() swallows errors for inline comments (they are supplementary
  // in the polling loop), but the gate must not allow transition if we can't
  // confirm there are no unaccounted comments.
  let strictCommentCount = 0;
  try {
    const repo = ghExec('repo view --json nameWithOwner').nameWithOwner;
    // Use --paginate to count ALL inline comments, not just the first page (default 30)
    const comments = ghExec(
      [
        'api',
        '--paginate',
        `repos/${repo}/pulls/${prInfo.number}/comments?per_page=100`,
        '--jq',
        'length',
      ],
      { json: false }
    );
    // --paginate with --jq length returns one number per page; sum them
    strictCommentCount = (comments || '')
      .split('\n')
      .filter(Boolean)
      .reduce((sum, n) => sum + (parseInt(n, 10) || 0), 0);
  } catch {
    // Cannot verify comment count — fail closed
    return { ready: false };
  }

  // Apply bot-comment deduplication (same as main loop does before deciding)
  let currentHead = null;
  try {
    currentHead = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    /* non-fatal */
  }

  const state = loadState(prInfo.number);
  const previousRunBotHashes = state
    ? state.previousRunBotHashes && state.previousRunBotHashes.length > 0
      ? state.previousRunBotHashes
      : (state.addressedBotComments || []).map((a) => a.hash)
    : [];

  const deduped = deduplicateBlockingBotComments(
    reviews.blocking,
    reviews.nonBlocking,
    previousRunBotHashes,
    { currentHead }
  );
  const dedupedReviews = {
    ...reviews,
    blocking: deduped.blocking,
    nonBlocking: deduped.nonBlocking,
    hasBlocking: deduped.blocking.length > 0,
  };

  const decision = decideNextAction(ci.status, prInfo, dedupedReviews, false);

  return {
    ready: decision.action === 'exit-success',
    reviews: dedupedReviews,
    decision,
    strictCommentCount,
    prInfo,
  };
}

// Export for testing; guard main() so it only runs when executed directly
if (require.main === module) {
  main().catch((err) => {
    console.error(c.red(`Unexpected error: ${err.message}`));
    process.exit(2);
  });
}

/**
 * Build accountability entries from blocking and non-blocking review comments.
 * Extracted for testability.
 *
 * @param {Array} blocking - Blocking review comments
 * @param {Array} nonBlocking - Non-blocking review comments
 * @returns {Array} Accountability entries with disposition and reason
 */
function buildAccountabilityEntries(blocking, nonBlocking) {
  const allComments = [...blocking, ...nonBlocking];
  return allComments.map((item) => ({
    id: item.id || null,
    author: item.author || 'unknown',
    path: item.path || null,
    comment: (item.body || '').slice(0, 120),
    disposition: item.deduplicated
      ? 'addressed'
      : blocking.includes(item)
        ? 'addressed'
        : 'acknowledged',
    reason: item.deduplicated
      ? 'Previously addressed, re-posted after force-push'
      : blocking.includes(item)
        ? 'Blocking comment addressed during follow-up'
        : 'Non-blocking low-priority comment',
  }));
}

module.exports = {
  classifyCommentPriority,
  isBotAuthorLogin,
  isBlockingPriority,
  getResolvedCommentIds,
  resolveOutdatedThreads,
  decideNextAction,
  getAdaptiveInterval,
  computeCommentHash,
  deduplicateBlockingBotComments,
  getChangedPaths,
  initState,
  getCodeContext,
  buildAccountabilityEntries,
  // Gate-check exports: used by workflow-definition.js verify()
  isPRGateReady,
  ghExec,
  getPRInfo,
  checkCI,
  getReviews,
};
