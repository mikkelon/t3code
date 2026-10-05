import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Socket from "effect/socket/Socket";

import { layerRemoteHttpClient } from "@t3tools/client-runtime/rpc";

import * as Tracing from "../features/observability/tracing";
import * as Persistence from "../persistence/layer";
import * as MobileCrypto from "./crypto";
import { disposeOnFoundationReplace, type FoundationHotModule } from "./foundation-fast-refresh";

declare const module: { readonly hot?: FoundationHotModule } | undefined;

const layerHttpClient = layerRemoteHttpClient(fetch);

type RuntimeLayerSource =
  | typeof Socket.layerWebSocketConstructorGlobal
  | typeof MobileCrypto.layer
  | typeof layerHttpClient
  | typeof Persistence.layer
  | typeof Tracing.layer;

const layerRuntime = Socket.layerWebSocketConstructorGlobal.pipe(
  Layer.provideMerge(MobileCrypto.layer),
  Layer.provideMerge(layerHttpClient),
  Layer.provideMerge(Tracing.layer.pipe(Layer.provide(layerHttpClient))),
  Layer.provideMerge(Persistence.layer),
);

export const runtime: ManagedRuntime.ManagedRuntime<
  Layer.Success<RuntimeLayerSource>,
  Layer.Error<RuntimeLayerSource>
> = ManagedRuntime.make(layerRuntime);

export const layer: Layer.Layer<
  Layer.Success<RuntimeLayerSource>,
  Layer.Error<RuntimeLayerSource>
> = Layer.effectContext(runtime.contextEffect);

disposeOnFoundationReplace(typeof module === "undefined" ? undefined : module.hot, () =>
  runtime.dispose(),
);
