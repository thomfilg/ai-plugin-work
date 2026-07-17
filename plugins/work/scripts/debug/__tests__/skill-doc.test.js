'use strict';

/**
 * skill-doc — documentation assertion tests for the `/debug` SKILL.md.
 *
 * Reads plugins/work/skills/debug/SKILL.md and pins its required content per
 * Task 3 (GH-316) Acceptance Criteria:
 *   - Frontmatter: name, description, argument-hint, user-invocable, and
 *     allowed-tools containing Task (plus Bash, Read).
 *   - The verbatim `codex:plugin-root-preamble` block (mirroring the other
 *     skills, e.g. skills/work/SKILL.md, skills/brief/SKILL.md).
 *   - Parses `/debug "<description>"`, `continue`, `status`, `list`, and the
 *     `--diagnose` flag from the argument (mirroring /work).
 *   - `/debug "<description>"` runs `debug-session.js init` then dispatches
 *     Task(debugger) mode investigate; `--diagnose` dispatches mode diagnose.
 *   - `/debug continue` verifies the session exists and is `active`, then
 *     dispatches Task(debugger) mode continue.
 *   - `/debug status` runs `debug-session.js status` and `/debug list` runs
 *     `debug-session.js list` — NEITHER dispatches Task(debugger).
 *   - A Task(debugger) dispatch block is present; the skill body does NOT read
 *     investigation files itself (keeps the main session lean).
 *
 * Requirements covered: R2, R5, R6, R7, R11.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SKILL_MD_PATH = path.join(__dirname, '..', '..', '..', 'skills', 'debug', 'SKILL.md');

function readSkillMd() {
  return fs.readFileSync(SKILL_MD_PATH, 'utf8');
}

/** Extract the leading YAML frontmatter block (between the first pair of --- fences). */
function readFrontmatter() {
  const content = readSkillMd();
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(match, 'expected a leading YAML frontmatter block fenced by ---');
  return match[1];
}

test('SKILL.md carries frontmatter with name, description, argument-hint, user-invocable', () => {
  const fm = readFrontmatter();
  assert.match(fm, /^name:\s*debug\s*$/m, 'expected "name: debug" in the frontmatter');
  assert.match(fm, /^description:/m, 'expected a "description:" key in the frontmatter');
  assert.match(fm, /^argument-hint:/m, 'expected an "argument-hint:" key in the frontmatter');
  assert.match(
    fm,
    /^user-invocable:\s*true\s*$/m,
    'expected "user-invocable: true" in the frontmatter'
  );
});

test('SKILL.md frontmatter allowed-tools contains Task, Bash, and Read', () => {
  const fm = readFrontmatter();
  const match = fm.match(/^allowed-tools:\s*(.+)$/m);
  assert.ok(match, 'expected an "allowed-tools:" key in the frontmatter');
  const tools = match[1];
  assert.match(tools, /\bTask\b/, 'expected allowed-tools to include Task');
  assert.match(tools, /\bBash\b/, 'expected allowed-tools to include Bash');
  assert.match(tools, /\bRead\b/, 'expected allowed-tools to include Read');
});

test('SKILL.md carries the verbatim codex:plugin-root-preamble block', () => {
  const content = readSkillMd();
  assert.match(
    content,
    /<!-- codex:plugin-root-preamble v1[\s\S]*?scripts\/codemod-plugin-root-preamble\.js/,
    'expected the codex:plugin-root-preamble marker comment'
  );
  assert.match(
    content,
    /Resolve the plugin root before running any script below/,
    'expected the preamble body text'
  );
  // The preamble self-locates against this skill's own SKILL.md path.
  assert.match(
    content,
    /skills\/debug\/SKILL\.md/,
    "expected the preamble to reference this skill's own SKILL.md path"
  );
  assert.match(
    content,
    /PLUGIN_ROOT="\$\(cd "\$\(dirname "\$SKILL_MD"\)\/\.\.\/\.\." && pwd\)"/,
    'expected the preamble self-locate fallback line'
  );
});

test('SKILL.md parses the subcommands continue / status / list and a "<description>"', () => {
  const content = readSkillMd();
  assert.match(content, /\bcontinue\b/, 'expected the "continue" subcommand to be documented');
  assert.match(content, /\bstatus\b/, 'expected the "status" subcommand to be documented');
  assert.match(content, /\blist\b/, 'expected the "list" subcommand to be documented');
  assert.match(
    content,
    /\/debug\s+"<description>"|\/debug\s+"[^"]+"/,
    'expected /debug "<description>" invocation to be documented'
  );
});

test('SKILL.md parses the --diagnose flag', () => {
  const content = readSkillMd();
  assert.match(content, /--diagnose/, 'expected the --diagnose flag to be documented');
  assert.match(
    content,
    /--diagnose[\s\S]*diagnose/i,
    'expected --diagnose to map to the diagnose mode'
  );
});

test('SKILL.md routes status and list to debug-session.js WITHOUT dispatching a Task', () => {
  const content = readSkillMd();
  assert.match(
    content,
    /debug-session\.js\s+status/,
    'expected status to invoke debug-session.js status'
  );
  assert.match(
    content,
    /debug-session\.js\s+list/,
    'expected list to invoke debug-session.js list'
  );
  // The prose must be explicit that status/list do NOT dispatch Task(debugger).
  assert.match(
    content,
    /(status|list)[\s\S]*(no|without|never|do(?:es)? not)[\s\S]*Task\(debugger\)/i,
    'expected status/list to explicitly NOT dispatch Task(debugger)'
  );
});

test('SKILL.md runs debug-session.js init then dispatches Task(debugger) mode investigate', () => {
  const content = readSkillMd();
  assert.match(
    content,
    /debug-session\.js\s+init/,
    'expected /debug "<description>" to run debug-session.js init'
  );
  assert.match(content, /Task\(debugger\)/, 'expected a Task(debugger) dispatch');
  assert.match(
    content,
    /\binvestigate\b/,
    'expected the investigate mode to be passed to the agent'
  );
});

test('SKILL.md continue verifies an active session then dispatches Task(debugger) mode continue', () => {
  const content = readSkillMd();
  assert.match(
    content,
    /continue[\s\S]*active/i,
    'expected continue to verify the session is active'
  );
  assert.match(
    content,
    /continue[\s\S]*Task\(debugger\)|Task\(debugger\)[\s\S]*continue/i,
    'expected continue to dispatch Task(debugger) mode continue'
  );
});

test('SKILL.md continue-guard parses the status VALUE and only dispatches when exactly active', () => {
  const content = readSkillMd();
  // Isolate the `/debug continue` section (up to the next `## ` heading) so the
  // assertions pin the guard prose itself, not incidental matches elsewhere.
  const section = content.slice(content.indexOf('### `/debug continue`'));
  const continueSection = section.slice(0, section.indexOf('\n## '));
  assert.ok(continueSection.length > 0, 'expected a /debug continue section');

  // The guard must capture the status VALUE, not rely on the exit code alone.
  assert.match(
    continueSection,
    /status:/,
    'expected the guard to parse the `status:` value from the helper output'
  );
  assert.match(
    continueSection,
    /exit code|exit `?0`?/i,
    'expected the guard to call out that a success exit is not proof of resumability'
  );
  assert.match(
    continueSection,
    /only when[\s\S]*active|exactly[\s\S]*active/i,
    'expected the guard to dispatch ONLY when the status value is exactly active'
  );

  // The guard must stop (not dispatch) on every terminal status.
  for (const terminal of ['resolved', 'diagnosed', 'abandoned']) {
    assert.match(
      continueSection,
      new RegExp(terminal),
      `expected the guard to name the terminal status "${terminal}"`
    );
  }
  assert.match(
    continueSection,
    /stop[\s\S]*without[\s\S]*dispatch|without dispatching|report[\s\S]*stop/i,
    'expected the guard to report and STOP (no dispatch) on a terminal status'
  );
});

test('SKILL.md has a Task(debugger) dispatch block for investigate/diagnose/continue', () => {
  const content = readSkillMd();
  assert.match(content, /Task\(debugger\)/, 'expected a Task(debugger) dispatch block');
  assert.match(content, /\bmode\b/i, 'expected the dispatch block to pass a mode');
  assert.match(content, /\bdiagnose\b/, 'expected the dispatch block to cover diagnose');
});

test('SKILL.md states the skill body does not read investigation files itself', () => {
  const content = readSkillMd();
  assert.match(
    content,
    /(do(?:es)? not|never|no(?:t)?)\s+read[\s\S]*investigation/i,
    'expected the isolation note that the skill body does not read investigation files'
  );
  assert.match(
    content,
    /lean|isolat/i,
    'expected the rationale that the isolated Task keeps the main session lean'
  );
});
