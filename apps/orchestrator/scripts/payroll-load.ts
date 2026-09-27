/**
 * Loads the synthetic payroll demo database in data/payroll into the `local-postgres` MCP server, one statement
 * at a time (that server executes a single statement per call). This talks to the server directly through
 * McpConnection, not through McpHub, because the hub's read-only guard exists precisely to stop agents running
 * the DDL and inserts below. Nothing here touches a real payroll: every row is generated.
 *
 * Usage: pnpm payroll:load [--drop] [--only <file>] [--dry-run] [--verify] [--server <id>]
 *   --drop      run 00-drop.sql first, so the load starts from an empty schema
 *   --only      run one file, e.g. --only 02-seed.sql
 *   --from      skip to statement N of the single file named by --only, to resume after a failure
 *   --dry-run   print the statements that would run, and send nothing
 *   --verify    after loading, print row counts per table and the payslip_line partition spread
 */
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config/load.js";
import { resolveServer } from "../src/mcp/config.js";
import { McpConnection } from "../src/mcp/connection.js";
import { splitSqlStatements } from "../src/mcp/sql-guard.js";

const STATEMENT_TIMEOUT_MS = 180_000; // seed statements are legitimately slower than anything an agent may run
const LOAD_FILES = ["01-schema.sql", "02-seed.sql", "03-analytics.sql"];
const DROP_FILE = "00-drop.sql";

const VERIFY_SQL = `
SELECT c.relname AS table_name, to_char(c.reltuples::bigint, 'FM999,999,999') AS estimated_rows,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relispartition = false
ORDER BY c.reltuples DESC`;

function loadEnv(): void {
  try {
    process.loadEnvFile(path.resolve(import.meta.dirname, "../../../.env"));
  } catch {
    // .env is optional: this script needs no key, only the MCP server URL from config/mcp.yaml
  }
}

function flagValue(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
}

/** First line of a statement, shortened, so the log reads like a list of steps. */
function label(statement: string): string {
  const line = statement.split("\n").find((part) => part.trim() !== "" && !part.trim().startsWith("--")) ?? statement;
  const text = line.trim().replace(/\s+/g, " ");
  return text.length > 78 ? `${text.slice(0, 77)}…` : text;
}

function resultText(result: { content?: unknown }): string {
  const content = Array.isArray(result.content) ? result.content : [];
  return content
    .map((part) => (typeof part === "object" && part !== null && "text" in part ? String((part as { text: unknown }).text) : ""))
    .join("\n")
    .trim();
}

async function main(): Promise<void> {
  loadEnv();
  process.env.ANALYTAX_TELEMETRY_ENABLED = "false";
  process.env.LOG_LEVEL ??= "error";

  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const serverId = flagValue(args, "--server") ?? "local-postgres";
  const only = flagValue(args, "--only");
  const from = Number(flagValue(args, "--from") ?? 1);
  if (only === undefined && from !== 1) throw new Error("--from only makes sense with --only <file>");
  const files = [...(args.includes("--drop") ? [DROP_FILE] : []), ...(only ? [only] : LOAD_FILES)];

  const config = loadConfig();
  const entry = config.mcp?.servers[serverId];
  if (!config.mcp || !entry) throw new Error(`config/mcp.yaml has no server "${serverId}"`);
  const resolved = resolveServer(serverId, entry, config.mcp.defaults, process.env);
  if (!resolved.ok) throw new Error(`${serverId} is misconfigured: ${resolved.detail}`);

  const dir = path.resolve(config.home, "data/payroll");
  const plan = files.map((file) => {
    const full = path.join(dir, file);
    if (!fs.existsSync(full)) throw new Error(`${full} does not exist`);
    const split = splitSqlStatements(fs.readFileSync(full, "utf8"));
    if (!split.ok) throw new Error(`${file} could not be split into statements: ${split.reason}`);
    return { file, statements: file === only ? split.statements.slice(from - 1) : split.statements, offset: file === only ? from - 1 : 0 };
  });

  console.log(`${serverId} · ${resolved.server.host} · ${dir}`);
  for (const { file, statements } of plan) console.log(`  ${file.padEnd(16)} ${String(statements.length).padStart(3)} statement(s)`);
  if (dryRun) {
    for (const { file, statements } of plan) {
      console.log(`\n${file}`);
      statements.forEach((statement, index) => console.log(`  ${String(index + 1).padStart(3)} ${label(statement)}`));
    }
    return;
  }

  const connection = new McpConnection(resolved.server);
  await connection.connect();
  const run = async (sql: string): Promise<string> => {
    const result = await connection.callTool("execute_sql", { sql }, { timeoutMs: STATEMENT_TIMEOUT_MS });
    const text = resultText(result);
    if (result.isError) throw new Error(text || "the server returned an error with no message");
    return text;
  };

  try {
    const started = Date.now();
    for (const { file, statements, offset } of plan) {
      console.log(`\n${file}`);
      for (const [index, statement] of statements.entries()) {
        const at = Date.now();
        const position = `${String(index + 1 + offset).padStart(3)}/${statements.length + offset}`;
        try {
          const text = await run(statement);
          const rows = text.split("\n").filter((line) => line.trim() !== "").length;
          console.log(`  ✔ ${position} ${label(statement).padEnd(80)} ${String(Date.now() - at).padStart(6)} ms${rows > 0 ? `  ${rows} row(s)` : ""}`);
        } catch (error) {
          console.log(`  ✖ ${position} ${label(statement)}`);
          console.error(`\n✖ ${file} statement ${index + 1} failed: ${(error as Error).message}\n`);
          console.error(statement.length > 2000 ? `${statement.slice(0, 2000)}\n…` : statement);
          process.exitCode = 1;
          return;
        }
      }
    }
    console.log(`\n✔ loaded in ${Math.round((Date.now() - started) / 1000)}s`);

    if (args.includes("--verify")) {
      console.log("\nTables");
      const rows = (await run(VERIFY_SQL)).split("\n").filter((line) => line.trim() !== "");
      let total = 0;
      for (const row of rows) {
        const parsed = JSON.parse(row) as { table_name: string; estimated_rows: string; total_size: string };
        total += Number(parsed.estimated_rows.replaceAll(",", ""));
        console.log(`  ${parsed.table_name.padEnd(22)} ${parsed.estimated_rows.padStart(11)} rows  ${parsed.total_size}`);
      }
      console.log(`  ${"total (estimated)".padEnd(22)} ${total.toLocaleString("en-US").padStart(11)} rows`);
      const partitions = await run(
        "SELECT count(*) AS partitions, sum(c.reltuples)::bigint AS rows FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE i.inhparent = 'payslip_line'::regclass AND c.reltuples > 0",
      );
      console.log(`  payslip_line partitions holding rows: ${partitions}`);
    }
  } finally {
    await connection.close();
  }
}

main().catch((error: unknown) => {
  console.error(`✖ ${(error as Error).message}`);
  process.exitCode = 1;
});
