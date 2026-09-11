# Responses → Gemini 多模态核查

最新进展（2026-08-31 后续项目映射核查）：在独立进程中让原安装代码能调用有效
Python 后，成功读取 Antigravity IDE 凭证；原 Responses 文本、SSE 和图片识别均
实测 200。项目 ID 没有变化。线上服务未修改，以下原始 403 记录仍保留作为对照。
详见文末“运行时项目映射与凭证对照”。

核查日期：2026-08-31。结论：旧转换路由保留，新 AGY 文本桥接没有替换它；
但本机已安装服务的 Google 官方登录上游仍返回 403，不能宣称端到端畅通。

## 已确认的边界

| 能力 | 原有 Responses → Gemini | 新 AGY CLI 桥接 |
| --- | --- | --- |
| 文本、文本 SSE | 保留转换；官方登录实测 403 | Chat Completions 文本已在前次验证通过 |
| 图片输入 | `input_image.image_url` 内联 base64 data URL 转 `inlineData` | 拒绝 |
| 音频输入 | `input_audio.input_audio = {data, format}` 等本项目支持的形式转 `inlineData` | 拒绝 |
| 视频输入 | `input_video.video_url` / `video_url` 内联 data URL 转 `inlineData` | 拒绝 |
| 多轮媒体历史 | `previous_response_id` 在同一状态缓存中保留媒体 | 仅文本转录，无等价 Responses 会话 |
| 图片生成输出 | 支持的 Gemini 图片结果转为 `output_text` 内的 Markdown data URL，含 SSE | 不支持 |
| 原生 Responses 图像生成工具项 | 不支持 `image_generation_call` 完整语义 | 不支持 |
| PDF、`input_file`、仅 `file_id` | 转换入口拒绝 | 拒绝 |
| HTTP(S) 远程媒体 URL | Gemini 转换入口拒绝，不主动下载 | 拒绝 |
| `/v1/responses` 端点 | 原有代理提供 | 桥接自身没有此端点，返回 404 |

音视频字段以上述项目实现为准，不能据此推断兼容所有 OpenAI SDK 的所有
Responses 音视频结构。媒体输入每个块最多 7 MiB（解码后）；另受入口请求体限制。
校验覆盖 base64、MIME 类别和大小，不负责解码文件或证明编码受 Google 模型支持。
多模态输入转换通过，也不表示支持语音或视频生成输出。

生成图片的实际显示取决于客户端是否渲染 Markdown data URL；本次没有做 Cherry
Studio UI 图像渲染验收。原生图像任务应与本项目已有独立图像接口区分。

## 验证证据

新增 `test/responses-gemini-multimodal.test.js` 使用真实请求校验、Responses 历史、
Responses/Chat/Claude/Gemini 转换器及 Code Assist 包装器，仅替换上游传输。
该文件自动进入现有 `npm run test:unit`，覆盖：

- 普通 Gemini API 与官方 Code Assist 两种路由的同步、SSE 媒体传递。
- 图片、音频、视频的 MIME、base64 数据和顺序保持不变；官方模型别名和思考等级。
- `previous_response_id` 后续请求仍包含前轮媒体与助手回答。
- 同步和 SSE 图片输出的 Markdown 表示。
- 远程 URL、文件引用、空数据、非法 base64、MIME 类别不匹配和超限输入在传输前拒绝。
- 上游 403 保持失败，不能变成成功的 `response.completed`。

本轮新增 9 项回归通过；全量 `npm run test:unit` 的 124 个文件、改动测试的
ESLint/格式检查以及 CI、发布治理检查通过。没有修改生产逻辑、依赖或安装包，
未执行 GUI/Rust 构建。

音视频测试使用字节传递夹具，不是可供模型解码的真实音视频。模拟上游成功证明
转换代码工作，不证明 Google 账户的权限、可用额度或模型理解能力。

实际请求使用安装服务的 `https://localhost:3445/v1/responses`，通过本地 CA
验证 TLS，使用现有允许 Responses 入口的密钥，不输出或修改密钥：

| 输入 | 模型 | HTTP | 上游 | 成功完成 |
| --- | --- | --- | --- | --- |
| 文本 | `gemini-3.7-flash-high` | 403 | gemini，permission denied | 否 |
| 文本，`stream:true` | 同上 | 403 | 同上 | 否 |
| 图片 data URL + 文本 | 同上 | 403 | 同上 | 否 |

本地脱敏结果保存在 `.hpm-runtime/responses-gemini-live-validation.json`。
没有改安装目录的路由、认证或服务。这轮未重新验证公网 nginx 入口。

## 为什么不能把多模态直接转给 AGY

[官方 headless 文档](https://antigravity.google/docs/cli/headless/)规定 stdin
内容只接受字符串或文本块；[交互模式的图片/视频粘贴](https://antigravity.google/docs/cli-prompting)
是另一套输入接口。不能把终端粘贴能力当作 headless JSON 附件能力。

本次还在现有隔离工作区和拒绝工具权限设置下，实际向安装的 AGY 1.1.22
headless stdin 发送图片块。CLI 启动后拒绝非文本内容，没有生成成功响应。
脱敏结果在 `.hpm-runtime/agy-multimodal-validation.json`，不保存 CLI 原始诊断。

[官方 Python SDK 附件文档](https://antigravity.google/docs/sdk/structured-output)
提供图片和 PDF 示例。但其[快速开始及认证说明](https://antigravity.google/docs/sdk/overview)
采用 Gemini API Key 或 Vertex 项目认证，不能假定可复用 AGY 订阅登录。
本次没有安装 SDK、注入订阅令牌或宣称 SDK 实测成功。

## 接入建议

保留 `google-official` 和原有 Responses/Gemini 路由，让 AGY 作为独立的文本模型。
不要自动把图片、音视频、文件请求转给 AGY，也不要降级为丢弃媒体后只发送文本。

多模态端到端恢复需要先解决 Google 官方登录上游权限，或由用户配置有权限的
Gemini API/Vertex 后端。随后用可解码的真实图片、音频、视频分别验证理解结果、
流式完成、多轮历史及客户端显示。SDK 附件接入应单独验证认证和权限边界后再实现。

## 社区调查补充（2026-08-31）

以下为来源核查，不代表已经在本机验证这些修复。Issue 被关闭也不代表问题已修复。

| 来源 | 报告或官方说明 | 对本项目的意义 |
| --- | --- | --- |
| [Gemini CLI #13516](https://github.com/google-gemini/gemini-cli/discussions/13516) | 官方仓库认证说明区分个人 Pro/Ultra 与企业项目环境变量 | 不应为个人订阅盲目添加 Cloud 项目变量 |
| [Pi 使用者的排障记录](https://github.com/anandpant/scripts-prompts-config/blob/main/universal/pi-google-code-assist-antigravity-troubleshooting.md) | 作者报告同账号两种 provider 使用不同项目，修正项目选择后恢复 | 核对实际 `loadCodeAssist` 返回的项目与生成请求所用项目；仅为个案 |
| [Gemini CLI #25425](https://github.com/google-gemini/gemini-cli/issues/25425) | 使用者报告仅用官方客户端也出现订阅识别正常、生成 403，重登无效 | 403 本身不能证明是代理触发封禁 |
| [CLIProxyAPI #1374](https://github.com/router-for-me/CLIProxyAPI/issues/1374) | 响应明确含 `VALIDATION_REQUIRED` 和 Google 验证链接 | 与本机目前只有 permission denied 的响应区分，不能套用验证码解释 |
| [anima 图片输入记录](https://github.com/seanwinslow28/anima/blob/main/docs/research/2026-05-26-anti-gravity-cli-findings.md) | 作者报告通过本地图片路径及文件工具读取图片 | stdin 图片块不支持，不代表所有文件工具方式均不可行 |
| [imagine-agy](https://github.com/dyrok/imagine-agy) | 项目通过 CLI 的 `generate_image` 工具生成文件 | 这是工具/文件任务，不是原生 Responses 图像协议；项目使用跳过权限选项，不直接采用 |
| [OpenCodeX #2458](https://github.com/lidge-jun/opencodex/issues/2458) | 使用者报告 Gemini 3.7 视频请求出现未声明工具而返回 502 | 媒体链路恢复后仍需验证工具边界，不能关闭未声明工具保护 |

本机只读检查：安装配置没有显式 `googleOfficialProjectId`；本次检查进程没有
`GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_PROJECT_ID`。这不能证明正在运行的服务
没有不同环境变量，也不能排除后端自动下发错误项目。现有代码会从
`loadCodeAssist` 结果提取项目后传给生成请求，下一步应检查该运行时值及验证错误，
不应凭社区项目名直接覆盖配置。

优先路线仍是修复正确认证/项目映射或使用有权限的正式 API 后端。若要继续复用
AGY 登录，值得单独验证“附件保存到私有临时目录 → 官方文件工具读取 → 文本答案”
这条实验路线。必须实现并验证仅授权附件文件的权限边界、禁止命令/网络工具、
超时清理、真实视觉识别及不会读取目录外文件；不能用
`--dangerously-skip-permissions` 代替这些边界。官方权限规则是 Deny > Ask > Allow，
所以也不能在现有 `read_file(*)` 拒绝规则下添加 allow 就声称附件已经放行。

[官方 SDK README](https://github.com/google-antigravity/antigravity-sdk-python)
明确列出图片、音频、视频和文档类型，并提供 API Key / Vertex 认证路径；这仍不
证明支持 AGY 订阅令牌。另有[账号停用个案](https://github.com/router-for-me/CLIProxyAPI/issues/1814)，
报告者自己也未确认触发原因，因此既不能保证逆向代理无账号风险，也不能把本机
403 直接归因为封禁。本轮未安装第三方项目、放宽权限或更改线上路由。

## 运行时项目映射与凭证对照

本次使用安装目录内原有模块进行实际请求，没有修改安装文件。核心项目发现、
Code Assist 包装模块与工作区文件校验一致。项目标识仅记录 SHA-256 前 12 位，
不输出 OAuth 凭证。返回项目的指纹为 `218f87bcebbc`。

| 检查项 | 当前探测进程的默认 PATH | 仅在隔离进程 PATH 中提供可用 Python |
| --- | --- | --- |
| 读取 IDE SQLite 登录状态 | 失败，裸 `python` 命令指向不可用的 WindowsApps 别名 | 成功 |
| 实际凭证来源 | `.gemini/oauth_creds.json`，Gemini CLI 文件回退 | `antigravity-state`，Antigravity IDE |
| 刷新令牌 | 200 | 200 |
| `loadCodeAssist` | 200 | 200 |
| 返回项目指纹 | `218f87bcebbc` | `218f87bcebbc` |
| `projectValidationError` | 未返回 | 未返回 |
| 发现项目 → prepared → 生成请求 | 三者一致，字段存在 | 三者一致，字段存在 |
| `fetchAvailableModels` | 403 | 200，25 个模型 |
| `generateContent`，Gemini 3.7 Flash High | 403 | 200 |

因此本次没有发现项目 ID 丢失、改写或不一致。也不能仅凭项目一致就断言两个
OAuth 登录来源拥有相同权限。可复现差异是依赖 Python 的 IDE 凭证读取失败后，
解析器静默回退到了另一客户端的 OAuth 文件。

随后用原安装入口脚本启动独立代理，使用私有临时配置、随机本地端口和入口密钥，
不经过 AGY 桥接。该进程 PATH 指向已经可用的 Python，不改系统环境变量：

- Responses 文本：200，状态 completed，指定答案匹配。
- Responses SSE：200，有 response.completed，指定答案匹配。
- Responses 图片：200，正确识别程序生成的纯红 PNG；提示词未告知图片颜色。
- 测试进程已停止，临时配置与运行目录已清理。

这证明原 Responses → Gemini 链路可以在正确凭证来源下恢复。正在运行的服务
PID 21780 的管理接口同期返回权限错误，但本次没有读取其内存中的凭证或项目
缓存，也没有直接获取该进程完整环境，因此不能把独立进程对照说成对线上进程
内存状态的直接观察。线上尚未应用任何修复或重启。

脱敏证据：`.hpm-runtime/google-project-default-path-validation.json`、
`.hpm-runtime/google-project-ide-python-validation.json`、
`.hpm-runtime/google-project-responses-validation.json`。

后续修复应明确选择并验证可用 Python，或移除读取 IDE SQLite 对裸 `python`
命令的依赖；IDE 凭证读取失败必须给出安全、可见的来源错误，不能悄悄混用 Gemini
CLI OAuth。项目验证错误和按凭证隔离项目缓存是另需加固的边界，但此次返回中
没有项目验证错误，不能把它们认定为当前 403 的已证实原因。

## 凭证读取修复与安装版验证（2026-08-31）

以上“尚未更新安装版”描述的是修复前的对照阶段。现已完成以下修复并应用到
`C:/Users/juhon/AppData/Local/HTTPS Proxy Manager`：

- 新增独立 `antigravity-credentials.js`，使用安装包已有的 Node 22.22.3
  `node:sqlite` 只读访问 IDE 状态数据库，移除对系统 Python 的依赖，不增加依赖包。
- 查询限制为指定状态键和最多 1 MiB 文本，拒绝数据库视图、非文件、符号链接、
  损坏及异常内容；不会把 SQLite 原始错误、令牌或登录数据返回给客户端。
- 官方登录不再回退到 Gemini CLI OAuth。读取失败或 IDE 令牌刷新失败时，
  生成请求在本地返回明确的 503 `ANTIGRAVITY_*` 错误，不继续使用错误或过期凭证。
- 不改变显式 API Key 模式、项目发现、模型映射及 Responses/Gemini 媒体转换。
  未启用实验性 AGY CLI 桥接。

新增 11 项回归覆盖 WAL 状态实时变化及数据库不被修改、缺失、空值、损坏、
超限、类型错误、安全错误、刷新失败及 API Key 模式。新的测试文件进入现有
统一单测发现入口；现有 HTTP 集成测试增加“有 Gemini CLI 登录但无 IDE 登录”
场景，断言返回 503 且上游请求数不增加。

验证结果：125/125 单测文件通过；总体覆盖率为语句/行 68.41%、分支 71.10%、
函数 77.17%，现有安全覆盖率门禁通过。新凭证模块语句/行/函数覆盖率 100%，
分支 97.72%。语法、目标文件格式、Lint、发布清单和 CI 治理检查通过；Lint
仍有 6 项原有 WorkBuddy 未使用变量告警。本次只更新 Node 运行模块，没有
重建 Rust/UI 安装包。

集成门禁限制：`headers-routing.test.js` 连同新增凭证失败边界完整通过；
`entry-auth-integration.test.js` 曾单独运行通过，但 `npm run test:integration`
连续重跑时仍在原有 15 秒启动等待处超时，后续独立诊断也复现了启动超时。
因此不能把整套集成命令标为通过。未增加超时、跳过断言或放宽门禁；该启动
时序问题尚未定位，不影响下面已经完成的安装版及公网实际请求验证。
日志为 `.hpm-runtime/antigravity-fix-integration-native.log` 和
`.hpm-runtime/antigravity-fix-entry-auth-retry.log`。

| 实际请求 | 安装版结果 |
| --- | --- |
| 本地 TLS `/v1/responses` 文本 | 200，completed，指定答案匹配 |
| 本地 TLS `/v1/responses` SSE | 200，response.completed，指定答案匹配 |
| 本地 TLS `/v1/responses` 图片 | 200，正确识别合成纯红 PNG |
| 本地 HTTP `/v1/chat/completions` | 200，指定答案匹配 |
| 公网 `https://jhgpt.iepose.cn/v1/chat/completions` | 200，指定答案匹配 |

实际请求使用 `gemini-3.7-flash`，保留 TLS 证书验证。此次未重新实测音频、视频、
PDF 或图像生成，因此上述结果不应扩大为所有多模态能力均已验证。

仅替换四个修复模块，并更新安装目录运行清单的对应哈希及本地修补标记。旧文件
和原清单已备份至
`.hpm-runtime/deployment-backups/antigravity-native-20260831-012454/`。
重启后由现有管理器 PID 61372 管理代理 PID 170832；配置文件重启前后哈希一致。
该目录的 `patch-record.json` 记录文件哈希和回退所需的旧文件清单。

脱敏真实请求记录：`.hpm-runtime/antigravity-fix-live-workspace.json`、
`.hpm-runtime/antigravity-fix-production.json`、`.hpm-runtime/antigravity-fix-public.json`。
探测记录只保留状态、完成标志、预期答案是否匹配及耗时，不保存入口密钥或 OAuth。
