"""Read-only source inspection sheet; no changes to generated assets."""
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[4]
assets = root / 'frontend/assets/industrial/parallel-0914/crew'
board = Image.new('RGB', (680, 360), '#20262b')
draw = ImageDraw.Draw(board)
draw.text((12, 10), 'UNCUT RGB candidates - scale inspection only; alpha failed', fill='white')
x = 18
for name, width, height in [('couch.png', 62, 20), ('lowtable.png', 38, 17), ('lowtable-r3.png', 16, 36)]:
    source = Image.open(assets / name)
    image = source.copy()
    image.thumbnail((width * 4, height * 4), Image.Resampling.LANCZOS)
    board.paste(image, (x, 75))
    draw.text((x, 42), name, fill='white')
    image = source.copy()
    image.thumbnail((width, height), Image.Resampling.LANCZOS)
    board.paste(image, (x, 265))
    draw.text((x, 305), f'4x above / 1x below {width}x{height}', fill='white')
    x += 250 if name == 'couch.png' else 200
board.save(Path(__file__).with_name('scale-review.png'))
