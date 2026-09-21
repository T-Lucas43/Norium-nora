#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";
import process from "node:process";

const args = process.argv.slice(2);
const mode = args.shift();

function option(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const stateDir = path.resolve(option("--state-dir", path.join(process.cwd(), "tmp", "muse-codex-bridge")));
const stateFile = path.join(stateDir, "active.json");

function emit(stream, message) {
  stream.write(`${JSON.stringify(message)}\n`);
}

function normalizeWorkspace(value) {
  return path.resolve(value || process.cwd()).replaceAll("\\", "/").toLowerCase();
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, file);
}

function contentText(params) {
  const prompt = params?.prompt;
  if (typeof prompt === "string") return prompt;
  if (!Array.isArray(prompt)) return "";
  return prompt.filter((item) => item?.type === "text").map((item) => item.text || "").join("\n");
}

async function runProxy() {
  const agentCommand = option("--agent", process.env.MUSE_ACP_COMMAND);
  if (!agentCommand) throw new Error("Defina --agent ou MUSE_ACP_COMMAND com o caminho do muse-acp.");
  const agentArgs = JSON.parse(option("--agent-args", "[]"));
  if (!Array.isArray(agentArgs)) throw new Error("--agent-args deve ser um array JSON.");
  const token = crypto.randomBytes(32).toString("hex");
  const sessions = new Map();
  const requestMethods = new Map();
  const pendingDelegations = new Map();
  const busySessions = new Set();
  let protocolVersion = 1;
  let closing = false;

  const agent = spawn(agentCommand, agentArgs, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["pipe", "pipe", "inherit"],
    windowsHide: true,
  });

  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const lineEnd = buffer.indexOf("\n");
        const line = buffer.slice(0, lineEnd).trim();
        buffer = buffer.slice(lineEnd + 1);
        if (!line) continue;
        let command;
        try {
          command = JSON.parse(line);
        } catch {
          emit(socket, { ok: false, error: "Comando JSON invalido." });
          continue;
        }
        if (command.token !== token) {
          emit(socket, { ok: false, error: "Token local invalido." });
          socket.end();
          continue;
        }
        if (command.op === "status") {
          emit(socket, {
            ok: true,
            pid: process.pid,
            protocolVersion,
            sessions: [...sessions.values()].map((session) => ({
              sessionId: session.sessionId,
              cwd: session.cwd,
              busy: busySessions.has(session.sessionId),
              lastUsedAt: session.lastUsedAt,
            })),
          });
          socket.end();
          continue;
        }
        if (command.op === "cancel") {
          const session = chooseSession(command, sessions);
          if (!session) {
            emit(socket, { ok: false, error: "Nenhuma sessao Muse correspondente esta aberta no Zed." });
            socket.end();
            continue;
          }
          emit(agent.stdin, {
            jsonrpc: "2.0",
            method: "session/cancel",
            params: { sessionId: session.sessionId },
          });
          emit(socket, { ok: true, sessionId: session.sessionId });
          socket.end();
          continue;
        }
        if (command.op !== "delegate") {
          emit(socket, { ok: false, error: `Operacao desconhecida: ${command.op}` });
          socket.end();
          continue;
        }
        const session = chooseSession(command, sessions);
        if (!session) {
          emit(socket, {
            ok: false,
            error: "Abra ou retome uma conversa Muse Code no Zed para este workspace antes de delegar.",
          });
          socket.end();
          continue;
        }
        if (busySessions.has(session.sessionId)) {
          emit(socket, { ok: false, error: "A sessao Muse selecionada ja esta executando uma tarefa." });
          socket.end();
          continue;
        }
        const prompt = String(command.prompt || "").trim();
        if (!prompt) {
          emit(socket, { ok: false, error: "A tarefa nao pode ser vazia." });
          socket.end();
          continue;
        }
        const requestId = `codex-muse-${crypto.randomUUID()}`;
        const pending = {
          requestId,
          sessionId: session.sessionId,
          socket,
          startedAt: Date.now(),
          updates: [],
          accepted: false,
        };
        pendingDelegations.set(requestId, pending);
        busySessions.add(session.sessionId);
        session.lastUsedAt = new Date().toISOString();
        writeState(server, token, sessions, protocolVersion);
        emit(agent.stdin, {
          jsonrpc: "2.0",
          id: requestId,
          method: "session/prompt",
          params: {
            sessionId: session.sessionId,
            prompt: [{ type: "text", text: prompt }],
          },
        });
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  writeState(server, token, sessions, protocolVersion);

  const clientLines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  clientLines.on("line", (line) => {
    if (!line.trim()) return;
    try {
      const message = JSON.parse(line);
      if (message.method === "initialize") protocolVersion = Number(message.params?.protocolVersion || 1);
      if (message.id !== undefined && message.method) {
        requestMethods.set(String(message.id), { method: message.method, params: message.params || {} });
        if (message.method === "session/prompt") busySessions.add(message.params?.sessionId);
      }
    } catch {
      // The wrapped ACP server remains authoritative for protocol validation.
    }
    agent.stdin.write(`${line}\n`);
  });

  const agentLines = readline.createInterface({ input: agent.stdout, crlfDelay: Infinity });
  agentLines.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      process.stdout.write(`${line}\n`);
      return;
    }
    const id = message.id === undefined ? undefined : String(message.id);
    if (id && pendingDelegations.has(id)) {
      const pending = pendingDelegations.get(id);
      if (message.error) {
        finishDelegation(pending, { ok: false, error: message.error.message || "Muse recusou a tarefa." });
      } else if (protocolVersion >= 2) {
        pending.accepted = true;
      } else {
        finishDelegation(pending, {
          ok: true,
          sessionId: pending.sessionId,
          stopReason: message.result?.stopReason || "completed",
          durationMs: Date.now() - pending.startedAt,
          updates: pending.updates.slice(-80),
        });
      }
      return;
    }
    if (id && requestMethods.has(id)) {
      const request = requestMethods.get(id);
      requestMethods.delete(id);
      if (!message.error && ["session/new", "session/load", "session/resume"].includes(request.method)) {
        const sessionId = message.result?.sessionId || request.params?.sessionId;
        if (sessionId) {
          sessions.set(sessionId, {
            sessionId,
            cwd: request.params?.cwd || message.result?._meta?.cwd || process.cwd(),
            lastUsedAt: new Date().toISOString(),
          });
          writeState(server, token, sessions, protocolVersion);
        }
      }
      if (request.method === "session/prompt") busySessions.delete(request.params?.sessionId);
    }
    if (message.method === "session/update") {
      const sessionId = message.params?.sessionId;
      const update = message.params?.update || {};
      for (const pending of pendingDelegations.values()) {
        if (pending.sessionId === sessionId) pending.updates.push(compactUpdate(update));
      }
      if (protocolVersion >= 2 && update.sessionUpdate === "state_update" && update.state === "idle") {
        const pending = [...pendingDelegations.values()].find((item) => item.sessionId === sessionId && item.accepted);
        if (pending) {
          finishDelegation(pending, {
            ok: true,
            sessionId,
            stopReason: update.stopReason || "completed",
            durationMs: Date.now() - pending.startedAt,
            updates: pending.updates.slice(-80),
          });
        }
      }
    }
    process.stdout.write(`${line}\n`);
  });

  function finishDelegation(pending, result) {
    pendingDelegations.delete(pending.requestId);
    busySessions.delete(pending.sessionId);
    emit(pending.socket, result);
    pending.socket.end();
    writeState(server, token, sessions, protocolVersion);
  }

  function shutdown(code = 0) {
    if (closing) return;
    closing = true;
    for (const pending of pendingDelegations.values()) {
      finishDelegation(pending, { ok: false, error: "A ponte ACP foi encerrada durante a tarefa." });
    }
    server.close();
    agent.kill();
    try {
      const current = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      if (current.pid === process.pid) fs.rmSync(stateFile, { force: true });
    } catch {}
    process.exit(code);
  }

  agent.on("exit", (code) => shutdown(code ?? 1));
  process.stdin.on("end", () => shutdown(0));
  process.on("SIGINT", () => shutdown(130));
  process.on("SIGTERM", () => shutdown(143));
}

function compactUpdate(update) {
  const type = update.sessionUpdate || "unknown";
  if (["agent_message_chunk", "agent_message", "agent_thought_chunk"].includes(type)) {
    const content = update.content;
    return { type, text: typeof content === "string" ? content : content?.text || "" };
  }
  if (["tool_call", "tool_call_update"].includes(type)) {
    return { type, title: update.title, status: update.status, toolCallId: update.toolCallId };
  }
  if (type === "state_update") return { type, state: update.state, stopReason: update.stopReason };
  return { type };
}

function chooseSession(command, sessions) {
  if (command.sessionId && sessions.has(command.sessionId)) return sessions.get(command.sessionId);
  if (command.workspace) {
    const wanted = normalizeWorkspace(command.workspace);
    const matches = [...sessions.values()].filter((session) => normalizeWorkspace(session.cwd) === wanted);
    if (matches.length === 1) return matches[0];
  }
  return sessions.size === 1 ? [...sessions.values()][0] : null;
}

function writeState(server, token, sessions, protocolVersion) {
  const address = server.address();
  atomicWrite(stateFile, {
    pid: process.pid,
    host: "127.0.0.1",
    port: address?.port,
    token,
    protocolVersion,
    updatedAt: new Date().toISOString(),
    sessions: [...sessions.values()],
  });
}

function callProxy(command, timeoutMs) {
  return new Promise((resolve, reject) => {
    let state;
    try {
      state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    } catch {
      reject(new Error("A ponte Muse nao esta ativa. Abra uma conversa Muse Code no Zed e tente novamente."));
      return;
    }
    const socket = net.createConnection({ host: state.host, port: state.port });
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs);
    let buffer = "";
    socket.on("connect", () => emit(socket, { ...command, token: state.token }));
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      try {
        resolve(JSON.parse(buffer.slice(0, buffer.indexOf("\n"))));
      } catch (error) {
        reject(error);
      }
      socket.end();
    });
    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error(`Muse nao concluiu dentro de ${timeoutMs} ms.`));
    });
    socket.on("error", reject);
  });
}

async function runMcp() {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      continue;
    }
    if (request.id === undefined) continue;
    try {
      let result;
      if (request.method === "initialize") {
        result = {
          protocolVersion: request.params?.protocolVersion || "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "norium-muse-bridge", version: "1.0.0" },
          instructions: "Use muse_status antes de delegar. Envie um plano completo com muse_delegate e aguarde o termino. Depois revise o Git diff e execute testes independentemente. Nao edite os mesmos arquivos enquanto o Muse estiver ocupado. Limite padrao: duas tentativas; nunca faca push, deploy ou operacao destrutiva sem autorizacao explicita.",
          instructions: "Use muse_status antes de delegar. Envie um plano completo com muse_delegate e aguarde o termino. Depois revise o Git diff e execute testes independentemente. Nao edite os mesmos arquivos enquanto o Muse estiver ocupado. Limite padrao: duas tentativas; nunca faca push, deploy ou operacao destrutiva sem autorizacao explicita.",
        };
      } else if (request.method === "ping") {
        result = {};
      } else if (request.method === "tools/list") {
        result = { tools: toolDefinitions() };
      } else if (request.method === "tools/call") {
        result = await callTool(request.params?.name, request.params?.arguments || {});
      } else {
        throw Object.assign(new Error(`Metodo MCP desconhecido: ${request.method}`), { code: -32601 });
      }
      emit(process.stdout, { jsonrpc: "2.0", id: request.id, result });
    } catch (error) {
      emit(process.stdout, {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: error.code || -32000, message: error.message },
      });
    }
  }
}

function toolDefinitions() {
  return [
    {
      name: "muse_status",
      description: "Lista as sessoes Muse reais abertas pelo Zed e informa se estao ocupadas.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    {
      name: "muse_delegate",
      description: "Envia um plano de implementacao para a sessao Muse ACP aberta no Zed e aguarda a conclusao real.",
      inputSchema: {
        type: "object",
        required: ["prompt", "workspace"],
        properties: {
          prompt: { type: "string", minLength: 1 },
          workspace: { type: "string", description: "Caminho absoluto do repositorio autorizado." },
          sessionId: { type: "string" },
          attempt: { type: "integer", minimum: 1, default: 1 },
          maxAttempts: { type: "integer", minimum: 1, maximum: 10, default: 2 },
          timeoutSeconds: { type: "integer", minimum: 10, maximum: 3600, default: 1800 },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    {
      name: "muse_cancel",
      description: "Cancela a tarefa ativa na sessao Muse selecionada.",
      inputSchema: {
        type: "object",
        properties: { workspace: { type: "string" }, sessionId: { type: "string" } },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
  ];
}

async function callTool(name, parameters) {
  let response;
  if (name === "muse_status") {
    response = await callProxy({ op: "status" }, 5000);
  } else if (name === "muse_cancel") {
    response = await callProxy({ op: "cancel", ...parameters }, 5000);
  } else if (name === "muse_delegate") {
    const attempt = Number(parameters.attempt || 1);
    const maxAttempts = Number(parameters.maxAttempts || 2);
    if (attempt > maxAttempts) throw new Error(`Limite de correcoes atingido (${maxAttempts}).`);
    response = await callProxy(
      { op: "delegate", ...parameters },
      Number(parameters.timeoutSeconds || 1800) * 1000,
    );
  } else {
    throw Object.assign(new Error(`Ferramenta MCP desconhecida: ${name}`), { code: -32602 });
  }
  return {
    content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
    isError: !response.ok,
    structuredContent: response,
  };
}

if (mode === "proxy") {
  await runProxy();
} else if (mode === "mcp") {
  await runMcp();
} else {
  process.stderr.write("Uso: node scripts/muse-codex-bridge.mjs <proxy|mcp> [opcoes]\n");
  process.exit(2);
}
