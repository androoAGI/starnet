import hashlib,json
from pathlib import Path
from PIL import Image
root=Path(__file__).resolve().parents[4]
docs=Path(__file__).resolve().parent
ids=['industrial_partition','industrial_partition-r1','industrial_partition-r3','industrial_servicecab','industrial_wallpanel','industrial_floorvent','industrial_cabletray']
results=[]
for id in ids:
    p=docs/(id+'.export.json');m=json.loads(p.read_text())
    src=docs/(id+'-source.png');out=root/m['output'];im=Image.open(out)
    colors=im.getchannel('A').getcolors(im.width*im.height)
    alphas=sorted(v for count,v in colors)
    b=m['bounds'];s=min(b['width']/im.width,b['height']/im.height)
    fit={'x':b['x']+(b['width']-im.width*s)/2,'y':b['y']+b['height']-im.height*s,'width':im.width*s,'height':im.height*s,'bottom':b['y']+b['height']}
    good=im.mode=='RGBA' and alphas==[0,255] and m['subjectRgbChanges']==0 and hashlib.sha256(src.read_bytes()).hexdigest()==m['sourceSha256'] and hashlib.sha256(out.read_bytes()).hexdigest()==m['outputSha256']
    results.append({'id':id,'passed':good,'alphaValues':alphas,'crop':m['crop'],'fitWorldPixels':fit,'bounds':b,'liveVerified':False})
r={'count':len(results),'allPassed':all(x['passed'] for x in results),'results':results}
(docs/'infrastructure-verification.json').write_text(json.dumps(r,indent=2)+'\n')
print(json.dumps(r))
assert r['allPassed']
