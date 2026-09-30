# C2C Multi-Workspace

[English（完整使用說明）](README.md) | 繁體中文摘要

C2C 是連接 ChatGPT 與本機工作區的 CLI。ChatGPT 透過唯讀 MCP 讀取程式碼、規劃與審查；編碼 Agent 保留修改檔案、執行 shell、git 與測試的權限。一個安裝共用一個 Bridge、連接器與連線，可支援多個儲存庫或 worktree。Skill 是可選的呼叫方，不再是產品的主要入口。

## 安裝與預設連線

需要 Node.js 20+、pnpm 和 Git：

```bash
pnpm install
pnpm build
pnpm install -g .
```

新安裝預設推薦 **OpenAI Secure Tunnel**，用於持續的 ChatGPT MCP 連線。以 macOS 為例：

```bash
brew install openai/tools/tunnel-client
export CONTROL_PLANE_TUNNEL_ID=tunnel_...
export CONTROL_PLANE_API_KEY=...
c2c setup
```

請在 C2C 之外準備憑證：

1. 在 [OpenAI API Tunnels](https://platform.openai.com/settings/organization/tunnels) 建立或選取 Tunnel，並將其 ID 設定為 `CONTROL_PLANE_TUNNEL_ID`。
2. 在 [OpenAI API keys](https://platform.openai.com/settings/organization/api-keys) 建立或選取執行階段金鑰，並將其設定為 `CONTROL_PLANE_API_KEY`。

金鑰只放在本機執行環境，不要寫入命令列參數、儲存庫或聊天。C2C 會執行官方用戶端，但不會建立或刪除 Tunnel 資源，也不需要 `OPENAI_ADMIN_KEY`。

在 ChatGPT 新增一個連接器：**Connection = Tunnel / Authentication = No authentication**。C2C 與本機 tunnel-client 之間仍有程序層級的 bearer 授權。設定缺漏時會顯示錯誤，不會自動改用 Pairing。`setup --no-tunnel` 僅用於本機開發。

## 手動切換至 Pairing

舊版 Cloudflare + OAuth 配對方式需要明確選取：

```bash
brew install cloudflared
c2c connection use pairing
c2c setup
# ChatGPT 使用輸出的 HTTPS MCP 位址，Authentication = OAuth。
# 僅在授權表單已開啟時產生配對碼：
c2c pair
```

固定 Cloudflare 網域可使用：

```bash
c2c connection use pairing --transport named --zone example.com
```

固定網域設定失敗時會保留原有設定，不會自動切換到臨時網址。準備好 Secure 所需環境後，執行 `c2c connection use secure`，再執行 `c2c setup`。切換連線方式後，可能需要更新 ChatGPT 連接器的位址與驗證設定。已明確儲存的 quick、named、openai 設定會保留。

## 日常 CLI

```bash
c2c start                         # 預設建立已選取的連線
c2c connection status
c2c doctor
c2c workspace add                 # 目前目錄，不需要 -w
c2c workspace add /path/to/repo --alias main
c2c workspace list
c2c workspace set-default main
c2c restart
c2c stop                          # 停止整個安裝，影響所有工作區
```

註冊或選取其他工作區不會重建連接器或連線。`pair`／`unpair` 僅適用於 Pairing 模式；`unpair` 會撤銷所有已註冊工作區的 OAuth 存取權，不只影響目前目錄。本機開發可使用 `start --no-tunnel` 或 `restart --no-tunnel`。

## 語言

CLI 預設一律使用英文，不會依作業系統語系自動切換：

```bash
c2c prefs set --language en
c2c prefs set --language zh-TW     # 明確選取繁體中文
```

目前 CLI 僅支援 `en` 和 `zh-TW`；不支援簡體中文。文件語言與 CLI 輸出語言彼此獨立。JSON 欄位、選項名稱與錯誤代碼維持穩定；使用者內容和第三方診斷不會翻譯。舊版 `workspace add -w <path>` 與 `tunnel choose --mode ...` 仍可使用，但不再建議使用。

[CLI 流程圖](docs/cli-workflows.html) · [架構](docs/architecture.md) ·
[多工作區](docs/multi-workspace.md) · [安全性](docs/security.md) ·
[疑難排解](docs/troubleshooting.md)

實際 Secure Tunnel 端對端連線仍需要有效的外部 Tunnel、Runtime API Key 與官方用戶端；本機模擬程序測試無法證明真實 OpenAI 控制平面的連線可用性。

本專案為非官方社群專案，與 OpenAI 無關，亦未獲其背書。授權條款：[MIT](LICENSE)。
