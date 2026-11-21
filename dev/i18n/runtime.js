(function(){
var EN=false;try{EN=localStorage.getItem("pulse-lang")==="en";}catch(e){}
window.PULSE_LANG=EN?"en":"pl";
Array.prototype.forEach.call(document.querySelectorAll("[data-lang]"),function(b){
  b.setAttribute("aria-pressed",b.getAttribute("data-lang")===window.PULSE_LANG?"true":"false");
  b.addEventListener("click",function(){var l=b.getAttribute("data-lang");if(l===window.PULSE_LANG)return;try{localStorage.setItem("pulse-lang",l);}catch(e){}location.reload();});
});
window.I18N_ADD=function(){};
if(!EN)return;
var root=document.documentElement;
try{
var D=/*I18N*/{};
var M=new Map();Object.keys(D).forEach(function(k){M.set(k,D[k]);});
var MON={stycznia:"January",lutego:"February",marca:"March",kwietnia:"April",maja:"May",czerwca:"June",lipca:"July",sierpnia:"August",września:"September",października:"October",listopada:"November",grudnia:"December"};
var PRE=[
 [/^dziś (\d\d:\d\d)$/,"today $1"],[/^wczoraj (\d\d:\d\d)$/,"yesterday $1"],[/^pomiar (.+)$/,"measured $1"],
 [/(\d+) (zmiana|zmiany|zmian) w ciągu 24 godzin/g,function(m,n){return n+(n==="1"?" change":" changes")+" in 24 hours";}],
 [/Zaktualizowane przez Microsoft w ostatnich 24 godzinach/g,"Updated by Microsoft in the last 24 hours"],
 [/Zamknięte incydenty Microsoft z ostatnich 7 dni/g,"Microsoft incidents closed in the last 7 days"],
 [/W ostatnich 24 godzinach Microsoft nie zaktualizował żadnego otwartego zgłoszenia\./g,"In the last 24 hours Microsoft has not updated any open issue."],
 [/W ostatnich 7 dniach Microsoft nie zamknął żadnego incydentu\./g,"In the last 7 days Microsoft has not closed any incident."],
 [/Zaktualizowane przez Microsoft w ostatnich 24 godzinach \(/g,"Updated by Microsoft in the last 24 hours ("],
 [/\((\d+) z ostatnich 7 dni\)/g,"($1 from the last 7 days)"],
 [/(\d+) dni temu/g,"$1 days ago"],
 [/Ostatnie 24 godziny, wartości znormalizowane\. Źródło: Cloudflare Radar · odczyt:/g,"Last 24 hours, normalized values. Source: Cloudflare Radar · read:"],
 [/Odpowiedź uzyskało (\d+) z (\d+) sond w (\d+) krajach, mediana czasu odpowiedzi ([\d,]+) ms\./g,function(m,a,b,c,d){return a+" of "+b+" probes in "+c+" countries responded, median response time "+d.replace(",",".")+" ms.";}],
 [/Polska: (\d+) z (\d+) sond, mediana ([\d,]+) ms\./g,function(m,a,b,c){return "Poland: "+a+" of "+b+" probes, median "+c.replace(",",".")+" ms.";}],
 [/Sondy RIPE Atlas \(([\d,]+)%\)/g,function(m,a){return "RIPE Atlas probes ("+a.replace(",",".")+"%)";}],
 [/([\d,]+)% sond(?![\p{L}])/gu,function(m,a){return a.replace(",",".")+"% of probes";}],
 [/pomiar ping nr (\d+)/g,"ping measurement no. $1"],
 [/Trasy BGP sieci Microsoft \(AS(\d+)\)/g,"BGP routes of the Microsoft network (AS$1)"],
 [/Ruch sieci Microsoft widziany przez Cloudflare \(AS(\d+)\)/g,"Microsoft network traffic seen by Cloudflare (AS$1)"],
 [/Ruch sieci Microsoft w Cloudflare Radar \(AS(\d+)\)/g,"Microsoft network traffic in Cloudflare Radar (AS$1)"],
 [/^(Incydent|Porada|Zamknięty incydent|Wycofany incydent) (\d+) z (\d+)$/,function(m,k,a,b){return ({"Incydent":"Incident","Porada":"Advisory","Zamknięty incydent":"Closed incident","Wycofany incydent":"Withdrawn incident"})[k]+" "+a+" of "+b;}],
 [/wykryto w (\d+) z (\d+) tenantów/g,"detected in $1 of $2 tenants"],
 [/\bw (\d+) z (\d+) tenantów/g,"in $1 of $2 tenants"],
 [/^Przywrócony przez Microsoft /,"Restored by Microsoft "],
 [/; wcześniej niewidoczny w odczycie od /g,"; previously not listed since "],
 [/wykryto we wszystkich tenantach/g,"detected in all tenants"],
 [/we wszystkich tenantach/g,"in all tenants"],
 [/odpowiada (\d+) z (\d+) punktów końcowych/g,"$1 of $2 endpoints responding"],
 [/Service health z (\d+) tenantów: otwarte zgłoszenia (\d+)/g,"Service health from $1 tenants: $2 open issues"],
 [/(\d+) z (\d+) regionów odpowiada/g,"$1 of $2 regions responding"],
 [/(\d+) z (\d+) odpowiada/g,"$1 of $2 responding"],
 [/(\d+) z (\d+) pomiarów/g,"$1 of $2 measurements"],
 [/(\d+) z (\d+) poprawnych/g,"$1 of $2 successful"],
 [/(\d+) z (\d+) tenantów/g,"$1 of $2 tenants"],
 [/komunikat nr (\d+)/g,"update no. $1"],
 [/oraz (\d+) kolejn[a-zę]+/g,"and $1 more"],
 [/(\d+) wiadomoś[a-zćę]+ z ostatnich (\d+) dni/g,"$1 messages from the last $2 days"],
 [/(\d{1,2}) (stycznia|lutego|marca|kwietnia|maja|czerwca|lipca|sierpnia|września|października|listopada|grudnia) (\d{4})/g,function(m,a,b,c){return a+" "+MON[b]+" "+c;}],
 [/(\d+) min temu/g,"$1 min ago"],
 [/(\d+) godz\. temu/g,"$1 h ago"],
 [/(\d+) dni\b/g,"$1 days"],
 [/(\d+) (?:godzin[ay]?|godz\.)(?![\p{L}])/gu,"$1 h"]
];
var POST=[
 [/(\d+) z (\d+)/g,"$1 of $2"],
 [/(\d),(\d{1,2}) ?%/g,"$1.$2%"],
 [/około/g,"about"],
 [/ oraz /g," and "],
 [/([,·(]) kod /g,"$1 code "],
 [/ i usługi zależne/g," and dependent services"]
];
var FR=null,C=new Map();
function rx(s){return s.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");}
function build(){
  var L="[\\p{L}\\p{N}]",ks=Array.from(M.keys()).filter(function(k){return k.length>=3;}).sort(function(a,b){return b.length-a.length;});
  var parts=ks.map(function(k){return (/^[\p{L}\p{N}]/u.test(k)?"(?<!"+L+")":"")+rx(k)+(/[\p{L}\p{N}]$/u.test(k)?"(?!"+L+")":"");});
  try{FR=new RegExp(parts.join("|"),"gu");}catch(e){FR=false;}
}
window.I18N_ADD=function(pl,en){if(pl&&en&&M.get(pl)!==en){M.set(pl,en);FR=null;C.clear();}};
function tr(s){
  if(!s)return s;var c=C.get(s);if(c!==undefined)return c;
  var m=/^(\s*)([\s\S]*?)(\s*)$/.exec(s),core=m[2],out=s;
  if(/[A-Za-zÀ-ž]|\d,\d/.test(core)){
    var e=M.get(core);if(e===undefined)e=M.get(core.replace(/\s+/g," "));
    if(e!==undefined)out=m[1]+e+m[3];
    else{var t=core;PRE.forEach(function(r){t=t.replace(r[0],r[1]);});
      if(FR===null)build();if(FR)t=t.replace(FR,function(x){return M.get(x);});
      POST.forEach(function(r){t=t.replace(r[0],r[1]);});out=m[1]+t+m[3];}
  }
  if(C.size>6000)C.clear();C.set(s,out);
  if(window.__i18nMiss&&/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/.test(out))window.__i18nMiss.add(out);
  return out;
}
window.TR=tr;
var DONE=new WeakMap(),ATTR=["title","aria-label","placeholder","data-l","alt"];
function skip(n){for(var p=n;p&&p!==document;p=p.parentNode){if(p.nodeType===1){var t=p.nodeName;if(t==="SCRIPT"||t==="STYLE"||t==="CODE"||p.hasAttribute("data-noi18n"))return true;}}return false;}
function tText(n){var v=n.nodeValue;if(!v||DONE.get(n)===v)return;if(skip(n))return;var t=tr(v);DONE.set(n,t);if(t!==v)n.nodeValue=t;}
function tAttr(el){for(var i=0;i<ATTR.length;i++){var a=ATTR[i],v=el.getAttribute(a);if(v){var t=tr(v);if(t!==v)el.setAttribute(a,t);}}}
function walk(n){
  if(n.nodeType===3){tText(n);return;}
  if(n.nodeType!==1)return;if(skip(n))return;
  tAttr(n);var els=n.querySelectorAll("[title],[aria-label],[placeholder],[data-l],[alt]");for(var i=0;i<els.length;i++)tAttr(els[i]);
  var w=document.createTreeWalker(n,NodeFilter.SHOW_TEXT,null),x,list=[];while((x=w.nextNode()))list.push(x);list.forEach(tText);
}
root.setAttribute("lang","en");
document.title=tr(document.title);
walk(document.body);
new MutationObserver(function(ms){ms.forEach(function(m){
  if(m.type==="characterData")tText(m.target);
  else if(m.type==="attributes"){if(!skip(m.target))tAttr(m.target);}
  else for(var i=0;i<m.addedNodes.length;i++)walk(m.addedNodes[i]);
});}).observe(document.body,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:ATTR});
var P=window.CanvasRenderingContext2D&&CanvasRenderingContext2D.prototype;
if(P){["fillText","strokeText","measureText"].forEach(function(k){var o=P[k];P[k]=function(){if(typeof arguments[0]==="string")arguments[0]=tr(arguments[0]);return o.apply(this,arguments);};});}
}catch(e){if(window.console)console.error("i18n",e);}
root.classList.remove("i18n-wait");
})();
