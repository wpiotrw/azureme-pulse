# Zgłoszenia Microsoft na „Przeglądzie”: karty w rozwiniętych sekcjach, brak powtórzeń, kafelek paska.
import os,subprocess,time,sys
ROOT=os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA=ROOT+"/dev/tests/data"; OUT=os.environ.get("SHOTS","/tmp"); SRC=os.environ.get("LIVE",DATA+"/live18.json")
from playwright.sync_api import sync_playwright
from PIL import Image
srv=subprocess.Popen(["python3","-m","http.server","8788"],cwd=ROOT,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(1)
live=open(SRC).read(); errs=[]
try:
  with sync_playwright() as p:
    b=p.chromium.launch(executable_path="/usr/bin/google-chrome",args=["--no-sandbox"])
    def mk(vp,dsf=1,lang='pl',theme='dark',**kw):
        pg=b.new_page(viewport=vp,device_scale_factor=dsf,**kw); pg.on("pageerror",lambda e:errs.append(str(e)))
        pg.route("https://raw.githubusercontent.com/**",lambda r:r.fulfill(status=200,content_type="text/plain",body=open(DATA+'/cases_demo.json').read() if 'cases.json' in r.request.url else live,headers={"access-control-allow-origin":"*"}))
        pg.add_init_script("try{localStorage.setItem('pulse-lang','%s');localStorage.setItem('pulse-theme','%s');window.__i18nMiss=new Set()}catch(e){}"%(lang,theme)); pg.goto("http://localhost:8788/index.html"); pg.wait_for_timeout(3200)
        pg.evaluate("document.querySelectorAll('#brief details.bp').forEach(function(d){d.open=true})"); pg.wait_for_timeout(300)
        return pg
    def info(pg,tag):
        r=pg.evaluate("""(function(){var q=function(s){return Array.prototype.map.call(document.querySelectorAll(s),function(x){return x.textContent.trim().replace(/\\s+/g,' ')})};
          var ids=function(k){return q('#brief details[data-k="'+k+'"] .ic2 .id')};var a=ids('p-inc'),u=ids('p-upd');
          return {inc:a,upd:u,dup:a.filter(function(x){return u.indexOf(x)>=0}),tile:q('#sbar .sm')[0],h3:q('#brief details[data-k="p-upd"] h3')[0],nw:q('#brief .nw'),over:document.documentElement.scrollWidth-innerWidth,theme:document.documentElement.getAttribute('data-theme'),miss:Array.from(window.__i18nMiss||[])}})()""")
        print(tag,r)
    def shot(pg,name,full=True):
        pg.evaluate("window.scrollTo(0,document.getElementById('brief').getBoundingClientRect().top+scrollY-170)"); pg.wait_for_timeout(500); pg.screenshot(path=OUT+"/"+name)
    pm=mk({"width":390,"height":844},2,has_touch=True,is_mobile=True); info(pm,'phone dark'); shot(pm,'V18_a.png')
    pm.evaluate("window.scrollBy(0,620)"); pm.wait_for_timeout(400); pm.screenshot(path=OUT+"/V18_b.png")
    pm.evaluate("window.scrollTo(0,0)"); pm.wait_for_timeout(500); pm.screenshot(path=OUT+"/V18_top.png")
    pm.locator('#brief details[data-k="p-inc"] .ic2 summary').first.click(); pm.wait_for_timeout(300); shot(pm,'V18_c.png')
    pl=mk({"width":390,"height":844},2,theme='light',has_touch=True,is_mobile=True); info(pl,'phone light'); shot(pl,'V18_d.png')
    pd=mk({"width":1280,"height":900}); info(pd,'desktop'); shot(pd,'V18_e.png')
    pe=mk({"width":390,"height":844},2,lang='en',has_touch=True,is_mobile=True); info(pe,'phone en'); shot(pe,'V18_f.png')
    b.close()
  ims=[Image.open(OUT+"/V18_%s.png"%k) for k in 'abcd']; w=sum(i.size[0]//2 for i in ims)+30; o=Image.new('RGB',(w,844),'white'); x=0
  for i in ims: i=i.resize((i.size[0]//2,i.size[1]//2)); o.paste(i,(x,0)); x+=i.size[0]+10
  o.save(OUT+"/V18_phone.png")
finally: srv.kill()
print('ERRORS',errs)
