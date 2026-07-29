# VtAtlas

[English](README.md) | [한국어](README_KR.md)

VtAtlas is a read-only topology explorer for running
[Vitess](https://vitess.io/) environments. It collects the topology that
Vitess actually reports and renders logical, physical, request-path, and
replication views in a local web UI.

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
- Optional official VTAdmin API and Web integration in read-only mode
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

Open [http://localhost:17888](http://localhost:17888). The error center is at
`/errors.html`, and cluster registration is at `/servers.html`.

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

## Data flow

```text
Browser
  └─ VtAtlas :17888
       ├─ local vtctld gRPC through vtctldclient
       ├─ local process, listener, and debug endpoints
       └─ optional VTAdmin API :14200
            ├─ cluster A vtctld / VTGate
            ├─ cluster B vtctld / VTGate
            └─ additional registered clusters
```

VtAtlas does not connect directly to MySQL or write to a topology service such
as etcd. It writes only two app-owned runtime files:
`var/last-good.json` and `var/managed-clusters.json`.

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
`/etc/vtatlas/vtatlas.env`. Enable the two optional VTAdmin services when
multi-cluster support or the official VTAdmin UI is needed:

```bash
sudo systemctl enable --now vtatlas-vtadmin-api.service
sudo systemctl enable --now vtatlas-vtadmin-web.service
sudo systemctl restart vtatlas.service
```

Edit the units if another installation path or service account is used.

## Security model

- All web services bind to loopback by default.
- VTAdmin uses server-side read-only RBAC and read-only Web mode.
- VtAtlas has no Reparent, VSchema mutation, workflow mutation, or SQL write
  operation.
- External commands use fixed executables and argument arrays without a shell.
- Command and HTTP reads have bounded timeouts.
- Password, token, secret, credential, and private-key fields are redacted.
- Cluster registry writes require same-origin JSON requests and an explicit
  intent header.
- Runtime state is excluded from Git.

VtAtlas does not provide authentication. For internal-network access, keep the
services on loopback and place an authenticated TLS reverse proxy with network
ACLs in front of them.

## Test

```bash
npm run check
npm test
```

The tests use synthetic cluster names and documentation-only IP ranges. They do
not require a live Vitess cluster.

## License

Apache License 2.0. Vitess and VTAdmin are projects of the Vitess community;
VtAtlas is an independent visualization tool.
