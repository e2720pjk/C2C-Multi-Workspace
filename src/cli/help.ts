import type { Command } from "commander";
import { readLanguage } from "../config/language.js";

const traditionalChinese: Record<string, string> = {
  "output the version number": "顯示版本號碼",
  "display help for command": "顯示指令說明",
  "Start (or reuse) the installation bridge and register this workspace": "啟動或重用安裝級 Bridge，並註冊此工作區",
  "workspace root (defaults to current directory)": "工作區根目錄（預設為目前目錄）",
  "local-only bridge (development)": "僅啟動本機 Bridge（開發用途）",
  "machine-readable output": "輸出機器可讀的 JSON",
  "Prepare this workspace and the selected connection (Secure Tunnel by default)": "準備此工作區與選定的連線（預設為 Secure Tunnel）",
  "local-only setup (development)": "僅設定本機 Bridge（開發用途）",
  "Stop the installation bridge and its connection (all workspaces)": "停止安裝級 Bridge 與連線（影響所有工作區）",
  "Restart the installation bridge": "重新啟動安裝級 Bridge",
  "restart as a local-only bridge (development)": "重新啟動為僅供本機使用的 Bridge（開發用途）",
  "Show installation bridge status": "顯示安裝級 Bridge 狀態",
  "Diagnose and auto-repair the connection": "診斷並自動修復連線",
  "diagnose only, do not repair": "僅診斷，不修復",
  "Generate a one-time code (Pairing mode only; all workspaces)": "產生一次性配對碼（僅限 Pairing 模式；涵蓋所有工作區）",
  "Revoke Pairing access for ALL registered workspaces": "撤銷所有已註冊工作區的配對存取權",
  "Show recent bridge logs": "顯示近期 Bridge 日誌",
  "number of lines": "顯示行數",
  "include debug detail": "包含除錯資訊",
  "Manage registered workspaces or show the current workspace": "管理已註冊工作區，或顯示目前工作區",
  "List registered workspaces without exposing local roots": "列出已註冊工作區（不公開本機根目錄）",
  "Register a workspace (defaults to the current directory)": "註冊工作區（預設為目前目錄）",
  "workspace root": "工作區根目錄",
  "human-readable workspace alias": "便於辨識的工作區別名",
  "workspace id or alias": "工作區 ID 或別名",
  "Enable a registered workspace": "啟用已註冊工作區",
  "Disable a registered workspace": "停用已註冊工作區",
  "Remove a workspace from this installation": "從此安裝移除工作區",
  "Choose the default workspace": "選擇預設工作區",
  "Add the local settings directory to the Codex sandbox allowlist": "將本機設定目錄加入 Codex 沙箱允許清單",
  "Check GitHub for a newer version (real check at most once per local day)": "檢查 GitHub 更新（每個本機日期最多實際查詢一次）",
  "check even if already checked today": "即使今天已查詢，仍重新檢查",
  "Remember the ChatGPT Project and conversation for this workspace": "記住此工作區的 ChatGPT Project 與對話",
  "Show the saved ChatGPT conversation / Project for this workspace": "顯示此工作區已儲存的 ChatGPT 對話與 Project",
  "Save the ChatGPT Project and/or conversation for this workspace": "儲存此工作區的 ChatGPT Project 或對話",
  "ChatGPT conversation URL from the address bar": "瀏覽器位址列中的 ChatGPT 對話網址",
  "last protocol state, e.g. EXECUTED": "最近的協定狀態，例如 EXECUTED",
  "long-chat or project": "long-chat 或 project",
  "ChatGPT Project collection URL (…/g/g-p-…/project)": "ChatGPT Project 網址（…/g/g-p-…/project）",
  "exact connector title for this workspace": "此工作區使用的完整連接器名稱",
  "checkpoint protocol state, e.g. EXECUTED_SENT": "檢查點協定狀態，例如 EXECUTED_SENT",
  "original task goal for resume / HANDOFF": "用於恢復任務或 HANDOFF 的原始目標",
  "drop the active checkpoint (task DONE)": "清除目前檢查點（任務 DONE）",
  "Forget the current ChatGPT chat (Project binding is kept)": "清除目前 ChatGPT 聊天（保留 Project 綁定）",
  "Manage this installation's language and ChatGPT setup preferences": "管理此安裝的語言與 ChatGPT 設定偏好",
  "Show remembered ChatGPT setup choices (not per workspace)": "顯示已儲存的 ChatGPT 設定偏好（非工作區層級）",
  "Save a ChatGPT setup choice for this machine": "儲存此電腦的 ChatGPT 設定偏好",
  "remember that ChatGPT developer mode is on": "記住 ChatGPT 開發人員模式已啟用",
  "auto (preview) or manual": "auto（預覽版）或 manual",
  "en (default) or zh-TW; never inferred from OS locale": "en（預設）或 zh-TW；不依作業系統語系自動選擇",
  "Manage the installation's Secure Tunnel or Pairing profile": "管理安裝級 Secure Tunnel 或 Pairing 連線設定檔",
  "Show the selected connection profile and missing configuration": "顯示選定的連線設定檔與缺少的設定",
  "preview a Pairing named hostname": "預覽 Pairing 固定網域的主機名稱",
  "Sign in to Cloudflare (Pairing mode only)": "登入 Cloudflare（僅限 Pairing 模式）",
  "Select Secure Tunnel (recommended) or explicitly opt in to Pairing": "選擇 Secure Tunnel（建議），或明確切換至 Pairing",
  "secure or pairing": "secure 或 pairing",
  "Pairing only: quick (default) or named": "僅限 Pairing：quick（預設）或 named",
  "Cloudflare domain for a named hostname": "固定主機名稱所用的 Cloudflare 網域",
  "override the installation's named hostname": "指定此安裝的固定主機名稱",
};

/** Translate Commander descriptions without altering option names or JSON contracts. */
export function localizeHelp(command: Command): void {
  if (readLanguage() !== "zh-TW") return;
  command.description(traditionalChinese[command.description()] ?? command.description());
  command.helpOption("-h, --help", "顯示指令說明");
  if (command.commands.length > 0) command.helpCommand("help [command]", "顯示指令說明");
  for (const option of command.options) option.description = traditionalChinese[option.description] ?? option.description;
  for (const argument of command.registeredArguments) argument.description = traditionalChinese[argument.description] ?? argument.description;
  for (const child of command.commands) localizeHelp(child);
}
