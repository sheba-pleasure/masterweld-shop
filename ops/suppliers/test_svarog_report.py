import base64
import hashlib
import json
import re
import unittest

from svarog_price_updates import SCHEMA, DIFF_SCHEMA, IntakeError
from svarog_report import render, report_data

def fixture():
    row = {"row_id": "a", "supplier_code": "0000123", "title": "</script><img src=https://example.invalid onerror=alert(1)>",
           "manufacturer_article": None, "category": "equipment", "section": None,
           "packaging": {"material_amount": "5", "material_unit": "кг"}, "review_reasons": ["price_formula_requires_review"],
           "offer": {"source_price": {"value_decimal": None, "formula_sha256": "a"*64}},
           "source": {"sheet": "Аппараты", "row": 42, "hidden": True}}
    snapshot = {"schema": SCHEMA, "source": {"sha256": "a"*64, "filename": "Прайс.xlsx"},
                "summary": {"rows": 1, "unique_codes": 1, "duplicate_code_groups": 0}, "rows": [row]}
    diff = {"schema": DIFF_SCHEMA, "source_sha256": "a"*64, "previous_sha256": None,
            "new": [{"row_id": "a"}], "missing": [], "unchanged": [], "changed": [], "conflicts": []}
    return snapshot, diff

class ReportTests(unittest.TestCase):
    def test_untrusted_supplier_text_cannot_break_out_of_json_or_execute(self):
        html = render(*fixture())
        block = re.search(r'<script type="application/json" id="data">(.*?)</script>', html).group(1)
        self.assertNotIn("<", block)
        self.assertEqual(json.loads(block)["rows"][0]["title"], fixture()[0]["rows"][0]["title"])
        self.assertNotIn("<img src=https://", html)
        self.assertIn("connect-src 'none'", html)
        script = re.search(r"<script>([\s\S]*?)</script>", html).group(1)
        digest = base64.b64encode(hashlib.sha256(script.encode()).digest()).decode()
        self.assertIn("'sha256-" + digest + "'", html)

    def test_formula_not_money_and_locator_and_package_remain_visible(self):
        data = report_data(*fixture())
        row = data["rows"][0]
        self.assertEqual(row["priceLabel"], "Сумма требует уточнения")
        self.assertTrue(row["formula"])
        self.assertEqual(row["code"], "0000123")
        self.assertIn("строка 42", row["locator"])
        self.assertIn("5 кг", row["packaging"])
        self.assertEqual(row["changeLabel"], "Исходный прайс")

    def test_diff_cannot_be_attached_to_another_source(self):
        snapshot, diff = fixture()
        diff["source_sha256"] = "b"*64
        with self.assertRaises(IntakeError):
            render(snapshot, diff)

    def test_missing_kept_as_review_even_without_previous_details(self):
        snapshot, diff = fixture()
        diff["previous_sha256"] = "b"*64
        diff["missing"] = [{"row_id": "old", "supplier_code": "0000456", "title": "Прежний аппарат",
                            "source": {"sheet": "Прежний лист", "row": 17}}]
        row = report_data(snapshot, diff)["rows"][1]
        self.assertEqual(row["change"], "missing")
        self.assertEqual(row["code"], "0000456")

if __name__ == "__main__":
    unittest.main()
