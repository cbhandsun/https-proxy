# WorkBuddy 官方登录说明

本文档记录 WorkBuddy / CodeBuddy 官方登录凭证与模型路由的实现机制。

## 核心机制

WorkBuddy 在设计上采用与 **Codex** 相同的模式（直接读取本地 JWT 凭证，无需依赖 Electron GUI 运行）：

1. **凭证来源**：
   - 本地凭证文件路径：
     `%LOCALAPPDATA%/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info`
   - 文件结构包含：
     - `auth.accessToken`：标准 OAuth2 JWT Bearer Token（以 `eyJ...` 开头）
     - `auth.refreshToken`：刷新令牌
     - `auth.domain`：服务域名（如 `www.workbuddy.cn` / `copilot.tencent.com`）
     - `account.uid` / `account.uin`：用户唯一标识与 QQ/UIN
     - `auth.expiresAt`：凭证到期时间戳

2. **模型发现（Model Discovery）**：
   - 读取路径：`%LOCALAPPDATA%/Programs/WorkBuddy/resources/app.asar.unpacked/cli/product.json`
   - 官方模型目录：
     - `deepseek-v4.1-flash`（独家优惠高性价比模型，1M 上下文）
     - `deepseek-v4-pro`（百万长上下文旗舰模型）
     - `deepseek-v4-flash`
     - `deepseek-v3.2`
     - `minimax-m3`（MiniMax M3 原生多模态模型）
     - `minimax-m2.7`
     - `glm-5.3` / `glm-5.3-flash`
     - `glm-5.2` / `glm-5.1` / `glm-5.0` / `glm-5v-turbo`
     - `kimi-k2.6` / `kimi-k2.5`
     - `hy4-preview` / `hunyuan-2.0-thinking`

3. **代理配置（Proxy Configuration）**：
   - 配置文件 ID：`workbuddy-official`
   - 协议：`workbuddy`
   - 认证模式：`official-login`
   - 目标地址：`https://copilot.tencent.com/v2`

4. **内置模型路由（Built-in Model Routes）**：
   - `workbuddy/deepseek-v4.1-flash` -> `deepseek-v4.1-flash`
   - `workbuddy/deepseek-v4-pro` -> `deepseek-v4-pro`
   - `workbuddy/deepseek-v4-flash` -> `deepseek-v4-flash`
   - `workbuddy/minimax-m3` -> `minimax-m3`
   - `workbuddy/minimax-m2.7` -> `minimax-m2.7`
   - `workbuddy/glm-5.3` -> `glm-5.3`
   - `workbuddy/glm-5.3-flash` -> `glm-5.3-flash`
   - `workbuddy/glm-5.2` -> `glm-5.2`
   - `workbuddy/glm-5.1` -> `glm-5.1`
   - `workbuddy/glm-5.0` -> `glm-5.0`
   - `workbuddy/glm-5v-turbo` -> `glm-5v-turbo`
   - `workbuddy/kimi-k2.6` -> `kimi-k2.6`
   - `workbuddy/hy4-preview` -> `hy4-preview`
