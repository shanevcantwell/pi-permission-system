import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { toRecord } from "./common.js";

export const EXTENSION_ID = "pi-permission-system";

export interface PermissionSystemExtensionConfig {
  debugLog: boolean;
  permissionReviewLog: boolean;
}

export interface PermissionSystemConfigLoadResult {
  config: PermissionSystemExtensionConfig;
  created: boolean;
  warning?: string;
}

export const DEFAULT_EXTENSION_CONFIG: PermissionSystemExtensionConfig = {
  debugLog: false,
  permissionReviewLog: true,
};

export function resolveExtensionRoot(moduleUrl = import.meta.url): string {
  return join(dirname(fileURLToPath(moduleUrl)), "..");
}

export const EXTENSION_ROOT = resolveExtensionRoot();
export const CONFIG_PATH = join(EXTENSION_ROOT, "config.json");
export const LOGS_DIR = join(EXTENSION_ROOT, "logs");
export const DEBUG_LOG_PATH = join(LOGS_DIR, `${EXTENSION_ID}-debug.jsonl`);
export const PERMISSION_REVIEW_LOG_PATH = join(LOGS_DIR, `${EXTENSION_ID}-permission-review.jsonl`);

function cloneDefaultConfig(): PermissionSystemExtensionConfig {
  return {
    debugLog: DEFAULT_EXTENSION_CONFIG.debugLog,
    permissionReviewLog: DEFAULT_EXTENSION_CONFIG.permissionReviewLog,
  };
}

function createDefaultConfigContent(): string {
  return `${JSON.stringify(DEFAULT_EXTENSION_CONFIG, null, 2)}\n`;
}

function normalizeConfig(raw: unknown): PermissionSystemExtensionConfig {
  const record = toRecord(raw);
  return {
    debugLog: record.debugLog === true,
    permissionReviewLog: record.permissionReviewLog !== false,
  };
}

function ensureConfigDirectory(configPath: string): void {
  mkdirSync(dirname(configPath), { recursive: true });
}

export function ensurePermissionSystemConfig(configPath = CONFIG_PATH): { created: boolean; warning?: string } {
  if (existsSync(configPath)) {
    return { created: false };
  }

  try {
    ensureConfigDirectory(configPath);
    writeFileSync(configPath, createDefaultConfigContent(), "utf-8");
    return { created: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      created: false,
      warning: `Failed to initialize permission-system config at '${configPath}': ${message}`,
    };
  }
}

export function loadPermissionSystemConfig(configPath = CONFIG_PATH): PermissionSystemConfigLoadResult {
  const ensureResult = ensurePermissionSystemConfig(configPath);

  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    const config = normalizeConfig(parsed);
    return {
      config,
      created: ensureResult.created,
      warning: ensureResult.warning,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      config: cloneDefaultConfig(),
      created: ensureResult.created,
      warning: ensureResult.warning ?? `Failed to read permission-system config at '${configPath}': ${message}`,
    };
  }
}

export function ensurePermissionSystemLogsDirectory(logsDir = LOGS_DIR): string | undefined {
  try {
    mkdirSync(logsDir, { recursive: true });
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Failed to create permission-system log directory '${logsDir}': ${message}`;
  }
}
