// @effect-diagnostics nodeBuiltinImport:off - Drives the real shell installer through a PTY and a gated HTTP fixture.
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

// util-linux's script gives the real installer a terminal without a browser or extra packages.
describe.skipIf(HostProcessPlatform.defaultValue() !== "linux")("installer terminal", () => {
  it.each([false, true])(
    "preserves download and install behavior (HTTP failure: %s)",
    async (fail) => {
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-install-progress-"));
      const version = "1.2.3";
      const stem = `t3-${version}-linux-${HostProcessArchitecture.defaultValue()}`;
      const archiveName = `${stem}.tar.gz`;
      let resumeDownload: (() => void) | undefined;
      let sawPartialProgress = false;
      let output = "";
      await NodeFSP.mkdir(NodePath.join(root, stem));
      await NodeFSP.writeFile(NodePath.join(root, stem, "t3"), "#!/bin/sh\necho 't3 v1.2.3'\n", {
        mode: 0o755,
      });
      await NodeFSP.writeFile(
        NodePath.join(root, stem, "payload"),
        NodeCrypto.randomBytes(64 * 1024),
      );
      NodeChildProcess.execFileSync("tar", [
        "-czf",
        NodePath.join(root, archiveName),
        "-C",
        root,
        stem,
      ]);
      const archive = await NodeFSP.readFile(NodePath.join(root, archiveName));
      const checksum = NodeCrypto.createHash("sha256").update(archive).digest("hex");
      const server = NodeHttp.createServer((request, response) => {
        if (request.url?.endsWith("/SHA256SUMS")) {
          response.end(`${checksum}  ${archiveName}\n`);
        } else if (fail) {
          response.writeHead(500).end();
        } else {
          response.writeHead(200, { "Content-Length": archive.length });
          resumeDownload = () => response.end(archive.subarray(Math.floor(archive.length / 2)));
          response.write(archive.subarray(0, Math.floor(archive.length / 2)));
        }
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
      const installer = NodePath.resolve(import.meta.dirname, "install.sh").replaceAll(
        "'",
        "'\\''",
      );
      const child = NodeChildProcess.spawn("script", ["-qec", `sh '${installer}'`, "/dev/null"], {
        env: {
          ...process.env,
          TERM: "xterm",
          NO_COLOR: "1",
          T3CODE_VERSION: version,
          T3CODE_HOME: NodePath.join(root, "home"),
          T3CODE_INSTALL_BIN_DIR: NodePath.join(root, "bin"),
          T3CODE_RELEASE_BASE_URL: `http://127.0.0.1:${address.port}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const collect = (chunk: Buffer) => {
        output += chunk.toString();
        if (!sawPartialProgress && /\b[1-9]\d?%/.test(output)) {
          sawPartialProgress = true;
          resumeDownload?.();
        }
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      try {
        const code = await new Promise<number | null>((resolve, reject) => {
          child.on("error", reject);
          child.on("close", resolve);
        });
        const versions = NodePath.join(root, "home/runtime/versions");
        if (fail) {
          expect(code).not.toBe(0);
          expect(output).toContain("500");
          expect(output).not.toContain("100%");
          expect(output).not.toContain("Installed T3 Code");
          expect(await NodeFSP.readdir(versions)).toEqual([]);
        } else {
          expect(code).toBe(0);
          expect(sawPartialProgress).toBe(true);
          expect(output).toContain("100%");
          expect(output).toContain("0.1 / 0.1 MB");
          expect(output).toContain("Installed T3 Code 1.2.3");
          expect(
            await NodeFSP.readFile(NodePath.join(versions, version, ".install-complete"), "utf8"),
          ).toBe("1.2.3\n");
          expect(
            NodeChildProcess.execFileSync(NodePath.join(root, "bin/t3"), ["--version"], {
              encoding: "utf8",
            }).trim(),
          ).toBe("t3 v1.2.3");
          expect(await NodeFSP.readdir(versions)).toEqual([version]);
        }
      } finally {
        if (child.exitCode === null) child.kill();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    },
  );
});

describe.skipIf(HostProcessPlatform.defaultValue() === "win32")("installer release lookup", () => {
  it("installs the newest fork release on the stable channel, skipping nightlies", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-install-lookup-"));
    const platform = HostProcessPlatform.defaultValue() === "darwin" ? "darwin" : "linux";
    const version = "0.0.46-mk.2";
    const stem = `t3-${version}-${platform}-${HostProcessArchitecture.defaultValue()}`;
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

const desktopVersion = "0.0.46-mk.6";
const appImageArch = HostProcessArchitecture.defaultValue() === "arm64" ? "arm64" : "x86_64";
const desktopFeed = appImageArch === "arm64" ? "latest-linux-arm64.yml" : "latest-linux.yml";
const appImageName = `T3-Code-${desktopVersion}-${appImageArch}.AppImage`;
const fakeIcon = "fake t3code.png\n";
// Answers --appimage-extract the way the release does: the icon, and .DirIcon linking to it.
const fakeAppImage = `#!/bin/sh
if [ "$1" = --appimage-extract ]; then
  mkdir -p squashfs-root/usr/share/icons/hicolor/512x512/apps
  printf '${fakeIcon.replace("\n", "\\n")}' > squashfs-root/usr/share/icons/hicolor/512x512/apps/t3code.png
  ln -sfn usr/share/icons/hicolor/512x512/apps/t3code.png squashfs-root/.DirIcon
fi
`;

async function makeDesktopRelease(input: { readonly feedChecksumOf: string }) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-install-desktop-"));
  const stem = `t3-${desktopVersion}-linux-${HostProcessArchitecture.defaultValue()}`;
  const archiveName = `${stem}.tar.gz`;
  await NodeFSP.mkdir(NodePath.join(root, stem));
  await NodeFSP.writeFile(
    NodePath.join(root, stem, "t3"),
    `#!/bin/sh\necho 't3 v${desktopVersion}'\n`,
    { mode: 0o755 },
  );
  NodeChildProcess.execFileSync("tar", [
    "-czf",
    NodePath.join(root, archiveName),
    "-C",
    root,
    stem,
  ]);
  const archive = await NodeFSP.readFile(NodePath.join(root, archiveName));
  const archiveChecksum = NodeCrypto.createHash("sha256").update(archive).digest("hex");
  const feed = [
    `version: ${desktopVersion}`,
    "files:",
    `  - url: T3-Code-${desktopVersion}-amd64.deb`,
    `    sha512: ${NodeCrypto.createHash("sha512").update("deb").digest("base64")}`,
    "    size: 3",
    `  - url: ${appImageName}`,
    `    sha512: ${NodeCrypto.createHash("sha512").update(input.feedChecksumOf).digest("base64")}`,
    `    size: ${fakeAppImage.length}`,
    `path: ${appImageName}`,
    `sha512: ${NodeCrypto.createHash("sha512").update("top-level").digest("base64")}`,
    "",
  ].join("\n");
  const index = JSON.stringify([{ tag_name: `v${desktopVersion}`, draft: false }], null, 2);
  const requested: string[] = [];
  const server = NodeHttp.createServer((request, response) => {
    requested.push(request.url ?? "");
    if (request.url === "/index") response.end(index);
    else if (request.url === `/v${desktopVersion}/SHA256SUMS`)
      response.end(`${archiveChecksum}  ${archiveName}\n`);
    else if (request.url === `/v${desktopVersion}/${archiveName}`) response.end(archive);
    else if (request.url === `/v${desktopVersion}/${desktopFeed}`) response.end(feed);
    else if (request.url === `/v${desktopVersion}/${appImageName}`) response.end(fakeAppImage);
    else response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
  const dataHome = NodePath.join(root, "data home");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: NodePath.join(root, "home"),
    XDG_DATA_HOME: dataHome,
    T3CODE_DESKTOP_DIR: undefined,
    T3CODE_CHANNEL: "stable",
    T3CODE_VERSION: "",
    T3CODE_HOME: NodePath.join(root, "t3home"),
    T3CODE_INSTALL_BIN_DIR: NodePath.join(root, "bin"),
    T3CODE_RELEASE_BASE_URL: `http://127.0.0.1:${address.port}`,
    T3CODE_RELEASE_INDEX_URL: `http://127.0.0.1:${address.port}/index`,
    T3CODE_NO_LAUNCH: "1",
    DISPLAY: "",
    WAYLAND_DISPLAY: "",
  };
  return {
    requested,
    cliBin: NodePath.join(root, "bin/t3"),
    desktopDir: NodePath.join(dataHome, "t3code"),
    appImage: NodePath.join(dataHome, "t3code/T3-Code.AppImage"),
    launcher: NodePath.join(dataHome, "applications/com.t3tools.T3Code.desktop"),
    icon: NodePath.join(dataHome, "icons/com.t3tools.T3Code.desktop.png"),
    async install(...args: string[]) {
      const child = NodeChildProcess.spawn(
        "sh",
        [NodePath.resolve(import.meta.dirname, "install.sh"), ...args],
        { env, stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
      const code = await new Promise<number | null>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", resolve);
      });
      return { code, output };
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await NodeFSP.rm(root, { recursive: true, force: true });
    },
  };
}

const exists = (path: string) =>
  NodeFSP.lstat(path).then(
    () => true,
    () => false,
  );

describe.skipIf(HostProcessPlatform.defaultValue() !== "linux")("desktop installer", () => {
  it("installs the CLI, the AppImage, the icon and a visible launcher", async () => {
    const release = await makeDesktopRelease({ feedChecksumOf: fakeAppImage });
    try {
      const { code, output } = await release.install("--desktop");
      expect(code, output).toBe(0);
      expect(release.requested).toEqual([
        "/index",
        `/v${desktopVersion}/SHA256SUMS`,
        `/v${desktopVersion}/t3-${desktopVersion}-linux-${HostProcessArchitecture.defaultValue()}.tar.gz`,
        `/v${desktopVersion}/${desktopFeed}`,
        `/v${desktopVersion}/${appImageName}`,
      ]);
      expect(await NodeFSP.readFile(release.appImage, "utf8")).toBe(fakeAppImage);
      expect((await NodeFSP.stat(release.appImage)).mode & 0o777).toBe(0o755);
      expect(await NodeFSP.readdir(release.desktopDir)).toEqual(["T3-Code.AppImage"]);
      expect(await NodeFSP.readFile(release.icon, "utf8")).toBe(fakeIcon);
      const launcher = await NodeFSP.readFile(release.launcher, "utf8");
      // Same bytes as renderUrlHandlerDesktopEntry with launcherWmClass in
      // apps/desktop/src/app/DesktopLinuxUrlHandler.test.ts, so the app does not rewrite it.
      expect(launcher).toBe(
        [
          "[Desktop Entry]",
          "Type=Application",
          "Name=T3 Code (Alpha)",
          `Exec="${release.appImage}" %U`,
          `Icon=${release.icon}`,
          "Terminal=false",
          "StartupNotify=false",
          "StartupWMClass=t3code",
          "Categories=Development;",
          "MimeType=x-scheme-handler/t3code;",
          "",
        ].join("\n"),
      );
      expect(
        NodeChildProcess.execFileSync(release.cliBin, ["--version"], { encoding: "utf8" }).trim(),
      ).toBe(`t3 v${desktopVersion}`);
    } finally {
      await release.close();
    }
  });

  it("rejects an AppImage whose checksum does not match the feed and leaves nothing behind", async () => {
    const release = await makeDesktopRelease({ feedChecksumOf: "a different AppImage" });
    try {
      const { code, output } = await release.install("--desktop");
      expect(code).not.toBe(0);
      expect(output).toContain(`checksum mismatch for ${appImageName}`);
      expect(await NodeFSP.readdir(release.desktopDir)).toEqual([]);
      expect(await exists(release.launcher)).toBe(false);
    } finally {
      await release.close();
    }
  });

  it("skips the download for an installed version and repairs the launcher", async () => {
    const release = await makeDesktopRelease({ feedChecksumOf: fakeAppImage });
    try {
      expect((await release.install("--desktop")).code).toBe(0);
      const launcher = await NodeFSP.readFile(release.launcher, "utf8");
      await NodeFSP.rm(release.launcher);
      release.requested.length = 0;

      const { code, output } = await release.install("--desktop");
      expect(code, output).toBe(0);
      expect(release.requested).toEqual(["/index", `/v${desktopVersion}/${desktopFeed}`]);
      expect(output).toContain(`The T3 Code ${desktopVersion} desktop app is already installed.`);
      expect(await NodeFSP.readFile(release.launcher, "utf8")).toBe(launcher);
      expect(await NodeFSP.readdir(release.desktopDir)).toEqual(["T3-Code.AppImage"]);
    } finally {
      await release.close();
    }
  });

  it("uninstalls the desktop app offline and keeps the CLI", async () => {
    const release = await makeDesktopRelease({ feedChecksumOf: fakeAppImage });
    try {
      expect((await release.install("--desktop")).code).toBe(0);
      release.requested.length = 0;

      const { code, output } = await release.install("--uninstall-desktop");
      expect(code, output).toBe(0);
      expect(release.requested).toEqual([]);
      expect(await exists(release.appImage)).toBe(false);
      expect(await exists(release.launcher)).toBe(false);
      expect(await exists(release.icon)).toBe(false);
      expect(await exists(release.desktopDir)).toBe(false);
      expect(await exists(release.cliBin)).toBe(true);
      expect(output).toContain("Run t3 uninstall to remove the CLI and the service");
    } finally {
      await release.close();
    }
  });

  it("rejects unknown arguments before downloading anything", async () => {
    const release = await makeDesktopRelease({ feedChecksumOf: fakeAppImage });
    try {
      const { code, output } = await release.install("--desktp");
      expect(code).not.toBe(0);
      expect(output).toContain("unknown argument '--desktp'");
      expect(release.requested).toEqual([]);
    } finally {
      await release.close();
    }
  });
});
