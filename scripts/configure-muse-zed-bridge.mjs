#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const settingsPath = process.argv[2];
const bridgePath = process.argv[3];
const stateDir = process.argv[4];
const nodePath = process.execPath;

if (!settingsPath || !bridgePath || !stateDir) {
  throw new Error("Uso: node configure-muse-zed-bridge.mjs <settings.json> <bridge.mjs> <state-dir>");
}

function removeJsonComments(source) {
  let output = "";
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (!quoted && char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      output += "\n";
      continue;
    }
    output += char;
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') {
      quoted = true;
    }
  }
  return output;
}

const original = fs.readFileSync(settingsPath, "utf8");
const settings = JSON.parse(removeJsonComments(original));
settings.agent_servers ||= {};
const entryName = settings.agent_servers["Muse Code"] ? "Muse Code" : Object.keys(settings.agent_servers).find((name) => {
  const command = settings.agent_servers[name]?.command || "";
  return /muse-acp(?:\.exe)?$/i.test(command.replaceAll("\\", "/"));
});
if (!entryName) throw new Error("Nenhuma entrada Muse/muse-acp foi encontrada em agent_servers.");

const entry = settings.agent_servers[entryName];
let museAcpCommand = entry.command;
if (path.resolve(entry.command) === path.resolve(nodePath) && Array.isArray(entry.args)) {
  const agentIndex = entry.args.indexOf("--agent");
  if (agentIndex >= 0 && entry.args[agentIndex + 1]) museAcpCommand = entry.args[agentIndex + 1];
}
if (!/muse-acp(?:\.exe)?$/i.test(museAcpCommand.replaceAll("\\", "/"))) {
  throw new Error(`Comando ACP inesperado; instalacao recusada: ${museAcpCommand}`);
}

entry.command = nodePath;
entry.args = [path.resolve(bridgePath), "proxy", "--state-dir", path.resolve(stateDir), "--agent", museAcpCommand];
entry.env ||= {};
entry.env.MUSE_SERVE_ARGS = "--trust-workspace";

const stamp = new Date().toISOString().replaceAll(":", "-");
const backupPath = `${settingsPath}.codex-muse-backup-${stamp}`;
fs.copyFileSync(settingsPath, backupPath, fs.constants.COPYFILE_EXCL);
const temporary = `${settingsPath}.${process.pid}.tmp`;
fs.writeFileSync(temporary, `// Zed settings - Muse Code supervised by the local Codex MCP bridge\n${JSON.stringify(settings, null, 2)}\n`, "utf8");
fs.renameSync(temporary, settingsPath);

const verified = JSON.parse(removeJsonComments(fs.readFileSync(settingsPath, "utf8")));
if (verified.agent_servers?.[entryName]?.args?.[1] !== "proxy") {
  fs.copyFileSync(backupPath, settingsPath);
  throw new Error("A verificacao falhou; a configuracao original foi restaurada.");
}
process.stdout.write(`${JSON.stringify({ ok: true, entryName, settingsPath, backupPath }, null, 2)}\n`);
