import { existsSync, mkdirSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, resolve } from "path";
import { spawnSync } from "child_process";

import { ensureConfigFile, getConfigDir } from "./config.mjs";

const SERVICE_NAME = "com.claude-sub-proxy";

export function getPlatform() {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "linux") return "linux";
  throw new Error(`Unsupported platform: ${process.platform}`);
}

export function getServiceInstallPaths(platform = getPlatform()) {
  if (platform === "macos") {
    return {
      serviceFilePath: resolve(homedir(), "Library", "LaunchAgents", `${SERVICE_NAME}.plist`),
    };
  }

  return {
    serviceFilePath: resolve(homedir(), ".config", "systemd", "user", `${SERVICE_NAME}.service`),
  };
}

export function isServiceInstalled(platform = getPlatform()) {
  return existsSync(getServiceInstallPaths(platform).serviceFilePath);
}

export function getLaunchctlDomain() {
  if (process.getuid() === 0 || process.env.SUDO_UID) {
    throw new Error("macOS user services must be installed as the logged-in user. Run `claude-sub-proxy service install` without sudo.");
  }

  const uid = Number(process.getuid());

  if (!Number.isInteger(uid) || uid < 1) {
    throw new Error("macOS user services must be installed as a regular user session. Run `claude-sub-proxy service install` without sudo.");
  }

  return `gui/${uid}`;
}

export function getLaunchctlServiceTarget(domain = getLaunchctlDomain()) {
  return `${domain}/${SERVICE_NAME}`;
}

export function buildServiceDefinition({ platform = getPlatform(), nodePath, scriptPath, configPath }) {
  if (platform === "macos") {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_NAME}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${scriptPath}</string>
    <string>start</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CSP_CONFIG</key>
    <string>${configPath}</string>
    <key>CSP_SERVICE_MODE</key>
    <string>1</string>
  </dict>
  <key>RunAtLoad</key>
  <false/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
`;
  }

  return `[Unit]
Description=Claude Sub Proxy
After=network.target

[Service]
Type=simple
Environment=CSP_CONFIG=${configPath}
Environment=CSP_SERVICE_MODE=1
ExecStart=${nodePath} ${scriptPath} start
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
`;
}

export async function runServiceManager(command, args) {
  const { spawn } = await import("child_process");

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }

      rejectPromise(new Error(`${command} ${args.join(" ")} failed with code ${code}`));
    });
    child.on("error", rejectPromise);
  });
}

function isLaunchctlServiceLoaded(serviceTarget) {
  const printResult = spawnSync("launchctl", ["print", serviceTarget], { stdio: "ignore" });
  return printResult.status === 0;
}

function bootoutLaunchctlService(domain, serviceFilePath) {
  const result = spawnSync("launchctl", ["bootout", domain, serviceFilePath], { encoding: "utf8" });

  if (result.status === 0) {
    return;
  }

  const stderr = `${result.stderr || ""}${result.stdout || ""}`;
  const isAlreadyUnloaded = result.status === 3 || result.status === 5;
  const isMissingService = /Could not find service|service.*not found/i.test(stderr);
  const isBootoutIoError = /Boot-out failed:\s*5:\s*Input\/output error/i.test(stderr);

  if (isAlreadyUnloaded || isMissingService || isBootoutIoError) {
    return;
  }

  throw new Error(`launchctl bootout ${domain} ${serviceFilePath} failed with code ${result.status}`);
}

export async function installService({ nodePath, scriptPath, configPath }) {
  const platform = getPlatform();
  const { serviceFilePath } = getServiceInstallPaths(platform);
  const existedBeforeInstall = existsSync(serviceFilePath);

  ensureConfigFile();
  mkdirSync(dirname(serviceFilePath), { recursive: true });
  mkdirSync(getConfigDir(), { recursive: true });

  writeFileSync(
    serviceFilePath,
    buildServiceDefinition({ platform, nodePath, scriptPath, configPath }),
  );

  if (platform === "macos") {
    const domain = getLaunchctlDomain();
    const serviceTarget = getLaunchctlServiceTarget(domain);

    if (existedBeforeInstall) {
      bootoutLaunchctlService(domain, serviceFilePath);
    }
    await runServiceManager("launchctl", ["enable", serviceTarget]);
    await runServiceManager("launchctl", ["bootstrap", domain, serviceFilePath]);
    return { platform, serviceFilePath };
  }

  await runServiceManager("systemctl", ["--user", "daemon-reload"]);
  await runServiceManager("systemctl", ["--user", "enable", SERVICE_NAME]);
  return { platform, serviceFilePath };
}

export async function startService() {
  const platform = getPlatform();

  if (!isServiceInstalled(platform)) {
    const error = new Error("Service is not installed.");
    error.code = "SERVICE_NOT_INSTALLED";
    throw error;
  }

  if (platform === "macos") {
    const domain = getLaunchctlDomain();
    const { serviceFilePath } = getServiceInstallPaths(platform);
    const serviceTarget = getLaunchctlServiceTarget(domain);

    if (isLaunchctlServiceLoaded(serviceTarget)) {
      await runServiceManager("launchctl", ["kickstart", "-k", serviceTarget]);
      return;
    }

    await runServiceManager("launchctl", ["enable", serviceTarget]);
    await runServiceManager("launchctl", ["bootstrap", domain, serviceFilePath]);
    await runServiceManager("launchctl", ["kickstart", "-k", serviceTarget]);
    return;
  }

  await runServiceManager("systemctl", ["--user", "start", SERVICE_NAME]);
}

export async function stopService() {
  const platform = getPlatform();

  if (!isServiceInstalled(platform)) {
    const error = new Error("Service is not installed.");
    error.code = "SERVICE_NOT_INSTALLED";
    throw error;
  }

  if (platform === "macos") {
    const domain = getLaunchctlDomain();
    const { serviceFilePath } = getServiceInstallPaths(platform);
    bootoutLaunchctlService(domain, serviceFilePath);
    return;
  }

  await runServiceManager("systemctl", ["--user", "stop", SERVICE_NAME]);
}

export async function restartService() {
  const platform = getPlatform();

  if (!isServiceInstalled(platform)) {
    const error = new Error("Service is not installed.");
    error.code = "SERVICE_NOT_INSTALLED";
    throw error;
  }

  if (platform === "macos") {
    const serviceTarget = getLaunchctlServiceTarget();
    await runServiceManager("launchctl", ["kickstart", "-k", serviceTarget]);
    return;
  }

  await runServiceManager("systemctl", ["--user", "restart", SERVICE_NAME]);
}
