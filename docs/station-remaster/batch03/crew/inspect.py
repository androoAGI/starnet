from pathlib import Path
from PIL import Image, ImageDraw
import json,sys
root=Path(__file__).resolve().parents[4]
ids=sys.argv[1:]
board=Image.new('RGB',(400*len(ids),460),'#252b31')
draw=ImageDraw.Draw(board)
for i,id in enumerate(ids):
    im=Image.open(root/'frontend/assets/industrial/batch03/crew'/f'{id}.png').convert('RGBA')
    cfg=json.loads(Path(__file__).with_name(f'{id}.json').read_text(encoding='utf-8-sig'))
    draw.text((i*400+10,10),id,fill='white')
    large=im.copy();large.thumbnail((380,330),Image.Resampling.LANCZOS)
    board.paste(large,(i*400+(400-large.width)//2,40),large)
    small=im.copy();small.thumbnail((cfg['bounds']['width'],cfg['bounds']['height']),Image.Resampling.LANCZOS)
    board.paste(small,(i*400+30,390),small)
    draw.text((i*400+10,440),'Native envelope thumbnail, integration pending',fill='white')
board.save(Path(__file__).with_name('review-'+ids[0]+'.png'))

