import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { EventBus } from "../src/events.js";
import { ToolRegistry } from "../src/tools/tool.js";
import { parseSkillMarkdown, loadSkills } from "../src/skills/skill-loader.js";
import { installSkill } from "../src/skills/installer.js";
import { setupSkills } from "../src/skills/index.js";

test("parseSkillMarkdown extracts frontmatter and body", () => {
  const parsed = parseSkillMarkdown("---\nname: demo\ndescription: a demo skill\n---\nDo the thing.");
  assert.equal(parsed.name, "demo");
  assert.equal(parsed.description, "a demo skill");
  assert.equal(parsed.body, "Do the thing.");
});

test("parseSkillMarkdown tolerates missing frontmatter", () => {
  const parsed = parseSkillMarkdown("just a body");
  assert.equal(parsed.name, undefined);
  assert.equal(parsed.body, "just a body");
});

test("loadSkills loads valid skills and reports skipped dirs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tide-skills-"));
  await mkdir(path.join(root, "good"), { recursive: true });
  await writeFile(
    path.join(root, "good", "SKILL.md"),
    "---\nname: good\ndescription: ok\n---\nbody",
    "utf8",
  );
  await mkdir(path.join(root, "bad"), { recursive: true });
  await writeFile(path.join(root, "bad", "README.md"), "no skill here", "utf8");

  const { skills, skipped } = await loadSkills(root);
  assert.equal(skills.length, 1);
  assert.equal(skills[0]?.name, "good");
  assert.ok(skipped.some((s) => s.reason === "no SKILL.md"));
});

test("loadSkills returns empty for a missing directory", async () => {
  const result = await loadSkills(path.join(tmpdir(), "tide-does-not-exist-xyz"));
  assert.equal(result.skills.length, 0);
});

test("installSkill copies a local skill folder into the skills dir", async () => {
  const src = await mkdtemp(path.join(tmpdir(), "tide-skill-src-"));
  await writeFile(
    path.join(src, "SKILL.md"),
    "---\nname: copyme\ndescription: installable\n---\ninstructions",
    "utf8",
  );
  const skillsDir = await mkdtemp(path.join(tmpdir(), "tide-skills-dst-"));

  const result = await installSkill(src, skillsDir);
  assert.equal(result.name, "copyme");
  const installed = await readdir(skillsDir);
  assert.ok(installed.includes("copyme"));

  // Installing again without overwrite must fail.
  await assert.rejects(() => installSkill(src, skillsDir), /already installed/);
  // With overwrite it succeeds.
  const again = await installSkill(src, skillsDir, { overwrite: true });
  assert.equal(again.overwritten, true);
});

test("setupSkills registers skill and install_skill tools", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tide-skills-setup-"));
  await mkdir(path.join(root, "one"), { recursive: true });
  await writeFile(
    path.join(root, "one", "SKILL.md"),
    "---\nname: one\ndescription: first\n---\nbody",
    "utf8",
  );
  const registry = new ToolRegistry();
  const result = await setupSkills(registry, { skillsDir: root, events: new EventBus() });
  assert.equal(result.skills.length, 1);
  assert.ok(registry.has("skill"));
  assert.ok(registry.has("install_skill"));

  const skillTool = registry.get("skill");
  assert.ok(skillTool);
  const output = await skillTool!.execute({ name: "one" }, {
    cwd: root,
    signal: new AbortController().signal,
  });
  assert.match(output, /Skill: one/);
  assert.match(output, /body/);
});
