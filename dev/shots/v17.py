import os,subprocess,time,json,copy
ROOT=os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA=ROOT+"/dev/tests/data"; OUT=os.environ.get("SHOTS","/tmp"); SRC=os.environ.get("LIVE",DATA+'/live14.json')
from playwright.sync_api import sync_playwright
from PIL import Image
srv=subprocess.Popen(["python3","-m","http.server","8788"],cwd=ROOT,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(1)
base=json.load(open(SRC)); errs=[]
# A: as is, but every open issue turned into an advisory and two services left degraded without an issue of their own
A=copy.deepcopy(base)
for t in A['health']:
    for i in t['issues']:
        if not i.get('resolved'): i['classification']='advisory'
    for sv in t['services']:
        if sv['name'] in('Exchange Online','Microsoft Teams'): sv['status']='serviceDegradation'
# B: one real incident on Teams
B=copy.deepcopy(A); n=0
for t in B['health']:
    for i in t['issues']:
        if not i.get('resolved') and n==0: i['classification']='incident'; i['service']='Microsoft Teams'; i['updateAt']=i['modified']=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime(time.time()-1800)); n=1
# C: interruption without any issue + public page reports a problem
C=copy.deepcopy(A)
for t in C['health']:
    for sv in t['services']:
        if sv['name']=='Exchange Online': sv['status']='serviceInterruption'
C['public']['m365']['status']='Degraded'
try:
  with sync_playwright() as p:
    b=p.chromium.launch(executable_path="/usr/bin/google-chrome",args=["--no-sandbox"])
    def run(tag,d,lang='pl',vp={"width":1280,"height":900}):
        pg=b.new_page(viewport=vp); pg.on("pageerror",lambda e:errs.append(str(e))); body=json.dumps(d)
        pg.route("https://raw.githubusercontent.com/**",lambda r:r.fulfill(status=200,content_type="text/plain",body=open(DATA+'/cases_demo.json').read() if 'cases.json' in r.request.url else body,headers={"access-control-allow-origin":"*"}))
        pg.add_init_script("try{localStorage.setItem('pulse-lang','%s');window.__i18nMiss=new Set()}catch(e){}"%lang); pg.goto("http://localhost:8788/index.html"); pg.wait_for_timeout(3200)
        print(tag,'| banner:',pg.locator('#sbar .sm').inner_text().replace('\n',' / '),'| sp:',(pg.locator('#sbar .sp').inner_text().replace('\n',' / ') if pg.locator('#sbar .sp').count() else '-'),'| headline:',pg.locator('#headline').inner_text().replace('\n',' '),'| bad:',pg.locator('#bd-bad-n').inner_text())
        pg.screenshot(path=OUT+"/V17_%s.png"%tag)
        if lang=='en': pg.evaluate("location.hash='#/uslugi'"); pg.wait_for_timeout(500); print('MISS',[x[:70] for x in pg.evaluate("Array.from(window.__i18nMiss)") if 'Wiśniewski' not in x])
        return pg
    AZ={"fetched":"2026-11-18T12:16:00Z","ok":True,"subs":1,"tenants":[{"label":"Tenant 1 (8c6e…)","ok":True,"subs":1,"error":""},{"label":"Tenant 2 (833f…)","ok":True,"subs":0,"error":""}],"items":[{"id":"7PRY-G18","type":"ServiceIssue","level":"Warning","status":"Active","active":True,"title":"Active – Microsoft Defender for Cloud – delays in security recommendations","summary":"Customers using Microsoft Defender for Cloud may experience delays.","services":["Microsoft Defender for Cloud"],"regions":["Global"],"start":"2026-11-17T09:00:00Z","end":None,"updated":time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime(time.time()-3600)),"subs":1,"tenants":["Tenant 1 (8c6e…)"]}]}
    D=copy.deepcopy(A); D['azureHealth']=AZ
    E=copy.deepcopy(A); E['azureHealth']={"fetched":"x","ok":True,"subs":0,"tenants":[],"items":[]}
    F=copy.deepcopy(B); F['azureHealth']=AZ
    run('A',A); run('B',B); run('C',C); run('Aen',A,'en'); run('Cen',C,'en')
    pg=run('D',D); print('D azure cards:',pg.locator('[data-azh] .azc').count(),'|',pg.locator('[data-azh] .azc').first.inner_text().replace('\n',' / ')[:230]); pg.locator('#brief').scroll_into_view_if_needed(); pg.wait_for_timeout(300); pg.screenshot(path=OUT+"/V17_D2.png")
    pg=run('E',E); print('E note:',pg.locator('[data-azh] .azn').first.inner_text()[:90])
    run('F',F); pg=run('Den',D,'en'); pg.evaluate("location.hash='#/incydenty'"); pg.wait_for_timeout(500); print('MISS D',[x[:70] for x in pg.evaluate("Array.from(window.__i18nMiss)") if 'Wiśniewski' not in x and 'Defender' not in x])
    pm=run('Dm',D,vp={"width":390,"height":780}); print('overflow D',pm.evaluate("document.documentElement.scrollWidth-innerWidth"))
    pm=run('Am',A,vp={"width":390,"height":780}); print('overflow',pm.evaluate("document.documentElement.scrollWidth-innerWidth"))
    pu=run('Au',A); pu.evaluate("location.hash='#/uslugi'"); pu.wait_for_timeout(600); print('service rows:',[x.replace('\n',' | ')[:120] for x in pu.locator('#rows-real .sr').all_inner_texts() if 'Exchange' in x or 'Teams' in x][:2])
    b.close()
finally: srv.kill()
print('ERRORS',errs)
ims=[Image.open(OUT+'/V17_%s.png'%k).crop((290,0,1280,330)).resize((792,264)) for k in ('B','D','F')]+[Image.open(OUT+'/V17_D2.png').crop((290,0,1280,900)).resize((792,720))]
o=Image.new('RGB',(792,264*3+30+720),'white')
for k,i in enumerate(ims): o.paste(i,(0,k*274))
o.save(OUT+'/V17.png')
