import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";

import {
  BearerConnectionProfile,
  type ConnectionCatalogEntry,
  type ConnectionRoute,
  SshConnectionProfile,
} from "./catalog.ts";
import { gitHubRoutingConnectionKey } from "./githubRoutingPermissions.ts";
import { BearerConnectionTarget, SshConnectionTarget } from "./model.ts";
import {
  connectionRouteId,
  connectionRouteKind,
  connectionRouteLabel,
  credentialConnectionId,
  insertRoute,
  entryWithRoutes,
  mergeLearnedRoutes,
  routesAfterRemoving,
  sendsTokenInClear,
  upsertRoute,
  usableRoutes,
} from "./routes.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");

function direct(id: string, httpBaseUrl: string): ConnectionRoute {
  return {
    target: new BearerConnectionTarget({
      environmentId: ENVIRONMENT_ID,
      label: "Desk",
      connectionId: id,
    }),
    profile: Option.some(
      new BearerConnectionProfile({
        connectionId: id,
        environmentId: ENVIRONMENT_ID,
        label: "Desk",
        httpBaseUrl,
        wsBaseUrl: httpBaseUrl.replace(/^http/, "ws"),
      }),
    ),
  };
}

const SSH: ConnectionRoute = {
  target: new SshConnectionTarget({
    environmentId: ENVIRONMENT_ID,
    label: "Desk",
    connectionId: "ssh",
  }),
  profile: Option.some(
    new SshConnectionProfile({
      connectionId: "ssh",
      environmentId: ENVIRONMENT_ID,
      label: "Desk",
      target: { alias: "desk", hostname: "desk.example.com", username: "me", port: null },
    }),
  ),
};
const LAN = direct("lan", "http://192.168.1.10:3773/");
const TAILNET = direct("tailnet", "https://desk.tail1234.ts.net/");
const PUBLIC = direct("public", "https://desk.example.com/");
// Paired over plain HTTP, so its token may follow the server to plain HTTP LAN addresses.
const PLAIN = direct("plain", "http://desk.example.com:3773/");

function learned(id: string, httpBaseUrl: string): ConnectionRoute {
  const route = direct(id, httpBaseUrl);
  const profile = Option.getOrThrow(route.profile) as BearerConnectionProfile;
  return {
    target: route.target,
    profile: Option.some(new BearerConnectionProfile({ ...profile, learned: true })),
  };
}

describe("connection routes", () => {
  it("classifies direct routes by address", () => {
    expect(connectionRouteKind(LAN)).toBe("lan");
    // Tailscale, Cloudflare WARP and Mesh, and other VPNs share 100.64.0.0/10.
    expect(connectionRouteKind(direct("ip", "http://100.101.102.103:3773/"))).toBe("vpn");
    expect(connectionRouteLabel(direct("mesh", "http://100.96.0.1:3773/"))).toBe("VPN");
    expect(connectionRouteKind(TAILNET)).toBe("tailnet");
    expect(connectionRouteKind(PUBLIC)).toBe("public");
    expect(connectionRouteKind(direct("lo", "http://127.0.0.1:3773/"))).toBe("loopback");
    expect(connectionRouteKind(direct("ts6", "http://[fd7a:115c:a1e0::1]:3773/"))).toBe("tailnet");
    expect(connectionRouteLabel(TAILNET)).toBe("Tailscale");
    expect(connectionRouteKind(SSH)).toBe("ssh");
    expect(connectionRouteLabel(SSH)).toBe("SSH me@desk.example.com");
  });

  it("places a new route after faster kinds and ahead of SSH", () => {
    expect(insertRoute([SSH], LAN)).toEqual([LAN, SSH]);
    expect(insertRoute([LAN, SSH], TAILNET)).toEqual([LAN, TAILNET, SSH]);
    expect(insertRoute([TAILNET], LAN)).toEqual([LAN, TAILNET]);
    expect(insertRoute([LAN, TAILNET], SSH)).toEqual([LAN, TAILNET, SSH]);
  });

  it("keeps a user's order when a saved route is replaced", () => {
    const repaired = direct("lan", "http://192.168.1.11:3773/");
    expect(upsertRoute([SSH, LAN], repaired)).toEqual([SSH, repaired]);
  });
});

describe("learned routes", () => {
  const plainOnly: ConnectionCatalogEntry = {
    target: PLAIN.target,
    profile: PLAIN.profile,
    enabled: true,
  };
  const learnedId = (origin: string) => `learned:${ENVIRONMENT_ID}:${origin}@plain`;
  const ids = (routes: ReadonlyArray<ConnectionRoute> | null) =>
    routes?.map((route) => connectionRouteId(route.target)) ?? null;
  const profileOf = (route: ConnectionRoute) => Option.getOrThrow(route.profile);

  it("learns a LAN address over a paired route, ahead of it, borrowing its token", () => {
    const routes = mergeLearnedRoutes({
      entry: plainOnly,
      activeRoute: PLAIN,
      reported: [{ httpBaseUrl: "http://192.168.1.10:3773/" }],
      allowInsecure: true,
    });
    expect(ids(routes)).toEqual([learnedId("http://192.168.1.10:3773"), "plain"]);
    expect(profileOf(routes![0]!)).toMatchObject({
      learned: true,
      wsBaseUrl: "ws://192.168.1.10:3773/",
    });
    expect(credentialConnectionId(connectionRouteId(routes![0]!.target))).toBe("plain");
  });

  it("replaces a learned LAN address when the server reports a new one", () => {
    const first = mergeLearnedRoutes({
      entry: plainOnly,
      activeRoute: PLAIN,
      reported: [{ httpBaseUrl: "http://192.168.1.10:3773/" }],
      allowInsecure: true,
    })!;
    const entry: ConnectionCatalogEntry = {
      ...plainOnly,
      target: first[0]!.target,
      profile: first[0]!.profile,
      alternateRoutes: first.slice(1),
    };
    const moved = mergeLearnedRoutes({
      entry,
      activeRoute: PLAIN,
      reported: [{ httpBaseUrl: "http://10.0.0.42:3773/" }],
      allowInsecure: true,
    });
    expect(ids(moved)).toEqual([learnedId("http://10.0.0.42:3773"), "plain"]);
  });

  it("keeps a learned route where the user moved it while the server reports it", () => {
    const lan = { httpBaseUrl: "http://192.168.1.10:3773/" };
    const first = mergeLearnedRoutes({
      entry: plainOnly,
      activeRoute: PLAIN,
      reported: [lan],
      allowInsecure: true,
    })!;
    const reordered = entryWithRoutes(plainOnly, [first[1]!, first[0]!]);
    expect(
      mergeLearnedRoutes({
        entry: reordered,
        activeRoute: PLAIN,
        reported: [lan],
        allowInsecure: true,
      }),
    ).toBeNull();
    const next = mergeLearnedRoutes({
      entry: reordered,
      activeRoute: PLAIN,
      reported: [lan, { httpBaseUrl: "http://100.101.102.103:3773/" }],
      allowInsecure: true,
    });
    expect(ids(next)).toEqual([
      learnedId("http://100.101.102.103:3773"),
      "plain",
      learnedId("http://192.168.1.10:3773"),
    ]);
  });

  it("labels a learned address Tailscale only while the server reports it as tailnet", () => {
    const tailscale = { kind: "tailnet", httpBaseUrl: "http://100.101.102.103:3773/" };
    const mesh = { kind: "lan", httpBaseUrl: "http://100.96.0.1:3773/" };
    const first = mergeLearnedRoutes({
      entry: plainOnly,
      activeRoute: PLAIN,
      reported: [tailscale, mesh],
      allowInsecure: true,
    })!;
    expect(first.map(connectionRouteLabel)).toEqual(["Tailscale", "VPN", "desk.example.com"]);

    const corrected = mergeLearnedRoutes({
      entry: entryWithRoutes(plainOnly, first),
      activeRoute: PLAIN,
      reported: [{ ...tailscale, kind: "lan" }, mesh],
      allowInsecure: true,
    })!;
    expect(ids(corrected)).toEqual(ids(first));
    expect(corrected.map(connectionRouteLabel)).toEqual(["VPN", "VPN", "desk.example.com"]);
    expect(
      mergeLearnedRoutes({
        entry: entryWithRoutes(plainOnly, corrected),
        activeRoute: PLAIN,
        reported: [{ ...tailscale, kind: "lan" }, mesh],
        allowInsecure: true,
      }),
    ).toBeNull();
  });

  it("labels a paired numeric Tailscale address Tailscale once the server confirms it", () => {
    const paired = direct("paired", "http://100.101.102.103:3773/");
    const other = direct("other", "http://100.96.0.1:3773/");
    const entry = entryWithRoutes(plainOnly, [paired, other, PUBLIC]);
    expect(connectionRouteLabel(paired)).toBe("VPN");
    const confirmed = mergeLearnedRoutes({
      entry,
      activeRoute: paired,
      reported: [{ kind: "tailnet", httpBaseUrl: "http://100.101.102.103:3773/" }],
      allowInsecure: true,
    })!;
    expect(ids(confirmed)).toEqual(["paired", "other", "public"]);
    expect(confirmed.map(connectionRouteLabel)).toEqual(["Tailscale", "VPN", "desk.example.com"]);
  });

  it("leaves user routes alone and does not learn an address already saved", () => {
    const entry: ConnectionCatalogEntry = {
      target: LAN.target,
      profile: LAN.profile,
      alternateRoutes: [PLAIN],
      enabled: true,
    };
    expect(
      mergeLearnedRoutes({
        entry,
        activeRoute: PLAIN,
        reported: [{ httpBaseUrl: "http://192.168.1.10:3773" }],
        allowInsecure: true,
      }),
    ).toBeNull();
    expect(
      mergeLearnedRoutes({ entry, activeRoute: PLAIN, reported: [], allowInsecure: true }),
    ).toBeNull();
  });

  it("borrows the paired token when learned over a bearer route", () => {
    const entry: ConnectionCatalogEntry = {
      ...plainOnly,
      target: LAN.target,
      profile: LAN.profile,
    };
    const routes = mergeLearnedRoutes({
      entry,
      activeRoute: LAN,
      reported: [{ httpBaseUrl: "https://desk.tail1234.ts.net/" }],
      allowInsecure: true,
    })!;
    const learned = routes.find((route) => connectionRouteKind(route) === "tailnet")!;
    expect(credentialConnectionId(connectionRouteId(learned.target))).toBe("lan");
  });

  it("keeps a token paired over HTTPS off plain HTTP addresses outside the tailnet", () => {
    const entry = entryWithRoutes(plainOnly, [PUBLIC, SSH]);
    const routes = mergeLearnedRoutes({
      entry,
      activeRoute: PUBLIC,
      reported: [
        { kind: "lan", httpBaseUrl: "http://192.168.1.10:3773/" },
        { kind: "tailnet", httpBaseUrl: "http://100.101.102.103:3773/" },
        { kind: "tailnet", httpBaseUrl: "https://desk.tail1234.ts.net/" },
      ],
      allowInsecure: true,
    });
    expect(ids(routes)).toEqual([
      `learned:${ENVIRONMENT_ID}:http://100.101.102.103:3773@public`,
      `learned:${ENVIRONMENT_ID}:https://desk.tail1234.ts.net@public`,
      "public",
      "ssh",
    ]);
  });

  it("drops a plain HTTP LAN route learned earlier over an HTTPS-paired token", () => {
    const lanOrigin = "http://192.168.1.10:3773";
    const stale = direct(`learned:${ENVIRONMENT_ID}:${lanOrigin}@public`, `${lanOrigin}/`);
    const staleProfile = profileOf(stale) as BearerConnectionProfile;
    const learnedStale: ConnectionRoute = {
      target: stale.target,
      profile: Option.some(new BearerConnectionProfile({ ...staleProfile, learned: true })),
    };
    const routes = mergeLearnedRoutes({
      entry: entryWithRoutes(plainOnly, [learnedStale, PUBLIC, SSH]),
      activeRoute: PUBLIC,
      reported: [{ kind: "lan", httpBaseUrl: `${lanOrigin}/` }],
      allowInsecure: true,
    });
    expect(ids(routes)).toEqual(["public", "ssh"]);
  });

  it("drops a stale plain HTTP route borrowing an HTTPS-paired token while another route is active", () => {
    const lanOrigin = "http://10.0.0.42:3773";
    const stale = learned(`learned:${ENVIRONMENT_ID}:${lanOrigin}@public`, `${lanOrigin}/`);
    const entry = entryWithRoutes(plainOnly, [stale, LAN, PUBLIC, SSH]);
    expect(sendsTokenInClear([stale, LAN, PUBLIC, SSH], stale)).toBe(true);
    expect(ids(usableRoutes(entry))).toEqual(["lan", "public", "ssh"]);
    const routes = mergeLearnedRoutes({
      entry,
      activeRoute: LAN,
      reported: [{ kind: "lan", httpBaseUrl: `${lanOrigin}/` }],
      allowInsecure: true,
    });
    // The stale route is gone; the address is learned again with the LAN route's token.
    expect(ids(routes)).toEqual([
      "lan",
      `learned:${ENVIRONMENT_ID}:${lanOrigin}@lan`,
      "public",
      "ssh",
    ]);
  });

  it("keeps plain HTTP routes that don't borrow the active HTTPS-paired token", () => {
    const lanOrigin = "http://10.0.0.42:3773";
    const overLan = learned(`learned:${ENVIRONMENT_ID}:${lanOrigin}@lan`, `${lanOrigin}/`);
    const routes = mergeLearnedRoutes({
      entry: entryWithRoutes(plainOnly, [overLan, LAN, PUBLIC, SSH]),
      activeRoute: PUBLIC,
      reported: [{ kind: "lan", httpBaseUrl: `${lanOrigin}/` }],
      allowInsecure: true,
    });
    expect(routes).toBeNull();
  });

  it("learns plain HTTP LAN addresses over a token paired over plain HTTP", () => {
    const entry = entryWithRoutes(plainOnly, [LAN, SSH]);
    const routes = mergeLearnedRoutes({
      entry,
      activeRoute: LAN,
      reported: [{ kind: "lan", httpBaseUrl: "http://10.0.0.42:3773/" }],
      allowInsecure: true,
    });
    expect(ids(routes)).toEqual([
      "lan",
      `learned:${ENVIRONMENT_ID}:http://10.0.0.42:3773@lan`,
      "ssh",
    ]);
  });

  it("skips plain HTTP from an HTTPS page and never learns loopback", () => {
    expect(
      mergeLearnedRoutes({
        entry: plainOnly,
        activeRoute: PLAIN,
        reported: [
          { httpBaseUrl: "http://192.168.1.10:3773/" },
          { httpBaseUrl: "http://127.0.0.1:3773/" },
        ],
        allowInsecure: false,
      }),
    ).toBeNull();
  });

  it("removes learned routes along with the route whose credential they borrow", () => {
    const overPlain = mergeLearnedRoutes({
      entry: plainOnly,
      activeRoute: PLAIN,
      reported: [{ httpBaseUrl: "http://192.168.1.10:3773/" }],
      allowInsecure: true,
    })!;
    expect(routesAfterRemoving(overPlain, "plain")).toEqual([]);

    const paired: ConnectionCatalogEntry = {
      ...plainOnly,
      target: LAN.target,
      profile: LAN.profile,
      alternateRoutes: [PUBLIC],
    };
    const overLan = mergeLearnedRoutes({
      entry: paired,
      activeRoute: LAN,
      reported: [{ httpBaseUrl: "https://desk.tail1234.ts.net/" }],
      allowInsecure: true,
    })!;
    expect(ids(routesAfterRemoving(overLan, "lan"))).toEqual(["public"]);
    expect(ids(routesAfterRemoving(overLan, "public"))).toHaveLength(2);
  });

  it("keeps GitHub routing trust when a route is learned", () => {
    const learned = mergeLearnedRoutes({
      entry: plainOnly,
      activeRoute: PLAIN,
      reported: [{ httpBaseUrl: "http://192.168.1.10:3773/" }],
      allowInsecure: true,
    })!;
    const withLearned: ConnectionCatalogEntry = {
      ...plainOnly,
      target: learned[0]!.target,
      profile: learned[0]!.profile,
      alternateRoutes: learned.slice(1),
    };
    expect(gitHubRoutingConnectionKey(withLearned)).toBe(gitHubRoutingConnectionKey(plainOnly));
  });

  it("borrows the paired token when learning over a learned route", () => {
    const first = mergeLearnedRoutes({
      entry: plainOnly,
      activeRoute: PLAIN,
      reported: [{ httpBaseUrl: "http://192.168.1.10:3773/" }],
      allowInsecure: true,
    })!;
    const learnedLan = first[0]!;
    const entry: ConnectionCatalogEntry = {
      ...plainOnly,
      target: learnedLan.target,
      profile: learnedLan.profile,
      alternateRoutes: first.slice(1),
    };
    const next = mergeLearnedRoutes({
      entry,
      activeRoute: learnedLan,
      reported: [
        { httpBaseUrl: "http://192.168.1.10:3773/" },
        { httpBaseUrl: "https://desk.tail1234.ts.net/" },
      ],
      allowInsecure: true,
    })!;
    expect(ids(next)).toEqual([
      learnedId("http://192.168.1.10:3773"),
      learnedId("https://desk.tail1234.ts.net"),
      "plain",
    ]);
    for (const route of next) {
      expect(credentialConnectionId(connectionRouteId(route.target))).toBe("plain");
    }
  });

  it("saves a scheme change on the same host as a new address", () => {
    const first = mergeLearnedRoutes({
      entry: plainOnly,
      activeRoute: PLAIN,
      reported: [{ httpBaseUrl: "http://desk.local:3773/" }],
      allowInsecure: true,
    })!;
    const entry: ConnectionCatalogEntry = {
      ...plainOnly,
      target: first[0]!.target,
      profile: first[0]!.profile,
      alternateRoutes: first.slice(1),
    };
    const moved = mergeLearnedRoutes({
      entry,
      activeRoute: PLAIN,
      reported: [{ httpBaseUrl: "https://desk.local:3773/" }],
      allowInsecure: true,
    });
    expect(moved).not.toBeNull();
    expect(profileOf(moved![0]!)).toMatchObject({ httpBaseUrl: "https://desk.local:3773/" });
  });
});
