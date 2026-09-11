# 2026-08-31 本地候选构建

版本保持 `0.1.0`，Windows x64。已生成安装包和便携 ZIP，**未签名，未发布到
GitHub，不作为已通过正式发布门禁的版本**。本轮未运行安装器、替换当前安装目录，
也未提交、推送或打 Git 标签；当前工作区已有修改均保留在此次构建中。

## 产物

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `dist/artifacts/installers/HTTPS Proxy Manager_0.1.0_x64-setup.exe` | 25481387 | `41a05ddba51f368ec086124a9d0054264a175bfe96bf1fad53c3afa0846040ce` |
| `dist/artifacts/portable/HTTPS-Proxy-Manager-Portable.zip` | 37752988 | `83405b0cb43d62fea7d728b5d367636fddaf38a228b3e0b4337d9f38809e9875` |

两组校验清单和 npm/Rust CycloneDX SBOM 已生成，`verify-release-artifacts.js`
及 `list-release-assets.js` 通过。旧产物保存在
`dist/archive/pre-antigravity-release-20260831-013229/`。

## 修复与验证

- 包含 Antigravity IDE SQLite 凭证读取修复；不依赖 Python，不静默回退到
  Gemini CLI OAuth，读取或刷新失败时明确停止生成请求。
- 本次额外修复运行时打包：清理依赖内的 `.github`、`.claude` 元数据目录，
  打包前强制执行内容验证。清理拒绝目录联接、符号链接和越界路径，其余敏感
  内容仍作为失败处理。新增 6 项回归进入统一测试发现入口。
- 完整单元测试 126/126 文件通过；前端测试 10/10 及前端覆盖率门禁通过；
  thinking、env 测试通过。新增构建代码的格式、语法和 Lint 通过，发布配置、
  CI 治理与发布相关回归通过。
- Tauri 前端生产构建、Rust 优化构建、NSIS 安装包、便携 ZIP 构建成功。
- 使用 7-Zip 分别解包最终 EXE 和 ZIP：各自的 128 个清单源码文件与工作区
  SHA-256 一致；Node 22.22.3 文件哈希一致；新凭证模块存在。两种解包内容均
  通过敏感文件/私钥内容检查，未包含本机配置、登录数据或日志。
- 使用便携目录自带 Node 和管理器辅助程序，在私有临时目录运行真实请求：
  Responses 文本、SSE、图片识别全部返回 200、completed 且预期答案匹配。
  临时进程停止、测试目录清理完毕。本轮未重测音频、视频、PDF 或图像生成。

Rust 测试通过：`cargo test --manifest-path src-tauri/Cargo.toml --release
--features tauri/custom-protocol --locked`，库测试 12 项、入口测试 1 项，
总计 13 项通过，无忽略或过滤测试。

## 正式发布阻塞

1. 安装包 Authenticode 状态为 `NotSigned`；本机没有配置签名材料，也未发现
   当前用户的代码签名证书。项目 GitHub Release 流程禁止未签名正式发布。
2. `npm audit --audit-level=high` 报告 3 项高危依赖：`brace-expansion`、
   `ip-address`、`nanoid`。这是依赖审计结果，尚未逐项分析本应用的可利用性。
3. Windows Rust 依赖审计被 `RUSTSEC-2026-0235` 阻止。
4. 完整格式检查仍有 24 个现有工作区文件未通过，本轮没有批量改写这些文件。
5. 上一轮完整集成测试的入口鉴权用例在原有 15 秒启动等待处超时；不能用单独
   运行曾通过代替整套命令通过，本轮未提高超时或跳过测试。
6. 干净 Windows 环境中的安装/卸载烟雾测试尚未执行。本机已有正在使用的安装，
   按项目规则不能在此运行会安装/卸载产品的烟雾测试。

正式发布前需修复并复验依赖、格式和集成门禁，通过签名及干净环境安装验证，
再按确定的版本标签发布。本轮没有关闭规则、提高覆盖率基线或绕过这些门禁。

## 验证记录

- `.hpm-runtime/antigravity-release-build-final.log`
- `.hpm-runtime/antigravity-release-portable.log`
- `.hpm-runtime/antigravity-release-unit.log`
- `.hpm-runtime/antigravity-release-payload-validation.json`
- `.hpm-runtime/antigravity-release-portable-live.json`
- `.hpm-runtime/antigravity-release-rust-tests.log`
- `.hpm-runtime/antigravity-release-npm-audit.log`
- `.hpm-runtime/antigravity-release-rust-audit.log`
- `.hpm-runtime/antigravity-release-format.log`
