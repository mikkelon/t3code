# T3 Code (mikkelon fork)

This is a personal fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code),
a GUI for coding agents (Codex, Claude Code, Cursor, Grok Build, OpenCode,
Antigravity and others) by T3 Tools Inc., released under the [MIT license](./LICENSE).
All credit for T3 Code goes to its authors; this fork only changes two things:

- **A multi-device workflow.** Every machine runs T3 Code as an always-on
  background service, and the desktop app on that machine uses the running service
  instead of starting a second backend. The machines and a phone connect to each
  other over the LAN, Tailscale or SSH, and an SSH device host (for example a
  Mac) provides remote iOS simulators and Android emulators.
- **No commercial T3 features.** No T3 Connect cloud relay or managed tunnels, no
  Clerk account, no links to app.t3.codes or other hosted T3 services, and no
  PostHog product analytics. Everything local stays: LAN, Tailscale and SSH
  pairing included.

Releases, installers and `t3 update` use this repository's
[GitHub Releases](https://github.com/mikkelon/t3code/releases), never upstream's.
Report problems with this fork in its
[issues](https://github.com/mikkelon/t3code/issues).

## Install

Install and sign in to at least one provider CLI on each machine that will run
agents, for example `codex login` ([Codex CLI](https://developers.openai.com/codex/cli))
or `claude auth login` ([Claude Code](https://claude.com/product/claude-code)).
See [Providers](./docs/user/install.md#providers) for the full list.

### Command line and background service (Linux, Apple Silicon Mac)

```bash
curl -fsSL https://raw.githubusercontent.com/mikkelon/t3code/main/scripts/install.sh | sh
t3 service install
```

The installer puts `t3` in `~/.local/bin`. `t3 service install` keeps the server
running in the background (a systemd user service on Linux, started at boot; a
launchd agent on macOS, started at login). `t3 service status` shows its state and
log, and `t3 --help` lists everything else.

### Desktop app (Linux)

Download the `.AppImage` or `.deb` for your architecture from
[Releases](https://github.com/mikkelon/t3code/releases/latest). On Arch, use the
AppImage:

```bash
chmod +x T3-Code-*.AppImage && ./T3-Code-*.AppImage
```

Both update themselves from this fork's releases. When a background service is
running on the machine, the desktop app uses it instead of starting its own
server.

The fork publishes no macOS or Windows desktop builds and no Windows CLI. Build
them from source if you need them (see below).

### Switching from upstream T3 Code

Run the installer above, then `t3 service install` to move an existing service to
the fork's build, and replace the desktop app with the fork's AppImage or `.deb`.
Your data in `~/.t3` is kept: the fork uses the same `t3` command, home directory,
service name and app ID.

## Update

| What                         | How                                                                           |
| ---------------------------- | ----------------------------------------------------------------------------- |
| CLI and background service   | `t3 update` on the machine (asks before restarting the service)               |
| A server from another client | **Update server** in the version notice, or `t3 update <version>` on its host |
| Linux desktop app            | Updates itself; or download the new release                                   |

Fork releases are only published on the stable channel; there are no nightly
builds. See [Updating T3 Code](./docs/user/updating.md).

## Multi-device setup

1. **Every machine** (for example an always-on office PC, a home PC and a laptop):
   install the CLI and run `t3 service install`.
2. **Every machine**, with Tailscale running: `t3 pair --tailscale`. This publishes
   the service over Tailscale Serve HTTPS (it stays published across restarts) and
   prints a one-time pairing URL and QR code.
3. **Each desktop app:** open **Settings → Connections → Add environment** and paste
   a pairing URL from each of the other machines. The machine's own service is
   already there. Run `t3 pair` on a machine again for each new device; a pairing
   link works once.
4. **Phone:** install the official T3 Code app from the
   [App Store](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824) or
   [Google Play](https://play.google.com/store/apps/details?id=com.t3tools.t3code),
   open **Settings → Environments**, add an environment and scan the QR code from
   `t3 pair --tailscale` on each machine. The store app pairs directly with fork
   servers over Tailscale HTTPS; no account is involved. Update fork servers with
   `t3 update` or from a desktop client: the phone's **Check for updates** looks at
   upstream's releases, which a fork server cannot install.
5. **Remote simulators (optional):** on a Mac with Xcode (and/or a machine with the
   Android SDK) that the environments can reach over SSH, add it in
   **Settings → Integrations → Devices → Device hosts**. See
   [Devices](./docs/user/devices.md#ssh-device-hosts).

A machine without its own service can also be added from a desktop app with
**Add environment → SSH**, which starts a server there over SSH. More in
[Remote access](./docs/user/remote-access.md) and
[Running in the background](./docs/user/background-service.md).

## Build from source

Install [Vite+](https://viteplus.dev/guide/) (`curl -fsSL https://vite.plus | bash`),
then:

```bash
git clone https://github.com/mikkelon/t3code
cd t3code
vp i
vp run build:desktop               # server, web client and Electron main
node apps/server/dist/bin.mjs      # run the server
vp run dist:desktop:linux          # optional: x64 AppImage and .deb in release/
```

A desktop app built this way has no update feed, and a server run this way is not
managed by `t3 update` or the background service; rebuild to update. Development
setup is in [docs/operations/development.md](./docs/operations/development.md).

## Maintaining the fork

### Staying in sync with upstream

`scripts/sync-upstream.sh` rebases the fork's commits onto upstream `main` on a
`sync/<date>` branch, keeps files the fork deleted when upstream changed them,
stops on any other conflict, and runs the typechecks and fork-touched tests. It
never moves `main` and never pushes. See
[docs/operations/fork-sync.md](./docs/operations/fork-sync.md), including the
rules that keep the fork cheap to rebase.

### Releases

Run **Fork release** from the Actions tab, or push a tag such as `v0.0.46-mk.1`.
[`fork-release.yml`](./.github/workflows/fork-release.yml) builds on GitHub-hosted
runners and publishes a release with CLI archives for `linux-x64`, `linux-arm64`
and `darwin-arm64`, `SHA256SUMS`, and the Linux AppImage and `.deb` (x64, arm64)
with their update manifests. Builds are unsigned: Linux does not need signing,
and there are no macOS or Windows desktop builds because unsigned ones cannot
update themselves (macOS) or warn on every install (Windows). Upstream's
`release.yml` stays in the tree, trigger-less, so rebases stay clean.

Versions are `<core>-mk.<n>`, for example `0.0.46-mk.2`:

- `<core>` is the version upstream's nightlies use for the same commit (the patch
  after the last upstream release), so a fork build never claims an upstream
  version and sorts above the upstream release it is built on.
- `-mk.<n>` counts fork releases on that core; the workflow picks the next one.
- The app treats every prerelease other than `-nightly.` and `-preview.` as the
  stable channel, so `t3 update` and the desktop updater follow fork releases on
  `stable` unchanged. The install scripts match `-mk.<n>` tags explicitly, and a
  fork client warns when a fork server on the same core has a lower `<n>`.
- The repository they come from is set once, in `CLI_RELEASE_REPOSITORY`
  (`packages/shared/src/cliRelease.ts`), plus the `repo` line of
  `scripts/install.sh` and `scripts/install.ps1`.

## Documentation

- [Install and first run](./docs/user/install.md)
- [Running in the background](./docs/user/background-service.md)
- [Remote access](./docs/user/remote-access.md)
- [Updating T3 Code](./docs/user/updating.md)
- [Devices](./docs/user/devices.md)
- [All user docs](./docs/README.md)

Architecture notes start at [docs/internals/overview.md](./docs/internals/overview.md).
