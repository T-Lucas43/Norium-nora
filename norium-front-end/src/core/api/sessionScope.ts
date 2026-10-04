import { authToken } from "./config";
import { accessClaims } from "./cookieSession";

export function workspaceScope() {
  return localStorage.getItem("norium-workspace-id") || "primary";
}

/** Memory-only identity for rejecting responses from a previous login/workspace. */
export function requestScope() {
  const token = authToken();
  const claims = token ? accessClaims(token) : null;
  const identity = claims?.sid ? [claims.sub, claims.sid] : token;
  return JSON.stringify([identity, workspaceScope()]);
}
