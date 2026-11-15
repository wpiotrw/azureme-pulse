import os
ROOT=os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA=ROOT+"/dev/tests/data"
import subprocess,time,json
from playwright.sync_api import sync_playwright
from PIL import Image
srv=subprocess.Popen(["python3","-m","http.server","8788"],cwd=ROOT,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(1)
live=open(DATA+'/live14.json').read(); errs=[]
d=json.loads(live)
for t in d['health']:
    for i in t['issues']:
        if i['id']=='IT1549049': i['resolved']=True
    for sv in t['services']:
        if sv['name']=='Microsoft Intune': sv['status']='serviceOperational'
clean=json.dumps(d)
try:
  with sync_playwright() as p:
    b=p.chromium.launch(executable_path="/usr/bin/google-chrome",args=["--no-sandbox"])
    def mk(body,vp,dsf=1,theme='dark',**kw):
        pg=b.new_page(viewport=vp,device_scale_factor=dsf,**kw); pg.on("pageerror",lambda e:errs.append(str(e)))
        pg.route("https://raw.githubusercontent.com/**",lambda r:r.fulfill(status=200,content_type="text/plain",body=open(DATA+'/cases_demo.json').read() if 'cases.json' in r.request.url else body,headers={"access-control-allow-origin":"*"}))
        pg.add_init_script("try{localStorage.setItem('pulse-theme','%s')}catch(e){}"%theme); pg.goto("http://localhost:8788/index.html"); pg.wait_for_timeout(3200); return pg
    pm=mk(live,{"width":390,"height":780},2,has_touch=True,is_mobile=True); pm.evaluate("document.getElementById('sbar-x').click()"); print('overflow',pm.evaluate("document.documentElement.scrollWidth-innerWidth")); pm.screenshot(path="V10_m.png",full_page=True)
    pc=mk(clean,{"width":390,"height":780},2,has_touch=True,is_mobile=True); pc.evaluate("document.getElementById('sbar-x').click()"); print('clean headline:',pc.locator('#headline').inner_text().replace('\n',' '),'|',pc.locator('#bd-bad-t').inner_text()); pc.locator('.bok summary').click(); pc.wait_for_timeout(300); pc.screenshot(path="V10_c.png",full_page=True)
    pd=mk(live,{"width":1280,"height":900}); pd.screenshot(path="V10_d.png")
    pl=mk(live,{"width":1280,"height":900},theme='light'); pl.screenshot(path="V10_l.png")
    b.close()
finally: srv.kill()
print('ERRORS',errs)
m=Image.open('V10_m.png').crop((0,150,780,2550)).resize((390,1200)); c=Image.open('V10_c.png').crop((0,150,780,2550)).resize((390,1200))
dd=Image.open('V10_d.png').crop((290,100,820,900)).resize((398,600)); l=Image.open('V10_l.png').crop((290,100,820,900)).resize((398,600))
o=Image.new('RGB',(400*3,1200),'white'); o.paste(m,(0,0)); o.paste(c,(400,0)); o.paste(dd,(800,0)); o.paste(l,(800,600)); o.save('V10.png')
