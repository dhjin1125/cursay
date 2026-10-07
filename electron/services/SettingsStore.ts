import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_SETTINGS,
  POST_EDIT_MODELS,
  POST_EDIT_REASONING_EFFORTS,
  type AppSettings,
  type CommandDefinition,
  type SettingsPatch,
} from "../../shared/contracts.js";

function cloneDefaults(): AppSettings {
  return structuredClone(DEFAULT_SETTINGS);
}

function sanitizeCommand(value: unknown): CommandDefinition | null {
  if (!value || typeof value !== "object") return null;
  const command = value as Partial<CommandDefinition>;
  if (
    typeof command.id !== "string" ||
    typeof command.label !== "string" ||
    !Array.isArray(command.phrases) ||
    command.phrases.some((phrase) => typeof phrase !== "string") ||
    command.action?.type !== "hotkey"
  ) {
    return null;
  }

  const allowedKeys = new Set(["return", "escape", "tab", "space"]);
  const allowedModifiers = new Set(["command", "option", "control", "shift"]);
  if (!allowedKeys.has(command.action.key)) return null;

  return {
    id: command.id.slice(0, 80),
    label: command.label.slice(0, 80),
    phrases: command.phrases.map((phrase) => phrase.slice(0, 160)).filter(Boolean).slice(0, 12),
    match: "exact-segment-or-final",
    consumeTranscript: command.consumeTranscript !== false,
    cooldownMs: Math.max(250, Math.min(60_000, Number(command.cooldownMs) || 1_000)),
    targetBundleIds: Array.isArray(command.targetBundleIds)
      ? command.targetBundleIds.filter((item): item is string => typeof item === "string").slice(0, 16)
      : ["com.openai.codex"],
    action: {
      type: "hotkey",
      key: command.action.key,
      modifiers: Array.isArray(command.action.modifiers)
        ? command.action.modifiers.filter((item) => allowedModifiers.has(item))
        : [],
    },
    enabled: command.enabled !== false,
  };
}

function parseSettings(value: unknown): AppSettings {
  const defaults = cloneDefaults();
  if (!value || typeof value !== "object") return defaults;
  const input = value as Partial<AppSettings>;
  const commands = Array.isArray(input.commands)
    ? input.commands.map(sanitizeCommand).filter((item): item is CommandDefinition => item !== null)
    : defaults.commands;

  return {
    provider: input.provider === "local-whisper" ? "local-whisper" : "codex-stream",
    outputMode: input.outputMode === "scratch" ? "scratch" : "codex",
    targetBundleIds: Array.isArray(input.targetBundleIds)
      ? input.targetBundleIds.filter((item): item is string => typeof item === "string").slice(0, 16)
      : defaults.targetBundleIds,
    silenceDurationMs: Math.max(
      300,
      Math.min(3_000, Number(input.silenceDurationMs) || defaults.silenceDurationMs),
    ),
    persistTranscriptHistory: input.persistTranscriptHistory === true,
    launchAtLogin: input.launchAtLogin === true,
    postEditEnabled: input.postEditEnabled === true,
    postEditModel: POST_EDIT_MODELS.find((model) => model === input.postEditModel) ??
      defaults.postEditModel,
    postEditReasoningEffort: POST_EDIT_REASONING_EFFORTS.find(
      (effort) => effort === input.postEditReasoningEffort,
    ) ?? defaults.postEditReasoningEffort,
    onboardingComplete: input.onboardingComplete === true,
    onboardingStep: Math.max(0, Math.min(4, Math.round(Number(input.onboardingStep) || 0))),
    commands: commands.length > 0 ? commands : defaults.commands,
  };
}

export class SettingsStore {
  private settings: AppSettings = cloneDefaults();

  constructor(private readonly filePath: string) {}

  async load(): Promise<AppSettings> {
    try {
      this.settings = parseSettings(JSON.parse(await readFile(this.filePath, "utf8")));
    } catch {
      this.settings = cloneDefaults();
    }
    return this.get();
  }

  get(): AppSettings {
    return structuredClone(this.settings);
  }

  async patch(patch: SettingsPatch): Promise<AppSettings> {
    this.settings = parseSettings({ ...this.settings, ...patch });
    await this.persist();
    return this.get();
  }

  async updateCommand(command: CommandDefinition): Promise<AppSettings> {
    const safe = sanitizeCommand(command);
    if (!safe) throw new Error("Invalid command definition.");
    const commands = this.settings.commands.filter((item) => item.id !== safe.id);
    commands.push(safe);
    this.settings = { ...this.settings, commands };
    await this.persist();
    return this.get();
  }

  private async persist(): Promise<void> {
    const directory = path.dirname(this.filePath);
    const temporaryPath = `${this.filePath}.tmp`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(temporaryPath, `${JSON.stringify(this.settings, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
  }
}
