import { describe, expect, it } from "vitest";
import { parseCsvText, readCsv } from "./csv";

async function* chunks(text: string, size = 7) {
  const bytes = Buffer.from(text);
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}
async function collect(input: AsyncIterable<Record<string, string>>) {
  const rows = [];
  for await (const row of input) rows.push(row);
  return rows;
}
describe("streaming CSV", () => {
  it("handles BOM, CRLF, escaped quotes, UTF-8 and quoted newlines in 7-byte chunks", async () => {
    expect(
      await collect(
        readCsv(chunks('\uFEFFname,note\r\nFictional Alpha,"été\r\nsaid ""hello"""\r\n')),
      ),
    ).toEqual([{ name: "Fictional Alpha", note: 'été\r\nsaid "hello"' }]);
  });
  it("supports LF, empty fields and no final newline", async () => {
    expect(await parseCsvText("a,b\n,\nx,y")).toEqual([
      { a: "", b: "" },
      { a: "x", b: "y" },
    ]);
  });
  it("reports the physical starting line for an unterminated quote", async () => {
    await expect(parseCsvText('a,b\n1,2\n3,"unfinished\nfield')).rejects.toThrow(/line 3/i);
  });
  it("rejects mismatched counts with the physical row line", async () => {
    await expect(parseCsvText('a,b\n"one\ntwo",x\nwrong')).rejects.toThrow(/line 4/i);
  });
  it("validates headers even for a header-only file", async () => {
    const headers: string[][] = [];
    expect(await collect(readCsv(chunks("a,b\n"), (h) => headers.push(h)))).toEqual([]);
    expect(headers).toEqual([["a", "b"]]);
  });
  it("rejects stray quotes, text after closing quotes and duplicate headers", async () => {
    for (const text of ['a\nab"c', 'a\n"abc"x', "a,a\nx,y"]) {
      await expect(parseCsvText(text)).rejects.toThrow(/line/i);
    }
  });
  it("yields before asking for the rest of the input", async () => {
    let continued = false;
    async function* source() {
      yield "a\nfirst\n";
      continued = true;
      yield "second\n";
    }
    const reader = readCsv(source());
    expect((await reader.next()).value).toEqual({ a: "first" });
    expect(continued).toBe(false);
    await reader.return(undefined);
  });
  it("is independent of chunk sizes, including split escaped quotes and CRLF", async () => {
    const input =
      '\uFEFFname,note\r\n"Fictional été","one ""two""\r\nthree"\r\nFictional Beta,last';
    const expected = await parseCsvText(input);
    for (let size = 1; size <= Buffer.byteLength(input); size++) {
      expect(await collect(readCsv(chunks(input, size)))).toEqual(expected);
    }
  });
});
