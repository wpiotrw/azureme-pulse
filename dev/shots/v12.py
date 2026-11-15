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
    def mk(vp,dsf=1,theme='dark',**kw):
        pg=b.new_page(viewport=vp,device_scale_factor=dsf,**kw); pg.on("pageerror",lambda e:errs.append(str(e)))
        pg.route("https://raw.githubusercontent.com/**",lambda r:r.fulfill(status=200,content_type="text/plain",body=open(DATA+'/cases_demo.json').read() if 'cases.json' in r.request.url else live,headers={"access-control-allow-origin":"*"})); pg.add_init_script("try{localStorage.setItem('pulse-theme','%s')}catch(e){}"%theme); pg.goto("http://localhost:8788/index.html"); pg.wait_for_timeout(3000); return pg
    pm=mk({"width":390,"height":780},2,has_touch=True,is_mobile=True)
    print('home visible',pm.locator('#back').is_visible()); pm.locator('#tiles .row').nth(1).click(); pm.wait_for_timeout(500); pm.evaluate("window.scrollTo(0,1400)"); pm.wait_for_timeout(400); pm.screenshot(path="V12_m.png")
    print('in viewport after scroll',pm.evaluate("(function(){var r=document.getElementById('back').getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&r.width>0})()"),'overflow',pm.evaluate("document.documentElement.scrollWidth-innerWidth"))
    pm.click('#back'); pm.wait_for_timeout(400); print('after click',pm.evaluate("location.hash"))
    for th in ('dark','light'):
        pd=mk({"width":1280,"height":900},theme=th); pd.evaluate("location.hash='#/pomiary'"); pd.wait_for_timeout(500); pd.screenshot(path="V12_%s0.png"%th); pd.evaluate("window.scrollTo(0,900)"); pd.wait_for_timeout(400); pd.screenshot(path="V12_%s.png"%th)
        print(th,'desktop in viewport after scroll',pd.evaluate("(function(){var r=document.getElementById('back').getBoundingClientRect();return [Math.round(r.top),Math.round(document.getElementById('sbar').getBoundingClientRect().bottom)]})()"))
    b.close()
finally: srv.kill()
print('ERRORS',errs)
m=Image.open('V12_m.png').resize((390,780)); d0=Image.open('V12_dark0.png').crop((290,0,1280,250)).resize((743,188)); d=Image.open('V12_dark.png').crop((290,0,1280,250)).resize((743,188)); l=Image.open('V12_light.png').crop((290,0,1280,250)).resize((743,188))
o=Image.new('RGB',(400+743,780),'white'); o.paste(m,(0,0)); o.paste(d0,(400,0)); o.paste(d,(400,198)); o.paste(l,(400,396)); o.save('V12.png')
