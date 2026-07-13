'use strict';

/**
 * skill-files — shared SKILL.md discovery for the WP-10 skill-surface tools
 * (lint-skill-frontmatter, codemod-plugin-root-preamble).
 *
 * Walks `plugins/<plugin>/skills/**` recursively (codex discovers nested
 * SKILL.md files — GT §3.2), pruning node_modules and dot-directories.
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..', '..');

function readDirSafe(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function collectSkillMd(dir, out) {
  for (const ent of readDirSafe(dir)) {
    if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) collectSkillMd(full, out);
    else if (ent.isFile() && ent.name === 'SKILL.md') out.push(full);
  }
}

/**
 * Every `SKILL.md` under `plugins/<plugin>/skills/`, sorted, absolute paths.
 */
function listSkillFiles(repoRoot = REPO_ROOT) {
  const out = [];
  const pluginsDir = path.join(repoRoot, 'plugins');
  for (const ent of readDirSafe(pluginsDir)) {
    if (!ent.isDirectory()) continue;
    collectSkillMd(path.join(pluginsDir, ent.name, 'skills'), out);
  }
  return out.sort();
}

module.exports = { REPO_ROOT, listSkillFiles };
