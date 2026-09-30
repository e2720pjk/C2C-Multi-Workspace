# C2C Multi-Workspace

[English（完整使用说明）](README.md) | 简体中文摘要

C2C 是连接 ChatGPT 与本地工作区的 CLI。ChatGPT 通过只读 MCP 读取代码、规划和
审查；编码 Agent 保留修改文件、执行 shell、git 和测试的权限。
一个安装共用一个 Bridge、连接器和连接，支持多个仓库或 worktree。
Skill 是可选调用方，不再是产品的主要入口。

## 安装与默认连接

需要 Node.js 20+、pnpm 和 Git：

```bash
pnpm install
pnpm build
pnpm install -g .
```

新安装默认推荐 **OpenAI Secure Tunnel**，用于持续的 ChatGPT MCP 连接。
以 macOS 为例：

```bash
brew install openai/tools/tunnel-client
export CONTROL_PLANE_TUNNEL_ID=tunnel_...
export CONTROL_PLANE_API_KEY=...
c2c setup
```

需要在 C2C 之外获得已有 Tunnel ID 和 Runtime API Key。密钥只放在本地运行环境，
不要写入命令参数、仓库或聊天。C2C 不创建／删除 Tunnel，也不需要 `OPENAI_ADMIN_KEY`。

在 ChatGPT 添加一个连接器：**Connection = Tunnel / Authentication = No authentication**。
C2C 与本地 tunnel-client 之间仍有进程级 bearer 授权。缺少配置会报错，
不会自动改用 Pairing。`setup --no-tunnel` 仅用于本地开发。

## 手动切换到 Pairing

旧的 Cloudflare + OAuth 配对方式需要明确选择：

```bash
brew install cloudflared
c2c connection use pairing
c2c setup
# ChatGPT 使用输出的 HTTPS MCP 地址，Authentication = OAuth。
# 仅在授权表单已打开时生成配对码：
c2c pair
```

固定 Cloudflare 域名可用：

```bash
c2c connection use pairing --transport named --zone example.com
```

固定域名配置失败时保留原有设置，不会自动切到临时地址。
准备好 Secure 所需环境后，运行 `c2c connection use secure`，再运行 `c2c setup`。
切换方式后可能需要更新 ChatGPT 的连接器地址与认证设置。
已有明确保存的 quick、named、openai 设置会保留。

## 日常 CLI

```bash
c2c start                         # 默认建立已选连接
c2c connection status
c2c doctor
c2c workspace add                 # 当前目录，不需要 -w
c2c workspace add /path/to/repo --alias main
c2c workspace list
c2c workspace set-default main
c2c restart
c2c stop                          # 停止整个安装，影响所有工作区
```

注册或选择另一个工作区不会重建连接器或连接。`pair`／`unpair` 仅限 Pairing 模式；
`unpair` 撤销所有已注册工作区的 OAuth 访问，不只影响当前目录。
本地开发可以使用 `start --no-tunnel` 或 `restart --no-tunnel`。

## 语言

CLI 默认始终为英文，不根据操作系统语言自动显示简体中文：

```bash
c2c prefs set --language en
c2c prefs set --language zh-TW     # 明确选择繁体中文
```

目前 CLI 支持 en 和 zh-TW；文档语言与 CLI 输出语言独立。
JSON 字段、选项名称与错误代码保持稳定，用户内容和第三方诊断不翻译。
旧的 `workspace add -w <path>` 与 `tunnel choose --mode ...` 仍兼容，但不再推荐。

[CLI 流程图](docs/cli-workflows.html) · [架构](docs/architecture.md) ·
[多工作区](docs/multi-workspace.md) · [安全](docs/security.md) ·
[故障排查](docs/troubleshooting.md)

实际 Secure Tunnel 端到端连接仍需有效的外部 Tunnel、Runtime API Key 和官方客户端；
本地模拟进程测试不能证明真实 OpenAI 控制面的连接可用性。

非官方社区项目，与 OpenAI 无关联，未获其背书。许可证：[MIT](LICENSE)。
