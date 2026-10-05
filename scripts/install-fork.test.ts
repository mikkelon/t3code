// @effect-diagnostics nodeBuiltinImport:off - Drives the real shell installer against a local HTTP fixture.
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("installer release lookup", () => {
  it("installs the newest fork release on the stable channel, skipping nightlies", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-install-lookup-"));
    const platform = HostProcess.Platform.defaultValue() === "darwin" ? "darwin" : "linux";
    const version = "0.0.46-mk.2";
    const stem = `t3-${version}-${platform}-${HostProcess.Architecture.defaultValue()}`;
    const archiveName = `${stem}.tar.gz`;
    await NodeFSP.mkdir(NodePath.join(root, stem));
    await NodeFSP.writeFile(NodePath.join(root, stem, "t3"), `#!/bin/sh\necho 't3 v${version}'\n`, {
      mode: 0o755,
    });
    NodeChildProcess.execFileSync("tar", [
      "-czf",
      NodePath.join(root, archiveName),
      "-C",
      root,
      stem,
    ]);
    const archive = await NodeFSP.readFile(NodePath.join(root, archiveName));
    const checksum = NodeCrypto.createHash("sha256").update(archive).digest("hex");
    // Pretty-printed like GitHub's API, newest first.
    const index = JSON.stringify(
      ["v0.0.47-nightly.20261005.12", `v${version}`, "v0.0.46-mk.1", "v0.0.45"].map((tag) => ({
        tag_name: tag,
        draft: false,
      })),
      null,
      2,
    );
    const requested: string[] = [];
    const server = NodeHttp.createServer((request, response) => {
      requested.push(request.url ?? "");
      if (request.url === "/index") response.end(index);
      else if (request.url === `/v${version}/SHA256SUMS`)
        response.end(`${checksum}  ${archiveName}\n`);
      else if (request.url === `/v${version}/${archiveName}`) response.end(archive);
      else response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
    try {
      const child = NodeChildProcess.spawn(
        "sh",
        [NodePath.resolve(import.meta.dirname, "install.sh")],
        {
          env: {
            ...process.env,
            T3CODE_CHANNEL: "stable",
            T3CODE_VERSION: "",
            T3CODE_HOME: NodePath.join(root, "home"),
            T3CODE_INSTALL_BIN_DIR: NodePath.join(root, "bin"),
            T3CODE_RELEASE_BASE_URL: `http://127.0.0.1:${address.port}`,
            T3CODE_RELEASE_INDEX_URL: `http://127.0.0.1:${address.port}/index`,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
      const code = await new Promise<number | null>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", resolve);
      });
      expect(code, output).toBe(0);
      expect(requested).toEqual([
        "/index",
        `/v${version}/SHA256SUMS`,
        `/v${version}/${archiveName}`,
      ]);
      expect(
        await NodeFSP.readFile(
          NodePath.join(root, "home/runtime/versions", version, ".install-complete"),
          "utf8",
        ),
      ).toBe(`${version}\n`);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
