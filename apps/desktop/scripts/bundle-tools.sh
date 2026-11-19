#!/usr/bin/env bash
# Puts the pinned tools a prebuilt Talos needs on a clean Mac next to the app: bun (MIT) and tmux (ISC, with libevent, BSD-3,
# linked in statically) into <out>/bin, Anthropic's Claude Code installer script (pinned bytes) as <out>/claude-install.sh, and their licenses into <out>/licenses. build-app.sh calls it before it signs.
#   bundle-tools.sh --out DIR [--arch universal|arm64]
# Every download is checked against the sha256 pinned below before anything is unpacked; a mismatch stops the script (exit 9) and
# leaves nothing in DIR. The pins are bun's own published SHASUMS256.txt for the release (bun) and the sha256 of the release
# tarballs as downloaded for the pinned versions (tmux, libevent: their projects publish no checksum list; compare with
# the signature files next to the tarballs when bumping).
# Env: TALOS_TOOLS_CACHE (downloads; default apps/desktop/.build/tools-cache), TALOS_TOOLS_MIRROR (a folder that holds the files
# by name instead of the network: tests), TALOS_TOOLS_ONLY=bun|tmux|claude (tests).
# tmux is built here from source (about two minutes, once per version: the result is cached beside the downloads) against a static
# libevent and the system's ncurses, so the binary needs nothing from the Mac but system libraries; no Homebrew or conda is used.
# The result carries no path of this Mac (the compiler maps the build folder away and the symbols are stripped).
# Exit codes: 0 done; 9 a download did not match its pin; 1 a step failed; 64 bad arguments.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"

BUN_VERSION=1.4.4
BUN_SHA_ARM64=c240d7f0ccb90c263a849fcdb09b7ee62630d921348ed6aafda86b9d577bc510
BUN_SHA_X64=50a3491f73abc2fe81673171a85762d3bc2cc1680ccecadd983de99adf77977e
TMUX_VERSION=3.8
TMUX_SHA=e79c699c7e949dccd0a4a125e17b8d1261e311b16979dbc8eb34542f3966d82e
UTF8PROC_VERSION=2.12.0
UTF8PROC_SHA=f564011d38b2888d583d510b08e69ffa15aa117155db1b9b49ef1dfe1fa25111
LIBEVENT_VERSION=2.1.13-stable
LIBEVENT_SHA=f7e9383b8c0baa81b687e5b5eecc01beefaf1b19b64151d95ed61647fe7a315c
BUN_URL="https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION"
TMUX_URL="https://github.com/tmux/tmux/releases/download/$TMUX_VERSION/tmux-$TMUX_VERSION.tar.gz"
UTF8PROC_URL="https://github.com/JuliaStrings/utf8proc/archive/refs/tags/v$UTF8PROC_VERSION.tar.gz"
CLAUDE_INSTALL_SHA=2c5506d110560bf618bbe88f678f2c2a0047c86a9c6585fc84976120b1de0b44   # the same pin as ClaudeInstaller.swift
CLAUDE_INSTALL_URL="https://claude.ai/install.sh"
LIBEVENT_URL="https://github.com/libevent/libevent/releases/download/release-$LIBEVENT_VERSION/libevent-$LIBEVENT_VERSION.tar.gz"

OUT="" ARCH=universal
while [ $# -gt 0 ]; do
  case "$1" in
    --out) [ $# -ge 2 ] || { echo "bundle-tools: --out needs a folder" >&2; exit 64; }; OUT="$2"; shift 2 ;;
    --arch) [ $# -ge 2 ] || exit 64; case "$2" in universal|arm64) ARCH="$2" ;; *) echo "bundle-tools: --arch is universal or arm64" >&2; exit 64 ;; esac; shift 2 ;;
    *) echo "bundle-tools: unknown argument $1" >&2; exit 64 ;;
  esac
done
[ -n "$OUT" ] || { echo "bundle-tools: --out DIR is required" >&2; exit 64; }
CACHE="${TALOS_TOOLS_CACHE:-$HERE/.build/tools-cache}"
mkdir -p "$CACHE"
die() { echo "bundle-tools: $*" >&2; exit "${2:-1}"; }
sha_of() { /usr/bin/shasum -a 256 "$1" | awk '{print $1}'; }

# fetch NAME URL SHA: into the cache, checked. A cached file that does not match is fetched again, never trusted.
fetch() {
  local name="$1" url="$2" want="$3" dest="$CACHE/$1"
  if [ -f "$dest" ] && [ "$(sha_of "$dest")" = "$want" ]; then return 0; fi
  rm -f "$dest.part"
  if [ -n "${TALOS_TOOLS_MIRROR:-}" ]; then cp "$TALOS_TOOLS_MIRROR/$name" "$dest.part" || die "$name is not in the mirror" 1
  else /usr/bin/curl --proto '=https' --tlsv1.2 -fsSL --retry 2 --max-time 600 -o "$dest.part" "$url" || { rm -f "$dest.part"; die "could not download $url" 1; }; fi
  if [ "$(sha_of "$dest.part")" != "$want" ]; then
    rm -f "$dest.part"
    die "$name does not match its pinned sha256 ($want); refusing it. Nothing was bundled." 9
  fi
  mv "$dest.part" "$dest"
}

want_tool() { [ -z "${TALOS_TOOLS_ONLY:-}" ] || [ "$TALOS_TOOLS_ONLY" = "$1" ]; }
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/talos-tools-XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/bin" "$STAGE/licenses"

# ---- bun: the release's own zips, one per architecture, joined for a universal app
if want_tool bun; then
  fetch "bun-darwin-aarch64-$BUN_VERSION.zip" "$BUN_URL/bun-darwin-aarch64.zip" "$BUN_SHA_ARM64"
  /usr/bin/unzip -q -o "$CACHE/bun-darwin-aarch64-$BUN_VERSION.zip" -d "$STAGE/bun-arm64"
  if [ "$ARCH" = universal ]; then
    fetch "bun-darwin-x64-$BUN_VERSION.zip" "$BUN_URL/bun-darwin-x64.zip" "$BUN_SHA_X64"
    /usr/bin/unzip -q -o "$CACHE/bun-darwin-x64-$BUN_VERSION.zip" -d "$STAGE/bun-x64"
    /usr/bin/lipo -create "$STAGE/bun-arm64/bun-darwin-aarch64/bun" "$STAGE/bun-x64/bun-darwin-x64/bun" -output "$STAGE/bin/bun"
  else
    cp "$STAGE/bun-arm64/bun-darwin-aarch64/bun" "$STAGE/bin/bun"
  fi
  chmod 0755 "$STAGE/bin/bun"
  { echo "bun $BUN_VERSION (https://github.com/oven-sh/bun)"; echo; cat <<'MIT'
MIT License

Copyright (c) Oven.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
MIT
  } > "$STAGE/licenses/bun.txt"
fi

# ---- Claude Code's installer script: the exact pinned bytes, shipped inside the app (nothing is downloaded at install time)
if want_tool claude; then
  fetch "claude-install-$CLAUDE_INSTALL_SHA.sh" "$CLAUDE_INSTALL_URL" "$CLAUDE_INSTALL_SHA"
  cp "$CACHE/claude-install-$CLAUDE_INSTALL_SHA.sh" "$STAGE/claude-install.sh"
fi

# ---- tmux: from source, libevent static, system ncurses
if want_tool tmux; then
  BUILT="$CACHE/tmux-$TMUX_VERSION-libevent-$LIBEVENT_VERSION-utf8proc-$UTF8PROC_VERSION-$ARCH"
  if [ ! -x "$BUILT/tmux" ]; then
    fetch "tmux-$TMUX_VERSION.tar.gz" "$TMUX_URL" "$TMUX_SHA"
    fetch "libevent-$LIBEVENT_VERSION.tar.gz" "$LIBEVENT_URL" "$LIBEVENT_SHA"
    fetch "utf8proc-$UTF8PROC_VERSION.tar.gz" "$UTF8PROC_URL" "$UTF8PROC_SHA"
    SRC="$STAGE/src"; mkdir -p "$SRC" "$STAGE/prefix"
    /usr/bin/tar -xzf "$CACHE/libevent-$LIBEVENT_VERSION.tar.gz" -C "$SRC"
    /usr/bin/tar -xzf "$CACHE/tmux-$TMUX_VERSION.tar.gz" -C "$SRC"
    /usr/bin/tar -xzf "$CACHE/utf8proc-$UTF8PROC_VERSION.tar.gz" -C "$SRC"
    ARCHFLAGS="-arch arm64"; [ "$ARCH" = universal ] && ARCHFLAGS="-arch arm64 -arch x86_64"
    MAP="-ffile-prefix-map=$SRC=/src -ffile-prefix-map=$STAGE=/build"
    # a clean PATH: no Homebrew pkg-config, compilers or libraries may leak into what ships
    export MACOSX_DEPLOYMENT_TARGET=14.0 PATH=/usr/bin:/bin:/usr/sbin:/sbin
    unset PKG_CONFIG_PATH LIBRARY_PATH CPATH C_INCLUDE_PATH CFLAGS LDFLAGS CPPFLAGS
    ( cd "$SRC/libevent-$LIBEVENT_VERSION" \
      && CFLAGS="$ARCHFLAGS $MAP -O2" ./configure --prefix="$STAGE/prefix" --disable-shared --enable-static --disable-openssl --disable-samples \
           --disable-libevent-regress --disable-dependency-tracking >"$STAGE/libevent.log" 2>&1 \
      && make -j4 >>"$STAGE/libevent.log" 2>&1 && make install >>"$STAGE/libevent.log" 2>&1 ) || { tail -20 "$STAGE/libevent.log" >&2; die "libevent did not build"; }
    ( cd "$SRC/utf8proc-$UTF8PROC_VERSION" \
      && make libutf8proc.a CFLAGS="$ARCHFLAGS $MAP -O2 -DUTF8PROC_STATIC" >"$STAGE/utf8proc.log" 2>&1 \
      && mkdir -p "$STAGE/prefix/include" "$STAGE/prefix/lib" && cp utf8proc.h "$STAGE/prefix/include/" && cp libutf8proc.a "$STAGE/prefix/lib/" ) \
      || { tail -20 "$STAGE/utf8proc.log" >&2; die "utf8proc did not build"; }
    ( cd "$SRC/tmux-$TMUX_VERSION" \
      && CFLAGS="$ARCHFLAGS $MAP -O2" LDFLAGS="$ARCHFLAGS" \
         LIBEVENT_CFLAGS="-I$STAGE/prefix/include" LIBEVENT_LIBS="$STAGE/prefix/lib/libevent_core.a" \
         LIBUTF8PROC_CFLAGS="-I$STAGE/prefix/include -DUTF8PROC_STATIC" LIBUTF8PROC_LIBS="$STAGE/prefix/lib/libutf8proc.a" \
         ./configure --disable-dependency-tracking --enable-utf8proc --disable-jemalloc >"$STAGE/tmux.log" 2>&1 \
      && make -j4 >>"$STAGE/tmux.log" 2>&1 ) || { tail -20 "$STAGE/tmux.log" >&2; die "tmux did not build"; }
    mkdir -p "$BUILT.tmp"; cp "$SRC/tmux-$TMUX_VERSION/tmux" "$BUILT.tmp/tmux"
    # the projects' own licence texts, shipped beside the binary they are linked into
    { echo "tmux $TMUX_VERSION"; cat "$SRC/tmux-$TMUX_VERSION/COPYING"
      printf '\n\n-----\nlibevent %s (linked statically into tmux)\n' "$LIBEVENT_VERSION"; cat "$SRC/libevent-$LIBEVENT_VERSION/LICENSE"
      printf '\n\n-----\nutf8proc %s (linked statically into tmux)\n' "$UTF8PROC_VERSION"; cat "$SRC/utf8proc-$UTF8PROC_VERSION/LICENSE.md"; } > "$BUILT.tmp/licenses.txt"
    /usr/bin/strip -x "$BUILT.tmp/tmux"
    rm -rf "$BUILT"; mv "$BUILT.tmp" "$BUILT"
  fi
  # only system libraries may be named by the binary
  BAD="$(/usr/bin/otool -L "$BUILT/tmux" | grep -E '^[[:space:]]' | awk '{print $1}' | grep -vE '^(/usr/lib/|/System/)' || true)"
  [ -z "$BAD" ] || die "the tmux build depends on a library outside the system: $BAD"
  cp "$BUILT/tmux" "$STAGE/bin/tmux"; chmod 0755 "$STAGE/bin/tmux"
  cp "$BUILT/licenses.txt" "$STAGE/licenses/tmux.txt"
fi

rm -rf "$OUT"
mkdir -p "$(dirname "$OUT")"
mv "$STAGE" "$OUT"
rm -rf "$OUT/src" "$OUT/prefix" "$OUT"/bun-* "$OUT"/*.log
trap - EXIT
echo "bundle-tools: bun $BUN_VERSION and tmux $TMUX_VERSION ($ARCH) are in $OUT/bin"
