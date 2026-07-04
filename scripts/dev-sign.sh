#!/bin/bash
# dev-sign.sh (#108): sign a debug LiveCap.app with a STABLE self-signed
# identity ("LiveCap Dev") so macOS TCC grants (mic, system audio) persist
# across rebuilds. Ad-hoc signing (`codesign --sign -`) produces a new cdhash
# every build, which resets all TCC grants and costs one operator
# SecurityAgent click per iteration; a named identity keeps the designated
# requirement stable so grants survive.
#
# Usage:
#   scripts/dev-sign.sh [path/to/LiveCap.app]
#   (default: src-tauri/target/debug/bundle/macos/LiveCap.app)
#
# What it does:
#   1. If no "LiveCap Dev" codesigning identity exists in the login keychain,
#      creates one: an openssl self-signed cert with the codeSigning EKU,
#      imported via `security import`, trusted for code signing via
#      `security add-trusted-cert`. macOS may show ONE GUI password prompt
#      for the trust step, and ONE "codesign wants to use key" prompt on the
#      first signing (click "Always Allow") — both are one-time.
#   2. Signs the .app with that identity and re-registers it with
#      LaunchServices.
set -euo pipefail

IDENTITY="LiveCap Dev"
APP="${1:-src-tauri/target/debug/bundle/macos/LiveCap.app}"
LOGIN_KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

if [ ! -d "$APP" ]; then
  echo "error: app bundle not found: $APP" >&2
  echo "build it first: pnpm tauri build --debug (or pass the bundle path)" >&2
  exit 1
fi

have_identity() {
  security find-identity -v -p codesigning "$LOGIN_KEYCHAIN" 2>/dev/null \
    | grep -q "\"$IDENTITY\""
}

print_manual_steps() {
  cat >&2 <<EOF

Automated certificate creation failed. One-time manual fallback:
  1. Open Keychain Access → menu: Keychain Access → Certificate Assistant
     → Create a Certificate…
  2. Name: $IDENTITY
     Identity Type: Self-Signed Root
     Certificate Type: Code Signing
  3. Click Create, then Done. The cert lands in the login keychain.
  4. Re-run this script — it will find the identity and sign.
EOF
}

create_identity() {
  echo "creating self-signed codesigning identity \"$IDENTITY\" (one-time)…"
  local tmp
  tmp=$(mktemp -d)
  # shellcheck disable=SC2064  # expand $tmp now, not at trap time
  trap "rm -rf '$tmp'" EXIT

  # Self-signed cert with the Code Signing extended key usage (what
  # Certificate Assistant's "Code Signing" template produces). 10 years.
  openssl req -x509 -newkey rsa:2048 -days 3650 -nodes \
    -keyout "$tmp/key.pem" -out "$tmp/cert.pem" \
    -subj "/CN=$IDENTITY" \
    -addext "keyUsage=critical,digitalSignature" \
    -addext "extendedKeyUsage=critical,codeSigning" \
    -addext "basicConstraints=critical,CA:FALSE"

  # Bundle key+cert and import into the login keychain; -T pre-authorizes
  # /usr/bin/codesign to use the private key.
  openssl pkcs12 -export -name "$IDENTITY" \
    -inkey "$tmp/key.pem" -in "$tmp/cert.pem" \
    -out "$tmp/livecap-dev.p12" -passout pass:livecap-dev
  security import "$tmp/livecap-dev.p12" -k "$LOGIN_KEYCHAIN" \
    -P livecap-dev -T /usr/bin/codesign

  # Trust the cert for code signing (user trust domain). macOS shows one GUI
  # password prompt for this; that is the single interactive step.
  security add-trusted-cert -p codeSign -k "$LOGIN_KEYCHAIN" "$tmp/cert.pem"
}

if have_identity; then
  echo "identity \"$IDENTITY\" already present — reusing (TCC grants persist)"
else
  if ! create_identity || ! have_identity; then
    print_manual_steps
    exit 1
  fi
  echo "identity \"$IDENTITY\" created"
fi

echo "signing $APP …"
codesign --force --deep --sign "$IDENTITY" "$APP"
codesign --verify --deep --strict "$APP"
codesign --display --verbose=2 "$APP" 2>&1 | grep -E '^(Identifier|Authority|CDHash)=' || true

# Refresh LaunchServices so `open` and computer-use resolve the new bundle.
/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister -f "$APP"

echo "done — launch with: open \"$APP\""
