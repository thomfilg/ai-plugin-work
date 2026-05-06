const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SKILL_PATH = path.resolve(__dirname, '..', 'SKILL.md');
const content = fs.readFileSync(SKILL_PATH, 'utf-8');

/**
 * Extract the preamble: content between the closing `---` of frontmatter
 * and the `# Cleanup Worktrees Command` heading.
 */
function getPreamble() {
  // Find the second `---` (end of frontmatter)
  const firstIdx = content.indexOf('---');
  if (firstIdx === -1) return null;
  const secondIdx = content.indexOf('---', firstIdx + 3);
  if (secondIdx === -1) return null;
  const afterFrontmatter = content.slice(secondIdx + 3);

  // Find the heading
  const headingIdx = afterFrontmatter.indexOf('# Cleanup Worktrees Command');
  if (headingIdx === -1) return null;

  const preamble = afterFrontmatter.slice(0, headingIdx).trim();
  return preamble.length > 0 ? preamble : null;
}

/**
 * Extract the Step 1 section content.
 */
function getStep1Section() {
  const start = content.search(/^### Step 1:/m);
  if (start === -1) return null;
  const rest = content.slice(start);
  const nextStep = rest.slice(1).search(/\n### Step [0-9]/);
  if (nextStep === -1) return rest;
  return rest.slice(0, nextStep + 1);
}

describe('cleanup-worktrees SKILL.md — fresh-data preamble (GH-90)', () => {
  describe('Preamble exists and enforces fresh analysis', () => {
    it('preamble exists between frontmatter and heading', () => {
      const preamble = getPreamble();
      assert.ok(
        preamble,
        'SKILL.md must have content between the closing --- of frontmatter and # Cleanup Worktrees Command'
      );
    });

    it('preamble contains discard/re-analyze directive', () => {
      const preamble = getPreamble();
      assert.ok(preamble, 'preamble must exist');
      assert.match(
        preamble,
        /discard.*prior|re-analy[sz]e.*from scratch|from scratch.*re-analy[sz]e/i,
        'Preamble must instruct to discard prior results or re-analyze from scratch'
      );
    });

    it('preamble mandates git fetch --prune origin', () => {
      const preamble = getPreamble();
      assert.ok(preamble, 'preamble must exist');
      assert.match(
        preamble,
        /git fetch --prune origin/,
        'Preamble must mandate running git fetch --prune origin'
      );
    });

    it('preamble mandates re-checking PR status', () => {
      const preamble = getPreamble();
      assert.ok(preamble, 'preamble must exist');
      assert.match(
        preamble,
        /PR status|gh pr view|pull request.*status/i,
        'Preamble must mandate re-checking PR status'
      );
    });

    it('preamble mandates re-checking uncommitted/unpushed work', () => {
      const preamble = getPreamble();
      assert.ok(preamble, 'preamble must exist');
      assert.match(
        preamble,
        /uncommitted|unpushed/i,
        'Preamble must mandate checking for uncommitted or unpushed work'
      );
    });

    it('preamble includes Fresh analysis output instruction', () => {
      const preamble = getPreamble();
      assert.ok(preamble, 'preamble must exist');
      assert.match(
        preamble,
        /fresh analysis.*discarded|fresh analysis.*started/i,
        'Preamble must include a "Fresh analysis started" output instruction'
      );
    });
  });

  describe('Step 1 uses correct fetch command', () => {
    it('Step 1 uses git fetch --prune origin', () => {
      const step1 = getStep1Section();
      assert.ok(step1, 'Step 1 section must exist');
      assert.match(
        step1,
        /git fetch --prune origin/,
        'Step 1 must use "git fetch --prune origin" not "git fetch origin main"'
      );
    });
  });

  describe('Existing structure preserved', () => {
    it('contains # Cleanup Worktrees Command heading', () => {
      assert.match(
        content,
        /^# Cleanup Worktrees Command$/m,
        'SKILL.md must contain the "# Cleanup Worktrees Command" heading'
      );
    });

    it('contains ## Philosophy section', () => {
      assert.match(
        content,
        /^## Philosophy/m,
        'SKILL.md must contain the "## Philosophy" section'
      );
    });

    it('contains ## Instructions section', () => {
      assert.match(
        content,
        /^## Instructions$/m,
        'SKILL.md must contain the "## Instructions" section'
      );
    });
  });
});
