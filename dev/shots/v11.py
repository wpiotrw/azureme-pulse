import os
ROOT=os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA=ROOT+"/dev/tests/data"
import subprocess,time
from playwright.sync_api import sync_playwright
from PIL import Image
srv=subprocess.Popen(["python3","-m","http.server","8788"],cwd=ROOT,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(1)
live=open(DATA+'/live14.json').read(); errs=[]
try:
  with sync_playwright() as p:
    b=p.chromium.launch(executable_path="/usr/bin/google-chrome",args=["--no-sandbox"])
    def mk(vp,dsf=1,**kw):
        pg=b.new_page(viewport=vp,device_scale_factor=dsf,**kw); pg.on("pageerror",lambda e:errs.append(str(e)))
        pg.route("https://raw.githubusercontent.com/**",lambda r:r.fulfill(status=200,content_type="text/plain",body=open(DATA+'/cases_demo.json').read() if 'cases.json' in r.request.url else live,headers={"access-control-allow-origin":"*"})); pg.goto("http://localhost:8788/index.html"); pg.wait_for_timeout(3000); return pg
    pm=mk({"width":390,"height":780},2,has_touch=True,is_mobile=True)
    st=lambda: (pm.evaluate("location.hash"),pm.locator('#back').is_visible(),pm.locator('#back').inner_text().replace('\n',' ') if pm.locator('#back').is_visible() else '')
    print('home',st())
    pm.locator('#tiles .row').nth(1).click(); pm.wait_for_timeout(500); print('tile->',st()); pm.screenshot(path="V11_m.png")
    pm.evaluate("location.hash='#/incydenty'"); pm.wait_for_timeout(400); print('then',st())
    pm.click('#back'); pm.wait_for_timeout(400); print('back1',st())
    pm.click('#back'); pm.wait_for_timeout(400); print('back2',st())
    pm.evaluate("location.hash='#/slownik'"); pm.wait_for_timeout(300); pm.go_back(); pm.wait_for_timeout(400); print('browser back',st())
    pd=mk({"width":1280,"height":900}); pd.evaluate("location.hash='#/pomiary'"); pd.wait_for_timeout(500); pd.screenshot(path="V11_d.png")
    b.close()
finally: srv.kill()
print('ERRORS',errs)
m=Image.open('V11_m.png').resize((390,780)); d=Image.open('V11_d.png').crop((290,0,1280,520)).resize((743,390))
o=Image.new('RGB',(400+743,780),'white'); o.paste(m,(0,0)); o.paste(d,(400,0)); o.save('V11.png')
