import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Socket from "effect/unstable/socket/Socket";

import { remoteHttpClientLayer } from "@t3tools/client-runtime/rpc";

import { tracingLayer } from "../features/observability/tracing";
import * as Persistence from "../persistence/layer";
import { cryptoLayer } from "./crypto";
import { disposeOnFoundationReplace, type FoundationHotModule } from "./foundation-fast-refresh";

declare const module: { readonly hot?: FoundationHotModule } | undefined;

const httpClientLayer = remoteHttpClientLayer(fetch);

type RuntimeLayerSource =
  | typeof Socket.layerWebSocketConstructorGlobal
  | typeof cryptoLayer
  | typeof httpClientLayer
  | typeof Persistence.layer
  | typeof tracingLayer;

const runtimeLayer = Socket.layerWebSocketConstructorGlobal.pipe(
  Layer.provideMerge(cryptoLayer),
  Layer.provideMerge(httpClientLayer),
  Layer.provideMerge(tracingLayer.pipe(Layer.provide(httpClientLayer))),
  Layer.provideMerge(Persistence.layer),
);

export const runtime: ManagedRuntime.ManagedRuntime<
  Layer.Success<RuntimeLayerSource>,
  Layer.Error<RuntimeLayerSource>
> = ManagedRuntime.make(runtimeLayer);

export const runtimeContextLayer: Layer.Layer<
  Layer.Success<RuntimeLayerSource>,
  Layer.Error<RuntimeLayerSource>
> = Layer.effectContext(runtime.contextEffect);

disposeOnFoundationReplace(typeof module === "undefined" ? undefined : module.hot, () =>
  runtime.dispose(),
);
