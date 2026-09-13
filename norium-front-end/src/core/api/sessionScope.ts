import { authToken } from "./config";

export function workspaceScope() {
  return localStorage.getItem("norium-workspace-id") || "primary";
}

/** Memory-only identity for rejecting responses from a previous login/workspace. */
export function requestScope() {
  return JSON.stringify([authToken(), workspaceScope()]);
}
