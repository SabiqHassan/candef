import { StringDecoder } from "node:string_decoder";

/** Buffers only the current record; line numbers refer to physical input lines. */
export async function* readCsv(
  input: AsyncIterable<string | Buffer>,
  onHeader?: (headers: string[]) => void,
  includeColumn?: (header: string) => boolean,
): AsyncGenerator<Record<string, string>> {
  const decoder = new StringDecoder("utf8");
  let headers: string[] | null = null;
  let fields: string[] = [];
  let field = "";
  let fieldTouched = false;
  let selected: boolean[] = [];
  const retainField = () => !headers || selected[fields.length] !== false;
  let state: "plain" | "quoted" | "closed" = "plain";
  let line = 1;
  let rowLine = 1;
  let first = true;
  let previousCr = false;
  let skipLf = false;
  let touched = false;
  const fail = (message: string): never => {
    throw new Error(`CSV line ${rowLine}: ${message}`);
  };
  function finish(): Record<string, string> | null {
    fields.push(field);
    field = "";
    fieldTouched = false;
    const values = fields;
    fields = [];
    touched = false;
    state = "plain";
    if (!headers) {
      if (new Set(values).size !== values.length || values.some((v) => !v))
        fail("empty or duplicate header");
      headers = values;
      onHeader?.(headers);
      selected = headers.map((header) => includeColumn?.(header) ?? true);
      return null;
    }
    if (values.length !== headers.length)
      fail(`expected ${headers.length} fields, got ${values.length}`);
    return Object.fromEntries(
      headers.flatMap((header, i) => (selected[i] ? [[header, values[i]!]] : [])),
    );
  }
  async function* decoded() {
    for await (const chunk of input) {
      // Flush any partial byte sequence before a caller switches to decoded strings.
      yield typeof chunk === "string" ? decoder.end() + chunk : decoder.write(chunk);
    }
    yield decoder.end();
  }
  for await (const chunk of decoded()) {
    for (const character of chunk) {
      if (first) {
        first = false;
        if (character === "\uFEFF") continue;
      }
      if (skipLf) {
        skipLf = false;
        if (character === "\n") {
          previousCr = false;
          rowLine = line;
          continue;
        }
      }
      touched = true;
      let ended = false;
      if (state === "quoted") {
        if (character === '"') state = "closed";
        else if (retainField()) field += character;
      } else if (state === "closed" && character === '"') {
        if (retainField()) field += '"';
        state = "quoted";
      } else if (character === ",") {
        fields.push(field);
        field = "";
        fieldTouched = false;
        state = "plain";
      } else if (character === "\r" || character === "\n") {
        const row = finish();
        if (row) yield row;
        ended = true;
        skipLf = character === "\r";
      } else if (state === "closed") {
        fail("unexpected character after closing quote");
      } else if (character === '"') {
        if (fieldTouched) fail("quote inside an unquoted field");
        state = "quoted";
      } else {
        fieldTouched = true;
        if (retainField()) field += character;
      }
      if (character === "\r" || (character === "\n" && !previousCr)) line++;
      previousCr = character === "\r";
      if (ended) rowLine = line;
    }
  }
  if (state === "quoted") fail("unterminated quote");
  if (touched || fields.length || field) {
    const row = finish();
    if (row) yield row;
  }
}

export async function parseCsvText(text: string): Promise<Record<string, string>[]> {
  async function* input() {
    yield text;
  }
  const rows: Record<string, string>[] = [];
  for await (const row of readCsv(input())) rows.push(row);
  return rows;
}
