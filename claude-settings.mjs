import { dirname, resolve } from "path";
import { access, mkdir, readFile, rename, writeFile } from "fs/promises";
import { constants } from "fs";

const SETTINGS_SCOPES = {
  global: "~/.claude/settings.json",
  project: ".claude/settings.json",
  local: ".claude/settings.local.json",
};

export function listSettingsScopes() {
  return [
    { key: "global", label: `Global user (${SETTINGS_SCOPES.global})` },
    { key: "project", label: `Project (${SETTINGS_SCOPES.project})` },
    { key: "local", label: `Local project-only (${SETTINGS_SCOPES.local})` },
  ];
}

export function resolveSettingsPath(scopeKey, { homeDir, cwd }) {
  if (!SETTINGS_SCOPES[scopeKey]) {
    throw new Error(`Unknown settings scope: ${scopeKey}`);
  }

  if (scopeKey === "global") {
    return resolve(homeDir, ".claude", "settings.json");
  }

  if (scopeKey === "project") {
    return resolve(cwd, ".claude", "settings.json");
  }

  return resolve(cwd, ".claude", "settings.local.json");
}

export async function loadSettingsFile(settingsPath) {
  try {
    await access(settingsPath, constants.F_OK);
  } catch {
    return { existed: false, settings: {} };
  }

  const raw = await readFile(settingsPath, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Settings file must be a JSON object: ${settingsPath}`);
  }

  return { existed: true, settings: parsed };
}

export function setAnthropicBaseUrl(settings, baseUrl) {
  if (!baseUrl || !baseUrl.trim()) {
    throw new Error("ANTHROPIC_BASE_URL is required.");
  }

  const nextSettings = { ...settings };
  const envValue = nextSettings.env;

  if (envValue === undefined) {
    nextSettings.env = {};
  } else if (!envValue || typeof envValue !== "object" || Array.isArray(envValue)) {
    throw new Error("settings.json contains an invalid \"env\" value; expected an object.");
  } else {
    nextSettings.env = { ...envValue };
  }

  const nextValue = baseUrl.trim();
  const previousValue = nextSettings.env.ANTHROPIC_BASE_URL;
  nextSettings.env.ANTHROPIC_BASE_URL = nextValue;

  return {
    nextSettings,
    previousValue,
    changed: previousValue !== nextValue,
    needsConfirmation: Boolean(previousValue && previousValue !== nextValue),
  };
}

export function removeAnthropicBaseUrl(settings) {
  const nextSettings = { ...settings };
  const envValue = nextSettings.env;

  if (envValue === undefined) {
    return {
      nextSettings,
      previousValue: undefined,
      changed: false,
    };
  }

  if (!envValue || typeof envValue !== "object" || Array.isArray(envValue)) {
    throw new Error("settings.json contains an invalid \"env\" value; expected an object.");
  }

  nextSettings.env = { ...envValue };
  const previousValue = nextSettings.env.ANTHROPIC_BASE_URL;

  if (previousValue === undefined) {
    return {
      nextSettings,
      previousValue,
      changed: false,
    };
  }

  delete nextSettings.env.ANTHROPIC_BASE_URL;

  return {
    nextSettings,
    previousValue,
    changed: true,
  };
}

export async function writeSettingsAtomic(settingsPath, settings) {
  const parentDir = dirname(settingsPath);
  await mkdir(parentDir, { recursive: true });

  const temporaryPath = `${settingsPath}.tmp-${process.pid}-${Date.now()}`;
  const serialized = `${JSON.stringify(settings, null, 2)}\n`;

  await writeFile(temporaryPath, serialized, "utf8");
  await rename(temporaryPath, settingsPath);
}
