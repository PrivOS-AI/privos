export interface Column {
  header: string;
  path: string[];
}

export interface Out {
  write(chunk: string): void;
}

/** raw writes the bytes unchanged. format is json or table. unwrap is the object key that holds the row array. */
export function render(
  out: Out,
  body: Buffer,
  format: string,
  raw: boolean,
  unwrap: string,
  cols: Column[],
): void {
  const text = body.toString("utf8").trim();
  if (raw) {
    out.write(text === "" ? "\n" : `${text}\n`);
    return;
  }
  switch (format) {
    case "":
    case "json":
      writeJSON(out, text);
      return;
    case "table":
      writeTable(out, text, unwrap, cols);
      return;
    default:
      throw new Error(`unsupported format ${JSON.stringify(format)} (use json or table)`);
  }
}

function writeJSON(out: Out, text: string): void {
  if (text === "") {
    out.write("\n");
    return;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    out.write(`${JSON.stringify(parsed, null, 2)}\n`);
  } catch {
    out.write(`${text}\n`);
  }
}

function writeTable(out: Out, text: string, unwrap: string, cols: Column[]): void {
  if (text === "") throw new Error("empty response; use --format json or --raw");
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    throw new Error("response is not JSON; use --format json or --raw");
  }
  const rows = rowArray(payload, unwrap);
  const headers = cols.map((c) => c.header);
  const cells = rows.map((row) =>
    cols.map((c) => {
      const obj = isRecord(row);
      const cell = obj ? lookup(row, c.path) : lookup(row, []);
      return clip(sanitize(cell), 80);
    }),
  );
  printAligned(out, headers, cells);
}

function rowArray(payload: unknown, unwrap: string): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (isRecord(payload)) {
    if (unwrap !== "") {
      if (!(unwrap in payload)) {
        throw new Error(`response has no ${JSON.stringify(unwrap)} array; use --format json or --raw`);
      }
      const inner = payload[unwrap];
      if (!Array.isArray(inner)) {
        throw new Error(`${JSON.stringify(unwrap)} is not an array; use --format json or --raw`);
      }
      return inner;
    }
  }
  throw new Error("response is not a list; use --format json or --raw");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function lookup(v: unknown, path: string[]): string {
  if (path.length === 0) return scalar(v);
  let cur: unknown = v;
  for (const key of path) {
    if (!isRecord(cur)) return "";
    cur = cur[key];
  }
  return scalar(cur);
}

function scalar(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") {
    if (Number.isInteger(v)) return String(v);
    return String(v);
  }
  if (typeof v === "boolean") return v ? "true" : "false";
  return JSON.stringify(v);
}

function sanitize(s: string): string {
  return s.replaceAll("\r", " ").replaceAll("\n", " ").replaceAll("\t", " ");
}

function clip(s: string, n: number): string {
  const chars = [...s];
  if (chars.length <= n) return s;
  if (n <= 3) return chars.slice(0, n).join("");
  return `${chars.slice(0, n - 3).join("")}...`;
}

function printAligned(out: Out, headers: string[], rows: string[][]): void {
  const widths = headers.map((h) => h.length);
  for (const row of rows) {
    row.forEach((cell, i) => {
      if (cell.length > (widths[i] ?? 0)) widths[i] = cell.length;
    });
  }
  const line = (cells: string[]) =>
    cells
      .map((cell, i) => (i < cells.length - 1 ? cell + " ".repeat((widths[i] ?? 0) - cell.length) : cell))
      .join("  ");
  out.write(`${line(headers)}\n`);
  if (rows.length === 0) {
    out.write("(no rows)\n");
    return;
  }
  for (const row of rows) out.write(`${line(row)}\n`);
}
