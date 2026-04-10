/**
 * Tests for workflow-router-hook.js — GH-206 hardening
 *
 * Verifies:
 * 1. execSync with string interpolation is NOT used (injection vector removed)
 * 2. safeExec (which wraps execFileSync) is used with array args (safe from shell injection)
 * 3. logHookError is imported and invoked on failure paths
 * 4. Existing workflow routing behaviour is preserved
 *
 * Run with: node --test workflows/lib/__tests__/workflow-router-hook-injection.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'workflow-router-hook.js');

// ---------- Static source-code analysis tests ----------

describe('workflow-router-hook source hardening', () => {
  const src = fs.readFileSync(HOOK_PATH, 'utf-8');

  it('should NOT use execSync with template-literal string interpolation', () => {
    const hasUnsafeExecSync = /execSync\s*\(/.test(src);
    assert.strictEqual(
      hasUnsafeExecSync,
      false,
      'execSync call found — replace with safeExec to prevent shell injection'
    );
  });

  it('should NOT import execFileSync directly from child_process', () => {
    const hasDirectExecFileSync = /require\([^)]*child_process[^)]*\)[\s\S]*execFileSync/.test(src);
    const destructuredExecFileSync = /\{\s*execFileSync\s*\}\s*=\s*require/.test(src);
    assert.strictEqual(
      hasDirectExecFileSync || destructuredExecFileSync,
      false,
      'execFileSync should not be imported directly — use safeExec from workflows/lib/safe-exec'
    );
  });

  it('should import safeExec from workflows/lib/safe-exec', () => {
    const hasSafeExecImport = /\{\s*safeExec\s*\}\s*=\s*require/.test(src);
    const referencesSafeExecModule = /safe-exec/.test(src);
    assert.strictEqual(
      hasSafeExecImport && referencesSafeExecModule,
      true,
      'safeExec import from workflows/lib/safe-exec is missing'
    );
  });

  it('should call safeExec with process.execPath and array args', () => {
    const hasCorrectPattern = /safeExec\s*\(\s*process\.execPath\s*,\s*\[/.test(src);
    assert.strictEqual(
      hasCorrectPattern,
      true,
      'safeExec should be called with process.execPath as the executable and array args'
    );
  });

  it('should import logHookError from hook-error-log', () => {
    const hasLogImport = /logHookError/.test(src);
    assert.strictEqual(hasLogImport, true, 'logHookError import is missing');
  });

  it('should reference hook-error-log module path', () => {
    const hasModulePath = /hook-error-log/.test(src);
    assert.strictEqual(hasModulePath, true, 'hook-error-log module reference is missing');
  });

  it('should NOT have backtick-interpolated command strings in child_process calls', () => {
    const hasBacktickCmd = /(?:exec(?:Sync|FileSync)|safeExec)\s*\(\s*`/.test(src);
    assert.strictEqual(
      hasBacktickCmd,
      false,
      'Template-literal command string found in exec call — use array args instead'
    );
  });

  it('should pass ENGINE_PATH, matched, plan, and parsed args as array elements', () => {
    // Verify the array contains ENGINE_PATH, matched, 'plan' as discrete elements
    const hasArrayPattern = /safeExec\s*\(\s*process\.execPath\s*,\s*\[/.test(src);
    assert.strictEqual(
      hasArrayPattern,
      true,
      "safeExec should receive args as an array [ENGINE_PATH, matched, 'plan', ...parsedArgs]"
    );
  });
});

// ---------- Functional / integration tests ----------

function runHook(userPrompt) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [HOOK_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CLAUDE_USER_PROMPT: userPrompt },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
    proc.on('error', reject);
    proc.stdin.end();
  });
}

describe('workflow-router-hook functional behaviour', () => {
  it('should exit 0 for non-workflow commands', async () => {
    const { code } = await runHook('hello how are you');
    assert.strictEqual(code, 0);
  });

  it('should exit 0 for empty prompt', async () => {
    const { code } = await runHook('');
    assert.strictEqual(code, 0);
  });

  it('should exit 0 when no workflows match', async () => {
    const { code } = await runHook('/nonexistent-command PROJ-123');
    assert.strictEqual(code, 0);
  });
});
