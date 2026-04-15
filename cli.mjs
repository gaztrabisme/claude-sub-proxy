#!/usr/bin/env node
import { createInterface } from "readline/promises";
import { stdin as input, stdout as output } from "process";
import { fileURLToPath } from "url";
import { homedir } from "os";

import {
  addRoute,
  createConfigFromExample,
  ensureConfigDir,
  ensureConfigFile,
  getConfigPath,
  loadConfig,
  maskSecret,
  removeRouteByName,
  saveConfig,
} from "./config.mjs";
import {
  listSettingsScopes,
  loadSettingsFile,
  removeAnthropicBaseUrl,
  resolveSettingsPath,
  setAnthropicBaseUrl,
  writeSettingsAtomic,
} from "./claude-settings.mjs";
import { startProxy } from "./runtime.mjs";
import { installService, restartService, startService, stopService } from "./service.mjs";

const ROUTE_PROMPTS = [
  { key: "name", label: "Route name", example: "MiniMax", required: true },
  { key: "match", label: "Match regex", example: "haiku|sonnet", required: true },
  { key: "api_base", label: "API base URL", example: "https://api.minimax.io/anthropic", required: true },
  { key: "api_key", label: "API key", example: "sk-... or $MINIMAX_API_KEY", required: true },
  { key: "model", label: "Target model", example: "MiniMax-M2.7", required: true },
  { key: "auth_scheme", label: "Auth scheme", example: "x-api-key or bearer", defaultValue: "x-api-key" },
];

function printHelp() {
  console.log(`Usage:
  claude-sub-proxy start

  claude-sub-proxy claude install
  claude-sub-proxy claude disable

  claude-sub-proxy service install
  claude-sub-proxy service start
  claude-sub-proxy service restart
  claude-sub-proxy service stop

  claude-sub-proxy configure init
  claude-sub-proxy configure show
  claude-sub-proxy configure add
  claude-sub-proxy configure remove <name>

Guide:
  start
    Start the proxy in the foreground for local testing or manual runs.

  configure
    configure init
      Create ~/.claude-sub-proxy/config.json from the example template.
    configure show
      Show the active config and redact API keys in terminal output.
    configure add
      Interactively add a routing rule for matching Claude models.
    configure remove <name>
      Remove a routing rule by its unique route name.

  claude
    claude install
      Write ANTHROPIC_BASE_URL into Claude settings so Claude Code uses this proxy.
    claude disable
      Remove ANTHROPIC_BASE_URL from Claude settings and restore default Claude endpoint behavior.

  service
    service install
      Install the background user service for the current OS.
    service start
      Start the installed background service.
    service restart
      Restart the installed background service.
    service stop
      Stop the installed background service.

Typical setup:
  1. claude-sub-proxy configure init
  2. claude-sub-proxy configure add
  3. claude-sub-proxy claude install
  4. claude-sub-proxy service install
  5. claude-sub-proxy service start`);
}

function formatTable(rows) {
  if (rows.length === 0) return "";

  const widths = rows[0].map((_, index) => Math.max(...rows.map((row) => String(row[index]).length)));
  return rows
    .map((row, rowIndex) =>
      row
        .map((cell, index) => String(cell).padEnd(widths[index]))
        .join("  ")
        .concat(rowIndex === 0 ? `\n${widths.map((width) => "-".repeat(width)).join("  ")}` : ""),
    )
    .join("\n");
}

async function promptForRoute(config) {
  const rl = createInterface({ input, output, terminal: Boolean(output.isTTY) });

  try {
    const currentConfig = { ...config };
    const currentPort = currentConfig.port || 13456;
    const portAnswer = await rl.question(`Port [${currentPort}]: `);
    currentConfig.port = Number(portAnswer.trim() || currentPort);

    while (true) {
      const route = {};
      for (const prompt of ROUTE_PROMPTS) {
        const suffix = prompt.defaultValue ? ` [${prompt.defaultValue}]` : "";
        const answer = await rl.question(`${prompt.label} (${prompt.example})${suffix}: `);
        const value = answer.trim() || prompt.defaultValue || "";

        if (prompt.required && !value) {
          throw new Error(`${prompt.label} is required.`);
        }

        if (value) {
          route[prompt.key] = value;
        }
      }

      Object.assign(currentConfig, addRoute(currentConfig, route));

      const addAnother = await rl.question("Add another route? [y/N]: ");
      if (!/^y(es)?$/i.test(addAnother.trim())) {
        return currentConfig;
      }
    }
  } finally {
    rl.close();
  }
}

function getSuggestedAnthropicBaseUrl() {
  try {
    const config = loadConfig();
    const port = Number(config.port || 13456);
    return `http://127.0.0.1:${port}`;
  } catch {
    return "http://127.0.0.1:13456";
  }
}

async function promptForSettingsScope(rl) {
  const scopes = listSettingsScopes();
  console.log("Choose Claude settings target:");
  scopes.forEach((scope, index) => {
    console.log(`  ${index + 1}. ${scope.label}`);
  });

  const scopeAnswer = await rl.question("Selection [1]: ");
  const selectedIndex = scopeAnswer.trim() ? Number(scopeAnswer.trim()) : 1;
  if (!Number.isInteger(selectedIndex) || selectedIndex < 1 || selectedIndex > scopes.length) {
    throw new Error(`Invalid selection: ${scopeAnswer.trim() || "(empty)"}`);
  }

  return scopes[selectedIndex - 1];
}

async function runClaudeInstallFlow() {
  const rl = createInterface({ input, output, terminal: Boolean(output.isTTY) });

  try {
    const selectedScope = await promptForSettingsScope(rl);
    const settingsPath = resolveSettingsPath(selectedScope.key, { homeDir: homedir(), cwd: process.cwd() });
    const suggestedBaseUrl = getSuggestedAnthropicBaseUrl();
    const urlAnswer = await rl.question(`ANTHROPIC_BASE_URL [${suggestedBaseUrl}]: `);
    const baseUrl = (urlAnswer.trim() || suggestedBaseUrl).trim();

    const { settings } = await loadSettingsFile(settingsPath);
    const update = setAnthropicBaseUrl(settings, baseUrl);

    if (update.needsConfirmation) {
      console.warn(`Warning: existing ANTHROPIC_BASE_URL is \"${update.previousValue}\".`);
      const confirmAnswer = await rl.question(`Overwrite with \"${baseUrl}\"? [y/N]: `);
      if (!/^y(es)?$/i.test(confirmAnswer.trim())) {
        console.log("No changes written.");
        return;
      }
    }

    await writeSettingsAtomic(settingsPath, update.nextSettings);

    if (update.changed) {
      console.log(`Updated Claude settings: ${settingsPath}`);
    } else {
      console.log(`Claude settings already had ANTHROPIC_BASE_URL=${baseUrl}`);
    }
  } finally {
    rl.close();
  }
}

async function runDisableRouteFlow() {
  const rl = createInterface({ input, output, terminal: Boolean(output.isTTY) });

  try {
    const selectedScope = await promptForSettingsScope(rl);
    const settingsPath = resolveSettingsPath(selectedScope.key, { homeDir: homedir(), cwd: process.cwd() });
    const { existed, settings } = await loadSettingsFile(settingsPath);

    if (!existed) {
      console.log(`Claude settings file does not exist: ${settingsPath}`);
      return;
    }

    const update = removeAnthropicBaseUrl(settings);

    if (!update.changed) {
      console.log(`Claude settings did not contain ANTHROPIC_BASE_URL: ${settingsPath}`);
      return;
    }

    await writeSettingsAtomic(settingsPath, update.nextSettings);
    console.log(`Removed ANTHROPIC_BASE_URL from Claude settings: ${settingsPath}`);
  } finally {
    rl.close();
  }
}

function showConfig() {
  const config = loadConfig();
  console.log(`Config: ${getConfigPath()}`);
  console.log("");
  console.log(formatTable([
    ["Field", "Value"],
    ["port", config.port ?? 13456],
  ]));
  console.log("");

  const routeRows = [["Name", "Match", "API Base", "API Key", "Model", "Auth"]];
  for (const route of config.routes || []) {
    routeRows.push([
      route.name || "",
      route.match || "",
      route.api_base || "",
      maskSecret(route.api_key || ""),
      route.model || "",
      route.auth_scheme || "x-api-key",
    ]);
  }

  console.log(routeRows.length === 1 ? "Routes: none" : formatTable(routeRows));
}

async function main(argv) {
  const [command, subcommand, ...rest] = argv;

  try {
    if (!command || command === "--help" || command === "-h") {
      printHelp();
      return;
    }

    if (command === "start") {
      startProxy();
      return;
    }

    if (command === "configure" && subcommand === "init") {
      ensureConfigDir();
      const result = createConfigFromExample();
      console.log(result.created ? `Created config at ${result.path}` : `Config already exists at ${result.path}`);
      return;
    }

    if (command === "configure" && subcommand === "show") {
      showConfig();
      return;
    }

    if ((command === "claude" && subcommand === "install") || command === "install-claude" || (command === "configure" && subcommand === "claude")) {
      await runClaudeInstallFlow();
      return;
    }

    if ((command === "claude" && subcommand === "disable") || command === "disable-route") {
      await runDisableRouteFlow();
      return;
    }

    if (command === "configure" && subcommand === "add") {
      ensureConfigFile();
      const nextConfig = await promptForRoute(loadConfig());
      saveConfig(nextConfig);
      console.log(`Updated config at ${getConfigPath()}`);
      return;
    }

    if (command === "configure" && subcommand === "remove") {
      const routeName = rest.join(" ").trim();
      if (!routeName) {
        throw new Error("Route name is required.");
      }
      const nextConfig = removeRouteByName(loadConfig(), routeName);
      saveConfig(nextConfig);
      console.log(`Removed route "${routeName}" from ${getConfigPath()}`);
      return;
    }

    if ((command === "service" && subcommand === "install") || command === "install-service") {
      const result = await installService({
        nodePath: process.execPath,
        scriptPath: fileURLToPath(import.meta.url),
        configPath: getConfigPath(),
      });
      console.log(`Installed ${result.platform} service at ${result.serviceFilePath}`);
      return;
    }

    if (command === "service" && subcommand === "start") {
      await startService();
      console.log("Service started");
      return;
    }

    if (command === "service" && subcommand === "stop") {
      await stopService();
      console.log("Service stopped");
      return;
    }

    if (command === "service" && subcommand === "restart") {
      await restartService();
      console.log("Service restarted");
      return;
    }

    printHelp();
    process.exitCode = 1;
  } catch (error) {
    if (error.code === "SERVICE_NOT_INSTALLED") {
      console.error("Service is not installed. Run `claude-sub-proxy service install` first.");
      process.exitCode = 1;
      return;
    }

    console.error(error.message);
    process.exitCode = 1;
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
