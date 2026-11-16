// FILE: skillPromptInjection.ts
// Purpose: Inlines portable skill instructions into the outgoing prompt for providers
//          that cannot natively load the referenced skill files. This is the fallback
//          that makes Saint catalog skills usable on every provider.
// Layer: Server provider helper
// Exports: shouldInlineSkillForProvider, buildInlineSkillInstructions

import * as fs from "node:fs/promises";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";

import type { ProviderKind, ProviderSkillReference } from "@saint/contracts";
import { isWorkspaceRootWithin } from "@saint/shared/threadWorkspace";

// Per-skill cap keeps a single oversized SKILL.md from eating the turn budget.
const MAX_INLINE_SKILL_CONTENT_CHARS = 24_000;

const INLINE_SKILLS_HEADER =
  "The user invoked the following agent skill(s) for this request. Follow each " +
  "skill's instructions. File paths referenced inside a skill are relative to its " +
  '"dir" attribute.';

const CROSS_PROVIDER_SKILL_DIR_NAMES = [
  ".saint",
  ".codex",
  ".cursor",
  ".claude",
  ".agents",
] as const;

function pathSegments(path: string): Set<string> {
  return new Set(
    nodePath
      .normalize(path)
      .split(/[\\/]+/)
      .map((segment) => segment.toLowerCase()),
  );
}

export interface ShouldInlineSkillOptions {
  readonly workspaceCwd?: string | undefined;
  readonly homeDir?: string | undefined;
}

export function shouldInlineSkillForProvider(
  provider: ProviderKind,
  skillPath: string,
  options?: ShouldInlineSkillOptions,
): boolean {
  const segments = pathSegments(skillPath);
  switch (provider) {
    case "antigravity": {
      if (!(segments.has(".agents") || segments.has("_agents"))) {
        return true;
      }
      // `agy` loads workspace `<workspace>/.agents` and `<workspace>/_agents`
      // natively, but does not load home `~/.agents/skills`.
      const homeDir = options?.homeDir ?? nodeOs.homedir();
      if (
        isWorkspaceRootWithin(skillPath, nodePath.join(homeDir, ".agents")) ||
        isWorkspaceRootWithin(skillPath, nodePath.join(homeDir, "_agents"))
      ) {
        return true;
      }
      if (options?.workspaceCwd) {
        return !(
          isWorkspaceRootWithin(skillPath, nodePath.join(options.workspaceCwd, ".agents")) ||
          isWorkspaceRootWithin(skillPath, nodePath.join(options.workspaceCwd, "_agents"))
        );
      }
      // Without a known workspace, inline so the skill is never silently dropped.
      return true;
    }
    case "codex":
      // Codex loads .codex and .agents skills natively, plus ~/.saint/skills
      // registered via skills/extraRoots/set. Only foreign provider roots
      // need inline instructions alongside their structured skill reference.
      return [".claude", ".cursor"].some((dir) => segments.has(dir));
    case "cursor":
      // cursor-agent natively scans .cursor/.agents/.claude/.codex skill roots;
      // only Saint-owned paths need inlining.
      return segments.has(".saint");
    case "claudeAgent":
      // Claude Code only loads skills from .claude/skills folders.
      return !segments.has(".claude");
    case "devin":
      return !(
        [".agents", ".claude", ".codeium", ".cognition", ".devin", ".windsurf"].some((dir) =>
          segments.has(dir),
        ) ||
        ((segments.has(".config") || (segments.has("appdata") && segments.has("roaming"))) &&
          (segments.has("devin") || segments.has("cognition")))
      );
    case "pi":
      // Pi loads its own skill set; anything resolved from a cross-provider
      // folder is portable and must be inlined.
      return CROSS_PROVIDER_SKILL_DIR_NAMES.some((dir) => segments.has(dir));
    default:
      // Grok/Droid/OpenCode have no native skill support.
      return true;
  }
}

export async function buildInlineSkillInstructions(input: {
  readonly provider: ProviderKind;
  readonly skills: ReadonlyArray<ProviderSkillReference>;
  readonly maxChars: number;
  readonly workspaceCwd?: string | undefined;
  readonly homeDir?: string | undefined;
}): Promise<string> {
  const inlineSkills = input.skills.filter((skill) =>
    shouldInlineSkillForProvider(input.provider, skill.path, {
      workspaceCwd: input.workspaceCwd,
      homeDir: input.homeDir,
    }),
  );
  if (inlineSkills.length === 0 || input.maxChars <= 0) {
    return "";
  }

  let text = "";
  for (const skill of inlineSkills) {
    let content: string;
    try {
      content = await fs.readFile(skill.path, "utf8");
    } catch {
      continue;
    }
    let trimmed = content.trim();
    if (trimmed.length > MAX_INLINE_SKILL_CONTENT_CHARS) {
      trimmed = `${trimmed.slice(0, MAX_INLINE_SKILL_CONTENT_CHARS)}\n[skill content truncated]`;
    }
    const block = `<skill name=${JSON.stringify(skill.name)} dir=${JSON.stringify(
      nodePath.dirname(skill.path),
    )}>\n${trimmed}\n</skill>`;
    const candidate =
      text.length === 0 ? `${INLINE_SKILLS_HEADER}\n\n${block}` : `${text}\n\n${block}`;
    if (candidate.length > input.maxChars) {
      // Keep whatever already fits instead of overflowing the provider turn budget.
      break;
    }
    text = candidate;
  }
  return text;
}
