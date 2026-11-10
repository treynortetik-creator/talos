#!/bin/bash
# Does a Keychain item survive a rebuild signed with the owner's team? (Part 2 of the dev-channels card: the LaunchTrust seal.)
#   TALOS_SIGN_ID="Apple Development: you@example.com (ABCDE12345)"  keychain-survival-probe.sh
# With no TALOS_SIGN_ID it takes the first codesigning identity whose certificate carries team $TALOS_TEAM_ID (required when TALOS_SIGN_ID is unset).
#
# Safe by construction: it touches ONE item, a generic password under a service name it makes up (com.talos.survival-probe.<random>),
# and nothing else. It never reads, lists, changes or deletes any other item. Keychain user interaction is switched off for every call
# (SecKeychainSetUserInteractionAllowed(false) plus kSecUseAuthenticationUIFail), so a read the keychain would ask about FAILS instead
# of showing a prompt. The item is deleted at the end by the same binary that made it.
#
# Steps: build the tiny probe, sign it, write the item; change the source, rebuild at the same path and sign again; read the item back
# with the rebuilt binary (SURVIVES = it read the same bytes with no prompt). Control: rebuild once more signed AD HOC and read again
# (expected to FAIL, which proves the check can tell). Prints SURVIVES, or DOES NOT SURVIVE with the OSStatus. Prints only names and
# team ids of identities, never exports anything.
set -euo pipefail
TEAM="${TALOS_TEAM_ID:-}"
if [ -z "${TALOS_SIGN_ID:-}" ] && [ -z "$TEAM" ]; then echo "keychain-survival-probe: set TALOS_SIGN_ID, or TALOS_TEAM_ID to pick an identity" >&2; exit 64; fi
ID="${TALOS_SIGN_ID:-}"
if [ -z "$ID" ]; then
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    ou="$(security find-certificate -c "$name" -p 2>/dev/null | openssl x509 -noout -subject 2>/dev/null | sed -E 's/.*OU ?= ?([A-Z0-9]+).*/\1/')"
    if [ "$ou" = "$TEAM" ]; then ID="$name"; break; fi
  done < <(security find-identity -v -p codesigning 2>/dev/null | sed -nE 's/^ *[0-9]+\) [0-9A-F]+ "(.*)"$/\1/p')
fi
if [ -z "$ID" ]; then
  echo "NO IDENTITY: no valid codesigning identity for team $TEAM on this Mac (set TALOS_SIGN_ID). Nothing was written to the Keychain." >&2
  exit 2
fi
echo "signing identity: $ID"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/talos-kc-probe.XXXXXX")"
SERVICE="com.talos.survival-probe.$(uuidgen | tr 'A-Z' 'a-z')"
BIN="$WORK/probe"
cleanup() {
  # The item's access list names the binary by its PATH and signature, so it is deleted by a signed build AT THE SAME PATH (a copy
  # elsewhere is refused with -25244). If that did not happen the service name is printed so the one item can be removed by hand.
  if [ "$DELETED" != yes ]; then echo "NOT DELETED: remove the generic password with service $SERVICE (Keychain Access, search \"survival-probe\")" >&2; fi
  rm -rf "$WORK"
}
DELETED=no
trap cleanup EXIT
write_src() {
  cat >"$WORK/probe.swift" <<SRC
import Foundation
import Security
// build tag: $1
SecKeychainSetUserInteractionAllowed(false)
let a = CommandLine.arguments
guard a.count == 3 else { exit(64) }
func q(_ service: String) -> [String: Any] {
  [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: "probe",
   kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail]
}
switch a[1] {
case "write":
  var d = q(a[2]); d[kSecValueData as String] = Data("probe-secret".utf8); d[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
  let s = SecItemAdd(d as CFDictionary, nil); print("write", s); exit(s == errSecSuccess ? 0 : 1)
case "read":
  var d = q(a[2]); d[kSecReturnData as String] = true; d[kSecMatchLimit as String] = kSecMatchLimitOne
  var out: CFTypeRef?; let s = SecItemCopyMatching(d as CFDictionary, &out)
  if s == errSecSuccess, let data = out as? Data, String(decoding: data, as: UTF8.self) == "probe-secret" { print("read ok"); exit(0) }
  print("read", s); exit(1)
case "delete":
  let s = SecItemDelete(q(a[2]) as CFDictionary); print("delete", s); exit(s == errSecSuccess || s == errSecItemNotFound ? 0 : 1)
default: exit(64)
}
SRC
}
build() { # $1 tag, $2 sign identity ('-' = ad hoc)
  write_src "$1"
  swiftc -O -o "$BIN" "$WORK/probe.swift" 2>"$WORK/swiftc.log" || { cat "$WORK/swiftc.log" >&2; exit 3; }
  codesign --force --sign "$2" --identifier com.talos.survival-probe "$BIN" 2>/dev/null
}
build v1 "$ID"
echo "service: $SERVICE"
echo "first build: $(codesign -dv "$BIN" 2>&1 | grep -E '^(Identifier|TeamIdentifier)=' | tr '\n' ' ')"
"$BIN" write "$SERVICE"
build v2 "$ID"
echo "rebuilt:     $(codesign -dv "$BIN" 2>&1 | grep -E '^(Identifier|TeamIdentifier)=' | tr '\n' ' ') (a different binary: $(cmp -s "$BIN" "$WORK/probe.signed" && echo NO || echo yes))"
if "$BIN" read "$SERVICE"; then RESULT="SURVIVES"; else RESULT="DOES NOT SURVIVE"; fi
build v3 "-"
if "$BIN" read "$SERVICE"; then CONTROL="the ad hoc rebuild could read it (the check cannot tell)"; else CONTROL="the ad hoc rebuild could not read it (the check can tell)"; fi
echo "control: $CONTROL"
build v4 "$ID"
if "$BIN" delete "$SERVICE"; then DELETED=yes; echo "cleanup: the probe item is deleted"; fi
echo "RESULT: $RESULT"
[ "$RESULT" = SURVIVES ]
