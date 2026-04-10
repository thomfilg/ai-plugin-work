#!/usr/bin/env node
/**
 * Symlink Helper Script (Project-Agnostic)
 *
 * Creates proper symlinks for git worktrees by detecting the current directory,
 * finding the main worktree, and creating correct symlinks.
 *
 * Works with any git repository that uses worktrees.
 *
 * Usage:
 *   node symlink.js                    # Auto-detect and fix all .env symlinks
 *   node symlink.js --check            # Check symlinks without fixing
 *   node symlink.js --env              # Fix .env symlinks only
 *   node symlink.js --claude           # Fix .claude symlink only
 *   node symlink.js --dry-run          # Show what would be done without making changes
 *   node symlink.js --main <path>      # Specify main worktree path explicitly
 *
 * Auto-detection:
 *   - Uses `git worktree list` to find all worktrees
 *   - The main worktree is detected by:
 *     1. The one without a ticket/branch suffix (shortest directory name)
 *     2. Or the first worktree in the list (git's default behavior)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

/**
 * Execute a command and return the output
 */
function exec(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8' }).trim();
  } catch (error) {
    return null;
  }
}

/**
 * Get the current worktree root directory
 */
function getWorktreeRoot() {
  const root = exec('git rev-parse --show-toplevel');
  if (!root) {
    console.error('Error: Not in a git repository');
    process.exit(1);
  }
  return root;
}

/**
 * Get all worktrees for the current repository
 */
function getWorktrees() {
  const output = exec('git worktree list --porcelain');
  if (!output) {
    console.error('Error: Could not list worktrees');
    process.exit(1);
  }

  const worktrees = [];
  let current = {};

  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      current.path = line.substring(9);
    } else if (line.startsWith('HEAD ')) {
      current.head = line.substring(5);
    } else if (line.startsWith('branch ')) {
      current.branch = line.substring(7);
    } else if (line === 'bare') {
      current.bare = true;
    } else if (line === 'detached') {
      current.detached = true;
    } else if (line === '') {
      if (current.path) {
        worktrees.push(current);
      }
      current = {};
    }
  }

  // Push last entry if exists
  if (current.path) {
    worktrees.push(current);
  }

  return worktrees;
}

/**
 * Detect the main worktree from the list of worktrees
 * Strategy: The main worktree typically has the shortest directory name
 * (e.g., "my-project" vs "my-project-PROJ-123")
 */
function detectMainWorktree(worktrees, currentRoot) {
  if (worktrees.length === 0) {
    return null;
  }

  if (worktrees.length === 1) {
    return worktrees[0].path;
  }

  // Sort by length - shortest is likely the main worktree
  const sorted = [...worktrees].sort((a, b) => {
    const aName = path.basename(a.path);
    const bName = path.basename(b.path);
    return aName.length - bName.length;
  });

  // Check if the shortest one is on main/master branch
  const shortest = sorted[0];
  if (
    shortest.branch &&
    (shortest.branch === 'refs/heads/main' || shortest.branch === 'refs/heads/master')
  ) {
    return shortest.path;
  }

  // Fallback: Look for one without ticket-like suffix
  const ticketPattern = /-[A-Z]+-\d+/;
  for (const wt of sorted) {
    const basename = path.basename(wt.path);
    if (!ticketPattern.test(basename)) {
      return wt.path;
    }
  }

  // Last fallback: return the shortest path
  return sorted[0].path;
}

/**
 * Check if the current directory is the main worktree
 */
function isMainWorktree(worktreeRoot, mainWorktreePath) {
  return path.resolve(worktreeRoot) === path.resolve(mainWorktreePath);
}

/**
 * Find all .env files in the main worktree's apps directory
 */
function findMainEnvFiles(mainWorktreePath) {
  const appsDir = path.join(mainWorktreePath, 'apps');
  const envFiles = [];

  if (!fs.existsSync(appsDir)) {
    // No apps directory - might be a different project structure
    // Try to find .env in root
    const rootEnv = path.join(mainWorktreePath, '.env');
    if (fs.existsSync(rootEnv)) {
      return [{ relativePath: '.env', sourcePath: rootEnv }];
    }
    return envFiles;
  }

  try {
    const appDirs = fs.readdirSync(appsDir, { withFileTypes: true });
    for (const dirent of appDirs) {
      if (dirent.isDirectory()) {
        const envPath = path.join(appsDir, dirent.name, '.env');
        if (fs.existsSync(envPath)) {
          envFiles.push({
            appName: dirent.name,
            relativePath: path.join('apps', dirent.name, '.env'),
            sourcePath: envPath,
          });
        }
      }
    }
  } catch (error) {
    console.error(`Error reading apps directory: ${error.message}`);
  }

  return envFiles;
}

/**
 * Check symlink status for a target path
 */
function checkSymlink(targetPath) {
  try {
    const stats = fs.lstatSync(targetPath);
    if (stats.isSymbolicLink()) {
      const linkTarget = fs.readlinkSync(targetPath);
      const resolvedPath = path.resolve(path.dirname(targetPath), linkTarget);
      const exists = fs.existsSync(resolvedPath);
      return {
        exists: true,
        isSymlink: true,
        linkTarget,
        resolvedPath,
        targetExists: exists,
      };
    } else {
      return {
        exists: true,
        isSymlink: false,
        isFile: stats.isFile(),
        isDirectory: stats.isDirectory(),
      };
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { exists: false, isSymlink: false };
    }
    throw error;
  }
}

/**
 * Create or fix a symlink using absolute path
 */
function createSymlink(targetPath, sourcePath, dryRun = false) {
  const status = checkSymlink(targetPath);

  // If it's already a valid symlink to the correct target, skip
  if (status.isSymlink && status.targetExists) {
    const currentResolved = status.resolvedPath;
    if (path.resolve(currentResolved) === path.resolve(sourcePath)) {
      return { action: 'skip', reason: 'Already correctly linked' };
    }
  }

  // If symlink exists but is broken or wrong, remove it
  if (status.isSymlink) {
    if (!dryRun) {
      fs.unlinkSync(targetPath);
    }
    console.log(
      `  ${dryRun ? 'Would remove' : 'Removing'} broken/incorrect symlink: ${targetPath}`
    );
  }

  // If a regular file exists, don't overwrite
  if (status.exists && !status.isSymlink) {
    return { action: 'skip', reason: 'Regular file exists (not overwriting)' };
  }

  // Create the symlink using absolute path
  if (!dryRun) {
    // Ensure parent directory exists
    const parentDir = path.dirname(targetPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }
    fs.symlinkSync(sourcePath, targetPath);
  }

  return { action: dryRun ? 'would_create' : 'created', sourcePath };
}

/**
 * Fix .env symlinks in the current worktree
 */
function fixEnvSymlinks(worktreeRoot, mainWorktreePath, dryRun = false) {
  console.log('\n📁 Fixing .env symlinks...\n');

  const mainEnvFiles = findMainEnvFiles(mainWorktreePath);

  if (mainEnvFiles.length === 0) {
    console.log('  No .env files found in main worktree');
    return [];
  }

  const results = [];

  for (const envFile of mainEnvFiles) {
    const targetPath = path.join(worktreeRoot, envFile.relativePath);
    const targetDir = path.dirname(targetPath);

    // Skip if target directory doesn't exist in this worktree
    if (!fs.existsSync(targetDir)) {
      results.push({
        relativePath: envFile.relativePath,
        status: 'skipped',
        reason: 'Directory does not exist in worktree',
      });
      continue;
    }

    const result = createSymlink(targetPath, envFile.sourcePath, dryRun);
    results.push({ relativePath: envFile.relativePath, targetPath, ...result });

    if (result.action === 'created') {
      console.log(`  ✅ ${envFile.relativePath}: Created symlink`);
      console.log(`     ${targetPath} -> ${envFile.sourcePath}`);
    } else if (result.action === 'would_create') {
      console.log(`  🔍 ${envFile.relativePath}: Would create symlink`);
      console.log(`     ${targetPath} -> ${envFile.sourcePath}`);
    } else if (result.action === 'skip') {
      console.log(`  ⏭️  ${envFile.relativePath}: ${result.reason}`);
    }
  }

  return results;
}

/**
 * Fix .claude symlink in the current worktree
 */
function fixClaudeSymlink(worktreeRoot, mainWorktreePath, dryRun = false) {
  console.log('\n📁 Fixing .claude symlink...\n');

  const targetPath = path.join(worktreeRoot, '.claude');
  const sourcePath = path.join(mainWorktreePath, '.claude');

  // Check if .claude exists in main worktree
  if (!fs.existsSync(sourcePath)) {
    console.log('  ⏭️  .claude: Does not exist in main worktree');
    return { action: 'skip', reason: 'Source does not exist' };
  }

  const result = createSymlink(targetPath, sourcePath, dryRun);

  if (result.action === 'created') {
    console.log(`  ✅ .claude: Created symlink`);
    console.log(`     ${targetPath} -> ${sourcePath}`);
  } else if (result.action === 'would_create') {
    console.log(`  🔍 .claude: Would create symlink`);
    console.log(`     ${targetPath} -> ${sourcePath}`);
  } else if (result.action === 'skip') {
    console.log(`  ⏭️  .claude: ${result.reason}`);
  }

  return result;
}

/**
 * Check all symlinks without fixing
 */
function checkAllSymlinks(worktreeRoot, mainWorktreePath) {
  console.log('\n🔍 Checking symlinks...\n');

  // Check .claude symlink
  const claudePath = path.join(worktreeRoot, '.claude');
  const claudeSourcePath = path.join(mainWorktreePath, '.claude');
  const claudeStatus = checkSymlink(claudePath);

  console.log('.claude:');
  if (claudeStatus.isSymlink) {
    console.log(`  Symlink: ${claudeStatus.linkTarget}`);
    console.log(`  Resolves to: ${claudeStatus.resolvedPath}`);
    console.log(`  Target exists: ${claudeStatus.targetExists ? '✅' : '❌'}`);
    if (
      claudeStatus.targetExists &&
      path.resolve(claudeStatus.resolvedPath) === path.resolve(claudeSourcePath)
    ) {
      console.log(`  Correct: ✅`);
    } else if (claudeStatus.targetExists) {
      console.log(`  Correct: ⚠️  Points to different location`);
      console.log(`  Expected: ${claudeSourcePath}`);
    } else {
      console.log(`  Correct: ❌ Broken symlink`);
    }
  } else if (claudeStatus.exists) {
    console.log(`  Status: Regular ${claudeStatus.isDirectory ? 'directory' : 'file'}`);
  } else {
    console.log('  Status: Does not exist');
  }

  // Check .env symlinks
  const mainEnvFiles = findMainEnvFiles(mainWorktreePath);
  console.log('\n.env files:');

  if (mainEnvFiles.length === 0) {
    console.log('  No .env files found in main worktree');
    return;
  }

  for (const envFile of mainEnvFiles) {
    const targetPath = path.join(worktreeRoot, envFile.relativePath);
    const status = checkSymlink(targetPath);

    console.log(`\n  ${envFile.relativePath}:`);
    if (status.isSymlink) {
      console.log(`    Symlink: ${status.linkTarget}`);
      console.log(`    Resolves to: ${status.resolvedPath}`);
      console.log(`    Target exists: ${status.targetExists ? '✅' : '❌'}`);
      if (
        status.targetExists &&
        path.resolve(status.resolvedPath) === path.resolve(envFile.sourcePath)
      ) {
        console.log(`    Correct: ✅`);
      } else if (status.targetExists) {
        console.log(`    Correct: ⚠️  Points to different file`);
        console.log(`    Expected: ${envFile.sourcePath}`);
      } else {
        console.log(`    Correct: ❌ Broken symlink`);
      }
    } else if (status.exists) {
      console.log(`    Status: Regular file`);
    } else {
      console.log(`    Status: Does not exist`);
    }
  }
}

/**
 * Parse command line arguments
 */
function parseArgs(args) {
  const options = {
    check: false,
    envOnly: false,
    claudeOnly: false,
    dryRun: false,
    mainPath: null,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--check') {
      options.check = true;
    } else if (arg === '--env') {
      options.envOnly = true;
    } else if (arg === '--claude') {
      options.claudeOnly = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--main' && args[i + 1]) {
      options.mainPath = args[++i];
    }
  }
  // Available flags: --check, --env, --claude, --dry-run, --main <path>

  return options;
}

/**
 * Main function
 */
function main() {
  const args = process.argv.slice(2);
  const options = parseArgs(args);

  // TODO: Add tests for worktree detection and symlink operations
  const worktreeRoot = getWorktreeRoot();
  console.log(`\n📂 Current worktree: ${worktreeRoot}`);

  // Detect or use specified main worktree
  let mainWorktreePath;
  if (options.mainPath) {
    mainWorktreePath = path.resolve(options.mainPath);
    console.log(`📂 Main worktree (specified): ${mainWorktreePath}`);
  } else {
    const worktrees = getWorktrees();
    mainWorktreePath = detectMainWorktree(worktrees, worktreeRoot);
    console.log(`📂 Main worktree (detected): ${mainWorktreePath}`);
    console.log(`📂 Total worktrees: ${worktrees.length}`);
  }

  if (!mainWorktreePath) {
    console.error('Error: Could not detect main worktree');
    process.exit(1);
  }

  if (!fs.existsSync(mainWorktreePath)) {
    console.error(`Error: Main worktree path does not exist: ${mainWorktreePath}`);
    process.exit(1);
  }

  if (isMainWorktree(worktreeRoot, mainWorktreePath)) {
    console.log('\n⚠️  You are in the main worktree. No symlinks needed.');
    process.exit(0);
  }

  console.log(`📂 This is a feature worktree: ${path.basename(worktreeRoot)}`);

  if (options.check) {
    checkAllSymlinks(worktreeRoot, mainWorktreePath);
    return;
  }

  if (options.dryRun) {
    console.log('\n🔍 DRY RUN - No changes will be made\n');
  }

  if (!options.claudeOnly) {
    fixEnvSymlinks(worktreeRoot, mainWorktreePath, options.dryRun);
  }

  if (!options.envOnly) {
    fixClaudeSymlink(worktreeRoot, mainWorktreePath, options.dryRun);
  }

  console.log('\n✅ Done!\n');
}

main();
