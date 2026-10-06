// Minimal MCP stdio client: launches the exact command from mcp.json,
// does the JSON-RPC handshake, lists tools, and calls one navigation tool.
const { spawn } = require("child_process");

const cfg = require("C:/Users/Administrator/.dsh/skills/browser-automation/mcp.json");
const srv = cfg.mcpServers["chrome-devtools"];

const child = spawn(srv.command, srv.args, { stdio: ["pipe", "pipe", "pipe"], shell: false });

let buf = "";
const pending = new Map();
let nextId = 1;

child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});
child.stderr.on("data", (d) => process.stderr.write("[srv] " + d));

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => pending.has(id) && (pending.delete(id), reject(new Error("timeout " + method))), 120000);
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

(async () => {
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "1" },
  });
  console.log("server:", init.result?.serverInfo?.name, init.result?.serverInfo?.version);
  notify("notifications/initialized", {});

  const tools = await rpc("tools/list", {});
  const names = (tools.result?.tools || []).map((t) => t.name);
  console.log("tool count:", names.length);

  // Drive the browser for real: open a page and read it back.
  const call = (name, args) => rpc("tools/call", { name, arguments: args });
  const asText = (r) =>
    (r.result?.content || []).map((c) => c.text || "").join("\n") ||
    JSON.stringify(r.error || r.result);

  const list = names.find((n) => /list_pages/.test(n));
  const newPage = names.find((n) => /new_page/.test(n));
  const nav = names.find((n) => /navigate_page/.test(n));

  let pageId;
  if (newPage) {
    const np = await call(newPage, { url: "https://example.com" });
    console.log("new_page:", asText(np).slice(0, 200));
    const m = asText(np).match(/\b(\d+)\b/);
    if (m) pageId = Number(m[1]);
  }
  if (pageId === undefined && list) {
    const lp = await call(list, {});
    console.log("list_pages:", asText(lp).slice(0, 200));
    const m = asText(lp).match(/\b(\d+)\b/);
    if (m) pageId = Number(m[1]);
  }

  console.log("pageId:", pageId);
  const navRes = await call(nav, pageId === undefined ? { url: "https://example.com" } : { pageId, url: "https://example.com" });
  console.log("navigate_page:", asText(navRes).slice(0, 300));

  const shot = names.find((n) => /take_screenshot/.test(n));
  if (shot) {
    const s = await call(shot, pageId === undefined ? {} : { pageId });
    const t = asText(s);
    console.log("screenshot bytes:", t.length);
  }

  const failed = /error|invalid/i.test(asText(navRes));
  console.log("RESULT:", failed ? "FAIL" : "PASS");
  child.kill();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("ERR", e.message); child.kill(); process.exit(1); });
