import type { BashPermissions, PermissionState } from "./types.js";

type CompiledPattern = {
  pattern: string;
  state: PermissionState;
  regex: RegExp;
  wildcardCount: number;
  literalLength: number;
};

export interface BashPermissionCheck {
  state: PermissionState;
  matchedPattern?: string;
  command: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compilePattern(pattern: string, state: PermissionState): CompiledPattern {
  const escaped = pattern
    .split("*")
    .map((part) => escapeRegExp(part))
    .join(".*");

  const wildcardCount = (pattern.match(/\*/g) || []).length;
  const literalLength = pattern.replace(/\*/g, "").length;

  return {
    pattern,
    state,
    regex: new RegExp(`^${escaped}$`),
    wildcardCount,
    literalLength,
  };
}

function bySpecificity(a: CompiledPattern, b: CompiledPattern): number {
  if (a.wildcardCount !== b.wildcardCount) {
    return a.wildcardCount - b.wildcardCount;
  }
  if (a.literalLength !== b.literalLength) {
    return b.literalLength - a.literalLength;
  }
  return b.pattern.length - a.pattern.length;
}

export class BashFilter {
  private readonly compiledPatterns: CompiledPattern[];

  constructor(
    private readonly permissions: BashPermissions,
    private readonly defaultState: PermissionState,
  ) {
    this.compiledPatterns = Object.entries(permissions)
      .map(([pattern, state]) => compilePattern(pattern, state))
      .sort(bySpecificity);
  }

  check(command: string): BashPermissionCheck {
    for (const pattern of this.compiledPatterns) {
      if (pattern.regex.test(command)) {
        return {
          state: pattern.state,
          matchedPattern: pattern.pattern,
          command,
        };
      }
    }

    return {
      state: this.defaultState,
      command,
    };
  }
}
