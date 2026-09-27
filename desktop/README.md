# Nerya Desktop · 1.0.0 Beta

The Tauri application starts the real Python runtime and standalone Next.js server.
Its installer contains portable Python, Node and Playwright Chromium. It does not
freeze Python into a single executable: Skills need a working `sys.executable` to
launch their own scripts.

## Installation

Download a completed build from [GitHub Releases](https://github.com/NeryaAI/Nerya/releases).
Choose the correct CPU architecture and verify the download against `SHA256SUMS.txt`.

| System | CPU | Installer |
| --- | --- | --- |
| macOS | Apple Silicon | `Nerya-1.0.0-beta.1-macos-arm64.dmg` / `.pkg` |
| macOS | Intel | `Nerya-1.0.0-beta.1-macos-x64.dmg` / `.pkg` |
| Windows | x64 | `Nerya-1.0.0-beta.1-windows-x64.exe` / `.msi` |
| Linux | x64 | `Nerya-1.0.0-beta.1-linux-x64.deb` / `.AppImage` |

macOS: open the disk image and copy Nerya into Applications, or use the package
installer. Windows: use either the NSIS or MSI installer, not both. Linux: prefer
the Debian package on the Ubuntu 22.04 build baseline so the package manager can
resolve declared dependencies. AppImage still requires compatible host libraries
and, when mounting normally, FUSE.

The bundled browser's supported baseline is macOS 14+, Windows 11+ (or Windows
Server 2019+) and supported Ubuntu/Debian releases. The macOS bundle minimum is set
to 14.0 accordingly; a lower minimum for the Rust shell would not make the bundled
browser compatible with older systems. See [Playwright system requirements](https://playwright.dev/python/docs/intro#system-requirements).

No Python, Node, Rust or package manager is needed by desktop users. Windows bundles
the offline WebView2 installer. Linux is not a fully static distribution: GTK,
WebKitGTK and Chromium's shared-library dependencies must be available on the host.
Linux desktop sessions without a system tray may not expose the tray UI.

The default beta builds use an **ad-hoc macOS signature**, not Developer ID signing
or Apple notarization. Windows builds are unsigned. Do not equate a successful build
or checksum with OS trust, and do not disable Gatekeeper or SmartScreen protections.
Publicly trusted signing requires the maintainer's own certificates and credentials.

## First launch and workspace safety

Configure a model in the app, connect accounts when needed, and set an administrator
password for access from other devices. New workspaces have no default strategies,
strategy-bound routes or scheduled jobs. Initialization does not recreate examples,
and upgrading never silently removes user strategies or an existing encrypted vault.

Settings → Login / 设置 → 登录 contains notifications, external access and the
listening port. The default access port is `18400`; the launcher uses a free local
port if it is occupied. Sharing is off on startup. Enabling sharing requires an
administrator password. Local loopback access and authenticated external access
use separate provenance checks; forwarded headers cannot grant local trust.

The optional external URL is an advertised address, not a tunnel or an automatic
firewall rule. Use HTTPS or a VPN for public access. Closing a window keeps Nerya in
the tray; Quit stops its services. A fully exited or sleeping app cannot deliver
background notifications. Notification acceptance is not proof that a banner was
shown: OS permissions, focus settings and desktop support still apply.

macOS obtains the Vault encryption key from Keychain. Windows/Linux currently use
the private local key-file bootstrap; they are not claimed to use the OS credential
store. Protect the app-data directory and back up its key with the encrypted data.

## Native build prerequisites

Build on the **target operating system and architecture**. Do not cross-compile the
Rust shell while accidentally shipping Python/Node/Chromium from the build host.
`prepare.mjs` rejects mismatched Tauri targets, and payload verification checks the
actual native platform as well as the runtime manifest.

The release pins Node in `../.node-version`, Python in `../.python-version`, Rust
`1.96.0` and uv `0.11.18` in the workflow. Rust dependencies use `Cargo.lock`, npm
dependencies use the two `package-lock.json` files, and Python runtime dependencies
use the universal, hash-verified `requirements.lock`.

macOS needs Xcode Command Line Tools. Windows needs the MSVC C++ build tools and
Windows SDK. On Ubuntu 22.04, install the native dependencies:

```bash
sudo apt-get update
sudo apt-get install -y build-essential curl libssl-dev libwebkit2gtk-4.1-dev \
  libayatana-appindicator3-dev librsvg2-dev patchelf libfuse2 xdg-utils
```

From the repository root:

```bash
uv venv
uv pip install --constraint desktop/requirements.lock -e ".[dev,mcp,trading,prediction,browser]"
npm ci
npm --prefix desktop ci
```

Activate `.venv` before the Python commands below (`source .venv/bin/activate` on
macOS/Linux, `.venv\Scripts\Activate.ps1` in PowerShell). Linux builders also run
`python -m playwright install-deps chromium` to install Chromium's host libraries.
For development only, `python -m playwright install chromium` prepares the developer
browser cache. Release builds download their browser into the bundle instead.

## Build commands

Run from the repository root. These commands do not modify an operator workspace.

```bash
# macOS, on each CPU architecture separately
npm --prefix desktop run build -- --ci --bundles app,dmg -- --locked
node desktop/scripts/installer.mjs

# Windows x64
npm --prefix desktop run build -- --ci --bundles nsis,msi -- --locked

# Linux x64
npm --prefix desktop run build -- --ci --bundles deb,appimage -- --locked
```

`beforeBuildCommand` prepares the portable runtime, builds the actual standalone
web server, and generates icons from the application's branding. Node archives are
checked against the official published SHA-256 list. Python installs are hash-checked
against the committed lock. Runtime resources contain the product license and lock
file. Build output lives in ignored `runtime/`, `.runtime-build-*` and
`src-tauri/target/` directories, not in the user's workspace.

For development, run `npm --prefix desktop run dev`. The development manifest points
to the source checkout and `.venv`; it must never be included in a release bundle.

## Verify the payload, not just compilation

```bash
python scripts/release_version.py
python -m unittest discover -s desktop/tests -v
npm run typecheck --workspace @nerya/dashboard
npm run check:i18n --workspace @nerya/dashboard
cargo test --release --locked --manifest-path desktop/src-tauri/Cargo.toml
python desktop/scripts/verify_runtime.py
python desktop/scripts/verify_bundle.py
python desktop/scripts/collect_artifacts.py
```

Run Cargo tests after preparing runtime resources/icons. `verify_runtime.py` checks
relative paths, escaping symlinks, architecture, version pins, resource/license
presence, portable Node and Python, essential imports and built-in Skill loading.

`verify_bundle.py` checks the macOS application signature and its resource payload,
administratively extracts Windows MSI without installing it into the user account,
or extracts a Debian package into a temporary directory. It then runs the isolated
runtime smoke test against that packaged payload, not the original source tree.

The smoke test clears developer credentials and most environment variables. It
starts the bundled Chromium without the user's browser cache, creates a disposable
empty workspace, starts the actual Python and Next.js services, checks setup/settings
pages, encrypted credential storage, local and remote access boundaries, port
configuration and shutdown cleanup. The fake model endpoint is an unreachable
loopback address. No real model calls or orders are made.

This verifies startup and packaged resources, **not** native notification banners,
interactive OS trust prompts or broker-specific trading. Alternative installer
front ends (DMG/PKG, NSIS and AppImage) also need human installation acceptance on
the supported target systems; the automated payload test is not a claim of all UI
installer paths being exercised.

## CI/CD and versioning

[`.github/workflows/desktop.yml`](../.github/workflows/desktop.yml) runs on pushes,
pull requests and manual dispatch. It uses four native jobs: Windows x64, Linux x64,
macOS ARM64 and macOS x64. Jobs do not cancel the remaining platforms when one fails.
The quality gate additionally builds/verifies Python source distributions and runs
the full runtime regression suite rather than pytest's default smoke selection.

Each successful platform uploads two installers, checksums and build metadata as a
14-day workflow artifact. Branch/PR runs never publish GitHub Releases. A `v*` tag
must exactly match `VERSION`; publication requires the quality gate plus every
native build and payload test. Release assembly verifies the four platform reports,
all eight installers and their SHA-256 hashes before uploading them.

To prepare a future version:

```bash
# Edit VERSION, then synchronize/check all package metadata.
python scripts/release_version.py --write
python scripts/release_version.py
```

SemVer `1.0.0-beta.1` maps to Python `1.0.0b1`, Windows MSI `1.0.0.1` and macOS
bundle build `1.0.0b1`. Commit the manifests and lockfiles together, update the
release notes, and push the matching tag. Do not move an existing release tag.
The workflow creates a prerelease for prerelease versions. There is no automatic
in-app updater feed in this beta.

To intentionally update the Python runtime lock:

```bash
uv pip compile pyproject.toml --extra mcp --extra trading --extra prediction \
  --extra browser --universal --python-version 3.12 --generate-hashes \
  --no-emit-package nerya --output-file desktop/requirements.lock
```

Review the lock changes and rerun all native builds. Do not change a version pin
merely to make one developer's cached environment pass.

## Troubleshooting

Missing `next` or the Tauri CLI means the root or desktop `npm ci` step was skipped.
A cross-target error means the native runtime and requested Rust target disagree.
A missing library on Linux needs a distribution-level dependency fix, not an ignored
test. A development manifest in a release means the production prepare step did not
finish. Check `desktop-runtime.log` in the application's data directory for startup
failures, and redact credentials before sharing logs. Never delete an encrypted
vault or replace its key to work around a startup error.
