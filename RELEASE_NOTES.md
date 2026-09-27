# Nerya 1.0.0 Beta 1

Release identifier: `1.0.0-beta.1` / Python `1.0.0b1`.

## Workspace

The Agent strategy workspace brings streaming conversation, tools, strategy workflows,
historical backtests, market cards and research reports into one place. It includes
English/Chinese and light/dark interfaces, reusable local historical data, direct
Skill/Agent resource editing, account configuration and external Agent integrations.
New workspaces start with no strategies or scheduled trades.

## Desktop delivery

Native builds target Windows x64, Linux x64, macOS Apple Silicon and macOS Intel.
Installers bundle Python, Node, the standalone web workspace and Chromium. Python
dependencies, Node archives and package versions are verified during the build.
The workflow exercises installer payloads with temporary data and fake credentials
before making a release available. SHA-256 checksums and build metadata accompany
each platform's installers.

## Beta limitations

These default beta artifacts are ad-hoc signed on macOS, not notarized, and unsigned
on Windows. They are not a claim of OS-trusted public distribution. Linux still needs
the distribution's desktop/browser shared libraries. Native notification permissions,
system trust prompts and broker-specific live trading require separate acceptance
testing. No updater feed or automatic in-app upgrade is configured by this release.

Keep a backup of existing workspaces and encryption keys before upgrading. Website
recordings use example data; backtests are historical simulations, not live returns.
