"""Fetch and stage reviewed PixelLab cycles; never installs without separate review.
Usage: python dev/smooth_walk_batch.py skin [skin ...] [--cached]
Recipes live in dev/smooth-walk-sources.json. Requires Pillow.
"""
import argparse
import json
import shutil
import urllib.request
import zipfile
from PIL import Image
from smooth_walk_import import ROOT, STAGE, stage


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('skins', nargs='+')
    parser.add_argument('--cached', action='store_true', help='Use existing downloaded ZIPs')
    args = parser.parse_args()
    recipes = json.loads((ROOT / 'dev/smooth-walk-sources.json').read_text())['skins']
    STAGE.mkdir(parents=True, exist_ok=True)
    for skin in args.skins:
        recipe = recipes[skin]
        archive = STAGE / f'{skin}.zip'
        if not args.cached:
            print(f'{skin}: downloading export', flush=True)
            url = f"https://api.pixellab.ai/mcp/characters/{recipe['characterId']}/download"
            with urllib.request.urlopen(url, timeout=60) as response, archive.open('wb') as output:
                shutil.copyfileobj(response, output)
        with zipfile.ZipFile(archive) as z:
            paths = set(z.namelist())
        tracks = []
        for direction in recipe['directions']:
            selected = dict(recipe, **recipe.get('overrides', {}).get(direction, {}))
            suffix = f"animations/{selected['animationName']}/{direction}/frame_000.png"
            matches = [p for p in paths if p.endswith(suffix)]
            if len(matches) != 1:
                raise ValueError(f'{skin}.{direction}: expected one exported animation, found {len(matches)}')
            prefix = matches[0].removesuffix(suffix)
            frame_prefix = prefix + suffix.removesuffix('frame_000.png')
            start = selected['frameStart']
            frames = [f'{frame_prefix}frame_{i:03}.png' for i in range(start, start+selected['frameCount'])]
            reference = f'{frame_prefix}frame_000.png' if selected.get('referenceFrame') else f'{prefix}rotations/{direction}.png'
            if not all(p in paths for p in frames + [reference]):
                raise ValueError(f'{skin}.{direction}: incomplete export')
            tracks.append(dict(skin=skin, direction=direction, archive=str(archive), reference_path=reference, frame_paths=frames))
        (STAGE / f'{skin}.json').write_text(json.dumps(tracks, indent=2), newline='\n')
        for track in tracks:
            stage(track)
        comparisons = [Image.open(STAGE / skin / d / 'comparison.png') for d in recipe['directions']]
        sheet = Image.new('RGB', (comparisons[0].width, sum(im.height for im in comparisons)))
        y = 0
        for im in comparisons:
            sheet.paste(im, (0, y))
            y += im.height
        sheet.save(STAGE / skin / 'all-directions.png')
        print(f'{skin}: all directions staged for review', flush=True)

if __name__ == '__main__':
    main()
