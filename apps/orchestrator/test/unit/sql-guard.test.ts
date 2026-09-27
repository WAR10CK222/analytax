import { describe, expect, it } from "vitest";
import { checkReadOnlySql, splitSqlStatements, tokenizeSql } from "../../src/mcp/sql-guard.js";

const allowed = [
  ["a bare select", "SELECT 1"],
  ["a trailing semicolon", "SELECT 1;"],
  ["a line comment first", "-- count them\nSELECT count(*) FROM meeting"],
  ["a nested block comment", "/* outer /* inner */ still comment */ SELECT 1"],
  ["a CTE", "WITH t AS (SELECT 1 AS n) SELECT n FROM t"],
  ["EXPLAIN with options", "EXPLAIN (FORMAT JSON) SELECT 1"],
  ["EXPLAIN of a CTE", "EXPLAIN WITH t AS (SELECT 1) SELECT * FROM t"],
  ["SHOW", "SHOW search_path"],
  ["TABLE", "TABLE state"],
  ["VALUES", "VALUES (1),(2)"],
  ["a parenthesised union", "(SELECT 1) UNION ALL (SELECT 2)"],
  ["dangerous words inside a literal", "SELECT 'delete from users'"],
  ["an escaped quote inside a literal", "SELECT 'it''s; drop table t'"],
  ["an E-string with a backslash quote", "SELECT E'line\\'; DROP TABLE t'"],
  ["a dollar-quoted body", "SELECT $$; DROP TABLE t$$"],
  ["a tagged dollar-quoted body", "SELECT $tag$ insert into x $tag$"],
  ["quoted identifiers that look like keywords", 'SELECT "delete" FROM "update"'],
  ["columns that merely start with a keyword", "SELECT count(*) FROM meeting WHERE updated_at > now() AND start_date < now()"],
  ["read-only pg_ helpers", "SELECT pg_size_pretty(pg_total_relation_size('institute_data'))"],
  ["an aggregate over a partitioned table", "SELECT type, sum(data_value) FROM indicator_data WHERE start_date >= '2026-09-01' GROUP BY 1 LIMIT 50"],
] as const;

const refused = [
  ["a delete", "DELETE FROM meeting"],
  ["an insert", "INSERT INTO state (code, name) VALUES (1, 'x')"],
  ["an update", "UPDATE app_user SET is_active = false"],
  ["a drop", "DROP TABLE meeting"],
  ["a truncate", "TRUNCATE meeting"],
  ["a grant", "GRANT ALL ON meeting TO public"],
  ["a second statement", "SELECT 1; DELETE FROM meeting"],
  ["two selects", "SELECT 1;SELECT 2"],
  ["a statement hidden behind a comment", "-- SELECT 1\nDELETE FROM meeting"],
  ["a writing CTE", "WITH d AS (DELETE FROM meeting RETURNING *) SELECT * FROM d"],
  ["an inserting CTE", "WITH x AS (INSERT INTO state VALUES (9,'z') RETURNING code) SELECT * FROM x"],
  ["EXPLAIN ANALYZE", "EXPLAIN ANALYZE SELECT 1"],
  ["EXPLAIN ANALYZE in an option list", "EXPLAIN (ANALYZE, BUFFERS) SELECT 1"],
  ["EXPLAIN of a delete", "EXPLAIN DELETE FROM meeting"],
  ["SELECT INTO", "SELECT * INTO backup FROM meeting"],
  ["row locking", "SELECT * FROM meeting FOR UPDATE"],
  ["share locking", "SELECT * FROM meeting FOR SHARE"],
  ["no key update locking", "SELECT * FROM meeting FOR NO KEY UPDATE"],
  ["session mutation", "SET search_path = public"],
  ["a reset", "RESET ALL"],
  ["a DO block", "DO $$ BEGIN PERFORM 1; END $$"],
  ["a procedure call", "CALL some_procedure()"],
  ["COPY to a program", "COPY meeting TO PROGRAM 'curl http://example.com'"],
  ["COPY from a file", "COPY meeting FROM '/etc/passwd'"],
  ["reading a file", "SELECT pg_read_file('/etc/passwd')"],
  ["a schema-qualified file read", "SELECT pg_catalog.pg_read_file('/etc/passwd')"],
  ["sleeping", "SELECT pg_sleep(60)"],
  ["dblink", "SELECT * FROM dblink('host=evil', 'SELECT 1') AS t(x int)"],
  ["large object import", "SELECT lo_import('/etc/passwd')"],
  ["sequence mutation", "SELECT nextval('state_code_seq')"],
  ["starting a transaction", "START TRANSACTION"],
  ["an unterminated string", "SELECT 'oops"],
  ["an unterminated block comment", "/* nope SELECT 1"],
  ["an unterminated dollar quote", "SELECT $tag$ nope"],
  ["nothing at all", "   "],
  ["comments only", "-- just a comment"],
  ["an oversized statement", `SELECT '${"x".repeat(20_001)}'`],
] as const;

describe("checkReadOnlySql", () => {
  it.each(allowed)("allows %s", (_name, sql) => {
    expect(checkReadOnlySql(sql)).toEqual({ ok: true });
  });

  it.each(refused)("refuses %s", (_name, sql) => {
    const result = checkReadOnlySql(sql);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
  });

  it("explains why it refused", () => {
    expect(checkReadOnlySql("DELETE FROM meeting")).toEqual({ ok: false, reason: 'statements starting with "DELETE" are not read-only' });
    expect(checkReadOnlySql("SELECT * FROM t WHERE id IN (SELECT id FROM u) FOR UPDATE")).toEqual({ ok: false, reason: '"FOR UPDATE" is not read-only' });
    expect(checkReadOnlySql("SELECT 1; SELECT 2")).toEqual({ ok: false, reason: "more than one statement was sent; send exactly one" });
    expect(checkReadOnlySql("VACUUM")).toEqual({ ok: false, reason: 'statements starting with "VACUUM" are not read-only' });
  });
});

describe("tokenizeSql", () => {
  it("drops comments and keeps literals whole", () => {
    const result = tokenizeSql("SELECT /* x */ 'a''b' -- tail\n, \"Col\"");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tokens.map((token) => `${token.kind}:${token.text}`)).toEqual(["word:SELECT", "string:a'b", "punct:,", "ident:Col"]);
  });

  it("records offsets that slice the original text back out", () => {
    const sql = "SELECT count(*) FROM payslip";
    const result = tokenizeSql(sql);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const last = result.tokens.at(-1)!;
    expect(sql.slice(last.start, last.end)).toBe("payslip");
  });
});

describe("splitSqlStatements", () => {
  const split = (sql: string): string[] => {
    const result = splitSqlStatements(sql);
    expect(result.ok).toBe(true);
    return result.ok ? result.statements : [];
  };

  it("splits on top-level semicolons and drops comments between statements", () => {
    const file = ["-- a file", "SELECT 1;", "", "-- next", "SELECT 2;", ""].join("\n");
    expect(split(file)).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("keeps a dollar-quoted body whole, so a DO block is one statement", () => {
    const file = ["CREATE TABLE t (id int);", "DO $part$", "BEGIN", "  EXECUTE 'CREATE TABLE u (id int)';", "END", "$part$;", "SELECT 1;"].join("\n");
    const statements = split(file);
    expect(statements).toHaveLength(3);
    expect(statements[1]).toContain("EXECUTE 'CREATE TABLE u (id int)'");
  });

  it("ignores semicolons inside string literals", () => {
    expect(split("INSERT INTO t VALUES ('a;b'); SELECT 1")).toEqual(["INSERT INTO t VALUES ('a;b')", "SELECT 1"]);
  });

  it("keeps a comment that sits inside a statement", () => {
    const file = ["SELECT 1 -- why", "  + 2;"].join("\n");
    expect(split(file)).toEqual([file.slice(0, -1)]);
  });

  it("returns the lexer reason when the file cannot be read", () => {
    expect(splitSqlStatements("SELECT 'unterminated")).toEqual({ ok: false, reason: "unterminated string literal" });
  });
});
