import { spawn } from "child_process";

const LOGGER_TAG = "claude-sub-proxy";

function createStdIoLogger() {
  return {
    info(message) {
      process.stdout.write(`${message}\n`);
    },
    error(message) {
      process.stderr.write(`${message}\n`);
    },
    close() {},
  };
}

export function createMacosSystemLogger({ spawnImpl = spawn } = {}) {
  const child = spawnImpl("logger", ["-t", LOGGER_TAG], {
    stdio: ["pipe", "ignore", "ignore"],
  });

  if (!child.pid || !child.stdin) {
    throw new Error("Failed to start macOS system logger (`logger`).");
  }

  let writeFailed = null;

  child.on("error", (error) => {
    writeFailed = error;
  });

  child.stdin.on("error", (error) => {
    writeFailed = error;
  });

  function write(message) {
    if (writeFailed) {
      throw new Error(`macOS system logger is unavailable: ${writeFailed.message}`);
    }

    if (!child.stdin || child.stdin.destroyed || child.exitCode !== null) {
      throw new Error("macOS system logger is unavailable.");
    }

    child.stdin.write(`${message}\n`);
  }

  return {
    info(message) {
      write(message);
    },
    error(message) {
      write(message);
    },
    close() {
      if (child.stdin && !child.stdin.destroyed) {
        child.stdin.end();
      }
    },
  };
}

export function createLogger({
  isServiceMode = process.env.CSP_SERVICE_MODE === "1",
  platform = process.platform,
  spawnImpl = spawn,
} = {}) {
  if (isServiceMode && platform === "darwin") {
    return createMacosSystemLogger({ spawnImpl });
  }

  return createStdIoLogger();
}
