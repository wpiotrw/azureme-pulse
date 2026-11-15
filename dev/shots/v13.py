import os,subprocess,time,json
ROOT=os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA=ROOT+"/dev/tests/data"; OUT=os.environ.get("SHOTS","/tmp")
from playwright.sync_api import sync_playwright
from PIL import Image
srv=subprocess.Popen(["python3","-m","http.server","8788"],cwd=ROOT,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(1)
live=open(DATA+'/live14.json').read(); errs=[]
d=json.loads(live); S=d['samples']
S[40]['r']['teams'][0]=0; S[40]['r']['teams'][2]=503            # transient
for i in (80,81,82): S[i]['r']['exo'][0]=0; S[i]['r']['exo'][2]=0   # sustained
for i in (80,81): S[i]['r']['graph'][0]=0                        # two probes at once
S[-1]['r']['intune'][0]=0; S[-2]['r']['intune'][0]=0             # ongoing
bad=json.dumps(d)
try:
  with sync_playwright() as p:
    b=p.chromium.launch(executable_path="/usr/bin/google-chrome",args=["--no-sandbox"])
    def mk(body,vp,dsf=1,lang='pl',**kw):
        pg=b.new_page(viewport=vp,device_scale_factor=dsf,**kw); pg.on("pageerror",lambda e:errs.append(str(e)))
        pg.route("https://raw.githubusercontent.com/**",lambda r:r.fulfill(status=200,content_type="text/plain",body=open(DATA+'/cases_demo.json').read() if 'cases.json' in r.request.url else body,headers={"access-control-allow-origin":"*"}))
        pg.add_init_script("try{localStorage.setItem('pulse-lang','%s');window.__i18nMiss=new Set()}catch(e){}"%lang); pg.goto("http://localhost:8788/index.html"); pg.wait_for_timeout(3200); return pg
    pm=mk(live,{"width":390,"height":780},2,has_touch=True,is_mobile=True)
    print('clean:',pm.locator('#pb-home .pb-k').inner_text().replace('\n',' | ')); pm.locator('#pb-home').scroll_into_view_if_needed(); pm.wait_for_timeout(300); pm.screenshot(path=OUT+"/V13_a.png")
    pb=mk(bad,{"width":390,"height":780},2,has_touch=True,is_mobile=True)
    print('bad:',pb.locator('#pb-home .pb-k').inner_text().replace('\n',' | '))
    pb.evaluate("location.hash='#/pomiary'"); pb.wait_for_timeout(700); print('overflow',pb.evaluate("document.documentElement.scrollWidth-innerWidth"))
    print('outages:',[x.replace('\n',' | ') for x in pb.locator('#pb-out .pb-row').all_inner_texts()])
    pb.evaluate("document.getElementById('sbar-x').click()"); pb.wait_for_timeout(200); pb.screenshot(path=OUT+"/V13_b.png",full_page=True)
    pb.evaluate("document.querySelector('#pb-top rect[data-si=\"80\"]').dispatchEvent(new MouseEvent('click',{bubbles:true}))"); pb.wait_for_timeout(400)
    print('sample dialog:',pb.locator('#dlg-t').inner_text(),'| bad rows',pb.locator('#dlg-b tr.bad').count()); pb.screenshot(path=OUT+"/V13_c.png"); pb.evaluate("document.getElementById('dlg').close()")
    pb.locator('#pb-out .pb-row').first.click(); pb.wait_for_timeout(400); print('probe dialog:',pb.locator('#dlg-t').inner_text()); pb.evaluate("document.getElementById('dlg').close()")
    tabs=pb.locator('#pomiary [role=tab], #pomiary .tabs button'); print('tabs:',tabs.all_inner_texts()); tabs.last.click(); pb.wait_for_timeout(300); print('desc rows',pb.locator('#pb-desc tbody tr').count()); pb.locator('#pb-desc').scroll_into_view_if_needed(); pb.screenshot(path=OUT+"/V13_d.png")
    pe=mk(bad,{"width":1280,"height":900},lang='en'); pe.evaluate("location.hash='#/pomiary'"); pe.wait_for_timeout(700); pe.evaluate("document.querySelector('#pb-top rect[data-si=\"80\"]').dispatchEvent(new MouseEvent('click',{bubbles:true}))"); pe.wait_for_timeout(300); pe.evaluate("document.getElementById('dlg').close()"); pe.locator('#pomiary .tabs button').last.click(); pe.wait_for_timeout(300)
    print('EN:',pe.locator('#pb-out .pb-row').first.inner_text().replace('\n',' | ')); print('MISS',[x[:70] for x in pe.evaluate("Array.from(window.__i18nMiss)") if 'Wiśniewski' not in x])
    pe.evaluate("window.scrollTo(0,0)"); pe.screenshot(path=OUT+"/V13_e.png")
    b.close()
finally: srv.kill()
print('ERRORS',errs)
ims=[Image.open(OUT+'/V13_a.png').resize((390,780)),Image.open(OUT+'/V13_b.png').crop((0,150,780,1710)).resize((390,780)),Image.open(OUT+'/V13_c.png').resize((390,780)),Image.open(OUT+'/V13_d.png').resize((390,780))]
o=Image.new('RGB',(400*4,780),'white')
for k,i in enumerate(ims): o.paste(i,(k*400,0))
o.save(OUT+'/V13.png'); Image.open(OUT+'/V13_e.png').crop((290,100,1280,640)).save(OUT+'/V13e.png')
