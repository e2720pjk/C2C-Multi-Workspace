import path from "node:path";
import { getStateDir, readJsonIfExists } from "./paths.js";

export const LANGUAGES = ["en", "zh-TW"] as const;
export type Language = (typeof LANGUAGES)[number];

/** C2C's language is explicit, never inferred from the OS locale. */
export function readLanguage(): Language {
  const prefs = readJsonIfExists<{ language?: unknown }>(path.join(getStateDir(), "prefs.json"));
  return prefs?.language === "zh-TW" ? "zh-TW" : "en";
}

/** Read on demand so a running bridge also picks up preference changes. */
export function t(english: string, traditionalChinese: string): string {
  return readLanguage() === "zh-TW" ? traditionalChinese : english;
}
