import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "fs/promises";
import { readFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import {
  loadSettingsFile,
  removeAnthropicBaseUrl,
  resolveSettingsPath,
  setAnthropicBaseUrl,
  writeSettingsAtomic,
} from "../claude-settings.mjs";

test("resolveSettingsPath returns expected locations", () => {
  const homeDir = "/Users/tester";
  const cwd = "/repo";

  assert.equal(resolveSettingsPath("global", { homeDir, cwd }), "/Users/tester/.claude/settings.json");
  assert.equal(resolveSettingsPath("project", { homeDir, cwd }), "/repo/.claude/settings.json");
  assert.equal(resolveSettingsPath("local", { homeDir, cwd }), "/repo/.claude/settings.local.json");
});

test("setAnthropicBaseUrl initializes env when missing", () => {
  const update = setAnthropicBaseUrl({ featureFlags: { safeMode: true } }, "http://127.0.0.1:13456");

  assert.equal(update.changed, true);
  assert.equal(update.previousValue, undefined);
  assert.equal(update.needsConfirmation, false);
  assert.deepEqual(update.nextSettings, {
    featureFlags: { safeMode: true },
    env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:13456" },
  });
});

test("setAnthropicBaseUrl requests confirmation on overwrite", () => {
  const update = setAnthropicBaseUrl(
    { env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:9999", OTHER_VAR: "ok" } },
    "http://127.0.0.1:13456",
  );

  assert.equal(update.changed, true);
  assert.equal(update.previousValue, "http://127.0.0.1:9999");
  assert.equal(update.needsConfirmation, true);
  assert.equal(update.nextSettings.env.OTHER_VAR, "ok");
});

test("setAnthropicBaseUrl handles idempotent value", () => {
  const update = setAnthropicBaseUrl(
    { env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:13456" } },
    "http://127.0.0.1:13456",
  );

  assert.equal(update.changed, false);
  assert.equal(update.needsConfirmation, false);
});

test("removeAnthropicBaseUrl removes base url and preserves sibling env vars", () => {
  const update = removeAnthropicBaseUrl({
    featureFlags: { safeMode: true },
    env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:13456", OTHER_VAR: "ok" },
  });

  assert.equal(update.changed, true);
  assert.equal(update.previousValue, "http://127.0.0.1:13456");
  assert.deepEqual(update.nextSettings, {
    featureFlags: { safeMode: true },
    env: { OTHER_VAR: "ok" },
  });
});

test("removeAnthropicBaseUrl is a no-op when env is missing", () => {
  const update = removeAnthropicBaseUrl({ featureFlags: { safeMode: true } });

  assert.equal(update.changed, false);
  assert.equal(update.previousValue, undefined);
  assert.deepEqual(update.nextSettings, { featureFlags: { safeMode: true } });
});

test("removeAnthropicBaseUrl is a no-op when base url is absent", () => {
  const update = removeAnthropicBaseUrl({ env: { OTHER_VAR: "ok" } });

  assert.equal(update.changed, false);
  assert.equal(update.previousValue, undefined);
  assert.deepEqual(update.nextSettings, { env: { OTHER_VAR: "ok" } });
});

test("removeAnthropicBaseUrl rejects invalid env shape", () => {
  assert.throws(() => removeAnthropicBaseUrl({ env: [] }), /invalid "env" value/);
});

test("writeSettingsAtomic persists JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "claude-settings-test-"));
  const settingsPath = join(dir, ".claude", "settings.json");

  await writeSettingsAtomic(settingsPath, { env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:13456" } });
  const raw = await readFile(settingsPath, "utf8");
  const parsed = JSON.parse(raw);
  assert.equal(parsed.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:13456");
});

test("loadSettingsFile returns empty object for missing file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "claude-settings-test-"));
  const settingsPath = join(dir, "missing.json");
  const result = await loadSettingsFile(settingsPath);
  assert.equal(result.existed, false);
  assert.deepEqual(result.settings, {});
});
