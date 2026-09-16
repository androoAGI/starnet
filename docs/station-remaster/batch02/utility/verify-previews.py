from PIL import Image, ImageDraw
from pathlib import Path
import json
root=Path(__file__).resolve().parent
repo=root.parents[3]
manifest=json.loads((root/'manifest.json').read_text())
ids=list(manifest['props'])
# Preview sheets are diagnostic composites only; sprite sources are never resized.
for group in range(4):
    sheet=Image.new('RGB',(1200,500),(30,35,40)); draw=ImageDraw.Draw(sheet)
    for index,id in enumerate(ids[group*3:group*3+3]):
        im=Image.open(repo/manifest['props'][id]['image']).convert('RGBA')
        im.thumbnail((380,450),Image.Resampling.LANCZOS)
        sheet.paste(im,(index*400+(400-im.width)//2,40),im)
        draw.text((index*400+15,10),id,fill='white')
    sheet.save(root/('proof-%02d.png'%(group+1)))
sheet=Image.new('RGB',(1200,600),(30,35,40)); draw=ImageDraw.Draw(sheet)
for index,id in enumerate(ids):
    p=manifest['props'][id]; im=Image.open(repo/p['image'])
    assert im.mode=='RGBA',id
    assert im.getchannel('A').getextrema()==(0,255),id
    a=im.getchannel('A'); crop=a.getbbox(); im=im.crop(crop)
    envelope=p['desiredWorldEnvelope']; im.thumbnail((envelope['width']*4,envelope['height']*4),Image.Resampling.LANCZOS)
    x=(index%4)*300;y=(index//4)*200
    draw.text((x+12,y+10),id,fill='white')
    sheet.paste(im,(x+150-im.width//2,y+160-im.height),im)
    draw.line((x+80,y+161,x+220,y+161),fill=(65,70,75))
    draw.text((x+12,y+176),'4 display px / world px; uniform fit',fill=(145,155,160))
sheet.save(root/'scale-proof.png')
print('12 RGBA files verified; refreshed4 dark-matte proofs and uniform-fit scale proof.')

