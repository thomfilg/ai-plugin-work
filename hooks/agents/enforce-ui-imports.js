#!/usr/bin/env node

/**
 * PreToolUse hook to enforce UI component imports from project UI packages
 * instead of directly from @mui/material or other UI frameworks.
 *
 * This hook blocks imports when:
 * 1. UI documentation files exist in the repo (packages/ui/components-catalog.md)
 * 2. The file being edited is NOT in packages/ui or packages/shared-ui
 * 3. The content contains forbidden imports from @mui/material
 *
 * Allowed MUI imports (primitives only):
 * - Box, Stack, AppBar, Toolbar
 * - styled, useTheme, ThemeProvider
 * - Any import from @mui/icons-material
 */

const fs = require('fs');
const path = require('path');

// UI documentation files that indicate a project has its own UI package
const UI_DOC_FILES = [
  'packages/ui/components-catalog.md',
  'packages/ui/README.md',
  'packages/shared-ui/README.md',
  'docs/ui-component-examples.md',
  'docs/ui-component-variations.md'
];

// Folders where ALL MUI imports are allowed (building the core UI foundation)
const FULLY_ALLOWED_FOLDERS = [
  'packages/ui'
];

// Folders with expanded primitives (building app-shell components)
const SHARED_UI_FOLDERS = [
  'packages/shared-ui'
];

// Known UI frameworks that should be checked
const UI_FRAMEWORKS = [
  '@mui/material',
  '@chakra-ui/react',
  'antd',
  '@mantine/core',
  '@fluentui/react'
];

// Allowed MUI imports for apps (only true primitives/utilities - no components with UI)
const ALLOWED_MUI_IMPORTS_APPS = [
  // Layout primitives only
  'Box',
  'Stack',
  // Styling utilities
  'styled',
  'useTheme',
  'ThemeProvider',
  'createTheme',
  'CssBaseline',
  'GlobalStyles',
  'ScopedCssBaseline',
  // System utilities
  'useMediaQuery',
  'alpha',
  'darken',
  'lighten',
  'emphasize',
  'getContrastRatio',
  // Types are allowed
  'SxProps',
  'Theme',
  'Palette',
  'PaletteColor',
  'TypographyVariant'
];

// Expanded allowed MUI imports for shared-ui (app-shell layout primitives)
// These are needed for building Header, Footer, Layout components
const ALLOWED_MUI_IMPORTS_SHARED_UI = [
  ...ALLOWED_MUI_IMPORTS_APPS,
  // App shell layout components (not available in ui package)
  'AppBar',
  'Toolbar',
  'Container',
  'Grid',
  'Grid2',
  // Loading indicators for Header
  'LinearProgress',
  'CircularProgress',
  // IconButton for Header actions
  'IconButton',
  // Divider for layout separation
  'Divider'
];

/**
 * Find the git root directory
 */
function findGitRoot(startPath) {
  let currentPath = startPath;

  while (currentPath !== '/') {
    if (fs.existsSync(path.join(currentPath, '.git'))) {
      return currentPath;
    }
    currentPath = path.dirname(currentPath);
  }

  return null;
}

/**
 * Check if UI documentation files exist in the repository
 */
function hasUIDocumentation(gitRoot) {
  if (!gitRoot) return false;

  for (const docFile of UI_DOC_FILES) {
    const fullPath = path.join(gitRoot, docFile);
    if (fs.existsSync(fullPath)) {
      return true;
    }
  }

  return false;
}

/**
 * Check if the file path is within a fully allowed folder (packages/ui)
 */
function isInFullyAllowedFolder(filePath, gitRoot) {
  if (!gitRoot || !filePath) return false;

  const relativePath = path.relative(gitRoot, filePath);

  for (const folder of FULLY_ALLOWED_FOLDERS) {
    if (relativePath.startsWith(folder + '/') || relativePath.startsWith(folder + path.sep)) {
      return true;
    }
  }

  return false;
}

/**
 * Check if the file path is within shared-ui folder
 */
function isInSharedUIFolder(filePath, gitRoot) {
  if (!gitRoot || !filePath) return false;

  const relativePath = path.relative(gitRoot, filePath);

  for (const folder of SHARED_UI_FOLDERS) {
    if (relativePath.startsWith(folder + '/') || relativePath.startsWith(folder + path.sep)) {
      return true;
    }
  }

  return false;
}

/**
 * Extract forbidden imports from content
 * Returns array of { framework, components } objects
 * @param {string} content - The file content to check
 * @param {string[]} allowedImports - List of allowed import names
 */
function extractForbiddenImports(content, allowedImports) {
  const forbidden = [];

  // Match import statements from UI frameworks
  // Patterns:
  // - import { X, Y } from '@mui/material'
  // - import X from '@mui/material/X'
  // - import type { X } from '@mui/material' (allowed)

  for (const framework of UI_FRAMEWORKS) {
    // Pattern 1: Named imports - import { X, Y } from 'framework'
    const namedImportRegex = new RegExp(
      `import\\s+(?!type\\s)\\{([^}]+)\\}\\s+from\\s+['"]${framework.replace('/', '\\/')}['"]`,
      'g'
    );

    let match;
    while ((match = namedImportRegex.exec(content)) !== null) {
      const importList = match[1];
      const components = importList
        .split(',')
        .map(s => s.trim().split(/\s+as\s+/)[0].trim()) // Handle "X as Y" aliases
        .filter(s => s && !allowedImports.includes(s));

      if (components.length > 0) {
        forbidden.push({ framework, components });
      }
    }

    // Pattern 2: Default imports from subpaths - import X from 'framework/X'
    const defaultImportRegex = new RegExp(
      `import\\s+(?!type\\s)(\\w+)\\s+from\\s+['"]${framework.replace('/', '\\/')}\\/(\\w+)['"]`,
      'g'
    );

    while ((match = defaultImportRegex.exec(content)) !== null) {
      const component = match[2];
      if (!allowedImports.includes(component)) {
        forbidden.push({ framework, components: [component] });
      }
    }
  }

  return forbidden;
}

/**
 * Check if file is a React/TypeScript file that might contain imports
 */
function isReactFile(filePath) {
  if (!filePath) return false;
  const ext = path.extname(filePath).toLowerCase();
  return ['.tsx', '.jsx', '.ts', '.js'].includes(ext);
}

/**
 * Get the content being written/edited
 */
function getContentFromToolInput(toolName, toolInput) {
  switch (toolName) {
    case 'Write':
      return toolInput?.content || '';
    case 'Edit':
      return toolInput?.new_string || '';
    case 'MultiEdit':
      // MultiEdit has an array of edits
      if (Array.isArray(toolInput?.edits)) {
        return toolInput.edits.map(e => e.new_string || '').join('\n');
      }
      return '';
    default:
      return '';
  }
}

/**
 * Get the file path being written/edited
 */
function getFilePathFromToolInput(toolName, toolInput) {
  switch (toolName) {
    case 'Write':
    case 'Edit':
      return toolInput?.file_path || '';
    case 'MultiEdit':
      // For MultiEdit, check all files
      if (Array.isArray(toolInput?.edits)) {
        return toolInput.edits.map(e => e.file_path).filter(Boolean);
      }
      return '';
    default:
      return '';
  }
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  const hookData = JSON.parse(input);
  const toolName = hookData.tool_name;
  const toolInput = hookData.tool_input || {};

  // Only check Write, Edit, MultiEdit tools
  if (!['Write', 'Edit', 'MultiEdit'].includes(toolName)) {
    process.exit(0);
  }

  // Get file path(s) and content
  const filePaths = getFilePathFromToolInput(toolName, toolInput);
  const content = getContentFromToolInput(toolName, toolInput);

  // Handle single path or array of paths
  const pathsToCheck = Array.isArray(filePaths) ? filePaths : [filePaths];

  // Filter to only React files
  const reactFiles = pathsToCheck.filter(p => p && isReactFile(p));

  if (reactFiles.length === 0) {
    // Not a React file, approve
    process.exit(0);
  }

  // Find git root from the first file path
  const firstPath = reactFiles[0];
  const gitRoot = findGitRoot(path.dirname(firstPath));

  if (!gitRoot) {
    // Not in a git repo, approve
    process.exit(0);
  }

  // Check if UI documentation exists
  if (!hasUIDocumentation(gitRoot)) {
    // No UI docs, allow direct framework imports
    process.exit(0);
  }

  // Check if all files are in fully allowed folders (packages/ui)
  const allInFullyAllowed = reactFiles.every(fp => isInFullyAllowedFolder(fp, gitRoot));
  if (allInFullyAllowed) {
    // Working in packages/ui, allow ALL imports
    process.exit(0);
  }

  // Determine which allowed list to use based on folder
  const isSharedUI = reactFiles.some(fp => isInSharedUIFolder(fp, gitRoot));
  const allowedImports = isSharedUI ? ALLOWED_MUI_IMPORTS_SHARED_UI : ALLOWED_MUI_IMPORTS_APPS;
  const folderContext = isSharedUI ? 'shared-ui' : 'apps';

  // Check for forbidden imports
  const forbiddenImports = extractForbiddenImports(content, allowedImports);

  if (forbiddenImports.length === 0) {
    // No forbidden imports found
    process.exit(0);
  }

  // Build detailed error message
  const importsList = forbiddenImports
    .map(f => `  - ${f.framework}: ${f.components.join(', ')}`)
    .join('\n');

  const allowedList = allowedImports.slice(0, 10).join(', ') + '...';

  process.stderr.write(`╔══════════════════════════════════════════════════════════════════════╗
║  ❌ FORBIDDEN UI FRAMEWORK IMPORTS DETECTED                          ║
╠══════════════════════════════════════════════════════════════════════╣
║                                                                      ║
║  This repository has a UI component library. You MUST use it.        ║
║                                                                      ║
╚══════════════════════════════════════════════════════════════════════╝

🚫 Blocked imports:
${importsList}

✅ Allowed MUI primitives: ${allowedList}

📖 UI Documentation found in this repo - READ FIRST:
   - packages/ui/components-catalog.md
   - packages/shared-ui/README.md

╔══════════════════════════════════════════════════════════════════════╗
║  YOUR OPTIONS:                                                       ║
╠══════════════════════════════════════════════════════════════════════╣
║                                                                      ║
║  1. USE PROJECT UI PACKAGE (Recommended)                             ║
║     Import from your project UI package or similar                    ║
║     Read components-catalog.md to find equivalent components         ║
║                                                                      ║
║  2. ASK USER FOR PERMISSION                                          ║
║     Use AskUserQuestion tool to ask:                                 ║
║     "The UI package doesn't have X component. May I import           ║
║      directly from @mui/material for this specific case?"            ║
║                                                                      ║
╚══════════════════════════════════════════════════════════════════════╝

⚠️ This hook enforces UI consistency. If you're building the UI package
   itself (packages/ui or packages/shared-ui), this restriction doesn't apply.
`);
  process.exit(2);
}

main().catch(err => {
  console.error('Hook error:', err.message);
  // On error, approve to avoid blocking legitimate operations
  process.exit(0);
});
