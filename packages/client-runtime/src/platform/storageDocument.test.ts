import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  SshConnectionProfile,
  SshConnectionRegistration,
} from "../connection/catalog.ts";
import {
  BearerConnectionTarget,
  ConnectionTransientError,
  PrimaryConnectionTarget,
  SshConnectionTarget,
} from "../connection/model.ts";
import {
  GitHubRoutingPermissions,
  makeGitHubRoutingPermissions,
} from "../connection/githubRoutingPermissions.ts";
import {
  ConnectionCatalogDocument,
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
  catalogRoutes,
  setRoutesInCatalog,
  registerConnectionInCatalog,
  removeConnectionFromCatalog,
  setConnectionEnabledInCatalog,
} from "./storageDocument.ts";

const decodeConnectionCatalogDocument = Schema.decodeUnknownEffect(ConnectionCatalogDocument);

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const decodeCatalogDocument = Schema.decodeUnknownSync(ConnectionCatalogDocument);
const encodeConnectionCatalogDocument = Schema.encodeEffect(ConnectionCatalogDocument);

const SSH_TARGET = new SshConnectionTarget({
  environmentId: ENVIRONMENT_ID,
  label: "Remote",
  connectionId: "ssh-1",
});
const SSH_PROFILE = new SshConnectionProfile({
  connectionId: SSH_TARGET.connectionId,
  environmentId: ENVIRONMENT_ID,
  label: SSH_TARGET.label,
  target: { alias: "work", hostname: "work.example.test", username: "maria", port: 22 },
});
const BEARER_TARGET = new BearerConnectionTarget({
  environmentId: ENVIRONMENT_ID,
  label: "Remote",
  connectionId: "bearer-1",
});
const BEARER_PROFILE = new BearerConnectionProfile({
  connectionId: BEARER_TARGET.connectionId,
  environmentId: ENVIRONMENT_ID,
  label: BEARER_TARGET.label,
  httpBaseUrl: "https://remote.example.test",
  wsBaseUrl: "wss://remote.example.test",
});
const BEARER_CREDENTIAL = new BearerConnectionCredential({
  token: "bearer-token",
});
describe("ConnectionCatalogDocument", () => {
  it.effect("persists explicit GitHub trust and forgets it when a connection is removed", () =>
    Effect.gen(function* () {
      let document = EMPTY_CONNECTION_CATALOG_DOCUMENT;
      const entry = { target: BEARER_TARGET, profile: Option.some(BEARER_PROFILE), enabled: true };
      const storage = {
        read: Effect.sync(() => document.githubRoutingPermissions ?? []),
        write: (githubRoutingPermissions: NonNullable<typeof document.githubRoutingPermissions>) =>
          Effect.gen(function* () {
            document = yield* decodeConnectionCatalogDocument({
              ...document,
              githubRoutingPermissions,
            }).pipe(Effect.orDie);
          }),
      };
      const permissions = yield* makeGitHubRoutingPermissions(storage);
      expect(yield* permissions.get(entry)).toBe("off");
      yield* permissions.set(entry, "read");
      const restarted = yield* makeGitHubRoutingPermissions(storage);
      expect(yield* restarted.get(entry)).toBe("read");

      const changedEndpoint = {
        ...entry,
        profile: Option.some(
          new BearerConnectionProfile({
            ...BEARER_PROFILE,
            httpBaseUrl: "https://different.example.test",
          }),
        ),
      };
      expect(yield* restarted.get(changedEndpoint)).toBe("off");
      expect(
        yield* restarted.get({
          ...entry,
          profile: Option.some(
            new BearerConnectionProfile({
              ...BEARER_PROFILE,
              wsBaseUrl: "wss://different.example.test",
            }),
          ),
        }),
      ).toBe("off");
      expect(
        yield* restarted.get({
          target: SSH_TARGET,
          profile: Option.some(SSH_PROFILE),
          enabled: true,
        }),
      ).toBe("off");
      yield* restarted.set(entry, "read-write");
      expect(yield* restarted.get(entry)).toBe("read-write");
      yield* restarted.forget(ENVIRONMENT_ID);
      expect(yield* restarted.get(entry)).toBe("off");
      const afterRemoval = yield* makeGitHubRoutingPermissions(storage);
      expect(yield* afterRemoval.get(entry)).toBe("off");

      yield* permissions.set(entry, "read");
      document = removeConnectionFromCatalog(document, ENVIRONMENT_ID);
      const afterCatalogRemoval = yield* makeGitHubRoutingPermissions(storage);
      expect(yield* afterCatalogRemoval.get(entry)).toBe("off");
    }),
  );

  it.effect("requires explicit trust for primary and SSH connections independently", () =>
    Effect.gen(function* () {
      const permissions = yield* makeGitHubRoutingPermissions({
        read: Effect.succeed([]),
        write: () => Effect.void,
      });
      const entries = [
        {
          target: new PrimaryConnectionTarget({
            environmentId: ENVIRONMENT_ID,
            label: "Local",
            httpBaseUrl: "http://localhost:3000",
            wsBaseUrl: "ws://localhost:3000",
          }),
          profile: Option.none(),
          enabled: true,
        },
        {
          enabled: true,
          target: new SshConnectionTarget({
            environmentId: ENVIRONMENT_ID,
            label: "SSH",
            connectionId: "ssh-1",
          }),
          profile: Option.some(
            new SshConnectionProfile({
              environmentId: ENVIRONMENT_ID,
              label: "SSH",
              connectionId: "ssh-1",
              target: { alias: "work", hostname: "work.example.test", username: "maria", port: 22 },
            }),
          ),
        },
      ];
      for (const entry of entries) {
        expect(yield* permissions.get(entry)).toBe("off");
        yield* permissions.set(entry, "read");
        expect(yield* permissions.get(entry)).toBe("read");
        yield* permissions.set(entry, "off");
        expect(yield* permissions.get(entry)).toBe("off");
      }
    }),
  );

  it.effect("does not enable GitHub routing when permission persistence fails", () =>
    Effect.gen(function* () {
      const entry = { target: BEARER_TARGET, profile: Option.some(BEARER_PROFILE), enabled: true };
      expect(yield* (yield* GitHubRoutingPermissions).get(entry)).toBe("off");
      const permissions = yield* makeGitHubRoutingPermissions({
        read: Effect.succeed([]),
        write: () =>
          Effect.fail(
            new ConnectionTransientError({
              reason: "remote-unavailable",
              detail: "storage unavailable",
            }),
          ),
      });
      yield* permissions.set(entry, "read-write").pipe(Effect.flip);
      expect(yield* permissions.get(entry)).toBe("off");
    }),
  );

  it("round-trips a catalog with bearer and SSH routes", () => {
    const document = registerConnectionInCatalog(
      registerConnectionInCatalog(
        EMPTY_CONNECTION_CATALOG_DOCUMENT,
        new BearerConnectionRegistration({
          target: BEARER_TARGET,
          profile: BEARER_PROFILE,
          credential: BEARER_CREDENTIAL,
        }),
      ),
      new SshConnectionRegistration({ target: SSH_TARGET, profile: SSH_PROFILE }),
      [BEARER_TARGET, SSH_TARGET],
    );
    const schema = Schema.fromJsonString(ConnectionCatalogDocument);
    const restored = Schema.decodeSync(schema)(Schema.encodeSync(schema)(document));

    expect(restored).toEqual(document);
  });

  it("registers a bearer connection as one catalog mutation", () => {
    const document = registerConnectionInCatalog(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
      new BearerConnectionRegistration({
        target: BEARER_TARGET,
        profile: BEARER_PROFILE,
        credential: BEARER_CREDENTIAL,
      }),
    );

    expect(document.targets).toEqual([BEARER_TARGET]);
    expect(document.profiles).toEqual([BEARER_PROFILE]);
    expect(document.credentials).toEqual([
      {
        connectionId: BEARER_TARGET.connectionId,
        credential: BEARER_CREDENTIAL,
      },
    ]);
  });

  it("removes every catalog record owned by an explicit disconnect", () => {
    const registered = registerConnectionInCatalog(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
      new BearerConnectionRegistration({
        target: BEARER_TARGET,
        profile: BEARER_PROFILE,
        credential: BEARER_CREDENTIAL,
      }),
    );

    expect(removeConnectionFromCatalog(registered, ENVIRONMENT_ID)).toEqual(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
    );
  });

  it("decodes a document written before the disabled list existed", () => {
    const decoded = decodeCatalogDocument({
      schemaVersion: 1,
      targets: [],
      profiles: [],
      credentials: [],
    });

    expect(decoded.disabledEnvironmentIds).toEqual([]);
  });

  it("drops T3 Connect routes from a catalog saved by a build that had them", () => {
    const learnedOverConnectId = `learned:${ENVIRONMENT_ID}:http://192.168.1.20:3773`;
    const learnedOverBearerId = `learned:${ENVIRONMENT_ID}:http://10.0.0.5:3773@${BEARER_TARGET.connectionId}`;
    const connectOnlyEnvironmentId = EnvironmentId.make("environment-2");
    const decoded = decodeCatalogDocument({
      schemaVersion: 1,
      targets: [
        { _tag: "RelayConnectionTarget", environmentId: ENVIRONMENT_ID, label: "Remote" },
        { ...BEARER_TARGET, _tag: "BearerConnectionTarget" },
        {
          _tag: "BearerConnectionTarget",
          environmentId: ENVIRONMENT_ID,
          label: "Remote",
          connectionId: learnedOverConnectId,
        },
        {
          _tag: "BearerConnectionTarget",
          environmentId: ENVIRONMENT_ID,
          label: "Remote",
          connectionId: learnedOverBearerId,
        },
        { _tag: "RelayConnectionTarget", environmentId: connectOnlyEnvironmentId, label: "Gone" },
      ],
      profiles: [
        { ...BEARER_PROFILE, _tag: "BearerConnectionProfile" },
        {
          _tag: "BearerConnectionProfile",
          connectionId: learnedOverConnectId,
          environmentId: ENVIRONMENT_ID,
          label: "Remote",
          httpBaseUrl: "http://192.168.1.20:3773/",
          wsBaseUrl: "ws://192.168.1.20:3773/",
          learned: true,
          authorization: "t3-connect",
        },
        {
          _tag: "BearerConnectionProfile",
          connectionId: learnedOverBearerId,
          environmentId: ENVIRONMENT_ID,
          label: "Remote",
          httpBaseUrl: "http://10.0.0.5:3773/",
          wsBaseUrl: "ws://10.0.0.5:3773/",
          learned: true,
        },
      ],
      credentials: [
        {
          connectionId: BEARER_TARGET.connectionId,
          credential: { _tag: "BearerConnectionCredential", token: "bearer-token" },
        },
      ],
      remoteDpopTokens: [
        {
          _tag: "RemoteDpopAccessToken",
          environmentId: ENVIRONMENT_ID,
          label: "Remote",
          endpoint: {
            httpBaseUrl: "https://remote.example.test",
            wsBaseUrl: "wss://remote.example.test",
            providerKind: "cloudflare_tunnel",
          },
          accessToken: "dpop-token",
          expiresAtEpochMs: 1_000_000,
          dpopThumbprint: "thumbprint",
        },
      ],
    });

    expect(decoded.targets.map((target) => target.connectionId)).toEqual([
      BEARER_TARGET.connectionId,
      learnedOverBearerId,
    ]);
    expect(decoded.profiles.map((profile) => profile.connectionId)).toEqual([
      BEARER_PROFILE.connectionId,
      learnedOverBearerId,
    ]);
    expect(decoded.credentials).toEqual([
      { connectionId: BEARER_TARGET.connectionId, credential: BEARER_CREDENTIAL },
    ]);
    expect(catalogRoutes(decoded, connectOnlyEnvironmentId)).toEqual([]);
    expect(decoded).not.toHaveProperty("remoteDpopTokens");
  });

  it.effect("rewrites a legacy catalog without its T3 Connect records", () =>
    Effect.gen(function* () {
      const document = yield* decodeConnectionCatalogDocument({
        schemaVersion: 1,
        targets: [
          { _tag: "RelayConnectionTarget", environmentId: ENVIRONMENT_ID, label: "Remote" },
        ],
        profiles: [],
        credentials: [],
        remoteDpopTokens: [],
      });
      const encoded = yield* encodeConnectionCatalogDocument(document);

      expect(encoded).toEqual({
        schemaVersion: 1,
        targets: [],
        profiles: [],
        credentials: [],
        disabledEnvironmentIds: [],
      });
    }),
  );

  it("switches a saved environment off and back on without touching its records", () => {
    const registered = registerConnectionInCatalog(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
      new BearerConnectionRegistration({
        target: BEARER_TARGET,
        profile: BEARER_PROFILE,
        credential: BEARER_CREDENTIAL,
      }),
    );

    const disabled = setConnectionEnabledInCatalog(registered, ENVIRONMENT_ID, false);
    expect(disabled.disabledEnvironmentIds).toEqual([ENVIRONMENT_ID]);
    expect(disabled.targets).toEqual(registered.targets);
    expect(disabled.credentials).toEqual(registered.credentials);
    // Idempotent: switching off twice stores the id once.
    expect(
      setConnectionEnabledInCatalog(disabled, ENVIRONMENT_ID, false).disabledEnvironmentIds,
    ).toEqual([ENVIRONMENT_ID]);

    expect(
      setConnectionEnabledInCatalog(disabled, ENVIRONMENT_ID, true).disabledEnvironmentIds,
    ).toEqual([]);
    // Re-registering (editing label or URL) keeps the flag.
    expect(
      registerConnectionInCatalog(
        disabled,
        new BearerConnectionRegistration({
          target: BEARER_TARGET,
          profile: BEARER_PROFILE,
          credential: BEARER_CREDENTIAL,
        }),
      ).disabledEnvironmentIds,
    ).toEqual([ENVIRONMENT_ID]);
    expect(removeConnectionFromCatalog(disabled, ENVIRONMENT_ID).disabledEnvironmentIds).toEqual(
      [],
    );
  });

  it("persists the normalized SSH profile beside its target", () => {
    const target = new SshConnectionTarget({
      environmentId: ENVIRONMENT_ID,
      label: "SSH",
      connectionId: "ssh-1",
    });
    const profile = new SshConnectionProfile({
      connectionId: target.connectionId,
      environmentId: target.environmentId,
      label: target.label,
      target: {
        alias: "devbox",
        hostname: "devbox.example.test",
        username: "developer",
        port: 22,
      },
    });
    const document = registerConnectionInCatalog(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
      new SshConnectionRegistration({ target, profile }),
    );

    expect(document.targets).toEqual([target]);
    expect(document.profiles).toEqual([profile]);
    expect(document.credentials).toEqual([]);
  });

  it("keeps every route of an environment and drops only a removed route's records", () => {
    const withBearer = registerConnectionInCatalog(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
      new BearerConnectionRegistration({
        target: BEARER_TARGET,
        profile: BEARER_PROFILE,
        credential: BEARER_CREDENTIAL,
      }),
    );
    const withSsh = registerConnectionInCatalog(
      withBearer,
      new SshConnectionRegistration({ target: SSH_TARGET, profile: SSH_PROFILE }),
      [BEARER_TARGET, SSH_TARGET],
    );
    expect(catalogRoutes(withSsh, ENVIRONMENT_ID)).toEqual([BEARER_TARGET, SSH_TARGET]);
    expect(withSsh.credentials).toHaveLength(1);

    // Dropping the bearer route forgets its profile and credential.
    const sshOnly = setRoutesInCatalog(withSsh, ENVIRONMENT_ID, [SSH_TARGET]);
    expect(sshOnly.targets).toEqual([SSH_TARGET]);
    expect(sshOnly.profiles).toEqual([SSH_PROFILE]);
    expect(sshOnly.credentials).toEqual([]);

    // Dropping SSH forgets its profile; the bearer route keeps its records.
    const bearerOnly = setRoutesInCatalog(withSsh, ENVIRONMENT_ID, [BEARER_TARGET]);
    expect(bearerOnly.profiles).toEqual([BEARER_PROFILE]);
    expect(bearerOnly.credentials).toHaveLength(1);
  });

  it("keeps an environment's position in the catalog when its routes change", () => {
    const other = new SshConnectionTarget({
      environmentId: EnvironmentId.make("environment-2"),
      label: "Other",
      connectionId: "ssh-2",
    });
    const document = {
      ...EMPTY_CONNECTION_CATALOG_DOCUMENT,
      targets: [SSH_TARGET, other],
    };
    expect(
      setRoutesInCatalog(document, ENVIRONMENT_ID, [BEARER_TARGET, SSH_TARGET]).targets,
    ).toEqual([BEARER_TARGET, SSH_TARGET, other]);
  });
});
