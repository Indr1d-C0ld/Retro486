#!/usr/bin/env python3
"""Retro486 - webfont 8x16 dal BIOS VGA LGPL di Bochs (vendor/roms/video/bochs).

    python3 -I tools/font/crea-font.py

Ogni pixel acceso diventa un quadrato di 64 unita' (em = 1024 = 16 righe):
il testo resta nitido alle dimensioni multiple di 16 px. Mappa la code page 437.
"""
import sys
from pathlib import Path
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

ROOT = Path(__file__).resolve().parents[2]
ROM = ROOT / 'vendor/roms/video/bochs/VGABIOS-lgpl-latest.bin'
OUT = ROOT / 'app/fonts/vga8x16.woff'

CTRL = '\0☺☻♥♦♣♠•◘○◙♂♀♪♫☼►◄↕‼¶§▬↨↑↓→←∟↔▲▼'
HIGH = ('ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌'
        '█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ')
CP437 = CTRL + ''.join(chr(i) for i in range(32, 127)) + '⌂' + HIGH
assert len(CP437) == 256

rom = ROM.read_bytes()
A = bytes.fromhex('000010386cc6c6fec6c6c6c600000000')
start = rom.find(A) - 0x41 * 16
assert start >= 0 and rom[start:start + 16] == bytes(16), 'tabella font non trovata'
glyphs_bits = [rom[start + i * 16:start + i * 16 + 16] for i in range(256)]

PX, EM, ASC = 64, 1024, 12  # baseline sotto la riga 11
fb = FontBuilder(EM, isTTF=True)
names = ['.notdef'] + [f'g{i:02x}' for i in range(1, 256)]
fb.setupGlyphOrder(names)
fb.setupCharacterMap({ord(CP437[i]): names[i] for i in range(1, 256)})
glyf = {}
for i, rows in enumerate(glyphs_bits):
    pen = TTGlyphPen(None)
    for r, byte in enumerate(rows):
        x = 0
        while x < 8:
            if byte & (0x80 >> x):
                x0 = x
                while x < 8 and byte & (0x80 >> x):
                    x += 1
                y1 = (ASC - r) * PX
                y0 = y1 - PX
                pen.moveTo((x0 * PX, y0)); pen.lineTo((x0 * PX, y1)); pen.lineTo((x * PX, y1)); pen.lineTo((x * PX, y0)); pen.closePath()
            else:
                x += 1
    glyf[names[i]] = pen.glyph()
fb.setupGlyf(glyf)
fb.setupHorizontalMetrics({n: (8 * PX, 0) for n in names})
fb.setupHorizontalHeader(ascent=ASC * PX, descent=-(16 - ASC) * PX)
fb.setupNameTable({'familyName': 'Retro486 VGA', 'styleName': 'Regular',
                   'copyright': 'Glyphs from the LGPL VGABIOS (Bochs/Plex86 project)', 'licenseDescription': 'LGPL-2.1'})
fb.setupOS2(sTypoAscender=ASC * PX, sTypoDescender=-(16 - ASC) * PX, usWinAscent=ASC * PX, usWinDescent=(16 - ASC) * PX, sxHeight=7 * PX, sCapHeight=10 * PX)
fb.setupPost(isFixedPitch=1)
fb.font.flavor = 'woff'
OUT.parent.mkdir(parents=True, exist_ok=True)
fb.save(str(OUT))
print(f'{OUT.relative_to(ROOT)}: {OUT.stat().st_size} byte, tabella a 0x{start:x}')
