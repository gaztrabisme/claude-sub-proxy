import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const DEFAULT_CONFIG_DIR = resolve(homedir(), ".claude-sub-proxy");
const DEFAULT_CONFIG_PATH = resolve(DEFAULT_CONFIG_DIR, "config.json");
const EXAMPLE_CONFIG_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "config.example.json");

export function getConfigDir() {
  return DEFAULT_CONFIG_DIR;
}

export function getConfigPath() {
  return process.env.CSP_CONFIG || DEFAULT_CONFIG_PATH;
}

export function getExampleConfigPath() {
  return EXAMPLE_CONFIG_PATH;
}

export function ensureConfigDir() {
  mkdirSync(dirname(getConfigPath()), { recursive: true });
}

export function configExists() {
  return existsSync(getConfigPath());
}

export function createConfigFromExample() {
  ensureConfigDir();

  if (configExists()) {
    return { created: false, path: getConfigPath() };
  }

  writeFileSync(getConfigPath(), readFileSync(getExampleConfigPath(), "utf8"));
  return { created: true, path: getConfigPath() };
}

export function loadConfig() {
  return JSON.parse(readFileSync(getConfigPath(), "utf8"));
}

export function saveConfig(config) {
  ensureConfigDir();
  writeFileSync(getConfigPath(), `${JSON.stringify(config, null, 2)}\n`);
}

export function ensureConfigFile() {
  ensureConfigDir();
  return createConfigFromExample();
}

export function validateUniqueRouteName(config, routeName) {
  const routes = Array.isArray(config.routes) ? config.routes : [];

  if (routes.some((route) => route.name === routeName)) {
    throw new Error(`Route name "${routeName}" already exists.`);
  }
}

export function addRoute(config, route) {
  validateUniqueRouteName(config, route.name);
  const routes = Array.isArray(config.routes) ? [...config.routes] : [];
  routes.push(route);
  return { ...config, routes };
}

export function removeRouteByName(config, routeName) {
  const routes = Array.isArray(config.routes) ? config.routes : [];
  const matches = routes.filter((route) => route.name === routeName);

  if (matches.length === 0) {
    throw new Error(`Route "${routeName}" was not found.`);
  }

  if (matches.length > 1) {
    throw new Error(`Route name "${routeName}" is duplicated in config. Resolve duplicates manually first.`);
  }

  const nextRoutes = [];
  let removed = false;
  for (const route of routes) {
    if (!removed && route.name === routeName) {
      removed = true;
      continue;
    }
    nextRoutes.push(route);
  }

  return { ...config, routes: nextRoutes };
}

export function maskSecret(value) {
  if (!value) return "";
  if (value.startsWith("$")) return value;
  if (value.length <= 4) return "*".repeat(value.length);
  return `${value.slice(0, 2)}${"*".repeat(Math.min(8, Math.max(4, value.length - 4)))}${value.slice(-2)}`;
}
