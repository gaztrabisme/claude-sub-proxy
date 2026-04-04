#!/usr/bin/env node
import { createServer } from "http";
import { readFileSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";

// --- Config ---
const CONFIG_PATH = process.env.CSP_CONFIG || resolve(homedir(), ".claude-sub-proxy", "config.json");
let config;
try {
  config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
} catch {
  console.error(`No config found at ${CONFIG_PATH}`);
  console.error(`Run: mkdir -p ~/.claude-sub-proxy && cp config.example.json ~/.claude-sub-proxy/config.json`);
  process.exit(1);
}

const PORT = process.env.CSP_PORT || config.port || 13456;
const ANTHROPIC_API = "https://api.anthropic.com";

// Build routing table: regex → { api_base, api_key, model_name }
const routes = (config.routes || []).map((r) => ({
  match: new RegExp(r.match, "i"),
  api_base: r.api_base,
  api_key: r.api_key.startsWith("$") ? process.env[r.api_key.slice(1)] || "" : r.api_key,
  model: r.model,
  name: r.name || r.model,
}));

function findRoute(model) {
  return routes.find((r) => r.match.test(model));
}

createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks);

  let body;
  try { body = JSON.parse(rawBody); } catch { body = {}; }

  const model = body.model || "";
  const route = findRoute(model);

  const targetBase = route ? route.api_base : ANTHROPIC_API;
  const targetUrl = `${targetBase}${req.url}`;

  // Build clean headers — strip hop-by-hop and compression
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (["host", "connection", "accept-encoding", "content-length", "transfer-encoding"].includes(k)) continue;
    headers[k] = v;
  }
  headers["host"] = new URL(targetBase).host;
  headers["accept-encoding"] = "identity";

  if (route) {
    headers["x-api-key"] = route.api_key;
    delete headers["authorization"];
    body.model = route.model;
  }

  const finalBody = route ? JSON.stringify(body) : rawBody;

  const tag = route ? `→ ${route.name} (${route.model})` : `→ Anthropic (${model})`;
  process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${tag}\n`);

  try {
    const resp = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: req.method !== "GET" ? finalBody : undefined,
      redirect: "follow",
    });

    const respHeaders = {};
    for (const [k, v] of resp.headers) {
      if (["content-encoding", "transfer-encoding", "content-length"].includes(k)) continue;
      respHeaders[k] = v;
    }

    res.writeHead(resp.status, respHeaders);
    if (resp.body) {
      for await (const chunk of resp.body) res.write(chunk);
    }
    res.end();
  } catch (err) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: err.message, type: "proxy_error" } }));
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`claude-sub-proxy on 127.0.0.1:${PORT}`);
  console.log(`Routes: ${routes.map((r) => `${r.match} → ${r.name}`).join(", ") || "none"}`);
  console.log(`Default: Anthropic (passthrough)`);
});
