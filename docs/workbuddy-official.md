# WorkBuddy Official Login Notes

[中文版本](workbuddy-official.zh-CN.md)

This document records the official login credentials and model routing design for WorkBuddy / CodeBuddy.

## Architecture

WorkBuddy follows the same direct-credential pattern as **Codex** (reading local OAuth JWT token without requiring the Electron GUI application to run):

1. **Credential Source**:
   - Path: `%LOCALAPPDATA%/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info`
   - Content format:
     - `auth.accessToken`: Standard OAuth2 JWT Bearer Token (starts with `eyJ...`)
     - `auth.refreshToken`: Refresh token
     - `auth.domain`: Gateway domain (`www.workbuddy.cn` / `copilot.tencent.com`)
     - `account.uid` / `account.uin`: User identifier
     - `auth.expiresAt`: Expiry timestamp

2. **Model Discovery**:
   - Read from: `%LOCALAPPDATA%/Programs/WorkBuddy/resources/app.asar.unpacked/cli/product.json`
   - Fallback catalog with default official models:
     - `deepseek-v4-pro` (1M context flagship)
     - `deepseek-v4-flash`
     - `deepseek-v3.2`
     - `minimax-m3` (multimodal coding & agents)
     - `minimax-m2.7`
     - `glm-5.2` / `glm-5.1` / `glm-5.0` / `glm-5v-turbo`
     - `kimi-k2.6` / `kimi-k2.5`

3. **Proxy Configuration**:
   - Profile ID: `workbuddy-official`
   - Protocol: `workbuddy`
   - Auth Mode: `official-login`
   - Target URL: `https://copilot.tencent.com/v2`

4. **Built-in Model Routes**:
   - `workbuddy/deepseek-v4-pro` -> `deepseek-v4-pro`
   - `workbuddy/deepseek-v4-flash` -> `deepseek-v4-flash`
   - `workbuddy/minimax-m3` -> `minimax-m3`
   - `workbuddy/minimax-m2.7` -> `minimax-m2.7`
   - `workbuddy/glm-5.2` -> `glm-5.2`
   - `workbuddy/glm-5.1` -> `glm-5.1`
   - `workbuddy/glm-5.0` -> `glm-5.0`
   - `workbuddy/glm-5v-turbo` -> `glm-5v-turbo`
   - `workbuddy/kimi-k2.6` -> `kimi-k2.6`
