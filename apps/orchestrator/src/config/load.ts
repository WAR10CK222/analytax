import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";
import { McpConfig } from "../mcp/config.js";
import { shortHash, stableStringify } from "../util/hash.js";
import { ModelsConfig, OrchestratorConfig } from "./schema.js";

export interface AppConfig {
  /** Directory containing config/, agents/ and skills/. */
  home: string;
  models: ModelsConfig;
  orchestrator: OrchestratorConfig;
  /** config/mcp.yaml, or null when the file does not exist (MCP tool servers are optional). */
  mcp: McpConfig | null;
  /** Stable hash of all configs (used to key memoized agent runtimes). */
  hash: string;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

/** ANALYTAX_HOME, else the nearest ancestor of this module (or cwd) that contains config/models.yaml. */
export function resolveHome(): string {
  if (process.env.ANALYTAX_HOME) return path.resolve(process.env.ANALYTAX_HOME);
  for (const start of [path.dirname(fileURLToPath(import.meta.url)), process.cwd()]) {
    let dir = start;
    for (let depth = 0; depth < 10; depth++) {
      if (existsSync(path.join(dir, "config", "models.yaml"))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return process.cwd();
}

function readYaml<T>(file: string, schema: z.ZodType<T>): T {
  if (!existsSync(file)) throw new ConfigError(`Config file not found: ${file}`);
  let raw: unknown;
  try {
    raw = parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new ConfigError(`Invalid YAML in ${file}: ${(error as Error).message}`);
  }
  const result = schema.safeParse(raw);
  if (!result.success) throw new ConfigError(`Invalid config ${file}:\n${z.prettifyError(result.error)}`);
  return result.data;
}

let cached: AppConfig | null = null;

export function loadConfig(home = resolveHome(), options: { fresh?: boolean } = {}): AppConfig {
  if (cached && !options.fresh && cached.home === home) return cached;
  const models = readYaml(path.join(home, "config", "models.yaml"), ModelsConfig);
  const orchestrator = readYaml(path.join(home, "config", "orchestrator.yaml"), OrchestratorConfig);
  const mcpFile = path.join(home, "config", "mcp.yaml");
  const mcp = existsSync(mcpFile) ? readYaml(mcpFile, McpConfig) : null;
  const config: AppConfig = { home, models, orchestrator, mcp, hash: shortHash(stableStringify({ models, orchestrator, mcp })) };
  cached = config;
  return config;
}
