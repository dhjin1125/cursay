import type { CommandDefinition } from "./contracts.js";

export interface CommandMatch {
  command: CommandDefinition;
  normalizedPhrase: string;
}

export function normalizeCommandText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("ko-KR")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export class CommandRouter {
  private readonly lastRun = new Map<string, number>();

  route(
    text: string,
    commands: CommandDefinition[],
    now = Date.now(),
  ): CommandMatch | null {
    const normalized = normalizeCommandText(text);
    if (!normalized) return null;

    for (const command of commands) {
      if (!command.enabled) continue;
      const matches = command.phrases.some(
        (phrase) => normalizeCommandText(phrase) === normalized,
      );
      if (!matches) continue;

      const previous = this.lastRun.get(command.id) ?? 0;
      if (now - previous < command.cooldownMs) return null;
      this.lastRun.set(command.id, now);
      return { command, normalizedPhrase: normalized };
    }

    return null;
  }

  reset(): void {
    this.lastRun.clear();
  }
}
