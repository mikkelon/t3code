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
  upsertRoute,
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

describe("connection routes", () => {
  it("classifies direct routes by address", () => {
    expect(connectionRouteKind(LAN)).toBe("lan");
    expect(connectionRouteKind(direct("ip", "http://100.101.102.103:3773/"))).toBe("tailnet");
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
    // The user preferred SSH over the LAN; re-pairing the LAN keeps that.
    const repaired = direct("lan", "http://192.168.1.11:3773/");
    expect(upsertRoute([SSH, LAN], repaired)).toEqual([SSH, repaired]);
  });
});

describe("learned routes", () => {
  const publicOnly: ConnectionCatalogEntry = {
    target: PUBLIC.target,
    profile: PUBLIC.profile,
    enabled: true,
  };
  const learnedId = (origin: string) => `learned:${ENVIRONMENT_ID}:${origin}@public`;
  const ids = (routes: ReadonlyArray<ConnectionRoute> | null) =>
    routes?.map((route) => connectionRouteId(route.target)) ?? null;
  const profileOf = (route: ConnectionRoute) => Option.getOrThrow(route.profile);

  it("learns a LAN address over a paired route, ahead of it, borrowing its token", () => {
    const routes = mergeLearnedRoutes({
      entry: publicOnly,
      activeRoute: PUBLIC,
      reported: [{ httpBaseUrl: "http://192.168.1.10:3773/" }],
      allowInsecure: true,
    });
    expect(ids(routes)).toEqual([learnedId("http://192.168.1.10:3773"), "public"]);
    expect(profileOf(routes![0]!)).toMatchObject({
      learned: true,
      wsBaseUrl: "ws://192.168.1.10:3773/",
    });
    expect(credentialConnectionId(connectionRouteId(routes![0]!.target))).toBe("public");
  });

  it("replaces a learned LAN address when the server reports a new one", () => {
    const first = mergeLearnedRoutes({
      entry: publicOnly,
      activeRoute: PUBLIC,
      reported: [{ httpBaseUrl: "http://192.168.1.10:3773/" }],
      allowInsecure: true,
    })!;
    const entry: ConnectionCatalogEntry = {
      ...publicOnly,
      target: first[0]!.target,
      profile: first[0]!.profile,
      alternateRoutes: first.slice(1),
    };
    const moved = mergeLearnedRoutes({
      entry,
      activeRoute: PUBLIC,
      reported: [{ httpBaseUrl: "http://10.0.0.42:3773/" }],
      allowInsecure: true,
    });
    expect(ids(moved)).toEqual([learnedId("http://10.0.0.42:3773"), "public"]);
  });

  it("keeps a learned route where the user moved it while the server reports it", () => {
    const lan = { httpBaseUrl: "http://192.168.1.10:3773/" };
    const first = mergeLearnedRoutes({
      entry: publicOnly,
      activeRoute: PUBLIC,
      reported: [lan],
      allowInsecure: true,
    })!;
    // The user prefers the paired public address over the learned LAN address.
    const reordered = entryWithRoutes(publicOnly, [first[1]!, first[0]!]);
    expect(
      mergeLearnedRoutes({
        entry: reordered,
        activeRoute: PUBLIC,
        reported: [lan],
        allowInsecure: true,
      }),
    ).toBeNull();
    // A newly reported address is still placed by speed.
    const next = mergeLearnedRoutes({
      entry: reordered,
      activeRoute: PUBLIC,
      reported: [lan, { httpBaseUrl: "http://100.101.102.103:3773/" }],
      allowInsecure: true,
    });
    expect(ids(next)).toEqual([
      learnedId("http://100.101.102.103:3773"),
      "public",
      learnedId("http://192.168.1.10:3773"),
    ]);
  });

  it("leaves user routes alone and does not learn an address already saved", () => {
    const entry: ConnectionCatalogEntry = {
      target: LAN.target,
      profile: LAN.profile,
      alternateRoutes: [PUBLIC],
      enabled: true,
    };
    expect(
      mergeLearnedRoutes({
        entry,
        activeRoute: PUBLIC,
        reported: [{ httpBaseUrl: "http://192.168.1.10:3773" }],
        allowInsecure: true,
      }),
    ).toBeNull();
    // The server stops reporting the LAN address; the paired route stays.
    expect(
      mergeLearnedRoutes({ entry, activeRoute: PUBLIC, reported: [], allowInsecure: true }),
    ).toBeNull();
  });

  it("borrows the paired token when learned over a bearer route", () => {
    const entry: ConnectionCatalogEntry = {
      ...publicOnly,
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

  it("skips plain HTTP from an HTTPS page and never learns loopback", () => {
    expect(
      mergeLearnedRoutes({
        entry: publicOnly,
        activeRoute: PUBLIC,
        reported: [
          { httpBaseUrl: "http://192.168.1.10:3773/" },
          { httpBaseUrl: "http://127.0.0.1:3773/" },
        ],
        allowInsecure: false,
      }),
    ).toBeNull();
  });

  it("removes learned routes along with the route whose credential they borrow", () => {
    const overPublic = mergeLearnedRoutes({
      entry: publicOnly,
      activeRoute: PUBLIC,
      reported: [{ httpBaseUrl: "http://192.168.1.10:3773/" }],
      allowInsecure: true,
    })!;
    expect(routesAfterRemoving(overPublic, "public")).toEqual([]);

    const paired: ConnectionCatalogEntry = {
      ...publicOnly,
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
    // Removing the public address keeps the paired LAN and what it learned.
    expect(ids(routesAfterRemoving(overLan, "public"))).toHaveLength(2);
  });

  it("keeps GitHub routing trust when a route is learned", () => {
    const learned = mergeLearnedRoutes({
      entry: publicOnly,
      activeRoute: PUBLIC,
      reported: [{ httpBaseUrl: "http://192.168.1.10:3773/" }],
      allowInsecure: true,
    })!;
    const withLearned: ConnectionCatalogEntry = {
      ...publicOnly,
      target: learned[0]!.target,
      profile: learned[0]!.profile,
      alternateRoutes: learned.slice(1),
    };
    expect(gitHubRoutingConnectionKey(withLearned)).toBe(gitHubRoutingConnectionKey(publicOnly));
  });

  it("borrows the paired token when learning over a learned route", () => {
    const first = mergeLearnedRoutes({
      entry: publicOnly,
      activeRoute: PUBLIC,
      reported: [{ httpBaseUrl: "http://192.168.1.10:3773/" }],
      allowInsecure: true,
    })!;
    const learnedLan = first[0]!;
    const entry: ConnectionCatalogEntry = {
      ...publicOnly,
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
      "public",
    ]);
    for (const route of next) {
      expect(credentialConnectionId(connectionRouteId(route.target))).toBe("public");
    }
  });

  it("saves a scheme change on the same host as a new address", () => {
    const first = mergeLearnedRoutes({
      entry: publicOnly,
      activeRoute: PUBLIC,
      reported: [{ httpBaseUrl: "http://desk.local:3773/" }],
      allowInsecure: true,
    })!;
    const entry: ConnectionCatalogEntry = {
      ...publicOnly,
      target: first[0]!.target,
      profile: first[0]!.profile,
      alternateRoutes: first.slice(1),
    };
    const moved = mergeLearnedRoutes({
      entry,
      activeRoute: PUBLIC,
      reported: [{ httpBaseUrl: "https://desk.local:3773/" }],
      allowInsecure: true,
    });
    expect(moved).not.toBeNull();
    expect(profileOf(moved![0]!)).toMatchObject({ httpBaseUrl: "https://desk.local:3773/" });
  });
});
