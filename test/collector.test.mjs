import assert from "node:assert/strict";
import test from "node:test";
import {
  aliasString,
  buildExternalVtadminTopology,
  extractKeyspaceNames,
  extractShards,
  extractTablets,
  retainUnavailableClusters,
} from "../lib/collector.mjs";

test("parses the Vitess 23 GetKeyspaces response", () => {
  const input = [
    { name: "commerce", keyspace: { durability_policy: "none" } },
    { name: "identity", keyspace: { durability_policy: "semi_sync" } },
  ];
  assert.deepEqual(extractKeyspaceNames(input), ["commerce", "identity"]);
});

test("parses primary aliases and base64 key ranges from FindAllShardsInKeyspace", () => {
  const input = {
    shards: {
      "-80": {
        keyspace: "commerce",
        name: "-80",
        shard: {
          primary_alias: { cell: "zone1", uid: 200 },
          key_range: { end: "gA==" },
          is_primary_serving: true,
        },
      },
      "80-": {
        keyspace: "commerce",
        name: "80-",
        shard: {
          primary_alias: { cell: "zone1", uid: 201 },
          key_range: { start: "gA==" },
          is_primary_serving: true,
        },
      },
    },
  };

  assert.deepEqual(
    extractShards(input).map(({ name, keyRange, primaryAlias }) => ({
      name,
      keyRange,
      primaryAlias,
    })),
    [
      {
        name: "-80",
        keyRange: "-80",
        primaryAlias: "zone1-0000000200",
      },
      {
        name: "80-",
        keyRange: "80-",
        primaryAlias: "zone1-0000000201",
      },
    ],
  );
});

test("maps numeric TabletType enums without inventing tablets", () => {
  const input = [
    {
      alias: { cell: "zone1", uid: 100 },
      keyspace: "identity",
      shard: "0",
      type: 1,
      port_map: { grpc: 16100, vt: 15100 },
    },
    {
      alias: { cell: "zone1", uid: 101 },
      keyspace: "identity",
      shard: "0",
      type: 2,
    },
    {
      alias: { cell: "zone1", uid: 102 },
      keyspace: "identity",
      shard: "0",
      type: 3,
    },
    {
      keyspace: "FABRICATED",
      shard: "0",
      type: 1
    },
  ];

  assert.deepEqual(
    extractTablets(input).map(({ alias, type }) => ({ alias, type })),
    [
      { alias: "zone1-0000000100", type: "PRIMARY" },
      { alias: "zone1-0000000101", type: "REPLICA" },
      { alias: "zone1-0000000102", type: "RDONLY" },
    ],
  );
});

test("tablet alias formatting preserves Vitess zero padding", () => {
  assert.equal(aliasString({ cell: "zone1", uid: 42 }), "zone1-0000000042");
  assert.equal(aliasString("zone2-0000000042"), "zone2-0000000042");
  assert.equal(aliasString({ cell: "zone1" }), "");
});

test("merges a VTAdmin external cluster without duplicating the local cluster", () => {
  const result = buildExternalVtadminTopology({
    clusters: [
      { id: "local", name: "Local" },
      { id: "remote-a", name: "Remote Catalog" },
    ],
    keyspaces: [
      {
        cluster: { id: "remote-a", name: "Remote Catalog" },
        keyspace: { name: "catalog", keyspace: { durability_policy: "none" } },
        shards: {
          "-55": {
            name: "-55",
            shard: {
              primary_alias: { cell: "remote-a", uid: 300 },
              key_range: { end: "VQ==" },
              is_primary_serving: true,
            },
          },
          "55-aa": {
            name: "55-aa",
            shard: {
              primary_alias: { cell: "remote-a", uid: 301 },
              key_range: { start: "VQ==", end: "qg==" },
              is_primary_serving: true,
            },
          },
          "aa-": {
            name: "aa-",
            shard: {
              primary_alias: { cell: "remote-a", uid: 302 },
              key_range: { start: "qg==" },
              is_primary_serving: true,
            },
          },
        },
      },
    ],
    tablets: [300, 301, 302].map((uid, index) => ({
      cluster: { id: "remote-a", name: "Remote Catalog" },
      tablet: {
        alias: { cell: "remote-a", uid },
        hostname: "192.0.2.10",
        keyspace: "catalog",
        shard: ["-55", "55-aa", "aa-"][index],
        type: 1,
      },
      state: 1,
      FQDN: `http://192.0.2.10:${15300 + index}`,
    })),
    vschemas: [
      {
        cluster: { id: "remote-a", name: "Remote Catalog" },
        name: "catalog",
        v_schema: {
          sharded: true,
          vindexes: { hash: { type: "hash" } },
          tables: { catalog_items: {} },
        },
      },
    ],
    srvKeyspaces: {
      catalog: {
        srv_keyspaces: {
          "remote-a": {
            partitions: [
              {
                served_type: 1,
                shard_references: [
                  { name: "-55" },
                  { name: "55-aa" },
                  { name: "aa-" },
                ],
              },
            ],
          },
        },
      },
    },
    vtctlds: [
      {
        cluster: { id: "remote-a", name: "Remote Catalog" },
        hostname: "192.0.2.10:25999",
        FQDN: "192.0.2.10:25000",
      },
    ],
  });

  assert.equal(
    result.nodes.filter((node) => node.type === "cluster").length,
    1,
  );
  assert.equal(
    result.nodes.find((node) => node.type === "keyspace")?.label,
    "catalog",
  );
  assert.equal(
    result.nodes.filter((node) => node.type === "shard").length,
    3,
  );
  assert.equal(
    result.nodes.filter((node) => node.type === "tablet").length,
    3,
  );
  assert.equal(result.verified.keyspaces[0], "catalog");
  assert.ok(
    result.edges.some(
      (edge) =>
        edge.views.includes("request") &&
        edge.source.startsWith("gateway:vtadmin:remote-a"),
    ),
  );
});

test("retains the last known external graph and marks its nodes and edges unreachable", () => {
  const clusterNode = {
    id: "cluster:vtadmin:remote-a",
    type: "cluster",
    label: "Remote Catalog",
    status: "HEALTHY",
    attributes: { "Cluster ID": "remote-a" },
    sourceIds: ["vtadmin:clusters"],
  };
  const keyspaceNode = {
    id: "keyspace:vtadmin:remote-a:catalog",
    type: "keyspace",
    label: "catalog",
    status: "HEALTHY",
    attributes: { "Cluster ID": "remote-a", Keyspace: "catalog" },
    sourceIds: ["vtadmin:keyspaces"],
  };
  const cachedEdge = {
    id: "edge:contains:remote-a-catalog",
    source: clusterNode.id,
    target: keyspaceNode.id,
    type: "contains",
    views: ["logical"],
  };
  const retained = retainUnavailableClusters({
    nodes: [clusterNode],
    edges: [],
    previousCache: {
      collectedAt: "2026-07-29T01:00:00.000Z",
      nodes: [clusterNode, keyspaceNode],
      edges: [cachedEdge],
    },
    degradedClusters: [
      {
        id: "remote-a",
        sourceId: "vtadmin:cluster:remote-a:keyspaces",
        error: "request timed out",
        failedSourceIds: ["vtadmin:cluster:remote-a:keyspaces"],
      },
    ],
    collectedAt: "2026-07-29T01:01:00.000Z",
  });

  assert.equal(retained.nodes.length, 2);
  assert.ok(retained.nodes.every((node) => node.status === "UNREACHABLE"));
  assert.equal(
    retained.nodes.find((node) => node.type === "keyspace").attributes.Failure,
    "request timed out",
  );
  assert.equal(retained.edges[0].status, "UNREACHABLE");
  assert.equal(retained.degradedClusters[0].retainedNodes, 2);
});

test("marks a cluster critical when a shard has no Primary", () => {
  const result = buildExternalVtadminTopology({
    clusters: [{ id: "broken", name: "Broken Cluster" }],
    keyspaces: [
      {
        cluster: { id: "broken", name: "Broken Cluster" },
        keyspace: { name: "APP", keyspace: {} },
        shards: {
          "0": {
            name: "0",
            shard: { is_primary_serving: false },
          },
        },
      },
    ],
    vschemas: [
      {
        cluster: { id: "broken", name: "Broken Cluster" },
        name: "APP",
        v_schema: { sharded: false },
      },
    ],
  });

  assert.equal(
    result.nodes.find((node) => node.type === "shard").status,
    "CRITICAL",
  );
  assert.equal(
    result.nodes.find((node) => node.type === "keyspace").status,
    "CRITICAL",
  );
  assert.equal(
    result.nodes.find((node) => node.type === "cluster").status,
    "CRITICAL",
  );
});
