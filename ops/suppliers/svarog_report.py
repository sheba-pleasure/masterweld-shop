#!/usr/bin/env python3
"""Build an offline, private Russian review UI from a verified intake snapshot."""
from __future__ import annotations
import argparse
import base64
from decimal import Decimal
import hashlib
import json
import os
from pathlib import Path
import re

from svarog_price_updates import SCHEMA, DIFF_SCHEMA, IntakeError, read_committed

CATEGORIES = {
    "equipment": "Сварочные аппараты", "materials": "Сварочные материалы",
    "gas/reducers": "Редукторы и регуляторы", "gas/components": "Комплектующие газового оборудования",
    "gas/torches-cutters": "Газовые горелки и резаки", "gas/cutting-machines": "Машины газовой резки",
    "torches": "Сварочные горелки", "torch-spares": "Запасные части к горелкам",
    "protection-chemistry": "Защита и химия", "accessories": "Аксессуары",
}
REASONS = {
    "duplicate_supplier_code": "Один код встречается в нескольких строках",
    "price_formula_requires_review": "Цена рассчитана формулой; нужна сумма от поставщика",
    "price_missing_or_invalid": "Цена отсутствует или требует проверки",
    "price_currency_unconfirmed": "Валюта цены в этой части прайса не подтверждена",
    "hidden_source_row_or_sheet": "Строка или лист скрыты в исходном Excel",
    "discontinued_text_requires_review": "В тексте есть отметка о снятии с производства",
    "package_unknown": "Количество в упаковке не установлено",
    "package_formula_requires_review": "Упаковка указана формулой",
    "model_formula_requires_review": "Модель указана формулой",
    "manufacturer_article_formula_requires_review": "Артикул производителя указан формулой",
    "manufacturer_article_format_requires_review": "Проверить формат артикула производителя",
    "supplier_code_numeric_format_requires_review": "Нужен точный код с ведущими нулями",
    "supplier_code_formula_or_missing": "Код отсутствует или задан формулой",
    "supplier_code_requires_review": "Проверить код поставщика",
    "product_name_requires_review": "Название не установлено",
    "name_from_description_column": "Название взято из описания; проверить",
}
FIELDS = {"source_price": "Цена поставщика", "title": "Название", "manufacturer_article": "Артикул",
          "model": "Модель", "packaging": "Упаковка", "category": "Группа", "section": "Раздел",
          "review_reasons": "Вопросы к источнику", "supplier_code": "Код"}
KINDS = {"recommended_retail": "Рекомендованная розничная цена",
         "recommended_retail_package": "Рекомендованная цена упаковки",
         "retail": "Розничная цена поставщика"}
CHANGE = {"new": "Новая строка", "changed": "Изменение в прайсе", "missing": "Нет в новом прайсе",
          "conflict": "Требуется сверка", "unchanged": "Без изменений"}

def price_text(price):
    if price.get("value_decimal") is None:
        return "Сумма требует уточнения"
    value = format(Decimal(price["value_decimal"]), "f")
    whole, dot, fraction = value.partition(".")
    whole = f"{int(whole):,}".replace(",", " ")
    text = whole + ("," + fraction if dot else "")
    return text + (" ₽" if price.get("currency") == "RUB" else " (валюта не подтверждена)")

def package_text(package):
    parts = []
    for key, label in (("quantity", "Количество в упаковке"), ("material_amount", "Масса/длина"),
                       ("minimum", "Минимальная партия")):
        if package.get(key) is not None:
            value = str(package[key])
            if key == "material_amount" and package.get("material_unit"):
                value += " " + str(package["material_unit"])
            parts.append(label + ": " + value)
    return "; ".join(parts)

def report_data(snapshot, diff, previous=None):
    if snapshot.get("schema") != SCHEMA or diff.get("schema") != DIFF_SCHEMA:
        raise IntakeError("REPORT_SCHEMA")
    if diff.get("source_sha256") != snapshot["source"]["sha256"]:
        raise IntakeError("REPORT_DIFF_SOURCE")
    if previous is not None and diff.get("previous_sha256") != previous["source"]["sha256"]:
        raise IntakeError("REPORT_PREVIOUS_SOURCE")
    changes, fields = {}, {}
    for kind in ("new", "missing", "unchanged"):
        for row in diff[kind]:
            changes[row["row_id"]] = kind
    for entry in diff["changed"]:
        changes[entry["after"]["row_id"]] = "changed"
        fields[entry["after"]["row_id"]] = list(entry["fields"])
    for entry in diff["conflicts"]:
        for row in entry["after"]:
            changes[row["row_id"]] = "conflict"
            fields[row["row_id"]] = list(entry.get("fields", {}))
    current_ids = {row["row_id"] for row in snapshot["rows"]}
    missing_ids = {row["row_id"] for row in diff["missing"]}
    all_rows = snapshot["rows"] + [r for r in (previous or {}).get("rows", []) if r["row_id"] in missing_ids and r["row_id"] not in current_ids]
    # Missing rows remain visible even when only their immutable row references are available.
    if previous is None:
        for r in diff["missing"]:
            all_rows.append(r | {"manufacturer_article": None, "category": "В прежнем прайсе",
                "section": None, "packaging": {}, "offer": {"source_price": {}},
                "review_reasons": ["missing_previous_details"]})
    baseline = diff.get("previous_sha256") is None
    rows = []
    for r in all_rows:
        price = r["offer"]["source_price"]
        change = changes.get(r["row_id"], "unchanged")
        raw_reasons = r["review_reasons"]
        rows.append({
            "id": r["row_id"], "code": r["supplier_code"] or "Код не установлен",
            "title": r.get("title") or "Название требует проверки",
            "article": r.get("manufacturer_article"), "category": CATEGORIES.get(r["category"], r["category"]),
            "section": r.get("section"), "packaging": package_text(r["packaging"]),
            "priceLabel": price_text(price), "priceNote": KINDS.get(price.get("kind"), "Сумма в исходном прайсе") + ". Не цена магазина.",
            "locator": r["source"]["sheet"] + ", строка " + str(r["source"]["row"]),
            "duplicate": "duplicate_supplier_code" in raw_reasons,
            "formula": bool(price.get("formula_sha256")), "hidden": r["source"].get("hidden", False),
            "reasons": [REASONS.get(x, "Требуется проверка исходной строки") for x in raw_reasons],
            "change": change, "changeLabel": "Исходный прайс" if baseline and change == "new" else CHANGE[change],
            "changedFields": [FIELDS.get(f, "Сведения источника") for f in fields.get(r["row_id"], [])],
        })
    summary = snapshot["summary"]
    return {"rows": rows, "filename": snapshot["source"]["filename"],
            "comparison": "Это первая версия в реестре." if baseline else "Сравнение с предыдущей сохранённой версией.",
            "stats": [[summary["rows"], "строк исходного прайса"], [summary["unique_codes"], "кодов поставщика"],
                      [summary["duplicate_code_groups"], "групп с повторяющимися кодами"],
                      [len(diff["changed"]), "изменённых предложений"]]}

def render(snapshot, diff, previous=None):
    data = json.dumps(report_data(snapshot, diff, previous), ensure_ascii=False, separators=(",", ":"))
    data = data.replace("&", "\\u0026").replace("<", "\\u003c").replace(">", "\\u003e")
    template = Path(__file__).with_suffix(".html").read_text()
    script = re.search(r"<script>\n([\s\S]*?)</script>", template).group(1)
    script = "\n" + script
    digest = base64.b64encode(hashlib.sha256(script.encode()).digest()).decode()
    return template.replace("__DATA__", data).replace("__SCRIPT_HASH__", "'sha256-" + digest + "'")

def build_report(state: Path, source_sha: str):
    # read_committed verifies immutable original/snapshot/diff/summary hashes.
    if not re.fullmatch("[0-9a-f]{64}", source_sha):
        raise IntakeError("REPORT_INVALID_SHA")
    directory = Path(state) / "snapshots" / source_sha
    receipt, snapshot = read_committed(directory, source_sha)
    diff = json.loads((directory / "diff.json").read_bytes())
    previous = None
    if diff["previous_sha256"]:
        _, previous = read_committed(Path(state) / "snapshots" / diff["previous_sha256"], diff["previous_sha256"])
    target = directory / "catalog-review-v2.html"
    result = render(snapshot, diff, previous)
    if target.exists() and target.read_text() != result:
        raise IntakeError("REPORT_EXISTS_DIFFERENT")
    if not target.exists():
        descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w") as stream:
            stream.write(result)
    return {"report": str(target), "rows": len(snapshot["rows"]), "network": False, "catalog_changed": False}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", required=True, type=Path)
    parser.add_argument("--sha", required=True)
    args = parser.parse_args()
    print(json.dumps(build_report(args.state, args.sha), ensure_ascii=False))

if __name__ == "__main__":
    main()
