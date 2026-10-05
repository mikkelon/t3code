/**
 * Product analytics sink.
 *
 * This fork sends no product analytics. The service stays so that call sites
 * keep recording events, which are dropped.
 *
 * @module AnalyticsService
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export class AnalyticsService extends Context.Service<
  AnalyticsService,
  {
    /** Record a product event. Dropped in this fork. */
    readonly record: (
      event: string,
      properties?: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<void>;

    /** Flush queued events. Nothing is queued in this fork. */
    readonly flush: Effect.Effect<void>;
  }
>()("t3/telemetry/AnalyticsService") {
  static readonly layerTest = Layer.succeed(
    AnalyticsService,
    AnalyticsService.of({
      record: () => Effect.void,
      flush: Effect.void,
    }),
  );
}

export const layer = AnalyticsService.layerTest;
