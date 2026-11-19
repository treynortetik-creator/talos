#!/usr/bin/env bash
# rpath-scrub-test.sh: rpath-scrub.sh on a real universal binary (two slices) that carries the rpaths a build Mac adds: one into an
# Xcode toolchain under the home folder (a Mac whose Xcode sits in Downloads), one under /Applications, and the two that must stay.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; SCRUB="$HERE/rpath-scrub.sh"
T="$(mktemp -d "${TMPDIR:-/tmp}/talos-rpath-test-XXXXXX")"; trap 'rm -rf "$T"' EXIT
fails=0; ok() { echo "  ok   $1"; }; bad() { echo "  FAIL $1"; fails=$((fails + 1)); }
printf 'int main(void){return 0;}\n' > "$T/m.c"
/usr/bin/clang -Wl,-headerpad_max_install_names -arch arm64 -o "$T/a" "$T/m.c" && /usr/bin/clang -Wl,-headerpad_max_install_names -arch x86_64 -o "$T/x" "$T/m.c" && /usr/bin/lipo -create "$T/a" "$T/x" -output "$T/bin" \
  || { echo "rpath-scrub-test: could not build a universal test binary"; exit 1; }
TC="Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift-6.2/macosx"
for r in /usr/lib/swift @loader_path "$HOME/Downloads/Xcode.app/Contents/$TC" "/Applications/Xcode.app/Contents/$TC"; do
  /usr/bin/install_name_tool -add_rpath "$r" "$T/bin"
done
rpaths() { /usr/bin/lipo "$T/bin" -thin "$1" -output "$T/s-$1" && /usr/bin/otool -l "$T/s-$1" | /usr/bin/awk '/cmd LC_RPATH/{r=1;next} r&&/path /{sub(/^ *path /,"");sub(/ \(offset [0-9]+\)$/,"");print;r=0}' | sort | tr '\n' '|'; }
[ "$(rpaths arm64)" = "$(printf '%s\n' /usr/lib/swift @loader_path "$HOME/Downloads/Xcode.app/Contents/$TC" "/Applications/Xcode.app/Contents/$TC" | sort | tr '\n' '|')" ] \
  && ok "the test binary carries the four rpaths in its arm64 slice" || bad "the test binary was not set up as meant"
bash "$SCRUB" "$T/bin" >/dev/null; rc=$?
[ $rc = 0 ] && ok "scrub exits 0" || bad "scrub exited $rc"
want="$(printf '%s\n' /usr/lib/swift @loader_path | sort | tr '\n' '|')"
for a in arm64 x86_64; do [ "$(rpaths $a)" = "$want" ] && ok "$a keeps only /usr/lib/swift and @loader_path" || bad "$a rpaths left: $(rpaths $a)"; done
bash "$SCRUB" "$T/bin" >/dev/null && [ "$(rpaths arm64)" = "$want" ] && ok "a second run changes nothing" || bad "a second run failed or changed the file"
/usr/bin/codesign -s - -f "$T/bin" 2>/dev/null; "$T/bin" && ok "the scrubbed binary still runs" || bad "the scrubbed binary does not run"
bash "$SCRUB" "$T/none" >/dev/null 2>&1; [ $? = 64 ] && ok "a missing file is a usage error" || bad "a missing file was not refused"
[ $fails = 0 ] && echo "rpath-scrub-test: all passed" || { echo "rpath-scrub-test: $fails failed"; exit 1; }
