#!/usr/bin/env python3
"""Offline document-v1 extraction. Originals are read-only; no catalog writes or network."""
import csv
import hashlib
import io
import json
import math
import struct
import pathlib
import re
import resource
import subprocess
import sys
import tempfile
import zipfile
from xml.etree import ElementTree as ET

VERSION = "document-v1"
MAX_BYTES = 5 * 1024 * 1024
MAX_TEXT = 1000000
MAX_ROWS = 5000
MAX_PAGES = 40


class ReviewRequired(Exception):
    pass


def command(args, timeout=45):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=timeout, check=True)
    if len(result.stdout) > MAX_TEXT * 4:
        raise ReviewRequired("OUTPUT_LIMIT")
    return result.stdout.decode("utf-8", errors="strict")


def xml(data):
    if len(data) > 20 * 1024 * 1024 or re.search(br"<!\s*(DOCTYPE|ENTITY)", data, re.I):
        raise ReviewRequired("UNSAFE_XML")
    return ET.fromstring(data)


def archive(path):
    z = zipfile.ZipFile(path)
    infos = z.infolist()
    if len(infos) > 2000 or sum(i.file_size for i in infos) > 40 * 1024 * 1024:
        z.close()
        raise ReviewRequired("ARCHIVE_LIMIT")
    if len({i.filename for i in infos}) != len(infos) or any(i.flag_bits & 1 for i in infos):
        z.close()
        raise ReviewRequired("ARCHIVE_INVALID")
    if any("vbaProject" in i.filename for i in infos):
        z.close()
        raise ReviewRequired("MACROS_REQUIRE_REVIEW")
    return z


def local(tag):
    return tag.rsplit("}", 1)[-1]


def child_text(element, name="t"):
    return "".join(x.text or "" for x in element.iter() if local(x.tag) == name)


def cells_text(element):
    return "".join(element.itertext())


def string_cell(value):
    value = str(value if value is not None else "")
    if len(value) > 2000 or "\x00" in value:
        raise ReviewRequired("CELL_LIMIT")
    return value


def make_table(rows, label, locators, warnings=None):
    # Blank lines retained internally. Leading headings are not silently guessed away.
    while rows and not any(str(v).strip() for v in rows[-1]):
        rows.pop()
        locators.pop()
    if len(rows) < 2:
        return None
    width = max(map(len, rows))
    if not 2 <= width <= 30 or len(rows) > MAX_ROWS + 1:
        raise ReviewRequired("TABLE_LIMIT")
    rows = [[string_cell(v) for v in r] + [""] * (width-len(r)) for r in rows]
    if any(len(v)>100 for v in rows[0]):
        raise ReviewRequired("HEADER_REVIEW")
    return {"label": label, "header": rows[0], "rows": rows[1:],
            "header_locator": locators[0], "row_locators": locators[1:],
            "warnings": warnings or [], "review_required": True}


def xlsx(path):
    tables, blocks = [], []
    with archive(path) as z:
        main = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
        relns = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
        ns = {"s": main}
        strings = []
        if "xl/sharedStrings.xml" in z.namelist():
            strings = [child_text(si) for si in xml(z.read("xl/sharedStrings.xml"))]
        rels = {r.attrib["Id"]: r.attrib["Target"] for r in xml(z.read("xl/_rels/workbook.xml.rels"))}
        sheets = xml(z.read("xl/workbook.xml")).findall("s:sheets/s:sheet", ns)
        if len(sheets)>30:
            raise ReviewRequired("SHEET_LIMIT")
        for index, sheet in enumerate(sheets,1):
            target = rels.get(sheet.attrib.get("{"+relns+"}id"), "")
            if ".." in pathlib.PurePosixPath(target).parts:
                raise ReviewRequired("WORKBOOK_LINK")
            entry = target.lstrip("/") if target.startswith("/") else "xl/"+target
            node = xml(z.read(entry))
            rows, locators, warnings = [], [], []
            if sheet.attrib.get("state","visible")!="visible":
                warnings.append("HIDDEN_SHEET")
            if node.find("s:mergeCells",ns) is not None:
                warnings.append("MERGED_CELLS")
            for row in node.findall("s:sheetData/s:row",ns):
                values = {}
                row_id = row.attrib.get("r","")
                if row.attrib.get("hidden")=="1":
                    warnings.append("HIDDEN_ROWS")
                for cell in row.findall("s:c",ns):
                    ref=cell.attrib.get("r","")
                    match=re.fullmatch(r"([A-Z]{1,3})([0-9]+)",ref)
                    if not match:
                        raise ReviewRequired("CELL_REFERENCE")
                    col=0
                    for char in match.group(1):
                        col=col*26+ord(char)-64
                    if col>30:
                        raise ReviewRequired("COLUMN_LIMIT")
                    kind=cell.attrib.get("t","n")
                    formula=cell.find("s:f",ns)
                    if formula is not None:
                        value="="+(formula.text or "")
                        warnings.append("FORMULA_NOT_EVALUATED")
                    elif kind=="inlineStr":
                        value=child_text(cell)
                    else:
                        value=cell.findtext("s:v","",ns)
                        if kind=="s":
                            value=strings[int(value)]
                        elif kind in ("n","b","d","e"):
                            # Preserve raw numbers; formatted SKU/date requires a person's decision.
                            if cell.attrib.get("s"):
                                warnings.append("FORMATTED_CELL_REVIEW")
                    values[col-1]=value
                if values:
                    rows.append([values.get(i,"") for i in range(max(values)+1)])
                    locators.append(f"sheet:{index}/row:{row_id}")
                if len(rows)>MAX_ROWS+1:
                    raise ReviewRequired("ROW_LIMIT")
            table=make_table(rows,sheet.attrib.get("name",f"Лист {index}"),locators,sorted(set(warnings)))
            if table:
                tables.append(table)
            else:
                blocks.append({"locator":f"sheet:{index}","text":"\n".join("\t".join(r) for r in rows),"review_required":True})
    return tables,blocks


def xls(path):
    # xlrd normally returns formula caches as ordinary values. Intercept BIFF records
    # on this book instance before any sheet is loaded, and replace every formula cell.
    # This relies on the pinned reader's record API; never silently upgrade it.
    import xlrd
    from xlrd.biffh import XL_FORMULA_OPCODES
    if xlrd.__version__ != "2.0.2":
        raise ReviewRequired("XLS_READER_VERSION")
    book = None
    try:
        book = xlrd.open_workbook(filename=str(path), use_mmap=False, logfile=io.StringIO(),
                                  formatting_info=True, on_demand=True, ragged_rows=True,
                                  ignore_workbook_corruption=False)
        if book.biff_version not in (50, 70, 80) or not book.on_demand:
            raise ReviewRequired("XLS_VERSION_REVIEW")
        if book.nsheets > 30:
            raise ReviewRequired("SHEET_LIMIT")
        tables, blocks = [], []
        original_reader = book.get_record_parts
        formula_cells = {}
        def read_record():
            code, length, data = original_reader()
            if len(data) != length:
                raise ReviewRequired("XLS_DAMAGED")
            if code in XL_FORMULA_OPCODES:
                if length < 22:
                    raise ReviewRequired("XLS_DAMAGED")
                row, col = struct.unpack_from("<HH", data)
                if row > MAX_ROWS or col >= 30:
                    raise ReviewRequired("TABLE_LIMIT")
                formula_cells[(row, col)] = hashlib.sha256(data).hexdigest()
            return code, length, data
        book.get_record_parts = read_record
        for index in range(book.nsheets):
            formula_cells.clear()
            sheet = book.sheet_by_index(index)
            if sheet.nrows > MAX_ROWS + 1 or sheet.ncols > 30:
                raise ReviewRequired("TABLE_LIMIT")
            warnings = ["XLS_NONCELL_CONTENT_REVIEW"]
            if sheet.visibility:
                warnings.append("HIDDEN_SHEET")
            if sheet.merged_cells:
                warnings.append("MERGED_CELLS")
            if any(info.hidden for info in sheet.rowinfo_map.values()):
                warnings.append("HIDDEN_ROWS")
            if any(info.hidden for info in sheet.colinfo_map.values()):
                warnings.append("HIDDEN_COLUMNS")
            if formula_cells:
                warnings.append("XLS_FORMULA_VALUE_REQUIRED")
            rows, locators = [], []
            for row_index in range(sheet.nrows):
                values = []
                for col_index in range(sheet.ncols):
                    if (row_index, col_index) in formula_cells:
                        # Deliberate marker, not the original formula text or its cached result.
                        value = "=Формула XLS: введите проверенное значение"
                    elif col_index >= sheet.row_len(row_index):
                        value = ""
                    else:
                        cell = sheet.cell(row_index, col_index)
                        if cell.ctype in (xlrd.XL_CELL_EMPTY, xlrd.XL_CELL_BLANK):
                            value = ""
                        elif cell.ctype == xlrd.XL_CELL_TEXT:
                            value = cell.value
                        elif cell.ctype == xlrd.XL_CELL_NUMBER:
                            if not math.isfinite(cell.value):
                                raise ReviewRequired("XLS_DAMAGED")
                            value = str(int(cell.value)) if cell.value.is_integer() else str(cell.value)
                            style = book.xf_list[cell.xf_index]
                            if style.format_key != 0:
                                warnings.append("FORMATTED_CELL_REVIEW")
                        elif cell.ctype == xlrd.XL_CELL_BOOLEAN:
                            value = "1" if cell.value else "0"
                        elif cell.ctype == xlrd.XL_CELL_DATE:
                            value = "Дата Excel: " + str(cell.value)
                            warnings.append("XLS_DATE_REVIEW")
                        elif cell.ctype == xlrd.XL_CELL_ERROR:
                            value = "Ошибка Excel: " + xlrd.error_text_from_code.get(cell.value, "неизвестная")
                            warnings.append("XLS_CELL_ERROR_REVIEW")
                        else:
                            raise ReviewRequired("XLS_CELL_REVIEW")
                    values.append(string_cell(value))
                rows.append(values)
                locators.append(f"sheet:{index+1}/row:{row_index+1}")
            table = make_table(rows, sheet.name, locators, sorted(set(warnings)))
            if table:
                table["formula_cells"] = [
                    {"locator": f"sheet:{index+1}/row:{row+1}/column:{col+1}", "record_sha256": digest}
                    for (row, col), digest in sorted(formula_cells.items())
                ]
                tables.append(table)
            else:
                blocks.append({"locator": f"sheet:{index+1}", "text": "\n".join("\t".join(r) for r in rows),
                               "review_required": True})
            book.unload_sheet(index)
        return tables, blocks
    except xlrd.XLRDError as exc:
        if "encrypt" in str(exc).lower() or "password" in str(exc).lower():
            raise ReviewRequired("XLS_PASSWORD_REQUIRED") from None
        raise ReviewRequired("XLS_DAMAGED") from None
    except (struct.error, AssertionError, UnicodeError):
        raise ReviewRequired("XLS_DAMAGED") from None
    finally:
        if book is not None:
            book.release_resources()


def direct_child(element, name):
    return next((child for child in element if local(child.tag) == name), None)


def word_count(properties, name, default, minimum=0):
    element = None if properties is None else direct_child(properties, name)
    if element is None:
        return default
    value = next((v for k,v in element.attrib.items() if local(k) == "val"), "")
    if not re.fullmatch(r"[0-9]{1,3}", value) or not minimum <= int(value) <= 30:
        raise ReviewRequired("DOCX_GRID_REVIEW")
    return int(value)


def word_paragraph(paragraph):
    # Preserve actual text, tabs and explicit breaks, not formatting tabs or drawing labels.
    parts = []
    def visit(element):
        name = local(element.tag)
        if name in ("pPr", "rPr", "drawing", "pict", "object"):
            return
        if name == "t":
            parts.append(element.text or "")
        elif name == "tab":
            parts.append("\t")
        elif name in ("br", "cr"):
            parts.append("\n")
        else:
            for child in element:
                visit(child)
    visit(paragraph)
    return "".join(parts)


def word_cell(cell):
    if any(local(x.tag) == "tbl" for x in cell.iter()):
        raise ReviewRequired("NESTED_TABLE_REVIEW")
    return "\n".join(word_paragraph(p) for p in cell.iter() if local(p.tag) == "p")


def word_rows(table, index):
    grid = direct_child(table, "tblGrid")
    grid_width = 0 if grid is None else sum(local(x.tag) == "gridCol" for x in grid)
    if grid_width > 30:
        raise ReviewRequired("COLUMN_LIMIT")
    rows, locators = [], []
    for ri,row in enumerate((x for x in table if local(x.tag) == "tr"),1):
        properties = direct_child(row, "trPr")
        before = word_count(properties, "gridBefore", 0)
        after = word_count(properties, "gridAfter", 0)
        if grid_width and (before >= grid_width or after >= grid_width):
            raise ReviewRequired("DOCX_GRID_REVIEW")
        values = [""] * before
        for cell in (x for x in row if local(x.tag) == "tc"):
            span = word_count(direct_child(cell, "tcPr"), "gridSpan", 1, 1)
            if len(values) + span + after > 30:
                raise ReviewRequired("COLUMN_LIMIT")
            # A spanning cell supplies its value once. Covered columns remain unknown.
            values.extend([word_cell(cell)] + [""] * (span - 1))
        values.extend([""] * after)
        if grid_width > len(values):
            values.extend([""] * (grid_width - len(values)))
        rows.append(values)
        locators.append(f"table:{index}/row:{ri}")
        if len(rows) > MAX_ROWS + 1:
            raise ReviewRequired("ROW_LIMIT")
    return rows, locators


def office_xml(path,kind):
    tables,blocks=[],[]
    with archive(path) as z:
        node=xml(z.read("word/document.xml" if kind=="docx" else "content.xml"))
        if kind=="docx":
            for i,p in enumerate([x for x in node.iter() if local(x.tag)=="p"],1):
                text=word_paragraph(p)
                if text.strip():
                    blocks.append({"locator":f"paragraph:{i}","text":text,"review_required":True})
            candidates=[x for x in node.iter() if local(x.tag)=="tbl"]
        else:
            candidates=[x for x in node.iter() if local(x.tag)=="table"]
        for index,table in enumerate(candidates,1):
            rows,locators=[],[]
            if kind=="docx":
                rows,locators=word_rows(table,index)
                result=make_table(rows,f"Таблица {index}",locators,["MERGED_CELLS_REVIEW"])
                if result:
                    tables.append(result)
                continue
            row_tag,cell_tag="table-row","table-cell"
            for ri,row in enumerate([x for x in table if local(x.tag)==row_tag],1):
                vals=[]
                if any(local(k)=="number-rows-repeated" and int(v)>1 for k,v in row.attrib.items()):
                    raise ReviewRequired("REPEATED_ROWS_REVIEW")
                for cell in [x for x in row if local(x.tag) in (cell_tag,"covered-table-cell")]:
                    if any(local(k)=="number-columns-repeated" and int(v)>30 for k,v in cell.attrib.items()):
                        raise ReviewRequired("COLUMN_LIMIT")
                    repeat=next((int(v) for k,v in cell.attrib.items() if local(k)=="number-columns-repeated"),1)
                    formula=next((v for k,v in cell.attrib.items() if local(k)=="formula"),None)
                    value=("="+formula) if formula else cells_text(cell)
                    vals.extend([value]*repeat)
                rows.append(vals);locators.append(f"table:{index}/row:{ri}")
            result=make_table(rows,f"Таблица {index}",locators,["MERGED_CELLS_REVIEW"])
            if result:
                tables.append(result)
    return tables,blocks


def text_tables(text,locator):
    """A text candidate is never a confirmed model, price or SKU."""
    # Keep physical positions in the saved text block before filtering empty lines.
    numbered=[(i,line) for i,line in enumerate(text.splitlines(),1) if line.strip()]
    lines=[line for _,line in numbered]
    locators=[f"{locator}/line:{i}" for i,_ in numbered]
    if not lines:
        return []
    split=[re.split(r"\t| {2,}",line.strip()) for line in lines]
    width=len(split[0])
    if 2<=width<=30 and len(split)>1 and all(len(r)==width for r in split):
        table=make_table(split,locator,locators,["TEXT_LAYOUT_REVIEW"])
    else:
        # Retain each nonempty line as a candidate, with identifiers/prices deliberately empty.
        table=make_table([["sku","title","price"]]+[["",line,""] for line in lines],
            locator,["derived:unconfirmed-header"]+locators,
            ["UNSTRUCTURED_TEXT","SKU_AND_PRICE_REQUIRE_REVIEW","LINES_MAY_NOT_BE_PRODUCTS"])
    return [table] if table else []


def image_ocr(path):
    from PIL import Image
    Image.MAX_IMAGE_PIXELS=25000000
    with Image.open(path) as im:
        if im.width*im.height>25000000:
            raise ReviewRequired("IMAGE_LIMIT")
        if getattr(im,"n_frames",1)>1:
            raise ReviewRequired("MULTIFRAME_REVIEW")
        im.verify()
    return command(["tesseract",str(path),"stdout","-l","rus+eng","--psm","6"],90)


def extract(path,filename):
    path=pathlib.Path(path)
    original=path.read_bytes()
    if not 0<len(original)<=MAX_BYTES:
        raise ReviewRequired("FILE_SIZE")
    result={"version":VERSION,"text_locator_version":2,"sha256":hashlib.sha256(original).hexdigest(),"bytes":len(original),
            "tables":[],"blocks":[],"warnings":[],"coverage":{},"review_required":True,
            "enrichment":{"state":"provider_not_configured","automatic_publication":False,
              "steps":["identify_exact_model","find_primary_sources","review_minimum_specs",
                       "find_image_and_usage_rights","review_generated_image","review_description"]}}
    suffix=pathlib.Path(filename).suffix.lower()
    try:
        if suffix in (".csv",".tsv"):
            text=original.decode("utf-8-sig")
            dialect=csv.Sniffer().sniff(text[:65536],delimiters=",;\t")
            rows=list(csv.reader(io.StringIO(text),dialect))
            table=make_table(rows,filename,[f"record:{i}" for i in range(1,len(rows)+1)],["COLUMN_MAPPING_REVIEW"])
            if table: result["tables"]=[table]
        elif suffix==".xlsx":
            result["tables"],result["blocks"]=xlsx(path)
        elif suffix==".xls":
            result["tables"],result["blocks"]=xls(path)
            result["xls_table_version"]=1
        elif suffix in (".docx",".ods"):
            result["tables"],result["blocks"]=office_xml(path,suffix[1:])
            if suffix==".docx":
                result["docx_table_version"]=2
        elif suffix in (".txt",".md"):
            text=original.decode("utf-8-sig")
            result["blocks"]=[{"locator":"document:1","text":text,"review_required":True}]
            result["tables"]=text_tables(text,"document:1")
        elif suffix==".pdf":
            info=command(["pdfinfo",str(path)])
            match=re.search(r"^Pages:\s+(\d+)",info,re.M)
            if not match or not 0<int(match.group(1))<=MAX_PAGES:
                raise ReviewRequired("PAGE_LIMIT")
            count=int(match.group(1));result["coverage"]={"pages":count,"processed":0}
            with tempfile.TemporaryDirectory() as tmp:
                for page in range(1,count+1):
                    text=command(["pdftotext","-f",str(page),"-l",str(page),"-layout",str(path),"-"])
                    engine="pdftotext"
                    if len(re.sub(r"\s","",text))<20:
                        output=str(pathlib.Path(tmp)/"page")
                        command(["pdftoppm","-f",str(page),"-l",str(page),"-scale-to","2400","-singlefile","-png",str(path),output])
                        text=image_ocr(output+".png");engine="tesseract-rus-eng"
                    result["blocks"].append({"locator":f"page:{page}","page":page,"text":text,"engine":engine,"review_required":True})
                    result["tables"].extend(text_tables(text,f"page:{page}"))
                    result["coverage"]["processed"]+=1
            result["warnings"].append("MIXED_PDF_IMAGES_REQUIRE_VISUAL_REVIEW")
        elif suffix in (".png",".jpg",".jpeg",".webp",".tif",".tiff"):
            text=image_ocr(path)
            result["blocks"]=[{"locator":"image:1","text":text,"engine":"tesseract-rus-eng","review_required":True}]
            result["tables"]=text_tables(text,"image:1")
        else:
            raise ReviewRequired("FORMAT_REQUIRES_MANUAL_CONVERSION")
        if len(result["tables"])>100 or len(json.dumps(result,ensure_ascii=False))>MAX_TEXT:
            raise ReviewRequired("EXTRACTION_LIMIT")
        result["coverage"]["complete"]=True
    except (ReviewRequired,ValueError,KeyError,IndexError,ET.ParseError,zipfile.BadZipFile,
            subprocess.SubprocessError,OSError) as exc:
        result["warnings"].append(str(exc) if isinstance(exc,ReviewRequired) else "EXTRACTION_REQUIRES_REVIEW")
        result["coverage"]["complete"]=False
    return result


if __name__=="__main__":
    resource.setrlimit(resource.RLIMIT_AS,(1024*1024*1024,1024*1024*1024))
    resource.setrlimit(resource.RLIMIT_CPU,(150,150))
    resource.setrlimit(resource.RLIMIT_FSIZE,(12*1024*1024,12*1024*1024))
    try:
        output=extract(sys.argv[1],sys.argv[2])
        print(json.dumps(output,ensure_ascii=False,allow_nan=False))
    except Exception:
        print('{"error":"EXTRACTION_FAILED"}')
        sys.exit(1)
