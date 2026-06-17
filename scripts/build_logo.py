#!/usr/bin/env python3
"""Fix the lights on the KAIRO base logo.

The base (scripts/orig_sample.svg, exported from Illustrator) ships with two
problems that wash the whole icon yellow:
  1. a leftover reference <image> (the old yellow/black icon) sitting at the
     bottom of the stack;
  2. mix-blend-mode:screen on the red tile, so it screens over that image and
     bleeds through as orange.

We strip both so the tile renders as solid red and the white ray paths (which
keep their screen blend) glow as intended. Nothing else in the base changes.
"""
import re
import sys

SRC = "scripts/orig_sample.svg"


def main():
    with open(SRC) as f:
        svg = f.read()

    # 1. drop the leftover reference image
    svg, n_img = re.subn(r'<image\b.*?/>', '', svg, flags=re.S)

    # 2. remove the light rays (.st5 paths) — they read as tacky
    svg, n_rays = re.subn(r'\s*<path class="st5"[^>]*/>', '', svg)

    # 3. take screen blend off the tile (.st9) so it renders solid red
    svg, n_blend = re.subn(r'\.st5,\s*\.st9\s*\{', '.st5 {', svg)

    if n_img == 0 or n_blend == 0 or n_rays == 0:
        sys.exit("base not in the expected shape "
                 "(image: {}, rays: {}, blend: {})".format(n_img, n_rays, n_blend))

    # --shadow: add a 45-degree long shadow extruded from the book to the
    # bottom-right corner (clipped to the tile).
    if "--shadow" in sys.argv:
        ds = re.findall(r'<path class="st[27]"[^>]*\bd="([^"]+)"', svg)
        step, count = 1.2, 120
        uses = "".join(
            '<path transform="translate({o} {o})" d="{d}"/>'.format(o=round(k * step, 2), d=d)
            for k in range(1, count + 1) for d in ds)
        clip = ('<clipPath id="lsClip"><rect x="184.13" y="277.59" '
                'width="240.79" height="240.79" rx="46.07" ry="46.07"/></clipPath>')
        shadow = ('<g clip-path="url(#lsClip)"><g fill="#3a0608" opacity="0.30">'
                  + uses + '</g></g>')
        svg = svg.replace("</defs>", clip + "\n  </defs>", 1)
        svg = re.sub(r'(<rect class="st9"[^>]*/>)', r'\1\n' + shadow, svg, count=1)

    # --square: crop the canvas to the tile for a full-bleed 1024px app icon.
    if "--square" in sys.argv:
        svg = re.sub(
            r'(<svg\b[^>]*?)\s+viewBox="0 0 612 792"',
            r'\1 width="1024" height="1024" '
            r'viewBox="184.13 277.59 240.79 240.79"',
            svg, count=1)

    sys.stdout.write(svg)


if __name__ == "__main__":
    main()
