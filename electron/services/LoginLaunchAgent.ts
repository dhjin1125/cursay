import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const LABEL = "local.minkyu.CodexVoiceControl";

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export class LoginLaunchAgent {
  private readonly plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);

  async isEnabled(): Promise<boolean> {
    try {
      const contents = await readFile(this.plistPath, "utf8");
      return contents.includes(`<string>${LABEL}</string>`);
    } catch {
      return false;
    }
  }

  async setEnabled(enabled: boolean, appBundlePath: string): Promise<void> {
    if (!enabled) {
      try {
        await unlink(this.plistPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      return;
    }

    if (!appBundlePath.endsWith(".app")) {
      throw new Error("Launch at login is available only in the packaged app.");
    }

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/open</string>
    <string>-gj</string>
    <string>${escapeXml(appBundlePath)}</string>
    <string>--args</string>
    <string>--launched-at-login</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;
    const temporaryPath = `${this.plistPath}.tmp`;
    await mkdir(path.dirname(this.plistPath), { recursive: true, mode: 0o700 });
    await writeFile(temporaryPath, xml, { encoding: "utf8", mode: 0o644 });
    await rename(temporaryPath, this.plistPath);
  }
}
