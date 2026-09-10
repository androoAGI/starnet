"""Import the reviewed eight-pose imagegen sheets, preserving master canvas and floor.
Run without --install to stage contact sheets; --install updates only these two tracks.
"""
import argparse,json
from pathlib import Path
from PIL import Image,ImageDraw
ROOT=Path(__file__).resolve().parents[1]
def main():
 install=argparse.ArgumentParser();install.add_argument('--install',action='store_true');args=install.parse_args()
 sprites=ROOT/'frontend/assets/sprites';manifest=json.loads((sprites/'manifest.json').read_text(encoding='utf-8'))['sprites']
 out=ROOT/'.worldshots/frame-sweep-0910/staged';out.mkdir(parents=True,exist_ok=True)
 for skin,direction,name in [('ninjaturtle','north','turtle-north'),('voidwizard','north-west','wizard-northwest')]:
  sheet=Image.open(ROOT/f'dev/frame-sweep-sources/{name}.png').convert('RGBA');sheet.putalpha(sheet.getchannel('A').point(lambda a:0 if a<=16 else a))
  ref=Image.open(sprites/f'{skin}/rot_{direction}.png').convert('RGBA');rb=ref.getbbox();frames=[]
  tiles=[sheet.crop((round(i*sheet.width/8),0,round((i+1)*sheet.width/8),sheet.height)) for i in range(8)]
  initial=tiles[0].getbbox();scale=(rb[3]-rb[1])/(initial[3]-initial[1])
  for i,tile in enumerate(tiles):
   bb=tile.getbbox();im=tile.crop(bb);im=im.resize((round(im.width*scale),round(im.height*scale)),Image.Resampling.LANCZOS)
   # Alpha cleanup is export normalization, not a painted change to the character.
   im.putalpha(im.getchannel('A').point(lambda a:0 if a<=16 else a));ib=im.getbbox();canvas=Image.new('RGBA',ref.size)
   canvas.alpha_composite(im,(round((rb[0]+rb[2]-im.width)/2),rb[3]-ib[3]));assert canvas.getbbox()[3]==rb[3]
   canvas.save(out/f'{skin}-{direction}-{i}.png');frames.append(canvas)
   if args.install:
    relative=manifest[f'{skin}.walk.{direction}'][i]
    canvas.save(sprites/relative);canvas.save(ROOT/'website/app/assets/sprites'/relative)
  contact=Image.new('RGB',(9*180,200),'#29343f')
  for i,im in enumerate([ref]+frames):
   im=im.resize((184,184),Image.Resampling.NEAREST);contact.paste(im,(i*180,0),im)
  contact.save(out/f'{name}-review.png')
if __name__=='__main__':main()
