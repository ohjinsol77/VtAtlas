// Authentication is intentionally a replaceable boundary. The initial local-only
// release uses a short-lived DBA session and explicit per-action approval, but
// does not claim that this is user authentication.
export async function authenticateOperator(_request) {
  const mode = process.env.VTO_AUTH_MODE ?? "deferred";
  if (mode !== "deferred") {
    const error = new Error(`unsupported operator authentication mode: ${mode}`);
    error.status = 501;
    throw error;
  }
  return {
    id: "local-operator",
    roles: ["dba"],
    authenticationMode: "deferred",
    authenticated: false,
  };
}
