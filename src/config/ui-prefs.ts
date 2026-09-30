import path from "node:path";
import { getStateDir, readJsonIfExists, writeSecureJson } from "./paths.js";
import { LANGUAGES, t, type Language } from "./language.js";

export type SetupMode = "auto" | "manual";

export const SETUP_MODES: readonly SetupMode[] = ["auto", "manual"];

/** Shown once, before the first ChatGPT connection on this machine. */
export const SETUP_CHOICE_PROMPT = [
  "Choose how to configure ChatGPT once on this machine:",
  "",
  "1. AI-assisted setup (preview)",
  "An agent configures ChatGPT in the browser. You handle login, CAPTCHA, and confirmations.",
  "If the same setup step fails twice, switch to guided manual setup.",
  "",
  "2. Guided manual setup",
  "Follow step-by-step instructions and configure ChatGPT yourself.",
  "",
  "Reply with 1 or 2 before an agent starts browser setup.",
].join("\n");

interface StoredUiPrefs {
  developerModeEnabled?: boolean;
  setupMode?: SetupMode;
  language?: Language;
  updatedAt: string;
}

export interface UiPrefsView {
  language: Language;
  developerModeEnabled: boolean;
  setupMode: SetupMode | null;
  setupChoicePrompt: string;
  remembered: {
    developerMode: boolean;
    setupMode: boolean;
  };
}

export function prefsFile(): string {
  return path.join(getStateDir(), "prefs.json");
}

function readStored(): StoredUiPrefs | null {
  const raw = readJsonIfExists<StoredUiPrefs>(prefsFile());
  if (!raw || typeof raw !== "object") return null;
  const setupMode = raw.setupMode === "auto" || raw.setupMode === "manual" ? raw.setupMode : undefined;
  return {
    developerModeEnabled: raw.developerModeEnabled === true,
    setupMode,
    language: raw.language === "en" || raw.language === "zh-TW" ? raw.language : undefined,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
  };
}

export function readUiPrefs(): UiPrefsView {
  const stored = readStored();
  const developerModeEnabled = stored?.developerModeEnabled === true;
  const setupMode = stored?.setupMode ?? null;
  return {
    language: stored?.language ?? "en",
    developerModeEnabled,
    setupMode,
    setupChoicePrompt: t(SETUP_CHOICE_PROMPT, [
      "請選擇此電腦的 ChatGPT 設定方式（只需選擇一次）：",
      "",
      "1. AI 協助設定（預覽版）",
      "Agent 在瀏覽器完成設定；登入、驗證碼與確認步驟由你處理。",
      "相同設定步驟失敗兩次後，改用手動教學設定。",
      "",
      "2. 手動教學設定",
      "依照逐步指引，自行完成 ChatGPT 設定。",
      "",
      "請回覆 1 或 2，再讓 Agent 開始瀏覽器設定。",
    ].join("\n")),
    remembered: {
      developerMode: developerModeEnabled,
      setupMode: setupMode !== null,
    },
  };
}

export interface UiPrefsPatch {
  language?: Language;
  developerModeEnabled?: true;
  setupMode?: SetupMode;
}

export function mergeUiPrefs(patch: UiPrefsPatch): UiPrefsView {
  if (patch.setupMode !== undefined && !SETUP_MODES.includes(patch.setupMode)) {
    throw new Error(`setup-mode must be one of ${SETUP_MODES.join(", ")}`);
  }
  if (patch.language !== undefined && !LANGUAGES.includes(patch.language)) {
    throw new Error(`language must be one of ${LANGUAGES.join(", ")}`);
  }
  const previous = readStored();
  const setupMode = patch.setupMode ?? previous?.setupMode;
  const stored: StoredUiPrefs = {
    updatedAt: new Date().toISOString(),
  };
  // Only persist "confirmed on". Never write false — that would skip the
  // Security page on a new ChatGPT account or a machine restore.
  if (patch.developerModeEnabled === true || previous?.developerModeEnabled === true) {
    stored.developerModeEnabled = true;
  }
  if (setupMode) stored.setupMode = setupMode;
  const language = patch.language ?? previous?.language;
  if (language) stored.language = language;
  writeSecureJson(prefsFile(), stored);
  return readUiPrefs();
}
