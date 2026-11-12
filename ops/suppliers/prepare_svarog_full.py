"""Build a reviewable, lossless full intake from the independently audited workbook.

No database writes, price approval, publication or fuzzy identity merge.
The input workbook checksum is mandatory; audit data must match it.
"""
from pathlib import Path
from collections import defaultdict, Counter
from datetime import datetime, timezone
import argparse, csv, hashlib, json, re, uuid

SCHEMA = 'masterweld-svarog-full-intake-v1'
EXPECTED_SHA = 'f63d386248cdec16cbf9dcfeae3c9b003e0ca7267326f44c3a15ff96b7bbd74e'
CONFIG = {
 'Сварочное оборудование Сварог': ('G', 'recommended_retail', 'E', 'equipment'),
 'Сварочные материалы': ('D', 'recommended_retail_package', None, 'materials'),
 'Редукторы и регуляторы ': ('G', 'retail', 'D', 'gas/reducers'),
 'Комплектующие к ГО': ('D', 'retail', 'C', 'gas/components'),
 'Горелки и резаки газовые': ('D', 'retail', 'C', 'gas/torches-cutters'),
 'Машины газовой резки': ('D', 'retail', 'C', 'gas/cutting-machines'),
 'Сварочные горелки': ('D', 'retail', 'F', 'torches'),
 'Запасные части к горелкам': ('D', 'retail', 'F', 'torch-spares'),
 'СИЗ и химия ': ('C', 'recommended_retail', 'E', 'protection-chemistry'),
 'Аксессуары': ('E', 'recommended_retail', 'D', 'accessories'),
}

def checksum(raw):
    return hashlib.sha256(raw).hexdigest()

def display_code(r):
    raw = r['code_raw'].strip()
    if r['code_type'] == 'n':
        if not re.fullmatch(r'\d+', raw) or not r['code_format'].startswith('00000000000'):
            raise ValueError('UNREVIEWED_NUMERIC_CODE_FORMAT')
        return raw.zfill(11)
    return raw

def normalize(rows, inventory, original):
    digest = checksum(original)
    if digest != EXPECTED_SHA or inventory['sha256'] != digest:
        raise ValueError('SOURCE_CHECKSUM_MISMATCH')
    groups = defaultdict(list)
    locators = set()
    for r in rows:
        key = (r['sheet'], r['row'])
        if key in locators:
            raise ValueError('DUPLICATE_SOURCE_LOCATOR')
        locators.add(key)
        groups[display_code(r)].append(r)
    if len(rows) != 2008 or len(groups) != 1966:
        raise ValueError('WORKBOOK_STRUCTURE_REVIEW_REQUIRED')
    source_rows, cards, conflicts = [], [], []
    sheets = {s['name']: s for s in inventory['sheets']}
    for r in rows:
        s, number = r['sheet'], r['row']
        code = display_code(r)
        pc, price_type, description_col, category = CONFIG[s]
        cells = r['cells']
        get = lambda col: cells.get(col, {}).get('value') if col else None
        raw_name = r['name'] or get('C')
        if not isinstance(raw_name, str) or not raw_name.strip():
            raise ValueError('EMPTY_PRODUCT_NAME')
        warnings = []
        if len(groups[code]) > 1: warnings.append('duplicate_code_requires_identity_decision')
        if r['hidden']: warnings.append('hidden_source_row')
        if 'СНЯТ' in raw_name.upper(): warnings.append('discontinued_in_source_requires_recheck')
        price = r['prices'][pc]
        if not price or price['type'] == 'e': warnings.append('source_price_error_or_empty')
        if price and price['type'] == 'f': warnings.append('formula_price_not_approved')
        if not r['name']: warnings.append('name_from_description_column')
        if s == 'Сварочные материалы' and 84 <= number <= 139: warnings.append('package_quantity_unknown')
        if s == 'Сварочные материалы' and number == 141: warnings.append('package_unit_conversion_conflict')
        if code == '00000087388': warnings.append('thread_dimension_identity_conflict')
        if s == 'Сварочные материалы' and number == 82: warnings.append('brand_section_conflict')
        urls = [v['value'].strip() for v in cells.values() if isinstance(v['value'], str)
                and v['value'].strip().startswith(('https://', 'http://'))]
        urls += [link['target'] for link in sheets[s]['links']
                 if re.sub(r'\D+', '', link['cell']) == str(number) and link['target']]
        urls = sorted(set(urls))
        brand = None
        brand_basis = 'unconfirmed'
        if re.search(r'сварог', raw_name, re.I): brand, brand_basis = 'Сварог', 'product_name'
        elif 'ELKRAFT' in (r['section'] or '').upper(): brand, brand_basis = 'ELKRAFT', 'section'
        elif re.search(r'ROSMA', raw_name, re.I): brand, brand_basis = 'ROSMA', 'product_name'
        # Workbook brand is a candidate, not proof that Hypertherm-compatible spares are made by it.
        candidate_brand = brand or 'Сварог'
        if brand is None: warnings.append('brand_from_workbook_requires_confirmation')
        packaging = {'sale_unit': None, 'price_unit': None, 'package_quantity': None,
                     'package_mass_kg': None, 'minimum_order_quantity': None,
                     'minimum_wholesale_quantity': None, 'raw': None}
        if s == 'Сварочные материалы' and isinstance(get('C'), (int, float)):
            packaging.update(package_mass_kg=get('C'), price_unit='package', raw={'C': get('C')})
        if s == 'Редукторы и регуляторы ':
            packaging.update(sale_unit='piece', price_unit='piece', package_quantity=get('H'), raw={'H': get('H')})
        if s == 'Горелки и резаки газовые': packaging.update(package_quantity=get('E'), raw={'E': get('E')})
        if s == 'Сварочные горелки': packaging.update(minimum_order_quantity=get('E'), raw={'E': get('E')})
        if s == 'Запасные части к горелкам': packaging.update(minimum_wholesale_quantity=get('E'), raw={'E': get('E')})
        if s == 'СИЗ и химия ': packaging.update(minimum_order_quantity=get('D'), raw={'D': get('D')})
        if s == 'Аксессуары': packaging.update(minimum_order_quantity=get('F'), raw={'F': get('F')})
        row_id = f'{digest}:{s}:{number}'
        candidate_id = str(uuid.uuid5(uuid.NAMESPACE_URL, 'masterweld:svarog:row:' + row_id))
        group_id = str(uuid.uuid5(uuid.NAMESPACE_URL, 'masterweld:svarog:code:' + code))
        title = re.sub(r'\s+', ' ', raw_name).strip()
        # No invented marketing properties or model extraction from a similar name.
        description = get(description_col)
        if description == raw_name: description = None
        card = {
            'candidate_id': candidate_id, 'identity_group_id': group_id,
            'identity_status': 'conflict' if len(groups[code]) > 1 else 'single_source_candidate',
            'readiness': 'draft', 'publication_authorized': False,
            'supplier': 'svarog', 'supplier_code_raw': r['code_raw'],
            'supplier_code_display': code, 'supplier_code_match': code,
            'code_cell_type': r['code_type'], 'code_number_format': r['code_format'],
            'manufacturer_article_raw': r['article_raw'], 'manufacturer_sku_verified': None,
            'name_raw': raw_name, 'title_proposed': title, 'brand_confirmed': brand,
            'brand_proposed': candidate_brand, 'brand_basis': brand_basis,
            'category_proposed': category, 'section_raw': r['section'],
            'short_description_proposed': description if isinstance(description, str) else None,
            'description_basis': 'supplier_excel_unverified',
            'technical_raw': {c: get(c) for c in ([description_col] if description_col else [])},
            'packaging': packaging, 'price': None, 'purchase_price': None,
            'availability': 'unknown', 'stock_qty': None, 'lead_time_days': None,
            'images': [], 'documentation': [], 'documentation_status': 'search_pending',
            'source_urls': urls, 'review_reasons': warnings, 'source_row_id': row_id,
            'provenance': {'file': inventory['filename'], 'sha256': digest, 'sheet': s,
                           'row': number, 'hidden': r['hidden'], 'received_on': '2026-11-12'},
        }
        offer = {'source_row_id': row_id, 'source_price_type': price_type,
                 'source_price_value': price['value'] if price and price['type'] == 'n' else None,
                 'source_price_currency': 'RUB',
                 'currency_basis': 'workbook_context_unconfirmed' if s == 'СИЗ и химия ' else 'sheet_header',
                 'price_cell': f'{pc}{number}', 'all_price_cells_raw': r['prices'],
                 'purchase_price_confirmed': None, 'site_price_approved': None,
                 'stock': 'unknown', 'valid_from_confirmed': None, 'valid_to_confirmed': None}
        source_rows.append({'id': row_id, 'card_candidate_id': candidate_id, 'offer': offer,
                            'original_cells': cells})
        cards.append(card)
    for code, duplicates in groups.items():
        if len(duplicates) > 1:
            conflicts.append({'supplier_code': code, 'decision': 'pending', 'rows': [
                {'sheet': r['sheet'], 'row': r['row'], 'name': r['name'] or r['cells'].get('C', {}).get('value')}
                for r in duplicates]})
    summary = {'source_rows': len(source_rows), 'draft_row_cards': len(cards),
               'unique_code_groups': len(groups), 'single_source_candidates': sum(len(v) == 1 for v in groups.values()),
               'duplicate_code_groups': len(conflicts), 'rows_in_duplicate_groups': sum(len(v) for v in groups.values() if len(v) > 1),
               'published': 0, 'applied_to_shop_database': 0,
               'by_sheet': dict(Counter(r['sheet'] for r in rows))}
    return {'schema': SCHEMA, 'source_sha256': digest,
            'owner_decision': '2026-11-12: load full assortment; historical heading dates do not block intake; prices undecided',
            'generated_at': datetime.now(timezone.utc).isoformat(), 'summary': summary,
            'cards': cards, 'source_rows': source_rows, 'identity_review': conflicts}

def write_outputs(bundle, output):
    output.mkdir(parents=True, exist_ok=True)
    (output / 'Svarog_all_2008_draft_cards.json').write_text(json.dumps(bundle, ensure_ascii=False, indent=2))
    fields = ['supplier_code_display','manufacturer_article_raw','title_proposed','brand_confirmed',
              'brand_proposed','category_proposed','identity_status','readiness','price','purchase_price',
              'availability','documentation_status','source_sheet','source_row','review_reasons']
    with (output / 'Svarog_all_2008_draft_cards.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.DictWriter(f, fieldnames=fields, delimiter=';'); w.writeheader()
        for c in bundle['cards']:
            row = {k: c.get(k) for k in fields}
            row.update(source_sheet=c['provenance']['sheet'], source_row=c['provenance']['row'],
                       review_reasons=';'.join(c['review_reasons']))
            w.writerow(row)
    (output / 'intake_summary.json').write_text(json.dumps(bundle['summary'], ensure_ascii=False, indent=2))

def main():
    p=argparse.ArgumentParser();p.add_argument('--analysis',type=Path,required=True)
    p.add_argument('--original',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    a=p.parse_args();b=normalize(json.loads((a.analysis/'product_rows.json').read_text()),
        json.loads((a.analysis/'workbook_inventory.json').read_text()),a.original.read_bytes())
    write_outputs(b,a.output); print(json.dumps(b['summary'],ensure_ascii=False))

if __name__ == '__main__': main()
