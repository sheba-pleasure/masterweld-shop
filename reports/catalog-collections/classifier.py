#!/usr/bin/env python3
"""Интернет-магазин «Мастер Сварщик»: воспроизводимая разметка каталога и подборок.

Только чтение: данные выгружаются через SELECT (psql COPY ... TO STDOUT).
Скрипт ничего не пишет в базу; результат — CSV и отчёт в этой папке.
Запуск:  python3 reports/catalog-collections/classifier.py
"""
import csv, io, re, subprocess, sys
from collections import Counter, defaultdict
from pathlib import Path

OUT = Path(__file__).resolve().parent

SQL = """
COPY (
  SELECT p.id, coalesce(p.sku,'') sku, p.title, p.status::text status,
         coalesce(c.name,'') cat, coalesce(pc.name,'') parent, coalesce(c.slug,'') cat_slug,
         coalesce(p.brand,'') brand, p.price, coalesce(p.old_price::text,'') old_price,
         p.in_stock, coalesce(p.stock_qty::text,'') stock_qty,
         coalesce(p.specs,'') specs, coalesce(p.source_url,'') source_url,
         (SELECT count(*) FROM product_photos f WHERE f.product_id = p.id) photos
  FROM products p
  LEFT JOIN categories c ON c.id = p.category_id
  LEFT JOIN categories pc ON pc.id = c.parent_id
  ORDER BY p.title, p.id
) TO STDOUT WITH CSV HEADER
"""

def load():
    r = subprocess.run(["psql", "-X", "-q", "-c", SQL], capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit("psql error: " + r.stderr)
    return list(csv.DictReader(io.StringIO(r.stdout)))

def rx(p): return re.compile(p, re.I)

# ---------- признаки по названию ----------
PART = rx(r"(сопл|наконечник|цанг|диффузор|катод|изолятор|колпач|газ\.?\s*линз|канал|головк|корпус цанг|спираль|насадк|электрод(?!ы\s)(?= к плазм)|завихр)")
FOR_TORCH = rx(r"(для|к)\s+(сварочн\w+\s+)?горелк|держател\w+\s+(сварочн\w+\s+)?горелк|головк\w*\s+горелк")
TORCH = rx(r"(^|\s)(сварочная\s+)?горелка\b")
MACHINE = rx(r"(аппарат|полуавтомат|инвертор|САИ|\bARC\b|\bMIG\s*\d|\bTIG\s*\d|\bMMA\b|bestmini|GYSmi|\bMaster\s*\d|Мастер\s*\d|ВД-\d|МТРА|SAGGIO)")
ELECTRODE = rx(r"^(\S+\s+)?электрод")
TUNGSTEN = rx(r"(вольфрам|\bW[CLTPYZ]-?\d{2}\b)")
WIRE = rx(r"проволок")
ROD = rx(r"(пруток|прутки|присадоч)")
REDUCER = rx(r"(^|\s)(БКО|БАО|БПО|БГО|БАРО|БАЗО|БУО|БМО|БВО|УР-|РЗ\s*\d|Р3|AP-|АР-|У-30|TECH CONTROL|редуктор|регулятор)")
GLASS = rx(r"(стекло|светофильтр|хамелеон|АСФ)")
MASK = rx(r"маск")
FULL_MASK = rx(r"^(маска(-щиток)?|маска сварщика|сварочная маска)\b")

def target_category(p):
    """Возвращает список (раздел, правило, уверенность)."""
    t, cat, par = p["title"], p["cat"], p["parent"]
    m = []
    in_mig = "MIG/MAG" in cat; in_tig = "TIG" in cat
    is_part = bool(PART.search(t)) or bool(FOR_TORCH.search(t))
    is_torch = bool(TORCH.search(t)) and not FOR_TORCH.search(t)
    if "плазм" in (cat + par).lower():
        return [("Плазменная резка (CUT) / " + {"Аппараты плазменной резки": "Аппараты",
                 "Плазмотроны": "Плазмотроны"}.get(cat, "Расходники к плазмотронам"),
                 "раздел плазменной резки без изменений", "high")]
    if "Газовая сварка" in par:
        sub = {"Газовые резаки": "Резаки", "Газовые горелки": "Горелки (газовые и кислородные)",
               "Кислородно-газовые горелки": "Горелки (газовые и кислородные)",
               "Газовоздушные и кровельные горелки": "Газовоздушные и кровельные"}.get(cat, "Рукава и принадлежности")
        return [("Газовая сварка и резка / " + sub, "раздел газовой сварки без изменений", "high")]
    if "Генераторы" in (cat + par):
        sub = "Компрессоры" if "Компрессор" in cat or "компрессор" in t.lower() else "Генераторы"
        return [("Генераторы и компрессоры / " + sub, "раздел генераторов без изменений", "high")]
    if "Защита" in (cat + par):
        full_mask = bool(FULL_MASK.match(t.strip())) and not rx(r"для\s+маск").search(t)
        if full_mask: m.append(("Защита сварщика / Маски", "название начинается с «Маска» — готовая маска", "high"))
        elif GLASS.search(t) or rx(r"оголов|крепёж|крепеж|(для|к)\s+маск").search(t): m.append(("Защита сварщика / Комплектующие к маскам", "светофильтр/стекло/оголовье/крепёж для маски", "medium"))
        elif cat == "Сварочные маски" or MASK.search(t): m.append(("Защита сварщика / Маски", "раздел или слово «маска»", "medium"))
        elif cat in ("Перчатки и краги", "Спецодежда и обувь"): m.append(("Защита сварщика / Перчатки, краги, спецодежда", "подраздел защиты", "high"))
        return m
    if cat == "Сварочные аппараты" or (par == "Сварочные аппараты") or (cat == "Другие товары для сварки и резки" and MACHINE.search(t)) or "Контактная сварка" in (cat + par) or cat in ("Сварка под флюсом (SAW)", "Сварка пластиковых труб"):
        if "Контактная" in (cat + par):
            if "Комплектующие" in cat or PART.search(t):
                return [("Оснастка / Комплектующие для контактной сварки", "подраздел комплектующих контактной сварки", "high")]
            return [("Сварочные аппараты / Контактная сварка", "раздел контактной сварки", "high")]
        if cat in ("Сварка под флюсом (SAW)", "Сварка пластиковых труб"):
            return [("Сварочные аппараты / Прочие (SAW, сварка труб)", "малый раздел", "high")]
        if par == "Сварочные аппараты":
            sub = {"Полуавтоматы MIG/MAG": "MIG/MAG", "Аргонодуговые аппараты TIG": "TIG", "Аппараты ручной дуговой сварки MMA": "MMA"}[cat]
            return [("Сварочные аппараты / " + sub, "подраздел аппаратов без изменений", "high")]
        procs = set()
        if rx(r"\bTIG\b|аргонодугов").search(t): procs.add("TIG")
        if rx(r"\bMIG\b|полуавтомат|САИПА|\bMAG\b").search(t): procs.add("MIG/MAG")
        if rx(r"\bMMA\b|\bARC\b|САИ\s*-?\s*\d|ручной дуговой").search(t) and not rx(r"САИПА").search(t): procs.add("MMA")
        if rx(r"МТРА|контактн").search(t): procs = {"Контактная сварка"}
        if len(procs) == 1:
            pr = procs.pop()
            return [("Сварочные аппараты / " + pr, "процесс в названии аппарата", "medium")]
        return [] if not procs else [("Сварочные аппараты / " + x, "несколько процессов в названии", "low") for x in sorted(procs)]
    # электросварка: горелки и расходники
    if "Расходники для электросварки" in (cat + par) or cat == "Другие товары для сварки и резки" or "Оборудование и аксессуары" in (cat + par) or cat == "Товары по акции":
        if TUNGSTEN.search(t): m.append(("Сварочные материалы / Вольфрамовые электроды", "вольфрам/WC-WL-WT в названии", "medium"))
        elif ELECTRODE.search(t) and not rx(r"электрододерж").search(t): m.append(("Сварочные материалы / Электроды", "слово «электрод» в начале названия", "medium"))
        if WIRE.search(t): m.append(("Сварочные материалы / Проволока", "слово «проволока»", "medium"))
        if ROD.search(t) and not WIRE.search(t): m.append(("Сварочные материалы / Присадочные прутки", "слово «пруток/присадочные»", "medium"))
        if REDUCER.search(t): m.append(("Редукторы и регуляторы газа", "маркировка редуктора в названии", "medium"))
        if rx(r"клемм").search(t) or cat == "Клеммы заземления": m.append(("Оснастка / Кабели и соединители", "клемма заземления", "high"))
        if rx(r"электрододерж").search(t): m.append(("Оснастка / Электрододержатели и зажимы", "электрододержатель", "medium"))
        if rx(r"магнит").search(t) or cat == "Магнитные держатели": m.append(("Оснастка / Магнитные держатели", "магнитный держатель", "medium"))
        if rx(r"кабел|вилк|розетк|разъ[её]м|штекер|байонет").search(t) and not is_torch and not rx(r"электрододерж|клемм").search(t): m.append(("Оснастка / Кабели и соединители", "кабель/вилка/розетка в названии", "low"))
        if is_torch and not m:
            if in_mig or rx(r"\b(MS|MB|MIG)\s*-?\s*\d|полуавтомат").search(t): m.append(("Сварочные горелки / MIG/MAG", "целая горелка, серия/раздел MIG", "medium"))
            elif in_tig or rx(r"\b(TS|SRT|TIG|WP|UnoTIG)\s*-?\s*\d|аргон").search(t): m.append(("Сварочные горелки / TIG", "целая горелка, серия/раздел TIG", "medium"))
        elif is_part and not m:
            if in_mig: m.append(("Расходные части к горелкам / MIG/MAG", "запчасть, раздел MIG", "medium"))
            elif in_tig: m.append(("Расходные части к горелкам / TIG", "запчасть, раздел TIG", "medium"))
        if not m:
            if cat == "Расходники для MIG/MAG": m.append(("Расходные части к горелкам / MIG/MAG", "оставлено по исходному подразделу", "medium"))
            elif cat == "Расходники для TIG": m.append(("Расходные части к горелкам / TIG", "оставлено по исходному подразделу", "medium"))
            elif cat == "Редукторы и регуляторы расхода газа": m.append(("Редукторы и регуляторы газа", "исходный подраздел", "high"))
            elif cat == "Сварочные кабели и комплекты": m.append(("Оснастка / Кабели и соединители", "исходный подраздел", "high"))
    return m

# ---------- подборки ----------
COLL = [
 ("01_price_reduced", "Цена снижена"), ("02_brand_foxweld", "FoxWeld"), ("03_brand_varteg", "Varteg"),
 ("04_marked_in_stock", "Отмечены как в наличии"), ("05_tig_acdc", "TIG AC/DC — алюминий"),
 ("06_pulse", "Импульсная сварка"), ("07_filler_aluminium", "Присадка и проволока для алюминия"),
 ("08_filler_stainless", "Присадка и проволока для нержавейки"), ("09_no_gas", "Сварка без газа"),
 ("10_power_380", "Питание 380 В"), ("11_power_220", "Питание 220 В"), ("12_tungsten", "Вольфрамовые электроды"),
 ("13_masks_filters", "Маски-хамелеоны и светофильтры"), ("14_reducers_argon", "Редукторы для аргона и смеси"),
 ("15_pt31_parts", "Расходные части для плазмотрона PT-31"), ("16_tig17", "Горелки и запчасти TIG-17"),
 ("17_tig26", "Горелки и запчасти TIG-26"), ("18_mig15", "Горелки и запчасти MIG-15"),
 ("19_mig24", "Горелки и запчасти MIG-24"), ("20_mig25", "Горелки и запчасти MIG-25"), ("21_mig36", "Горелки и запчасти MIG-36"),
 ("22_roofing", "Кровельные работы"), ("23_multiprocess", "Многопроцессные аппараты MMA/MIG/TIG"),
 ("24_body_repair", "Кузовной ремонт"), ("25_field_mount", "Выездной монтаж"), ("26_garage", "Гараж и мастерская"),
 ("27_machine_kit", "Комплект к аппарату"), ("28_mask_glass_size", "Комплектующие к маскам по размеру светофильтра"),
]
KEYS = {k for k, _ in COLL}

def collections(p, target):
    t, s = p["title"], p["specs"]; out = []
    def add(k, field, ev, st, note=""): out.append((k, field, ev[:160], st, note))
    is_machine = target.startswith("Сварочные аппараты") or bool(MACHINE.search(t) and rx(r"аппарат|полуавтомат|SAGGIO|САИ").search(t))
    is_material = target.startswith("Сварочные материалы") or bool(WIRE.search(t) or ROD.search(t))
    if p["old_price"] and float(p["old_price"]) > float(p["price"]):
        add("01_price_reduced", "old_price>price", f"{p['price']} < {p['old_price']}", "verified_field", "Не «Акция»: маркетинговое подтверждение отсутствует")
    if p["brand"].lower() == "foxweld": add("02_brand_foxweld", "brand", p["brand"], "verified_field")
    elif "foxweld" in t.lower(): add("02_brand_foxweld", "title", "FoxWeld в названии, поле brand пустое/другое", "needs_spec_review", "Проверить поле бренда")
    if p["brand"].lower() == "varteg": add("03_brand_varteg", "brand", p["brand"], "verified_field")
    elif "varteg" in t.lower(): add("03_brand_varteg", "title", "Varteg в названии, поле brand пустое/другое", "needs_spec_review", "Проверить поле бренда")
    if p["in_stock"] == "t": add("04_marked_in_stock", "in_stock", "in_stock=true, stock_qty пусто", "editorial_review", "Логический флаг, складской остаток не подтверждён")
    acdc_t, acdc_s = rx(r"AC\s*/\s*DC").search(t), rx(r"AC\s*/\s*DC").search(s)
    if acdc_t or acdc_s:
        if not is_machine: add("05_tig_acdc", "title" if acdc_t else "specs", "AC/DC у не-аппарата", "rejected", "Не сварочный аппарат")
        elif acdc_s and rx(r"TIG").search(t + s): add("05_tig_acdc", "specs", acdc_s.group(0), "needs_spec_review", "AC/DC в характеристиках; сверить с техпаспортом перед публикацией")
        else: add("05_tig_acdc", "title", acdc_t.group(0), "needs_spec_review", "Только название")
    if rx(r"pulse|импульс").search(t + " " + s):
        add("06_pulse", "title" if rx(r"pulse|импульс").search(t) else "specs", "Pulse/импульс", "needs_spec_review" if is_machine else "rejected", "" if is_machine else "Не аппарат")
    if rx(r"ER\s*-?\s*4043|ER\s*-?\s*5356|AlSi|AlMg|ER\s*-?\s*1100|алюмин").search(t):
        add("07_filler_aluminium", "title", "марка Al в названии", "needs_spec_review" if is_material else "rejected", "" if is_material else "Не присадочный материал")
    if rx(r"ER\s*-?\s*30[89]|ER\s*-?\s*316|нерж").search(t):
        add("08_filler_stainless", "title", "марка нержавейки в названии", "needs_spec_review" if is_material else "rejected", "" if is_material else "Не присадочный материал")
    if rx(r"E71T|самозащит|порошков|без газа|флюс").search(t):
        st = "needs_spec_review" if WIRE.search(t) else "rejected"
        add("09_no_gas", "title", "E71T/самозащитная/флюс", st, "Проволока-кандидат; аппараты без газа не подтверждены — подборку не публиковать" if st != "rejected" else "Не проволока (например, флюс SAW)")
    for key, volt in (("10_power_380", "380"), ("11_power_220", "220|230")):
        mv = rx(rf"({volt})\s*В\b").search(s) or rx(rf"({volt})\s*В\b").search(t)
        if mv: add(key, "specs" if rx(rf"({volt})\s*В\b").search(s) else "title", mv.group(0), "needs_spec_review", "Напряжение указано с «В», сверить с техпаспортом")
        elif is_machine and rx(rf"\b({volt})\b").search(t): add(key, "title", "число без «В»", "rejected", "Число в названии — ток или модель, не напряжение")
    if TUNGSTEN.search(t): add("12_tungsten", "title", "вольфрам/WC", "needs_spec_review" if target.endswith("Вольфрамовые электроды") else "editorial_review")
    if GLASS.search(t) or (MASK.search(t) and rx(r"хамелеон|АСФ").search(t + s)):
        add("13_masks_filters", "title", "маска/светофильтр", "needs_spec_review")
    if REDUCER.search(t) and rx(r"аргон|AR|CO2|углекисл|У-30|АР-").search(t + " " + s):
        add("14_reducers_argon", "title/specs", "газ в описании", "needs_spec_review", "Сверить тип газа")
    if rx(r"PT\s*-?\s*31").search(t): add("15_pt31_parts", "title", "PT-31", "needs_spec_review", "Совместимость только после сверки атрибута")
    for key, pat in (("16_tig17", r"(TIG|TS|WP|SRT|UnoTIG)\s*-?\s*17|TIG17"), ("17_tig26", r"(TIG|TS|WP|SRT|UnoTIG)\s*-?\s*26|TIG17/18/26"),
                     ("18_mig15", r"(MIG|MS|MB)\s*-?\s*15\b"), ("19_mig24", r"(MIG|MS|MB)\s*-?\s*24\b"), ("20_mig25", r"(MIG|MS|MB)\s*-?\s*25\b"), ("21_mig36", r"(MIG|MS|MB)\s*-?\s*36\b")):
        mm = rx(pat).search(t)
        if mm: add(key, "title", mm.group(0), "needs_spec_review", ("целая горелка" if TORCH.search(t) and not FOR_TORCH.search(t) and not PART.search(t) else "запчасть/аксессуар") + "; серия по названию, совместимость не подтверждена")
    if p["cat_slug"].endswith("krovelnye"): add("22_roofing", "category", p["cat"], "editorial_review", "Раздел подтверждён; состав сценария — кураторский")
    elif rx(r"кровельн").search(t): add("22_roofing", "title", "кровельная", "editorial_review")
    if is_machine:
        procs = sum(bool(rx(x).search(t + " " + s)) for x in (r"\bMMA\b|ручн\w+ дугов", r"\bMIG\b|\bMAG\b|полуавтомат", r"\bTIG\b|аргонодугов"))
        if procs >= 2 or rx(r"multi|мульти|3\s*в\s*1").search(t): add("23_multiprocess", "title/specs", f"процессов: {procs}", "needs_spec_review", "Режимы подтвердить по техпаспорту")
    gm = rx(r"(стекло|светофильтр|хамелеон|фильтр)[^\d]{0,30}(\d{2,3})\s*[*xх×]\s*(\d{2,3})").search(t)
    if gm: add("28_mask_glass_size", "title", f"{gm.group(2)}×{gm.group(3)}", "needs_spec_review", "Размер в названии; совместимость с масками не подтверждена")
    return out

DIAM = rx(r"(?:\bd|\bд|\bD)\s*[.=]?\s*=?\s*(\d+(?:[.,]\d+)?)\s*(?:mm|мм)?")
def diameters(title):
    """Разные явные диаметры (d=3.0 & d=4.0). Обозначения катушек вида D100 не считаются."""
    vals = set()
    for v in DIAM.findall(title):
        x = float(v.replace(",", "."))
        if x < 20: vals.add(x)
    return vals

def main():
    rows = load()
    ids = [r["id"] for r in rows]
    assert len(ids) == len(set(ids)), "duplicate ids"
    dup = defaultdict(list)
    for r in rows: dup[re.sub(r"\s+", " ", r["title"].strip().lower())].append(r)
    audit, cand = [], []
    for r in rows:
        m = target_category(r)
        old = (r["parent"] + " / " if r["parent"] else "") + r["cat"]
        targets = sorted({x[0] for x in m})
        reasons = []
        if len(targets) == 1:
            tgt, rule, conf = m[0][0], m[0][1], m[0][2]
        else:
            tgt, rule, conf = old + " (без изменений)", ("нет подходящего правила" if not targets else "несколько правил: " + " | ".join(targets)), "uncertain"
            reasons.append("неоднозначная категория")
        if conf == "low":
            rule = f"кандидат: {tgt} ({rule}); категория не меняется"
            tgt = old + " (без изменений)"
            reasons.append("низкая уверенность правила — требует проверки")
        if len(dup[re.sub(r"\s+", " ", r["title"].strip().lower())]) > 1: reasons.append("повтор названия")
        if r["status"] != "published": reasons.append("черновик")
        if r["photos"] == "0": reasons.append("нет фото")
        if not r["specs"].strip(): reasons.append("нет характеристик")
        if not r["brand"].strip(): reasons.append("нет бренда")
        if len(diameters(r["title"])) >= 2: reasons.append("несколько вариантов в одном товаре")
        cs = collections(r, tgt if conf != "uncertain" else "")
        for c in cs:
            assert c[0] in KEYS
            cand.append({"collection_key": c[0], "product_id": r["id"], "title": r["title"], "evidence_field": c[1], "evidence_text": c[2], "status": c[3], "note": c[4]})
        audit.append({"product_id": r["id"], "sku": r["sku"], "title": r["title"], "status": r["status"], "category_old": old,
            "brand": r["brand"], "price": r["price"], "in_stock": "true" if r["in_stock"] == "t" else "false",
            "proposed_category": tgt, "category_rule": rule, "category_confidence": conf,
            "collection_candidate_keys": ";".join(sorted({c[0] for c in cs if c[3] != "rejected"})),
            "review_reason": "; ".join(reasons), "original_source_url": r["source_url"]})
    with open(OUT / "products-audit.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(audit[0])); w.writeheader(); w.writerows(audit)
    with open(OUT / "collection-candidates.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(cand[0])); w.writeheader(); w.writerows(cand)
    write_report(rows, audit, cand, dup)

def write_report(rows, audit, cand, dup):
    st = Counter(r["status"] for r in rows)
    conf = Counter(a["category_confidence"] for a in audit)
    need_review = sum(1 for a in audit if a["category_confidence"] in ("uncertain", "low") or "повтор названия" in a["review_reason"] or "несколько вариантов" in a["review_reason"])
    by = defaultdict(Counter); fields = defaultdict(Counter)
    for c in cand: by[c["collection_key"]][c["status"]] += 1; fields[c["collection_key"]][c["evidence_field"]] += 1
    pub = {r["id"] for r in rows if r["status"] == "published"}
    pub_ok = Counter(c["collection_key"] for c in cand if c["status"] == "verified_field" and c["product_id"] in pub)
    L = ["# Интернет-магазин «Мастер Сварщик»: разметка каталога и кандидатные подборки", "",
         "Только чтение. База, товары, цены, разделы, адреса и noindex не менялись. Подборки ниже — 28 кандидатов (27 из плана; MIG-24 и MIG-25 разделены, так как это разные серии), а не опубликованные страницы.", "",
         "## Сводка по данным", "",
         f"- Товаров: **{len(rows)}**, уникальных product_id: **{len({r['id'] for r in rows})}** (в products-audit.csv ровно по одной строке на товар).",
         f"- Опубликовано: **{st['published']}**, черновиков: **{st['draft']}**, скрытых: **{st['hidden']}**.",
         f"- Отметка «в наличии» (логический флаг): опубликованные — true {sum(r['in_stock']=='t' and r['status']=='published' for r in rows)}, false {sum(r['in_stock']!='t' and r['status']=='published' for r in rows)}; черновики — true {sum(r['in_stock']=='t' and r['status']=='draft' for r in rows)}, false {sum(r['in_stock']!='t' and r['status']=='draft' for r in rows)}.",
         f"- Точное количество (stock_qty) заполнено у {sum(bool(r['stock_qty']) for r in rows)} товаров. Актуальный складской остаток не подтверждён, «в наличии сегодня» не обещаем.",
         f"- Уверенность в предложенном разделе: high {conf['high']}, medium {conf['medium']}, low {conf['low']}, uncertain {conf['uncertain']}.",
         f"- Требуют ручной проверки (uncertain/low, повтор названия или несколько вариантов в одном товаре): **{need_review}**.",
         f"- Пар «товар — подборка»: {len(cand)}.", "",
         "Уверенность medium означает, что правило сработало по названию. Перед переносом раздела такие товары проверяются выборочно.", "",
         "## 28 кандидатных подборок", "",
         "| Ключ | Подборка | Кандидатов (без rejected) | Поля-основания | verified_field (опубл.) | needs_spec_review | editorial_review | rejected |", "|---|---|---|---|---|---|---|---|"]
    for k, name in COLL:
        b = by[k]; tot = b["verified_field"] + b["needs_spec_review"] + b["editorial_review"]
        fl = ", ".join(f"{f} {n}" for f, n in fields[k].most_common()) or "—"
        L.append(f"| {k} | {name} | {tot} | {fl} | {pub_ok[k]} | {b['needs_spec_review']} | {b['editorial_review']} | {b['rejected']} |")
    L += ["", "Подборки 24–27 (кузовной ремонт, выездной монтаж, гараж, комплект к аппарату) не имеют автоматических кандидатов: их собирает эксперт вручную, автоматически они не публикуются.", ""]
    # конфликты
    L += ["## Типовые конфликты (примеры с артикулами)", ""]
    def sku(a): return a["sku"] or "без артикула"
    shown = 0
    for a in audit:
        if a["category_confidence"] == "uncertain" and shown < 10:
            L.append(f"- [{sku(a)}] {a['title']} — {a['category_old']}: {a['category_rule']}"); shown += 1
    rej = [c for c in cand if c["status"] == "rejected"][:6]
    for c in rej:
        a = next(x for x in audit if x["product_id"] == c["product_id"])
        L.append(f"- [{sku(a)}] {c['title']} — подборка {c['collection_key']} отклонена: {c['note']}")
    multi = [a for a in audit if "несколько вариантов" in a["review_reason"]][:4]
    for a in multi: L.append(f"- [{sku(a)}] {a['title']} — один товар на несколько диаметров")
    L += ["", "## Потенциальные дубли (одинаковые названия)", "", "| Название | Товары (артикул · цена · статус) |", "|---|---|"]
    nd = 0
    for t, g in sorted(dup.items()):
        if len(g) > 1:
            nd += 1
            L.append(f"| {g[0]['title']} | " + "; ".join(f"{r['sku'] or 'без арт.'} · {r['price']} · {r['status']}" for r in g) + " |")
    L += ["", f"Групп повторов: **{nd}**. Ничего не объединяется автоматически: сначала сверяются цена, артикул, адрес на старом сайте (source_url) и фото.", ""]
    # главная
    L += ["## Плитки для главной", "",
          "Главная показывает только подборки, у которых основание проверено полем базы, а не словом в названии. Сейчас таких тематических подборок нет: все тематические (AC/DC, алюминий, нержавейка, PT-31, серии горелок, маски) имеют статус needs_spec_review.", "",
          "Можно показать сразу (подтверждено полем):", "",
          f"1. Цена снижена — {pub_ok['01_price_reduced']} опубликованных товаров. Подпись «Цена снижена», не «Акция».", "",
          "Не показывать на главной: FoxWeld/Varteg (бренды, а не задачи; оставить на странице «Подборки»), «Отмечены как в наличии» (до синхронизации склада).", "",
          "Очередь после проверки характеристик, по убыванию ценности:", "",
          "2. Расходные части для плазмотрона PT-31", "3. Присадка и проволока для алюминия", "4. Присадка и проволока для нержавейки",
          "5. Горелки и запчасти MIG-15 / MIG-24 / MIG-25 / MIG-36 (каждая серия отдельно)", "6. Горелки и запчасти TIG-17 / TIG-26", "7. TIG AC/DC — алюминий", "8. Маски-хамелеоны и светофильтры", "",
          "Пока подтверждена одна плитка, на главной показывается одна. Остальные места не заполняются, ничего не выдумывается.", "",
          "## Следующий этап (только после отдельного согласия)", "",
          "1. Новые таблицы: подборки, проверенные метки «товар — метка — кто подтвердил», ручной состав подборок. Таблицы товаров и разделов не меняются.",
          "2. Импорт меток со статусом needs_spec_review в очередь подтверждения в Telegram-боте (кнопки «подтвердить / отклонить»).",
          "3. Публикуется только подборка с минимум 3 подтверждёнными опубликованными товарами. На плитке показывается реальное число товаров.",
          "4. Откат: подборку можно снять с публикации кнопкой. Полный откат — удаление новых таблиц, каталог при этом не затрагивается.",
          "5. Повторная разметка после обновления прайса: `python3 reports/catalog-collections/classifier.py`. Запуск только читает базу.", ""]
    (OUT / "report.md").write_text("\n".join(L), encoding="utf-8")
    print("rows", len(rows), "cand", len(cand), "review", need_review, conf, dict(st))

if __name__ == "__main__":
    main()
