import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const HOST_ADDRESS_RE = /^\{\{HOST_IP\}\}:(\d{1,5})$/;
const MAX_ENDPOINTS = 32;

function requiredString(value, label, maxLength = 500) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} 항목을 입력하세요.`);
  }
  const result = value.trim();
  if (result.length > maxLength) {
    throw new Error(`${label} 항목이 너무 깁니다.`);
  }
  return result;
}

function endpointAddress(value, label) {
  const address = requiredString(value, label, 300);
  const hostMatch = address.match(HOST_ADDRESS_RE);
  if (hostMatch) {
    const port = Number(hostMatch[1]);
    if (port < 1 || port > 65535) throw new Error(`${label} 포트가 올바르지 않습니다.`);
    return address;
  }

  let parsed;
  try {
    parsed = new URL(`http://${address}`);
  } catch {
    throw new Error(`${label} 형식은 host:port 이어야 합니다.`);
  }
  if (
    !parsed.hostname ||
    !parsed.port ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${label} 형식은 host:port 이어야 합니다.`);
  }
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} 포트가 올바르지 않습니다.`);
  }
  return address;
}

function normalizeHosts(value, label) {
  if (!Array.isArray(value) || !value.length || value.length > MAX_ENDPOINTS) {
    throw new Error(`${label}에는 1~${MAX_ENDPOINTS}개의 endpoint가 필요합니다.`);
  }
  return value.map((entry, index) => ({
    host: {
      fqdn: endpointAddress(entry?.host?.fqdn, `${label}[${index}] HTTP`),
      hostname: endpointAddress(entry?.host?.hostname, `${label}[${index}] gRPC`),
    },
  }));
}

export function normalizeManagedCluster(value) {
  const id = requiredString(value?.id, "Cluster ID", 128);
  if (!ID_RE.test(id)) {
    throw new Error("Cluster ID에는 영문, 숫자, 점, 밑줄, 콜론, 하이픈만 사용할 수 있습니다.");
  }
  const name = requiredString(value?.name, "표시명", 160);
  if (name.includes(",")) throw new Error("표시명에는 쉼표를 사용할 수 없습니다.");
  const tabletFqdnTemplate = requiredString(
    value?.tabletFqdnTemplate ??
      "http://{{ .Tablet.Hostname }}:15{{ .Tablet.Alias.Uid }}",
    "Tablet URL 템플릿",
  );
  if (
    !/^https?:\/\//.test(tabletFqdnTemplate) ||
    !tabletFqdnTemplate.includes(".Tablet.Hostname") ||
    tabletFqdnTemplate.includes(",")
  ) {
    throw new Error("Tablet URL 템플릿은 HTTP(S)이며 Tablet.Hostname을 포함해야 합니다.");
  }

  return {
    id,
    name,
    enabled: value?.enabled !== false,
    tabletFqdnTemplate,
    discovery: {
      vtctlds: normalizeHosts(value?.discovery?.vtctlds, "vtctld"),
      vtgates: normalizeHosts(value?.discovery?.vtgates, "VTGate"),
    },
  };
}

export function normalizeRegistry(value) {
  const clusters = (Array.isArray(value?.clusters) ? value.clusters : []).map(
    normalizeManagedCluster,
  );
  const ids = new Set();
  for (const cluster of clusters) {
    if (ids.has(cluster.id)) throw new Error(`중복 Cluster ID: ${cluster.id}`);
    ids.add(cluster.id);
  }
  return { schemaVersion: 1, clusters };
}

export async function readRegistry(file) {
  try {
    return normalizeRegistry(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if (error.code === "ENOENT") return { schemaVersion: 1, clusters: [] };
    throw error;
  }
}

export async function writeRegistry(file, value) {
  const registry = normalizeRegistry(value);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporaryFile = `${file}.${process.pid}.tmp`;
  await writeFile(temporaryFile, `${JSON.stringify(registry, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryFile, file);
  return registry;
}
