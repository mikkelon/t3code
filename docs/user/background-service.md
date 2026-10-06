# Running T3 Code in the background

On Linux and macOS, T3 Code runs as a service for your user, so agents keep
working when you close the app or log out of a terminal. The desktop app sets
it up by itself ([details](#the-desktop-app-and-the-service)). On a machine
without the desktop app, use the `t3` CLI.

## Manage the service

Install the `t3` CLI first ([Install T3 Code](./install.md#command-line)), then
run these commands on the machine that will host T3 Code:

| Task                            | Command                |
| ------------------------------- | ---------------------- |
| Install and start               | `t3 service install`   |
| Inspect status and log location | `t3 service status`    |
| Move to a newer release         | `t3 update`            |
| Restart                         | `t3 service restart`   |
| Stop and remove from startup    | `t3 service uninstall` |

Uninstalling the service leaves your projects, threads, and settings intact.
Running `t3 service install` again repairs a service that `t3 service status`
reports as broken.

`t3 update` downloads the newest release on your channel and switches `t3`
and the service to it. Restarting interrupts running agent turns, terminals,
and remote clients, so it asks first; answer no and the service keeps running
the old version until you run `t3 service restart`. Pass `--yes` from a
script. A server you started by hand is left running; stop and start it again
to pick up the new version. Wait for any remote update already in progress
before updating; to match a remote client's version, follow
[Updating T3 Code](./updating.md).

Pass an exact version (`t3 update 0.0.42`) to pin one, `--channel nightly` to
switch trains, or `--allow-downgrade` to move backwards. `preview` is a
maintainers' test train: its builds can be broken and are never offered as
updates, so the installer and `t3 update` ask for confirmation before
installing one.

`t3 uninstall` removes the background service, the `t3` launcher, and the
downloaded versions after showing you the list and asking once. Your projects,
threads, and settings under `~/.t3/userdata` are kept. Pass `--yes` from a
script.

## The desktop app and the service

The Linux and macOS desktop apps install the service themselves. On first
launch, T3 Code sets it up from the version it ships, without a download, and
tells you once. From then on the app is a window onto the service: closing it
leaves your agents running, and the next launch connects again without
pairing. A service you installed with `t3 service install` is used as it is.
If the service is stopped, the app starts it; if it cannot, it offers to retry
instead of starting a second server on the same data. Run `t3 service status`
to see why.

If setting up the service fails, the app shows the error with **Retry**, or
continues with agents running inside the app, which stop when you close it.
**Settings → Connections** then shows the error with **Retry**.

Updating the app updates the service. When the app is newer than the service,
the service switches to the app's version as soon as no agents are running;
until then **Settings → Connections** shows the update as ready, with
**Update now**. If the new version fails to start, the service goes back to the
previous one and the app shows the error with **Retry update**. A service newer
than the app, for example after `t3 update`, is left as it is. The `t3` in
`~/.local/bin` follows the version the service runs, unless it is a `t3` you
installed another way, such as from npm.

**Settings → Connections → Background service** shows the service's version and
uptime, with **Restart** and **Show logs**. Under **Advanced**, **Don't run
agents in the background** removes the service and restarts the app with agents
running inside it, and the app stops installing the service until you turn the
option off again. Projects and threads are kept either way.

The app does not change how the service listens on the network. To reach the
service from your other devices, turn on **Tailscale HTTPS** in
**Settings → Connections** ([details](./remote-access.md#tailscale-https)).

## Platform support

Linux needs systemd user services. Setup enables lingering so T3 Code starts at
boot and keeps running after logout; on a computer you are logged in to, this
usually needs no password. If it needs an administrator, the service still runs
while you are logged in, and `t3 service status` and **Settings → Connections**
show the command that enables lingering.

macOS starts the service when you log in and stops it when you log out. Keep the
Mac logged in and awake for unattended remote access. Installing over SSH while
nobody is logged in at the Mac's screen can fail at the final start step; the
service is still installed and will start at the next login.

Windows background services are not supported.

## Troubleshooting

Start with `t3 service status` on the host. It prints the log path and, on Linux,
checks whether the installed service is running, enabled, and allowed to survive
logout.

If it stops when your SSH session closes, check for `linger-disabled`. An
administrator can enable lingering with:

```sh
sudo loginctl enable-linger "$(id -un)"
```

Over SSH, allow sudo to prompt:

```sh
ssh -t your-server 'sudo loginctl enable-linger "$(id -un)"'
```

Run only the `loginctl` command with sudo; running T3 Code as root creates a
separate installation. Without administrator access, the service runs while
you are logged in; to keep T3 Code running after you log out of SSH, run
`t3 serve` in a terminal multiplexer such as `tmux`.

| Status problem                          | Next step                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `linger-unavailable`                    | Run `loginctl show-user "$(id -un)" --property=Linger` and check that systemd-logind is available.                             |
| `user-manager-unavailable`              | Run `systemctl --user status` in a login session for the service user; check your distribution's systemd user-session support. |
| `service-disabled` or `service-stopped` | Read the log and `systemctl --user status t3code.service`, then use the repair command printed by T3 Code.                     |
| `restart-pending`                       | A newer version is installed but the service still runs the previous one. Run `t3 service restart`.                            |

On macOS, check **System Settings → General → Login Items** if the service no
longer starts at login. If agent work cannot access Desktop, Documents, or
Downloads, it may need Full Disk Access for the `t3` executable listed in
`ProgramArguments` in
`~/Library/LaunchAgents/com.t3tools.t3code.service.plist`.

For connection problems from other devices, see
[remote access troubleshooting](./remote-access.md#troubleshooting).
