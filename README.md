# VtAtlas

[English](README.md) | [한국어](README_KR.md)

VtAtlas is a topology explorer and guarded operations console for running
[Vitess](https://vitess.io/) environments. It collects the topology that
Vitess actually reports and renders logical, physical, request-path, and
replication views in a local web UI. Viewer mode is read-only. Optional DBA
mode places a local Operator API, per-action approval, audit logging, and
limited VTAdmin write RBAC in front of operational changes.

The repository contains application source and generic examples only. It does
not contain topology snapshots, database data, credentials, or configuration
from the environment where VtAtlas was developed.

## What it shows

- Fixed top-to-bottom layouts for logical, physical, request, and replication
  relationships
- Multi-cluster lanes so identically named keyspaces do not overlap
- Double-click focus navigation, multi-step relationship traversal, back
  navigation, pan, zoom, and fit-to-screen
- Unsharded keyspaces as distinct teal keyspace nodes without a redundant
  `Shard 0` box
- Dedicated error center and direct error link in the red status banner
- Installed but stopped components such as VTOrc, VTAdmin, and `mysqlctld`
- Multi-server registration for vtctld and VTGate endpoints
- A VtAtlas operations console that exposes every HTTP route registered by
  VTAdmin 23.0.3: 35 Viewer operations and 41 DBA operations
- Separate read-only and limited-write VTAdmin processes, explicit DBA session,
  live target preflight, one-time approval, exact confirmation phrase, and
  local JSONL audit log
- Last-known-good retention: unreachable clusters stay visible instead of
  disappearing during a timeout

Status colors have a consistent operational meaning:

| Color | Meaning |
| --- | --- |
| Green | Healthy |
| Yellow | Performance degradation, replica failure, or replication degradation |
| Red | Service-impacting failure such as a missing primary or unreachable cluster |
| Gray | Unknown, maintenance, or installed but not running |

## Requirements

- Linux or WSL
- Node.js 20 or newer
- A reachable `vtctld` gRPC endpoint
- `vtctldclient` from the Vitess installation
- `netstat` from `net-tools` for local listener discovery
- Optional: the Vitess `vtadmin` binary and built VTAdmin Web assets

VtAtlas has no third-party npm runtime dependencies.

## Quick start

```bash
git clone https://github.com/ohjinsol77/VtAtlas.git
cd VtAtlas
cp config.example.env config.env
```

Edit `config.env` for the local Vitess installation. At minimum, verify these
values:

```bash
VTV_VTCTLDCLIENT=/opt/vitess/current/bin/vtctldclient
VTV_VTCTLD_ADDRESS=127.0.0.1:15999
```

Then load the configuration, validate the source, and start the UI:

```bash
set -a
. ./config.env
set +a
npm run check
npm test
npm start
```

Open [http://localhost:17888](http://localhost:17888). The operations console
is at `/admin.html`, the error center is at `/errors.html`, and cluster
registration is at `/servers.html`.

`VTV_START_SCRIPT` is optional. When set, VtAtlas reads non-secret startup hints
from that file; topology relationships still come from live Vitess APIs and
process data.

## Multi-cluster setup

The main collector uses `vtctldclient` for its local cluster. Additional
clusters are aggregated through the official VTAdmin API.

1. Edit `vtadmin/clusters.json` and `vtadmin/discovery-local.json` for the
   initial cluster.
2. Start the read-only VTAdmin API:

   ```bash
   node vtadmin/launcher.mjs
   ```

3. In another process, start the optional official VTAdmin Web frontend:

   ```bash
   node vtadmin/web-server.mjs
   ```

4. Set `VTV_VTADMIN_API=http://127.0.0.1:14200` before starting VtAtlas.
5. Add more clusters from `http://localhost:17888/servers.html`.

Each cluster can contain multiple vtctld and VTGate endpoints. `fqdn` is the
HTTP endpoint and `hostname` is the gRPC endpoint:

```json
{
  "id": "production-a",
  "name": "Production A",
  "enabled": true,
  "tabletFqdnTemplate": "http://{{ .Tablet.Hostname }}:15{{ .Tablet.Alias.Uid }}",
  "discovery": {
    "vtctlds": [
      {
        "host": {
          "fqdn": "control-a.example.net:15000",
          "hostname": "control-a.example.net:15999"
        }
      }
    ],
    "vtgates": [
      {
        "host": {
          "fqdn": "gateway-a.example.net:15001",
          "hostname": "gateway-a.example.net:15991"
        }
      }
    ]
  }
}
```

The disabled example in `vtadmin/managed-clusters.example.json` can also be
copied to `var/managed-clusters.json`. If a host address changes at runtime,
`{{HOST_IP}}:port` can be used in an endpoint and overridden with
`VTA_HOST_IP`.

The managed registry is watched by the launcher. Saving a server change causes
a graceful VTAdmin restart; it does not modify the remote Vitess cluster.

## Viewer and DBA modes

Viewer mode calls only the read operation allowlist through the read-only
VTAdmin API. DBA mode is optional and uses a separate process chain:

```text
Viewer
  └─ VtAtlas :17888
       └─ read operation allowlist
            └─ read-only VTAdmin :14200

DBA
  └─ VtAtlas :17888
       └─ Operator API :17890
            ├─ short-lived DBA session
            ├─ live Cluster/Keyspace/Shard/Tablet preflight
            ├─ one-time approval + exact confirmation phrase
            ├─ redacted JSONL audit log
            └─ limited-write VTAdmin :14202
```

The operations console covers inventory, topology, diagnostics, replication,
HA, tablets, schemas and online DDL, workflows, VDiff, transactions, and
VExplain/VTExplain.

| Area | DBA operations |
| --- | --- |
| Topology | Create/delete Keyspace and Shard, delete Tablet, rebuild serving graph, remove Keyspace cell |
| HA | Planned/Emergency Failover and external promotion acknowledgement |
| Tablet | Read-only/read-write, refresh state, reload schema |
| Replication | Start/stop replication and refresh replication source |
| Validation | Cluster, Keyspace, Shard, schema, and version validation |
| Schema | Reload, apply schema/online DDL, cancel/cleanup/complete/launch/retry migration |
| Workflow | Start/stop, Materialize, MoveTables, Reshard, traffic switch, complete/delete, VDiff |
| Transaction | Conclude an unresolved distributed transaction |

DBA authentication is deliberately **not implemented yet**. The current
release is safe only as a localhost development/operator boundary. Before
exposing it to an internal network, replace `operator/auth.mjs` with the
organization's authenticated identity and approval integration, keep the
Operator and both VTAdmin ports private, and put authenticated TLS and network
ACLs in front of VtAtlas.

## Data flow

```text
Browser
  └─ VtAtlas :17888
       ├─ local vtctld gRPC through vtctldclient
       ├─ local process, listener, and debug endpoints
       ├─ read-only VTAdmin API :14200
       │    ├─ cluster A vtctld / VTGate
       │    ├─ cluster B vtctld / VTGate
       │    └─ additional registered clusters
       └─ optional Operator API :17890
            └─ limited-write VTAdmin API :14202
```

VtAtlas does not connect directly to MySQL. Viewer mode does not write to
Vitess. Approved DBA operations are sent to vtctld through the separate
limited-write VTAdmin process. App-owned runtime files are
`var/last-good.json`, `var/managed-clusters.json`, and
`var/operator-audit.jsonl`.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Process health |
| `GET` | `/api/topology` | Latest normalized topology |
| `POST` | `/api/refresh` | Trigger a read-only refresh |
| `GET` | `/api/servers` | List built-in and managed clusters |
| `POST` | `/api/servers` | Register a monitoring target |
| `PUT` | `/api/servers/:id` | Update a monitoring target |
| `DELETE` | `/api/servers/:id` | Remove a monitoring target |
| `GET` | `/api/raw/:sourceId` | View a redacted source response |
| `GET` | `/api/configuration` | View non-secret runtime settings |
| `GET` | `/api/admin/catalog` | Viewer VTAdmin operation catalog |
| `POST` | `/api/admin/read` | Execute an allowlisted Viewer operation |
| `GET` | `/api/operator/catalog` | DBA operation catalog |
| `GET/POST/DELETE` | `/api/operator/session` | Inspect, enter, or leave DBA mode |
| `POST` | `/api/operator/prepare` | Validate a DBA target and create one-time approval |
| `POST` | `/api/operator/execute` | Execute an approved operation |
| `GET` | `/api/operator/audit` | Read recent redacted audit events |

## systemd

Generic units are provided in `deploy/` and assume the repository is installed
at `/opt/vtatlas` under a `vitess` user:

```bash
sudo install -d -o vitess -g vitess /opt/vtatlas /opt/vtatlas/var
sudo install -d -m 0750 /etc/vtatlas
sudo cp config.example.env /etc/vtatlas/vtatlas.env
sudo cp deploy/*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now vtatlas.service
```

Install or clone the source into `/opt/vtatlas`, then update
`/etc/vtatlas/vtatlas.env`. Enable the read-only VTAdmin service for
multi-cluster Viewer features:

```bash
sudo systemctl enable --now vtatlas-vtadmin-api.service
sudo systemctl restart vtatlas.service
```

To enable DBA mode, set
`VTV_OPERATOR_API=http://127.0.0.1:17890` in the environment file and start the
separate limited-write VTAdmin and Operator services:

```bash
sudo systemctl enable --now vtatlas-vtadmin-operator.service
sudo systemctl enable --now vtatlas-operator.service
sudo systemctl restart vtatlas.service
```

The legacy official VTAdmin frontend remains optional:

```bash
sudo systemctl enable --now vtatlas-vtadmin-web.service
```

Edit the units if another installation path or service account is used.

## Security model

- All web services bind to loopback by default.
- Viewer and DBA requests use separate endpoint allowlists and VTAdmin
  processes.
- Viewer VTAdmin uses read-only RBAC. Operator VTAdmin uses an explicit
  operation-specific write RBAC instead of wildcard write actions.
- The Operator API requires an explicit intent header, a short-lived DBA
  session, current-target preflight, a one-time approval token, and an exact
  action/target confirmation phrase.
- External commands use fixed executables and argument arrays without a shell.
- Command and HTTP requests have bounded timeouts and response sizes.
- Password, token, secret, credential, and private-key fields are redacted.
- Cluster registry writes require same-origin JSON requests and an explicit
  intent header.
- Operator events are appended to a mode-0600 JSONL audit log.
- Runtime state and audit logs are excluded from Git.

VtAtlas does not yet provide authentication. A typed `DBA MODE` acknowledgement
is a safety interlock, not identity verification. For internal-network access,
implement the authentication boundary first; keep ports 14200, 14202, and
17890 on loopback and expose only the main VtAtlas service through an
authenticated TLS reverse proxy with network ACLs.

## Test

```bash
npm run check
npm test
```

The tests use synthetic cluster names and documentation-only IP ranges. They do
not require a live Vitess cluster. They cover the complete v23.0.3 route
catalog, request/path validation, response limits and redaction, session and
approval enforcement, immutable requests, audit logging, unsharded topology,
local sharding, and remote sharding.

After configuring a live environment, this safe probe checks Viewer data,
preflight, all discovered unsharded/local-sharded/remote-sharded Shards, audit
logging, and before/after topology equality. Without the flag it stops after
preflight. With the flag it executes only `ValidateShard`:

```bash
node scripts/live-operator-probe.mjs
node scripts/live-operator-probe.mjs --execute-validations
```

## License

Apache License 2.0. Vitess and VTAdmin are projects of the Vitess community;
VtAtlas is an independent visualization tool.
