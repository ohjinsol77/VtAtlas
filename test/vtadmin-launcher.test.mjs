import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildLaunch } from "../vtadmin/launcher.mjs";

test("launcher materializes generic and legacy WSL host placeholders", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vtatlas-launcher-"));
  const configFile = path.join(directory, "clusters.json");
  const managedFile = path.join(directory, "managed.json");
  await writeFile(
    configFile,
    JSON.stringify({
      binary: "/bin/true",
      bind: "127.0.0.1:14200",
      origins: ["http://127.0.0.1:14201"],
      rbacConfig: "./rbac.yaml",
      clusters: [],
    }),
  );
  await writeFile(
    managedFile,
    JSON.stringify({
      schemaVersion: 1,
      clusters: [
        {
          id: "generic",
          name: "Generic",
          enabled: true,
          tabletFqdnTemplate: "http://{{ .Tablet.Hostname }}",
          discovery: {
            vtctlds: [
              {
                host: {
                  fqdn: "{{HOST_IP}}:15000",
                  hostname: "{{HOST_IP}}:15999",
                },
              },
            ],
            vtgates: [
              {
                host: {
                  fqdn: "{{HOST_IP}}:15001",
                  hostname: "{{HOST_IP}}:15991",
                },
              },
            ],
          },
        },
        {
          id: "legacy-wsl",
          name: "Legacy WSL",
          enabled: true,
          tabletFqdnTemplate: "http://{{ .Tablet.Hostname }}",
          discovery: {
            vtctlds: [
              {
                host: {
                  fqdn: "{{WSL_IP}}:25000",
                  hostname: "{{WSL_IP}}:25999",
                },
              },
            ],
            vtgates: [
              {
                host: {
                  fqdn: "{{WSL_IP}}:25001",
                  hostname: "{{WSL_IP}}:25991",
                },
              },
            ],
          },
        },
      ],
    }),
  );

  const originalHostIp = process.env.VTA_HOST_IP;
  const originalRuntimeDir = process.env.VTA_RUNTIME_DIR;
  process.env.VTA_HOST_IP = "192.0.2.44";
  process.env.VTA_RUNTIME_DIR = directory;
  try {
    const launch = await buildLaunch(configFile, managedFile);
    const discoveryFiles = launch.args
      .filter((value) => value.startsWith("id="))
      .map((value) =>
        value
          .split(",")
          .find((part) => part.startsWith("discovery-staticfile-path="))
          .slice("discovery-staticfile-path=".length),
      );
    assert.equal(discoveryFiles.length, 2);
    for (const file of discoveryFiles) {
      const materialized = await readFile(file, "utf8");
      assert.match(materialized, /192\.0\.2\.44/);
      assert.doesNotMatch(materialized, /\{\{(?:HOST|WSL)_IP\}\}/);
    }
  } finally {
    if (originalHostIp === undefined) delete process.env.VTA_HOST_IP;
    else process.env.VTA_HOST_IP = originalHostIp;
    if (originalRuntimeDir === undefined) delete process.env.VTA_RUNTIME_DIR;
    else process.env.VTA_RUNTIME_DIR = originalRuntimeDir;
  }
});
