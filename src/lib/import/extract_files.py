"""Ограниченное извлечение таблиц XLSX и текста PDF без записи в магазин.

Вывод JSON предназначен для последующей ручной разметки колонок.
Формулы не вычисляются. PDF без текста требует OCR.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import zipfile

MAX_FILE_BYTES = 5 * 1024 * 1024
MAX_EXPANDED_BYTES = 40 * 1024 * 1024
MAX_ROWS = 10_000
MAX_COLS = 50
MAX_PAGES = 100
MAX_TEXT_CHARS = 1_000_000
MAX_CELL_CHARS = 10_000


class ExtractionError(Exception):
    pass


def validate_size(path: str) -> None:
    size = os.path.getsize(path)
    if size <= 0 or size > MAX_FILE_BYTES:
        raise ExtractionError("FILE_SIZE")


def extract_xlsx(path: str) -> dict:
    from openpyxl import load_workbook

    validate_size(path)
    try:
        with zipfile.ZipFile(path) as archive:
            infos = archive.infolist()
            if len(infos) > 2000 or sum(i.file_size for i in infos) > MAX_EXPANDED_BYTES:
                raise ExtractionError("EXPANDED_FILE_TOO_LARGE")
            if any(i.flag_bits & 1 for i in infos):
                raise ExtractionError("ENCRYPTED_FILE")
    except zipfile.BadZipFile as exc:
        raise ExtractionError("INVALID_XLSX") from exc

    try:
        workbook = load_workbook(path, read_only=True, data_only=False, keep_links=False)
        sheets = []
        if len(workbook.worksheets) > 30:
            raise ExtractionError("TOO_MANY_SHEETS")
        for sheet in workbook.worksheets:
            if sheet.max_row and sheet.max_row > MAX_ROWS:
                raise ExtractionError("TOO_MANY_ROWS")
            if sheet.max_column and sheet.max_column > MAX_COLS:
                raise ExtractionError("TOO_MANY_COLUMNS")
            rows = []
            for row in sheet.iter_rows(max_row=MAX_ROWS + 1, max_col=MAX_COLS + 1):
                if len(rows) >= MAX_ROWS:
                    raise ExtractionError("TOO_MANY_ROWS")
                if len(row) > MAX_COLS and row[MAX_COLS].value is not None:
                    raise ExtractionError("TOO_MANY_COLUMNS")
                cells = []
                for cell in row[:MAX_COLS]:
                    value = cell.value
                    if value is None or isinstance(value, (str, int, float, bool)):
                        if isinstance(value, str) and len(value) > MAX_CELL_CHARS:
                            raise ExtractionError("CELL_TOO_LONG")
                        cells.append(value)
                    else:
                        # Dates and special cell values need manual review.
                        cells.append(None)
                while cells and cells[-1] is None:
                    cells.pop()
                rows.append(cells)
            while rows and not rows[-1]:
                rows.pop()
            sheets.append({"name": sheet.title, "rows": rows})
        return {"format": "xlsx", "sheets": sheets}
    except ExtractionError:
        raise
    except Exception as exc:
        raise ExtractionError("INVALID_XLSX") from exc
    finally:
        if "workbook" in locals():
            workbook.close()


def extract_pdf(path: str) -> dict:
    from pypdf import PdfReader

    validate_size(path)
    try:
        reader = PdfReader(path, strict=True)
        if reader.is_encrypted:
            raise ExtractionError("ENCRYPTED_FILE")
        if len(reader.pages) > MAX_PAGES:
            raise ExtractionError("TOO_MANY_PAGES")
        pages = []
        total = 0
        for index, page in enumerate(reader.pages, 1):
            # Ограничиваем распакованные потоки до извлечения текста.
            content = page.get_contents()
            streams = [] if content is None else (content if isinstance(content, list) else [content])
            for stream in streams:
                data = stream.get_data()
                if len(data) > MAX_EXPANDED_BYTES:
                    raise ExtractionError("EXPANDED_FILE_TOO_LARGE")
            text = page.extract_text() or ""
            total += len(text)
            if total > MAX_TEXT_CHARS:
                raise ExtractionError("TEXT_TOO_LARGE")
            # Даже страница с текстом может содержать таблицу-картинку.
            pages.append({"page": index, "text": text, "needs_ocr": not text.strip(),
                          "manual_review_required": True})
        return {"format": "pdf", "pages": pages}
    except ExtractionError:
        raise
    except Exception as exc:
        raise ExtractionError("INVALID_PDF") from exc


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("format", choices=["xlsx", "pdf"])
    parser.add_argument("path")
    args = parser.parse_args()
    try:
        result = extract_xlsx(args.path) if args.format == "xlsx" else extract_pdf(args.path)
        json.dump({"ok": True, "data": result}, sys.stdout, ensure_ascii=False, allow_nan=False)
        print()
        return 0
    except (ExtractionError, OSError, ValueError):
        print(json.dumps({"ok": False, "error": "EXTRACTION_FAILED"}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
