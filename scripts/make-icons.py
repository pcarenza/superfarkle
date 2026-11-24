"""Regenerate the Android launcher icons and splash screens from the artwork in store/.
Overwrites the PNGs already in android/app/src/main/res, keeping their sizes.
  python3 scripts/make-icons.py [res_dir]
Needs Pillow. The artwork itself (3D dice renders) lives in store/.
"""
import glob, os, sys
from PIL import Image, ImageDraw

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
RES = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'android', 'app', 'src', 'main', 'res')
STORE = os.path.join(ROOT, 'store')
BG = Image.open(os.path.join(STORE, 'icon-background.png')).convert('RGBA')
FG = Image.open(os.path.join(STORE, 'icon-foreground.png')).convert('RGBA')
SPLASH_BG = (15, 42, 28, 255)

def layer(w, h, scale):
    """The dice centred on a transparent w x h canvas, `scale` of its shorter side."""
    k = int(min(w, h) * scale)
    out = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    out.alpha_composite(FG.resize((k, k), Image.LANCZOS), ((w - k) // 2, (h - k) // 2))
    return out

for p in glob.glob(os.path.join(RES, 'mipmap-*', 'ic_launcher*.png')):
    w, h = Image.open(p).size
    name = os.path.basename(p)
    if 'foreground' in name:
        img = layer(w, h, 1.2)
    elif 'background' in name:
        img = BG.resize((w, h), Image.LANCZOS)
    else:  # legacy launcher icon (adaptive layers are 108dp with a 66% safe zone; legacy fills the tile)
        img = BG.resize((w, h), Image.LANCZOS)
        img.alpha_composite(layer(w, h, 1.15))
        if 'round' in name:
            mask = Image.new('L', (w, h), 0)
            ImageDraw.Draw(mask).ellipse((0, 0, w - 1, h - 1), fill=255)
            img.putalpha(mask)
    img.save(p)

for p in glob.glob(os.path.join(RES, 'drawable*', 'splash.png')):
    w, h = Image.open(p).size
    img = Image.new('RGBA', (w, h), SPLASH_BG)
    img.alpha_composite(layer(w, h, 0.5))
    img.save(p)
print('icons and splash screens written to', RES)
