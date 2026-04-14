import test from "node:test";
import assert from "node:assert/strict";

import { addRoute, maskSecret, removeRouteByName } from "../config.mjs";
import { createLogger, createMacosSystemLogger } from "../logger.mjs";
import * as service from "../service.mjs";
import { formatListenError, normalizeAuthScheme } from "../runtime.mjs";

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
  const plist = service.buildServiceDefinition({
    platform: "macos",
    nodePath: "/usr/local/bin/node",
    scriptPath: "/app/cli.mjs",
    configPath: "/Users/me/.claude-sub-proxy/config.json",
  });

  assert.match(plist, /<string>\/app\/cli.mjs<\/string>/);
  assert.match(plist, /<string>start<\/string>/);
  assert.match(plist, /<key>CSP_CONFIG<\/key>/);
  assert.match(plist, /<key>CSP_SERVICE_MODE<\/key>/);
  assert.doesNotMatch(plist, /StandardOutPath/);
  assert.doesNotMatch(plist, /StandardErrorPath/);
});

test("buildServiceDefinition renders systemd user unit", () => {
  const unit = service.buildServiceDefinition({
    platform: "linux",
    nodePath: "/usr/bin/node",
    scriptPath: "/app/cli.mjs",
    configPath: "/home/me/.claude-sub-proxy/config.json",
  });

  assert.match(unit, /ExecStart=\/usr\/bin\/node \/app\/cli\.mjs start/);
  assert.match(unit, /Environment=CSP_CONFIG=\/home\/me\/\.claude-sub-proxy\/config\.json/);
  assert.match(unit, /Environment=CSP_SERVICE_MODE=1/);
  assert.match(unit, /StandardOutput=journal/);
  assert.match(unit, /StandardError=journal/);
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

test("formatListenError explains port conflicts", () => {
  assert.equal(
    formatListenError({ code: "EADDRINUSE", message: "listen EADDRINUSE" }, 13456),
    "Port 13456 is already in use on 127.0.0.1. Stop the existing process or set CSP_PORT to another port.",
  );
});

test("getLaunchctlDomain prefers sudo uid when present", () => {
  const previousSudoUid = process.env.SUDO_UID;
  const previousGetuid = process.getuid;
  process.getuid = () => 501;

  try {
    delete process.env.SUDO_UID;
    assert.equal(service.getLaunchctlDomain(), "gui/501");
  } finally {
    process.getuid = previousGetuid;
    if (previousSudoUid === undefined) {
      delete process.env.SUDO_UID;
    } else {
      process.env.SUDO_UID = previousSudoUid;
    }
  }
});

test("getLaunchctlServiceTarget composes the launchctl label", () => {
  assert.equal(service.getLaunchctlServiceTarget("gui/501"), "gui/501/com.claude-sub-proxy");
});

test("getLaunchctlDomain rejects sudo on macOS", () => {
  const previousSudoUid = process.env.SUDO_UID;
  const previousGetuid = process.getuid;
  process.env.SUDO_UID = "501";
  process.getuid = () => 0;

  try {
    assert.throws(() => service.getLaunchctlDomain(), /without sudo/);
  } finally {
    process.getuid = previousGetuid;
    if (previousSudoUid === undefined) {
      delete process.env.SUDO_UID;
    } else {
      process.env.SUDO_UID = previousSudoUid;
    }
  }
});

test("createLogger uses stdio outside macOS service mode", () => {
  const logger = createLogger({ isServiceMode: false, platform: "darwin" });
  assert.equal(typeof logger.info, "function");
  assert.equal(typeof logger.error, "function");
  assert.equal(typeof logger.close, "function");
});

test("createMacosSystemLogger writes to logger stdin", () => {
  const writes = [];
  let ended = false;
  const fakeChild = {
    pid: 123,
    exitCode: null,
    stdin: {
      destroyed: false,
      write(chunk) {
        writes.push(chunk);
      },
      end() {
        ended = true;
      },
      on() {},
    },
    on() {},
  };

  const logger = createMacosSystemLogger({
    spawnImpl() {
      return fakeChild;
    },
  });

  logger.info("hello");
  logger.error("world");
  logger.close();

  assert.deepEqual(writes, ["hello\n", "world\n"]);
  assert.equal(ended, true);
});

test("createMacosSystemLogger fails if logger cannot start", () => {
  assert.throws(
    () => createMacosSystemLogger({
      spawnImpl() {
        return {
          pid: undefined,
          stdin: null,
          on() {},
        };
      },
    }),
    /Failed to start macOS system logger/,
  );
});
