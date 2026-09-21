import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";
import test from "node:test";

const bridge = path.resolve("scripts/muse-codex-bridge.mjs");

function jsonQueue(stream) {
  const values = [];
  const waiters = [];
  readline.createInterface({ input: stream }).on("line", (line) => {
    const value = JSON.parse(line);
    const waiter = waiters.shift();
    if (waiter) waiter(value);
    else values.push(value);
  });
  return () => values.length ? Promise.resolve(values.shift()) : new Promise((resolve) => waiters.push(resolve));
}

function closeChild(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once("exit", resolve);
    child.stdin.end();
  });
}

test("MCP delegates to the same ACP session and returns real updates", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "muse-codex-bridge-"));
  const fake = path.join(root, "fake-agent.mjs");
  fs.writeFileSync(fake, `
    import readline from "node:readline";
    const input = readline.createInterface({ input: process.stdin });
    const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
    input.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.method === "initialize") send({jsonrpc:"2.0",id:message.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true}}});
      if (message.method === "session/new") send({jsonrpc:"2.0",id:message.id,result:{sessionId:"session-test"}});
      if (message.method === "session/prompt") {
        send({jsonrpc:"2.0",method:"session/update",params:{sessionId:message.params.sessionId,update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:"executado"}}}});
        send({jsonrpc:"2.0",id:message.id,result:{stopReason:"end_turn"}});
      }
    });
  `);
  const actualProxy = spawn(process.execPath, [
    bridge, "proxy", "--state-dir", root, "--agent", process.execPath,
    "--agent-args", JSON.stringify([fake]),
  ], {
    cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  const nextProxyJson = jsonQueue(actualProxy.stdout);
  actualProxy.stdin.write(`${JSON.stringify({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:1}})}\n`);
  await nextProxyJson();
  actualProxy.stdin.write(`${JSON.stringify({jsonrpc:"2.0",id:2,method:"session/new",params:{cwd:root,mcpServers:[]}})}\n`);
  const created = await nextProxyJson();
  assert.equal(created.result.sessionId, "session-test");

  const mcp = spawn(process.execPath, [bridge, "mcp", "--state-dir", root], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(async () => {
    await closeChild(mcp);
    await closeChild(actualProxy);
  });
  const nextMcpJson = jsonQueue(mcp.stdout);
  mcp.stdin.write(`${JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"muse_delegate",arguments:{workspace:root,prompt:"Crie o arquivo de teste"}}})}\n`);
  const delegated = await nextMcpJson();
  assert.equal(delegated.result.structuredContent.ok, true);
  assert.equal(delegated.result.structuredContent.sessionId, "session-test");
  assert.equal(delegated.result.structuredContent.updates[0].text, "executado");
  const visible = await nextProxyJson();
  assert.equal(visible.method, "session/update");
  assert.equal(visible.params.update.content.text, "executado");
});
