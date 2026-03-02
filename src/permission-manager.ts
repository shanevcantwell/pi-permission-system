import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { BashFilter } from "./bash-filter.js";
import type {
  AgentPermissions,
  BashPermissions,
  GlobalPermissionConfig,
  PermissionCheckResult,
  PermissionDefaultPolicy,
  PermissionState,
} from "./types.js";

const GLOBAL_CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-permissions.jsonc");
const AGENTS_DIR = join(homedir(), ".pi", "agent", "agents");

const BUILT_IN_TOOLS = new Set(["bash", "read", "write", "edit", "grep", "find", "ls"]);
const LEGACY_TOOL_ALIASES: Record<string, string> = {};
const SPECIAL_PERMISSION_KEYS = new Set(["doom_loop", "external_directory"]);
const MCP_BASELINE_TARGETS = new Set(["mcp_status", "mcp_list", "mcp_search", "mcp_describe", "mcp_connect"]);

function normalizeToolName(toolName: string): string {
  return LEGACY_TOOL_ALIASES[toolName] || toolName;
}

const DEFAULT_POLICY: PermissionDefaultPolicy = {
  tools: "ask",
  bash: "ask",
  mcp: "ask",
  skills: "ask",
  special: "ask",
};

const EMPTY_GLOBAL_CONFIG: GlobalPermissionConfig = {
  defaultPolicy: DEFAULT_POLICY,
  tools: {},
  bash: {},
  mcp: {},
  skills: {},
  special: {},
};

function stripJsonComments(input: string): string {
  let output = "";
  let inString = false;
  let stringQuote: '"' | "'" | "" = "";
  let escaping = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    const next = input[i + 1] || "";

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
        output += char;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (!inString && char === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }

    if (!inString && char === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }

    output += char;

    if (!inString && (char === '"' || char === "'")) {
      inString = true;
      stringQuote = char;
      escaping = false;
      continue;
    }

    if (!inString) {
      continue;
    }

    if (escaping) {
      escaping = false;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if (char === stringQuote) {
      inString = false;
      stringQuote = "";
    }
  }

  return output;
}

function isPermissionState(value: unknown): value is PermissionState {
  return value === "allow" || value === "deny" || value === "ask";
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function normalizePolicy(value: unknown): PermissionDefaultPolicy {
  const record = toRecord(value);
  return {
    tools: isPermissionState(record.tools) ? record.tools : DEFAULT_POLICY.tools,
    bash: isPermissionState(record.bash) ? record.bash : DEFAULT_POLICY.bash,
    mcp: isPermissionState(record.mcp) ? record.mcp : DEFAULT_POLICY.mcp,
    skills: isPermissionState(record.skills) ? record.skills : DEFAULT_POLICY.skills,
    special: isPermissionState(record.special) ? record.special : DEFAULT_POLICY.special,
  };
}

function normalizePermissionRecord(value: unknown): Record<string, PermissionState> {
  const record = toRecord(value);
  const normalized: Record<string, PermissionState> = {};
  for (const [key, state] of Object.entries(record)) {
    if (isPermissionState(state)) {
      normalized[key] = state;
    }
  }
  return normalized;
}

function normalizeRawPermission(raw: unknown): AgentPermissions {
  const record = toRecord(raw);

  const tools = normalizePermissionRecord(record.tools);
  const normalizedTools: Record<string, PermissionState> = {};
  for (const [toolName, state] of Object.entries(tools)) {
    normalizedTools[normalizeToolName(toolName)] = state;
  }

  const normalized: AgentPermissions = {
    defaultPolicy: normalizePolicy(record.defaultPolicy),
    tools: normalizedTools,
    bash: normalizePermissionRecord(record.bash),
    mcp: normalizePermissionRecord(record.mcp),
    skills: normalizePermissionRecord(record.skills),
    special: normalizePermissionRecord(record.special),
  };

  for (const [key, value] of Object.entries(record)) {
    if (!isPermissionState(value)) {
      continue;
    }

    const normalizedToolName = normalizeToolName(key);

    if (BUILT_IN_TOOLS.has(normalizedToolName)) {
      normalized.tools = { ...(normalized.tools || {}), [normalizedToolName]: value };
      continue;
    }

    if (SPECIAL_PERMISSION_KEYS.has(key)) {
      normalized.special = { ...(normalized.special || {}), [key]: value };
    }
  }

  return normalized;
}

type StackNode = { indent: number; target: Record<string, unknown> };

function parseSimpleYamlMap(input: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const stack: StackNode[] = [{ indent: -1, target: root }];

  const lines = input.split(/\r?\n/);
  for (const rawLine of lines) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) {
      continue;
    }

    const indent = rawLine.length - rawLine.trimStart().length;
    const line = rawLine.trim();

    const separatorIndex = line.indexOf(":");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim().replace(/^['"]|['"]$/g, "");
    const rawValue = line.slice(separatorIndex + 1).trim();

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const current = stack[stack.length - 1].target;

    if (!rawValue) {
      const child: Record<string, unknown> = {};
      current[key] = child;
      stack.push({ indent, target: child });
      continue;
    }

    let scalar = rawValue;
    if ((scalar.startsWith('"') && scalar.endsWith('"')) || (scalar.startsWith("'") && scalar.endsWith("'"))) {
      scalar = scalar.slice(1, -1);
    }

    current[key] = scalar;
  }

  return root;
}

function extractFrontmatter(markdown: string): string {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return "";
  }

  const end = normalized.indexOf("\n---", 4);
  if (end === -1) {
    return "";
  }

  return normalized.slice(4, end);
}

function isBuiltInToolName(toolName: string): boolean {
  return BUILT_IN_TOOLS.has(toolName);
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");

  return new RegExp(`^${escaped}$`);
}

type WildcardMatch = { state: PermissionState; matchedPattern: string; matchedName: string };

function sortPermissionPatterns(
  permissions: Record<string, PermissionState>,
): Array<[pattern: string, state: PermissionState]> {
  return Object.entries(permissions).sort((a, b) => {
    const [aPattern] = a;
    const [bPattern] = b;
    const aWildcards = (aPattern.match(/\*/g) || []).length;
    const bWildcards = (bPattern.match(/\*/g) || []).length;

    if (aWildcards !== bWildcards) {
      return aWildcards - bWildcards;
    }

    const aLiteralLength = aPattern.replace(/\*/g, "").length;
    const bLiteralLength = bPattern.replace(/\*/g, "").length;

    if (aLiteralLength !== bLiteralLength) {
      return bLiteralLength - aLiteralLength;
    }

    return bPattern.length - aPattern.length;
  });
}

function findWildcardPermission(
  permissions: Record<string, PermissionState> | undefined,
  name: string,
): WildcardMatch | null {
  if (!permissions) {
    return null;
  }

  for (const [pattern, state] of sortPermissionPatterns(permissions)) {
    if (wildcardToRegExp(pattern).test(name)) {
      return { state, matchedPattern: pattern, matchedName: name };
    }
  }

  return null;
}

function findWildcardPermissionForNames(
  permissions: Record<string, PermissionState> | undefined,
  names: readonly string[],
): WildcardMatch | null {
  if (!permissions || names.length === 0) {
    return null;
  }

  const normalizedNames = names.map((value) => value.trim()).filter((value) => value.length > 0);
  if (normalizedNames.length === 0) {
    return null;
  }

  for (const name of normalizedNames) {
    const match = findWildcardPermission(permissions, name);
    if (match) {
      return match;
    }
  }

  return null;
}

function getNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function parseQualifiedMcpToolName(value: string): { server: string; tool: string } | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const colonIndex = trimmed.indexOf(":");
  if (colonIndex <= 0 || colonIndex >= trimmed.length - 1) {
    return null;
  }

  const server = trimmed.slice(0, colonIndex).trim();
  const tool = trimmed.slice(colonIndex + 1).trim();
  if (!server || !tool) {
    return null;
  }

  return { server, tool };
}

function createMcpPermissionTargets(input: unknown): string[] {
  const record = toRecord(input);
  const tool = getNonEmptyString(record.tool);
  const server = getNonEmptyString(record.server);
  const connect = getNonEmptyString(record.connect);
  const describe = getNonEmptyString(record.describe);
  const search = getNonEmptyString(record.search);

  const targets: string[] = [];
  const pushTarget = (value: string | null) => {
    if (!value) {
      return;
    }
    if (!targets.includes(value)) {
      targets.push(value);
    }
  };

  if (tool) {
    const qualified = parseQualifiedMcpToolName(tool);
    const resolvedServer = server ?? qualified?.server ?? null;
    const resolvedTool = qualified?.tool ?? tool;

    if (resolvedServer) {
      pushTarget(`${resolvedServer}_${resolvedTool}`);
      pushTarget(`${resolvedServer}:${resolvedTool}`);
      pushTarget(resolvedServer);
    }

    pushTarget(resolvedTool);
    pushTarget(tool);
    pushTarget("mcp_call");
    return targets;
  }

  if (connect) {
    pushTarget(`mcp_connect_${connect}`);
    pushTarget(connect);
    pushTarget("mcp_connect");
    return targets;
  }

  if (describe) {
    if (server) {
      pushTarget(`${server}_${describe}`);
      pushTarget(`${server}:${describe}`);
      pushTarget(server);
    }

    pushTarget(describe);
    pushTarget("mcp_describe");
    return targets;
  }

  if (search) {
    if (server) {
      pushTarget(`mcp_server_${server}`);
      pushTarget(server);
    }

    pushTarget(search);
    pushTarget("mcp_search");
    return targets;
  }

  if (server) {
    pushTarget(`mcp_server_${server}`);
    pushTarget(server);
    pushTarget("mcp_list");
    return targets;
  }

  pushTarget("mcp_status");
  return targets;
}

export class PermissionManager {
  private readonly globalConfigPath: string;
  private readonly agentsDir: string;

  constructor(options: { globalConfigPath?: string; agentsDir?: string } = {}) {
    this.globalConfigPath = options.globalConfigPath || GLOBAL_CONFIG_PATH;
    this.agentsDir = options.agentsDir || AGENTS_DIR;
  }

  private loadGlobalConfig(): GlobalPermissionConfig {
    try {
      const raw = readFileSync(this.globalConfigPath, "utf-8");
      const parsed = JSON.parse(stripJsonComments(raw)) as unknown;
      const normalized = normalizeRawPermission(parsed);

      return {
        defaultPolicy: normalizePolicy(normalized.defaultPolicy),
        tools: normalized.tools || {},
        bash: normalized.bash || {},
        mcp: normalized.mcp || {},
        skills: normalized.skills || {},
        special: normalized.special || {},
      };
    } catch {
      return EMPTY_GLOBAL_CONFIG;
    }
  }

  private loadAgentPermissions(agentName?: string): AgentPermissions {
    if (!agentName) {
      return {};
    }

    const filePath = join(this.agentsDir, `${agentName}.md`);

    try {
      const markdown = readFileSync(filePath, "utf-8");
      const frontmatter = extractFrontmatter(markdown);
      if (!frontmatter) {
        return {};
      }

      const parsed = parseSimpleYamlMap(frontmatter);
      return normalizeRawPermission(parsed.permission);
    } catch {
      return {};
    }
  }

  private mergePermissions(globalConfig: GlobalPermissionConfig, agentConfig: AgentPermissions): GlobalPermissionConfig {
    return {
      defaultPolicy: {
        ...globalConfig.defaultPolicy,
        ...(agentConfig.defaultPolicy || {}),
      },
      tools: {
        ...(globalConfig.tools || {}),
        ...(agentConfig.tools || {}),
      },
      bash: {
        ...(globalConfig.bash || {}),
        ...(agentConfig.bash || {}),
      },
      mcp: {
        ...(globalConfig.mcp || {}),
        ...(agentConfig.mcp || {}),
      },
      skills: {
        ...(globalConfig.skills || {}),
        ...(agentConfig.skills || {}),
      },
      special: {
        ...(globalConfig.special || {}),
        ...(agentConfig.special || {}),
      },
    };
  }

  private resolvePermissions(agentName?: string): {
    globalConfig: GlobalPermissionConfig;
    agentConfig: AgentPermissions;
    merged: GlobalPermissionConfig;
  } {
    const globalConfig = this.loadGlobalConfig();
    const agentConfig = this.loadAgentPermissions(agentName);
    return {
      globalConfig,
      agentConfig,
      merged: this.mergePermissions(globalConfig, agentConfig),
    };
  }

  getBashPermissions(agentName?: string): BashPermissions {
    const { merged } = this.resolvePermissions(agentName);
    return merged.bash || {};
  }

  checkPermission(toolName: string, input: unknown, agentName?: string): PermissionCheckResult {
    const { agentConfig, merged } = this.resolvePermissions(agentName);
    const normalizedToolName = normalizeToolName(toolName);

    if (SPECIAL_PERMISSION_KEYS.has(normalizedToolName)) {
      const result = findWildcardPermission(merged.special, normalizedToolName);
      return {
        toolName,
        state: result?.state || merged.defaultPolicy.special,
        matchedPattern: result?.matchedPattern,
        source: "special",
      };
    }

    if (normalizedToolName === "skill") {
      const skillName = toRecord(input).name;
      if (typeof skillName === "string") {
        const result = findWildcardPermission(merged.skills, skillName);
        return {
          toolName,
          state: result?.state || merged.defaultPolicy.skills,
          matchedPattern: result?.matchedPattern,
          source: "skill",
        };
      }

      return {
        toolName,
        state: merged.defaultPolicy.skills,
        source: "skill",
      };
    }

    if (normalizedToolName === "bash") {
      const record = toRecord(input);
      const command = typeof record.command === "string" ? record.command : "";

      const agentBashToolOverride = agentConfig.tools?.bash;
      const hasAgentBashPatterns = Object.keys(agentConfig.bash || {}).length > 0;

      if (agentBashToolOverride && !hasAgentBashPatterns) {
        return {
          toolName,
          state: agentBashToolOverride,
          command,
          source: "bash",
        };
      }

      const bashDefault = agentBashToolOverride || merged.tools?.bash || merged.defaultPolicy.bash;
      const filter = new BashFilter(merged.bash || {}, bashDefault);
      const result = filter.check(command);

      return {
        toolName,
        state: result.state,
        command: result.command,
        matchedPattern: result.matchedPattern,
        source: "bash",
      };
    }

    if (isBuiltInToolName(normalizedToolName)) {
      return {
        toolName,
        state: merged.tools?.[normalizedToolName] || merged.defaultPolicy.tools,
        source: "tool",
      };
    }

    if (normalizedToolName === "mcp") {
      const mcpTargets = [...createMcpPermissionTargets(input), "mcp"];
      const mcpMatch = findWildcardPermissionForNames(merged.mcp, mcpTargets);
      if (mcpMatch) {
        return {
          toolName,
          state: mcpMatch.state,
          matchedPattern: mcpMatch.matchedPattern,
          target: mcpMatch.matchedName,
          source: "mcp",
        };
      }

      const baselineTarget = mcpTargets.find((target) => MCP_BASELINE_TARGETS.has(target));
      if (baselineTarget) {
        const hasAnyMcpAllowRule = Object.values(merged.mcp || {}).some((state) => state === "allow");
        if (hasAnyMcpAllowRule || merged.defaultPolicy.mcp === "allow") {
          return {
            toolName,
            state: "allow",
            target: baselineTarget,
            source: "mcp",
          };
        }
      }

      return {
        toolName,
        state: merged.defaultPolicy.mcp || "deny",
        target: mcpTargets[0],
        source: "default",
      };
    }

    const mcpMatch = findWildcardPermission(merged.mcp, toolName);
    if (mcpMatch) {
      return {
        toolName,
        state: mcpMatch.state,
        matchedPattern: mcpMatch.matchedPattern,
        target: mcpMatch.matchedName,
        source: "mcp",
      };
    }

    return {
      toolName,
      state: merged.defaultPolicy.mcp || "deny",
      target: toolName,
      source: "default",
    };
  }
}
