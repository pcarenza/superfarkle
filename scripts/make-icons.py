"""Regenerate the Android launcher icons and splash screens (dice artwork).
Overwrites the PNGs already in android/app/src/main/res, keeping their sizes.
  python3 scripts/make-icons.py
"""
import glob, os
from PIL import Image, ImageDraw, ImageFilter

RES = os.path.join(os.path.dirname(__file__), '..', 'android', 'app', 'src', 'main', 'res')
FELT = (24, 94, 60, 255)
DARK = (15, 42, 28, 255)
S = 1024

def die(size, rot=0, pip_red=True):
    """A rounded ivory die showing a five, drawn at high resolution."""
    d = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    g = ImageDraw.Draw(d)
    m = int(S * 0.08)
    g.rounded_rectangle((m, m, S - m, S - m), radius=int(S * 0.2), fill=(246, 236, 210, 255), outline=(205, 190, 150, 255), width=10)
    r = int(S * 0.065)
    for (x, y) in [(.3, .3), (.7, .3), (.5, .5), (.3, .7), (.7, .7)]:
        c = (S * x, S * y)
        g.ellipse((c[0] - r, c[1] - r, c[0] + r, c[1] + r), fill=(30, 26, 22, 255))
    if rot:
        d = d.rotate(rot, resample=Image.BICUBIC)
    return d

def shadowed(img):
    sh = Image.new('RGBA', img.size, (0, 0, 0, 0))
    sh.paste((0, 0, 0, 120), mask=img.split()[3])
    sh = sh.filter(ImageFilter.GaussianBlur(24))
    out = Image.new('RGBA', img.size, (0, 0, 0, 0))
    out.alpha_composite(sh, (0, 18))
    out.alpha_composite(img)
    return out

def fit(img, w, h):
    return img.resize((w, h), Image.LANCZOS)

def write(path, img):
    img.save(path)

def fg_layer(w, h, scale):
    d = shadowed(die(S, rot=-12))
    k = int(min(w, h) * scale)
    layer = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    layer.alpha_composite(fit(d, k, k), ((w - k) // 2, (h - k) // 2))
    return layer

for p in glob.glob(os.path.join(RES, 'mipmap-*', 'ic_launcher*.png')):
    w, h = Image.open(p).size
    name = os.path.basename(p)
    if 'foreground' in name:
        write(p, fg_layer(w, h, 0.62))
    elif 'background' in name:
        write(p, Image.new('RGBA', (w, h), FELT))
    else:
        base = Image.new('RGBA', (w, h), FELT)
        base.alpha_composite(fg_layer(w, h, 0.72))
        if 'round' in name:
            mask = Image.new('L', (w, h), 0)
            ImageDraw.Draw(mask).ellipse((0, 0, w - 1, h - 1), fill=255)
            base.putalpha(mask)
        write(p, base)

for p in glob.glob(os.path.join(RES, 'drawable*', 'splash.png')):
    w, h = Image.open(p).size
    img = Image.new('RGBA', (w, h), DARK)
    img.alpha_composite(fg_layer(w, h, 0.3))
    write(p, img)
print('done')
