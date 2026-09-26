import { describe, expect, it } from "vitest";

import { CsvError, normalizeHeader, parseCsv, toCsv } from "@/lib/import/csv";
import { readDay, readList, readMoney, readNumber, readWholeNumber } from "@/lib/import/values";

describe("parseCsv", () => {
  it("reads what Excel's CSV UTF-8 writes: BOM, CRLF, quotes, commas and line breaks inside quotes, Bangla", () => {
    const text = '﻿Name,Phone,Address Detail\r\n"Karim, Rezaul",01812345678,"Road 27\r\nDhanmondi"\r\nফারজানা আক্তার,01911223344,"She said ""hi"""\r\n\r\n';
    const table = parseCsv(text);
    expect(table.headers).toEqual(["name", "phone", "address_detail"]);
    expect(table.rows).toEqual([
      { line: 2, values: { name: "Karim, Rezaul", phone: "01812345678", address_detail: "Road 27\r\nDhanmondi" } },
      // The quoted line break makes this sheet row 4, as a spreadsheet would number it.
      { line: 4, values: { name: "ফারজানা আক্তার", phone: "01911223344", address_detail: 'She said "hi"' } },
    ]);
  });

  it("fills missing trailing cells with blanks and drops blank lines", () => {
    const table = parseCsv("a,b,c\n1\n\n,,\n2,3,4");
    expect(table.rows.map((r) => r.values)).toEqual([
      { a: "1", b: "", c: "" },
      { a: "2", b: "3", c: "4" },
    ]);
  });

  it("refuses an empty file, a header with no data, a repeated column and an unclosed quote", () => {
    expect(() => parseCsv("")).toThrow(CsvError);
    expect(() => parseCsv("a,b\n")).toThrow(/no data/);
    expect(() => parseCsv("Size,size\n1,2")).toThrow(/twice/);
    expect(() => parseCsv('a\n"open')).toThrow(/never closed/);
    expect(() => parseCsv("a\n1\n2\n3", { maxRows: 2 })).toThrow(/At most 2 rows/);
  });

  it("normalizes headers and round-trips through toCsv", () => {
    expect(normalizeHeader(" Opening-Qty ")).toBe("opening_qty");
    expect(normalizeHeader("Price (৳)")).toBe("price_");
    const csv = toCsv(["name", "note"], [["A, B", 'say "x"']]);
    expect(parseCsv(csv).rows[0].values).toEqual({ name: "A, B", note: 'say "x"' });
  });
});

describe("cell readers", () => {
  it("reads money the way people type it", () => {
    expect(readNumber("৳ 1,42,000.50")).toBe(142000.5);
    expect(readNumber("১২৫০")).toBe(1250);
    expect(readNumber("")).toBeNull();
    expect(readNumber("12a")).toBeNaN();
    expect(readMoney("Tk. 950", "unit_cost")).toBe("950.00");
    expect(() => readMoney("9.999", "unit_cost")).toThrow(/2 decimals/);
    expect(() => readMoney("-5", "unit_cost")).toThrow(/below 0/);
    expect(readMoney("-5", "opening_balance", { min: -100 })).toBe("-5.00");
  });

  it("reads whole numbers within bounds", () => {
    expect(readWholeNumber("6", "qty")).toBe(6);
    expect(() => readWholeNumber("1.5", "qty")).toThrow(/whole/);
    expect(() => readWholeNumber("0", "weight", { min: 1 })).toThrow(/between/);
  });

  it("reads dates ISO or day-first, never month-first", () => {
    expect(readDay("2026-10-01", "d")).toBe("2026-10-01");
    expect(readDay("03/04/2026", "d")).toBe("2026-04-03");
    expect(readDay("25.09.2026", "d")).toBe("2026-09-25");
    expect(() => readDay("31/02/2026", "d")).toThrow(/real date/);
    expect(() => readDay("Sept 25", "d")).toThrow(/YYYY-MM-DD/);
  });

  it("splits lists on semicolons", () => {
    expect(readList(" eid; new |sale ;")).toEqual(["eid", "new", "sale"]);
  });
});
