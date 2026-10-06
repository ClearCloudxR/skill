// Validate cordis.patch.yml parses and contains a well-formed MCP entry.
// Uses js-yaml from the DSH runtime if available, else a structural fallback.
const fs = require("fs");
const p = "C:\\Users\\Administrator\\.dsh\\profiles\\desktop\\cordis.patch.yml";
const text = fs.readFileSync(p, "utf8");

let yaml = null;
for (const c of [
  "G:/dsh/resources/app.asar.unpacked/node_modules/js-yaml",
  "G:/dsh/resources/app.asar/node_modules/js-yaml",
]) {
  try { yaml = require(c); break; } catch {}
}

if (!yaml) {
  console.log("js-yaml unavailable; structural check only");
  const ok = /id: mcp-chrome-devtools/.test(text) &&
             /name: "@deepseek-ai\/dsh-mcp-client"/.test(text) &&
             /transport: stdio/.test(text);
  console.log("structure:", ok ? "OK" : "MISSING MCP ENTRY");
  process.exit(ok ? 0 : 1);
}

const d = yaml.load(text);
console.log("YAML OK, entries:", d.length);
const mcp = d.filter((e) => String(e.id).startsWith("mcp-"));
for (const e of mcp) {
  console.log("id:", e.id);
  console.log("name:", e.name);
  console.log("serverName:", e.config.serverName);
  console.log("transport:", e.config.transport);
  console.log("command:", e.config.command);
  console.log("args:", JSON.stringify(e.config.args));
  console.log("env:", JSON.stringify(e.config.env));
}
const bad = mcp.filter((e) => e.config.transport !== "stdio" || !e.config.serverName || !/^[A-Za-z0-9_-]{1,32}$/.test(e.config.serverName));
console.log("RESULT:", mcp.length && !bad.length ? "PASS" : "FAIL");
process.exit(mcp.length && !bad.length ? 0 : 1);
