#!/usr/bin/env node
'use strict';

/**
 * Lint a crystallize manifest before writing.
 *
 *   cat manifest.json | node synapsys-crystallize-lint.js
 *
 * Reads a manifest JSON object on stdin, runs the rule registry, and prints
 * `{manifest, warnings, errors}` JSON on stdout. Exits 0 when `errors` is
 * empty, else 1. Invalid JSON on stdin emits a `{rule:'parse', ...}` error
 * entry and exits 1.
 *
 * Rule registry shape (each entry):
 *   {
 *     id:       string,           // e.g. 'R1-short-token'
 *     severity: 'warn' | 'error',
 *     scope:    'memory' | 'manifest', // optional; defaults to 'memory'
 *     check:    (memoryOrManifest, ctx) => Array<{rule, memory?, message}>
 *   }
 *
 * Module exports `lint(manifest)`, `RULES`, and `STOP_WORDS` for the test
 * suite. The CLI entry point only runs when this file is invoked directly.
 */

const { STOP_WORDS } = require('../lib/lint-stopwords');
const { extractAlternationTokens } = require('../lib/shared/trigger-tokens');

const PERMISSIVE_PRETOOL = new Set(['Edit:.*', 'Write:.*', 'Bash:.*']);

/**
 * In-place auto-fix helper used by rules that mutate the working manifest
 * (e.g. R7-inject-full-too-long). The runner threads a single manifest
 * reference through all rules, so downstream consumers see the post-fix shape.
 */
function applyAutoFix(target, key, value) {
  target[key] = value;
}

function countSharedTokens(a, b) {
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared;
}

function r5Overlap(manifest) {
  const memories = Array.isArray(manifest.memories) ? manifest.memories : [];
  const sets = memories.map((m) => new Set(extractAlternationTokens(m.trigger_prompt)));
  const issues = [];
  for (let i = 0; i < memories.length; i++) {
    for (let j = i + 1; j < memories.length; j++) {
      const shared = countSharedTokens(sets[i], sets[j]);
      if (shared < 3) continue;
      const a = memories[i].name || `#${i}`;
      const b = memories[j].name || `#${j}`;
      issues.push({
        rule: 'R5-overlap',
        message: `memories "${a}" and "${b}" share ${shared} alternation tokens in trigger_prompt`,
      });
    }
  }
  return issues;
}

const RULES = [
  {
    id: 'R2-stopword',
    severity: 'error',
    scope: 'memory',
    check(memory) {
      const tp = memory.trigger_prompt;
      if (typeof tp !== 'string' || tp.length === 0) return [];
      // spec §Security: wrap RegExp parsing in try/catch; emit error rather than throw.
      try {
        // eslint-disable-next-line no-new
        new RegExp(tp);
      } catch (err) {
        return [
          {
            rule: 'parse',
            memory: memory.name,
            message: `trigger_prompt is not a valid regex: ${err.message}`,
          },
        ];
      }
      const tokens = extractAlternationTokens(tp);
      const hits = tokens.filter((t) => STOP_WORDS.has(t));
      return hits.map((t) => ({
        rule: 'R2-stopword',
        memory: memory.name,
        message: `trigger_prompt contains stop-word alternation token "${t}"`,
      }));
    },
  },
  {
    id: 'R1-short-token',
    severity: 'warn',
    scope: 'memory',
    check(memory) {
      const tokens = extractAlternationTokens(memory.trigger_prompt);
      const short = tokens.filter((t) => t.length < 4);
      if (short.length === 0) return [];
      return [
        {
          rule: 'R1-short-token',
          memory: memory.name,
          message: `trigger_prompt has short alternation token(s) (<4 chars): ${short.join(', ')}`,
        },
      ];
    },
  },
  {
    id: 'R3-unbounded-dotstar',
    severity: 'warn',
    scope: 'memory',
    check(memory) {
      const tp = memory.trigger_prompt;
      if (typeof tp !== 'string' || !tp.includes('.*')) return [];
      // Anchored uses: `^.*` or `.*$` are considered anchored.
      // Flag every `.*` occurrence that is not adjacent to an anchor.
      const issues = [];
      const dotstarRe = /\.\*/g;
      let m;
      while ((m = dotstarRe.exec(tp)) !== null) {
        const before = tp[m.index - 1];
        const after = tp[m.index + 2];
        const anchored = before === '^' || after === '$';
        if (!anchored) {
          issues.push({
            rule: 'R3-unbounded-dotstar',
            memory: memory.name,
            message: `trigger_prompt contains unbounded ".*" outside an anchor`,
          });
          break;
        }
      }
      return issues;
    },
  },
  {
    id: 'R6-events-default',
    severity: 'warn',
    scope: 'memory',
    check(memory) {
      const events = Array.isArray(memory.events) ? memory.events : [];
      const eventSet = new Set(events);
      const isDefault =
        events.length === 2 && eventSet.has('UserPromptSubmit') && eventSet.has('PreToolUse');
      if (!isDefault) return [];
      const pretool = Array.isArray(memory.trigger_pretool) ? memory.trigger_pretool : [];
      const permissive = pretool.length === 0 || pretool.every((p) => PERMISSIVE_PRETOOL.has(p));
      if (!permissive) return [];
      return [
        {
          rule: 'R6-events-default',
          memory: memory.name,
          message:
            'events defaults to [UserPromptSubmit,PreToolUse] without a specific trigger_pretool — classifier matrix may have been skipped',
        },
      ];
    },
  },
  {
    id: 'R4-empty-pretool',
    severity: 'error',
    scope: 'memory',
    check(memory) {
      const events = Array.isArray(memory.events) ? memory.events : [];
      if (!events.includes('PreToolUse')) return [];
      const pretool = memory.trigger_pretool;
      const hasPretool = Array.isArray(pretool) && pretool.length > 0;
      if (hasPretool) return [];
      return [
        {
          rule: 'R4-empty-pretool',
          memory: memory.name,
          message: 'events includes "PreToolUse" but trigger_pretool is empty or missing',
        },
      ];
    },
  },
  {
    id: 'R9-pretool-malformed',
    severity: 'error',
    scope: 'memory',
    check(memory) {
      const pretool = Array.isArray(memory.trigger_pretool) ? memory.trigger_pretool : [];
      const malformedRe = /^[A-Z][A-Za-z]+:.+$/;
      const issues = [];
      for (const entry of pretool) {
        if (typeof entry !== 'string' || !malformedRe.test(entry)) {
          issues.push({
            rule: 'R9-pretool-malformed',
            memory: memory.name,
            message: `trigger_pretool entry "${entry}" does not match ^[A-Z][A-Za-z]+:.+$`,
          });
        }
      }
      return issues;
    },
  },
  {
    id: 'R5-overlap',
    severity: 'warn',
    scope: 'manifest',
    check: r5Overlap,
  },
  {
    id: 'R7-inject-full-too-long',
    severity: 'warn',
    scope: 'memory',
    check(memory) {
      if (memory.inject !== 'full') return [];
      const body = typeof memory.body === 'string' ? memory.body : '';
      if (body.split('\n').length <= 30) return [];
      applyAutoFix(memory, 'inject', 'summary');
      return [
        {
          rule: 'R7-inject-full-too-long',
          memory: memory.name,
          message: `memory "${memory.name}" inject=full with body > 30 lines auto-fixed to inject=summary`,
        },
      ];
    },
  },
  {
    id: 'R10-neg-without-pos',
    severity: 'warn',
    scope: 'memory',
    check(memory) {
      const neg = Array.isArray(memory.trigger_pretool_content_not)
        ? memory.trigger_pretool_content_not
        : [];
      if (neg.length === 0) return [];
      const pos = Array.isArray(memory.trigger_pretool_content)
        ? memory.trigger_pretool_content
        : [];
      if (pos.length > 0) return [];
      return [
        {
          rule: 'R10-neg-without-pos',
          memory: memory.name,
          message: `memory "${memory.name}" has trigger_pretool_content_not without a positive trigger_pretool_content — negative gate has nothing to gate`,
        },
      ];
    },
  },
  {
    id: 'R8-stop-without-retro',
    severity: 'warn',
    scope: 'memory',
    check(memory) {
      const body = typeof memory.body === 'string' ? memory.body : '';
      const events = Array.isArray(memory.events) ? memory.events : [];
      const hasStopEvent = events.includes('Stop');
      // Fire when the classifier assigned Stop (the retrospective channel) —
      // bodies of Stop-event memories should describe what to look for AFTER
      // the turn finishes. Body keywords like "after", "did I", "cleanup",
      // "retrospective" all signal retro intent and silence the warning.
      if (!hasStopEvent) return [];
      if (/\b(retro|retrospective|after|when finished|did i|cleanup)\b/i.test(body)) return [];
      return [
        {
          rule: 'R8-stop-without-retro',
          memory: memory.name,
          message:
            'memory has Stop event but body lacks retrospective guidance (retro/after/did I/cleanup)',
        },
      ];
    },
  },
];

/**
 * Run all rules against the manifest. Returns { manifest, warnings, errors }.
 * Some rules (e.g. R7) may mutate the manifest in-place; downstream consumers
 * see the post-fix shape.
 */
function runRule(rule, manifest) {
  const scope = rule.scope || 'memory';
  if (scope === 'manifest') return rule.check(manifest) || [];
  const issues = [];
  for (const memory of manifest.memories || []) {
    const out = rule.check(memory, { manifest }) || [];
    for (const entry of out) issues.push(entry);
  }
  return issues;
}

function lint(manifest) {
  const warnings = [];
  const errors = [];
  for (const rule of RULES) {
    const bucket = rule.severity === 'error' ? errors : warnings;
    for (const entry of runRule(rule, manifest)) bucket.push(entry);
  }
  return { manifest, warnings, errors };
}

async function readStdin() {
  process.stdin.setEncoding('utf8');
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return chunks.join('');
}

async function main() {
  const raw = await readStdin();
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (err) {
    const envelope = {
      manifest: null,
      warnings: [],
      errors: [{ rule: 'parse', message: `invalid JSON on stdin: ${err.message}` }],
    };
    process.stdout.write(JSON.stringify(envelope));
    process.exit(1);
  }

  const result = lint(manifest);
  process.stdout.write(JSON.stringify(result));
  process.exit(result.errors.length === 0 ? 0 : 1);
}

module.exports = { lint, RULES, STOP_WORDS };

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`fatal: ${err.message}\n`);
    process.exit(1);
  });
}
