"""Builds ../index.html from dev/src.html. Usage: python3 dev/build.py  (run from anywhere).
1. embeds the translation runtime with the dictionary (i18n/idx.txt keyed by i18n/tr_keys.json, plus i18n/hand.txt),
2. stamps the build, embeds the globe dots, writes index.html,
3. writes the main script to dev/.out/p.js so that it can be checked with: node --check dev/.out/p.js
"""
import re, hashlib, datetime, json, os
D = os.path.dirname(os.path.abspath(__file__))
R = lambda p: open(os.path.join(D, p), encoding='utf-8').read()
s = R('src.html')
keys = json.loads(R('i18n/tr_keys.json')); T = {}
for l in R('i18n/idx.txt').split('\n'):
    if l.strip(): i, en = l.split('|', 1); T[keys[int(i)]] = en
for l in R('i18n/hand.txt').split('\n'):
    if l.strip(): pl, en = l.split('|', 1); T[pl] = en
T = {k: v for k, v in T.items() if k != v}
rt = R('i18n/runtime.js').replace('/*I18N*/{}', json.dumps(T, ensure_ascii=False, separators=(',', ':')).replace('</', '<\\/'))
a = '<script>(function(){\nvar EN=false;'; assert s.count(a) == 1
i = s.index(a); j = s.index('</script>', i); s = s[:i] + '<script>' + rt + s[j:]
h = int(hashlib.sha1(s.encode()).hexdigest()[:8], 16); v = ''
while len(v) < 4: v += '0123456789abcdefghijklmnopqrstuvwxyz'[h % 36]; h //= 36
t = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
assert s.count('/*BUILD*/null') == 1
s = s.replace('/*BUILD*/null', '{t:"%s",v:"%s"}' % (t, v))
out = s.replace('/*DOTS*/[]', R('dots.json'))
open(os.path.join(D, '..', 'index.html'), 'w', encoding='utf-8').write(out)
os.makedirs(os.path.join(D, '.out'), exist_ok=True)
open(os.path.join(D, '.out', 'p.js'), 'w', encoding='utf-8').write(max(re.findall(r'<script>(.*?)</script>', out, re.S), key=len))
print('build', t, v, 'dictionary', len(T))
