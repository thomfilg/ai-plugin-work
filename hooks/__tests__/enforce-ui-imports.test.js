/**
 * Tests for enforce-ui-imports.js hook (PreToolUse)
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const HOOK_PATH = path.join(__dirname, '..', 'enforce-ui-imports.js');

let GIT_ROOT;

beforeAll(() => {
  GIT_ROOT = path.join(os.tmpdir(), `test-ui-imports-${process.pid}-${Date.now()}`);
  fs.mkdirSync(path.join(GIT_ROOT, '.git'), { recursive: true });
  fs.mkdirSync(path.join(GIT_ROOT, 'packages', 'ui'), { recursive: true });
  fs.mkdirSync(path.join(GIT_ROOT, 'packages', 'shared-ui', 'src'), { recursive: true });
  fs.mkdirSync(path.join(GIT_ROOT, 'apps', 'as-dashboard-worker', 'src'), { recursive: true });
  fs.mkdirSync(path.join(GIT_ROOT, 'apps', 'status-site'), { recursive: true });
  // UI docs required for the hook to activate
  fs.writeFileSync(path.join(GIT_ROOT, 'packages', 'ui', 'components-catalog.md'), '# UI');
});

afterAll(() => {
  fs.rmSync(GIT_ROOT, { recursive: true, force: true });
});

function runHook(input) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [HOOK_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      resolve({ result: { decision: code === 2 ? 'block' : 'approve', reason: stderr.trim() || undefined }, stderr, code, stdout });
    });
    proc.on('error', reject);
    proc.stdin.write(JSON.stringify(input));
    proc.stdin.end();
  });
}

describe('enforce-ui-imports hook', () => {
  it('should APPROVE non-Write/Edit tools', async () => {
    const { result } = await runHook({ tool_name: 'Read', tool_input: { file_path: '/some/file.tsx' } });
    expect(result.decision).toBe('approve');
  });

  it('should APPROVE non-React files', async () => {
    const { result } = await runHook({
      tool_name: 'Write',
      tool_input: { file_path: `${GIT_ROOT}/apps/status-site/config.json`, content: '{}' }
    });
    expect(result.decision).toBe('approve');
  });

  it('should APPROVE files in packages/ui (fully allowed)', async () => {
    const { result } = await runHook({
      tool_name: 'Write',
      tool_input: {
        file_path: `${GIT_ROOT}/packages/ui/src/Button.tsx`,
        content: 'import { Button } from "@mui/material";'
      }
    });
    expect(result.decision).toBe('approve');
  });

  it('should APPROVE allowed MUI primitives (Box, Stack) in app files', async () => {
    const { result } = await runHook({
      tool_name: 'Write',
      tool_input: {
        file_path: `${GIT_ROOT}/apps/as-dashboard-worker/src/component.tsx`,
        content: 'import { Box, Stack, styled } from "@mui/material";'
      }
    });
    expect(result.decision).toBe('approve');
  });

  it('should BLOCK forbidden MUI imports (Button, Card) in app files', async () => {
    const { result } = await runHook({
      tool_name: 'Write',
      tool_input: {
        file_path: `${GIT_ROOT}/apps/as-dashboard-worker/src/component.tsx`,
        content: 'import { Button, Card } from "@mui/material";'
      }
    });
    expect(result.decision).toBe('block');
    expect(result.reason).toContain('FORBIDDEN UI FRAMEWORK IMPORTS');
  });

  it('should APPROVE type imports from MUI', async () => {
    const { result } = await runHook({
      tool_name: 'Write',
      tool_input: {
        file_path: `${GIT_ROOT}/apps/as-dashboard-worker/src/component.tsx`,
        content: 'import type { SxProps } from "@mui/material";'
      }
    });
    expect(result.decision).toBe('approve');
  });

  it('should APPROVE Edit tool with allowed imports', async () => {
    const { result } = await runHook({
      tool_name: 'Edit',
      tool_input: {
        file_path: `${GIT_ROOT}/apps/as-dashboard-worker/src/component.tsx`,
        new_string: 'import { Box } from "@mui/material";'
      }
    });
    expect(result.decision).toBe('approve');
  });

  it('should APPROVE expanded MUI imports in shared-ui', async () => {
    const { result } = await runHook({
      tool_name: 'Write',
      tool_input: {
        file_path: `${GIT_ROOT}/packages/shared-ui/src/Header.tsx`,
        content: 'import { AppBar, Toolbar, IconButton } from "@mui/material";'
      }
    });
    expect(result.decision).toBe('approve');
  });

  it('should APPROVE on parse error', async () => {
    const proc = spawn('node', [HOOK_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
    const exitCode = await new Promise((resolve) => {
      proc.on('close', resolve);
      proc.stdin.write('not json');
      proc.stdin.end();
    });
    expect(exitCode === 2 ? 'block' : 'approve').toBe('approve');
  });
});
