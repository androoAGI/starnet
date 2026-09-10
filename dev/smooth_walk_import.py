"""Stage PixelLab walk frames against the shipped idle; install only after visual review.
Input JSON: [{skin, direction, archive, reference_path, frame_paths}].
frame_paths contains the generated poses, excluding the reference frame.
Usage: python dev/smooth_walk_import.py batch.json [--install]
"""
import argparse
import concurrent.futures
import hashlib
import io
import json
from pathlib import Path
import re
import zipfile
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
SPRITES = ROOT / 'frontend/assets/sprites'
STAGE = ROOT / '.worldshots/smooth-walk'

def box(image):
    result = image.getchannel('A').getbbox()
    if result is None:
        raise ValueError('Empty animation frame')
    return result

def remove_wizard_margin_pole(image, floor):
    # Same geometric rule as skin-bar-scan / the existing staff repair, on this known artifact only.
    image = image.copy()
    for reverse in (False, True):
        counts = [sum(image.getpixel((x,y))[3] > 16 for y in range(image.height)) for x in range(image.width)]
        order = list(range(image.width))
        if reverse: order.reverse()
        first = next((x for x in order if counts[x]), None)
        if first is None: continue
        step = -1 if reverse else 1
        end = first
        while 0 <= end+step < image.width and abs(end+step-first) < 4 and counts[end+step]: end += step
        xs = range(min(first,end), max(first,end)+1)
        height = box(image)[3]-box(image)[1]
        inside = end+step
        if not 0 <= inside < image.width: continue
        bar = max(counts[x] for x in xs)
        if bar < height*0.5 or counts[inside] > bar*0.5: continue
        for x in xs:
            for y in range(image.height):
                pixel = image.getpixel((x,y))
                warm = pixel[0] > 60 and pixel[0] > pixel[2]*1.25 and pixel[0] >= pixel[1]
                if x == end and image.getpixel((inside,y))[3] > 16 and not warm: continue
                image.putpixel((x,y),(0,0,0,0))
    dy = floor-box(image)[3]
    out = Image.new('RGBA', image.size)
    out.paste(image,(0,dy))
    return out

def stage(track):
    skin, direction = track['skin'], track['direction']
    if not re.fullmatch(r'[a-z0-9_]+', skin) or direction not in ('south','south-east','east','north-east','north','north-west','west','south-west'):
        raise ValueError('Invalid sprite track')
    target = Image.open(SPRITES / skin / f'rot_{direction}.png').convert('RGBA')
    archive = zipfile.ZipFile(track['archive'])
    def read(name):
        return Image.open(io.BytesIO(archive.read(name))).convert('RGBA')
    reference = read(track['reference_path'])
    tb, rb = box(target), box(reference)
    scale = (tb[3] - tb[1]) / (rb[3] - rb[1])
    # Refuse a similarly named but different source character; dimensions alone do not prove identity.
    aligned_reference = reference
    if abs(scale - 1) > 0.001:
        aligned_reference = reference.resize((round(reference.width * scale), round(reference.height * scale)), Image.Resampling.LANCZOS)
    ab = box(aligned_reference)
    aligned = Image.new('RGBA', target.size)
    aligned.paste(aligned_reference, (round((tb[0]+tb[2])/2 - (rb[0]+rb[2])/2*scale), tb[3]-ab[3]))
    mismatch = total = 0
    for x in range(target.width):
        for y in range(target.height):
            a, b = aligned.getpixel((x,y)), target.getpixel((x,y))
            if max(a[3], b[3]) <= 16: continue
            total += 1
            mismatch += max(abs(a[i]-b[i]) for i in range(4)) > 30
    if mismatch / total > 0.10:
        raise ValueError(f'{skin}.{direction}: source identity mismatch ({mismatch/total:.1%})')
    urls = track['frame_paths']
    if len(urls) not in (8, 12):
        raise ValueError(f'{skin}.{direction}: expected 8 or 12 generated frames, got {len(urls)}')
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        originals = list(pool.map(read, urls))
    images = []
    for original in originals:
        if original.size != reference.size:
            raise ValueError('Frame canvas differs from reference')
        if abs(scale - 1) > 0.001:
            original = original.resize((round(original.width * scale), round(original.height * scale)), Image.Resampling.LANCZOS)
        bb = box(original)
        height = bb[3] - bb[1]
        if not 0.85 <= height / (tb[3] - tb[1]) <= 1.15:
            raise ValueError(f'{skin}.{direction}: body-size drift {height / (tb[3] - tb[1]):.3f}')
        # One reference-derived horizontal anchor preserves real limb swing. Feet stay on the idle floor.
        dx = round((tb[0] + tb[2]) / 2 - (rb[0] + rb[2]) / 2 * scale)
        dy = tb[3] - bb[3]
        if bb[0]+dx < 0 or bb[2]+dx > target.width or bb[1]+dy < 0 or bb[3]+dy > target.height:
            raise ValueError('Frame would clip on the master canvas')
        canvas = Image.new('RGBA', target.size)
        canvas.paste(original, (dx, dy))
        if skin == 'blank':
            # Cadet is deliberately faceless; retain the shipped head instead of generated eyes.
            head_bottom = tb[1] + round((tb[3] - tb[1]) * 0.35)
            canvas.paste((0, 0, 0, 0), (0, 0, target.width, head_bottom))
            canvas.alpha_composite(target.crop((0, 0, target.width, head_bottom)))
        if skin == 'voidwizard' and direction == 'north-west':
            canvas = remove_wizard_margin_pole(canvas, tb[3])
        images.append(canvas)
    if len({hashlib.sha256(im.tobytes()).hexdigest() for im in images}) < len(urls) - 1:
        raise ValueError('Too few distinct generated poses')
    out = STAGE / skin / direction
    out.mkdir(parents=True, exist_ok=True)
    for i, image in enumerate(images):
        image.save(out / f'walk_{direction}_{i}.png')
    baseline = STAGE / 'baseline.zip'
    if baseline.exists():
        with zipfile.ZipFile(baseline) as source:
            prefix = 'frontend/assets/sprites/'
            manifest = json.loads(source.read(prefix + 'manifest.json'))
            old = [Image.open(io.BytesIO(source.read(prefix + p))).convert('RGBA') for p in manifest['sprites'][f'{skin}.walk.{direction}']]
        label = 'original baseline'
    else:
        manifest = json.loads((SPRITES / 'manifest.json').read_text())
        old = [Image.open(SPRITES / p).convert('RGBA') for p in manifest['sprites'][f'{skin}.walk.{direction}']]
        label = 'current worktree'
    sheet = Image.new('RGBA', (target.width * 12, target.height * 2 + 40), '#182125')
    draw = ImageDraw.Draw(sheet)
    draw.text((4,4), f'{skin} {direction}: {label}', fill='white')
    draw.text((4,target.height+24), f'candidate: {len(images)} generated poses', fill='white')
    for i in range(12):
        sheet.alpha_composite(old[i * len(old) // 12], (i * target.width, 20))
        sheet.alpha_composite(images[i * len(images) // 12], (i * target.width, target.height+40))
    sheet.convert('RGB').save(out / 'comparison.png')
    (out / 'source.json').write_text(json.dumps(track, indent=2))
    print(f'{skin}.{direction}: staged {len(images)} frames; reference scale {scale:.3f}', flush=True)
    return images

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('batch', type=Path)
    parser.add_argument('--install', action='store_true')
    args = parser.parse_args()
    tracks = json.loads(args.batch.read_text(encoding='utf-8-sig'))
    staged = [(track, stage(track)) for track in tracks]
    if args.install:
        manifest_path = SPRITES / 'manifest.json'
        manifest = json.loads(manifest_path.read_text())
        for track, images in staged:
            skin, direction = track['skin'], track['direction']
            paths = []
            for i, image in enumerate(images):
                rel = f'{skin}/walk_{direction}_{i}.png'
                image.save(SPRITES / rel)
                paths.append(rel)
            key = f'{skin}.walk.{direction}'
            for stale in set(manifest['sprites'][key]) - set(paths):
                candidate = (SPRITES / stale).resolve()
                if candidate.parent != (SPRITES / skin).resolve():
                    raise ValueError('Unexpected stale frame path')
                candidate.unlink()
            manifest['sprites'][key] = paths
        manifest_path.write_text(json.dumps(manifest, indent=2) + '\n', newline='\r\n')

if __name__ == '__main__':
    main()
