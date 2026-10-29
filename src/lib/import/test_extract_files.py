import importlib.util
import tempfile
import unittest
from pathlib import Path

from openpyxl import Workbook
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

spec = importlib.util.spec_from_file_location("extract_files", Path(__file__).with_name("extract_files.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ExtractionTests(unittest.TestCase):
    def test_real_xlsx_sheets_values_and_formula_are_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "price.xlsx"
            workbook = Workbook()
            sheet = workbook.active
            sheet.title = "Прайс"
            sheet.append(["Артикул", "Цена"])
            sheet.append(["001-AB", 123.45])
            sheet.append(["002", "=1+2"])
            workbook.create_sheet("Другой")
            workbook.save(path)
            result = module.extract_xlsx(str(path))
            self.assertEqual(result["sheets"][0]["name"], "Прайс")
            self.assertEqual(result["sheets"][0]["rows"][1], ["001-AB", 123.45])
            self.assertEqual(result["sheets"][0]["rows"][2], ["002", "=1+2"])
            self.assertEqual(len(result["sheets"]), 2)

    def test_blank_pdf_requires_ocr(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "scan.pdf"
            writer = PdfWriter()
            writer.add_blank_page(width=200, height=200)
            writer.write(str(path))
            result = module.extract_pdf(str(path))
            self.assertEqual(result["pages"][0]["page"], 1)
            self.assertTrue(result["pages"][0]["needs_ocr"])

    def test_text_pdf_keeps_page_text_for_review(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "price.pdf"
            writer = PdfWriter()
            page = writer.add_blank_page(width=300, height=300)
            font = DictionaryObject({
                NameObject("/Type"): NameObject("/Font"),
                NameObject("/Subtype"): NameObject("/Type1"),
                NameObject("/BaseFont"): NameObject("/Helvetica"),
            })
            page[NameObject("/Resources")] = DictionaryObject({
                NameObject("/Font"): DictionaryObject({NameObject("/F1"): font})
            })
            stream = DecodedStreamObject()
            stream.set_data(b"BT /F1 12 Tf 10 200 Td (SKU ABC Price 100) Tj ET")
            page[NameObject("/Contents")] = writer._add_object(stream)
            writer.write(str(path))
            result = module.extract_pdf(str(path))
            self.assertIn("SKU ABC Price 100", result["pages"][0]["text"])
            self.assertFalse(result["pages"][0]["needs_ocr"])
            self.assertTrue(result["pages"][0]["manual_review_required"])

    def test_invalid_or_oversized_file_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bad.xlsx"
            path.write_bytes(b"not an xlsx")
            with self.assertRaises(module.ExtractionError):
                module.extract_xlsx(str(path))
            path.write_bytes(b"a" * (module.MAX_FILE_BYTES + 1))
            with self.assertRaises(module.ExtractionError):
                module.extract_xlsx(str(path))


if __name__ == "__main__":
    unittest.main()
