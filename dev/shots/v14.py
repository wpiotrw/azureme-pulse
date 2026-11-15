import os,subprocess,time,json
ROOT=os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA=ROOT+"/dev/tests/data"; OUT=os.environ.get("SHOTS","/tmp")
from playwright.sync_api import sync_playwright
from PIL import Image
srv=subprocess.Popen(["python3","-m","http.server","8788"],cwd=ROOT,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(1)
live=open(DATA+'/live14.json').read(); errs=[]
d=json.loads(live); S=d['samples']
S[40]['r']['teams'][0]=0
for i in (80,81,82): S[i]['r']['exo'][0]=0; S[i]['r']['exo'][2]=0
for i in (80,81): S[i]['r']['graph'][0]=0
bad=json.dumps(d)
try:
  with sync_playwright() as p:
    b=p.chromium.launch(executable_path="/usr/bin/google-chrome",args=["--no-sandbox"])
    def mk(body,vp,dsf=1,lang='pl',theme='dark',**kw):
        pg=b.new_page(viewport=vp,device_scale_factor=dsf,**kw); pg.on("pageerror",lambda e:errs.append(str(e)))
        pg.route("https://raw.githubusercontent.com/**",lambda r:r.fulfill(status=200,content_type="text/plain",body=open(DATA+'/cases_demo.json').read() if 'cases.json' in r.request.url else body,headers={"access-control-allow-origin":"*"}))
        pg.add_init_script("try{localStorage.setItem('pulse-lang','%s');localStorage.setItem('pulse-theme','%s');window.__i18nMiss=new Set()}catch(e){}"%(lang,theme)); pg.goto("http://localhost:8788/index.html#/pomiary"); pg.wait_for_timeout(3400); return pg
    pd=mk(bad,{"width":1280,"height":900})
    box=pd.locator('#pb-top .ts-svg').bounding_box(); pd.mouse.move(box['x']+box['width']*0.6,box['y']+80); pd.wait_for_timeout(200)
    print('tip:',pd.locator('#pb-top .ts-tip').inner_text().replace('\n',' | ')); pd.locator('#pb-top').screenshot(path=OUT+"/V14_d.png")
    box=pd.locator('#pb-top .ts-svg').bounding_box(); pd.mouse.click(box['x']+box['width']*0.6,box['y']+80); pd.wait_for_timeout(300); print('click dialog:',pd.evaluate("document.getElementById('dlg').open"),pd.locator('#dlg-t').inner_text()); pd.evaluate("document.getElementById('dlg').close()")
    pd.locator('#live-rows .lr').nth(2).click(); pd.wait_for_timeout(500); print('probe dlg chart:',pd.locator('#ts-probe .ts-svg').count()); pd.locator('#dlg').screenshot(path=OUT+"/V14_p.png"); pd.evaluate("document.getElementById('dlg').close()")
    pd.evaluate("location.hash='#/model'"); pd.wait_for_timeout(700); print('radar chart:',pd.locator('#ts-radar .ts-svg').count()); pd.locator('#ts-radar').screenshot(path=OUT+"/V14_r.png")
    pl=mk(bad,{"width":1280,"height":900},theme='light'); pl.locator('#pb-top .pb-box').screenshot(path=OUT+"/V14_l.png")
    pm=mk(bad,{"width":390,"height":780},2,has_touch=True,is_mobile=True); print('overflow',pm.evaluate("document.documentElement.scrollWidth-innerWidth")); pm.locator('#pb-top .pb-box').screenshot(path=OUT+"/V14_m.png")
    pe=mk(bad,{"width":1280,"height":900},lang='en'); bx=pe.locator('#pb-top .ts-svg').bounding_box(); pe.mouse.move(bx['x']+bx['width']*0.6,bx['y']+80); pe.wait_for_timeout(200); print('EN tip:',pe.locator('#pb-top .ts-tip').inner_text().replace('\n',' | ')); pe.locator('#live-rows .lr').nth(2).click(); pe.wait_for_timeout(400); pe.evaluate("document.getElementById('dlg').close()"); pe.evaluate("location.hash='#/model'"); pe.wait_for_timeout(600); pe.evaluate("location.hash='#/home'"); pe.wait_for_timeout(500)
    print('MISS',[x[:70] for x in pe.evaluate("Array.from(window.__i18nMiss)") if 'Wiśniewski' not in x])
    b.close()
finally: srv.kill()
print('ERRORS',errs)
a=Image.open(OUT+'/V14_d.png'); l=Image.open(OUT+'/V14_l.png'); m=Image.open(OUT+'/V14_m.png'); m=m.resize((m.size[0]//2,m.size[1]//2)); pp=Image.open(OUT+'/V14_p.png'); r=Image.open(OUT+'/V14_r.png')
sc=lambda im,w: im.resize((w,im.size[1]*w//im.size[0]))
a=sc(a,800); l=sc(l,800); pp=sc(pp,560); r=sc(r,800)
o=Image.new('RGB',(800+10+max(m.size[0],560),max(a.size[1]+l.size[1]+r.size[1]+20,m.size[1]+pp.size[1]+10)),'white'); o.paste(a,(0,0)); o.paste(l,(0,a.size[1]+10)); o.paste(r,(0,a.size[1]+l.size[1]+20)); o.paste(m,(810,0)); o.paste(pp,(810,m.size[1]+10)); o.save(OUT+'/V14.png'); print(o.size)
