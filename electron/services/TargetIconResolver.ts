import path from "node:path";

const CODEX_BUNDLE_ID = "com.openai.codex";

export function getTargetIconCandidates(
  bundlePath: string,
  bundleId: string | null,
): string[] {
  if (bundleId !== CODEX_BUNDLE_ID) return [];

  const resourcesPath = path.join(bundlePath, "Contents", "Resources");
  return [
    path.join(resourcesPath, "icon-codex-dark-color.png"),
    path.join(resourcesPath, "icon-codex-light.png"),
  ];
}

export function getTargetIconCacheKey(
  bundlePath: string,
  bundleId: string | null,
): string {
  return `${bundleId ?? ""}\0${bundlePath}`;
}
