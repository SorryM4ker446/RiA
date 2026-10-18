import { createHash } from "node:crypto";

export const marketSkillFiles = [
  { path: "SKILL.md", contents: '---\nname: community-writing\ndescription: >-\n  Polish writing and review prose using the bundled editorial references.\nlicense: MIT\n---\n# Community Writing\nSKILL_MARKET_MAIN\nRead references/style.md before editing.\n' + "Keep original meaning.\n".repeat(350) },
  { path: "references/style.md", contents: "SKILL_MARKET_REFERENCE\n" + "Choose concrete verbs.\n".repeat(1300) },
  { path: "scripts/check.py", contents: '# Read-only sample. Never executed by RiA.\nprint("SKILL_SCRIPT_MUST_NOT_EXECUTE")\n' },
];
export function marketSnapshot(files = marketSkillFiles) {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) { hash.update(file.path); hash.update(file.contents); }
  return { files, hash: hash.digest("hex") };
}
export const marketSearchItem = { id: "ria-tests/skills/community-writing", source: "ria-tests/skills", skillId: "community-writing", name: "community-writing", installs: 1234 };
