import { isToolCallEventType, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, normalize, resolve, sep } from "node:path";

import { PermissionManager } from "./permission-manager.js";
import { checkRequestedToolRegistration, getToolNameFromValue } from "./tool-registry.js";
import type { PermissionCheckResult, PermissionState } from "./types.js";

const AGENTS_DIR = join(homedir(), ".pi", "agent", "agents");
const ORCHESTRATOR_AGENT_NAME = "orchestrator";
const DELEGATION_TOOL_NAME = "task";
const TOOL_PERMISSION_MAP: Record<string, string> = {
  bash: "bash",
  read: "read",
  write: "write",
  edit: "edit",
  grep: "grep",
  find: "find",
  ls: "ls",
  mcp: "mcp",
  task: "task",
};
const LEGACY_TOOL_ALIASES: Record<string, string> = {};
const DEFAULT_ALLOWED_MAPPED_TOOLS = new Set<string>();

const AVAILABLE_SKILLS_OPEN_TAG = "<available_skills>";
const AVAILABLE_SKILLS_CLOSE_TAG = "</available_skills>";
const SKILL_BLOCK_PATTERN = "<skill>([\\s\\S]*?)<\\/skill>";
const SKILL_NAME_REGEX = /<name>([\s\S]*?)<\/name>/;
const SKILL_DESCRIPTION_REGEX = /<description>([\s\S]*?)<\/description>/;
const SKILL_LOCATION_REGEX = /<location>([\s\S]*?)<\/location>/;
const ACTIVE_AGENT_TAG_REGEX = /<active_agent\s+name=["']([^"']+)["'][^>]*>/i;

type SkillPromptEntry = {
  name: string;
  description: string;
  location: string;
  state: PermissionState;
  normalizedLocation: string;
  normalizedBaseDir: string;
};

type SkillPromptSection = {
  start: number;
  end: number;
  entries: Array<{ name: string; description: string; location: string }>;
};

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function encodeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function normalizePathForComparison(pathValue: string, cwd: string): string {
  const trimmed = pathValue.trim().replace(/^['"]|['"]$/g, "");
  if (!trimmed) {
    return "";
  }

  let normalizedPath = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;

  if (normalizedPath === "~") {
    normalizedPath = homedir();
  } else if (normalizedPath.startsWith("~/") || normalizedPath.startsWith("~\\")) {
    normalizedPath = join(homedir(), normalizedPath.slice(2));
  }

  const absolutePath = resolve(cwd, normalizedPath);
  const normalizedAbsolutePath = normalize(absolutePath);
  return process.platform === "win32" ? normalizedAbsolutePath.toLowerCase() : normalizedAbsolutePath;
}

function isPathWithinDirectory(pathValue: string, directory: string): boolean {
  if (!pathValue || !directory) {
    return false;
  }

  if (pathValue === directory) {
    return true;
  }

  const prefix = directory.endsWith(sep) ? directory : `${directory}${sep}`;
  return pathValue.startsWith(prefix);
}

function parseSkillPromptSection(prompt: string): SkillPromptSection | null {
  const start = prompt.indexOf(AVAILABLE_SKILLS_OPEN_TAG);
  if (start === -1) {
    return null;
  }

  const closeStart = prompt.indexOf(AVAILABLE_SKILLS_CLOSE_TAG, start + AVAILABLE_SKILLS_OPEN_TAG.length);
  if (closeStart === -1) {
    return null;
  }

  const end = closeStart + AVAILABLE_SKILLS_CLOSE_TAG.length;
  const sectionBody = prompt.slice(start + AVAILABLE_SKILLS_OPEN_TAG.length, closeStart);
  const entries: Array<{ name: string; description: string; location: string }> = [];

  const skillBlockRegex = new RegExp(SKILL_BLOCK_PATTERN, "g");
  for (const match of sectionBody.matchAll(skillBlockRegex)) {
    const block = match[1];
    const nameMatch = block.match(SKILL_NAME_REGEX);
    const descriptionMatch = block.match(SKILL_DESCRIPTION_REGEX);
    const locationMatch = block.match(SKILL_LOCATION_REGEX);

    if (!nameMatch || !descriptionMatch || !locationMatch) {
      continue;
    }

    const name = decodeXml(nameMatch[1].trim());
    const description = decodeXml(descriptionMatch[1].trim());
    const location = decodeXml(locationMatch[1].trim());

    if (!name || !location) {
      continue;
    }

    entries.push({ name, description, location });
  }

  return {
    start,
    end,
    entries,
  };
}

function resolveSkillPromptEntries(
  prompt: string,
  permissionManager: PermissionManager,
  agentName: string | null,
  cwd: string,
): { prompt: string; entries: SkillPromptEntry[] } {
  const section = parseSkillPromptSection(prompt);
  if (!section) {
    return { prompt, entries: [] };
  }

  const resolvedEntries: SkillPromptEntry[] = section.entries.map((entry) => {
    const check = permissionManager.checkPermission("skill", { name: entry.name }, agentName ?? undefined);
    const state: PermissionState = agentName ? check.state : "deny";
    return {
      name: entry.name,
      description: entry.description,
      location: entry.location,
      state,
      normalizedLocation: normalizePathForComparison(entry.location, cwd),
      normalizedBaseDir: normalizePathForComparison(dirname(entry.location), cwd),
    };
  });

  const visibleEntries = resolvedEntries.filter((entry) => entry.state !== "deny");
  if (visibleEntries.length === resolvedEntries.length) {
    return { prompt, entries: resolvedEntries };
  }

  const replacement = [
    AVAILABLE_SKILLS_OPEN_TAG,
    ...visibleEntries.flatMap((entry) => [
      "  <skill>",
      `    <name>${encodeXml(entry.name)}</name>`,
      `    <description>${encodeXml(entry.description)}</description>`,
      `    <location>${encodeXml(entry.location)}</location>`,
      "  </skill>",
    ]),
    AVAILABLE_SKILLS_CLOSE_TAG,
  ].join("\n");

  return {
    prompt: `${prompt.slice(0, section.start)}${replacement}${prompt.slice(section.end)}`,
    entries: resolvedEntries,
  };
}

function findSkillPathMatch(normalizedPath: string, entries: readonly SkillPromptEntry[]): SkillPromptEntry | null {
  if (!normalizedPath || entries.length === 0) {
    return null;
  }

  for (const entry of entries) {
    if (entry.normalizedLocation && normalizedPath === entry.normalizedLocation) {
      return entry;
    }
  }

  let bestMatch: SkillPromptEntry | null = null;
  for (const entry of entries) {
    if (!entry.normalizedBaseDir || !isPathWithinDirectory(normalizedPath, entry.normalizedBaseDir)) {
      continue;
    }

    if (!bestMatch || entry.normalizedBaseDir.length > bestMatch.normalizedBaseDir.length) {
      bestMatch = entry;
    }
  }

  return bestMatch;
}

function extractSkillNameFromInput(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/skill:")) {
    return null;
  }

  const afterPrefix = trimmed.slice("/skill:".length);
  if (!afterPrefix) {
    return null;
  }

  const firstWhitespace = afterPrefix.search(/\s/);
  const skillName = (firstWhitespace === -1 ? afterPrefix : afterPrefix.slice(0, firstWhitespace)).trim();
  return skillName || null;
}

function getEventToolName(event: unknown): string | null {
  return getToolNameFromValue(event);
}

function getEventInput(event: unknown): unknown {
  const record = toRecord(event);

  if (record.input !== undefined) {
    return record.input;
  }

  if (record.arguments !== undefined) {
    return record.arguments;
  }

  return {};
}

function isPermissionState(value: unknown): value is PermissionState {
  return value === "allow" || value === "deny" || value === "ask";
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

function loadAgentPermissionFields(agentName?: string): Record<string, PermissionState> {
  if (!agentName) {
    return {};
  }

  const filePath = join(AGENTS_DIR, `${agentName}.md`);
  try {
    const markdown = readFileSync(filePath, "utf-8");
    const frontmatter = extractFrontmatter(markdown);
    if (!frontmatter) {
      return {};
    }

    const parsedFrontmatter = parseSimpleYamlMap(frontmatter);
    const permissionBlock = toRecord(parsedFrontmatter.permission);
    const permissions: Record<string, PermissionState> = {};

    const collectStates = (value: unknown): void => {
      const record = toRecord(value);
      for (const [key, state] of Object.entries(record)) {
        if (isPermissionState(state)) {
          permissions[key] = state;
        }
      }
    };

    collectStates(permissionBlock.tools);
    collectStates(permissionBlock.mcp);
    collectStates(permissionBlock.bash);
    collectStates(permissionBlock.skills);
    collectStates(permissionBlock.special);

    for (const [key, value] of Object.entries(permissionBlock)) {
      if (isPermissionState(value)) {
        permissions[key] = value;
      }
    }

    return permissions;
  } catch {
    return {};
  }
}

function normalizeAgentName(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function getActiveAgentName(ctx: ExtensionContext): string | null {
  const entries = ctx.sessionManager.getEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as { type: string; customType?: string; data?: unknown };
    if (entry.type !== "custom" || entry.customType !== "active_agent") {
      continue;
    }

    const data = entry.data as { name?: unknown } | undefined;
    const normalizedName = normalizeAgentName(data?.name);
    if (normalizedName) {
      return normalizedName;
    }

    if (data?.name === null) {
      return null;
    }
  }

  return null;
}

function getActiveAgentNameFromSystemPrompt(systemPrompt: string | undefined): string | null {
  if (!systemPrompt) {
    return null;
  }

  const match = systemPrompt.match(ACTIVE_AGENT_TAG_REGEX);
  if (!match || !match[1]) {
    return null;
  }

  return normalizeAgentName(match[1]);
}

function isDelegationAllowedAgent(agentName: string | null): boolean {
  return Boolean(agentName && agentName.toLowerCase() === ORCHESTRATOR_AGENT_NAME);
}

function getDelegationBlockReason(agentName: string | null): string {
  const resolvedAgent = agentName ?? "none";
  return `Tool '${DELEGATION_TOOL_NAME}' is restricted to '${ORCHESTRATOR_AGENT_NAME}'. Active agent '${resolvedAgent}' cannot delegate.`;
}

function formatMissingToolNameReason(): string {
  return "Tool call was blocked because no tool name was provided. Use a registered tool name from pi.getAllTools().";
}

function formatUnknownToolReason(toolName: string, availableToolNames: readonly string[]): string {
  const preview = availableToolNames.slice(0, 10);
  const suffix = availableToolNames.length > preview.length ? ", ..." : "";
  const availableList = preview.length > 0 ? `${preview.join(", ")}${suffix}` : "none";

  const mcpHint = toolName === "mcp"
    ? ""
    : " If this was intended as an MCP server tool, call the built-in 'mcp' tool (for example: {\"tool\":\"server:tool\"}).";

  return `Tool '${toolName}' is not registered in this runtime and was blocked before permission checks.${mcpHint} Registered tools: ${availableList}.`;
}

function formatPermissionHardStopHint(result: PermissionCheckResult): string {
  if ((result.source === "mcp" || result.toolName === "mcp") && result.target) {
    return "Hard stop: this MCP permission denial is policy-enforced. Do not retry this target, do not run discovery/investigation to bypass it, and report the block to the user.";
  }

  return "Hard stop: this permission denial is policy-enforced. Do not retry or investigate bypasses; report the block to the user.";
}

function formatDenyReason(result: PermissionCheckResult, agentName?: string): string {
  const parts: string[] = [];

  if (agentName) {
    parts.push(`Agent '${agentName}'`);
  }

  if ((result.source === "mcp" || result.toolName === "mcp") && result.target) {
    parts.push(`is not permitted to run MCP target '${result.target}'`);
  } else {
    parts.push(`is not permitted to run '${result.toolName}'`);
  }

  if (result.command) {
    parts.push(`command '${result.command}'`);
  }

  if (result.matchedPattern) {
    parts.push(`(matched '${result.matchedPattern}')`);
  }

  return `${parts.join(" ")}. ${formatPermissionHardStopHint(result)}`;
}

function formatUserDeniedReason(result: PermissionCheckResult): string {
  const base = (result.source === "mcp" || result.toolName === "mcp") && result.target
    ? `User denied MCP target '${result.target}'.`
    : result.toolName === "bash" && result.command
      ? `User denied bash command '${result.command}'.`
      : `User denied tool '${result.toolName}'.`;

  return `${base} ${formatPermissionHardStopHint(result)}`;
}

function formatAskPrompt(result: PermissionCheckResult, agentName?: string): string {
  const subject = agentName ? `Agent '${agentName}'` : "Current agent";

  if (result.toolName === "bash") {
    const patternInfo = result.matchedPattern ? ` (matched '${result.matchedPattern}')` : "";
    return `${subject} requested bash command '${result.command || ""}'${patternInfo}. Allow this command?`;
  }

  if ((result.source === "mcp" || result.toolName === "mcp") && result.target) {
    const patternInfo = result.matchedPattern ? ` (matched '${result.matchedPattern}')` : "";
    return `${subject} requested MCP target '${result.target}'${patternInfo}. Allow this call?`;
  }

  const patternInfo = result.matchedPattern ? ` (matched '${result.matchedPattern}')` : "";
  return `${subject} requested tool '${result.toolName}'${patternInfo}. Allow this call?`;
}

function formatSkillAskPrompt(skillName: string, agentName?: string): string {
  const subject = agentName ? `Agent '${agentName}'` : "Current agent";
  return `${subject} requested skill '${skillName}'. Allow loading this skill?`;
}

function formatSkillPathAskPrompt(skill: SkillPromptEntry, readPath: string, agentName?: string): string {
  const subject = agentName ? `Agent '${agentName}'` : "Current agent";
  return `${subject} requested access to skill '${skill.name}' via '${readPath}'. Allow this read?`;
}

function formatSkillPathDenyReason(skill: SkillPromptEntry, readPath: string, agentName?: string): string {
  const subject = agentName ? `Agent '${agentName}'` : "Current agent";
  return `${subject} is not permitted to access skill '${skill.name}' via '${readPath}'.`;
}

async function confirmPermission(ctx: ExtensionContext, message: string): Promise<boolean> {
  return ctx.ui.confirm("Permission Required", message);
}

function getMappedPermissionState(toolName: string, permissionFields: Record<string, PermissionState>): PermissionState | undefined {
  const normalizedToolName = LEGACY_TOOL_ALIASES[toolName] || toolName;
  const directState = permissionFields[normalizedToolName];
  if (directState) {
    return directState;
  }

  const permissionKey = TOOL_PERMISSION_MAP[normalizedToolName];
  if (!permissionKey) {
    return undefined;
  }

  const mappedState = permissionFields[permissionKey];
  if (mappedState) {
    return mappedState;
  }

  for (const [legacyToolName, canonicalToolName] of Object.entries(LEGACY_TOOL_ALIASES)) {
    if (canonicalToolName !== normalizedToolName) {
      continue;
    }

    const legacyState = permissionFields[legacyToolName];
    if (legacyState) {
      return legacyState;
    }
  }

  if (DEFAULT_ALLOWED_MAPPED_TOOLS.has(permissionKey)) {
    return "allow";
  }

  return undefined;
}

function createMappedResult(toolName: string, input: unknown, state: PermissionState): PermissionCheckResult {
  const result: PermissionCheckResult = {
    toolName,
    state,
    source: "tool",
  };

  if (toolName === "bash") {
    const command = toRecord(input).command;
    if (typeof command === "string") {
      result.command = command;
    }
  }

  return result;
}

export default function piPermissionSystemExtension(pi: ExtensionAPI): void {
  let permissionManager = new PermissionManager();
  const cachedAgentPermissions = new Map<string, Record<string, PermissionState>>();
  let activeSkillEntries: SkillPromptEntry[] = [];
  let lastKnownActiveAgentName: string | null = null;

  const resolveAgentName = (ctx: ExtensionContext, systemPrompt?: string): string | null => {
    const fromSession = getActiveAgentName(ctx);
    if (fromSession) {
      lastKnownActiveAgentName = fromSession;
      return fromSession;
    }

    const fromSystemPrompt = getActiveAgentNameFromSystemPrompt(systemPrompt);
    if (fromSystemPrompt) {
      lastKnownActiveAgentName = fromSystemPrompt;
      return fromSystemPrompt;
    }

    return lastKnownActiveAgentName;
  };

  const getAgentPermissionFields = (agentName: string | null): Record<string, PermissionState> => {
    if (!agentName) {
      return {};
    }

    const cached = cachedAgentPermissions.get(agentName);
    if (cached) {
      return cached;
    }

    const loaded = loadAgentPermissionFields(agentName);
    cachedAgentPermissions.set(agentName, loaded);
    return loaded;
  };

  const shouldExposeTool = (toolName: string, agentName: string | null): boolean => {
    if (toolName === DELEGATION_TOOL_NAME && !isDelegationAllowedAgent(agentName)) {
      return false;
    }

    const permissionFields = getAgentPermissionFields(agentName);
    const mappedState = getMappedPermissionState(toolName, permissionFields);
    if (mappedState) {
      return mappedState !== "deny";
    }

    const check = permissionManager.checkPermission(toolName, {}, agentName ?? undefined);
    return check.state !== "deny";
  };

  pi.on("session_start", async (_event, ctx) => {
    permissionManager = new PermissionManager();
    cachedAgentPermissions.clear();
    activeSkillEntries = [];
    lastKnownActiveAgentName = getActiveAgentName(ctx);
  });

  pi.on("session_switch", async (_event, ctx) => {
    activeSkillEntries = [];
    lastKnownActiveAgentName = getActiveAgentName(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const agentName = resolveAgentName(ctx, event.systemPrompt);
    const allTools = pi.getAllTools();
    const allowedTools: string[] = [];

    for (const tool of allTools) {
      const toolName = getEventToolName(tool);
      if (!toolName) {
        continue;
      }

      if (shouldExposeTool(toolName, agentName)) {
        allowedTools.push(toolName);
      }
    }

    pi.setActiveTools(allowedTools);

    const skillPromptResult = resolveSkillPromptEntries(event.systemPrompt, permissionManager, agentName, ctx.cwd);
    activeSkillEntries = skillPromptResult.entries;

    if (skillPromptResult.prompt !== event.systemPrompt) {
      return { systemPrompt: skillPromptResult.prompt };
    }

    return {};
  });

  pi.on("input", async (event, ctx) => {
    const skillName = extractSkillNameFromInput(event.text);
    if (!skillName) {
      return { action: "continue" };
    }

    const agentName = resolveAgentName(ctx);

    if (!agentName) {
      if (ctx.hasUI) {
        ctx.ui.notify(`Skill '${skillName}' is blocked because active agent context is unavailable.`, "warning");
      }
      return { action: "handled" };
    }

    const check = permissionManager.checkPermission("skill", { name: skillName }, agentName ?? undefined);

    if (check.state === "deny") {
      if (ctx.hasUI) {
        const resolvedAgent = agentName ?? "none";
        ctx.ui.notify(`Skill '${skillName}' is not permitted for agent '${resolvedAgent}'.`, "warning");
      }
      return { action: "handled" };
    }

    if (check.state === "ask") {
      if (!ctx.hasUI) {
        return { action: "handled" };
      }

      const approved = await confirmPermission(ctx, formatSkillAskPrompt(skillName, agentName ?? undefined));
      if (!approved) {
        return { action: "handled" };
      }
    }

    return { action: "continue" };
  });

  pi.on("tool_call", async (event, ctx) => {
    const agentName = resolveAgentName(ctx);
    const permissionFields = getAgentPermissionFields(agentName);
    const toolName = getEventToolName(event);

    if (!toolName) {
      return { block: true, reason: formatMissingToolNameReason() };
    }

    const registrationCheck = checkRequestedToolRegistration(toolName, pi.getAllTools(), LEGACY_TOOL_ALIASES);
    if (registrationCheck.status === "missing-tool-name") {
      return { block: true, reason: formatMissingToolNameReason() };
    }

    if (registrationCheck.status === "unregistered") {
      return {
        block: true,
        reason: formatUnknownToolReason(registrationCheck.requestedToolName, registrationCheck.availableToolNames),
      };
    }

    if (toolName === DELEGATION_TOOL_NAME && !isDelegationAllowedAgent(agentName)) {
      return { block: true, reason: getDelegationBlockReason(agentName) };
    }

    if (isToolCallEventType("read", event) && activeSkillEntries.length > 0) {
      const normalizedReadPath = normalizePathForComparison(event.input.path, ctx.cwd);
      const matchedSkill = findSkillPathMatch(normalizedReadPath, activeSkillEntries);

      if (matchedSkill) {
        if (matchedSkill.state === "deny") {
          return {
            block: true,
            reason: formatSkillPathDenyReason(matchedSkill, event.input.path, agentName ?? undefined),
          };
        }

        if (matchedSkill.state === "ask") {
          if (!ctx.hasUI) {
            return {
              block: true,
              reason: `Accessing skill '${matchedSkill.name}' requires approval, but no interactive UI is available.`,
            };
          }

          const approved = await confirmPermission(
            ctx,
            formatSkillPathAskPrompt(matchedSkill, event.input.path, agentName ?? undefined),
          );
          if (!approved) {
            return { block: true, reason: `User denied access to skill '${matchedSkill.name}'.` };
          }
        }
      }
    }

    if (isToolCallEventType("bash", event)) {
      const command = event.input.command;
      const mappedBashState = getMappedPermissionState("bash", permissionFields);
      let mappedAskApproved = false;

      if (mappedBashState) {
        const mappedCheck = createMappedResult("bash", { command }, mappedBashState);

        if (mappedCheck.state === "deny") {
          return { block: true, reason: formatDenyReason(mappedCheck, agentName ?? undefined) };
        }

        if (mappedCheck.state === "ask") {
          const approved = await confirmPermission(ctx, formatAskPrompt(mappedCheck, agentName ?? undefined));
          if (!approved) {
            return { block: true, reason: formatUserDeniedReason(mappedCheck) };
          }
          mappedAskApproved = true;
        }
      }

      const check = permissionManager.checkPermission("bash", { command }, agentName ?? undefined);

      if (check.state === "deny") {
        return { block: true, reason: formatDenyReason(check, agentName ?? undefined) };
      }

      if (check.state === "ask") {
        if (mappedAskApproved || mappedBashState === "allow") {
          return {};
        }

        const approved = await confirmPermission(ctx, formatAskPrompt(check, agentName ?? undefined));
        if (!approved) {
          return { block: true, reason: formatUserDeniedReason(check) };
        }
      }

      return {};
    }

    const mappedState = getMappedPermissionState(toolName, permissionFields);
    if (mappedState) {
      const mappedCheck = createMappedResult(toolName, getEventInput(event), mappedState);

      if (mappedCheck.state === "deny") {
        return { block: true, reason: formatDenyReason(mappedCheck, agentName ?? undefined) };
      }

      if (mappedCheck.state === "ask") {
        const approved = await confirmPermission(ctx, formatAskPrompt(mappedCheck, agentName ?? undefined));
        if (!approved) {
          return { block: true, reason: formatUserDeniedReason(mappedCheck) };
        }
      }

      return {};
    }

    const check = permissionManager.checkPermission(toolName, getEventInput(event), agentName ?? undefined);

    if (check.state === "deny") {
      return { block: true, reason: formatDenyReason(check, agentName ?? undefined) };
    }

    if (check.state === "ask") {
      const approved = await confirmPermission(ctx, formatAskPrompt(check, agentName ?? undefined));
      if (!approved) {
        return { block: true, reason: formatUserDeniedReason(check) };
      }
    }

    return {};
  });
}
