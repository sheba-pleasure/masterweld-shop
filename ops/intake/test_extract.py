import hashlib
import importlib.util
import json
import io
import struct
import pathlib
import xlwt
import xlrd
import tempfile
import unittest
import zipfile
from PIL import Image,ImageDraw,ImageFont

spec=importlib.util.spec_from_file_location("extract",pathlib.Path(__file__).with_name("extract.py"))
engine=importlib.util.module_from_spec(spec);spec.loader.exec_module(engine)

class ExtractionTests(unittest.TestCase):
    def setUp(self):
        self.directory=tempfile.TemporaryDirectory()
        self.root=pathlib.Path(self.directory.name)
    def tearDown(self):
        self.directory.cleanup()
    def file(self,name,data):
        p=self.root/name;p.write_bytes(data);return p
    def test_csv_original_and_formula(self):
        data=b'sku;title;price\n001-A;Training;=1+2\n'
        p=self.file("input.csv",data);r=engine.extract(p,p.name)
        self.assertEqual(p.read_bytes(),data)
        self.assertEqual(r["sha256"],hashlib.sha256(data).hexdigest())
        self.assertEqual(r["tables"][0]["rows"][0],["001-A","Training","=1+2"])
        self.assertEqual(r["tables"][0]["row_locators"],["record:2"])
        self.assertTrue(r["review_required"])
    def test_unknown_format_never_claims_success(self):
        p=self.file("input.xlsb",b"unsupported format")
        r=engine.extract(p,p.name)
        self.assertFalse(r["coverage"]["complete"])
        self.assertIn("FORMAT_REQUIRES_MANUAL_CONVERSION",r["warnings"])
        self.assertFalse(r["tables"])
    def binary_workbook(self):
        book=xlwt.Workbook(encoding="utf-8")
        sheet=book.add_sheet("Прайс")
        for col,value in enumerate(["sku","title","price"]):sheet.write(0,col,value)
        sheet.write(1,0,"0007");sheet.write(1,1,"Учебный аппарат");sheet.write(1,2,123.45)
        sheet.write(3,0,"B");sheet.write(3,1,"Проверить формулу");sheet.write(3,2,xlwt.Formula("1+2"))
        sheet.write(4,0,7,xlwt.easyxf(num_format_str="00000"))
        sheet.write(4,1,"Числовой артикул");sheet.write(4,2,10)
        sheet.row(3).hidden=True;sheet.col(2).hidden=True
        sheet.write_merge(5,5,0,1,"Объединённая ячейка");sheet.write(5,2,20)
        hidden=book.add_sheet("Скрытый");hidden.visibility=1
        for row,values in enumerate([["sku","price"],["HIDDEN",30]]):
            for col,value in enumerate(values):hidden.write(row,col,value)
        return book

    def test_xls_original_coordinates_hidden_and_merged_cells(self):
        book=self.binary_workbook();buffer=io.BytesIO();book.save(buffer)
        original=buffer.getvalue();p=self.file("Прайс.XLS",original)
        result=engine.extract(p,p.name)
        self.assertTrue(result["coverage"]["complete"])
        self.assertEqual(result["xls_table_version"],1)
        self.assertEqual(result["sha256"],hashlib.sha256(original).hexdigest())
        self.assertEqual(p.read_bytes(),original)
        first,hidden=result["tables"]
        self.assertEqual(first["rows"][0],["0007","Учебный аппарат","123.45"])
        self.assertEqual(first["rows"][1],["","",""])
        self.assertEqual(first["row_locators"][2],"sheet:1/row:4")
        self.assertEqual(first["rows"][2][2],"=Формула XLS: введите проверенное значение")
        self.assertEqual(first["rows"][3][0],"7")
        self.assertEqual(first["rows"][4],["Объединённая ячейка","","20"])
        self.assertTrue({"HIDDEN_ROWS","HIDDEN_COLUMNS","MERGED_CELLS","FORMATTED_CELL_REVIEW",
                         "XLS_FORMULA_VALUE_REQUIRED","XLS_NONCELL_CONTENT_REVIEW"}.issubset(first["warnings"]))
        self.assertIn("HIDDEN_SHEET",hidden["warnings"])
        self.assertEqual(first["formula_cells"][0]["locator"],"sheet:1/row:4/column:3")
        self.assertEqual(len(first["formula_cells"][0]["record_sha256"]),64)
        self.assertTrue(first["review_required"])
        self.assertFalse(result["enrichment"]["automatic_publication"])

    def test_xls_cached_formula_result_cannot_become_a_price(self):
        # Produce a valid raw BIFF workbook with a plausible but stale formula cache.
        raw=bytearray(self.binary_workbook().get_biff_data())
        offset=0;changed=0
        while offset+4<=len(raw):
            code,length=struct.unpack_from("<HH",raw,offset)
            if code==0x0006:
                raw[offset+4+6:offset+4+14]=struct.pack("<d",9999.5)
                changed+=1
            offset+=4+length
        self.assertEqual(changed,1)
        p=self.file("cache.xls",bytes(raw))
        native=xlrd.open_workbook(str(p))
        self.assertEqual(native.sheet_by_index(0).cell_value(3,2),9999.5)
        native.release_resources()
        result=engine.extract(p,p.name)
        self.assertTrue(result["coverage"]["complete"])
        self.assertTrue(result["tables"][0]["rows"][2][2].startswith("=Формула XLS"))
        self.assertNotIn("9999.5",json.dumps(result,ensure_ascii=False))

    def test_xls_dates_and_errors_are_not_plain_numbers(self):
        book=xlwt.Workbook();sheet=book.add_sheet("Даты")
        for col,value in enumerate(["sku","date","error"]):sheet.write(0,col,value)
        sheet.write(1,0,"A")
        sheet.write(1,1,45292,xlwt.easyxf(num_format_str="DD.MM.YYYY"))
        sheet.row(1).set_cell_error(2,"#DIV/0!")
        buffer=io.BytesIO();book.save(buffer)
        p=self.file("dates.xls",buffer.getvalue());result=engine.extract(p,p.name)
        self.assertTrue(result["coverage"]["complete"])
        row=result["tables"][0]["rows"][0]
        self.assertTrue(row[1].startswith("Дата Excel:"))
        self.assertEqual(row[2],"Ошибка Excel: #DIV/0!")
        self.assertIn("XLS_DATE_REVIEW",result["tables"][0]["warnings"])
        self.assertIn("XLS_CELL_ERROR_REVIEW",result["tables"][0]["warnings"])

    def test_xls_encryption_has_a_specific_manual_recovery_reason(self):
        raw=self.binary_workbook().get_biff_data()
        first_length=struct.unpack_from("<H",raw,2)[0]+4
        # FILEPASS marks encryption; no attempt to guess or remove the password.
        protected=raw[:first_length]+struct.pack("<HHHHH",0x002f,6,0,0,0)+raw[first_length:]
        p=self.file("protected.xls",protected);result=engine.extract(p,p.name)
        self.assertFalse(result["coverage"]["complete"])
        self.assertFalse(result["tables"])
        self.assertIn("XLS_PASSWORD_REQUIRED",result["warnings"])
        self.assertEqual(p.read_bytes(),protected)

    def test_xls_limits_and_damaged_input_do_not_claim_complete(self):
        for name,content in [("broken.xls",b"not an Excel file"),
                             ("truncated.xls",self.binary_workbook().get_biff_data()[:100])]:
            with self.subTest(name=name):
                p=self.file(name,content);r=engine.extract(p,p.name)
                self.assertFalse(r["coverage"]["complete"])
                self.assertFalse(r["tables"])
        for axis,index in [("row",5001),("column",30),("sheets",31)]:
            with self.subTest(axis=axis):
                book=xlwt.Workbook();sheet=book.add_sheet("Data")
                sheet.write(0,0,"sku");sheet.write(0,1,"price");sheet.write(1,0,"A");sheet.write(1,1,10)
                if axis=="row":sheet.write(index,0,"OVER")
                if axis=="column":sheet.write(1,index,"OVER")
                if axis=="sheets":
                    for n in range(index-1):book.add_sheet("Extra"+str(n))
                buffer=io.BytesIO();book.save(buffer)
                p=self.file(axis+".xls",buffer.getvalue());r=engine.extract(p,p.name)
                self.assertFalse(r["coverage"]["complete"])
                self.assertFalse(r["tables"])
                self.assertTrue(set(r["warnings"]) & {"TABLE_LIMIT","SHEET_LIMIT"})

    def test_text_is_unconfirmed_not_invented_product(self):
        p=self.file("input.txt","Аппарат, модель не указана\n\nИтого 10000".encode())
        r=engine.extract(p,p.name)
        self.assertEqual(r["tables"][0]["rows"][0],["","Аппарат, модель не указана",""])
        self.assertEqual(r["tables"][0]["row_locators"],["document:1/line:1","document:1/line:3"])
        self.assertEqual(r["enrichment"]["state"],"provider_not_configured")
    def test_text_table_locators_keep_original_blank_lines(self):
        for separator in ("\n", "\r\n", "\r"):
            raw=separator.join(["", "  ", "sku  title  price", "", "001-A  ТЕСТ  10", " ", "001-B  ТЕСТ  20", ""])
            for origin in ("document:1", "page:2", "image:1"):
                with self.subTest(separator=repr(separator),origin=origin):
                    table=engine.text_tables(raw,origin)[0]
                    self.assertEqual(table["header_locator"],origin+"/line:3")
                    self.assertEqual(table["row_locators"],[origin+"/line:5",origin+"/line:7"])
                    self.assertEqual(table["rows"],[["001-A","ТЕСТ","10"],["001-B","ТЕСТ","20"]])
                    for row,locator in zip(table["rows"],table["row_locators"]):
                        source_line=raw.splitlines()[int(locator.rsplit(":",1)[1])-1]
                        self.assertEqual(row,engine.re.split(r"\t| {2,}",source_line.strip()))
        self.assertEqual(engine.text_tables(" \n\t\n","document:1"),[])
    def test_extracted_text_keeps_original_block_and_provenance_version(self):
        raw="\nАртикул  Название  Цена\n\n001  ТЕСТ  10\n"
        for suffix in ("txt","md"):
            p=self.file("input."+suffix,raw.encode())
            result=engine.extract(p,p.name)
            self.assertEqual(result["blocks"][0]["text"],raw)
            self.assertEqual(result["text_locator_version"],2)
            self.assertEqual(result["tables"][0]["header_locator"],"document:1/line:2")
            self.assertEqual(result["tables"][0]["row_locators"],["document:1/line:4"])
            self.assertEqual(p.read_bytes(),raw.encode())
            self.assertTrue(result["review_required"])
    def test_xlsx_multisheet_and_raw_formulas(self):
        p=self.root/"input.xlsx"
        with zipfile.ZipFile(p,"w") as z:
            z.writestr("xl/workbook.xml",'<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Прайс" sheetId="1" r:id="r1"/><sheet name="Скрытый" sheetId="2" state="hidden" r:id="r2"/></sheets></workbook>')
            z.writestr("xl/_rels/workbook.xml.rels",'<Relationships><Relationship Id="r1" Target="worksheets/s1.xml"/><Relationship Id="r2" Target="worksheets/s2.xml"/></Relationships>')
            data='<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>sku</t></is></c><c r="B1" t="inlineStr"><is><t>price</t></is></c></row><row r="5"><c r="A5" t="inlineStr"><is><t>0007</t></is></c><c r="B5"><f>1+2</f><v>3</v></c></row></sheetData></worksheet>'
            z.writestr("xl/worksheets/s1.xml",data);z.writestr("xl/worksheets/s2.xml",data)
        r=engine.extract(p,p.name)
        self.assertEqual(len(r["tables"]),2)
        self.assertEqual(r["tables"][0]["rows"],[["0007","=1+2"]])
        self.assertEqual(r["tables"][0]["row_locators"],["sheet:1/row:5"])
        self.assertIn("HIDDEN_SHEET",r["tables"][1]["warnings"])
    def test_docx_and_ods_tables(self):
        for kind,entry,data in [
          ("docx","word/document.xml",'<document><body><tbl><tr><tc><p><t>sku</t></p></tc><tc><p><t>price</t></p></tc></tr><tr><tc><p><t>A</t></p></tc><tc><p><t>10</t></p></tc></tr></tbl></body></document>'),
          ("ods","content.xml",'<document><table><table-row><table-cell><p>sku</p></table-cell><table-cell><p>price</p></table-cell></table-row><table-row><table-cell><p>A</p></table-cell><table-cell><p>10</p></table-cell></table-row></table></document>')]:
            p=self.root/("input."+kind)
            with zipfile.ZipFile(p,"w") as z:z.writestr(entry,data)
            r=engine.extract(p,p.name)
            self.assertEqual(r["tables"][0]["rows"],[["A","10"]])
    def docx(self, body):
        p=self.root/"layout.docx"
        with zipfile.ZipFile(p,"w") as z:
            z.writestr("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'+body+'</w:body></w:document>')
        return p

    def test_docx_grid_spans_skipped_cells_and_text_breaks(self):
        p=self.docx('<w:tbl><w:tblGrid><w:gridCol/><w:gridCol/><w:gridCol/><w:gridCol/></w:tblGrid>'
          '<w:tr><w:tc><w:p><w:r><w:t>sku</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>title</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>cost</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>price</w:t></w:r></w:p></w:tc></w:tr>'
          '<w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>TEST-A</w:t></w:r></w:p><w:p><w:r><w:t>TEST-B</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>100</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>150</w:t></w:r></w:p></w:tc></w:tr>'
          '<w:tr><w:trPr><w:gridBefore w:val="1"/><w:gridAfter w:val="1"/></w:trPr><w:tc><w:p><w:pPr><w:tabs><w:tab w:pos="100"/></w:tabs></w:pPr><w:r><w:t>Название</w:t><w:br/><w:t>Продолжение</w:t><w:tab/><w:t>Модель</w:t><w:cr/><w:t>Конец</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>200</w:t></w:r></w:p></w:tc></w:tr></w:tbl>')
        original=p.read_bytes()
        r=engine.extract(p,p.name)
        self.assertTrue(r["coverage"]["complete"],r)
        self.assertEqual(r["docx_table_version"],2)
        self.assertEqual(r["tables"][0]["rows"],[
            ["TEST-A\nTEST-B","","100","150"],
            ["","Название\nПродолжение\tМодель\nКонец","200",""],
        ])
        self.assertEqual(r["tables"][0]["row_locators"],["table:1/row:2","table:1/row:3"])
        self.assertIn("Название\nПродолжение\tМодель\nКонец",[b["text"] for b in r["blocks"]])
        self.assertEqual(p.read_bytes(),original)
        self.assertTrue(r["review_required"])

    def test_docx_vertical_merge_never_invents_repeated_values(self):
        p=self.docx('<w:tbl><w:tr><w:tc><w:p><w:r><w:t>sku</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>price</w:t></w:r></w:p></w:tc></w:tr>'
          '<w:tr><w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>10</w:t></w:r></w:p></w:tc></w:tr>'
          '<w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc><w:tc><w:p><w:r><w:t>20</w:t></w:r></w:p></w:tc></w:tr></w:tbl>')
        self.assertEqual(engine.extract(p,p.name)["tables"][0]["rows"],[["A","10"],["","20"]])

    def test_docx_unsafe_or_ambiguous_grid_requires_review(self):
        for value in ("0","-1","31","999999999","x"):
            p=self.docx('<w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="'+value+'"/></w:tcPr><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc></w:tr></w:tbl>')
            r=engine.extract(p,p.name)
            self.assertFalse(r["coverage"]["complete"],value)
            self.assertIn("DOCX_GRID_REVIEW",r["warnings"])
            self.assertFalse(r["tables"])
        p=self.docx('<w:tbl><w:tr><w:tc><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Nested</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:tc></w:tr></w:tbl>')
        r=engine.extract(p,p.name)
        self.assertFalse(r["coverage"]["complete"])
        self.assertIn("NESTED_TABLE_REVIEW",r["warnings"])
        self.assertFalse(r["tables"])

    def test_xml_entities_rejected(self):
        with self.assertRaises(engine.ReviewRequired):
            engine.xml(b'<!DOCTYPE foo [<!ENTITY x "test">]><foo>&x;</foo>')
    def test_archive_duplicates_rejected(self):
        p=self.root/"input.docx"
        with zipfile.ZipFile(p,"w") as z:
            z.writestr("word/document.xml","<doc/>")
            z.writestr("word/document.xml","<doc/>")
        r=engine.extract(p,p.name)
        self.assertIn("ARCHIVE_INVALID",r["warnings"])
    def test_real_ocr_image_and_scanned_pdf(self):
        im=Image.new("RGB",(1000,250),"white")
        font=ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",38)
        ImageDraw.Draw(im).text((30,50),"SKU TEST-001   Training   1250",fill="black",font=font)
        for suffix in ("png","pdf"):
            p=self.root/("scan."+suffix);im.save(p)
            r=engine.extract(p,p.name)
            self.assertTrue(r["coverage"]["complete"],r)
            self.assertIn("TEST-",r["blocks"][0]["text"])
            # OCR may confuse zero and O: never pretend this is a verified SKU.
            self.assertEqual(r["tables"][0]["rows"][0][0],"")
            self.assertEqual(r["blocks"][0]["engine"],"tesseract-rus-eng")
            self.assertTrue(r["review_required"])
    def test_bad_encoding_and_oversize(self):
        p=self.file("input.csv",b"\xff\xff")
        self.assertFalse(engine.extract(p,p.name)["coverage"]["complete"])
        with self.assertRaises(engine.ReviewRequired):
            engine.extract(self.file("huge.txt",b"x"*(engine.MAX_BYTES+1)),"huge.txt")

if __name__=="__main__":unittest.main()
