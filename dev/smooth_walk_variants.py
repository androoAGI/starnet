"""Apply the shipped Cadet color mappings to the selected new walk frames only."""
import json
import subprocess
import zipfile
from pathlib import Path
import sys
from PIL import Image
ROOT = Path(__file__).resolve().parents[1]
SPRITES = ROOT / 'frontend/assets/sprites'
sys.path.insert(0, str(SPRITES / '_assembly'))
from recolor_variants import learn, verify

source = ROOT / '.worldshots/smooth-walk/recolor-reference'
if not source.exists():
    source.mkdir(parents=True)
    config = json.loads((ROOT / 'dev/smooth-walk-sources.json').read_text())
    archive = source.parent / 'palette-baseline.zip'
    skins = ['blank', *config['paletteVariants']]
    subprocess.run(['git', 'archive', '--format=zip', '--output', str(archive), config['baselineCommit'], *[f'frontend/assets/sprites/{s}' for s in skins]], cwd=ROOT, check=True)
    with zipfile.ZipFile(archive) as z:
        for name in z.namelist():
            if not name.endswith('.png'): continue
            rel = Path(name).relative_to('frontend/assets/sprites')
            dest = source / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(z.read(name))
manifest_path = SPRITES / 'manifest.json'
manifest = json.loads(manifest_path.read_text())
base_tracks = {k:v for k,v in manifest['sprites'].items() if k.startswith('blank.walk.')}
for variant in ('blank_blue','blank_green','blank_red','blank_amber'):
    lut, conflicts, _ = learn(str(source), 'blank', variant)
    bad, _ = verify(str(source), 'blank', variant, lut)
    if conflicts or bad:
        raise ValueError(f'{variant}: existing color mapping is inconsistent')
    nearest = {}
    def color(p):
        if p[3] <= 16: return p
        if p in lut: return lut[p]
        if p not in nearest:
            src = min(lut, key=lambda c: sum((c[i]-p[i])**2 for i in range(3)))
            nearest[p] = (*lut[src][:3], p[3])
        return nearest[p]
    for key, paths in base_tracks.items():
        outpaths=[]
        for rel in paths:
            image = Image.open(SPRITES / rel).convert('RGBA')
            image.putdata([color(p) for p in (image.getpixel((x,y)) for y in range(image.height) for x in range(image.width))])
            out = rel.replace('blank/', variant + '/', 1)
            image.save(SPRITES / out)
            outpaths.append(out)
        manifest['sprites'][key.replace('blank.', variant + '.', 1)] = outpaths
    print(f'{variant}: {sum(map(len,base_tracks.values()))} walk frames recolored; existing mapping verified')
manifest_path.write_text(json.dumps(manifest, indent=2)+'\n', newline='\r\n')
