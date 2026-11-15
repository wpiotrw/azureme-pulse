import os
ROOT=os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA=ROOT+"/dev/tests/data"
import subprocess,time,sys
from playwright.sync_api import sync_playwright
from PIL import Image
srv=subprocess.Popen(["python3","-m","http.server","8788"],cwd=ROOT,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(1)
live=open(DATA+'/live14.json').read(); errs=[]
V=["incydenty","uslugi","microsoft","model","pomiary","regiony","sygnaly","slownik"]
try:
  with sync_playwright() as p:
    b=p.chromium.launch(executable_path="/usr/bin/google-chrome",args=["--no-sandbox"])
    def mk(init,vp,dsf=1,**kw):
        pg=b.new_page(viewport=vp,device_scale_factor=dsf,**kw); pg.on("pageerror",lambda e:errs.append(str(e)))
        pg.route("https://raw.githubusercontent.com/**",lambda r:r.fulfill(status=200,content_type="text/plain",body=open(DATA+'/cases_demo.json').read() if 'cases.json' in r.request.url else live,headers={"access-control-allow-origin":"*"})); pg.add_init_script(init); return pg
    th=sys.argv[1] if len(sys.argv)>1 else "dark"
    init="try{localStorage.setItem('pulse-theme','%s')}catch(e){}"%th
    pd=mk(init,{"width":1280,"height":900}); pm=mk(init,{"width":390,"height":780},2,has_touch=True,is_mobile=True)
    for pg,tag in ((pd,"d"),(pm,"m")):
        pg.goto("http://localhost:8788/index.html"); pg.wait_for_timeout(3200)
        for v in V:
            pg.evaluate("location.hash='#/%s'"%v); pg.wait_for_timeout(800)
            pg.screenshot(path="V3_%s_%s.png"%(tag,v),full_page=True)
            if tag=="m": print(v,'overflow',pg.evaluate("document.documentElement.scrollWidth-innerWidth"))
    b.close()
finally: srv.kill()
print('ERRORS',errs)
for v in V:
    im=Image.open("V3_d_%s.png"%v); w,h=im.size; im=im.crop((290,80,1280,min(h,2300))); im.save("V3_d_%s_c.png"%v); print(v,(w,h))
