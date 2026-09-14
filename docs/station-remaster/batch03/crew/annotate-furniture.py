import json,sys,hashlib
from pathlib import Path
from PIL import Image
docs=Path(__file__).resolve().parent
regions=json.loads((docs/'furniture-regions.json').read_text())
def map_points(v,fn):
    if len(v)==2 and all(isinstance(x,(int,float)) for x in v): return fn(v)
    return [map_points(x,fn) for x in v]
for id in sys.argv[1:]:
    cfgp=docs/(id+'.json');cfg=json.loads(cfgp.read_text(encoding='utf-8-sig'))
    ep=docs/(id+'.export.json');ex=json.loads(ep.read_text());c=ex['crop'];b=cfg['bounds']
    scale=min(b['width']/c['width'],b['height']/c['height']);fw=c['width']*scale;fh=c['height']*scale
    fx=b['x']+(b['width']-fw)/2;fy=b['y']+b['height']-fh
    data={'method':'Manual visual annotation of painted source geometry; approximate edges, not live validated. Normalized coordinates refer to final tight alpha crop, not full original canvas.','fitWorldPixels':{'x':fx,'y':fy,'width':fw,'height':fh,'bottom':fy+fh},'regions':{}}
    for key,pts in regions.get(id,{}).items():
        data['regions'][key]={'cropNormalized':pts,'sourcePixels':map_points(pts,lambda p:[round(c['left']+p[0]*c['width'],2),round(c['top']+p[1]*c['height'],2)]),'sourceNormalized':map_points(pts,lambda p:[round((c['left']+p[0]*c['width'])/ex['sourceWidth'],6),round((c['top']+p[1]*c['height'])/ex['sourceHeight'],6)]),'worldPixels':map_points(pts,lambda p:[round(fx+p[0]*fw,4),round(fy+p[1]*fh,4)])}
    cfg['authoredGeometry']=data;cfgp.write_text(json.dumps(cfg,indent=2)+'\n');ex['authoredGeometry']=data;ep.write_text(json.dumps(ex,indent=2)+'\n')
    print(id,json.dumps(data['fitWorldPixels']))
