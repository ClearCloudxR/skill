// Simulate what DSH's dsh-mcp-client will do at startup for our profile entry:
// spawn `cmd /c F:\node\npx.cmd -y chrome-devtools-mcp@latest ...` over stdio,
// do the MCP handshake, and confirm tools register with the exact names DSH would expose.
const { spawn } = require("child_process");
const fs = require("fs");

const p = "C:\\Users\\Administrator\\.dsh\\profiles\\desktop\\cordis.patch.yml";
const text = fs.readFileSync(p, "utf8");

// crude but sufficient extraction of our entry's fields
const block = text.split("- id: mcp-chrome-devtools")[1];
if (!block) { console.error("MCP entry not found in profile"); process.exit(1); }
const serverName = (block.match(/serverName:\s*(\S+)/) || [])[1];
const command = (block.match(/\n\s*command:\s*(\S+)/) || [])[1];
const argsLine = (block.match(/args:\s*\n((?:\s*-\s*.*\n)+)/) || [])[1] || "";
// Strip surrounding YAML quotes the way a real YAML parser would, so a quoted
// Windows path does not keep its delimiters as part of the argument value.
const unquote = (s) => {
  if (s.length >= 2 && s[0] === s[s.length - 1] && (s[0] === "'" || s[0] === '"')) {
    const inner = s.slice(1, -1);
    return s[0] === "'" ? inner.replace(/''/g, "'") : inner;
  }
  return s;
};
const args = argsLine
  .split("\n")
  .map((l) => unquote(l.replace(/^\s*-\s*/, "").trim()))
  .filter(Boolean);
const envCache = (block.match(/npm_config_cache:\s*(\S+)/) || [])[1];

console.log("serverName:", serverName);
console.log("command:", command);
console.log("args:", JSON.stringify(args));
console.log("npm_config_cache:", envCache);
console.log("---spawning---");

const child = spawn(command, args, {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, npm_config_cache: envCache },
});

let buf = "";
const pending = new Map();
let id = 1;

child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  }
});
child.stderr.on("data", (d) => {
  const s = d.toString();
  if (/error|fail|cannot/i.test(s)) process.stderr.write("[srv-err] " + s);
});
child.on("error", (e) => { console.error("SPAWN ERROR:", e.message); process.exit(1); });

const rpc = (method, params) => new Promise((res, rej) => {
  const i = id++;
  pending.set(i, res);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n");
  setTimeout(() => { if (pending.delete(i)) rej(new Error("timeout " + method)); }, 180000);
});

(async () => {
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "dsh-sim", version: "1" },
  });
  console.log("server:", init.result?.serverInfo?.name, init.result?.serverInfo?.version);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");

  const t = await rpc("tools/list", {});
  const names = (t.result?.tools || []).map((x) => x.name);
  console.log("tools:", names.length);
  console.log("DSH would expose e.g.: mcp__" + serverName + "__" + (names[0] || "?"));

  // prove it can actually drive the browser
  const call = (n, a) => rpc("tools/call", { name: n, arguments: a });
  const txt = (r) => (r.result?.content || []).map((c) => c.text || "").join("\n") || JSON.stringify(r.error);
  const newPage = names.find((n) => /new_page/.test(n));
  const nav = names.find((n) => /navigate_page/.test(n));
  const shot = names.find((n) => /take_screenshot/.test(n));

  const np = await call(newPage, { url: "https://example.com" });
  console.log("new_page:", txt(np).replace(/\n/g, " | ").slice(0, 160));
  const m = txt(np).match(/\b(\d+):/);
  const pageId = m ? Number(m[1]) : undefined;
  const nr = await call(nav, pageId === undefined ? { url: "https://example.com" } : { pageId, url: "https://example.com" });
  console.log("navigate:", txt(nr).replace(/\n/g, " | ").slice(0, 160));
  if (shot) {
    const s = await call(shot, pageId === undefined ? {} : { pageId });
    console.log("screenshot ok:", !/error|invalid/i.test(txt(s)));
  }
  const ok = names.length > 0 && !/error|invalid/i.test(txt(nr));
  console.log("RESULT:", ok ? "PASS" : "FAIL");
  child.kill();
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error("ERR", e.message); child.kill(); process.exit(1); });
