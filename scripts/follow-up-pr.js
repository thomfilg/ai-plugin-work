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
    maxAttempts: 10,
    interval: 60,
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
  --interval <seconds>  Wait between attempts (default: 60)
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
  try {
    raw = ghExec(`pr checks ${prArg} --json name,bucket,state,link,workflow`, { allowNonZero: true });
  } catch (err) {
    // gh pr checks exits 1 when checks fail, exit 8 when pending
    // Try to extract JSON from stderr/stdout
    if (err.message) {
      // Fallback: use pr view --json statusCheckRollup
      try {
        const data = ghExec(`pr view ${prArg} --json statusCheckRollup`);
        raw = (data.statusCheckRollup || []).map((check) => {
          let bucket;
          if (check.status !== 'COMPLETED') {
            bucket = 'pending';
          } else {
            switch (check.conclusion) {
              case 'SUCCESS':
              case 'NEUTRAL':
                bucket = 'pass';
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

  const checks = raw.map((check) => ({
    name: check.name || 'unknown',
    bucket: (check.bucket || 'pending').toLowerCase(),
    state: check.state || '',
    category: categorizeCheck(check.name || ''),
    url: check.link || null,
  }));

  const failed = checks.filter((ck) => ck.bucket === 'fail');
  const running = checks.filter((ck) => ck.bucket === 'pending');
  const passed = checks.filter((ck) => ck.bucket === 'pass' || ck.bucket === 'skipping');
  const cancelled = checks.filter((ck) => ck.bucket === 'cancel');

  let status;
  if (failed.length > 0) status = 'failing';
  else if (running.length > 0) status = 'pending';
  else if (checks.length === 0) status = 'no-checks';
  else if (cancelled.length > 0) status = 'cancelled';
  else status = 'passing';

  return { status, checks, failed, running, passed, cancelled, total: checks.length };
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

  // Copilot: [severity] tags (from copilot-instructions.md) or [nitpick] flag
  if (author === 'copilot-pull-request-reviewer' || author === 'Copilot') {
    if (/\[nitpick\]/i.test(body) || /\[low\]/i.test(body)) return 'low';
    if (/\[critical\]/i.test(body) || /\[high\]/i.test(body)) return 'high';
    if (/\[medium\]/i.test(body)) return 'medium';
    return 'medium';
  }

  // Cursor: parse **severity**: <level> pattern
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
    const perPage = 100;
    let page = 1;
    while (true) {
      const pageData = ghExec(['api', `repos/${repo}/pulls/${prNumber}/comments?per_page=${perPage}&page=${page}`]);
      if (!Array.isArray(pageData) || pageData.length === 0) break;
      // Filter out stale comments: line=null AND original_line exists means
      // the code changed since the comment was made. Keep file-level comments
      // (both line and original_line null) and current-line comments.
      const activeComments = pageData.filter(
        (cm) => !(cm.line === null && cm.original_line != null)
      );
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
  const isBotAuthor = (author) => botReviewers.includes(author);
  const actionable = reviews.filter(
    (r) => r.state === 'CHANGES_REQUESTED' || (r.state === 'COMMENTED' && r.body && !isBotAuthor(r.author))
  ).map((r) => {
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
  } else if (ci.status === 'passing') {
    lines.push(c.green(`CI: PASSED (all ${ci.total} checks)`));
    for (const ck of ci.passed) {
      lines.push(`  ${c.green('✓')} ${ck.name} — passed`);
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
          const preview = item.body.length > 80 ? item.body.slice(0, 77) + '...' : item.body;
          lines.push(`    ${c.dim('"' + preview + '"')}`);
        }
      }
      if (reviews.nonBlocking.length > 0) {
        lines.push(c.dim(`  + ${reviews.nonBlocking.length} non-blocking (nitpick/low priority — ignored)`));
      }
    } else if (reviews.nonBlocking.length > 0) {
      lines.push(c.green(`Reviews: CLEAR (${reviews.nonBlocking.length} non-blocking nitpicks — ignored)`));
    } else {
      lines.push(c.green('Reviews: CLEAR'));
    }
  }

  // Action hint
  lines.push('');
  if (ci.status === 'failing') {
    lines.push(`→ Fix the failure, push, then re-run: ${c.dim('node scripts/follow-up-pr.js')}`);
  } else if (ci.status === 'passing' && !opts.noReviews && reviews.hasBlocking) {
    lines.push(`→ Address blocking reviews, push, then re-run: ${c.dim('node scripts/follow-up-pr.js')}`);
  } else if (isConflicting) {
    lines.push(`→ Resolve conflicts, push, then re-run: ${c.dim('node scripts/follow-up-pr.js')}`);
  } else if (!isMergeReady) {
    lines.push(`→ Merge status not ready (${prInfo.mergeable || 'UNKNOWN'}). Waiting...`);
  } else if (ci.status === 'passing' && (!reviews.hasBlocking || opts.noReviews) && reviews.pendingBots.length === 0 && isMergeReady) {
    lines.push(c.green('═══════════════════════════════════════'));
    lines.push(c.green('  PR READY TO REVIEW'));
    lines.push(c.green('═══════════════════════════════════════'));
    lines.push('');
    lines.push(c.green(`CI: PASSED | Reviews: ${opts.noReviews ? 'SKIPPED' : 'CLEAR'} | Conflicts: NONE`));
    lines.push(c.green(`PR #${prInfo.number} is ready for review/merge!`));
  } else if (ci.status === 'pending') {
    lines.push(`→ Waiting ${opts.interval}s for checks... (attempt ${attempt}/${maxAttempts})`);
  } else if (!opts.noReviews && reviews.pendingBots.length > 0) {
    lines.push(`→ Waiting ${opts.interval}s for bot reviews... (attempt ${attempt}/${maxAttempts})`);
  }

  return lines.join('\n');
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

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Refresh PR info each attempt (mergeable status may change)
    try {
      prInfo = getPRInfo(prInfo.number);
    } catch {
      // Use cached info if refresh fails
    }

    // Check CI
    let ci;
    try {
      ci = checkCI(prInfo.number);
    } catch (err) {
      console.error(c.red(`Error checking CI: ${err.message}`));
      process.exit(2);
    }

    // Check reviews (unless --no-reviews)
    let reviews = { all: [], comments: [], actionable: [], blocking: [], nonBlocking: [], pendingBots: [], hasBlocking: false, hasActionable: false };
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

    // Print report
    console.log('');
    console.log(formatReport(prInfo, ci, reviews, attempt, maxAttempts, { ...opts, interval: opts.interval }));
    console.log('');

    // Fail-fast: CI failure → immediate exit
    if (ci.status === 'failing') {
      state.finalStatus = 'ci-failing';
      saveState(state);
      process.exit(1);
    }

    // All clear?
    const isConflicting = prInfo.mergeable === 'CONFLICTING' || prInfo.mergeStateStatus === 'DIRTY';
    const isMergeReady = prInfo.mergeable === 'MERGEABLE' && (!prInfo.mergeStateStatus || prInfo.mergeStateStatus === 'CLEAN' || prInfo.mergeStateStatus === 'HAS_HOOKS' || prInfo.mergeStateStatus === 'UNSTABLE');
    const ciPassed = ci.status === 'passing';
    // Non-blocking reviews (nitpicks/low priority) do NOT prevent "ready" status
    const reviewsClear = opts.noReviews || (!reviews.hasBlocking && reviews.pendingBots.length === 0);

    if (ciPassed && reviewsClear && isMergeReady) {
      state.finalStatus = 'ready';
      saveState(state);
      process.exit(0);
    }

    // Blocking reviews or conflicts → exit 1 (agent needs to fix)
    if (ciPassed && (reviews.hasBlocking || !isMergeReady)) {
      state.finalStatus = reviews.hasBlocking ? 'reviews-blocking' : 'conflicting';
      saveState(state);
      process.exit(1);
    }

    // Still pending — wait and retry
    if (attempt < maxAttempts) {
      await sleep(opts.interval);
    }
  }

  // Exhausted attempts
  console.log(c.yellow(`Max attempts (${maxAttempts}) reached. CI checks still pending.`));
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

module.exports = { classifyCommentPriority, isBlockingPriority };
