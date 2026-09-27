import { readFile } from "node:fs/promises";
import path from "node:path";
import { tool } from "@langchain/core/tools";
import { createMiddleware } from "langchain";
import { z } from "zod";
import { dispatchSessions } from "../agents/sessions.js";
import { truncate } from "../util/text.js";
import type { SkillRecord } from "./registry.js";

const MAX_RESOURCE_CHARS = 40_000;

const escapeXml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Tier-1 progressive disclosure: name + description + location only (Agent Skills client guidance). */
export function renderSkillCatalog(skills: readonly SkillRecord[], home: string): string {
  if (skills.length === 0) return "";
  const entries = skills
    .map((skill) => {
      const location = path.relative(home, path.join(skill.dir, "SKILL.md")).split(path.sep).join("/");
      return `  <skill>\n    <name>${escapeXml(skill.name)}</name>\n    <description>${escapeXml(skill.description)}</description>\n    <location>${escapeXml(location)}</location>\n  </skill>`;
    })
    .join("\n");
  return `<available_skills>\n${entries}\n</available_skills>`;
}

/** Tier-2: full instructions plus the list (not contents) of bundled resources. */
export function renderSkillContent(skill: SkillRecord): string {
  const resources = skill.resources.length
    ? `\n<skill_resources>\n${skill.resources.map((resource) => `  <file>${escapeXml(resource)}</file>`).join("\n")}\n</skill_resources>\nRead a resource with read_skill_resource only when the instructions call for it.`
    : "";
  return `<skill_content name="${escapeXml(skill.name)}">\n${skill.body}\n</skill_content>${resources}`;
}

type ToolMessageLike = { type?: string; name?: string; content?: unknown };

function alreadyActivated(state: unknown, skillName: string): boolean {
  const messages = (state as { messages?: ToolMessageLike[] } | undefined)?.messages ?? [];
  return messages.some(
    (message) =>
      message.type === "tool" &&
      message.name === "activate_skill" &&
      typeof message.content === "string" &&
      message.content.startsWith(`<skill_content name="${escapeXml(skillName)}">`),
  );
}

/**
 * Registers `activate_skill` and `read_skill_resource` scoped to one agent's allowed skills. The catalog itself is
 * baked into the agent's system prompt (stable prefix). Skill scripts are never executed.
 */
export function createSkillsMiddleware(skills: readonly SkillRecord[]) {
  if (skills.length === 0) return null;
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  const names = [...byName.keys()] as [string, ...string[]];

  const activateSkill = tool(
    async ({ name }, runtime) => {
      const skill = byName.get(name);
      if (!skill) return `Unknown skill '${name}'. Available skills: ${names.join(", ")}`;
      if (alreadyActivated((runtime as { state?: unknown } | undefined)?.state, name)) {
        return `Skill '${name}' is already active — its instructions are above.`;
      }
      dispatchSessions.fromRuntime(runtime)?.emit("agent.skill.loaded", { skill: name });
      return renderSkillContent(skill);
    },
    {
      name: "activate_skill",
      description:
        "Load the full instructions of one of your skills (see <available_skills>). Activate a skill before doing " +
        "work it covers. Returns the instructions and a list of bundled resource files.",
      schema: z.object({ name: z.enum(names).describe("Skill name from <available_skills>") }),
    },
  );

  const readSkillResource = tool(
    async ({ name, file }) => {
      const skill = byName.get(name);
      if (!skill) return `Unknown skill '${name}'.`;
      const normalized = file.replace(/\\/g, "/").replace(/^\.\//, "");
      if (!skill.resources.includes(normalized)) {
        return `'${file}' is not a bundled resource of '${name}'. Available: ${skill.resources.join(", ") || "none"}`;
      }
      const absolute = path.resolve(skill.dir, normalized);
      if (!absolute.startsWith(skill.dir + path.sep)) return "Access denied.";
      return truncate(await readFile(absolute, "utf8"), MAX_RESOURCE_CHARS);
    },
    {
      name: "read_skill_resource",
      description: "Read a bundled resource file (e.g. references/..., assets/...) listed by activate_skill.",
      schema: z.object({
        name: z.enum(names).describe("Skill name"),
        file: z.string().describe("Relative path exactly as listed in <skill_resources>"),
      }),
    },
  );

  return createMiddleware({ name: "AgentSkills", tools: [activateSkill, readSkillResource] });
}
