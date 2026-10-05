import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import {
  type ConnectionRegistration,
  ConnectionCredential,
  ConnectionProfile,
} from "../connection/catalog.ts";
import { type ConnectionTarget, PersistedConnectionTarget } from "../connection/model.ts";
import { StoredGitHubRoutingPermission } from "../connection/githubRoutingPermissions.ts";

export const StoredConnectionCredential = Schema.Struct({
  connectionId: Schema.String,
  credential: ConnectionCredential,
});
export type StoredConnectionCredential = typeof StoredConnectionCredential.Type;

const ConnectionCatalogDocumentFields = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  targets: Schema.Array(PersistedConnectionTarget),
  profiles: Schema.Array(ConnectionProfile),
  credentials: Schema.Array(StoredConnectionCredential),
  githubRoutingPermissions: Schema.optionalKey(Schema.Array(StoredGitHubRoutingPermission)),
  // Saved environments the user switched off. They stay registered with their
  // credentials and cache but never connect until switched back on. Older
  // documents predate the key, so decoding defaults it to none.
  disabledEnvironmentIds: Schema.Array(EnvironmentId).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
});

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

/**
 * T3 Connect routes, and routes learned through them, authenticate with a T3
 * Connect credential this build never obtains. A catalog written by a build
 * that had T3 Connect drops them on load and keeps the environment's other
 * routes; an environment reachable only through T3 Connect is forgotten.
 */
function withoutT3ConnectRoutes(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const profiles = Array.isArray(raw.profiles) ? raw.profiles : [];
  const connectIds = new Set(
    profiles.flatMap((profile) =>
      isRecord(profile) &&
      profile.authorization === "t3-connect" &&
      typeof profile.connectionId === "string"
        ? [profile.connectionId]
        : [],
    ),
  );
  const isConnectRoute = (value: unknown) =>
    isRecord(value) &&
    (value._tag === "RelayConnectionTarget" ||
      (typeof value.connectionId === "string" && connectIds.has(value.connectionId)));
  return {
    ...raw,
    ...(Array.isArray(raw.targets)
      ? { targets: raw.targets.filter((target) => !isConnectRoute(target)) }
      : {}),
    ...(Array.isArray(raw.profiles)
      ? { profiles: raw.profiles.filter((profile) => !isConnectRoute(profile)) }
      : {}),
  };
}

export const ConnectionCatalogDocument = Schema.Unknown.pipe(
  Schema.decodeTo(
    ConnectionCatalogDocumentFields,
    SchemaTransformation.transform<typeof ConnectionCatalogDocumentFields.Encoded, unknown>({
      decode: (raw) =>
        withoutT3ConnectRoutes(raw) as typeof ConnectionCatalogDocumentFields.Encoded,
      encode: (document) => document,
    }),
  ),
);
export type ConnectionCatalogDocument = typeof ConnectionCatalogDocument.Type;

export const EMPTY_CONNECTION_CATALOG_DOCUMENT: ConnectionCatalogDocument = Object.freeze({
  schemaVersion: 1,
  targets: [],
  profiles: [],
  credentials: [],
  disabledEnvironmentIds: [],
});

export function replaceCatalogValue<A>(
  values: ReadonlyArray<A>,
  key: (value: A) => string,
  next: A,
): ReadonlyArray<A> {
  const nextKey = key(next);
  return [...values.filter((value) => key(value) !== nextKey), next];
}

export function removeCatalogValue<A>(
  values: ReadonlyArray<A>,
  key: (value: A) => string,
  removedKey: string,
): ReadonlyArray<A> {
  return values.filter((value) => key(value) !== removedKey);
}

function connectionIdOf(target: ConnectionTarget): string | null {
  switch (target._tag) {
    case "PrimaryConnectionTarget":
      return null;
    case "BearerConnectionTarget":
    case "SshConnectionTarget":
      return target.connectionId;
  }
}

function routeKey(target: ConnectionTarget): string {
  return connectionIdOf(target) ?? target._tag;
}

function removeRouteMetadata(
  document: ConnectionCatalogDocument,
  removed: ReadonlyArray<ConnectionTarget>,
): ConnectionCatalogDocument {
  const connectionIds = new Set(removed.flatMap((target) => connectionIdOf(target) ?? []));
  return {
    ...document,
    profiles: document.profiles.filter((value) => !connectionIds.has(value.connectionId)),
    credentials: document.credentials.filter((value) => !connectionIds.has(value.connectionId)),
  };
}

/**
 * An environment's saved routes in preference order. Targets of one
 * environment keep their relative order in `targets`, so a document written
 * before routes existed is one environment with one route.
 */
export function catalogRoutes(
  document: ConnectionCatalogDocument,
  environmentId: EnvironmentId,
): ReadonlyArray<PersistedConnectionTarget> {
  return document.targets.filter((target) => target.environmentId === environmentId);
}

/**
 * Replaces an environment's routes with `routes`, preferred first. Records
 * owned by a dropped route go with it; the environment keeps its position in
 * the catalog. An empty list leaves the environment's other records in place;
 * use `removeConnectionFromCatalog` to forget the environment.
 */
export function setRoutesInCatalog(
  document: ConnectionCatalogDocument,
  environmentId: EnvironmentId,
  routes: ReadonlyArray<PersistedConnectionTarget>,
): ConnectionCatalogDocument {
  const kept = new Set(routes.map(routeKey));
  const dropped = catalogRoutes(document, environmentId).filter(
    (target) => !kept.has(routeKey(target)),
  );
  const firstIndex = document.targets.findIndex((target) => target.environmentId === environmentId);
  const others = document.targets.filter((target) => target.environmentId !== environmentId);
  const insertAt =
    firstIndex === -1
      ? others.length
      : document.targets.slice(0, firstIndex).filter((t) => t.environmentId !== environmentId)
          .length;
  return {
    ...removeRouteMetadata(document, dropped),
    targets: [...others.slice(0, insertAt), ...routes, ...others.slice(insertAt)],
  };
}

/** Saves one route of an environment, keeping its other routes. */
export function registerConnectionInCatalog(
  document: ConnectionCatalogDocument,
  registration: ConnectionRegistration,
  routes: ReadonlyArray<PersistedConnectionTarget> = [registration.target],
): ConnectionCatalogDocument {
  // Re-registering (for example editing a label or URL) keeps the disabled
  // flag; only `setConnectionEnabledInCatalog` or removal changes it.
  const next = setRoutesInCatalog(document, registration.target.environmentId, routes);

  switch (registration._tag) {
    case "BearerConnectionRegistration":
      return {
        ...next,
        profiles: replaceCatalogValue(
          next.profiles,
          (value) => value.connectionId,
          registration.profile,
        ),
        credentials: replaceCatalogValue(next.credentials, (value) => value.connectionId, {
          connectionId: registration.target.connectionId,
          credential: registration.credential,
        }),
      };
    case "SshConnectionRegistration":
      return {
        ...next,
        profiles: replaceCatalogValue(
          next.profiles,
          (value) => value.connectionId,
          registration.profile,
        ),
      };
  }
}

/** Forgets an environment and every route it had. */
export function removeConnectionFromCatalog(
  document: ConnectionCatalogDocument,
  environmentId: EnvironmentId,
): ConnectionCatalogDocument {
  const next = setRoutesInCatalog(document, environmentId, []);
  return {
    ...next,
    disabledEnvironmentIds: removeCatalogValue(
      next.disabledEnvironmentIds,
      (value) => value,
      environmentId,
    ),
    ...(next.githubRoutingPermissions === undefined
      ? {}
      : {
          githubRoutingPermissions: next.githubRoutingPermissions.filter(
            (permission) => permission.environmentId !== environmentId,
          ),
        }),
  };
}

/** Flips the disabled flag for a saved environment; unknown ids are ignored. */
export function setConnectionEnabledInCatalog(
  document: ConnectionCatalogDocument,
  environmentId: EnvironmentId,
  enabled: boolean,
): ConnectionCatalogDocument {
  const registered = document.targets.some((target) => target.environmentId === environmentId);
  const without = removeCatalogValue(
    document.disabledEnvironmentIds,
    (value) => value,
    environmentId,
  );
  return {
    ...document,
    disabledEnvironmentIds: registered && !enabled ? [...without, environmentId] : without,
  };
}
