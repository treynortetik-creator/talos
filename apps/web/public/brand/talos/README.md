# Talos brand assets (web copies)

Copied from `assets/brand/` (the source of truth; never edit these by hand, re-copy instead).

- `talos-icon-*.png`, `talos-icon-maskable-512.png`, `apple-touch-icon.png`, `favicon.ico`: app icon set.
- `../mascot-{pleased,beaming,worried}-{512,256}.png` (one level up, `public/brand/`): the approved expressions, resized from
  `assets/brand/talos-*-source.png` with rounded-tile transparent corners. `<Mascot>` reads these.
- `meander.svg`: the running Greek key, one 16 px tile. Used as a CSS mask (`.meander-rule`), so a token inks it.
- `../mascot/talos-{idle,working,talking,beaming,worried}.{webm,mov,png}`: the animated clips, copied from
  `assets/mascot/web/` (VP9 alpha `.webm`, HEVC alpha `.mov` for Apple WebKit). The `.png` is a frame of the same clip
  (transparent, 256 px), the poster and the reduced-motion still. `<Mascot>` (`src/ui/Mascot.tsx`) reads these.
- The older `../mascot-{pleased,beaming,worried}-*.png` tiles are no longer read by the app.
- Still to make: `badge-96.png` (monochrome Android badge), `og-1200x630.png`.
