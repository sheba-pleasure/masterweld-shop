import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  csvEscape,
  decodeUtf8,
  detectDelimiter,
  hashText,
  isFormulaLike,
  mapColumns,
  MAX_IMPORT_FILE_BYTES,
  MAX_PRICE_RUB,
  parseCsvFields,
  parsePriceFile,
  parseQtyValue,
  parseRubPrice,
  parseStockValue,
  rowsToCsv,
} from "./price-csv";

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(resolve("src/lib/import/__fixtures__", name)));

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("decodeUtf8: кодировка и BOM", () => {
  it("UTF-8 с BOM — BOM снимается, текст читается", () => {
    const bytes = enc("\uFEFFsku;price\nA;1\n");
    const dec = decodeUtf8(bytes);
    expect(dec.ok).toBe(true);
    if (dec.ok) expect(dec.text.startsWith("sku")).toBe(true);
  });

  it("cp1251 (байты 0xC0-0xFF вне UTF-8) — явный отказ, без угадывания", () => {
    // «Артикул» в cp1251: А=0xC0, р=0xF0, ...
    const cp1251 = new Uint8Array([0xc0, 0xf0, 0xf2, 0xe8, 0xea, 0xf3, 0xeb]);
    const dec = decodeUtf8(cp1251);
    expect(dec.ok).toBe(false);
    if (!dec.ok) expect(dec.code).toBe("UNSUPPORTED_ENCODING");
  });

  it("пустой файл и превышение размера — отказ", () => {
    expect(decodeUtf8(new Uint8Array(0))).toEqual({ ok: false, code: "EMPTY_FILE" });
    const big = new Uint8Array(MAX_IMPORT_FILE_BYTES + 1);
    expect(decodeUtf8(big)).toEqual({ ok: false, code: "FILE_TOO_LARGE" });
  });
});

describe("detectDelimiter: строгое определение разделителя", () => {
  it("semicolon, comma, tab определяются однозначно", () => {
    expect(detectDelimiter("a;b;c\n1;2;3")).toBe(";");
    expect(detectDelimiter("a,b,c\n1,2,3")).toBe(",");
    expect(detectDelimiter("a\tb\tc\n1\t2\t3")).toBe("\t");
  });

  it("разделитель внутри кавычек не считается", () => {
    expect(detectDelimiter('a;b\n"x;y;z";2')).toBe(";");
  });

  it("неоднозначность (одинаковое число разных разделителей) — отказ", () => {
    expect(detectDelimiter("a;b,c\n1;2,3")).toBeNull();
  });

  it("нет разделителей вовсе — отказ", () => {
    expect(detectDelimiter("однаколонка\n1\n2")).toBeNull();
  });
});

describe("parseCsvFields: quoted fields", () => {
  it("кавычки, экранированные кавычки и перенос строки внутри поля", () => {
    const r = parseCsvFields('a;"b;c";"d""e"\n"f\ng";2;3', ";");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.rows[0]).toEqual(["a", "b;c", 'd"e']);
      expect(r.rows[1]).toEqual(["f\ng", "2", "3"]);
    }
  });

  it("кавычка не в начале поля — MALFORMED_QUOTES", () => {
    expect(parseCsvFields('a;b"c;d', ";")).toEqual({ ok: false, code: "MALFORMED_QUOTES" });
  });

  it("текст после закрывающей кавычки — MALFORMED_QUOTES", () => {
    expect(parseCsvFields('a;"b"c;d', ";")).toEqual({ ok: false, code: "MALFORMED_QUOTES" });
  });

  it("незакрытая кавычка — MALFORMED_QUOTES", () => {
    expect(parseCsvFields('a;"b;c', ";")).toEqual({ ok: false, code: "MALFORMED_QUOTES" });
  });

  it("CRLF и CR обрабатываются", () => {
    const r = parseCsvFields("a;b\r\n1;2\r3;4", ";");
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.rows).toEqual([
        ["a", "b"],
        ["1", "2"],
        ["3", "4"],
      ]);
  });
});

describe("parseRubPrice: явный формат, до 2 знаков, без ×100", () => {
  it("точка и запятая по объявленному формату", () => {
    expect(parseRubPrice("1234.56", "dot")).toEqual({ ok: true, value: 1234.56 });
    expect(parseRubPrice("1234,56", "comma")).toEqual({ ok: true, value: 1234.56 });
  });

  it("«1,200»: при dot — невалидно, при comma — 3 знака — невалидно (никаких догадок)", () => {
    expect(parseRubPrice("1,200", "dot").ok).toBe(false);
    expect(parseRubPrice("1,200", "comma").ok).toBe(false);
  });

  it("«1.200» аналогично неоднозначен и отвергается", () => {
    expect(parseRubPrice("1.200", "dot").ok).toBe(false);
    expect(parseRubPrice("1.200", "comma").ok).toBe(false);
  });

  it("пробелы и NBSP — разделители тысяч", () => {
    expect(parseRubPrice("1 234,50", "comma")).toEqual({ ok: true, value: 1234.5 });
    expect(parseRubPrice("1\u00a0234.50", "dot")).toEqual({ ok: true, value: 1234.5 });
  });

  it("ноль, отрицательные, > лимита, буквы — отказ", () => {
    expect(parseRubPrice("0", "dot").ok).toBe(false);
    expect(parseRubPrice("-5", "dot").ok).toBe(false);
    expect(parseRubPrice(String(MAX_PRICE_RUB + 1), "dot").ok).toBe(false);
    expect(parseRubPrice("12abc", "dot").ok).toBe(false);
    expect(parseRubPrice("", "dot").ok).toBe(false);
  });
});

describe("parseStockValue / parseQtyValue", () => {
  it("наличие: да/нет в русских и английских вариантах; «под заказ» = нет", () => {
    for (const t of ["да", "1", "yes", "TRUE", "В наличии", "есть"])
      expect(parseStockValue(t)).toBe(true);
    for (const t of ["нет", "0", "no", "false", "под заказ", "нет в наличии"])
      expect(parseStockValue(t)).toBe(false);
    expect(parseStockValue("может быть")).toBeNull();
  });

  it("количество: только целое 0..1 000 000", () => {
    expect(parseQtyValue("10")).toBe(10);
    expect(parseQtyValue("0")).toBe(0);
    expect(parseQtyValue("1 000")).toBe(1000);
    expect(parseQtyValue("-1")).toBeNull();
    expect(parseQtyValue("1.5")).toBeNull();
    expect(parseQtyValue("1000001")).toBeNull();
  });
});

describe("parsePriceFile: полный конвейер", () => {
  it("валидный прайс с русскими колонками, semicolon, comma-десятичные", () => {
    const r = parsePriceFile(fixture("basic-semicolon.csv"), { decimalFormat: "comma" });
    expect(r.ok).toBe(true);
    expect(r.delimiter).toBe(";");
    expect(r.rows).toHaveLength(4);
    expect(r.invalidRows).toHaveLength(0);
    const first = r.rows[0]!;
    expect(first.sku).toBe("TEST-SHIM-01");
    expect(first.salePrice).toBe(1299.5);
    expect(first.costPrice).toBe(800);
    expect(first.stock).toBe(true);
    expect(first.qty).toBe(12);
    expect(first.supplierName).toBe("ООО «Тестовый Поставщик»");
    const third = r.rows[2]!;
    expect(third.salePrice).toBe(2450);
    expect(third.stock).toBe(false);
  });

  it("BOM + tab-разделитель", () => {
    const bytes = enc("\uFEFFартикул\tцена\nTEST-BOM-01\t100\n");
    const r = parsePriceFile(bytes, { decimalFormat: "dot" });
    expect(r.ok).toBe(true);
    expect(r.delimiter).toBe("\t");
    expect(r.rows[0]!.sku).toBe("TEST-BOM-01");
  });

  it("cp1251 — отказ с UNSUPPORTED_ENCODING", () => {
    const cp1251 = new Uint8Array([0x61, 0x72, 0xf2, 0xe8, 0xea, 0x3b, 0x31, 0x0a]);
    const r = parsePriceFile(cp1251, { decimalFormat: "dot" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("UNSUPPORTED_ENCODING");
  });

  it("нет колонки SKU — MISSING_SKU_COLUMN (матчить по названию нельзя)", () => {
    const r = parsePriceFile(fixture("missing-columns.csv"), { decimalFormat: "dot" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("MISSING_SKU_COLUMN");
  });

  it("есть SKU, но нет данных для импорта — MISSING_DATA_COLUMNS", () => {
    const r = parsePriceFile(enc("sku;название\nTEST-X;Что-то\n"), { decimalFormat: "dot" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("MISSING_DATA_COLUMNS");
  });

  it("строка без SKU попадает в invalidRows, файл не отклоняется целиком", () => {
    const r = parsePriceFile(enc("sku;price\n;100\nTEST-OK;200\n"), { decimalFormat: "dot" });
    expect(r.ok).toBe(true);
    expect(r.rows).toHaveLength(1);
    expect(r.invalidRows).toHaveLength(1);
    expect(r.invalidRows[0]!.errors).toContain("SKU_REQUIRED");
  });

  it("битая цена — invalid-строка, не угадывается", () => {
    const r = parsePriceFile(enc("sku;price\nTEST-A;abc\nTEST-B;1,5\n"), { decimalFormat: "dot" });
    expect(r.ok).toBe(true);
    expect(r.rows).toHaveLength(0);
    expect(r.invalidRows.map((x) => x.errors[0])).toEqual([
      "INVALID_SALE_PRICE",
      "INVALID_SALE_PRICE",
    ]);
  });

  it("неизвестные колонки — предупреждение, не ошибка", () => {
    const r = parsePriceFile(enc("sku;price;бренд\nTEST-A;100;X\n"), { decimalFormat: "dot" });
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.code === "UNKNOWN_COLUMN" && w.message.includes("бренд"))).toBe(
      true,
    );
  });

  it("formula-like значения — предупреждение, значения приняты как текст", () => {
    const r = parsePriceFile(fixture("formula.csv"), { decimalFormat: "dot" });
    expect(r.ok).toBe(true);
    expect(r.warnings.filter((w) => w.code === "FORMULA_LIKE_VALUE")).toHaveLength(2);
    expect(r.rows[0]!.supplierName).toBe("=SUM(A1:A9)");
  });

  it("превышение числа строк — TOO_MANY_ROWS", () => {
    const lines = ["sku;price", ...Array.from({ length: 50_001 }, (_, i) => `T-${i};1`)];
    const r = parsePriceFile(enc(lines.join("\n")), { decimalFormat: "dot" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("TOO_MANY_ROWS");
  });

  it("разное число полей в строке — строка отклонена с предупреждением", () => {
    const r = parsePriceFile(enc("sku;price;stock\nTEST-A;100\n"), { decimalFormat: "dot" });
    expect(r.ok).toBe(true);
    expect(r.invalidRows).toHaveLength(1);
    expect(r.invalidRows[0]!.errors).toContain("ROW_COLUMN_MISMATCH");
  });
});

describe("mapColumns: whitelist русских имён", () => {
  it("распознаёт русские синонимы", () => {
    const { columns } = mapColumns(["Артикул", "Цена", "Закупка", "Наличие", "Кол-во"]);
    expect(columns.sku).toBe(0);
    expect(columns.sale_price).toBe(1);
    expect(columns.cost_price).toBe(2);
    expect(columns.stock).toBe(3);
    expect(columns.qty).toBe(4);
  });
});

describe("экспорт CSV: защита от formula injection", () => {
  it("значения =, +, -, @ получают префикс-апостроф", () => {
    expect(csvEscape("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvEscape("+1")).toBe("'+1");
    expect(csvEscape("-2")).toBe("'-2");
    expect(csvEscape("@x")).toBe("'@x");
    expect(isFormulaLike("=evil")).toBe(true);
  });

  it("кавычки и разделители экранируются", () => {
    expect(csvEscape('a"b')).toBe('"a""b"');
    expect(csvEscape("a;b")).toBe('"a;b"');
    expect(csvEscape("обычный")).toBe("обычный");
  });

  it("rowsToCsv собирает корректный CSV", () => {
    const csv = rowsToCsv(
      ["sku", "price"],
      [
        ["TEST-A", "100"],
        ["TEST-B", "=1+1"],
      ],
    );
    expect(csv).toBe("sku,price\r\nTEST-A,100\r\nTEST-B,'=1+1");
  });
});

describe("hashText: идемпотентность батча", () => {
  it("одинаковый текст — одинаковый SHA-256, разный — разный", async () => {
    const a = await hashText("sku;price\nTEST-A;100\n");
    const b = await hashText("sku;price\nTEST-A;100\n");
    const c = await hashText("sku;price\nTEST-A;101\n");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
