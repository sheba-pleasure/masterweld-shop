"""Synthetic XLSX regression tests. No network, real data writes or database."""
import copy
import csv
import fcntl
import io
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET
import zipfile

import svarog_price_updates as update

MAIN = update.NS["m"]
ET.register_namespace("", MAIN)


def xlsx(products, *, header_row=2, sheet="Сварочное оборудование Сварог",
         change_header=None, extra_parts=None):
    """Build XLSX bytes directly, including deliberately stale formula caches."""
    workbook = ET.Element("workbook", {"xmlns": MAIN,
                         "xmlns:r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships"})
    sheets = ET.SubElement(workbook, "sheets")
    ET.SubElement(sheets, "sheet", {"name": sheet, "sheetId": "1", "r:id": "rId1"})
    root = ET.Element("worksheet", {"xmlns": MAIN})
    data = ET.SubElement(root, "sheetData")
    gas = sheet == "Горелки и резаки газовые"
    headers = {"A": "КОД", "B": "НАИМЕНОВАНИЕ", "D": "ОПИСАНИЕ" if not gas else "РОЗНИЧНАЯ ЦЕНА,₽",
               "E": "ПАРАМЕТРЫ" if not gas else "Количество в упаковке (шт.)",
               "G": "РЕКОМЕНДОВАННАЯ РОЗНИЧНАЯ ЦЕНА, ₽" if not gas else "Ссылка на сайт",
               "H": "МОДЕЛЬ"}
    if change_header:
        headers.update(change_header)
    def cell(row, column, number, value, numeric_style=1):
        if isinstance(value, tuple) and value[0] == "formula":
            node = ET.SubElement(row, "c", {"r": f"{column}{number}", "s": "1"})
            ET.SubElement(node, "f", value[3] if len(value) > 3 else {}).text = value[1]
            ET.SubElement(node, "v").text = value[2]
        elif isinstance(value, tuple) and value[0] == "number":
            node = ET.SubElement(row, "c", {"r": f"{column}{number}", "s": str(value[2] if len(value) > 2 else numeric_style)})
            ET.SubElement(node, "v").text = str(value[1])
        elif value is None:
            ET.SubElement(row, "c", {"r": f"{column}{number}", "s": "1"})
        else:
            node = ET.SubElement(row, "c", {"r": f"{column}{number}", "t": "inlineStr"})
            ET.SubElement(ET.SubElement(node, "is"), "t").text = str(value)
    header = ET.SubElement(data, "row", {"r": str(header_row)})
    for column, value in headers.items():
        cell(header, column, header_row, value)
    for index, product in enumerate(products, header_row + 1):
        number = product.get("_row", index)
        row = ET.SubElement(data, "row", {"r": str(number), "hidden": "1" if product.get("_hidden") else "0"})
        for column, value in product.items():
            if not column.startswith("_"):
                cell(row, column, number, value)
    parts = {
        "xl/workbook.xml": ET.tostring(workbook),
        "xl/_rels/workbook.xml.rels": b'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"/></Relationships>',
        "xl/styles.xml": ('<styleSheet xmlns="' + MAIN + '"><numFmts count="1"><numFmt numFmtId="164" formatCode="00000000000;[Red]\\-00000000000"/></numFmts><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>').encode(),
        "xl/worksheets/sheet1.xml": ET.tostring(root),
    }
    parts.update(extra_parts or {})
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, raw in parts.items():
            archive.writestr(name, raw)
    return output.getvalue()


def product(code=123, price="100", **extra):
    return {"A": ("number", str(code)), "B": "Аппарат 200", "G": ("number", price)} | extra


def parse(products, **options):
    return update.parse_workbook(xlsx(products, **options), "new-price.xlsx")


class ParserTests(unittest.TestCase):
    def test_numeric_and_text_codes_preserve_zeroes_and_raw_source(self):
        snapshot = parse([product(), product(A="00000000124")])
        first, second = snapshot["rows"]
        self.assertEqual(first["supplier_code"], "00000000123")
        self.assertEqual(first["original_cells"]["A"]["raw"], "123")
        self.assertEqual(second["supplier_code"], "00000000124")
        self.assertEqual(first["source"]["row"], 3)
        self.assertIsNone(first["offer"]["site_price"])
        self.assertIsNone(first["offer"]["purchase_price"])
        self.assertEqual(first["offer"]["source_price"]["state"], "unverified")

    def test_decimal_source_precision_survives_without_context_rounding(self):
        value = "0.225000000000000010000000000000000007"
        row = parse([product(E=("number", value))])["rows"][0]
        self.assertEqual(row["original_cells"]["E"]["value"], value)
        self.assertIsNone(update.decimal_value("1E-100000000"))

    def test_numeric_general_code_requires_review_instead_of_zero_guess(self):
        row = parse([product(A=("number", "123", 0))])["rows"][0]
        self.assertIsNone(row["supplier_code"])
        self.assertIsNone(row["stable_key"])
        self.assertIn("supplier_code_numeric_format_requires_review", row["review_reasons"])

    def test_formula_caches_never_become_price_code_model_or_package(self):
        formula = ("formula", "1+1", "999999")
        row = parse([product(A=formula, G=formula, H=formula)])["rows"][0]
        self.assertIsNone(row["supplier_code"])
        self.assertIsNone(row["model"]["value"])
        self.assertIsNone(row["offer"]["source_price"]["value_decimal"])
        self.assertIsNone(row["original_cells"]["G"]["value"])
        self.assertIsNone(row["original_cells"]["G"]["raw"])
        self.assertNotIn("999999", json.dumps(row))
        self.assertEqual(row["original_cells"]["G"]["cached_value_sha256"], update.sha(b"999999"))
        gas = parse([{"A": "000123", "B": "Горелка", "D": ("number", "200"), "E": formula}],
                    sheet="Горелки и резаки газовые")["rows"][0]
        self.assertIsNone(gas["packaging"]["quantity"])

    def test_shared_formula_follower_without_expression_is_blocked(self):
        row = parse([product(G=("formula", None, "123.45", {"t": "shared", "si": "1"}))])["rows"][0]
        self.assertIsNone(row["offer"]["source_price"]["value_decimal"])
        self.assertIn("price_formula_requires_review", row["review_reasons"])

    def test_blank_styled_rows_are_not_products_hidden_rows_are_preserved(self):
        snapshot = parse([product(_hidden=True), {"A": None, "B": None, "G": None}])
        self.assertEqual(snapshot["summary"]["rows"], 1)
        self.assertIn("hidden_source_row_or_sheet", snapshot["rows"][0]["review_reasons"])

    def test_new_versions_and_row_reordering_keep_stable_keys(self):
        old = parse([product(), product(124, B="Аппарат 250")])
        new = parse([product(124, B="Аппарат 250"), product(price="110.50")], header_row=9)
        self.assertNotEqual(old["source"]["sha256"], new["source"]["sha256"])
        self.assertEqual(old["rows"][0]["stable_key"], new["rows"][1]["stable_key"])
        diff = update.compare_snapshots(old, new)
        self.assertEqual(diff["summary"], {"new": 0, "changed": 1, "missing": 0, "conflicts": 0, "unchanged": 1})
        self.assertEqual(diff["changed"][0]["fields"]["source_price"]["after"]["value_decimal"], "110.5")

    def test_new_missing_duplicate_and_identity_conflicts_never_apply(self):
        old = parse([product(1), product(2), product(3), product(4), product(4)])
        new = parse([product(1, B="Другая модель"), product(3), product(4), product(4), product(5)])
        diff = update.compare_snapshots(old, new)
        self.assertEqual(diff["summary"], {"new": 1, "changed": 0, "missing": 1, "conflicts": 2, "unchanged": 1})
        self.assertEqual(diff["missing"][0]["action"], "keep_current_catalog")
        self.assertFalse(diff["catalog_changed"])
        self.assertEqual(new["summary"]["duplicate_code_groups"], 1)
        self.assertEqual(len(new["code_groups"][2]["row_ids"]), 2)
        self.assertEqual(diff["policy"]["manual_edits"], "never_overwrite")

    def test_explicit_model_and_packaging_change_is_identity_conflict(self):
        old = parse([product(H="M1")])
        new = parse([product(H="M2")])
        self.assertEqual(update.compare_snapshots(old, new)["summary"]["conflicts"], 1)
        old = parse([{"A": "00123", "B": "Горелка", "D": ("number", "200"), "E": ("number", "10")}],
                    sheet="Горелки и резаки газовые")
        new = copy.deepcopy(old)
        new["rows"][0]["packaging"]["quantity"] = "20"
        new["rows"][0]["stable_key"] = "changed-key"
        self.assertEqual(update.compare_snapshots(old, new)["summary"]["conflicts"], 1)

    def test_changed_formula_is_visible_even_when_both_values_are_blocked(self):
        old = parse([product(G=("formula", "A1*2", "4"))])
        new = parse([product(G=("formula", "A1*3", "6"))])
        self.assertEqual(update.compare_snapshots(old, new)["summary"]["changed"], 1)

    def test_unknown_currency_and_changed_headers_fail_closed(self):
        row = parse([product()], change_header={"G": "РЕКОМЕНДОВАННАЯ РОЗНИЧНАЯ ЦЕНА"})["rows"][0]
        self.assertIsNone(row["offer"]["source_price"]["currency"])
        self.assertIn("price_currency_unconfirmed", row["review_reasons"])
        with self.assertRaisesRegex(update.IntakeError, "SHEET_HEADER_REQUIRES_REVIEW"):
            parse([product()], change_header={"G": "Новая цена по неизвестным условиям"})

    def test_xml_entities_and_macros_rejected(self):
        for parts, error in [
            ({"xl/vbaProject.bin": b"macro"}, "ACTIVE_XLSX_CONTENT"),
            ({"xl/sharedStrings.xml": b'<!DOCTYPE a [<!ENTITY x "oops">]><sst/>'}, "UNSAFE_XML"),
            ({"xl/sharedStrings.xml": '<!DOCTYPE a [<!ENTITY x "oops">]><sst/>'.encode("utf-16")}, "UNSAFE_XML"),
            ({"../escape.xml": b"<xml/>"}, "ZIP_PATH_INVALID"),
        ]:
            with self.subTest(error=error), self.assertRaisesRegex(update.IntakeError, error):
                parse([product()], extra_parts=parts)


class CsvExportTests(unittest.TestCase):
    def test_unique_original_titles_only_no_price_brand_or_stock(self):
        snapshot = parse([product(1), product(2), product(2), product(3, B="X" * 201)])
        before = copy.deepcopy(snapshot)
        export = update.export_review_csv(snapshot)
        draft = list(csv.DictReader(io.StringIO(export["draft_csv"].lstrip("\ufeff")), delimiter=";"))
        review = list(csv.DictReader(io.StringIO(export["review_csv"].lstrip("\ufeff")), delimiter=";"))
        self.assertEqual(len(draft), 1)
        self.assertEqual(draft[0]["sku"], "00000000001")
        self.assertEqual(draft[0]["title"], "Аппарат 200")
        for forbidden in ("price", "sale_price", "cost_price", "brand", "stock_qty", "in_stock"):
            self.assertNotIn(forbidden, draft[0])
        self.assertEqual(len(review), 3)
        self.assertEqual(review[-1]["title"], "X" * 201)
        self.assertEqual(export["manifest"]["mapped_fields"], ["sku", "title"])
        self.assertEqual(export["manifest"]["supplier_collision_check"], "not_performed")
        self.assertEqual(snapshot, before)

    def test_formula_text_goes_to_escaped_review_without_changing_source(self):
        title = "=HYPERLINK(\"https://example.invalid\",\"X\")"
        snapshot = parse([product(1, B=title)])
        export = update.export_review_csv(snapshot)
        self.assertEqual(export["manifest"]["draft_rows"], 0)
        row = list(csv.DictReader(io.StringIO(export["review_csv"].lstrip("\ufeff")), delimiter=";"))[0]
        self.assertEqual(row["title"], "'" + title)
        self.assertEqual(snapshot["rows"][0]["title"], title)

    def test_name_recovered_from_description_needs_explicit_review(self):
        snapshot = parse([{"A": "000001", "B": None, "C": "Описание горелки",
                           "D": ("number", "200"), "E": ("number", "10")}],
                         sheet="Горелки и резаки газовые")
        export = update.export_review_csv(snapshot)
        self.assertEqual(export["manifest"]["draft_rows"], 0)
        self.assertEqual(export["manifest"]["review_rows"], 1)


class IntakeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.state = self.root / "private"
        self.original = self.root / "price.xlsx"
        self.original.write_bytes(xlsx([product()]))

    def tearDown(self):
        self.temporary.cleanup()

    def test_content_dedup_new_version_and_old_replay_never_roll_back(self):
        first = update.intake(self.original, self.state)
        original_bytes = self.original.read_bytes()
        duplicate = update.intake(self.original, self.state)
        self.assertEqual(duplicate["status"], "duplicate")
        self.assertEqual(first["source_sha256"], duplicate["source_sha256"])
        self.original.write_bytes(xlsx([product(price="105")]))
        second = update.intake(self.original, self.state, first["source_sha256"])
        self.assertEqual(second["summary"]["changed"], 1)
        self.original.write_bytes(original_bytes)
        update.intake(self.original, self.state)
        self.assertEqual(update.read_current(self.state), second["source_sha256"])
        self.assertEqual(len(list((self.state / "snapshots").iterdir())), 2)
        self.assertEqual((Path(first["snapshot_directory"]) / "original.xlsx").read_bytes(), original_bytes)
        for path in Path(first["snapshot_directory"]).iterdir():
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_expected_base_conflict(self):
        update.intake(self.original, self.state)
        self.original.write_bytes(xlsx([product(price="106")]))
        with self.assertRaisesRegex(update.IntakeError, "PREVIOUS_VERSION_CONFLICT"):
            update.intake(self.original, self.state, "a" * 64)
        self.assertEqual(len(list((self.state / "snapshots").iterdir())), 1)

    def test_lock_prevents_concurrent_parse(self):
        update.private_directory(self.state)
        with (self.state / "intake.lock").open("wb") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(update.IntakeError, "INTAKE_BUSY"):
                update.intake(self.original, self.state)

    def test_failure_before_directory_commit_leaves_no_partial_snapshot(self):
        with patch.object(update, "write_private", side_effect=OSError("synthetic disk error")):
            with self.assertRaises(OSError):
                update.intake(self.original, self.state)
        self.assertIsNone(update.read_current(self.state))
        self.assertEqual(list((self.state / "snapshots").iterdir()), [])

    def test_interrupted_pointer_write_recovers_same_receipt(self):
        with patch.object(update, "set_current", side_effect=OSError("synthetic interruption")):
            with self.assertRaises(OSError):
                update.intake(self.original, self.state)
        self.assertIsNone(update.read_current(self.state))
        recovered = update.intake(self.original, self.state)
        self.assertEqual(recovered["status"], "duplicate")
        self.assertEqual(update.read_current(self.state), recovered["source_sha256"])

    def test_interrupted_commit_blocks_different_file_until_recovered(self):
        with patch.object(update, "set_current", side_effect=OSError("synthetic interruption")):
            with self.assertRaises(OSError):
                update.intake(self.original, self.state)
        self.original.write_bytes(xlsx([product(price="105")]))
        with self.assertRaisesRegex(update.IntakeError, "RECOVER_PREVIOUS_INTAKE_FIRST"):
            update.intake(self.original, self.state)
        self.assertEqual(len(list((self.state / "snapshots").iterdir())), 1)

    def test_tampered_snapshot_fails_instead_of_replaying_or_overwriting(self):
        receipt = update.intake(self.original, self.state)
        (Path(receipt["snapshot_directory"]) / "snapshot.json").write_text("{}")
        with self.assertRaisesRegex(update.IntakeError, "COMMITTED_STATE_CHECKSUM"):
            update.intake(self.original, self.state)

    def test_nested_private_directory_creates_private_missing_parents(self):
        nested = self.state / "price-updates"
        update.intake(self.original, nested)
        self.assertEqual(stat.S_IMODE(self.state.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(nested.stat().st_mode), 0o700)

    def test_public_state_and_symlink_rejected(self):
        self.state.mkdir(mode=0o755)
        with self.assertRaisesRegex(update.IntakeError, "STATE_NOT_PRIVATE"):
            update.intake(self.original, self.state)
        self.state.rmdir()
        self.state.symlink_to(self.root, target_is_directory=True)
        with self.assertRaisesRegex(update.IntakeError, "STATE_SYMLINK"):
            update.intake(self.original, self.state)

    def test_no_network_and_no_input_mutation(self):
        raw = self.original.read_bytes()
        with patch("socket.socket", side_effect=AssertionError("Network forbidden")):
            result = update.intake(self.original, self.state)
        self.assertFalse(result["catalog_changed"])
        self.assertTrue(result["requires_review"])
        self.assertEqual(self.original.read_bytes(), raw)
        summary = (Path(result["snapshot_directory"]) / "summary.md").read_text()
        self.assertIn("Пропавшие позиции остаются в каталоге", summary)


if __name__ == "__main__":
    unittest.main()
