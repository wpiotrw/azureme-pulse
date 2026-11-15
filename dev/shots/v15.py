import os,subprocess,time,json
ROOT=os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA=ROOT+"/dev/tests/data"; OUT=os.environ.get("SHOTS","/tmp")
from playwright.sync_api import sync_playwright
from PIL import Image
srv=subprocess.Popen(["python3","-m","http.server","8788"],cwd=ROOT,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(1)
d=json.loads(open(DATA+'/live14.json').read()); S=d['samples']; errs=[]
S[40]['r']['teams'][0]=0
for i in (80,81,82): S[i]['r']['exo'][0]=0
for i in (80,81): S[i]['r']['graph'][0]=0
for i in range(100,106):
    for k in S[i]['r']: S[i]['r'][k][1]=int(S[i]['r'][k][1]*2.6)
bad=json.dumps(d)
try:
  with sync_playwright() as p:
    b=p.chromium.launch(executable_path="/usr/bin/google-chrome",args=["--no-sandbox"])
    def mk(vp,dsf=1,lang='pl',theme='dark',**kw):
        pg=b.new_page(viewport=vp,device_scale_factor=dsf,**kw); pg.on("pageerror",lambda e:errs.append(str(e)))
        pg.route("https://raw.githubusercontent.com/**",lambda r:r.fulfill(status=200,content_type="text/plain",body=open(DATA+'/cases_demo.json').read() if 'cases.json' in r.request.url else bad,headers={"access-control-allow-origin":"*"}))
        pg.add_init_script("try{localStorage.setItem('pulse-lang','%s');localStorage.setItem('pulse-theme','%s');window.__i18nMiss=new Set()}catch(e){}"%(lang,theme)); pg.goto("http://localhost:8788/index.html"); pg.wait_for_timeout(3200); pg.evaluate("location.hash='#/telemetria'"); pg.wait_for_timeout(900); return pg
    pd=mk({"width":1280,"height":900}); print('menu:',pd.locator('#mi-telemetria').inner_text().strip(),'| charts',pd.locator('#telemetria .ts-svg').count(),'| heat cells',pd.locator('#tl-hm rect').count(),'| marks',pd.locator('#tl-all .ts-mk').count())
    pd.screenshot(path=OUT+"/V15_d.png",full_page=True)
    pd.locator('#tl-hm rect[data-hc="80"]').first.click(); pd.wait_for_timeout(300); print('heat click:',pd.locator('#dlg-t').inner_text()); pd.evaluate("document.getElementById('dlg').close()")
    pd.locator('.hm-r').nth(2).click(); pd.wait_for_timeout(300); print('row click:',pd.locator('#dlg-t').inner_text()); pd.evaluate("document.getElementById('dlg').close()")
    pl=mk({"width":1280,"height":900},theme='light'); pl.screenshot(path=OUT+"/V15_l.png")
    pm=mk({"width":390,"height":780},2,has_touch=True,is_mobile=True); print('overflow',pm.evaluate("document.documentElement.scrollWidth-innerWidth")); pm.evaluate("document.getElementById('sbar-x').click()"); pm.wait_for_timeout(300); pm.screenshot(path=OUT+"/V15_m.png",full_page=True)
    pe=mk({"width":1280,"height":900},lang='en'); pe.wait_for_timeout(300); print('MISS',[x[:70] for x in pe.evaluate("Array.from(window.__i18nMiss)") if 'Wiśniewski' not in x])
    b.close()
finally: srv.kill()
print('ERRORS',errs)
a=Image.open(OUT+'/V15_d.png'); print(a.size); a=a.crop((290,60,1280,min(a.size[1],2700))); a=a.resize((660,a.size[1]*660//990))
m=Image.open(OUT+'/V15_m.png'); m=m.crop((0,120,780,min(m.size[1],5400))); m=m.resize((300,m.size[1]*300//780))
l=Image.open(OUT+'/V15_l.png').crop((290,60,1280,900)).resize((400,339))
o=Image.new('RGB',(660+300+400+20,max(a.size[1],m.size[1])),'white'); o.paste(a,(0,0)); o.paste(m,(670,0)); o.paste(l,(980,0)); o.save(OUT+'/V15.png'); print(o.size)
