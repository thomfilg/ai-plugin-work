#!/usr/bin/env node

/**
 * Determines which developer agents should be involved in code review
 * based on the affected files.
 *
 * Usage: node check-determine-developers.js '<AFFECTED_FILES_JSON>'
 *
 * Input: JSON object with structure:
 *   {
 *     "apps": { "app-name": ["file1.ts", "file2.tsx"] },
 *     "packages": ["packages/ui/src/Button.tsx"]
 *   }
 *
 * Output: JSON object with structure:
 *   {
 *     "developers": ["developer-nodejs-tdd", "developer-react-senior"],
 *     "hasBackend": true,
 *     "hasFrontend": true,
 *     "hasDevOps": false,
 *     "needsConsensus": true
 *   }
 */

const affectedFilesJson = process.argv[2];

if (!affectedFilesJson) {
  console.error("Usage: node check-determine-developers.js '<AFFECTED_FILES_JSON>'");
  process.exit(1);
}

let affectedFiles;
try {
  affectedFiles = JSON.parse(affectedFilesJson);
} catch (e) {
  console.error('Invalid JSON:', e.message);
  process.exit(1);
}

// Backend patterns (support both src/ and app/ for Remix apps)
const backendPatterns = [
  /apps\/.*-worker\//, // Worker apps
  /(src|app)\/routes\/api\//, // API routes (both conventions)
  /(src|app)\/api\//, // API handlers
  /(src|app)\/services\//, // Backend services
  /(src|app)\/controllers\//, // Controllers
  /(src|app)\/middleware\//, // Middleware
  /models\/.*\.server\.(ts|js)$/, // Server-side models (Remix convention)
  /\.sql$/, // SQL files
  /migrations\//, // Database migrations
  /packages\/database\//, // Database package
  /packages\/queue\//, // Queue package
  /packages\/api-client\//, // API client package
  /packages\/shared-backend\//, // Shared backend package
  // Test folders - backend
  /tests\/integration\//, // Integration tests (usually backend)
  /tests\/smoke\/.*api/i, // API smoke tests
  /\.server\.test\.(ts|js)$/, // Server-side test files
];

// Frontend patterns (support both src/ and app/ for Remix apps)
const frontendPatterns = [
  /apps\/.*\/(src|app)\/.*\.tsx$/, // React components (both conventions)
  /apps\/.*\/(src|app)\/.*\.css$/, // Styles
  /apps\/.*\/(src|app)\/.*\.scss$/, // SCSS styles
  /apps\/.*\/(src|app)\/components\//, // Component folders
  /apps\/.*\/(src|app)\/pages\//, // Page components
  /apps\/.*\/(src|app)\/hooks\//, // React hooks
  /apps\/.*\/(src|app)\/routes\/(?!api)/, // Non-API routes (page routes in Remix)
  /packages\/ui\//, // UI package
  /packages\/shared-ui\//, // Shared UI package
  // Test folders - frontend
  /tests\/e2e\//, // E2E tests (browser/UI tests)
  /\.test\.tsx$/, // React component tests
  /\.spec\.tsx$/, // React component specs
];

// DevOps patterns
const devopsPatterns = [
  /\.github\/workflows\//, // GitHub Actions
  /Dockerfile/, // Docker files
  /docker-compose/, // Docker Compose
  /terraform\//, // Terraform
  /\.gitlab-ci/, // GitLab CI
  /Makefile/, // Makefiles
  /scripts\/deploy/, // Deploy scripts
  /infra\//, // Infrastructure
  /k8s\//, // Kubernetes
  /\.env\.example/, // Environment examples
  /nginx/, // Nginx configs
];

// Collect all affected files into a flat array
function getAllFiles(affectedFiles) {
  const allFiles = [];

  // Add app files
  if (affectedFiles.apps) {
    for (const [appName, files] of Object.entries(affectedFiles.apps)) {
      if (Array.isArray(files)) {
        // Prefix with app name for pattern matching
        files.forEach((f) => allFiles.push(`apps/${appName}/${f}`));
      }
    }
  }

  // Add package files
  if (Array.isArray(affectedFiles.packages)) {
    allFiles.push(...affectedFiles.packages);
  }

  return allFiles;
}

// Check if any file matches patterns
function matchesPatterns(files, patterns) {
  return files.some((f) => patterns.some((p) => p.test(f)));
}

// Check for worker apps specifically
function hasWorkerApps(affectedFiles) {
  if (!affectedFiles.apps) return false;
  return Object.keys(affectedFiles.apps).some((appName) => appName.includes('worker'));
}

// Main logic
const allFiles = getAllFiles(affectedFiles);

const hasBackend = hasWorkerApps(affectedFiles) || matchesPatterns(allFiles, backendPatterns);
const hasFrontend = matchesPatterns(allFiles, frontendPatterns);
const hasDevOps = matchesPatterns(allFiles, devopsPatterns);

const developers = [];

if (hasBackend) developers.push('developer-nodejs-tdd');
if (hasFrontend) developers.push('developer-react-senior');
if (hasDevOps) developers.push('developer-devops');

// If no specific patterns matched, default based on file extensions
if (developers.length === 0) {
  const hasTs = allFiles.some((f) => /\.(ts|tsx)$/.test(f));
  const hasTsx = allFiles.some((f) => /\.tsx$/.test(f));

  if (hasTsx) {
    developers.push('developer-react-senior');
  } else if (hasTs) {
    developers.push('developer-nodejs-tdd');
  }
}

// If still no developers, default to nodejs-tdd
if (developers.length === 0) {
  developers.push('developer-nodejs-tdd');
}

const result = {
  developers,
  hasBackend,
  hasFrontend,
  hasDevOps,
  needsConsensus: developers.length > 1,
  fileCount: allFiles.length,
  summary:
    developers.length === 1
      ? `Single developer: ${developers[0]}`
      : `Multiple developers (consensus required): ${developers.join(', ')}`,
};

console.log(JSON.stringify(result, null, 2));
