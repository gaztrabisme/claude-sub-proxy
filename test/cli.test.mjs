import test from "node:test";
import assert from "node:assert/strict";

import { addRoute, maskSecret, removeRouteByName } from "../config.mjs";
import { buildServiceDefinition, getLaunchctlDomain } from "../service.mjs";
import { normalizeAuthScheme } from "../runtime.mjs";

test("maskSecret preserves env references", () => {
  assert.equal(maskSecret("$MINIMAX_API_KEY"), "$MINIMAX_API_KEY");
});

test("maskSecret redacts raw keys", () => {
  assert.equal(maskSecret("abcdef123456"), "ab********56");
});

test("addRoute rejects duplicate names", () => {
  const config = {
    port: 13456,
    routes: [{ name: "MiniMax", match: "haiku", api_base: "https://example.com", api_key: "secret", model: "x" }],
  };

  assert.throws(() => addRoute(config, {
    name: "MiniMax",
    match: "sonnet",
    api_base: "https://example.org",
    api_key: "another",
    model: "y",
  }));
});

test("removeRouteByName removes exact route", () => {
  const config = {
    port: 13456,
    routes: [
      { name: "MiniMax", match: "haiku", api_base: "https://example.com", api_key: "secret", model: "x" },
      { name: "DeepSeek", match: "sonnet", api_base: "https://example.org", api_key: "other", model: "y" },
    ],
  };

  const nextConfig = removeRouteByName(config, "MiniMax");
  assert.equal(nextConfig.routes.length, 1);
  assert.equal(nextConfig.routes[0].name, "DeepSeek");
});

test("removeRouteByName fails for missing route", () => {
  assert.throws(() => removeRouteByName({ routes: [] }, "Missing"));
});

test("removeRouteByName fails for duplicated names", () => {
  assert.throws(
    () => removeRouteByName({
      routes: [
        { name: "MiniMax", match: "haiku", api_base: "https://example.com", api_key: "secret", model: "x" },
        { name: "MiniMax", match: "sonnet", api_base: "https://example.org", api_key: "other", model: "y" },
      ],
    }, "MiniMax"),
  );
});

test("buildServiceDefinition renders macOS launch agent", () => {
  const plist = buildServiceDefinition({
    platform: "macos",
    nodePath: "/usr/local/bin/node",
    scriptPath: "/app/cli.mjs",
    configPath: "/Users/me/.claude-sub-proxy/config.json",
    logDir: "/Users/me/.claude-sub-proxy",
  });

  assert.match(plist, /<string>\/app\/cli.mjs<\/string>/);
  assert.match(plist, /<string>start<\/string>/);
  assert.match(plist, /<key>CSP_CONFIG<\/key>/);
});

test("buildServiceDefinition renders systemd user unit", () => {
  const unit = buildServiceDefinition({
    platform: "linux",
    nodePath: "/usr/bin/node",
    scriptPath: "/app/cli.mjs",
    configPath: "/home/me/.claude-sub-proxy/config.json",
    logDir: "/home/me/.claude-sub-proxy",
  });

  assert.match(unit, /ExecStart=\/usr\/bin\/node \/app\/cli\.mjs start/);
  assert.match(unit, /Environment=CSP_CONFIG=\/home\/me\/\.claude-sub-proxy\/config\.json/);
});

test("normalizeAuthScheme defaults to x-api-key", () => {
  assert.equal(normalizeAuthScheme(undefined), "x-api-key");
});

test("normalizeAuthScheme accepts bearer", () => {
  assert.equal(normalizeAuthScheme("bearer"), "bearer");
});

test("normalizeAuthScheme rejects unsupported values", () => {
  assert.throws(() => normalizeAuthScheme("basic"));
});

test("getLaunchctlDomain prefers sudo uid when present", () => {
  const previous = process.env.SUDO_UID;
  process.env.SUDO_UID = "501";

  try {
    assert.equal(getLaunchctlDomain(), "gui/501");
  } finally {
    if (previous === undefined) {
      delete process.env.SUDO_UID;
    } else {
      process.env.SUDO_UID = previous;
    }
  }
});
