import { spawn } from "node:child_process";
import { unwatchFile, watchFile } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readRegistry } from "../lib/server-registry.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const defaultConfigPath = path.join(moduleDir, "clusters.json");
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);
const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function localAddress(value, label) {
  const address = requiredString(value, label);
  const parsed = new URL(`http://${address}`);
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error(`${label} must bind to localhost, got ${parsed.hostname}`);
  }
  if (!parsed.port) throw new Error(`${label} must include a port`);
  return address;
}

function localOrigin(value, label) {
  const origin = new URL(requiredString(value, label));
  if (!["http:", "https:"].includes(origin.protocol)) {
    throw new Error(`${label} must use http or https`);
  }
  if (!LOOPBACK_HOSTS.has(origin.hostname)) {
    throw new Error(`${label} must use localhost, got ${origin.hostname}`);
  }
  return origin.origin;
}

function resolveConfigFile(configDir, value, label) {
  const file = requiredString(value, label);
  if (file.includes(",")) throw new Error(`${label} cannot contain a comma`);
  return path.isAbsolute(file) ? file : path.resolve(configDir, file);
}

function hostIpv4() {
  const override = process.env.VTA_HOST_IP ?? process.env.VTA_WSL_IP;
  if (override) {
    if (net.isIP(override) !== 4) {
      throw new Error("VTA_HOST_IP (or legacy VTA_WSL_IP) must be an IPv4 address");
    }
    return override;
  }

  const interfaces = os.networkInterfaces();
  const eth0 = interfaces.eth0?.find(
    (address) => address.family === "IPv4" && !address.internal,
  );
  const fallback = Object.values(interfaces)
    .flatMap((addresses) => addresses ?? [])
    .find((address) => address.family === "IPv4" && !address.internal);
  const address = eth0?.address ?? fallback?.address;
  if (!address) throw new Error("could not determine the host IPv4 address");
  return address;
}

async function writeRuntimeDiscovery(source, clusterId) {
  const address = hostIpv4();
  const expanded = JSON.stringify(source, null, 2)
    .replaceAll("{{HOST_IP}}", address)
    .replaceAll("{{WSL_IP}}", address);
  const runtimeDir =
    process.env.VTA_RUNTIME_DIR ??
    path.join(os.tmpdir(), "vitess-vtadmin-discovery");
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  const runtimeFile = path.join(runtimeDir, `${clusterId}.json`);
  await writeFile(runtimeFile, `${expanded}\n`, { mode: 0o600 });
  return runtimeFile;
}

async function materializeDiscovery(sourceFile, clusterId) {
  const source = await readFile(sourceFile, "utf8");
  if (!source.includes("{{HOST_IP}}") && !source.includes("{{WSL_IP}}")) {
    return sourceFile;
  }
  return writeRuntimeDiscovery(JSON.parse(source), clusterId);
}

async function clusterFlag(cluster, configDir, index) {
  const label = `clusters[${index}]`;
  const id = requiredString(cluster?.id, `${label}.id`);
  if (!ID_RE.test(id)) {
    throw new Error(`${label}.id contains unsupported characters`);
  }
  const name = requiredString(cluster?.name, `${label}.name`);
  if (name.includes(",")) throw new Error(`${label}.name cannot contain a comma`);
  const discoveryFile = cluster?.discovery
    ? await writeRuntimeDiscovery(cluster.discovery, id)
    : await materializeDiscovery(
        resolveConfigFile(
          configDir,
          cluster?.discoveryFile,
          `${label}.discoveryFile`,
        ),
        id,
      );
  const tabletFqdnTemplate = requiredString(
    cluster?.tabletFqdnTemplate,
    `${label}.tabletFqdnTemplate`,
  );
  if (tabletFqdnTemplate.includes(",")) {
    throw new Error(`${label}.tabletFqdnTemplate cannot contain a comma`);
  }

  return [
    `id=${id}`,
    `name=${name}`,
    "discovery=staticfile",
    `discovery-staticfile-path=${discoveryFile}`,
    `tablet-fqdn-tmpl=${tabletFqdnTemplate}`,
    "vtctld-backoff-strategy=exponential",
    "vtsql-backoff-strategy=exponential",
    "schema-cache-default-expiration=1m",
    "schema-cache-backfill-queue-size=0",
    "schema-cache-backfill-request-ttl=100ms",
    "schema-cache-backfill-enqueue-wait-time=50ms",
  ].join(",");
}

export async function buildLaunch(
  configPath = defaultConfigPath,
  managedConfigPath = process.env.VTA_MANAGED_CLUSTER_CONFIG,
) {
  const absoluteConfigPath = path.resolve(configPath);
  const configDir = path.dirname(absoluteConfigPath);
  const config = JSON.parse(await readFile(absoluteConfigPath, "utf8"));
  const binary = requiredString(config.binary, "binary");
  const bind = localAddress(
    process.env.VTA_API_BIND ?? config.bind,
    "bind",
  );
  const origins = (config.origins ?? []).map((value, index) =>
    localOrigin(value, `origins[${index}]`),
  );
  if (!origins.length) throw new Error("at least one localhost origin is required");
  const rbacConfig = resolveConfigFile(
    configDir,
    process.env.VTA_RBAC_CONFIG ?? config.rbacConfig,
    "rbacConfig",
  );
  const managed = managedConfigPath
    ? await readRegistry(path.resolve(managedConfigPath))
    : { clusters: [] };
  const clusters = [
    ...(Array.isArray(config.clusters) ? config.clusters : []),
    ...managed.clusters.filter((cluster) => cluster.enabled),
  ];
  if (!clusters.length) {
    throw new Error("at least one cluster is required");
  }
  const clusterIds = new Set();
  for (const cluster of clusters) {
    if (clusterIds.has(cluster.id)) {
      throw new Error(`duplicate cluster id: ${cluster.id}`);
    }
    clusterIds.add(cluster.id);
  }

  const args = [
    "--addr",
    bind,
    "--http-no-debug",
    "--logtostderr",
    "--rbac",
    "--rbac-config",
    rbacConfig,
  ];
  for (const origin of origins) args.push("--http-origin", origin);
  for (const [index, cluster] of clusters.entries()) {
    args.push("--cluster", await clusterFlag(cluster, configDir, index));
  }
  return { binary, args };
}

export async function main() {
  const configPath = process.env.VTA_CLUSTER_CONFIG ?? defaultConfigPath;
  const managedConfigPath = process.env.VTA_MANAGED_CLUSTER_CONFIG;
  let child;
  let restartRequested = false;
  let stopping = false;

  const done = new Promise((resolve, reject) => {
    const launch = async () => {
      try {
        const { binary, args } = await buildLaunch(
          configPath,
          managedConfigPath,
        );
        child = spawn(binary, args, { stdio: "inherit" });
        child.once("error", reject);
        child.once("exit", (code, signal) => {
          child = undefined;
          if (stopping) {
            resolve(code ?? (signal ? 1 : 0));
            return;
          }
          if (restartRequested) {
            restartRequested = false;
            setTimeout(() => void launch(), 250);
            return;
          }
          resolve(code ?? (signal ? 1 : 0));
        });
      } catch (error) {
        reject(error);
      }
    };
    void launch();
  });

  if (managedConfigPath) {
    watchFile(
      managedConfigPath,
      { interval: 1000, persistent: false },
      (current, previous) => {
        if (stopping || current.mtimeMs === previous.mtimeMs) return;
        restartRequested = true;
        child?.kill("SIGTERM");
      },
    );
  }
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      stopping = true;
      if (managedConfigPath) unwatchFile(managedConfigPath);
      if (child) child.kill(signal);
    });
  }

  process.exitCode = await done;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`VTAdmin launcher failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
