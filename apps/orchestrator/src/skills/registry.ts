import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { SkillSummary } from "@analytax/contracts";
import matter from "gray-matter";

export interface SkillRecord {
  name: string;
  description: string;
  /** Absolute skill directory. */
  dir: string;
  /** Body of SKILL.md without frontmatter. */
  body: string;
  license: string | null;
  compatibility: string | null;
  metadata: Record<string, string>;
  /** Parsed `allowed-tools` (experimental in the spec); null when absent. */
  allowedTools: string[] | null;
  /** Relative (posix) paths of bundled files other than SKILL.md. */
  resources: string[];
  root: string;
}

export interface SkillDiscovery {
  skills: SkillRecord[];
  warnings: string[];
}

const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_RESOURCES = 100;
const MAX_DEPTH = 4;
const SKIP_DIRS = new Set([".git", "node_modules"]);

function listResources(dir: string, relative = "", depth = 0): string[] {
  if (depth > MAX_DEPTH) return [];
  const files: string[] = [];
  for (const entry of readdirSync(path.join(dir, relative), { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...listResources(dir, child, depth + 1));
    else if (entry.isFile() && child !== "SKILL.md") files.push(child);
    if (files.length >= MAX_RESOURCES) break;
  }
  return files.slice(0, MAX_RESOURCES).sort();
}

const asString = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

/**
 * Parses one skill directory following the Agent Skills spec (agentskills.io), leniently:
 * name problems are warnings; a missing description or unparseable YAML skips the skill.
 */
export function parseSkill(dir: string, root: string, warnings: string[]): SkillRecord | null {
  const file = path.join(dir, "SKILL.md");
  const dirName = path.basename(dir);
  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(readFileSync(file, "utf8"));
  } catch (error) {
    warnings.push(`skill '${dirName}': invalid SKILL.md frontmatter (${(error as Error).message}) — skipped`);
    return null;
  }
  const data = parsed.data as Record<string, unknown>;
  const description = asString(data.description);
  if (!description) {
    warnings.push(`skill '${dirName}': missing description — skipped`);
    return null;
  }
  let name = asString(data.name) ?? dirName;
  if (!asString(data.name)) warnings.push(`skill '${dirName}': missing name, using directory name`);
  if (!NAME_PATTERN.test(name) || name.length > 64) warnings.push(`skill '${name}': name should match ${NAME_PATTERN} (≤64 chars)`);
  if (name !== dirName) {
    warnings.push(`skill '${name}': name should equal its directory '${dirName}' — using the directory name`);
    name = dirName;
  }
  if (description.length > 1024) warnings.push(`skill '${name}': description exceeds 1024 characters`);
  const compatibility = asString(data.compatibility);
  if (compatibility && compatibility.length > 500) warnings.push(`skill '${name}': compatibility exceeds 500 characters`);

  const rawAllowed = data["allowed-tools"];
  const allowedTools =
    typeof rawAllowed === "string"
      ? rawAllowed.split(/\s+/).filter(Boolean)
      : Array.isArray(rawAllowed)
        ? rawAllowed.map(String)
        : null;
  const metadata = Object.fromEntries(
    Object.entries((data.metadata as Record<string, unknown> | undefined) ?? {}).map(([key, value]) => [key, String(value)]),
  );

  return {
    name,
    description: description.slice(0, 1024),
    dir,
    body: parsed.content.trim(),
    license: asString(data.license),
    compatibility,
    metadata,
    allowedTools,
    resources: listResources(dir),
    root,
  };
}

/** Scans skill roots in order; a skill in a later root overrides an earlier one with the same name. */
export function discoverSkills(home: string, roots: readonly string[]): SkillDiscovery {
  const warnings: string[] = [];
  const byName = new Map<string, SkillRecord>();
  for (const root of roots) {
    const absolute = path.resolve(home, root);
    if (!existsSync(absolute) || !statSync(absolute).isDirectory()) continue;
    for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
      const dir = path.join(absolute, entry.name);
      if (!existsSync(path.join(dir, "SKILL.md"))) continue;
      const skill = parseSkill(dir, root, warnings);
      if (!skill) continue;
      const existing = byName.get(skill.name);
      if (existing) warnings.push(`skill '${skill.name}' in ${root} overrides the one in ${existing.root}`);
      byName.set(skill.name, skill);
    }
  }
  return { skills: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), warnings };
}

export class SkillRegistry {
  private readonly skills: Map<string, SkillRecord>;

  constructor(
    skills: readonly SkillRecord[],
    readonly warnings: readonly string[] = [],
  ) {
    this.skills = new Map(skills.map((skill) => [skill.name, skill]));
  }

  static discover(home: string, roots: readonly string[]): SkillRegistry {
    const { skills, warnings } = discoverSkills(home, roots);
    return new SkillRegistry(skills, warnings);
  }

  has(name: string): boolean {
    return this.skills.has(name);
  }

  get(name: string): SkillRecord | undefined {
    return this.skills.get(name);
  }

  list(): SkillRecord[] {
    return [...this.skills.values()];
  }

  summaries(home: string): SkillSummary[] {
    return this.list().map((skill) => ({
      name: skill.name,
      description: skill.description,
      location: path.relative(home, path.join(skill.dir, "SKILL.md")).split(path.sep).join("/"),
      resources: skill.resources,
    }));
  }
}
