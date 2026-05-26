'use strict';

/**
 * Registry of per-agent hook scripts for plugin-bundled agents.
 *
 * Plugin subagents cannot use the `hooks:` field in markdown frontmatter
 * (Claude Code strips it for security). This registry is the dispatcher's
 * substitute: it maps agent name -> hook type -> list of entries to run
 * when that agent is the active subagent.
 *
 * Entry shape:
 *   {
 *     matcher?: string,    // regex tested against tool_name (omit for Stop / unconditional)
 *     type: 'node'|'shell',
 *     command: string,     // node: path relative to plugin root; shell: literal sh -c command
 *     optional?: boolean,  // when true, non-zero exit does not block; mirrors `|| true` suffix
 *   }
 *
 * Paths for `type: 'node'` are resolved relative to CLAUDE_PLUGIN_ROOT by the dispatcher.
 */

const REGISTRY = Object.freeze({
  'commit-writer': Object.freeze({
    PreToolUse: Object.freeze([
      Object.freeze({
        matcher: '.*',
        type: 'node',
        command: 'scripts/workflows/work/agents/commit-writer/commit-writer-block-write.js',
      }),
    ]),
    PostToolUse: Object.freeze([
      Object.freeze({
        matcher: 'Bash',
        type: 'node',
        command: 'scripts/workflows/work/agents/commit-writer/commit-writer-precommit-guard.js',
      }),
    ]),
  }),
  'pr-generator': Object.freeze({
    PreToolUse: Object.freeze([
      Object.freeze({
        matcher: 'Bash',
        type: 'node',
        command: 'scripts/workflows/work-pr/agents/pr-generator/pr-generator-readonly-guard.js',
      }),
    ]),
    Stop: Object.freeze([
      Object.freeze({
        type: 'node',
        command: 'scripts/workflows/work-pr/agents/pr-generator/pr-generator-validator.js',
      }),
    ]),
  }),
  'pr-post-generator': Object.freeze({
    Stop: Object.freeze([
      Object.freeze({
        type: 'node',
        command:
          'scripts/workflows/work-pr/agents/pr-post-generator/pr-post-generator-validator.js',
      }),
    ]),
  }),
  'pr-reviewer': Object.freeze({
    Stop: Object.freeze([
      Object.freeze({
        type: 'node',
        command: 'scripts/workflows/check/agents/pr-reviewer/pr-review-validator.js',
      }),
    ]),
  }),
  'qa-api-tester': Object.freeze({
    PreToolUse: Object.freeze([
      Object.freeze({
        matcher: '.*',
        type: 'shell',
        command:
          'node "$CLAUDE_PLUGIN_ROOT/scripts/workflows/check/agents/qa-api-tester/qa-api-active-marker.js" set',
        optional: true,
      }),
      Object.freeze({
        matcher: 'Read|Glob|Grep|Bash',
        type: 'node',
        command: 'scripts/workflows/check/agents/qa-feature-tester/qa-pretooluse-hooks.js',
        optional: true,
      }),
    ]),
    Stop: Object.freeze([
      Object.freeze({
        type: 'shell',
        command:
          'node "$CLAUDE_PLUGIN_ROOT/scripts/workflows/check/agents/qa-api-tester/qa-api-active-marker.js" clear',
        optional: true,
      }),
      Object.freeze({
        type: 'node',
        command: 'scripts/workflows/check/agents/qa-api-tester/validate-api-report.js',
        optional: true,
      }),
    ]),
  }),
  'qa-feature-tester': Object.freeze({
    PreToolUse: Object.freeze([
      Object.freeze({
        matcher: '.*',
        type: 'node',
        command: 'scripts/workflows/check/agents/qa-feature-tester/qa-agent-start.js',
      }),
      Object.freeze({
        matcher: 'Read|Glob|Grep|Bash',
        type: 'node',
        command: 'scripts/workflows/check/agents/qa-feature-tester/qa-pretooluse-hooks.js',
      }),
      Object.freeze({
        matcher: 'mcp__playwright__browser_take_screenshot',
        type: 'node',
        command: 'scripts/workflows/check/agents/qa-feature-tester/screenshot-naming.js',
      }),
    ]),
    PostToolUse: Object.freeze([
      Object.freeze({
        matcher: 'mcp__playwright__browser_navigate|mcp__claude-in-chrome__navigate',
        type: 'node',
        command: 'scripts/workflows/check/agents/qa-feature-tester/track-navigated-url.js',
      }),
      Object.freeze({
        matcher: 'mcp__playwright__browser_take_screenshot',
        type: 'node',
        command: 'scripts/workflows/check/agents/qa-feature-tester/screenshot-size-validator.js',
      }),
      Object.freeze({
        matcher:
          'mcp__playwright__browser_snapshot|mcp__claude-in-chrome__read_page|mcp__claude-in-chrome__get_page_text|mcp__chrome-devtools__take_snapshot',
        type: 'node',
        command: 'scripts/workflows/check/agents/qa-feature-tester/qa-screenshot-validator.js',
      }),
    ]),
    Stop: Object.freeze([
      Object.freeze({
        type: 'shell',
        command: 'rm -f /tmp/qa-agent-active',
        optional: true,
      }),
      Object.freeze({
        type: 'node',
        command: 'scripts/workflows/check/agents/qa-feature-tester/qa-subagent-stop.js',
      }),
      Object.freeze({
        type: 'node',
        command: 'scripts/workflows/check/agents/qa-feature-tester/validate-qa-report.js',
      }),
    ]),
  }),
});

module.exports = { REGISTRY };
