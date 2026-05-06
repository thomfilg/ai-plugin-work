#!/usr/bin/env node
/**
 * write-report.js — Shared report writer utility
 *
 * Provides a factory for creating agent-gated report writer scripts.
 * Each writer script defines:
 *   - Which agents are authorized to call it
 *   - Which fields are required in the input
 *   - How to format the report content
 *
 * Enforcement (hook-issued token):
 *   1. The PreToolUse hook (enforce-step-workflow.js Rule 5) verifies agent
 *      identity using Claude Code's internal hookData (unspoofable).
 *   2. If verified, the hook writes a short-lived token file:
 *        /tmp/.claude-write-tokens/<script-basename>
 *      containing { agent, timestamp }.
 *   3. This script reads the token, deletes it immediately, checks:
 *      - Token exists (hook approved the call)
 *      - Timestamp is a finite number within TOKEN_MAX_AGE_MS (prevents replay)
 *      - Agent name is a non-empty string matching allowedAgents
 *   4. Required fields are validated before writing
 *   5. The report is written atomically (tmp + rename)
 *
 * Why not CLAUDE_CURRENT_AGENT?
 *   Any agent can spoof it: `CLAUDE_CURRENT_AGENT=x node script.js`
 *   The token file is written by the hook process, not the Bash command.
 *
 * Usage from agent-specific scripts:
 *   const { createReportWriter, tokenPath } = require('./write-report');
 *   createReportWriter({ ... }).run();
 */

const fs = require('fs');
const path = require('path');
const { normalizeAgentName } = require('../agent-detection');

/** Max age for a token to be considered valid (10 seconds) */
const TOKEN_MAX_AGE_MS = 10_000;

/** Private directory for token files (0700 permissions) */
const TOKEN_DIR = '/tmp/.claude-write-tokens';

/**
 * Ensure the token directory exists with restricted permissions.
 */
function ensureTokenDir() {
  let stat;
  try {
    stat = fs.lstatSync(TOKEN_DIR);
  } catch (e) {
    if (!e || e.code !== 'ENOENT') throw e;
    fs.mkdirSync(TOKEN_DIR, { mode: 0o700, recursive: true });
    return;
  }
  // Reject symlinks — attacker could point to unsafe location
  if (stat.isSymbolicLink()) {
    throw new Error(`Unsafe token directory: ${TOKEN_DIR} must not be a symlink`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Unsafe token directory: ${TOKEN_DIR} is not a directory`);
  }
  // Verify ownership (Unix only)
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`Unsafe token directory: ${TOKEN_DIR} is not owned by the current user`);
  }
  // Fix permissions if needed
  if ((stat.mode & 0o077) !== 0) {
    fs.chmodSync(TOKEN_DIR, 0o700);
  }
}

/**
 * Build the token file path for a given script.
 * @param {string} scriptBasename — e.g. "write-qa-report.js"
 * @returns {string} — e.g. "/tmp/.claude-write-tokens/write-qa-report.js"
 */
function tokenPath(scriptBasename) {
  return path.join(TOKEN_DIR, scriptBasename);
}

/**
 * Read and consume a write token (atomic read + delete).
 * Validates that the token file is a regular file (not a symlink).
 * @param {string} scriptBasename
 * @returns {{ agent: string, timestamp: number } | null}
 */
function consumeToken(scriptBasename) {
  const tp = tokenPath(scriptBasename);
  try {
    // Verify the token is a regular file (not a symlink to an unsafe target)
    const stat = fs.lstatSync(tp);
    if (!stat.isFile()) return null;

    const raw = fs.readFileSync(tp, 'utf8');
    // Delete immediately to prevent reuse
    try {
      fs.unlinkSync(tp);
    } catch {
      /* already deleted — race is fine */
    }
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * @typedef {object} ReportWriterConfig
 * @property {string} name — Human-readable name (e.g. "QA Report Writer")
 * @property {string[]} allowedAgents — Agent names authorized to call this writer
 * @property {string[]} requiredFields — Field names that must be present in input
 * @property {(input: object) => string} formatReport — Function that formats input into markdown
 * @property {(input: object) => string[]} [validate] — Optional extra validation (returns error messages)
 * @property {string} [reportType] — Report type for post-write status validation (e.g. 'tests', 'codeReview', 'completion')
 */

/**
 * Create a report writer instance.
 *
 * @param {ReportWriterConfig} config
 * @returns {{ run: () => Promise<void> }}
 */
function createReportWriter(config) {
  const { name, allowedAgents, requiredFields, formatReport, validate, reportType } = config;

  async function run() {
    // Parse input from stdin (JSON)
    let rawInput = '';
    for await (const chunk of process.stdin) {
      rawInput += chunk;
    }

    let input;
    try {
      input = JSON.parse(rawInput);
    } catch (e) {
      process.stderr.write(`[${name}] ERROR: Invalid JSON input.\n${e.message}\n`);
      process.exit(1);
    }

    // --- Enforcement 1: Hook-issued token verification ---
    // The PreToolUse hook (Rule 5) writes a token file after verifying agent
    // identity via Claude Code's internal hookData. We consume that token here.
    // This cannot be spoofed because the token is written by the hook process,
    // not by the Bash command the agent executes.
    const errors = [];

    const scriptBasename = path.basename(process.argv[1] || '');
    const token = consumeToken(scriptBasename); // reads + deletes token atomically
    let verifiedAgent = null;

    if (!token) {
      process.stderr.write(
        `[${name}] BLOCKED: No valid write token found.\n` +
          `  Expected token at: ${tokenPath(scriptBasename)}\n` +
          `  The PreToolUse hook must approve this call first.\n` +
          `  This script can only be called through Claude Code's agent system.\n`
      );
      process.exit(2);
    }

    // Validate token structure: timestamp must be a finite number, agent must be a string
    if (typeof token.timestamp !== 'number' || !Number.isFinite(token.timestamp)) {
      process.stderr.write(`[${name}] BLOCKED: Token has invalid or missing timestamp.\n`);
      process.exit(2);
    }
    if (typeof token.agent !== 'string' || !token.agent) {
      process.stderr.write(`[${name}] BLOCKED: Token has invalid or missing agent field.\n`);
      process.exit(2);
    }

    // Check token freshness — prevents replay with pre-placed token files
    // Reject expired AND future timestamps (clock skew / tampered tokens)
    const age = Date.now() - token.timestamp;
    if (age < 0 || age > TOKEN_MAX_AGE_MS) {
      process.stderr.write(
        `[${name}] BLOCKED: Write token expired (${age}ms old, max ${TOKEN_MAX_AGE_MS}ms).\n` +
          `  Token was issued at ${new Date(token.timestamp).toISOString()}\n`
      );
      process.exit(2);
    }

    // Check agent in token matches allowedAgents
    verifiedAgent = token.agent;
    const agentMatch = allowedAgents.some(
      (a) => normalizeAgentName(a) === normalizeAgentName(verifiedAgent)
    );

    if (!agentMatch) {
      process.stderr.write(
        `[${name}] BLOCKED: Token agent "${verifiedAgent}" is not authorized.\n` +
          `  Allowed agents: ${allowedAgents.join(', ')}\n` +
          `  Only these agents can use this writer.\n`
      );
      process.exit(2);
    }

    // --- Enforcement 2: Required fields ---
    for (const field of requiredFields) {
      if (input[field] === undefined || input[field] === null || input[field] === '') {
        errors.push(`Missing required field: "${field}"`);
      }
    }

    // --- Enforcement 3: Custom validation ---
    if (validate) {
      const extra = validate(input);
      if (extra && extra.length > 0) {
        errors.push(...extra);
      }
    }

    if (errors.length > 0) {
      process.stderr.write(
        `[${name}] VALIDATION FAILED:\n` +
          errors.map((e, i) => `  ${i + 1}. ${e}`).join('\n') +
          '\n'
      );
      process.exit(1);
    }

    // --- Format and write ---
    const reportPath = input.reportPath;
    if (typeof reportPath !== 'string' || !reportPath.trim()) {
      process.stderr.write(`[${name}] ERROR: "reportPath" must be a non-empty string.\n`);
      process.exit(1);
    }
    // Guard against path traversal — reportPath must be absolute
    if (!path.isAbsolute(reportPath)) {
      process.stderr.write(`[${name}] ERROR: "reportPath" must be an absolute path.\n`);
      process.exit(1);
    }
    // Scope reportPath to the ticket's task folder (bound into token by hook)
    if (token.tasksBase) {
      const resolved = path.resolve(reportPath);
      if (!resolved.startsWith(token.tasksBase + path.sep) && resolved !== token.tasksBase) {
        process.stderr.write(
          `[${name}] BLOCKED: reportPath is outside the ticket's task folder.\n` +
            `  reportPath: ${resolved}\n` +
            `  Allowed folder: ${token.tasksBase}/\n`
        );
        process.exit(2);
      }
    }

    const newContent = formatReport(input);

    // Post-write validation: verify formatted output has a parseable Status line (GH-326)
    if (reportType) {
      const { STATUS_LINE_RE, resolveAlias } = require('../parse-report-status');
      const statusMatch = newContent.match(STATUS_LINE_RE);
      const hasValidStatus = statusMatch && resolveAlias(statusMatch[1].toUpperCase(), reportType);
      if (!hasValidStatus) {
        process.stderr.write(
          `[${name}] VALIDATION FAILED: Formatted report has no parseable Status line.\n` +
            `  parseReportStatus returned: ${hasValidStatus ? 'valid' : 'UNKNOWN'}\n` +
            `  The formatReport() function must include a "Status: <VALUE>" line.\n` +
            `  This is a bug in the report writer, not in the agent input.\n`
        );
        process.exit(1);
      }
    }

    // Prepend strategy: if file exists, preserve old content with separator
    let finalContent = newContent;
    if (fs.existsSync(reportPath)) {
      const oldContent = fs.readFileSync(reportPath, 'utf8');
      const timestamp = new Date().toISOString();
      finalContent = newContent + `\n\n---\n## Previous Run: ${timestamp}\n---\n\n` + oldContent;
    }

    // Reject symlink targets — prevents overwriting unexpected files
    try {
      const stat = fs.lstatSync(reportPath);
      if (stat.isSymbolicLink()) {
        process.stderr.write(`[${name}] BLOCKED: reportPath is a symlink — refusing to write.\n`);
        process.exit(2);
      }
    } catch {
      /* file doesn't exist yet — fine */
    }

    // Atomic write: write to tmp then rename (prevents partial reads)
    const dir = path.dirname(reportPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tmp = `${reportPath}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, finalContent, 'utf8');
    fs.renameSync(tmp, reportPath);

    // Output success info as JSON (for the calling agent to parse)
    const result = {
      success: true,
      reportPath,
      size: Buffer.byteLength(finalContent, 'utf8'),
      agent: verifiedAgent,
    };
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }

  return { run };
}

module.exports = { createReportWriter, consumeToken, tokenPath, ensureTokenDir, TOKEN_MAX_AGE_MS };
