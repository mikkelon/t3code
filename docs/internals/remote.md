# Remote architecture

Each connection joins a client to one environment over HTTP and WebSocket. The
environment owns providers, execution, files, and durable state. Direct access,
Tailscale, and SSH change how the client reaches that server; they do not
introduce another execution model. See
[remote access](../user/remote-access.md) for setup.

## Identity is independent of the route

An environment keeps its ID across server restarts and endpoint changes. Saved
connections are local to a client profile; the server's identity and state are
not. A repository identity can correlate clones across environments, but never
routes work between them. A project and its threads belong to one environment.
The canonical key follows the `upstream` remote when one exists, so pull request
features target the repository a fork tracks. A fork also reports its own
`origin`, and clients group and label by that, so a fork never collapses into a
checkout of its upstream.

[Environment ID initialization](../../apps/server/src/environment/ServerEnvironment.ts)
must publish a complete ID atomically. Repair of an empty ID file retains a
recovery file so concurrent or delayed initializers choose the same winner.
Removing that recovery state as ordinary temporary-file cleanup can change the
identity underneath an already-running server.

Advertised endpoints are reachability hints. Only the connecting device can
prove that a route works. In particular, a host's loopback address refers to a
different machine when another device opens it. Endpoint selection must not
silently fall back to loopback when a shareable endpoint is unavailable.

A saved environment holds an ordered list of routes, and the
[driver](../../packages/client-runtime/src/connection/driver.ts) connects over
the first that works. Each direct route is first checked with the public
descriptor, so a saved LAN address that a different machine answers on another
network receives no credential. That check is not proof of a working route:
when every route stays silent, each is still tried. A route that fails to
connect, including a blocked one such as a revoked credential, moves on to the
next; only an incompatible server stops the walk, because it is the same
server on every route. While connected over a later route the
[supervisor](../../packages/client-runtime/src/connection/supervisor.ts)
preflights the earlier ones and replaces the session when one would connect.
Preflight includes authorization so a route that answers but rejects this
client never costs a working session; a route that still fails afterwards is
held back for a cooldown so a flaky network cannot bounce the connection.

A connected server reports the LAN and tailnet addresses it is bound to, and the
client saves them as learned routes. A learned route reuses the paired bearer
token of the route it was learned over. Learned routes the server stops reporting are dropped, which is
how a changed LAN address replaces the old one; routes the user saved are never
touched. The reported addresses are hints like any advertised endpoint, so a
learned route still has to answer as this environment before it is used.

GitHub routing trust covers the whole route list. Adding or changing a route
revokes it; reordering does not, because the same addresses remain trusted.

## Browsers are clients

A browser stores its connection catalog locally and connects directly to each
environment. Serving the UI over HTTPS therefore cannot make a plain HTTP LAN
backend accessible from that browser context.

A pairing URL carries the pairing secret in its fragment, so it stays out of
requests to the page's origin. The browser exchanges the secret with the
environment and strips it from its history. Moving the token into a query
parameter would disclose it to whatever serves the page.

Saved catalogs written by builds that had T3 Connect can still hold its routes.
[Decoding](../../packages/client-runtime/src/platform/storageDocument.ts) drops
them, and routes learned through them, because this build never obtains the
credential they need.

## Access and process ownership are different

Tailscale supplies an endpoint for ordinary pairing, so it needs no separate
environment type. Authentication remains the environment's responsibility for
every route. See [environment authentication](./environment-auth.md).

SSH can launch a server as well as forward a port. Desktop main owns that
lifecycle because it can spawn SSH and handle authentication prompts. The
renderer uses the forwarded endpoint through the shared connection runtime.
[SSH cleanup](../../packages/ssh/src/tunnel.ts) stops a remote server only if the
launcher owns it; a server it discovered already running must survive a client
disconnect. Reconnection restores the forward before opening the application
transport.

Remote servers can outlive several client releases. Clients must use advertised
capabilities and handle their absence, rather than assume their own version
describes the server. Process replacement belongs to the launcher's
[update protocol](./server-updates.md); the connection runtime handles the
resulting disconnect.

### Desktop and the background service

One T3 home has one server. Two servers on one database contend for SQLite, replay each other's
events into their own provider reactors (duplicate agent processes for one thread), and fight over
runtime state and tunnels. So before choosing a port, the desktop app decides who owns its home
([discovery](../../apps/desktop/src/backend/DesktopLocalServerDiscovery.ts)): a server whose
`server-runtime.json` names a live pid and whose origin answers with the home's `environment-id` is
adopted; an installed service unit for that home is started and adopted; with neither, a packaged
Linux or macOS app installs the service unless the user opted out; only otherwise does the app embed
a backend. This all happens before any backend starts, which is what makes installing safe. Failure
to start an installed service or sign in never falls back to embedding; a failed install may, but
only after removing what it installed. The runtime file alone is not trusted because a dead
server's file can point at a port another home's server now uses.

The service never runs from the app bundle: an AppImage is mounted only while it runs and an update
replaces it, and the unit needs the standalone `t3` the launcher protocol expects. So release builds
ship their own platform's CLI release archive (`resources/service-runtime.tar.gz`), and
`t3 service install|stage --runtime-archive` unpacks it into `<home>/runtime/versions/<version>`,
the layout `t3 update` and the install script produce. An older service is moved to the app's
version through the server's own update (`server.updateServer`), not by rewriting the unit: the
launcher backs up the database, trials the new version and rolls back when it fails to start. The
renderer starts that update, because it already knows when no agent runs and tracks update
progress and failure. The app
authenticates the way `t3` does for the same OS user: a CLI of the server's exact version (bundled,
or the service's pinned runtime) issues an administrative session, because every CLI that opens the
database runs migrations. An adopted server is never stopped or cleaned up by the app, and a server
only clears runtime state that still names its own pid. Settings that relaunch the embedded backend
do not reach an adopted server; Tailscale HTTPS is therefore a server setting
(`server.setTailscaleServe`), while launch flags keep owning it for the embedded backend.

### Desktop without a local environment

Desktop normally launches or adopts its primary server, but the desktop setting `localEnvironmentEnabled`
(`apps/desktop/src/settings/DesktopAppSettings.ts`) turns that off. Changing it relaunches the app;
no local state is deleted. On the next start the main process skips port selection, server exposure,
and the primary and WSL backends, and opens the window right away. The renderer sees this through
`desktopBridge.getLocalEnvironmentEnabled()`: `readPrimaryEnvironmentTarget` returns null, so primary
auth and platform-managed discovery are skipped and only saved environments (pairing, SSH)
connect. This is possible because the desktop renderer is not served by the backend: the `t3code://`
scheme serves the bundled client from disk (Vite in development) and API traffic always goes to the
environment's own URL.
