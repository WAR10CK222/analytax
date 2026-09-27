/**
 * Read-only check for SQL an agent wants to run through an MCP tool.
 *
 * The statement is lexed first and every decision is made on tokens, so text inside string literals, dollar-quoted
 * bodies and "quoted identifiers" can never trigger (or evade) a rule.
 *
 * Limits, stated plainly: a lexer is not a parser. It refuses whenever a forbidden word appears outside a literal, so
 * an unquoted column named `set` is refused (quote it), and it cannot see a write hidden inside a volatile function
 * (`SELECT my_writing_fn()`). It is defence in depth, not a replacement for a read-only database role. Every
 * ambiguity refuses.
 */

const MAX_SQL_CHARS = 20_000;

/** `start` and `end` are offsets into the original SQL, so callers can slice the source back out of the tokens. */
export type SqlToken = { kind: "word" | "ident" | "string" | "number" | "punct"; text: string; start: number; end: number };

export type SqlCheck = { ok: true } | { ok: false; reason: string };

const fail = (reason: string): SqlCheck => ({ ok: false, reason });

/** Statements an agent may run. Everything else is refused at the first word. */
const OPENERS = new Set(["select", "with", "explain", "show", "table", "values"]);

/** Words that make a statement non-read-only wherever they appear outside literals and quoted identifiers. */
const DENIED = new Set([
  // data changes
  "insert", "update", "delete", "merge", "truncate", "upsert", "returning", "into",
  // schema and permissions
  "create", "alter", "drop", "rename", "comment", "grant", "revoke", "reassign", "own", "owner",
  // execution and session state
  "call", "do", "execute", "prepare", "deallocate", "set", "reset", "discard", "declare", "fetch", "move", "close",
  // transactions and maintenance
  "commit", "rollback", "savepoint", "vacuum", "analyze", "analyse", "reindex", "cluster", "refresh", "lock",
  // io and side effects
  "copy", "listen", "unlisten", "notify", "import", "export",
  // functions with side effects or file/network access
  "nextval", "setval", "dblink", "dblink_exec", "pg_sleep", "pg_stat_file", "pg_file_write", "pg_file_unlink", "pg_logical_emit_message",
]);

/** Families of function names that read files, touch other backends or create objects. */
const DENIED_PREFIXES = ["pg_read_", "pg_ls_", "pg_advisory", "pg_terminate", "pg_cancel", "pg_create_", "pg_drop_", "pg_import", "pg_replication", "lo_", "dblink_"];

/** Word pairs that are only dangerous together, so the first word stays usable on its own (`start_date`, `for` clauses). */
const DENIED_PAIRS: [string, Set<string>][] = [
  ["for", new Set(["update", "share", "no", "key"])],
  ["start", new Set(["transaction"])],
  ["begin", new Set(["transaction", "work", "atomic", "isolation"])],
  ["security", new Set(["label"])],
];

const isWordStart = (char: string): boolean => /[A-Za-z_\u0080-￿]/.test(char);
const isWordChar = (char: string): boolean => /[A-Za-z0-9_$\u0080-￿]/.test(char);

/** Splits SQL into tokens, dropping comments. Literals keep their text but are never matched against keywords. */
export function tokenizeSql(sql: string): { ok: true; tokens: SqlToken[] } | { ok: false; reason: string } {
  const tokens: SqlToken[] = [];
  let index = 0;
  while (index < sql.length) {
    const start = index;
    const char = sql[index]!;
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === "-" && sql[index + 1] === "-") {
      const newline = sql.indexOf("\n", index);
      index = newline === -1 ? sql.length : newline + 1;
      continue;
    }
    if (char === "/" && sql[index + 1] === "*") {
      let depth = 1;
      index += 2;
      while (index < sql.length && depth > 0) {
        if (sql[index] === "/" && sql[index + 1] === "*") {
          depth += 1;
          index += 2;
        } else if (sql[index] === "*" && sql[index + 1] === "/") {
          depth -= 1;
          index += 2;
        } else index += 1;
      }
      if (depth > 0) return { ok: false, reason: "unterminated block comment" };
      continue;
    }
    if (char === "'") {
      // Backslash escapes only apply to E'…' strings, marked by the preceding word.
      const escaped = tokens.at(-1)?.kind === "word" && tokens.at(-1)!.text.toLowerCase() === "e";
      index += 1;
      let text = "";
      let closed = false;
      while (index < sql.length) {
        const current = sql[index]!;
        if (escaped && current === "\\" && index + 1 < sql.length) {
          text += sql[index + 1];
          index += 2;
          continue;
        }
        if (current === "'") {
          if (sql[index + 1] === "'") {
            text += "'";
            index += 2;
            continue;
          }
          index += 1;
          closed = true;
          break;
        }
        text += current;
        index += 1;
      }
      if (!closed) return { ok: false, reason: "unterminated string literal" };
      tokens.push({ kind: "string", text, start, end: index });
      continue;
    }
    if (char === '"') {
      index += 1;
      let text = "";
      let closed = false;
      while (index < sql.length) {
        if (sql[index] === '"') {
          if (sql[index + 1] === '"') {
            text += '"';
            index += 2;
            continue;
          }
          index += 1;
          closed = true;
          break;
        }
        text += sql[index];
        index += 1;
      }
      if (!closed) return { ok: false, reason: "unterminated quoted identifier" };
      tokens.push({ kind: "ident", text, start, end: index });
      continue;
    }
    if (char === "$") {
      const tag = /^\$[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*\$|^\$\$/.exec(sql.slice(index));
      if (tag) {
        const marker = tag[0];
        const end = sql.indexOf(marker, index + marker.length);
        if (end === -1) return { ok: false, reason: "unterminated dollar-quoted string" };
        index = end + marker.length;
        tokens.push({ kind: "string", text: sql.slice(start + marker.length, end), start, end: index });
        continue;
      }
      // $1 and friends are parameters, not strings.
      index += 1;
      tokens.push({ kind: "punct", text: "$", start, end: index });
      continue;
    }
    if (/[0-9]/.test(char)) {
      let text = "";
      while (index < sql.length && /[0-9a-fA-FxX._]/.test(sql[index]!)) {
        text += sql[index];
        index += 1;
      }
      tokens.push({ kind: "number", text, start, end: index });
      continue;
    }
    if (isWordStart(char)) {
      let text = "";
      while (index < sql.length && isWordChar(sql[index]!)) {
        text += sql[index];
        index += 1;
      }
      tokens.push({ kind: "word", text, start, end: index });
      continue;
    }
    index += 1;
    tokens.push({ kind: "punct", text: char, start, end: index });
  }
  return { ok: true, tokens };
}

/** Splits on top-level `;`. A single trailing semicolon is fine; anything after it is a second statement. */
function statements(tokens: readonly SqlToken[]): SqlToken[][] {
  const out: SqlToken[][] = [];
  let current: SqlToken[] = [];
  let depth = 0;
  for (const token of tokens) {
    if (token.kind === "punct") {
      if (token.text === "(") depth += 1;
      else if (token.text === ")") depth = Math.max(0, depth - 1);
      else if (token.text === ";" && depth === 0) {
        if (current.length > 0) out.push(current);
        current = [];
        continue;
      }
    }
    current.push(token);
  }
  if (current.length > 0) out.push(current);
  return out;
}

const words = (tokens: readonly SqlToken[]): string[] => tokens.filter((token) => token.kind === "word").map((token) => token.text.toLowerCase());

/** First word of a statement, skipping leading parentheses: `(SELECT 1) UNION (SELECT 2)`. */
function opener(tokens: readonly SqlToken[]): string | null {
  for (const token of tokens) {
    if (token.kind === "punct" && token.text === "(") continue;
    return token.kind === "word" ? token.text.toLowerCase() : null;
  }
  return null;
}

/** Tokens of an EXPLAIN statement after the keyword and any `( … )` option list. */
function afterExplain(tokens: readonly SqlToken[]): SqlToken[] {
  const rest = tokens.slice(tokens.findIndex((token) => token.kind === "word" && token.text.toLowerCase() === "explain") + 1);
  if (rest[0]?.kind === "punct" && rest[0].text === "(") {
    let depth = 0;
    for (let index = 0; index < rest.length; index++) {
      const token = rest[index]!;
      if (token.kind !== "punct") continue;
      if (token.text === "(") depth += 1;
      else if (token.text === ")") {
        depth -= 1;
        if (depth === 0) return rest.slice(index + 1);
      }
    }
    return [];
  }
  return rest;
}

/** True when the statement is a single read-only query. Errs towards refusing. */
export function checkReadOnlySql(sql: string): SqlCheck {
  if (typeof sql !== "string" || sql.trim() === "") return fail("the statement is empty");
  if (sql.length > MAX_SQL_CHARS) return fail(`the statement is longer than ${MAX_SQL_CHARS} characters`);

  const lexed = tokenizeSql(sql);
  if (!lexed.ok) return fail(lexed.reason);

  const parts = statements(lexed.tokens);
  if (parts.length === 0) return fail("the statement has no SQL, only comments or whitespace");
  if (parts.length > 1) return fail("more than one statement was sent; send exactly one");

  const tokens = parts[0]!;
  const first = opener(tokens);
  if (!first) return fail("the statement does not start with a keyword");
  if (!OPENERS.has(first)) return fail(`statements starting with "${first.toUpperCase()}" are not read-only`);

  const statementWords = words(tokens);
  if (first === "explain") {
    if (statementWords.includes("analyze") || statementWords.includes("analyse")) return fail("EXPLAIN ANALYZE executes the statement");
    const inner = opener(afterExplain(tokens));
    if (!inner || !OPENERS.has(inner) || inner === "explain") return fail("EXPLAIN is only allowed on a read-only statement");
  }

  for (let index = 0; index < statementWords.length; index++) {
    const word = statementWords[index]!;
    // EXPLAIN's own keyword and the ANALYZE check above are handled already.
    if (first === "explain" && index === 0) continue;
    if (DENIED.has(word)) return fail(`"${word.toUpperCase()}" is not allowed in a read-only statement`);
    if (DENIED_PREFIXES.some((prefix) => word.startsWith(prefix))) return fail(`the function "${word}" is not allowed`);
    const pair = DENIED_PAIRS.find(([head]) => head === word);
    const next = statementWords[index + 1];
    if (pair && next && pair[1].has(next)) return fail(`"${word.toUpperCase()} ${next.toUpperCase()}" is not read-only`);
  }
  return { ok: true };
}

/**
 * Splits a SQL file into individual statements, using the same lexer as the guard so that semicolons inside
 * strings, `$tag$ … $tag$` bodies (a whole `DO` block is one statement) and comments are not split points.
 * Comments and whitespace between statements are dropped; whatever is inside a statement is returned verbatim.
 */
export function splitSqlStatements(sql: string): { ok: true; statements: string[] } | { ok: false; reason: string } {
  const lexed = tokenizeSql(sql);
  if (!lexed.ok) return { ok: false, reason: lexed.reason };

  const out: string[] = [];
  let depth = 0;
  let from: number | null = null;
  let to = 0;
  const flush = (): void => {
    if (from === null) return;
    const text = sql.slice(from, to).trim();
    if (text !== "") out.push(text);
    from = null;
  };
  for (const token of lexed.tokens) {
    if (token.kind === "punct") {
      if (token.text === "(") depth += 1;
      else if (token.text === ")") depth = Math.max(0, depth - 1);
      else if (token.text === ";" && depth === 0) {
        flush();
        continue;
      }
    }
    if (from === null) from = token.start;
    to = token.end;
  }
  flush();
  return { ok: true, statements: out };
}
