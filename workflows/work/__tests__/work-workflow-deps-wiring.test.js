/**
 * Tests for dependency wiring in work.workflow.js
 *
 * Verifies that required dependencies are properly wired into
 * buildTransitionDeps() for transitionStep calls.
 *
 * Run: node --test workflows/work/__tests__/work-workflow-deps-wiring.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WORKFLOW_PATH = path.join(__dirname, '..', 'work.workflow.js');
const source = fs.readFileSync(WORKFLOW_PATH, 'utf-8');

describe('work.workflow.js dependency wiring', () => {
  describe('buildTransitionDeps includes getHeadSha (GH-299 Task 5)', () => {
    it('should import getHeadSha from git-utils', () => {
      // Verify the require statement pulls getHeadSha from git-utils
      const importPattern = /require\([^)]*git-utils[^)]*\)/;
      assert.ok(importPattern.test(source), 'git-utils should be required');

      const getHeadShaImport = /getHeadSha\b/;
      assert.ok(getHeadShaImport.test(source), 'getHeadSha should be imported from git-utils');
    });

    it('should include getHeadSha in buildTransitionDeps return object', () => {
      // Extract the buildTransitionDeps function body by finding its boundaries
      const fnStart = source.indexOf('function buildTransitionDeps()');
      assert.ok(fnStart !== -1, 'buildTransitionDeps function should exist');

      // Find the function's opening brace
      const fnBodyStart = source.indexOf('{', fnStart);

      // Walk to the matching closing brace for the function body
      let braceCount = 0;
      let fnBodyEnd = fnBodyStart;
      for (let i = fnBodyStart; i < source.length; i++) {
        if (source[i] === '{') braceCount++;
        if (source[i] === '}') braceCount--;
        if (braceCount === 0) {
          fnBodyEnd = i;
          break;
        }
      }

      const fnBody = source.slice(fnBodyStart, fnBodyEnd + 1);
      // Match getHeadSha as a property in the return object (not just a comment reference)
      assert.ok(
        /\bgetHeadSha[,\s}]/.test(fnBody),
        `buildTransitionDeps should include getHeadSha as a property in its return object.\nFunction body: ${fnBody}`
      );
    });
  });
});
