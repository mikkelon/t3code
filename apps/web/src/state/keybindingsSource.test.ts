import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { selectKeybindingsConfig } from "./keybindingsSource";

const config = (key: string) =>
  ({ keybindings: [{ key, command: "chat.new" }] }) as unknown as ServerConfig;
const serviceId = "env-service" as EnvironmentId;
const otherId = "env-other" as EnvironmentId;

describe("selectKeybindingsConfig", () => {
  it("uses the primary environment's config when there is a primary", () => {
    const primary = config("mod+n");
    expect(
      selectKeybindingsConfig({
        primaryEnvironmentId: serviceId,
        primaryConfig: primary,
        environmentConfigs: new Map([[otherId, config("mod+o")]]),
      }),
    ).toBe(primary);
  });

  it("keeps waiting for the primary's config instead of borrowing another machine's", () => {
    expect(
      selectKeybindingsConfig({
        primaryEnvironmentId: serviceId,
        primaryConfig: null,
        environmentConfigs: new Map([[otherId, config("mod+o")]]),
      }),
    ).toBeNull();
  });

  // #15668: with the local environment off, a saved connection to the
  // background service has the user's keybindings.json, not the defaults.
  it("falls back to the first connected environment when there is no primary", () => {
    const service = config("mod+shift+n");
    expect(
      selectKeybindingsConfig({
        primaryEnvironmentId: null,
        primaryConfig: null,
        environmentConfigs: new Map([
          [serviceId, service],
          [otherId, config("mod+o")],
        ]),
      }),
    ).toBe(service);
  });
});
