"""One-shot resumable official-document discovery. No approval or database writes.

Honours the manufacturer's ten-second crawl delay; stores original HTML and
separate candidate links. A document title/model match never certifies validity.
"""
from pathlib import Path
from html.parser import HTMLParser
from datetime import datetime, timezone
from urllib.parse import urljoin, urlparse
from urllib.request import Request, build_opener, HTTPRedirectHandler
from urllib.robotparser import RobotFileParser
import argparse, hashlib, json, re, time, xml.etree.ElementTree as ET

BASE = 'https://svarog-rf.ru'
AGENT = 'MasterweldCatalogResearch/1.0 (+https://masterweld.ru)'

class Page(HTMLParser):
    def __init__(self):
        super().__init__(); self.links=[]; self.anchor=None; self.h1=False; self.title=[]
    def handle_starttag(self, tag, attrs):
        a=dict(attrs)
        if tag == 'h1': self.h1=True
        if tag == 'a': self.anchor={'url':a.get('href',''),'text':''}
    def handle_endtag(self,tag):
        if tag == 'h1': self.h1=False
        if tag == 'a' and self.anchor is not None:
            self.links.append(self.anchor); self.anchor=None
    def handle_data(self,data):
        if self.h1: self.title.append(data)
        if self.anchor is not None: self.anchor['text']+=data

class SafeRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urlparse(newurl).scheme != 'https' or urlparse(newurl).netloc != 'svarog-rf.ru':
            raise ValueError('REDIRECT_OUTSIDE_OFFICIAL_ORIGIN')
        return super().redirect_request(req, fp, code, msg, headers, newurl)

def fetch(url):
    if urlparse(url).scheme != 'https' or urlparse(url).netloc != 'svarog-rf.ru':
        raise ValueError('UNTRUSTED_ORIGIN')
    with build_opener(SafeRedirect()).open(Request(url,headers={'User-Agent':AGENT}),timeout=25) as r:
        data=r.read(5_000_001)
        if len(data)>5_000_000: raise ValueError('HTML_TOO_LARGE')
        return data,r.url,r.headers.get('Content-Type')

def model_codes(title):
    return {v.upper() for v in re.findall(r'(?<![A-Za-z0-9])([A-Za-z]\d[A-Za-z0-9]{1,10})(?![A-Za-z0-9])',title)}

def main():
    p=argparse.ArgumentParser();p.add_argument('--cards',type=Path,required=True)
    p.add_argument('--source-dir',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    p.add_argument('--limit',type=int,default=0); a=p.parse_args()
    a.output.mkdir(parents=True,exist_ok=True); rawdir=a.output/'raw';rawdir.mkdir(exist_ok=True)
    cards=json.loads(a.cards.read_text())['cards']
    all_codes=set().union(*(model_codes(c['title_proposed']) for c in cards))
    urls=[e.text for e in ET.parse(a.source_dir/'sitemap.xml').iter() if e.tag.endswith('}loc') and '/docs/' in (e.text or '')]
    index=Page();index.feed((a.source_dir/'index.html').read_text())
    titles={urljoin(BASE,l['url']):l['text'].strip() for l in index.links if '/docs/' in l['url'] and l['text'].strip()}
    def priority(url):
        codes=model_codes(url.rsplit('/',1)[-1])
        if all_codes & codes: return 0
        if any(t in url for t in ['sertifikat','deklar','pasport','gorel','shchit','maska','provolog','provolok','elektrod']): return 1
        return 2
    urls=sorted(set(urls),key=lambda u:(priority(u),u))
    report=a.output/'document_discovery.json'
    state=json.loads(report.read_text()) if report.exists() else {'schema':'svarog-document-discovery-v1','documents':[],'errors':[]}
    completed={d['page_url'] for d in state['documents']} | {d['page_url'] for d in state['errors']}
    robot=RobotFileParser();robot.set_url(BASE+'/robots.txt')
    rb,_,_=fetch(BASE+'/robots.txt');robot.parse(rb.decode().splitlines())
    (rawdir/'robots.txt').write_bytes(rb)
    delay=max(10,robot.crawl_delay(AGENT) or 10); last=time.monotonic(); done=0
    state.update(discovered_page_urls=urls,total_discovered=len(urls),crawl_delay_seconds=delay,
                 application_status='candidates_only_not_approved_or_published')
    for url in urls:
        if url in completed: continue
        if a.limit and done>=a.limit: break
        if not robot.can_fetch(AGENT,url):
            state['errors'].append({'page_url':url,'reason':'ROBOTS_DISALLOWED'});continue
        time.sleep(max(0,delay-(time.monotonic()-last)));last=time.monotonic()
        try:
            data,final,mime=fetch(url);sha=hashlib.sha256(data).hexdigest()
            (rawdir/(sha+'.html')).write_bytes(data)
            page=Page();page.feed(data.decode('utf-8',errors='strict'))
            title=' '.join(' '.join(page.title).split()) or titles.get(url)
            if not title: raise ValueError('NO_DOCUMENT_TITLE')
            files=[]
            for link in page.links:
                target=urljoin(final,link['url'])
                if urlparse(target).netloc=='svarog-rf.ru' and urlparse(target).scheme=='https' and re.search(r'\.(pdf|docx?|xlsx?|zip)(?:[?#]|$)',target,re.I):
                    files.append({'url':target,'label':' '.join(link['text'].split()),'content_read':False})
            files=list({d['url']:d for d in files}.values())
            codes=model_codes(title)
            candidates=[{'candidate_id':c['candidate_id'],'supplier_code':c['supplier_code_display'],
                         'basis':'exact_model_token_in_official_document_title',
                         'model_tokens':sorted(model_codes(c['title_proposed']) & codes),
                         'variant_scope':'unconfirmed','approved':False}
                        for c in cards if model_codes(c['title_proposed']) & codes]
            state['documents'].append({'page_url':url,'final_url':final,'title':title,'html_sha256':sha,
                'fetched_at':datetime.now(timezone.utc).isoformat(),'files':files,'product_candidates':candidates,
                'certificate_validity':'not_checked','publication_allowed':False})
        except Exception as e:
            state['errors'].append({'page_url':url,'reason':str(e),'at':datetime.now(timezone.utc).isoformat()})
        done+=1
        state['pending_pages']=len(urls)-len(state['documents'])-len(state['errors'])
        report.write_text(json.dumps(state,ensure_ascii=False,indent=2))
        print(json.dumps({'processed':len(state['documents'])+len(state['errors']),
                          'found':len(state['documents']),'errors':len(state['errors']),
                          'pending':state['pending_pages']},ensure_ascii=False),flush=True)
    report.write_text(json.dumps(state,ensure_ascii=False,indent=2))

if __name__=='__main__':main()
