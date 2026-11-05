#!/usr/bin/env bash
# One-time, free, local code-signing identity so macOS privacy grants (Desktop folder, microphone, ...) survive rebuilds.
# An ad-hoc signature is the hash of the binary, so every build looks like a new app; a certificate-based identity does not.
#
#   make-signing-identity.sh              create it (idempotent) and trust it for code signing (ONE password prompt)
#   make-signing-identity.sh --status     exit 0 if the certificate exists in the keychain, else 1
#   make-signing-identity.sh --remove     delete the identity and its trust setting (no-op when absent)
#   --no-trust                            skip the trust step (tests; a trusted identity is what codesign needs)
# Env: TALOS_IDENTITY_NAME (default "Talos Local Signing"), TALOS_KEYCHAIN (default login keychain),
#      TALOS_KEYCHAIN_PASSWORD (unlock a non-default keychain, tests only).
set -euo pipefail
NAME="${TALOS_IDENTITY_NAME:-Talos Local Signing}"
KC="${TALOS_KEYCHAIN:-$HOME/Library/Keychains/login.keychain-db}"
ACTION=create TRUST=1
for a in "$@"; do
  case "$a" in
    --status) ACTION=status ;;
    --remove) ACTION=remove ;;
    --no-trust) TRUST=0 ;;
    *) echo "make-signing-identity: unknown argument $a" >&2; exit 64 ;;
  esac
done

# Exact-name matching only. `security find-certificate -c` / `delete-identity -c` match a case-insensitive SUBSTRING of
# the common name, so they would find (and delete) "Owner Talos Local Signing Backup". Select by exact label, act by SHA-1.
hashes() { security find-certificate -a -c "$NAME" -Z "$KC" 2>/dev/null | awk -v n="$NAME" \
  '/^SHA-1 hash:/{h=$3} /"labl"<blob>=/{l=$0; sub(/.*"labl"<blob>="/,"",l); sub(/"$/,"",l); if (l==n) print h}'; }
exists() { [ -n "$(hashes)" ]; }
# "Usable" = listed by find-identity -v (certificate + key + trusted for code signing), not merely present.
usable() { local h; for h in $(hashes); do security find-identity -v -p codesigning "$KC" 2>/dev/null | grep -qF "$h" && return 0; done; return 1; }
trust_step() { # trust_step <cert.pem>
  echo "macOS will ask for your password once to trust this certificate for code signing."
  security add-trusted-cert -r trustRoot -p codeSign -k "$KC" "$1"
}
[ -n "${TALOS_KEYCHAIN_PASSWORD:-}" ] && security unlock-keychain -p "$TALOS_KEYCHAIN_PASSWORD" "$KC" >/dev/null 2>&1

case "$ACTION" in
  status)
    if usable; then echo "present and trusted: $NAME"; exit 0
    elif exists; then echo "present but NOT trusted for code signing: $NAME (run make-signing-identity.sh again)"; exit 3
    else echo "absent: $NAME"; exit 1; fi ;;
  remove)
    if ! exists; then echo "nothing to remove ($NAME is not in the keychain)"; exit 0; fi
    for h in $(hashes); do   # -t also deletes the user trust setting
      security delete-identity -Z "$h" -t "$KC" >/dev/null 2>&1 || security delete-certificate -Z "$h" -t "$KC" >/dev/null 2>&1 || true
    done
    if exists; then echo "could not remove every certificate named: $NAME" >&2; exit 1; fi
    echo "removed: $NAME"; exit 0 ;;
esac

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
if exists; then
  if usable; then echo "already present and trusted: $NAME"; exit 0; fi
  if [ "$TRUST" = 0 ]; then echo "present but not trusted (--no-trust: leaving it): $NAME"; exit 0; fi
  # A cancelled trust prompt last time: certificate imported, never trusted. Redo only the trust step.
  h="$(hashes | head -1)"
  security find-certificate -a -Z -p -c "$NAME" "$KC" 2>/dev/null | awk -v h="$h" \
    '/^SHA-1 hash:/{on=($3==h)} on&&/BEGIN CERTIFICATE/{p=1} p{print} /END CERTIFICATE/{p=0}' > "$T/existing.pem"
  [ -s "$T/existing.pem" ] || { echo "could not read the existing certificate" >&2; exit 1; }
  trust_step "$T/existing.pem"
  echo "trusted: $NAME"; exit 0
fi

cat > "$T/openssl.cnf" <<CNF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $NAME
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
CNF
OPENSSL=/usr/bin/openssl   # LibreSSL: its .p12 imports cleanly (Homebrew OpenSSL 3 would need -legacy)
"$OPENSSL" req -x509 -newkey rsa:2048 -nodes -days 3650 -config "$T/openssl.cnf" -keyout "$T/key.pem" -out "$T/cert.pem" 2>/dev/null
"$OPENSSL" pkcs12 -export -inkey "$T/key.pem" -in "$T/cert.pem" -out "$T/id.p12" -passout pass:talos 2>/dev/null
security import "$T/id.p12" -k "$KC" -P talos -T /usr/bin/codesign >/dev/null
[ "$TRUST" = 0 ] || trust_step "$T/cert.pem"
echo "created: $NAME"
