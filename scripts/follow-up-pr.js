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
const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Colors ──────────────────────────────────────────────────────────────────

const isColorEnabled = process.stdout.isTTY === true && !process.env.NO_COLOR;
const c = {
  red: (s) => isColorEnabled ? `\x1b[31m${s}\x1b[0m` : s,
  green: (s) => isColorEnabled ? `\x1b[32m${s}\x1b[0m` : s,
  yellow: (s) => isColorEnabled ? `\x1b[33m${s}\x1b[0m` : s,
  cyan: (s) => isColorEnabled ? `\x1b[36m${s}\x1b[0m` : s,
  bold: (s) => isColorEnabled ? `\x1b[1m${s}\x1b[0m` : s,
  dim: (s) => isColorEnabled ? `\x1b[2m${s}\x1b[0m` : s,
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
        args.noReviews = true;
        break;
      case '--help':
      case '-h':
        console.log(`Usage: node scripts/follow-up-pr.js [options]

Options:
  --pr <number>         PR number (default: auto-detect from branch)
  --max-attempts <n>    Max polling attempts (default: 10)
  --interval <seconds>  Fixed wait between attempts (default: adaptive)
  --once                Single check, no loop (for manual debugging only)
  --no-reviews          Skip review polling
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
        try { return JSON.parse(stdout); } catch { /* fall through */ }
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
    raw = ghExec(`pr checks ${prArg} --json name,bucket,state,link,workflow`, { allowNonZero: true });
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
  if (!usedFallback) try {
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

const DEFAULT_BOT_REVIEWERS = 'copilot-pull-request-reviewer,cursor-ai[bot]';

function getBotReviewers() {
  const env = process.env.FOLLOW_UP_PR_BOT_REVIEWERS;
  const raw = env !== undefined ? env : DEFAULT_BOT_REVIEWERS;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
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
        'api', 'graphql',
        '-f', `query=${query}`,
        '-f', `owner=${owner}`,
        '-f', `name=${name}`,
        '-F', `pr=${prNumber}`,
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
        console.error(c.dim(`  ⚠ GraphQL partial error: ${graphqlResult.errors[0].message || 'unknown'} — continuing with available data`));
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
            console.error(c.dim(`  ⚠ Resolved thread has ${comments.totalCount} comments (fetched ${nodes.length}) — some may not be filtered`));
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
    console.error(c.dim(`  ⚠ GraphQL thread query failed: ${err.message || 'unknown'} — falling back to REST-only filtering`));
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
  try {
    const repoData = ghExec('repo view --json nameWithOwner');
    const repo = repoData.nameWithOwner;

    // Get current branch commit SHAs to detect stale comments from force-pushes
    let branchCommits = new Set();
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
    const { resolved: resolvedCommentIds, outdatedThreadIds } = getResolvedCommentIds(repo, prNumber);

    // Optionally resolve outdated threads on GitHub
    if (process.env.ENABLE_RESOLVE_OUTDATED_COMMENTS === 'true' && outdatedThreadIds.length > 0) {
      resolveOutdatedThreads(outdatedThreadIds);
    }

    const isActiveComment = (cm) => {
      if (cm.line === null && cm.original_line != null) return false;
      if (branchCommits.size > 0 && cm.commit_id && !branchCommits.has(cm.commit_id)) return false;
      if (resolvedCommentIds.has(cm.id)) return false;
      return true;
    };

    const perPage = 100;
    let page = 1;
    while (true) {
      const pageData = ghExec(['api', `repos/${repo}/pulls/${prNumber}/comments?per_page=${perPage}&page=${page}`]);
      if (!Array.isArray(pageData) || pageData.length === 0) break;
      const activeComments = pageData.filter(isActiveComment);
      comments.push(...activeComments.map((cm) => ({
        id: cm.id,
        author: cm.user?.login || 'unknown',
        body: (cm.body || '').trim(),
        path: cm.path || null,
        line: cm.line || null,
        state: 'COMMENTED',
      })));
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
    const checksRunning = (data.statusCheckRollup || []).some(
      (ck) => ck.status !== 'COMPLETED'
    );
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
  const isBotAuthor = (author) => {
    const lower = (author || '').toLowerCase();
    // Exact match against configured bot reviewers (case-insensitive)
    if (botReviewersLower.includes(lower)) return true;
    // Match known aliases used by classifyCommentPriority
    if (lower === 'copilot' || lower === 'cursor-ai[bot]') return true;
    // Fuzzy match: strip [bot] suffix from configured names
    return botReviewersLower.some((bot) => bot.includes('[bot]') && lower === bot.replace('[bot]', ''));
  };
  const isBotReview = (r) => isBotAuthor(r.author) || BOT_BODY_MARKERS.test(r.body || '');
  const isActionableReview = (r) => r.state === 'CHANGES_REQUESTED' || (r.state === 'COMMENTED' && r.body && !isBotReview(r));
  const actionable = reviews.filter(isActionableReview).map((r) => {
    const priority = classifyCommentPriority(r.author, r.body);
    // CHANGES_REQUESTED is always at least medium (blocking), regardless of severity tags
    const effectivePriority = (r.state === 'CHANGES_REQUESTED' && priority === 'low') ? 'medium' : priority;
    return { ...r, priority: effectivePriority };
  });

  // Classify inline comments by priority
  const classifiedComments = comments.map((cm) => ({
    ...cm,
    priority: classifyCommentPriority(cm.author, cm.body),
  }));

  // Split into blocking (medium/high) and non-blocking (low/nitpick)
  const allItems = [...actionable, ...classifiedComments];
  const blocking = allItems.filter((item) => isBlockingPriority(item.priority));
  const nonBlocking = allItems.filter((item) => !isBlockingPriority(item.priority));

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
    const result = execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], {
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000,
    }).trim();
    return result.replace(/[^\w.-]/g, '_');
  } catch {
    return 'local';
  }
}

function stateFilePath(prNumber) {
  return path.join(os.tmpdir(), `follow-up-pr-${getRepoSlug()}-${prNumber}.json`);
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
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2) + '\n');
}

function initState(prInfo) {
  return {
    prNumber: prInfo.number,
    prUrl: prInfo.url,
    branch: prInfo.branch,
    startTime: new Date().toISOString(),
    attempts: [],
    finalStatus: null,
  };
}

// ── Report Formatting ───────────────────────────────────────────────────────

function formatNonBlockingItems(items, lines) {
  for (const item of items) {
    const loc = item.path ? ` ${c.dim(item.path + (item.line ? ':' + item.line : ''))}` : '';
    lines.push(`  ${c.dim('○')} ${c.cyan('@' + item.author)} ${c.dim('[LOW]')}${loc}`);
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
  lines.push(
    `PR: ${c.cyan('#' + prInfo.number)} — ${prInfo.title}`
  );
  lines.push(
    `Branch: ${c.dim(prInfo.branch)} | Attempt: ${attempt}/${maxAttempts}`
  );
  lines.push('');

  // CI status
  if (ci.status === 'failing') {
    const failFastNote = ci.running.length > 0 ? ' (fail-fast — not waiting for remaining checks)' : '';
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
        const getTicketId = require('./get-ticket-id.js');
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
    lines.push(c.yellow(`CI: CANCELLED (${ci.cancelled.length} cancelled, ${ci.passed.length} passed)`));
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
  const isMergeReady = prInfo.mergeable === 'MERGEABLE' && (!prInfo.mergeStateStatus || prInfo.mergeStateStatus === 'CLEAN' || prInfo.mergeStateStatus === 'HAS_HOOKS' || prInfo.mergeStateStatus === 'UNSTABLE');
  if (isConflicting) {
    lines.push('');
    lines.push(c.red('CONFLICTS: Merge conflicts detected — rebase required'));
  } else if (!isMergeReady) {
    lines.push('');
    lines.push(c.yellow(`MERGE STATUS: ${prInfo.mergeable || 'UNKNOWN'} (${prInfo.mergeStateStatus || 'UNKNOWN'}) — not yet mergeable`));
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
        if (item.path && item.line) {
          lines.push(`    ${c.yellow('→ Alter line ' + item.line + ' in ' + item.path + ' to address this comment (touch the exact line to invalidate stale review)')}`);
        } else if (item.path) {
          lines.push(`    ${c.yellow('→ Alter ' + item.path + ' to address this comment')}`);
        }
      }
      if (reviews.nonBlocking.length > 0) {
        lines.push(`  + ${reviews.nonBlocking.length} non-blocking (nitpick/low — assess whether to address):`);
        formatNonBlockingItems(reviews.nonBlocking, lines);
      }
    } else if (reviews.nonBlocking.length > 0) {
      lines.push(c.green(`Reviews: CLEAR`) + ` (${reviews.nonBlocking.length} non-blocking — assess whether to address):`);
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
    lines.push(`→ CI was cancelled. Re-push or re-run the workflow: ${c.dim('gh run rerun <run-id>')}`);
  } else if (!opts.noReviews && reviews.hasBlocking && reviews.pendingBots.length > 0) {
    const blockCount = reviews.blocking ? reviews.blocking.length : 0;
    lines.push(`→ Waiting ${opts.interval}s for bot reviews (${blockCount} blocking comment${blockCount !== 1 ? 's' : ''} may become stale)... (attempt ${attempt}/${maxAttempts})`);
  } else if (!opts.noReviews && reviews.hasBlocking) {
    lines.push(`→ Address blocking reviews, push, then re-run: ${c.dim('node scripts/follow-up-pr.js')}`);
  } else if (ciAcceptable && (!reviews.hasBlocking || opts.noReviews) && reviews.pendingBots.length === 0 && isMergeReady) {
    lines.push(c.green('═══════════════════════════════════════'));
    lines.push(c.green('  PR READY TO REVIEW'));
    lines.push(c.green('═══════════════════════════════════════'));
    lines.push('');
    const ciLabel = ci.status === 'no-checks' ? 'NO CHECKS' : 'PASSED';
    lines.push(c.green(`CI: ${ciLabel} | Reviews: ${opts.noReviews ? 'SKIPPED' : 'CLEAR'} | Conflicts: NONE`));
    lines.push(c.green(`PR #${prInfo.number} is ready for review/merge!`));
  } else if (ci.status === 'pending') {
    lines.push(`→ Waiting ${opts.interval}s for checks... (attempt ${attempt}/${maxAttempts})`);
  } else if (!opts.noReviews && reviews.pendingBots.length > 0) {
    lines.push(`→ Waiting ${opts.interval}s for bot reviews... (attempt ${attempt}/${maxAttempts})`);
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
  const isMergeReady = prInfo.mergeable === 'MERGEABLE' && (!prInfo.mergeStateStatus || prInfo.mergeStateStatus === 'CLEAN' || prInfo.mergeStateStatus === 'HAS_HOOKS' || prInfo.mergeStateStatus === 'UNSTABLE');
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
  if (!noReviews && reviews.hasBlocking && !ciFinished) reasons.push('waiting for CI to finish before evaluating reviews');
  if (!noReviews && reviews.hasBlocking && reviews.pendingBots.length > 0) reasons.push('blocking reviews may become stale after bot review');
  if (!isMergeReady && !isConflicting) reasons.push(`merge status: ${prInfo.mergeStateStatus || 'UNKNOWN'}`);

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
  const completed = (ci.passed ? ci.passed.length : 0)
    + (ci.neutral ? ci.neutral.length : 0)
    + (ci.failed ? ci.failed.length : 0)
    + (ci.cancelled ? ci.cancelled.length : 0);
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
    console.log(c.dim(`PR #${prInfo.number} is ${prInfo.state.toLowerCase()}. Nothing to monitor.`));
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
  let reviews = { all: [], comments: [], actionable: [], blocking: [], nonBlocking: [], pendingBots: [], hasBlocking: false, hasActionable: false };

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
    reviews = { all: [], comments: [], actionable: [], blocking: [], nonBlocking: [], pendingBots: [], hasBlocking: false, hasActionable: false };
    if (!opts.noReviews) {
      try {
        reviews = getReviews(prInfo.number);
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
      blockingReviews: reviews.blocking.map((r) => ({ id: r.id, author: r.author, priority: r.priority })),
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

    if (decision.action === 'exit-fail') {
      state.finalStatus = decision.finalStatus;
      saveState(state);
      process.exit(1);
    }

    if (decision.action === 'exit-success') {
      state.finalStatus = decision.finalStatus;
      saveState(state);
      process.exit(0);
    }

    // Continue polling with adaptive interval
    if (attempt < maxAttempts) {
      await sleep(interval);
    }
  }

  // Exhausted attempts — report what we were waiting on
  const lastDecision = decideNextAction(ci.status, prInfo, reviews, opts.noReviews);
  console.log(c.yellow(`Max attempts (${maxAttempts}) reached. Still waiting: ${lastDecision.waitReason || 'unknown'}`));
  state.finalStatus = 'timeout';
  saveState(state);
  process.exit(1);
}

// Export for testing; guard main() so it only runs when executed directly
if (require.main === module) {
  main().catch((err) => {
    console.error(c.red(`Unexpected error: ${err.message}`));
    process.exit(2);
  });
}

module.exports = { classifyCommentPriority, isBlockingPriority, getResolvedCommentIds, resolveOutdatedThreads, decideNextAction, getAdaptiveInterval };
