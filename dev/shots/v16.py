import os,subprocess,time,json,sys
ROOT=os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA=ROOT+"/dev/tests/data"; OUT=os.environ.get("SHOTS","/tmp"); SRC=os.environ.get("LIVE",DATA+'/live14.json')
from playwright.sync_api import sync_playwright
from PIL import Image
srv=subprocess.Popen(["python3","-m","http.server","8788"],cwd=ROOT,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(1)
live=open(SRC).read(); errs=[]
try:
  with sync_playwright() as p:
    b=p.chromium.launch(executable_path="/usr/bin/google-chrome",args=["--no-sandbox"])
    def mk(vp,dsf=1,lang='pl',**kw):
        pg=b.new_page(viewport=vp,device_scale_factor=dsf,**kw); pg.on("pageerror",lambda e:errs.append(str(e)))
        pg.route("https://raw.githubusercontent.com/**",lambda r:r.fulfill(status=200,content_type="text/plain",body=open(DATA+'/cases_demo.json').read() if 'cases.json' in r.request.url else live,headers={"access-control-allow-origin":"*"}))
        pg.add_init_script("try{localStorage.setItem('pulse-lang','%s');window.__i18nMiss=new Set()}catch(e){}"%lang); pg.goto("http://localhost:8788/index.html"); pg.wait_for_timeout(3200); pg.evaluate("location.hash='#/telemetria'"); pg.wait_for_timeout(900); return pg
    pm=mk({"width":390,"height":780},2,has_touch=True,is_mobile=True)
    print('ranges:',pm.locator('#tl-all .ts-rg button').all_inner_texts(),'on:',pm.locator('#tl-all .ts-rg button.on').inner_text(),'| overflow',pm.evaluate("document.documentElement.scrollWidth-innerWidth"))
    pm.evaluate("window.scrollTo(0,document.getElementById('tl-all').getBoundingClientRect().top+scrollY-150)"); pm.wait_for_timeout(500)
    print('banner mini:',pm.evaluate("document.getElementById('sbar').classList.contains('mini')"),'height',pm.evaluate("document.getElementById('sbar').offsetHeight"))
    pm.screenshot(path=OUT+"/V16_a.png")
    pm.locator('#tl-all .ts-rg button').last.click(); pm.wait_for_timeout(300); pm.locator('#tl-all .ts-help summary').click(); pm.wait_for_timeout(200)
    pm.evaluate("window.scrollTo(0,0)"); pm.wait_for_timeout(300); pm.locator('#tl-ex summary').click(); pm.wait_for_timeout(500); pm.evaluate("window.scrollTo(0,document.getElementById('tl-ex').getBoundingClientRect().top+scrollY-80)"); pm.wait_for_timeout(400); pm.screenshot(path=OUT+"/V16_e.png"); pm.locator('#tl-ex').screenshot(path=OUT+"/V16_ex.png")
    pm.evaluate("window.scrollTo(0,document.getElementById('tl-all').getBoundingClientRect().top+scrollY-110)"); pm.wait_for_timeout(400); pm.screenshot(path=OUT+"/V16_b.png")
    pm.evaluate("window.scrollTo(0,document.getElementById('tl-all').getBoundingClientRect().bottom+scrollY-500)"); pm.wait_for_timeout(400); pm.screenshot(path=OUT+"/V16_c.png")
    bx=pm.locator('#tl-all .ts-svg').bounding_box()
    pm.evaluate("window.scrollTo(0,0)"); pm.wait_for_timeout(400); print('banner back to full:',not pm.evaluate("document.getElementById('sbar').classList.contains('mini')"))
    pd=mk({"width":1280,"height":900}); print('desktop on:',pd.locator('#tl-all .ts-rg button.on').inner_text()); pd.locator('#tl-all .ts-rg button').last.click(); pd.wait_for_timeout(300)
    bx=pd.locator('#tl-all .ts-svg').bounding_box(); pd.mouse.click(bx['x']+bx['width']*0.5,bx['y']+90); pd.wait_for_timeout(300); print('click on grouped point:',pd.locator('#dlg-t').inner_text()); pd.evaluate("document.getElementById('dlg').close()"); pd.locator('#tl-all').screenshot(path=OUT+"/V16_d.png")
    pe=mk({"width":390,"height":780},2,lang='en',has_touch=True,is_mobile=True); pe.locator('#tl-all .ts-rg button').last.click(); pe.locator('#tl-all .ts-help summary').click(); pe.evaluate("window.scrollTo(0,0)"); pe.wait_for_timeout(300); pe.locator('#tl-ex summary').click(); pe.wait_for_timeout(300); print('MISS',[x[:70] for x in pe.evaluate("Array.from(window.__i18nMiss)") if 'Wiśniewski' not in x])
    b.close()
finally: srv.kill()
print('ERRORS',errs)
ims=[Image.open(OUT+'/V16_%s.png'%k).resize((390,780)) for k in 'abc']; d=Image.open(OUT+'/V16_d.png'); d=d.resize((780,d.size[1]*780//d.size[0]))
o=Image.new('RGB',(1200,780+d.size[1]+10),'white')
for k,i in enumerate(ims): o.paste(i,(k*400,0))
o.paste(d,(0,790)); o.save(OUT+'/V16.png'); print(o.size)
