import os
ROOT=os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA=ROOT+"/dev/tests/data"
import subprocess,time
from playwright.sync_api import sync_playwright
srv=subprocess.Popen(["python3","-m","http.server","8788"],cwd=ROOT,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(1)
live=open(DATA+'/live14.json').read(); errs=[]
try:
  with sync_playwright() as p:
    b=p.chromium.launch(executable_path="/usr/bin/google-chrome",args=["--no-sandbox"]); pg=b.new_page(viewport={"width":1280,"height":900}); pg.on("pageerror",lambda e:errs.append(str(e)))
    pg.route("https://raw.githubusercontent.com/**",lambda r:r.fulfill(status=200,content_type="text/plain",body=open(DATA+'/cases_demo.json').read() if 'cases.json' in r.request.url else live,headers={"access-control-allow-origin":"*"}))
    pg.add_init_script("try{localStorage.setItem('pulse-lang','en');window.__i18nMiss=new Set()}catch(e){}"); pg.goto("http://localhost:8788/index.html"); pg.wait_for_timeout(3000)
    for v in ["incydenty","uslugi","microsoft","model","pomiary","regiony","sygnaly","slownik"]:
        pg.evaluate("location.hash='#/%s'"%v); pg.wait_for_timeout(600)
    pg.evaluate("document.getElementById('sim-btn')&&document.getElementById('sim-btn').click()"); pg.wait_for_timeout(800)
    print('MISS',[x[:70] for x in pg.evaluate("Array.from(window.__i18nMiss)") if 'Wiśniewski' not in x][:12]); b.close()
finally: srv.kill()
print('ERRORS',errs)
