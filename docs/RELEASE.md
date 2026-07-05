# LiveCap Release Runbook

How a LiveCap release is cut. The pipeline lives in `.github/workflows/release.yml`
and is triggered by pushing a `v*` tag. It builds a macOS (Apple silicon,
`aarch64-apple-darwin`) DMG, generates SHA-256 checksums, and attaches both to a
**draft** GitHub Release.

Signing and notarization are wired in but **optional**: when the Apple secrets
below are not configured, the workflow still completes end-to-end and produces
an **unsigned** DMG (users must right-click → Open on first launch). Once the
operator adds the secrets (gate #14), the exact same tag flow produces a signed
and notarized build — no workflow changes needed.

Security invariants: credentials live in GitHub Actions secrets ONLY. Never
commit signing material, never paste secret values into issues/PRs/logs, and
never echo them in workflow steps (per `SECURITY.md`).

---

## Part A — Operator one-time setup (signing + notarization)

Everything in this section is operator-owned and done exactly once (until the
certificate expires, ~5 years).

### A1. Apple Developer Program membership

1. Enroll at <https://developer.apple.com/programs/enroll/> (USD 99/year) with
   your Apple Account.
2. Wait for the membership to be active (usually < 48h). Note your **Team ID**:
   <https://developer.apple.com/account> → Membership details → Team ID
   (10-character string).

### A2. Create a "Developer ID Application" certificate

This is the certificate type for apps distributed **outside** the Mac App
Store. Easiest path is Xcode:

1. Xcode → Settings… → Accounts → select your Apple Account → your team →
   "Manage Certificates…".
2. Click **+** → **Developer ID Application**. The certificate and its private
   key land in your login keychain.

(Alternative without Xcode: Keychain Access → Certificate Assistant → "Request
a Certificate From a Certificate Authority…" to create a CSR, then upload it at
<https://developer.apple.com/account/resources/certificates/add> choosing
"Developer ID Application", download the `.cer`, and double-click to install.)

### A3. Export the certificate to a password-protected `.p12`

1. Keychain Access → login keychain → "My Certificates" category.
2. Find `Developer ID Application: <Your Name> (<TEAMID>)` — expand it and
   confirm the private key is attached.
3. Right-click the certificate → "Export…" → format **Personal Information
   Exchange (.p12)** → save as `livecap-developer-id.p12` → set a strong
   export password (this becomes `APPLE_CERTIFICATE_PASSWORD`).
4. Base64-encode it (this becomes `APPLE_CERTIFICATE`):

   ```sh
   base64 -i livecap-developer-id.p12 -o livecap-developer-id.p12.b64
   ```

5. Note the exact identity string (this becomes `APPLE_SIGNING_IDENTITY`):

   ```sh
   security find-identity -v -p codesigning
   # → e.g.  "Developer ID Application: Your Name (TEAMID1234)"
   ```

### A4. Create an app-specific password (for notarization)

1. Sign in at <https://account.apple.com> → Sign-In and Security →
   **App-Specific Passwords** → generate one named e.g. `livecap-notarytool`.
2. This becomes `APPLE_PASSWORD`. Your Apple Account e-mail is `APPLE_ID`.

### A5. Set the six GitHub Actions secrets

From a clone of the repo (values are prompted interactively or read from a
file — they never appear in shell history or the repo):

```sh
gh secret set APPLE_CERTIFICATE < livecap-developer-id.p12.b64
gh secret set APPLE_CERTIFICATE_PASSWORD   # paste the .p12 export password at the prompt
gh secret set APPLE_SIGNING_IDENTITY       # paste e.g. Developer ID Application: Your Name (TEAMID1234)
gh secret set APPLE_ID                     # paste your Apple Account e-mail
gh secret set APPLE_PASSWORD               # paste the app-specific password
gh secret set APPLE_TEAM_ID                # paste the 10-character Team ID
```

All six are the standard Tauri v2 macOS signing/notarization env vars — the
workflow passes them straight to `tauri build`, which imports the certificate
into a temporary keychain, codesigns the app, and submits it to Apple's notary
service (then staples the ticket).

Presence rules enforced by the workflow:

- All of `APPLE_CERTIFICATE` + `APPLE_CERTIFICATE_PASSWORD` +
  `APPLE_SIGNING_IDENTITY` → build is **signed**.
- Additionally all of `APPLE_ID` + `APPLE_PASSWORD` + `APPLE_TEAM_ID` → build
  is also **notarized**.
- Anything missing → the affected stage is skipped gracefully (a
  notice/warning is logged; the workflow still succeeds).

### A6. Clean up local material

```sh
rm livecap-developer-id.p12 livecap-developer-id.p12.b64
```

The keychain copy of the certificate is the only local artifact you keep.

---

## Part B — Per-release steps (agent-runnable)

### B1. Bump the version

The version lives in **three** files and must match the tag (the workflow's
first step fails the release if they diverge):

| File | Field |
|---|---|
| `package.json` | `"version"` |
| `src-tauri/tauri.conf.json` | `"version"` |
| `src-tauri/Cargo.toml` | `version` under `[package]` |

After editing `src-tauri/Cargo.toml`, refresh the lockfile so `Cargo.lock`
picks up the new `livecap-app` version:

```sh
cargo check --workspace
```

Land the bump through the normal PR flow (branch → PR → review → merge). Never
commit directly to `main`.

### B2. Tag and push

From the merged `main` commit:

```sh
git checkout main && git pull
git tag vX.Y.Z
git push origin vX.Y.Z
```

Pushing the tag triggers `.github/workflows/release.yml`. (For a dry run that
doesn't consume the real version's tag, use a pre-release suffix such as
`vX.Y.Z-dry.1` — the version check only compares the `X.Y.Z` core.)

### B3. What the workflow does

1. Verifies the tag matches the three version fields (B1).
2. `pnpm install --frozen-lockfile` → `pnpm build` → `pnpm tauri build
   --target aarch64-apple-darwin` (DMG + .app bundles per
   `src-tauri/tauri.conf.json`).
3. Signs and notarizes **iff** the Part A secrets are present; otherwise logs
   a notice and continues unsigned.
4. Writes `SHA256SUMS.txt` over the DMG.
5. Creates a **draft** GitHub Release for the tag (generated notes) and
   uploads `LiveCap_X.Y.Z_aarch64.dmg` + `SHA256SUMS.txt`. Re-runs of the same
   tag re-upload artifacts onto the existing draft.

### B4. Verify the draft

1. Download both assets from the draft release (repo → Releases → the draft).
2. Verify the checksum:

   ```sh
   shasum -a 256 -c SHA256SUMS.txt
   ```

3. Mount the DMG, drag `LiveCap.app` to `/Applications`, and launch it on
   real hardware.
4. For **signed** builds also confirm Gatekeeper acceptance:

   ```sh
   codesign -dv --verbose=2 /Applications/LiveCap.app   # Developer ID identity shown
   spctl -a -vv -t exec /Applications/LiveCap.app       # "accepted", "Notarized Developer ID"
   xcrun stapler validate /Applications/LiveCap.app     # "The validate action worked!"
   ```

   For **unsigned** builds, `spctl` rejection is expected — first launch is
   right-click → Open.

### B5. Publish

Edit the draft release notes if needed, then publish it (operator decision —
the workflow never auto-publishes). The tag's release page URL becomes the
canonical download link.

### B6. Homebrew cask follow-up (post-first-release, per #14)

After the **first published** (signed) release, add a Homebrew cask so
`brew install --cask livecap` works:

1. Create the cask (own tap `realproject7/homebrew-tap` first; homebrew-cask
   upstream once the notability bar is met) pointing at the release DMG URL,
   with the `sha256` from `SHA256SUMS.txt` and `version`.
2. On every subsequent release, bump the cask's `version` + `sha256`.
3. Only then flip the README Quick Start from "planned" to real install
   instructions (tracked by #14 — not part of this pipeline).
