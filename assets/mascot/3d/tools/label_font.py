"""The font the proof and critic sheets burn their labels in.

Arial where the owner's Mac has it; elsewhere (a Linux or WSL box, a CI runner) the sans font fontconfig names; with neither,
Pillow's built-in font. A label only has to be legible: which face draws it changes no tile and no check.
"""
import os
import shutil
import subprocess
from functools import lru_cache

from PIL import ImageFont

MAC_ARIAL = '/System/Library/Fonts/Supplemental/Arial.ttf'


@lru_cache(maxsize=1)
def path():
    """A TrueType file to label with, or None when this machine has none to name."""
    if os.path.exists(MAC_ARIAL):
        return MAC_ARIAL
    if shutil.which('fc-match'):
        try:
            p = subprocess.run(['fc-match', '-f', '%{file}', 'sans'], capture_output=True, text=True, timeout=10).stdout.strip()
        except (OSError, subprocess.SubprocessError):
            p = ''
        if p.lower().endswith(('.ttf', '.otf', '.ttc')) and os.path.exists(p):
            return p
    return None


def font(size):
    p = path()
    return ImageFont.truetype(p, size) if p else ImageFont.load_default(size)
