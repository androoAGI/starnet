import hashlib,json
from pathlib import Path
from PIL import Image
docs=Path(__file__).resolve().parent
root=docs.parents[3]
ids=list(json.loads((docs/'furniture-regions.json').read_text()))
rows=[]
for id in ids:
    meta=json.loads((docs/(id+'.export.json')).read_text())
    out=root/meta['output'];src=docs/(id+'-source.png');prompt=docs/(id+'.prompt.txt')
    im=Image.open(out);alpha=sorted(v for n,v in im.getchannel('A').getcolors(im.width*im.height))
    passed=im.mode=='RGBA' and alpha==[0,255] and hashlib.sha256(src.read_bytes()).hexdigest()==meta['sourceSha256'] and hashlib.sha256(out.read_bytes()).hexdigest()==meta['outputSha256'] and meta['subjectRgbChanges']==0 and bool(meta.get('authoredGeometry',{}).get('regions')) and prompt.is_file()
    rows.append({'id':id,'passed':passed,'size':im.size,'alphaValues':alpha,'sourceHash':meta['sourceSha256'],'outputHash':meta['outputSha256'],'regionNames':list(meta['authoredGeometry']['regions']),'fitWorldPixels':meta['authoredGeometry']['fitWorldPixels']})
report={'count':len(rows),'expectedViews':26,'allPassed':len(rows)==26 and all(r['passed'] for r in rows),'liveVerified':False,'rows':rows}
(docs/'furniture-verification.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({'count':len(rows),'allPassed':report['allPassed']}))
assert report['allPassed']
