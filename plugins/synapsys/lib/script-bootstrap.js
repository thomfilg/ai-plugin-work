'use strict';

/**
 * Shared script bootstrap for synapsys CLI tools.
 *
 * Re-exports the common modules every script needs and provides `setupCli()`
 * which parses process.argv flags and resolves cwd in one call. Lets scripts
 * keep a one-liner setup section so jscpd doesn't flag identical require
 * blocks as duplicate-blocks.
 *
 * Usage:
 *   const {
 *     fs, path, discoverStores, listMemories, setupCli,
 *   } = require('../lib/script-bootstrap');
 *   const { flag, cwd } = setupCli();
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { makeFlag } = require(path.join(__dirname, 'cli-args'));
const {
  MARKER,
  FOLDER,
  candidateStores,
  discoverStores,
  listMemories,
  listMemoriesFromStore,
  getProjectName,
  parseFrontmatter,
  safeExec,
} = require(path.join(__dirname, 'memory-store'));

function setupCli() {
  const flag = makeFlag(process.argv.slice(2));
  return { flag, cwd: flag('cwd') || process.cwd() };
}

module.exports = {
  fs,
  os,
  path,
  execSync,
  makeFlag,
  setupCli,
  MARKER,
  FOLDER,
  candidateStores,
  discoverStores,
  listMemories,
  listMemoriesFromStore,
  getProjectName,
  parseFrontmatter,
  safeExec,
};
