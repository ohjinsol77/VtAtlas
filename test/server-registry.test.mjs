import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  normalizeManagedCluster,
  readRegistry,
  writeRegistry,
} from "../lib/server-registry.mjs";

const cluster = {
  id: "example-prod",
  name: "Example Production",
  enabled: true,
  tabletFqdnTemplate:
    "http://{{ .Tablet.Hostname }}:15{{ .Tablet.Alias.Uid }}",
  discovery: {
    vtctlds: [
      {
        host: {
          fqdn: "example.internal:15000",
          hostname: "example.internal:15999",
        },
      },
    ],
    vtgates: [
      {
        host: {
          fqdn: "example.internal:15001",
          hostname: "example.internal:15991",
        },
      },
    ],
  },
};

test("validates and persists a managed cluster registry", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vtv-registry-"));
  const file = path.join(directory, "managed.json");
  try {
    await writeRegistry(file, { clusters: [cluster] });
    const stored = await readRegistry(file);
    assert.equal(stored.schemaVersion, 1);
    assert.deepEqual(stored.clusters, [cluster]);
    assert.equal(JSON.parse(await readFile(file, "utf8")).clusters[0].id, cluster.id);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("accepts the dynamic host address placeholder", () => {
  const normalized = normalizeManagedCluster({
    ...cluster,
    discovery: {
      vtctlds: [
        {
          host: {
            fqdn: "{{HOST_IP}}:25000",
            hostname: "{{HOST_IP}}:25999",
          },
        },
      ],
      vtgates: cluster.discovery.vtgates,
    },
  });
  assert.equal(
    normalized.discovery.vtctlds[0].host.hostname,
    "{{HOST_IP}}:25999",
  );
});

test("rejects endpoint paths and credentials", () => {
  assert.throws(
    () =>
      normalizeManagedCluster({
        ...cluster,
        discovery: {
          ...cluster.discovery,
          vtctlds: [
            {
              host: {
                fqdn: "example.internal:15000/path",
                hostname: "user:pass@example.internal:15999",
              },
            },
          ],
        },
      }),
    /host:port/,
  );
});
