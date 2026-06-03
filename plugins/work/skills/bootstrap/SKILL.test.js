// Task 3 RED tests — colocated with SKILL.md so task-next.js discovers them
// via findTestFilesInScope colocated-sibling rule (basename SKILL + .test.js).
// These tests assert that SKILL.md wires in bootstrap-branch.js correctly.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const SKILL_MD = path.join(__dirname, "SKILL.md");

describe("bootstrap SKILL.md — Task 3 wiring", () => {
  describe("SKILL.md invokes the helper and aborts the skill on non-zero exit", () => {
    it("Step 4 invokes bootstrap-branch.js, captures stdout into BRANCH_NAME, and aborts on non-zero exit", () => {
      const md = fs.readFileSync(SKILL_MD, "utf8");
      assert.match(md, /bootstrap-branch\.js/, "SKILL.md must reference bootstrap-branch.js");
      assert.match(md, /BRANCH_NAME=/, "SKILL.md must capture stdout into BRANCH_NAME");
      assert.match(
        md,
        /(abort|exit\s+(?:non-zero|1)|\$\?\s*!=\s*0|exit\s+\$\?)/i,
        "SKILL.md must abort on non-zero helper exit",
      );
    });
  });

  describe("SKILL.md does not create a worktree when validation fails", () => {
    it("git worktree add is gated behind helper exit-0 and uses validated BRANCH_NAME", () => {
      const md = fs.readFileSync(SKILL_MD, "utf8");
      assert.match(md, /git worktree add/, "SKILL.md must contain git worktree add");
      assert.match(md, /\$BRANCH_NAME/, "git worktree add must use $BRANCH_NAME");
      assert.match(md, /BRANCH_NAME_REGEX/, "SKILL.md must document BRANCH_NAME_REGEX");
      assert.match(md, /BRANCH_PREFIX/, "SKILL.md must document BRANCH_PREFIX");
      assert.match(md, /gitBranchName/, "SKILL.md must document Linear gitBranchName precedence");
    });
  });
});
