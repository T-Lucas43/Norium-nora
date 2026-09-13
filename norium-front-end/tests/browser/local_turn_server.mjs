import fs from "node:fs";
import http from "node:http";
import process from "node:process";

import { createServer } from "turn-server";

const env = process.env;

function requiredString(...names) {
  for (const name of names) {
    const value = env[name];
    if (value) return value;
  }
  throw new Error(`Missing required environment variable ${names.join(" or ")}.`);
}

function optionalString(name, fallback = "") {
  return env[name]?.trim() || fallback;
}

function integer(name, fallback, { min = 0, max = 65_535 } = {}) {
  const raw = env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function boolean(name, fallback = false) {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes"].includes(raw)) return true;
  if (["0", "false", "no"].includes(raw)) return false;
  throw new Error(`${name} must be true or false.`);
}

function readableFile(name) {
  const path = optionalString(name);
  if (!path) throw new Error(`${name} is required when TURN test TLS is enabled.`);
  try {
    fs.accessSync(path, fs.constants.R_OK);
  } catch (error) {
    throw new Error(`${name} is not a readable file: ${path}`, { cause: error });
  }
  return path;
}

function emit(event, details = {}) {
  process.stdout.write(`${JSON.stringify({ event, ...details })}\n`);
}

const host = optionalString("TURN_TEST_HOST", "127.0.0.1");
const externalIp = optionalString("TURN_TEST_EXTERNAL_IP", host === "0.0.0.0" ? "127.0.0.1" : host);
const realm = optionalString("TURN_TEST_REALM", "team-calls.test");
const secret = requiredString("TURN_TEST_SECRET", "TEAM_CALL_TURN_SHARED_SECRET");
if (secret.length < 32 || /\s|[^\x21-\x7e]/u.test(secret)) {
  throw new Error("TURN test secret must contain at least 32 printable ASCII characters without whitespace.");
}

const turnPort = integer("TURN_TEST_PORT", 3478, { min: 1 });
const healthPort = integer("TURN_TEST_HEALTH_PORT", 3479, { min: 0 });
const relayMinPort = integer("TURN_TEST_RELAY_MIN_PORT", 49_152, { min: 1 });
const relayMaxPort = integer("TURN_TEST_RELAY_MAX_PORT", 49_255, { min: relayMinPort });
const enableTcp = boolean("TURN_TEST_TCP", true);
const tlsRequested = boolean("TURN_TEST_TLS")
  || Boolean(optionalString("TURN_TEST_TLS_PORT"))
  || Boolean(optionalString("TURN_TEST_TLS_CERT"))
  || Boolean(optionalString("TURN_TEST_TLS_KEY"));
const tlsPort = tlsRequested ? integer("TURN_TEST_TLS_PORT", 5349, { min: 1 }) : null;
const tlsCert = tlsRequested ? readableFile("TURN_TEST_TLS_CERT") : null;
const tlsKey = tlsRequested ? readableFile("TURN_TEST_TLS_KEY") : null;
const drainMs = integer("TURN_TEST_DRAIN_MS", 2_000, { min: 0, max: 30_000 });

const endpoints = [
  { port: turnPort, transport: "udp", address: host },
  ...(enableTcp ? [{ port: turnPort, transport: "tcp", address: host }] : []),
  ...(tlsRequested
    ? [{ port: tlsPort, transport: "tls", address: host, cert: tlsCert, key: tlsKey }]
    : []),
];
const expectedEndpoints = new Set(endpoints.map(({ port, transport }) => `${transport}:${port}`));
const listeningEndpoints = new Map();
let ready = false;
let shuttingDown = false;

const turnServer = createServer({
  auth: { mechanism: "long-term", realm, secret },
  relay: { ip: host, externalIp, portRange: [relayMinPort, relayMaxPort] },
  allowLoopback: true,
  idleTimeout: integer("TURN_TEST_IDLE_TIMEOUT_MS", 30_000, { min: 1_000, max: 300_000 }),
  maxConnections: integer("TURN_TEST_MAX_CONNECTIONS", 500, { min: 1, max: 10_000 }),
  totalQuota: integer("TURN_TEST_TOTAL_QUOTA", 500, { min: 1, max: 10_000 }),
});

const healthServer = http.createServer((request, response) => {
  if (!["/healthz", "/readyz"].includes(request.url || "")) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "not-found" }));
    return;
  }
  const healthy = ready && !shuttingDown && turnServer.isHealthy();
  response.writeHead(healthy ? 200 : 503, {
    "cache-control": "no-store",
    "content-type": "application/json",
  });
  response.end(JSON.stringify({
    status: healthy ? "ready" : "starting",
    endpoints: [...listeningEndpoints.values()],
    stats: turnServer.getStats(),
  }));
});

function maybeReady() {
  if (ready || shuttingDown
    || [...expectedEndpoints].some((endpoint) => !listeningEndpoints.has(endpoint))) return;
  ready = true;
  const healthAddress = healthServer.address();
  emit("turn-test-ready", {
    realm,
    healthUrl: `http://127.0.0.1:${healthAddress.port}/healthz`,
    endpoints: [...listeningEndpoints.values()],
    relayPortRange: [relayMinPort, relayMaxPort],
  });
}

turnServer.on("listening", (info) => {
  const endpoint = {
    transport: info.transport,
    address: info.address,
    port: info.port,
  };
  listeningEndpoints.set(`${info.transport}:${info.port}`, endpoint);
  maybeReady();
});

turnServer.on("error", (error) => {
  emit("turn-test-error", { message: error.message });
  process.exitCode = 1;
  void shutdown("server-error");
});

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  ready = false;
  emit("turn-test-stopping", { signal });

  const deadline = (operation) => Promise.race([
    operation,
    new Promise((resolve) => setTimeout(resolve, drainMs + 1_000)),
  ]);
  await Promise.allSettled([
    deadline(new Promise((resolve) => healthServer.close(resolve))),
    deadline(new Promise((resolve) => turnServer.drain(drainMs, resolve))),
  ]);
  emit("turn-test-stopped");
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void shutdown(signal).then(() => process.exit(0));
  });
}

healthServer.on("error", (error) => {
  emit("turn-test-error", { message: `Health listener failed: ${error.message}` });
  process.exitCode = 1;
  void shutdown("health-error");
});

healthServer.listen(healthPort, "127.0.0.1", () => {
  turnServer.listen(endpoints);
});
