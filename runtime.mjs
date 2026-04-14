import { createServer } from "http";
import { getConfigPath, loadConfig } from "./config.mjs";

const ANTHROPIC_API = "https://api.anthropic.com";

export function getRuntimeConfig() {
  let config;

  try {
    config = loadConfig();
  } catch {
    console.error(`No config found at ${getConfigPath()}`);
    console.error("Run: claude-sub-proxy configure init");
    process.exit(1);
  }

  const port = process.env.CSP_PORT || config.port || 13456;
  const routes = (config.routes || []).map((route) => ({
    match: new RegExp(route.match, "i"),
    api_base: route.api_base,
    api_key: route.api_key.startsWith("$") ? process.env[route.api_key.slice(1)] || "" : route.api_key,
    model: route.model,
    name: route.name || route.model,
    auth_scheme: normalizeAuthScheme(route.auth_scheme),
  }));

  return { config, port, routes };
}

export function normalizeAuthScheme(value) {
  if (!value) return "x-api-key";

  const normalized = String(value).trim().toLowerCase();
  if (normalized === "x-api-key" || normalized === "bearer") {
    return normalized;
  }

  throw new Error(`Unsupported auth_scheme "${value}". Use "x-api-key" or "bearer".`);
}

export function formatListenError(error, port) {
  if (error?.code === "EADDRINUSE") {
    return `Port ${port} is already in use on 127.0.0.1. Stop the existing process or set CSP_PORT to another port.`;
  }

  return error?.message || "Failed to start proxy server.";
}

function findRoute(routes, model) {
  return routes.find((route) => route.match.test(model));
}

export function startProxy() {
  const { port, routes } = getRuntimeConfig();

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks);

    let body;
    try {
      body = JSON.parse(rawBody);
    } catch {
      body = {};
    }

    const model = body.model || "";
    const route = findRoute(routes, model);
    const targetBase = route ? route.api_base : ANTHROPIC_API;
    const targetUrl = `${targetBase}${req.url}`;

    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (["host", "connection", "accept-encoding", "content-length", "transfer-encoding"].includes(key)) continue;
      headers[key] = value;
    }

    headers.host = new URL(targetBase).host;
    headers["accept-encoding"] = "identity";

    if (route) {
      delete headers.authorization;
      delete headers["x-api-key"];

      if (route.auth_scheme === "bearer") {
        headers.authorization = `Bearer ${route.api_key}`;
      } else {
        headers["x-api-key"] = route.api_key;
      }

      body.model = route.model;
    }

    const finalBody = route ? JSON.stringify(body) : rawBody;
    const tag = route ? `-> ${route.name} (${route.model})` : `-> Anthropic (${model})`;
    process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${tag}\n`);

    try {
      const response = await fetch(targetUrl, {
        method: req.method,
        headers,
        body: req.method !== "GET" ? finalBody : undefined,
        redirect: "follow",
      });

      const responseHeaders = {};
      for (const [key, value] of response.headers) {
        if (["content-encoding", "transfer-encoding", "content-length"].includes(key)) continue;
        responseHeaders[key] = value;
      }

      res.writeHead(response.status, responseHeaders);
      if (response.body) {
        for await (const chunk of response.body) res.write(chunk);
      }
      res.end();
    } catch (error) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: error.message, type: "proxy_error" } }));
    }
  });

  server.on("error", (error) => {
    console.error(formatListenError(error, port));
    process.exitCode = 1;
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`claude-sub-proxy on 127.0.0.1:${port}`);
    console.log(`Routes: ${routes.map((route) => `${route.match} -> ${route.name}`).join(", ") || "none"}`);
    console.log("Default: Anthropic (passthrough)");
  });

  return server;
}
