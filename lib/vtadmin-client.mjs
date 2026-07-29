const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);
const SECRET_RE =
  /(password|passwd|token|secret|credential|private[-_]?key|authorization|grpc-auth|mysql-auth)/i;

export function loopbackBaseUrl(value, label = "VTAdmin API") {
  const url = new URL(String(value ?? ""));
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`${label} must use HTTP(S)`);
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(`${label} must use a loopback address`);
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${label} must be an origin without credentials or a path`);
  }
  return url.origin;
}

function redactString(value) {
  return String(value)
    .replace(
      /((?:password|passwd|token|secret|credential|private[-_]?key)\s*[=:]\s*)([^\s"',]+)/gi,
      "$1<redacted>",
    )
    .replace(/(authorization:\s*)([^\r\n]+)/gi, "$1<redacted>");
}

export function redactValue(value, key = "") {
  if (SECRET_RE.test(key)) return "<redacted>";
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [
        childKey,
        redactValue(child, childKey),
      ]),
    );
  }
  return value;
}

async function limitedText(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw new Error("VTAdmin response exceeded the configured size limit");
    }
    chunks.push(value);
  }
  const result = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(result);
}

export async function vtadminRequest(
  baseUrl,
  request,
  {
    timeoutMs = 30_000,
    maxResponseBytes = 16 * 1024 * 1024,
    redact = true,
  } = {},
) {
  const origin = loopbackBaseUrl(baseUrl);
  const target = new URL(request.path, origin);
  if (target.origin !== origin || !target.pathname.startsWith("/api/")) {
    throw new Error("VTAdmin request path is outside the API allowlist");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetch(target, {
      method: request.method,
      headers: {
        Accept: "application/json",
        ...(request.headers ?? {}),
      },
      body: request.body,
      redirect: "error",
      signal: controller.signal,
    });
    const text = await limitedText(response, maxResponseBytes);
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { ok: false, error: "VTAdmin returned malformed JSON" };
    }
    return {
      status: response.status,
      ok: response.ok && body?.ok !== false,
      body: redact ? redactValue(body) : body,
    };
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error("VTAdmin request timed out");
      timeoutError.status = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
