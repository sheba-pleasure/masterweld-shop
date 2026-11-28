#!/usr/bin/env python3
"""Offline Svarog XLSX versions: immutable private intake and review-only comparison.

No network, database, approval, catalog mutation or scheduling. A supplier quote
never becomes our purchase/sale price. XLSX formulas are evidence only; cached
results are neither parsed nor used as values. This parser uses the standard
library and reads explicit known sheet layouts, refusing changed headers.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import csv
from decimal import Decimal, InvalidOperation
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import posixpath
import re
import shutil
import stat
import tempfile
import xml.etree.ElementTree as ET
import zipfile

SCHEMA = "masterweld-svarog-price-snapshot-v1"
DIFF_SCHEMA = "masterweld-svarog-price-diff-v1"
NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
RID = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
MAX_BYTES = 5 * 1024 * 1024
MAX_EXPANDED = 80 * 1024 * 1024
MAX_ROWS = 30000
MAX_CELLS = 300000
# Columns are established by exact header roles, never a guessed price position.
# Materials' unnamed C column is retained as package evidence, not stock.
PROFILES = {
    "Сварочное оборудование Сварог": ("equipment", "recommended_retail", None),
    "Сварочные материалы": ("materials", "recommended_retail_package", "material_amount"),
    "Редукторы и регуляторы": ("gas/reducers", "retail", "quantity"),
    "Комплектующие к ГО": ("gas/components", "retail", None),
    "Горелки и резаки газовые": ("gas/torches-cutters", "retail", "quantity"),
    "Машины газовой резки": ("gas/cutting-machines", "retail", None),
    "Сварочные горелки": ("torches", "retail", "minimum"),
    "Запасные части к горелкам": ("torch-spares", "retail", "minimum"),
    "СИЗ и химия": ("protection-chemistry", "recommended_retail", "minimum"),
    "Аксессуары": ("accessories", "recommended_retail", "minimum"),
}


CATEGORY_LABELS = {
    "equipment": "Сварочное оборудование", "materials": "Сварочные материалы",
    "gas/reducers": "Редукторы и регуляторы", "gas/components": "Комплектующие к газовому оборудованию",
    "gas/torches-cutters": "Газовые горелки и резаки", "gas/cutting-machines": "Машины газовой резки",
    "torches": "Сварочные горелки", "torch-spares": "Запчасти к горелкам",
    "protection-chemistry": "Защита и химия", "accessories": "Аксессуары",
}
REVIEW_LABELS = {
    "supplier_code_formula_or_missing": "Код отсутствует или задан формулой",
    "supplier_code_numeric_format_requires_review": "Формат цифрового кода требует проверки",
    "supplier_code_requires_review": "Код требует проверки",
    "product_name_requires_review": "В колонке наименования нет пригодного текста",
    "name_from_description_column": "Предложено название из описания той же строки",
    "hidden_source_row_or_sheet": "Строка или лист скрыты в исходнике",
    "discontinued_text_requires_review": "В названии есть пометка о снятии с производства",
    "package_formula_requires_review": "Упаковка задана формулой",
    "package_unknown": "Упаковка или минимальная партия не указаны",
    "model_formula_requires_review": "Модель задана формулой",
    "manufacturer_article_format_requires_review": "Формат артикула требует проверки",
    "manufacturer_article_formula_requires_review": "Артикул задан формулой",
    "price_formula_requires_review": "Цена задана формулой; результат не принят",
    "price_missing_or_invalid": "Числовая цена отсутствует или недопустима",
    "price_currency_unconfirmed": "В заголовке цены не подтверждена валюта",
    "duplicate_supplier_code": "Код встречается в нескольких строках",
}


class IntakeError(ValueError):
    """Fixed operational codes; do not echo supplier/private content to stdout."""


def require(condition, code):
    if not condition:
        raise IntakeError(code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def normalized(value):
    return re.sub(r"\s+", " ", value or "").strip()


def xml(raw):
    # Reject UTF-16/32 declarations too: NUL bytes must not hide a DTD from
    # the lexical guard before ElementTree sees it.
    require(0 not in raw and b"<!DOCTYPE" not in raw.upper() and b"<!ENTITY" not in raw.upper(), "UNSAFE_XML")
    try:
        return ET.fromstring(raw)
    except ET.ParseError:
        raise IntakeError("INVALID_XML") from None


def decimal_value(raw):
    try:
        value = Decimal(raw)
    except (InvalidOperation, TypeError):
        return None
    if (not value.is_finite() or not -100 <= value.as_tuple().exponent <= 15
            or len(value.as_tuple().digits) > 100 or abs(value) > Decimal("1000000000000000")):
        return None
    # Decimal.normalize() applies the ambient precision and could round an
    # exact supplier value. Fixed formatting with trailing-zero removal does not.
    text = format(value, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def cell_value(cell):
    return cell.get("value") if cell else None


def read_cell(node, strings, formats):
    kind = node.get("t", "n")
    raw_node = node.find("m:v", NS)
    raw = raw_node.text if raw_node is not None else None
    style = int(node.get("s", "0"))
    require(0 <= style < len(formats), "INVALID_CELL_STYLE")
    formula = node.find("m:f", NS)
    result = {"type": kind, "raw": raw, "value": None, "number_format": formats[style]}
    if formula is not None:
        # A cached value can look valid (including a shared formula's followers).
        # Keep only its hash; the unchanged workbook preserves the exact bytes.
        result.update(type="f", raw=None, formula=formula.text,
                      formula_attributes=dict(formula.attrib),
                      formula_xml_sha256=sha(ET.tostring(formula)),
                      cached_value_sha256=sha(raw.encode()) if raw is not None else None)
    elif kind == "s":
        require(raw is not None and raw.isdigit() and int(raw) < len(strings), "INVALID_SHARED_STRING")
        result["value"] = strings[int(raw)]
    elif kind == "inlineStr":
        result["value"] = "".join(x.text or "" for x in node.findall("m:is//m:t", NS))
    elif kind in ("str", "d"):
        result["value"] = raw
    elif kind == "n" and raw is not None:
        result["value"] = decimal_value(raw)
        require(result["value"] is not None, "INVALID_NUMBER")
    elif kind not in ("n", "b", "e"):
        raise IntakeError("UNSUPPORTED_CELL_TYPE")
    return result


def code_display(cell):
    if not cell or cell["type"] == "f":
        return None, "supplier_code_formula_or_missing"
    value = cell_value(cell)
    if cell["type"] == "n":
        # Never invent missing zeroes for General or round a scientific code.
        positive_format = cell["number_format"].split(";")[0]
        if (not value or not re.fullmatch(r"[0-9]+", value)
                or not re.fullmatch(r"0{1,32}", positive_format)):
            return None, "supplier_code_numeric_format_requires_review"
        return value.zfill(len(positive_format)), None
    if cell["type"] in ("s", "inlineStr", "str") and value:
        candidate = value.strip()
        if re.fullmatch(r"[A-Za-zА-Яа-я0-9][A-Za-zА-Яа-я0-9._/-]{0,63}", candidate):
            return candidate, None
    return None, "supplier_code_requires_review"


def header_columns(rows, sheet):
    headers = []
    for row in rows[:50]:
        values = {col: normalized(cell_value(c)).upper() for col, c in row["cells"].items()}
        if "КОД" not in values.values():
            continue
        require(sum(v == "КОД" for v in values.values()) == 1, "AMBIGUOUS_CODE_HEADER")
        mapping = {"code": next(c for c, v in values.items() if v == "КОД")}
        for role, predicate in {
            "name": lambda v: v == "НАИМЕНОВАНИЕ" or (sheet == "Сварочные материалы" and v == "ДИАМЕТР ПРОВОЛОКИ / МАССА КАТУШКИ"),
            "article": lambda v: v == "АРТИКУЛ",
            "model": lambda v: v == "МОДЕЛЬ",
            "minimum": lambda v: v.startswith("МИНИМАЛЬНАЯ ПАРТИЯ"),
            "quantity": lambda v: v.startswith("КОЛИЧЕСТВО В УПАКОВКЕ"),
        }.items():
            found = [c for c, v in values.items() if predicate(v)]
            require(len(found) <= 1, "AMBIGUOUS_HEADER")
            mapping[role] = found[0] if found else None
        prices = [c for c, v in values.items()
                  if (v.startswith("РЕКОМЕНДОВАННАЯ РОЗНИЧНАЯ ЦЕНА")
                      or v.startswith("РОЗНИЧНАЯ ЦЕНА")
                      or v.startswith("РРЦ"))]
        if sheet == "Сварочные материалы":
            # Two tiered price columns: require their explicit second-line units.
            next_row = next((r for r in rows if r["number"] == row["number"] + 1), None)
            require(next_row is not None, "MATERIAL_PRICE_HEADER_CHANGED")
            prices = [c for c in prices if normalized(cell_value(next_row["cells"].get(c))).upper() == "УПАКОВКА"]
            require(mapping["name"] == "B", "MATERIAL_PACKAGE_COLUMN_CHANGED")
            mapping["material_amount"] = "C"
        require(mapping["name"] is not None and len(prices) == 1, "SHEET_HEADER_REQUIRES_REVIEW")
        mapping["price"] = prices[0]
        mapping["currency"] = "RUB" if "₽" in values[prices[0]] else None
        mapping["price_header"] = cell_value(row["cells"][prices[0]])
        mapping["header_row"] = row["number"]
        headers.append(mapping)
    require(len(headers) == 1, "SHEET_HEADER_REQUIRES_REVIEW")
    return headers[0]


def normalize_sheet(sheet, rows, digest):
    name = sheet["name"].strip()
    category, price_kind, package_role = PROFILES[name]
    columns = header_columns(rows, name)
    require(package_role in (None, "material_amount") or columns[package_role] is not None,
            "PACKAGE_HEADER_REQUIRES_REVIEW")
    result = []
    section, material_unit = None, None
    for row in rows:
        if row["number"] <= columns["header_row"]:
            continue
        cells = row["cells"]
        code_cell = cells.get(columns["code"])
        code_raw = cell_value(code_cell)
        title_cell = cells.get(columns["name"])
        title = cell_value(title_cell)
        # A text heading with no product name is not an identifier.
        # Numeric/formula identifiers with missing names remain review rows.
        code, code_problem = code_display(code_cell)
        looks_code = code is not None and bool(re.search(r"\d", code))
        is_product = bool(code_cell and ((code_cell["type"] == "n" and code_raw is not None)
                          or code_cell["type"] == "f" or (title and code is not None) or looks_code))
        if not is_product:
            if isinstance(code_raw, str) and code_raw.strip():
                section = code_raw
            unit = cell_value(cells.get("C"))
            if name == "Сварочные материалы" and unit in ("кг", "шт", "шт.", "м"):
                material_unit = unit
            continue
        reasons = []
        if code_problem:
            reasons.append(code_problem)
        # Supplier descriptions are preserved; no marketing/brand/model inference.
        if not isinstance(title, str) or not title.strip() or title_cell["type"] not in ("s", "str", "inlineStr"):
            title = None
            reasons.append("product_name_requires_review")
            description = cells.get("C") if name == "Горелки и резаки газовые" else None
            if description and description["type"] in ("s", "str", "inlineStr") and cell_value(description):
                title = cell_value(description)
                reasons.append("name_from_description_column")
        if row["hidden"] or sheet["state"] != "visible":
            reasons.append("hidden_source_row_or_sheet")
        if title and "СНЯТ" in title.upper():
            reasons.append("discontinued_text_requires_review")
        package = {"quantity": None, "material_amount": None, "material_unit": None, "minimum": None}
        if package_role:
            pc = cells.get(columns[package_role])
            package[package_role] = cell_value(pc)
            if package_role == "material_amount":
                package["material_unit"] = material_unit
            if pc and pc["type"] == "f":
                reasons.append("package_formula_requires_review")
            if cell_value(pc) is None:
                reasons.append("package_unknown")
        model_cell = cells.get(columns["model"]) if columns["model"] else None
        model_value = cell_value(model_cell)
        model = {"state": "source_unverified" if model_value else "unknown", "value": model_value}
        if model_cell and model_cell["type"] == "f":
            reasons.append("model_formula_requires_review")
        article_cell = cells.get(columns["article"]) if columns["article"] else None
        article = cell_value(article_cell)
        if article_cell and article_cell["type"] == "n" and article is not None:
            article, article_issue = code_display(article_cell)
            if article_issue:
                reasons.append("manufacturer_article_format_requires_review")
        if article_cell and article_cell["type"] == "f":
            reasons.append("manufacturer_article_formula_requires_review")
        price_cell = cells.get(columns["price"])
        price = cell_value(price_cell) if price_cell and price_cell["type"] == "n" else None
        if price is not None and Decimal(price) < 0:
            price = None
        if price_cell and price_cell["type"] == "f":
            reasons.append("price_formula_requires_review")
        elif price is None:
            reasons.append("price_missing_or_invalid")
        if columns["currency"] is None:
            reasons.append("price_currency_unconfirmed")
        locator = {"sheet": sheet["name"], "row": row["number"],
                   "hidden": row["hidden"], "sheet_state": sheet["state"]}
        row_id = sha(canonical([digest, sheet["name"], row["number"]]))
        identity = {"supplier": "svarog", "code": code, "model": model_value,
                    "package": {k: v for k, v in package.items() if k != "minimum"}}
        stable_key = sha(canonical(identity)) if code is not None else None
        price_source = {"value_decimal": price, "currency": columns["currency"],
                        "kind": price_kind, "state": "unverified",
                        "cell": columns["price"] + str(row["number"]),
                        "header": columns["price_header"],
                        "source_value_raw": cell_value(price_cell),
                        "formula_sha256": price_cell.get("formula_xml_sha256") if price_cell else None}
        result.append({
            "row_id": row_id, "stable_key": stable_key,
            "code_group_key": sha(canonical(["svarog", code])) if code else None,
            "supplier_code": code, "title": title, "manufacturer_article": article,
            "model": model, "category": category, "section": section, "packaging": package,
            "offer": {"source_price": price_source, "site_price": None, "purchase_price": None,
                      "stock": None, "availability": "unknown", "valid_from": None, "valid_to": None},
            "review_reasons": reasons, "source": locator, "original_cells": cells,
            "readiness": "review", "publication_authorized": False,
        })
    return result


def parse_workbook(raw: bytes, filename: str = "original.xlsx"):
    require(isinstance(raw, bytes) and 0 < len(raw) <= MAX_BYTES, "SOURCE_SIZE_LIMIT")
    require(Path(filename).name == filename and filename.lower().endswith(".xlsx"), "XLSX_REQUIRED")
    digest = sha(raw)
    try:
        archive = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile:
        raise IntakeError("INVALID_XLSX_ZIP") from None
    with archive:
        entries = archive.infolist()
        names = [x.filename for x in entries]
        require(len(entries) <= 4000 and len(set(names)) == len(names), "ZIP_ENTRY_LIMIT_OR_DUPLICATE")
        require(sum(x.file_size for x in entries) <= MAX_EXPANDED, "ZIP_EXPANDED_LIMIT")
        require(not any(x.flag_bits & 1 for x in entries), "ENCRYPTED_ZIP")
        require(not any("vbaproject" in n.lower() or "/activex/" in n.lower() or "/embeddings/" in n.lower()
                        for n in names), "ACTIVE_XLSX_CONTENT")
        require(not any(n.startswith("/") or ".." in n.split("/") for n in names), "ZIP_PATH_INVALID")
        def part(name):
            require(name in names, "XLSX_PART_MISSING")
            return xml(archive.read(name))
        workbook = part("xl/workbook.xml")
        rels = {r.get("Id"): r for r in part("xl/_rels/workbook.xml.rels")}
        shared = part("xl/sharedStrings.xml") if "xl/sharedStrings.xml" in names else []
        strings = ["".join(t.text or "" for t in si.findall(".//m:t", NS)) for si in shared]
        styles = part("xl/styles.xml")
        custom = {int(n.get("numFmtId")): n.get("formatCode") for n in styles.findall("m:numFmts/m:numFmt", NS)}
        formats = [custom.get(int(x.get("numFmtId", "0")),
                              "General" if x.get("numFmtId", "0") == "0" else "builtin:" + x.get("numFmtId"))
                   for x in styles.findall("m:cellXfs/m:xf", NS)]
        require(bool(formats), "XLSX_STYLES_MISSING")
        all_rows, sheet_inventory, unsupported = [], [], []
        total_rows = total_cells = 0
        seen_sheets = set()
        for sh in workbook.findall("m:sheets/m:sheet", NS):
            name = sh.get("name")
            require(name and name.strip() not in seen_sheets, "DUPLICATE_OR_INVALID_SHEET")
            seen_sheets.add(name.strip())
            relationship = rels.get(sh.get(RID))
            require(relationship is not None and relationship.get("TargetMode") != "External", "INVALID_SHEET_RELATIONSHIP")
            target = relationship.get("Target", "")
            path = posixpath.normpath(target.lstrip("/") if target.startswith("/") else "xl/" + target)
            require(path.startswith("xl/worksheets/") and path.endswith(".xml"), "INVALID_SHEET_PATH")
            sheet_xml = part(path)
            rows, seen_rows = [], set()
            for row in sheet_xml.findall("m:sheetData/m:row", NS):
                number = int(row.get("r", "0"))
                require(0 < number <= 1048576 and number not in seen_rows, "INVALID_ROW_LOCATOR")
                seen_rows.add(number)
                cells = {}
                for node in row.findall("m:c", NS):
                    coordinate = node.get("r", "")
                    match = re.fullmatch(r"([A-Z]{1,3})([0-9]+)", coordinate)
                    require(match and int(match[2]) == number and match[1] not in cells, "INVALID_CELL_LOCATOR")
                    cells[match[1]] = read_cell(node, strings, formats)
                    total_cells += 1
                total_rows += 1
                require(total_rows <= MAX_ROWS and total_cells <= MAX_CELLS, "WORKBOOK_ROW_CELL_LIMIT")
                rows.append({"number": number, "hidden": row.get("hidden") == "1", "cells": cells})
            rows.sort(key=lambda r: r["number"])
            sheet = {"name": name, "state": sh.get("state", "visible"), "row_count": len(rows)}
            sheet_inventory.append(sheet)
            if name.strip() == "Оглавление":
                continue
            if name.strip() not in PROFILES:
                unsupported.append(name)
                continue
            all_rows.extend(normalize_sheet(sheet, rows, digest))
        require(bool(all_rows), "NO_PRODUCT_ROWS")
    groups = defaultdict(list)
    for row in all_rows:
        if row["supplier_code"]:
            groups[row["supplier_code"]].append(row)
    for members in groups.values():
        if len(members) > 1:
            for row in members:
                row["review_reasons"].append("duplicate_supplier_code")
    code_groups = [{"supplier_code": code, "row_ids": [r["row_id"] for r in members],
                    "duplicate": len(members) > 1} for code, members in sorted(groups.items())]
    return {"schema": SCHEMA, "supplier": "svarog",
            "source": {"sha256": digest, "filename": filename, "size_bytes": len(raw)},
            "summary": {"rows": len(all_rows), "unique_codes": len(groups),
                        "duplicate_code_groups": sum(len(g) > 1 for g in groups.values()),
                        "conflict_rows": sum(bool(r["review_reasons"]) for r in all_rows),
                        "by_category": dict(Counter(r["category"] for r in all_rows)),
                        "published": 0, "applied_to_shop_database": 0},
            "sheets": sheet_inventory, "unsupported_sheets": unsupported,
            "review_reasons": ["unsupported_sheets_require_review"] if unsupported else [],
            "rows": all_rows, "code_groups": code_groups}


def row_reference(row):
    return {key: row[key] for key in ("row_id", "stable_key", "supplier_code", "title", "source")}


def comparable(row):
    # Source coordinates/formatting do not manufacture product changes.
    return {key: row[key] for key in ("supplier_code", "title", "manufacturer_article", "model",
            "category", "section", "packaging", "review_reasons")} | {
        "source_price": {key: row["offer"]["source_price"][key]
                         for key in ("value_decimal", "currency", "kind", "state", "source_value_raw", "formula_sha256")}}


def compare_snapshots(previous, current):
    require(current.get("schema") == SCHEMA and current.get("supplier") == "svarog", "INVALID_SNAPSHOT")
    require(previous is None or (previous.get("schema") == SCHEMA and previous.get("supplier") == "svarog"),
            "INVALID_PREVIOUS_SNAPSHOT")
    before, after = defaultdict(list), defaultdict(list)
    for row in (previous or {}).get("rows", []):
        before[row["supplier_code"]].append(row)
    for row in current["rows"]:
        after[row["supplier_code"]].append(row)
    result = {"schema": DIFF_SCHEMA, "previous_sha256": (previous or {}).get("source", {}).get("sha256"),
              "source_sha256": current["source"]["sha256"], "new": [], "changed": [],
              "missing": [], "conflicts": [], "unchanged": [],
              "requires_review": True, "catalog_changed": False,
              "policy": {"missing_action": "keep_current_catalog", "manual_edits": "never_overwrite",
                         "publication": "not_authorized", "prices": "unverified_supplier_quotes"}}
    for code in sorted(before.keys() | after.keys(), key=lambda c: c or ""):
        old, new = before[code], after[code]
        if code is None or len(old) > 1 or len(new) > 1:
            result["conflicts"].append({"reason": "unresolved_code" if code is None else "duplicate_supplier_code",
                "supplier_code": code, "before": list(map(row_reference, old)), "after": list(map(row_reference, new))})
        elif not new:
            result["missing"].append(row_reference(old[0]) | {"action": "keep_current_catalog"})
        elif not old:
            result["new"].append(row_reference(new[0]))
        else:
            left, right = comparable(old[0]), comparable(new[0])
            fields = {key: {"before": left[key], "after": right[key]} for key in left if left[key] != right[key]}
            if not fields:
                result["unchanged"].append(row_reference(new[0]))
            elif (old[0]["stable_key"] != new[0]["stable_key"]
                  or any(key in fields for key in ("title", "manufacturer_article", "model"))):
                result["conflicts"].append({"reason": "identity_or_package_changed", "supplier_code": code,
                    "before": [row_reference(old[0])], "after": [row_reference(new[0])], "fields": fields})
            else:
                result["changed"].append({"before": row_reference(old[0]), "after": row_reference(new[0]),
                                          "fields": fields})
    result["summary"] = {key: len(result[key]) for key in ("new", "changed", "missing", "conflicts", "unchanged")}
    result["source_review_reasons"] = current["review_reasons"]
    return result


def markdown_summary(snapshot, diff):
    s, d = snapshot["summary"], diff["summary"]
    lines = ["# Прайс «Сварог»: проверка обновления", "",
             f"Строк в новом файле: **{s['rows']}**. Кодов: **{s['unique_codes']}**.",
             f"Групп повторяющихся кодов: **{s['duplicate_code_groups']}**.", "",
             "| Результат сравнения | Количество |", "|---|---:|",
             f"| Новые позиции | {d['new']} |", f"| Изменения | {d['changed']} |",
             f"| Пропали из нового файла | {d['missing']} |", f"| Конфликты идентичности | {d['conflicts']} |",
             f"| Без изменений | {d['unchanged']} |", "",
             "Это предложения для проверки. Цены поставщика не утверждены как цены магазина или закупки.",
             "Пропавшие позиции остаются в каталоге. Ручные правки, публикация и остатки не меняются.",
             "Формулы и их сохранённые результаты не используются как значения.",
             "Дата получения файла не подтверждает срок действия цен.", "",
             "## Разделы", "", "| Раздел | Строк |", "|---|---:|"]
    for category, count in sorted(s["by_category"].items()):
        lines.append(f"| {CATEGORY_LABELS.get(category, category)} | {count} |")
    lines.extend(["", f"Строк с вопросами для проверки: **{s['conflict_rows']}**.",
                  "Точные строки, ячейки, причины и различия сохранены в snapshot.json и diff.json."])
    reasons = Counter(reason for row in snapshot["rows"] for reason in row["review_reasons"])
    if reasons:
        lines.extend(["", "## Что проверить", "", "Одна строка может иметь несколько причин.", "",
                      "| Причина | Строк |", "|---|---:|"])
        for reason, count in reasons.most_common():
            lines.append(f"| {REVIEW_LABELS.get(reason, reason)} | {count} |")
    if snapshot["unsupported_sheets"]:
        lines.append("Есть неизвестные листы: их содержание требует отдельного разбора.")
    return "\n".join(lines) + "\n"



def csv_formula_risk(value):
    text = str(value or "")
    return bool(text and (text[0] in "\t\r\n" or re.match(r"^[=+@-]", text.lstrip())))


def export_review_csv(snapshot):
    """Return UTF-8 CSV texts for explicit import preview, never publication.

    Importable columns are only sku/title. Prices, brand, stock and category are
    deliberately absent. Supplier/source columns are human evidence, not a
    supplier ownership check in the shop's SKU-based import RPC.
    """
    require(snapshot.get("schema") == SCHEMA, "INVALID_SNAPSHOT")
    counts = Counter(row["supplier_code"] for row in snapshot["rows"])
    headers = ["sku", "title", "supplier", "source_sha256", "source_sheet", "source_row",
               "source_row_id", "draft_only", "price_policy", "review_notes"]
    draft_rows, review_rows = [], []
    exclusion_counts = Counter()
    for row in snapshot["rows"]:
        code, title = row["supplier_code"], row["title"]
        exclusions = []
        if not code or not re.fullmatch(r"[A-Za-zА-Яа-яЁё0-9._/+-]{1,60}", code):
            exclusions.append("Код не подходит для штатного импорта")
        elif counts[code] != 1:
            exclusions.append("Повторяющийся код требует выбора идентичности")
        if not title or not 3 <= len(title.strip()) <= 200:
            exclusions.append("Полное название отсутствует или длиннее допустимых 200 символов")
        if any(reason in row["review_reasons"] for reason in ("product_name_requires_review", "name_from_description_column")):
            exclusions.append("Исходное наименование требует ручной проверки")
        if csv_formula_risk(code) or csv_formula_risk(title):
            exclusions.append("Текст требует защиты от формул электронной таблицы")
        notes = [REVIEW_LABELS.get(reason, reason) for reason in row["review_reasons"]]
        record = [code or "", title or "", "svarog", snapshot["source"]["sha256"],
                  row["source"]["sheet"], str(row["source"]["row"]), row["row_id"],
                  "Да. Только черновик; публикация не разрешена",
                  "Цена не задана. Для новых товаров требуется явное включение цены по запросу",
                  "; ".join(notes)]
        if exclusions:
            exclusion_counts.update(exclusions)
            review_rows.append(record + ["; ".join(exclusions)])
        else:
            draft_rows.append(record)
    def encode(columns, records):
        output = io.StringIO(newline="")
        writer = csv.writer(output, delimiter=";", quoting=csv.QUOTE_ALL, lineterminator="\r\n")
        writer.writerow(columns)
        for record in records:
            # Review files may contain arbitrary source text. Prefixing a quote
            # is display escaping only; snapshot.json retains the exact original.
            writer.writerow(["'" + str(v) if csv_formula_risk(v) else v for v in record])
        return "\ufeff" + output.getvalue()
    draft_csv = encode(headers, draft_rows)
    review_csv = encode(headers + ["exclusion_reason"], review_rows)
    require(len(draft_rows) <= 5000 and len(draft_csv.encode("utf-8")) <= 2 * 1024 * 1024,
            "IMPORT_CSV_LIMIT_REQUIRES_SPLIT")
    manifest = {
        "schema": "masterweld-svarog-draft-export-v1", "source_sha256": snapshot["source"]["sha256"],
        "draft_rows": len(draft_rows), "review_rows": len(review_rows),
        "exclusion_reasons": dict(exclusion_counts), "draft_only": True,
        "catalog_changed": False, "publication_authorized": False,
        "mapped_fields": ["sku", "title"], "supplier_collision_check": "not_performed",
        "draft_csv_sha256": sha(draft_csv.encode("utf-8")), "review_csv_sha256": sha(review_csv.encode("utf-8")),
        "instructions": [
            "Файл draft-inquiry-import.csv предназначен только для предпросмотра и явного подтверждения.",
            "Выберите только колонки sku и title. Остальные колонки — сведения об источнике.",
            "Для новых товаров явно включите «Цена по запросу» в штатном импорте.",
            "Проверьте каждое совпадение SKU с существующей карточкой: принадлежность поставщику, название и ручные правки.",
            "При неустановленном совпадении не применяйте импорт. Файл не подтверждает принадлежность существующих карточек Сварогу.",
            "Новые товары должны остаться черновиками «На разбор». Публикация требует отдельного решения.",
            "Цены, бренд, остатки и категории не назначаются этим файлом.",
            "Открывая CSV в Excel, задайте колонке sku текстовый формат. Не пересохраняйте коды с потерей ведущих нулей.",
            "Экранирование опасного текста апострофом применяется только к CSV; исходные значения сохранены в snapshot.json.",
        ],
    }
    return {"draft_csv": draft_csv, "review_csv": review_csv, "manifest": manifest}


def write_review_export(snapshot, directory):
    result = export_review_csv(snapshot)
    files = {"draft-inquiry-import.csv": result["draft_csv"].encode("utf-8"),
             "rows-requiring-review.csv": result["review_csv"].encode("utf-8"),
             "draft-export-manifest.json": canonical(result["manifest"])}
    for filename, data in files.items():
        path = directory / filename
        require(not path.is_symlink(), "STATE_SYMLINK")
        if path.exists():
            require(path.read_bytes() == data, "REVIEW_EXPORT_EXISTS_DIFFERENT")
        else:
            write_private(path, data)
    sync_directory(directory)
    return result["manifest"]


def private_directory(path):
    require(not path.is_symlink(), "STATE_SYMLINK")
    if not path.exists():
        # pathlib parents=True applies 0700 only to the final directory. Create
        # missing ancestors privately too, without changing existing parents.
        missing = []
        ancestor = path
        while not ancestor.exists():
            require(not ancestor.is_symlink(), "STATE_SYMLINK")
            missing.append(ancestor)
            ancestor = ancestor.parent
        for directory in reversed(missing):
            directory.mkdir(mode=0o700)
    require(path.is_dir() and stat.S_IMODE(path.stat().st_mode) & 0o077 == 0, "STATE_NOT_PRIVATE")


def write_private(path, raw):
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(raw)
        f.flush()
        os.fsync(f.fileno())


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def read_current(state):
    path = state / "current.json"
    require(not path.is_symlink(), "STATE_SYMLINK")
    if not path.exists():
        return None
    try:
        value = json.loads(path.read_bytes())
        digest = value["source_sha256"]
    except (ValueError, KeyError, TypeError):
        raise IntakeError("CURRENT_STATE_INVALID") from None
    require(isinstance(digest, str) and re.fullmatch("[0-9a-f]{64}", digest), "CURRENT_STATE_INVALID")
    return digest


def read_committed(directory, digest):
    require(not directory.is_symlink() and directory.is_dir(), "COMMITTED_STATE_MISSING")
    try:
        receipt = json.loads((directory / "receipt.json").read_bytes())
        original = (directory / "original.xlsx").read_bytes()
        snapshot_raw = (directory / "snapshot.json").read_bytes()
        diff_raw = (directory / "diff.json").read_bytes()
        summary_raw = (directory / "summary.md").read_bytes()
        require(sha(original) == digest and receipt["source_sha256"] == digest
                and sha(snapshot_raw) == receipt["snapshot_sha256"]
                and sha(diff_raw) == receipt["diff_sha256"]
                and sha(summary_raw) == receipt["summary_sha256"], "COMMITTED_STATE_CHECKSUM")
        snapshot = json.loads(snapshot_raw)
        require(snapshot["schema"] == SCHEMA and snapshot["source"]["sha256"] == digest, "COMMITTED_STATE_CHECKSUM")
        return receipt, snapshot
    except (OSError, ValueError, KeyError, TypeError) as error:
        if isinstance(error, IntakeError):
            raise
        raise IntakeError("COMMITTED_STATE_INVALID") from None


def set_current(state, digest):
    path = state / ("current." + digest + ".tmp")
    # Failed pointer writes leave no reusable authorization; safely remove only
    # our own exact non-symlink temporary pointer before rewriting it.
    if path.exists():
        require(not path.is_symlink(), "STATE_SYMLINK")
        path.unlink()
    write_private(path, canonical({"source_sha256": digest}))
    os.replace(path, state / "current.json")
    sync_directory(state)


def intake(original: Path, state: Path, expected_previous: str | None = None):
    """Stage one original; duplicate bytes replay their receipt without rolling back.

    current.json is the most recently parsed source, never an approval or a live
    catalog pointer. expected_previous optionally pins that source for a caller.
    """
    original, state = Path(original), Path(state)
    require(original.suffix.lower() == ".xlsx" and original.is_file(), "XLSX_REQUIRED")
    require(original.stat().st_size <= MAX_BYTES, "SOURCE_SIZE_LIMIT")
    with original.open("rb") as source_file:
        raw = source_file.read(MAX_BYTES + 1)
    require(0 < len(raw) <= MAX_BYTES, "SOURCE_SIZE_LIMIT")
    digest = sha(raw)
    private_directory(state)
    lock_path = state / "intake.lock"
    require(not lock_path.is_symlink(), "STATE_SYMLINK")
    lock_fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lock_fd, "rb") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise IntakeError("INTAKE_BUSY") from None
        snapshots = state / "snapshots"
        private_directory(snapshots)
        current_sha = read_current(state)
        directory = snapshots / digest
        if directory.exists():
            receipt, _snapshot = read_committed(directory, digest)
            # Complete an interrupted initial commit only while its original
            # comparison base is still current. Never move a newer version back.
            if current_sha == receipt["previous_sha256"]:
                set_current(state, digest)
            return receipt | {"status": "duplicate", "snapshot_directory": str(directory)}
        require(expected_previous is None or expected_previous == current_sha, "PREVIOUS_VERSION_CONFLICT")
        # Another source may have committed its immutable directory before a
        # crash updating current.json. Do not treat that gap as an empty base.
        for committed in snapshots.iterdir():
            if committed.name.startswith(".pending-") or committed.name == current_sha:
                continue
            require(re.fullmatch("[0-9a-f]{64}", committed.name) is not None, "COMMITTED_STATE_INVALID")
            try:
                prior_receipt = json.loads((committed / "receipt.json").read_bytes())
                require(prior_receipt["source_sha256"] == committed.name, "COMMITTED_STATE_INVALID")
                require(prior_receipt["previous_sha256"] != current_sha, "RECOVER_PREVIOUS_INTAKE_FIRST")
            except (OSError, ValueError, KeyError, TypeError) as error:
                if isinstance(error, IntakeError):
                    raise
                raise IntakeError("COMMITTED_STATE_INVALID") from None
        previous = read_committed(snapshots / current_sha, current_sha)[1] if current_sha else None
        snapshot = parse_workbook(raw, original.name)
        diff = compare_snapshots(previous, snapshot)
        snapshot_raw, diff_raw = canonical(snapshot), canonical(diff)
        summary_raw = markdown_summary(snapshot, diff).encode("utf-8")
        receipt = {"status": "prepared", "source_sha256": digest, "previous_sha256": current_sha,
                   "summary": diff["summary"], "source_summary": snapshot["summary"],
                   "snapshot_sha256": sha(snapshot_raw), "diff_sha256": sha(diff_raw),
                   "summary_sha256": sha(summary_raw), "requires_review": True, "catalog_changed": False}
        temporary = Path(tempfile.mkdtemp(prefix=".pending-", dir=snapshots))
        try:
            for filename, data in {"original.xlsx": raw, "snapshot.json": snapshot_raw,
                                   "diff.json": diff_raw, "summary.md": summary_raw,
                                   "receipt.json": canonical(receipt)}.items():
                write_private(temporary / filename, data)
            sync_directory(temporary)
            os.rename(temporary, directory)
            sync_directory(snapshots)
            set_current(state, digest)
        finally:
            if temporary.exists():
                shutil.rmtree(temporary)
        return receipt | {"snapshot_directory": str(directory)}


def main(argv=None):
    parser = argparse.ArgumentParser(description="Подготовка и сравнение прайсов Сварог; каталог и цены магазина не меняются.")
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--state", type=Path, required=True, help="Приватный каталог с правами 0700")
    parser.add_argument("--expected-previous")
    parser.add_argument("--export-csv", action="store_true", help="Подготовить CSV для явного подтверждения; импорт не выполняется")
    args = parser.parse_args(argv)
    try:
        result = intake(args.input, args.state, args.expected_previous)
        if args.export_csv:
            directory = Path(result["snapshot_directory"])
            _receipt, snapshot = read_committed(directory, result["source_sha256"])
            result["csv_export"] = write_review_export(snapshot, directory)
    except (IntakeError, OSError, zipfile.BadZipFile, ValueError) as error:
        code = str(error) if isinstance(error, IntakeError) else "INTAKE_IO_OR_FORMAT_ERROR"
        print(json.dumps({"status": "review_required", "error": code, "catalog_changed": False}))
        return 2
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
