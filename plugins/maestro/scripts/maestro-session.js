#!/usr/bin/env node
/**
 * maestro-session.js — manifest for an active orchestration session.
 *
 * Persists the orchestrator's plan when launching N parallel agents over M
 * tasks: the ordered task list (by priority), dependency graph, slot count,
 * and per-task status. Survives orchestrator restart, drives the
 * SessionStart reminder so a fresh session doesn't accidentally start a
 * parallel orchestration or forget the priority/dep plan.
 *
 * Storage: one JSON file per topic under MAESTRO_SESSION_DIR
 *          (default ~/.cache/maestro/sessions).
 *
 * Schema:
 *   {
 *     topic: string,                 // e.g. "claude-plugin-work-bugs-2026-06"
 *     slots: number,                 // parallel agent cap (the N)
 *     createdAt: ISO,
 *     tasks: [{
 *       id: string,                  // e.g. "GH-498"
 *       priority: number,            // lower = earlier; 1 is highest
 *       deps: string[],              // task ids that must be 'done' first
 *       status: 'pending'|'in_progress'|'done'|'blocked',
 *       updatedAt?: ISO,
 *       note?: string,
 *     }, ...]
 *   }
 *
 * CLI:
 *   init <topic> <slots> <id>:<prio>[:dep,dep] ...    create
 *   show <topic>                                       print full session
 *   list                                               all active sessions
 *   summary                                            short status per session
 *   update <topic> <id> <status> [note]                update one task
 *   next <topic>                                       next eligible task
 *   clear <topic>                                      remove session file
 */
'use strict';

const fs = require('fs');
const path = require('path');

const shared = require('./lib/maestro-conduct/session-shared');
const { countByStatus, eligibleTasks, getSessionDir } = shared;
const VALID_STATUS = new Set(['pending', 'in_progress', 'done', 'blocked']);

function ensureDir() {
  fs.mkdirSync(getSessionDir(), { recursive: true });
}
function sessionPath(topic) {
  return path.join(getSessionDir(), `${topic}.json`);
}

function init(topic, slots, tasks) {
  if (!topic || !/^[A-Za-z0-9_.-]+$/.test(topic)) throw new Error(`bad topic: ${topic}`);
  if (!(slots > 0)) throw new Error(`slots must be > 0`);
  if (!tasks.length) throw new Error(`at least one task required`);
  // Validate dep references — every dep must be a task in the same session.
  const ids = new Set(tasks.map((t) => t.id));
  for (const t of tasks) {
    for (const d of t.deps || []) {
      if (!ids.has(d)) throw new Error(`task ${t.id} depends on unknown ${d}`);
    }
  }
  ensureDir();
  const session = {
    topic,
    slots,
    createdAt: new Date().toISOString(),
    tasks: tasks.map((t) => ({
      id: t.id,
      priority: typeof t.priority === 'number' ? t.priority : 999,
      deps: t.deps || [],
      status: 'pending',
    })),
  };
  fs.writeFileSync(sessionPath(topic), JSON.stringify(session, null, 2));
  return session;
}

function read(topic) {
  try {
    return JSON.parse(fs.readFileSync(sessionPath(topic), 'utf8'));
  } catch {
    return null;
  }
}

function update(topic, taskId, status, note) {
  if (!VALID_STATUS.has(status)) throw new Error(`bad status: ${status}`);
  const s = read(topic);
  if (!s) throw new Error(`no session: ${topic}`);
  const t = s.tasks.find((x) => x.id === taskId);
  if (!t) throw new Error(`no task ${taskId} in ${topic}`);
  t.status = status;
  t.updatedAt = new Date().toISOString();
  if (note) t.note = note;
  fs.writeFileSync(sessionPath(topic), JSON.stringify(s, null, 2));
  return t;
}

function list() {
  const dir = getSessionDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

function nextEligible(topic) {
  const s = read(topic);
  if (!s) return null;
  return eligibleTasks(s.tasks)[0] || null;
}

function summarize(s) {
  const counts = countByStatus(s.tasks);
  return (
    `${s.topic}: slots=${s.slots} | ${counts.in_progress} in flight, ${counts.done}/${s.tasks.length} done, ${counts.pending} pending` +
    (counts.blocked ? `, ${counts.blocked} blocked` : '')
  );
}

function printSummary() {
  const sessions = list();
  if (!sessions.length) {
    console.log('No active maestro sessions.');
    return;
  }
  for (const s of sessions) console.log(summarize(s));
}

function clear(topic) {
  try {
    fs.unlinkSync(sessionPath(topic));
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  init,
  read,
  update,
  list,
  nextEligible,
  summarize,
  clear,
  get SESSION_DIR() {
    return getSessionDir();
  },
  sessionPath,
};

if (require.main === module) {
  const [, , cmd, ...args] = process.argv;
  try {
    switch (cmd) {
      case 'init': {
        const [topic, slotsStr, ...taskSpecs] = args;
        const slots = parseInt(slotsStr, 10);
        const tasks = taskSpecs.map((spec) => {
          const [id, prio, deps] = spec.split(':');
          return {
            id,
            priority: parseInt(prio, 10),
            deps: deps ? deps.split(',').filter(Boolean) : [],
          };
        });
        console.log(JSON.stringify(init(topic, slots, tasks), null, 2));
        break;
      }
      case 'show':
        console.log(JSON.stringify(read(args[0]), null, 2));
        break;
      case 'list':
        console.log(JSON.stringify(list(), null, 2));
        break;
      case 'summary':
        printSummary();
        break;
      case 'update':
        update(args[0], args[1], args[2], args.slice(3).join(' ') || undefined);
        console.log('ok');
        break;
      case 'next':
        console.log(JSON.stringify(nextEligible(args[0]), null, 2));
        break;
      case 'clear':
        console.log(clear(args[0]) ? 'cleared' : 'not found');
        break;
      default:
        console.error('usage: maestro-session.js <init|show|list|summary|update|next|clear> ...');
        process.exit(1);
    }
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
}
