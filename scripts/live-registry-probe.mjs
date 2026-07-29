// Live smoke probe; intentionally excluded from the unit-test discovery path.
const base = "http://127.0.0.1:17888";
const headers = {
  "Content-Type": "application/json",
  "X-Vitess-Topology-Intent": "manage-servers",
};
const probe = {
  id: "codex-registration-probe",
  name: "Registration Probe",
  enabled: false,
  tabletFqdnTemplate:
    "http://{{ .Tablet.Hostname }}:15{{ .Tablet.Alias.Uid }}",
  discovery: {
    vtctlds: [
      {
        host: {
          fqdn: "127.0.0.1:15000",
          hostname: "127.0.0.1:15999",
        },
      },
    ],
    vtgates: [
      {
        host: {
          fqdn: "127.0.0.1:15001",
          hostname: "127.0.0.1:15991",
        },
      },
    ],
  },
};

let response = await fetch(`${base}/api/servers`, {
  method: "POST",
  headers,
  body: JSON.stringify(probe),
});
if (response.status !== 201) {
  throw new Error(`create ${response.status}: ${await response.text()}`);
}
await new Promise((resolve) => setTimeout(resolve, 1600));

let listed = await (await fetch(`${base}/api/servers`)).json();
if (!listed.managed.some((cluster) => cluster.id === probe.id)) {
  throw new Error("probe missing after create");
}

response = await fetch(`${base}/api/servers/${probe.id}`, {
  method: "DELETE",
  headers,
  body: "{}",
});
if (!response.ok) {
  throw new Error(`delete ${response.status}: ${await response.text()}`);
}
await new Promise((resolve) => setTimeout(resolve, 2200));

listed = await (await fetch(`${base}/api/servers`)).json();
if (listed.managed.some((cluster) => cluster.id === probe.id)) {
  throw new Error("probe remained after delete");
}
const clusters = await (
  await fetch("http://127.0.0.1:14200/api/clusters")
).json();
process.stdout.write(
  `${JSON.stringify(
    {
      create: 201,
      delete: response.status,
      managed: listed.managed.map((cluster) => cluster.id),
      vtadminClusters: clusters.result.clusters.map((cluster) => cluster.id),
    },
    null,
    2,
  )}\n`,
);
