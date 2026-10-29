# Local evidence plugin: installed-host integration

## 干净检出的依赖初始化与测试

在仓库根目录依次执行以下依赖安装，再运行插件构建或统一验证：

```powershell
npm ci
npm ci --prefix plugins/hpm-local-evidence --ignore-scripts
npm run build:evidence-plugin
```

根目录与插件各自保留独立锁文件。插件 SDK 虽然同为 1.32.1，传递依赖版本并不完全相同；不能用根目录 node_modules 替代插件锁定的构建依赖。Verify 的 unit-tests 和 coverage 作业在依赖安装阶段执行第二条命令，测试本身不安装依赖、不访问网络。

旧版源码闭包的打包和握手回归只复制明确模板与当前 lib 依赖闭包到各自的临时目录，在其中生成 runtime 和 manifest。握手通过测试专用解析器使用根目录已安装的 SDK，不复制 node_modules，不读取已有的插件 runtime，也不写入真实插件源码目录。正式自包含分发包的构建仍使用插件自己的锁定依赖。

## 2026-10-21：并排 marketplace 身份的活动切换与回滚资格

在隔离原生 codex-cli 0.160.1 中，旧 0.1.0 以 `hpm-local-evidence@hpm-local` 安装，新 0.1.1 以 `hpm-local-evidence@hpm-local-next` 安装。旧会话与其 MCP 进程持续运行期间安装新身份，配置选择新身份后新建会话，再恢复旧身份并新建回滚会话，三次原生握手确认实际版本分别为 0.1.0、0.1.1、0.1.0。两份已安装包摘要均与各自观测配置一致；没有覆盖同一缓存目录。旧、新活动会话原文精确读取、原绝对到期时间保留、跨线程拒绝、两个缓存完整、进程终态及日常配置摘要均通过，真实模型请求为 0。

此项使用受信宿主显式捕获合成原文，不代表切换过程执行自动 Hook，也不是跨进程原文迁移。旧源来自此前独立 vault，包含先前的诊断 launcher 元数据；运行 server 字节保持原样。v1 原引用的日常 0.1.0 缓存路径已不存在，核验阶段失败且未安装；v2 改用经过重新核验的 vault 包。原失败保留。并排选择提供了避开已观察缓存覆盖冲突的候选流程，尚未接入产品安装器，也未改日常插件或生产配置。证据位于 `.hpm-acceptance/context-plugin-vault-20261021-01/plugin-side-by-side-v2-result.json`。

## 2026-10-21：旧版迁移限制与可执行的原样恢复命令

真实 0.1.0 包在隔离原生客户端中升级到 0.1.1 后，旧、新活动会话均可精确读回证据，绝对到期时间不变；但有旧进程存活时，恢复同版本的安装失败。诊断观察到旧进程的 cwd 位于版本缓存，安装错误归类为 cache/used，出现 Windows access denied；结束隔离 app-server 后，同一安装命令成功，恢复包握手确认仍执行 0.1.0。这是进程生命周期冲突的证据，未定位到具体失败的系统调用或路径。

另一个候选只改包身份为新的 recovery 版本，保留旧运行代码、SDK、Hook 和 MCP 配置。活动安装仍失败，结束进程后同命令成功。因此该候选已撤回，产品不增加改版本号的恢复分支，也不承诺旧版热回滚。原失败与停机对照分别保留在 `plugin-legacy010-diagnose-result.json`、`plugin-fresh-activation-result.json`、`plugin-activation-stopped-control-result.json`。

仓库提供以下包管理命令；所有路径都必须是绝对路径，vault 目录须预先建立。命令只输出包版本、摘要、文件数和字节数，失败只输出固定错误码。它们不修改客户端配置、不结束进程，也不调用原生安装器。

```powershell
# 校验现有完整包
node scripts/local-evidence-plugin-vault.js inspect "D:\plugin-package"
# 在升级前保存完整包到独立 vault；保留输出的 snapshotId
node scripts/local-evidence-plugin-vault.js retain "D:\plugin-package" "D:\plugin-vault"
# 恢复到一个尚不存在的目录；必须使用 retain 输出的 snapshotId
node scripts/local-evidence-plugin-vault.js restore "D:\plugin-vault" "<snapshotId>" "D:\restored-plugin-package"
```

原生安装的操作顺序：升级前 retain 并保存回执；需要旧版恢复时，先结束使用该插件的旧会话及其 MCP 进程；restore 到新目录并核对 snapshotId；让用户管理的 marketplace 指向该恢复包；再执行原生安装并新建会话，确认版本握手。未经结束旧会话，不把安装失败后的缓存视为完整安装，也不要删掉独立 vault。日常客户端迁移尚未执行。

vault 保存的是插件执行包及其依赖，不是聊天原文。可选插件的原文仍是内存 30 分钟策略，结束进程会失去这部分原文；以上包恢复不会恢复内存证据。代理层主方案的 24 小时加密原文留存是另一条独立路径，不能用插件包迁移验收替代。

## 2026-10-21：原生自动捕获与当前包升级回滚已验证

当前分发包在新建隔离 Codex 环境中，经确切 hook 信任后，真实源 MCP 工具通过原生 Code Mode 完成，PostToolUse hook 自动执行一次并精确留存 140 字节；没有向探针注入私有捕获调用。模型响应来自本地合成服务，真实模型请求为 0，进程已终止。此前 run97/run98 的 untrusted 结果保留，此次新增的是自动执行证据。

另用实际原生安装命令完成当前 0.1.1 → 诊断身份 0.1.2 → vault 恢复 0.1.1；物理删除 marketplace 包后仍可从独立完整存档回滚。活动会话原文、Unicode/CRLF、原到期时间、回滚后新会话及跨线程拒绝均通过。隔离启动观察器另外确认原生 app-server 的 MCP 子进程分别加载上述三个版本；只记录 PID、父 PID 和版本。诊断版未发布，运行源码及正式分发包未修改。

原生安装器仍清理退役版本缓存，回滚保障来自独立 vault；此项尚不证明旧 0.1.0 的完整迁移。hook 与升级探针分别验收，不宣称升级流程内也自动执行了 hook。内存 30 分钟策略、日常配置及生产进程未变。本批回执为 `.hpm-acceptance/context-plugin-vault-20261021-01/plugin-native-lifecycle-outcome.json`；整体未完成项及准确范围见 [实施状态](./context-recovery-implementation-status.md)。

## 2026-10-21：当前安装源为自包含分发包

`npm run build:evidence-plugin` 从当前源码和插件锁定的依赖生成完整 CJS 包，输出 packageDirectory 和 marketplaceDirectory。`scripts/install-local-evidence-plugin.js` 及隔离探针都使用该生成 marketplace；开发源码目录不再是这些入口的安装源。此命令只构建，不会安装插件或修改客户端配置。日常安装仍保留既有一次性 guard，本阶段没有执行。

分发包只有 10 个文件、约 1.96 MB，无外部 node_modules 运行依赖。runtime-manifest 绑定全部文件及构建输入，third-party-notices 包含参与构建的依赖版本、许可证文本及锁文件摘要。存档保留旧源码闭包 schema 的恢复支持，新包须通过独立 bundle 校验；两种格式都完整验证内容，不能以缺少依赖而退回开发源码。

原 60 秒完整包删除回归通过：在空环境和独立临时目录中运行，物理删除整个包后继续精确读回和捕获，并检查线程隔离及原到期时间。Codex 原生隔离安装 run98 通过安装、启动、合成捕获、精确读回、线程隔离和进程终态；新隔离环境 hook 为未信任，真实自动 hook 执行仍未证明。没有改动默认原生压缩、可选插件的内存留存策略、日常配置、生产进程或真实模型预算。当前最终验证和剩余交付状态见 [实施状态](./context-recovery-implementation-status.md)。

## 2026-10-21：Claude 原生续接、流元数据与计量兼容

Claude 原生压缩后会插入 assistant 消息；旧的全 user 条件因此丢弃有效回执。现在解析完整回执，只有唯一已观察到且确实源于该回执的后代窗口才能优先于旧回执；不相关和歧义分支继续拒绝。绑定层返回本次是否真正跨摘要窗口，私有历史仅首次重建，后续继承最新映射，避免重复恢复到旧摘要。回归涵盖有/无 acknowledgment、重开后的原文精确读取与新映射保留、伪造/跨身份/跨目标/策略变更/撤回/撤权/到期和冲突分支。测试仍在统一 CI 入口。

供应商只新增 Anthropic 的精确 beta=true 路径，以及 HTTPS443、同 host、api-key 模式和 claude profile 下 DeepSeek 的精确 /anthropic/v1/messages（含 beta=true）路径；额外查询、错 host/port/protocol/auth 和非法对象继续拒绝。对应扩展回归 61/61。

真实 Claude v8/v9 首轮失败，v9 上游实际为 200/SSE；v10 原样转发公开响应后完成首次工具捕获，但后续恢复拒绝。安全结构诊断发现 usage.service_tier 为字符串；官方 Anthropic SDK 明确定义 standard/priority/batch/null。新增精确枚举校验，不把档位计入数值汇总，只保留最终响应的合法档位；未知字符串、嵌套伪造和 accessor 仍拒绝。Claude SSE 收集器另修复丢失 message_start 的 type/model/stop_sequence，并应用最终 delta 的 stop_sequence，空缺字段兼容旧 fixture，非法元数据拒绝。新增 JSON/SSE 往返、正常/空/非法/极端与安全回归 98/98，旧失败记录保留。官方类型来源：https://raw.githubusercontent.com/anthropics/anthropic-sdk-typescript/main/src/resources/messages/messages.ts 。

原生 Claude v7 零模型通过三次实际压缩、真实 MCP 捕获一次、精确私下读取与答案、单根和无泄漏。两端新建全真实模型任务：Codex v36=true（9 次请求），Claude v11=false（6 次请求）。这些探针均经过恢复 HTTP 入口，并未覆盖完整 Core 或 Hook。

回执/绑定扩展回归 289/289；元数据修复前的标准完整客户端门禁 1275 项，1269 通过、3 失败、3 取消、0 跳过，291435.413ms。覆盖率语句/行 99.08%、分支 95.14%、函数 99.27%；容量资格、加密 owner 重开/启动等未通过。存储用例单独复核 21/21 通过，不替代完整门禁。原五档负载、两 worker、所有期限未改变。最终源码仅完成相关扩展回归，完整门禁没有宣称绿色；Lint、格式、语法、CI 清单、架构与发布清单检查通过。

当前真实模型预算 83/88，重复请求在探针网关拦截、不改日常配置、生产未激活。完整 Core HTTP/WS/Hook、WBIPC 长历史事务、容量性能、迁移/旧版回滚、全仓门禁、24h 到期观察与空闲激活仍未完成，整体 active。

本轮机器证据：claude-receipt-outcome.json、claude-metadata-source-freeze.json、claude-receipt-expanded.log、claude-metadata-usage-expanded.log 与相应原生验收结果。


## 2026-10-21：Codex 工具历史边界、原生摘要格式与可选读取字段

新增 Codex additional_tools 协议边界：普通生成把完整内嵌工具清单（含原生 id）纳入策略和精确历史；只有已识别的本地压缩可使用独立连续性指纹定位唯一已观察祖先。principal、target、instructions/system 与歧义拒绝保持；连续摘要收据使用独立索引并随根状态导出、重开、撤回和到期清理。持久化增加显式 identityFormat 标记，未知标记、跨协议和篡改拒绝；旧解析器的精确字段规则会拒绝新增状态，但尚未以真实旧版二进制完成降级验收。

原生零模型 v27 完成工具原文捕获、三次压缩、私下列目录/读取、后续请求精确原文与正确答案，且没有私有调用泄漏。v26/v27 证明探针使用 phase=final 会被当前原生客户端忽略；已支持并原样保留官方 final_answer（也支持 nullable phase）。真实摘要形状 v33 进一步发现 output_text.logprobs；仅接受并保留空数组，非空概率、非法类型、accessor、签名/opaque 和混合工具响应继续拒绝，避免新增收据与 token 概率错位。

v34 全程真实模型执行 8 次请求，完成三次实际压缩，但最终模型只调用带 afterSourceId 的目录请求，未读回原文，保留 passed=false。官方文档说明 Responses 在省略 strict 时会尝试规范化为严格 schema；代理注入的两个读取函数现显式 strict=false 以保留原可选字段契约，不改外部工具，也不放松宿主参数验证。回归覆盖空参数、未知字段、非法游标、分页类型与上下界、必填 sourceId/digest 及其他协议。修复后 v35 用真实模型自行完成目录→读回→答案，3 次请求、精确原文字节、正确最终值与事件级隐私检查均通过；但 v35 的种子和三次摘要仍为合成响应，不能替代全程真实验收。v29 曾把用户回显误计为泄漏；原失败记录保留，v30 零模型通过事件路径证明同提示只在 userMessage 回显命中，未追溯改判 v29。

Claude v3 零模型观察到无新对话时连续 /compact 只有一次实际压缩；v4 在压缩之间加入对话，完成三次摘要请求与三次 compact_boundary。该结果仅验证原生客户端命令/事件形状，不包含原文恢复、真实模型、Hook 或完整 Core 入口。另已只读验证生产能力检查当前拒绝 Anthropic 的 /v1/messages?beta=true 及现有 DeepSeek 的 /anthropic/v1/messages?beta=true；Claude 路由能力边界仍需精确修复和回归，尚未放宽供应商准入。

本轮先后扩展回归 92/92、93/93 与最新读取声明回归 118/118。首轮完整客户端 1270 项中 1267 通过、1 失败、2 取消；相同冻结源码仅将外层测试进程限制为 2 的诊断为 1270 项、1269 通过、1 失败、0 取消，容量资格仍在原 60 秒超时，32 MiB 加密重开在 163215ms 完成。该诊断没有进入 package/CI 配置；原五档负载、两 worker 和所有期限保持。最终 21 个源码/配置文件冻结后，标准完整客户端终态：1272 项，1265 通过、2 失败、5 取消、0 跳过，315205.9199ms；覆盖率语句/行 99.08%/99.08%、分支 95.14%、函数 99.27%。源码 SHA256 复核一致。

用户授权累计上限 64 次，目前 64/64，本轮新增真实请求 20 次；没有自动重试、修改日常模型/凭据、安装插件或激活生产。真实新任务在修复后的全程 Codex/Claude 精确恢复、完整 Core HTTP/WS/Hook、WBIPC 长历史事务发布、容量性能、旧插件迁移/回滚、全仓门禁、24h 实际到期观察与空闲窗口生产激活仍未完成，整体 active。24h 样本仍沿原到期 2026-10-22T00:55:55.109Z，不重播种。继续使用统一预算账本；新增真实请求需追加授权。

官方依据：[assistant phase](https://developers.openai.com/api/docs/guides/reasoning)、[Responses 输出格式](https://developers.openai.com/api/reference/resources/responses/methods/create)、[函数 schema 默认语义](https://developers.openai.com/api/docs/guides/function-calling)。本轮证据：inline-tools-*-source-freeze.json、inline-tools-*-client.log、optional-reader-schema-expanded.log、real-codex-http-recovery-*-v27/v34/v35-result.json、claude-native-compaction-synthetic-v4-result.json；最终机器记录 inline-tools-schema-outcome.json。


## 2026-10-21：省略 tools 的摘要识别修复，发现 additional_tools 历史边界

本轮先定位而未重发上一失败任务。新建 v14 真实诊断执行 3 次请求，确认原生压缩包含预期 checkpoint/handoff 提示、tool_choice=auto，但省略顶层 tools，导致旧分类器未识别摘要。累计账本 44/48，剩余 4 次；没有自动重试，也没有改日常配置或激活生产。v14 的 passed 仅表示诊断阶段完成，不代表恢复通过。

分类器现在接受省略或显式空数组 tools；显式 null、非空工具、错误选择器及非摘要继续拒绝。绑定与会话层重建内部摘要请求时省略内部 null 哨兵，避免规范化拒绝或错误策略冲突。重复收据窗口测试同时覆盖两种格式，并验证精确原文、多轮重开、单根及绝对到期时间。首次回归暴露绑定层尚未兼容的问题，修复后 3/3，完整绑定/摘要/协议/usage 扩展回归 67/67；Lint、格式、CI 与发布清单检查通过，测试仍在原统一 CI 入口。

v15–v20 使用真实原生客户端与本地合成 SSE 响应，均为零模型请求并已终止；这些实验不是真实模型验收。v16–v20 仍拒绝摘要祖先为 context_binding_compaction_unobserved，失败证据保留。无内容结构诊断观察到：原生请求首项 type=additional_tools、role=developer；压缩时该项工具由 3 个变为 0 个，同时 id 更换，其他已比较的字段不变。该差异足以改变现有精确历史指纹，但合成响应没有证实完整原生任务输出链，不能将其解释为唯一剩余原因。没有通过删除整项或宽松匹配绕过边界。

下一步需要将嵌入历史的工具策略纳入明确的 Codex 协议边界：普通生成保持完整工具策略与历史精确匹配；仅已识别的本地压缩可定位唯一已观察祖先，仍绑定 principal、target、instructions/system；摘要收据、歧义拒绝、持久化重开和旧读取器失败关闭必须同步验证。若新增祖先指纹字段，须显式处理持久化版本/降级兼容，不能挪用已有 echo 字段。之后才使用剩余额度验证实际原文进入后续上游请求与最终任务。

冻结 15 个源码/配置文件后完整客户端测试终态 exit 1：1263 项，1252 通过、4 失败、7 取消、0 跳过，耗时 341792ms；覆盖率语句/行 99.01%、分支 95.06%、函数 99.11%。11 个未通过项涉及加密冷恢复、两个入口启动、五档两 worker 容量资格、Windows 密文清理/ACL/启动/重开、32 MiB 四根重开及 source runtime API；失败均记录原有超时，没有改变期限、负载、并发或跳过门禁。冻结 SHA256 全部复核一致。整体目标仍 active；WBIPC、真实多端精确恢复、性能/全仓门禁、24h 到期与生产激活尚未完成。证据为 omitted-tools-*.log/json、real-codex-http-summary-classifier-v14-result.json 及 real-codex-http-summary-native-local*-result.json。


## 2026-10-21：真实第二轮 usage 根因修复，完整恢复仍未通过

追加授权已记入账本，累计上限 48 次；本轮新增 17 次，目前 41/48，剩余 7 次。未自动重试，复用现有模型/凭据，日常配置及生产不变。v8/v9/v10 为独立结构诊断，只保存类型、字段名和计数是否合法，不保存原文、归因条目身份或凭据。

真实工具回传后的第二轮响应增加 usage.attribution.request_fields.tools，内容为四项非负安全整数计数。归因校验模块精确支持此已观察结构；未知字段、非法计数及 content 嵌套继续拒绝，归因仍从公开 usage 中剔除。新增边界回归进入现有统一 CI 测试文件；4/4 定向、89/89 扩展回归通过，模块语句/分支/函数/行覆盖率均 100%，Lint、格式、CI 与发布清单检查通过。

v11 隔离真实 Codex 工具调用、回传后第二轮校验、runner release 与编码通过，2 次请求、原生进程已终止。v12 新任务连续三次真实压缩通过，5 次请求；这仍不证明精确私有原文恢复。v13 新的完整闭环探针发起 4 次请求后，在第二次压缩阶段 gateway_failed（该请求未取得响应状态），仅完成一次压缩，进程已终止；未自动重发，也未宣布最终任务/原文后续上游请求验收通过。

此前冻结的 1261 项完整门禁属于 usage 修订之前的源码；本次修订仅有上述定向验证，不能继承为完整最终门禁。当前完整目标仍 active，容量、冷恢复/启动、32 MiB 重开、WBIPC、真实多端精确恢复与 24h 到期/生产激活仍待完成。证据为 request-fields-*.log、real-codex-http-usage-shape-v8/v9/v10-result.json、real-codex-http-usage-fixed-v11-result.json、real-codex-http-compaction-fixed-v12-result.json 及 real-codex-http-recovery-fixed-v13-result.json。


## 2026-10-21：WebSocket 延迟加载与冻结源码完整验证（整体未通过）

新增独立 lazy-websocket-proxy 模块，主入口保留共享生命周期及实时配置 getter，仅在首次 upgrade 加载 WebSocket 实现。初始化失败返回空 503，仅记录固定错误码；成功初始化缓存，实际处理器的参数、接收者及返回值保持。新增 4 项定向回归通过，覆盖真实 HTTP upgrade 失败、安全日志、延迟加载、认证轮换及实际模块入口；扩展传输/生命周期/架构回归 101/101（第四项随后单独通过）。Lint、格式、CI 与发布清单检查通过。

冻结源码 lazy-ws-source-freeze-v2.json 的 9 个文件 SHA256 已复核一致。完整客户端门禁 1261 项，1256 通过、3 失败、2 取消、0 跳过，总耗时 332135ms。五个未通过项：加密 worker 冷恢复 30 秒超时、两个入口启动 15 秒超时、原五档两 worker 容量资格 60 秒超时、四根 32 MiB 历史重开 180 秒超时。覆盖率 statements/lines 99.06%、branches 95.09%、functions 99.27%。独立启动用例 2/2 通过不代表完整门禁下启动达标；未修改负载、并发或期限。

内容无关编码诊断记录 192 轮/四根/每根 40 次读回，耗时 11018ms，仅用于定位；另一项 scalar-layout 实验 12944ms 对比基线 12990ms 无有意义改善，已字节恢复。未保留指纹算法优化，未把小负载诊断作为容量资格。

用户已明确追加最多 24 次真实模型请求，统一账本累计上限从 24 调至 48；沿用现有模型和凭据、不自动重试、不改日常配置。后续先采集真实第二轮 usage 的无内容结构，再决定修复。生产未激活；WBIPC 事务压缩、真实多端恢复、完整门禁和 24h 到期观察仍待完成。证据位于 .hpm-acceptance/context-plugin-vault-20261021-01，整体目标保持 active。


## 2026-10-21：容量性能采样与两项撤回实验（门槛未变）

沿用现有实现，对四任务候选档执行 192 轮、每根 40 次读回的独立诊断，完成 768 次写入并精确读回；此诊断不替代原五档、两 worker、60 秒容量资格门禁。未采样基线单次耗时 12990ms，CPU 采样基线为 15191ms。采样定位到请求内编码函数，JSON.stringify 所在线 826 个采样 tick、字符串缓存查询所在行 295 个 tick；还包括校验、哈希和检查点往返，尚不能把容量超时归因于一个函数。

实验一通过完整当前文本的校验和复用旧规范指纹，41 项局部回归通过，但同规模诊断为 24124ms；实验二将请求内字符串缓存改为 FIFO，诊断为 17192ms。两项均未证明提速，已经撤回；新增实验模块和测试从工作树移除，原 package 命令、发布清单及公共窗口源码恢复，原绑定回归 38/38。仅保留诊断结果及 CPU 采样证据，不将较小负载的通过写为容量达标，也未改变负载、并发或超时。

本轮 0 次新增模型请求，账本仍为 24/24，追加额度尚未收到答复。真实第二轮 usage 差异、完整多端恢复、启动及容量门禁仍未通过；生产不变，整体目标保持 active。下一步继续沿序列化/验证调用次数定位，避免用额外哈希或缓存策略猜测替代实测。证据在同目录 capacity-profiling-outcome.json 和 capacity-diagnostic-192*.json/cpuprofile。


## 2026-10-21：真实 HTTP 原文捕获修复与 usage 边界，整体尚未验收

本批累计真实模型请求 24/24（含失败请求），已到用户授权上限；未自动重试、未改日常模型/凭据配置、未激活生产。后续真实请求必须先获追加额度。所有本批原生探针已终止。

真实 Codex 使用 Code Mode：外层 custom_tool_call 的 call_id 不同于客户端内层工具调用 ID；原文返回为 custom_tool_call_output.output 数组。原生回显会省略 metadata 和 internal_chat_message_metadata_passthrough 两个服务端字段。新增 context-responses-observed-echo.js，仅由独立观察到的服务端输出生成精确备用指纹；入站历史不做宽松投影，原始输出/原文保持完整。绑定、选择、现代私有历史窗口和持久化恢复支持该指纹。v3/v4 实测从两根分裂修复为单根，并观察到 visibleSources=1、24245 字节原文捕获。摘要收据允许受限 metadata/phase，仍拒绝签名与 opaque 内容。

官方 usage.attribution 是输入条目级重复计数，包含条目身份和 content 数组；新增独立校验模块，合法结构不会进入汇总计量或公开 usage，避免重复计费统计及私有条目 ID 泄漏。保持未知/非法计数与可执行对象拒绝。真实首轮 usage 校验与 JSON/SSE 编码已通过诊断，但工具结果回传后的下一轮 usage 仍拒绝，runner 记录 context_recovery_invalid_turn；尚未查清该轮具体差异，不能据此认定恢复链路通过。最后单次诊断使用合成的已有工具调用/数组结果，只支持字段结构诊断，不算真实任务验收。

本轮验证：定向回归 197/197、插件打包/存档测试 16/16；最新新增模块定向覆盖率 statements/lines/functions 100%，branches 98.36%；Lint、CI 配置与发布源码清单检查通过。插件运行闭包重新构建为 25 个模块，没有安装到日常客户端；旧存档升级/回滚的通过结论只对应原固定包，不能扩展为本次新增代理模块的原生回滚/Hook验收。

最新完整客户端运行 1257 项：1255 通过、2 失败、0 取消、0 跳过；覆盖率 statements/lines 99.06%，branches 95.09%，functions 99.27%。仍失败：原有 15 秒启动期限与 60 秒容量资格测试。 独立运行同一五档/两 worker 容量命令也于 60103ms 触发原 60 秒超时，不能归因于覆盖率并行负载。该完整运行期间 attribution 路径校验有后续局部修订，最后源码仅经上述定向验证，仍须完成一次源码冻结后的完整门禁。此前 1254 项运行的 4 失败/2 取消与更早失败证据均保留，没有加长超时、删减五档负载或更改两 worker 配置。

边界与后续：旧二进制可能拒绝新增 echo 指纹字段，旧读取器降级兼容未验收；现代窗口路径支持别名，旧逐项前缀路径不因此获得等价支持。仍待真实 Codex/Claude 三次压缩后精确读回、完整 core HTTP/WS、插件与真实 Hook、WBIPC 事务压缩、启动/容量性能及源码冻结后的全仓门禁。24h 到期样本保留原到期时间 2026-10-22T00:55:55.109Z，尚未到期，不重置样本。

证据：.hpm-acceptance/context-plugin-vault-20261021-01 下 real-codex-http-recovery-v3/v4/v5-result.json、real-codex-http-usage-diagnostic-result.json、real-codex-http-compaction-v6-result.json、real-codex-http-stages-v7-result.json、real-codex-http-tool-array-diagnostic-v4-result.json、real-model-budget.json 与 echo-usage-outcome.json。完整目标保持 active，未宣称整体完成。


## 现有凭据真实客户端基线：连通通过，Codex 三次本地摘要连续性已观察，代理恢复未验收

用户已授权复用现有模型/凭据，以新建合成任务最多发起 24 次真实模型请求、不自动重试并保留日常配置。本批统一账本 real-model-budget.json 已计 8/24 次，包括失败请求；所有原生进程确认终止，凭据仅在内存转发，没有写入临时配置或普通输出。逐阶段转发门禁拒绝第二次请求，未将客户端重试再次转发。

Claude 保持 deepseek-v4-flash，Codex 保持 gpt-6.1-sol；两者真实原生客户端生成及精确合成标记回答通过。首个 Claude 探针重复拼接 /anthropic 导致上游 404，1 次真实请求计入总额；客户端第二次尝试被本地门禁拦截。该失败原样保留。修正后的新合成任务 exit 0、1 次尝试/转发、HTTP 200。新增 scripts/lib/claude-acceptance-target.js 明确只允许 DeepSeek Anthropic messages 路径，正常/空/非法/极端/越界与敏感查询拒绝回归 2/2，通过统一 unit 自动发现；Lint、格式、check:ci 和 release:check 通过。

Codex app-server 真实合成线程执行 seed → compact-1 → compact-2 → compact-3 → final，共 5 次转发、均 HTTP 200，原生 turn 均 completed，观察到 3 个 contextCompaction 完成项，最终准确返回压缩前标记。实际走 /responses 本地摘要路径，未走 /responses/compact；原探针要求远程 compact 的 passed=false 与 compactionVerified=false 原样保留。这只支持“三次真实本地摘要压缩后标记连续性”的分项结论，不支持远程 opaque compact 通过，也不证明代理私有原文读取、插件恢复、Hook 执行或多端无感恢复完整验收。

证据位于 .hpm-acceptance/context-plugin-vault-20261021-01：real-claude-baseline-result.json、real-claude-baseline-v2-result.json、real-codex-baseline-result.json、real-codex-native-compaction-result.json、real-codex-native-compaction-phases.jsonl、real-model-budget.json、real-acceptance-outcome.json。仍待代理原文精确进入后续上游请求/最终任务、Claude 连续压缩、插件/Hook、WBIPC 双预算、容量/启动/存储压力门禁和真实 24h 到期。整体目标保持未完成，生产未激活。


## 独立存档原生升级与回滚验收通过，实际加载版本已确认（整体未完成）

隔离 Codex 原生安装及 app-server 验收确认加载版本 0.1.1 → 诊断 0.1.2 → 0.1.1。初装 30522ms、活动升级 37958ms、回退 37346ms，均在原 60000ms 安装期限内完成。两个活动线程在升级/回退后精确 Unicode/CRLF 原文和绝对到期时间保留，升级后及回退后新线程独立捕获/读回通过。诊断 0.1.2 只用于版本观察，不是产品发布。

自有临时 marketplace 源被物理删除后，从固定 SHA256 存档恢复并完成原生回退；原生安装器仍清理了退役 0.1.2 缓存，该历史完整性门禁仍为 false。独立存档再次恢复校验通过，因此回滚来源无需依赖退役缓存。首次探针因未观察到版本而终止，未执行升级/回退；v2 仅在隔离 MCP launcher 显式传入观察环境，以握手版本作为断言，没有放宽版本门禁。

证据 .hpm-acceptance/context-plugin-vault-20261021-01/native-vault-v2-result.json 与 native-vault-v2-phases.jsonl；原生进程确认终止。0 次模型请求，未变更日常配置或生产。实际 Hook、真实模型连续恢复、旧 0.1.0 首次迁移、容量/启动/存储压力门禁、WBIPC 和 24h 到期仍待完成，不能据此宣布整体交付。


## 插件独立回滚包存档落地：真实整包删除后恢复与启动通过，原生回退验收仍待完成

新增 scripts/lib/local-evidence-plugin-vault.js，以完整文件清单和 SHA256 为寻址身份，在原生可清理缓存之外保存运行包。安装脚本在调用原生 marketplace/add 之前保存待安装包，并在回执记录 snapshotId、版本、文件数与大小；原有日常一次性安装 guard 保留，本轮没有执行日常安装。

存档包含运行模块、SDK 与依赖文件，检查三个包版本身份、lock/SDK 身份及完整 runtime closure；拒绝符号链接、硬链接、未声明根目录、路径越界、缺失/篡改/额外文件、非法 JSON、过深结构和超大文件。文件读取按已检查大小分配有界 buffer，单文件 16 MiB、整包 128 MiB、16384 文件、32 层。先构造并验证独立暂存目录再发布；恢复拒绝覆盖已有目标，写入失败清理本次拥有的暂存目录并返回固定错误，不输出原始路径或内容。

新增 6 项边界/安全/失败回归由统一 unit 自动发现；局部覆盖率语句/行 99.25%、分支 97.67%、函数 100%，门槛通过。与原 MCP/整包删除用例合跑 20/20。Lint、格式、check:ci 与 release:check 通过。没有重跑并声称整体客户端或全仓门禁通过：上一轮完整客户端 1233/1244、5 失败和 6 取消仍保留，容量/启动/存储压力问题没有因包存档而解决。

实际整包探针使用当前暂存 0.1.1，保存 3690 文件、17291656 字节，物理删除自有临时源副本，再从固定 snapshotId 恢复。真实 restored/server.cjs stdio 握手确认加载版本 0.1.1，Unicode/CRLF 精确原文读回及异线程拒绝通过，transport 已关闭、命令 exit 0。此证据只证明独立包来源可恢复并运行，不证明原生 Codex 已从存档完成升级回退，也不关闭旧 0.1.0 首次迁移、Hook 或真实模型恢复验收。旧原生退役缓存完整性失败没有删除或改为通过。

该存档保存插件程序包，插件证据 fallback 仍为 memory-only 30 分钟；它没有把插件改成代理的 24h 加密原文存储，也没有迁移或读取用户原文、凭据、日常客户端配置。WBIPC 仍缺会话发布事务内的双预算压缩/恢复；不能仅放宽 32 MiB 入口而称已落地。

证据 .hpm-acceptance/context-plugin-vault-20261021-01：coverage.log、coverage/coverage-final.json、expanded.log、actual-package-result.json、ci.log、release.log、outcome.json 与源码哈希。本段插入前原文独立备份并逐字保留。整体目标继续，生产未变更。


## 新启动器当前源码完整客户端门禁：1233/1244，整体未通过

原 npm run test:client:coverage 已结束：1233 通过、5 失败、6 取消、0 跳过；测试 323787.6374ms。语句 98.78%、分支 95.02%、函数 99.1%、行 98.78%。没有修改源码、并发量、负载、期限或覆盖率门槛来改变本轮结果。

未通过项目：
- actual isolated proxy captures Chat/Responses/Claude JSON and SSE, then serves exact evidence through generic MCP
- qualification command distinguishes capacity refusal from execution error
- actual encrypted worker startup removes orphan staging and retains committed evidence across reopening
- encrypted worker reopen continues writing after an uncertain publication without exposing its source
- encrypted worker reopens four full session roots with 32 MiB of exact private history
- standalone release uses only packaged files and builtins, reads exactly and exits on EOF
- source runtime API discovers tools, executes once and owns downstream cleanup
- source runtime API startup failure closes transport and exposes a fixed error
- actual startup credential failure drains recovery before reporting failed process exit
- actual management listener rejects requests while credentials are pending and opens entries only after acknowledgement
- core target detection defers protocol-specific validators but the first matching request still validates

本轮完整门禁不能替代为前轮 1241/1242 或局部 14/14。启动、容量、存储的压力稳定性仍需修复；原生升级/回退仍保留退役缓存完整性失败及真实加载版本、Hook、模型验收边界。local-evidence-plugin-package 回归由统一 unit 发现并执行，不在当前显式 test:client:coverage 文件列表；不能把本轮完整客户端门禁说成也执行了整包物理删除回归。该回归单独结果保留在本目录 regression.log/coverage.log。

证据 .hpm-acceptance/context-plugin-cache-release-20261021-01/full-client-coverage.log、独立 full-coverage-final.json 与 full-outcome.json，含覆盖源码/测试/package SHA256。本段插入前另存 full.before 并逐字保留原尾部。无模型请求、日常插件或凭据变更、生产重启；整体目标继续。


## 新启动器跨版本原生探针：活动升级与回退读写通过，退役缓存完整性失败（整体未交付）

隔离 Codex 中以当前待发布 0.1.1 为基线，构造仅版本身份不同、其他行为相同的诊断 0.1.2，再切回 0.1.1。诊断版本只存在于隔离 marketplace，不是产品发布。初装 18767ms、活动升级 41431ms、活动回退 41267ms，原安装命令 60000ms 期限均未改变，全部 exit 0；升级目录发生变化，目标安装闭包 25 模块校验通过。

旧活动线程精确 Unicode/CRLF 原文和原到期时间保留；升级后新线程独立捕获/读取成功；回退后两个活动线程原文/到期时间保留，最终新线程捕获/读取成功。仅证明显式私有 RPC 和目标包身份，不证明真实 Hook、模型恢复或新线程实际加载版本身份。

最后保留原退役包完整性门禁：安装器已清理诊断 0.1.2 的 server/manifest，因此探针在 retired_cache_integrity 断言失败、整体 exit 1。没有删除或弱化该断言来宣称完整升级回滚通过。后续需要由我们维护独立、校验过的回滚包来源，不能依赖原生可清理缓存；旧日常 0.1.0 进程尚有 cwd 锁的首次迁移也未解决。

证据 .hpm-acceptance/context-plugin-cache-release-20261021-01/native-version-result.json、native-version-phases.jsonl、native-version.cjs 与 version-outcome.json。原生进程已确认终止，无模型请求、日常安装/凭据变更或生产重启。当前源码完整客户端门禁另在执行，本段不预判其结果。


## 插件释放 Windows 缓存目录占用：回归 14/14，原生同版本重装通过（整体未交付）

实际 stdio 插件以缓存目录作为 cwd 时，删除整个运行包稳定触发 EBUSY。新增独立启动 helper，先加载模块并创建 runtime，再切换到系统临时目录，最后连接 stdio；普通 factory 使用者不改变 cwd。启动输入拒绝未知字段、访问器与非法函数，失败统一安全错误并尝试关闭 session。主入口只负责装配。

新增真实整包删除回归：含 node_modules 的完整暂存包在进程活动时被物理删除，旧 Unicode/CRLF 原文仍精确读取、新捕获可用、原绝对到期时间不变、异线程拒绝。修复前真实 EBUSY，修复后回归及扩大失败路径覆盖均 14/14；MCP 模块语句/行/函数 100%，分支 90.32%。待发布 0.1.1 的 25 个模块逐一与源码和 manifest 匹配。相关 Lint、格式、check:ci、release:check 在前轮通过；当前新源码完整客户端门禁仍需重跑。

实际隔离 Codex CLI/app-server：初装 17002ms、活动同版本重装 55232ms，均在原 60000ms 期限内 exit 0；最终包完整，活动线程原文与到期时间保留，新线程捕获和精确读取通过。此原生重装证据没有 sentinel/inode 检查，不能证明安装器实际替换同版本缓存；物理删除证据来自独立回归，不能据此宣布跨版本升级回滚或 Hook 执行成功。

证据 .hpm-acceptance/context-plugin-cache-release-20261021-01：baseline.log、regression.log、coverage.log、独立 coverage/coverage-final.json、native-reinstall-result.json、native-phases.jsonl 与 outcome.json。没有模型请求、日常插件/凭据配置变更或生产重启。旧 0.1.0 进程不能追溯释放 cwd，首次迁移和跨版本回滚仍待验收；容量 60s、WBIPC 双预算、真实模型连续恢复、24h 到期及生产激活继续属于完整交付范围。


## 最新分页边界修复与完整门禁：1241/1242，剩余容量 60s 超时（2026-10-21 UTC；整体未交付）

修复实际可复现的页长选择错误：payload 100001 字节、offset 99990、limit 11、预算恰好容纳末页时，旧二分搜索只返回到 99999；因为末页 nextOffsetBytes=null 使编码大小不再严格递增。现在先检查最大候选，保留可完整放下的末页。

分页大小改为精确的小 header 加 UTF-8 文本双重 JSON 编码成本，普通文本直接计字节，转义文本使用本次至多 64 KiB 页范围的有界前缀计数。仍逐次选择合法 UTF-8 边界，返回前对真实 chunk 计算 SHA256，不将用于计尺寸的 digest 占位值作为结果。没有修改页大小、读额度或返回预算。新增全部 ASCII 字符、Unicode/控制/转义、空页/EOF、每一预算值与穷举合法 UTF-8 边界的独立 oracle 比对，以及真实 EOF 回归，直接进入统一客户端覆盖率和 unit 自动发现。

扩大回归 60 项中 59 通过，唯一失败为原容量子进程 60s 超时；分页模块语句/分支/函数/行覆盖率均 100%。候选局部对照显示普通文本和转义文本分页明显减少序列化成本，不能等同整体任务提速。Lint、格式、check:ci、release:check 通过。待发布插件 0.1.1 重新构建后 25 模块都与当前源码/manifest SHA256 一致；这不是日常安装或实际新版 Hook/模型验收。

最新完整 npm run test:client:coverage 已终止 exit 1：1242 项中 1241 通过、1 失败、0 取消、0 跳过，测试执行 280618.7146ms。覆盖率语句/行 99.05%、分支 95.05%、函数 99.26%，门槛通过。本次实际代理启动、暂存清理及三次加密 worker 重开均通过；32 MiB 四根精确私有历史加密重开 162742.7648ms，通过原 180s 期限，仅证明本轮结果。唯一失败仍是原五档、两个 worker 容量资格命令触发原 60000ms ETIMEDOUT，未用局部提速代替该门禁。

证据 .hpm-acceptance/context-page-sizing-20261021-01：旧包模块 page.before.js 与旧 manifest 匹配；comparison-v2.json、scoped/scoped-v2.log、expanded.log、完整 full-client-coverage.log、独立 coverage-final.json 和 outcome.json；回执含当前覆盖源码/测试入口/package 的 SHA256 与插件全部 25 模块校验。本段插入前原文备份并逐字保留。

整体仍待容量期限、WBIPC 双预算恢复、实际 Codex/Claude 连续原文恢复与 Hook、插件迁移回滚、真实 24h 到期和生产激活验收。本轮没有模型请求、日常凭据/插件安装变更或生产重启；不能宣布全面交付。


## 最新容量性能迭代：单元素安全克隆已验证，60s 门禁仍未通过（2026-10-21 UTC；整体未交付）

对恢复历史准入的单元素嵌套数组使用 array literal 创建 own data slot，保留每槽 descriptor、原型、key 数、循环、深度、共享节点、单项 2 MiB 与总字节门禁；不调用继承数字 setter。原多元素和未知结构继续走既有完整校验。新增 exact Unicode/CRLF、独立冻结副本、深度边界、own accessor/iterator、隐藏槽、伪装空洞、循环、字节溢出及隔离子进程 index-zero setter 回归，直接进入已有统一 CI 的 context-binding 测试文件。

相关绑定/会话覆盖率回归 83/83：修改模块语句/函数/行 100%、分支 98.07%，阈值通过；Lint、格式、check:ci 与 release:check 通过。包含原容量资格命令的扩大回归 93 项中 92 通过、1 失败、0 取消/跳过；唯一失败仍是原 60000ms ETIMEDOUT。之前 1237/1238 完整门禁保留在下方，但它不是本次新源码的完整覆盖率验收。

重新对原五档和原两个 worker 的容量命令做 CPU 诊断：全部画像结束，最大档 1920 轮、400 次精确恢复、20 次 JSON 重开及最终 drain 完整；本次采样总时长 62651.631ms，最慢 worker 62249.427ms。诊断没有把超过 60s 的结果算作期限内通过，也不代表 transport/durable/model 验收。旧采样约 88.7s 与本次 62.7s 的差异同时受代码和系统负载影响，不归因为单个小优化。当前仍需容量提速，不能宣布全面完成。

另有 .hpm-acceptance/context-encoding-token-20261021-01：请求内编码 token 复用候选摘要相等，但交替基准无稳定收益，未应用运行代码；同目录保留改动前原容量 60s 单独失败证据。单元素候选交替基准、初始深度测试断言失败与修正后结果、当前 CPU 原件、cpu-summary.json、coverage/coverage-final.json、regression.log 和当前源码 SHA256 回执存于 .hpm-acceptance/context-single-array-20261021-01。

未改变五档负载、两个 worker、容量/存储/启动期限或覆盖率门槛；没有模型请求、凭据或日常插件改动、没有生产重启。整体仍包含 WBIPC 双预算、实际 Codex/Claude 连续恢复与 Hook、迁移回滚、真实 24h 到期和生产激活等未完成验收。


## 最新完整客户端门禁：1237/1238，剩余五档容量 60s 超时（2026-10-21 UTC；整体未交付）

恢复状态克隆优化后，按当前源码再次执行原 npm run test:client:coverage，prepare、并发量、两个容量 worker、全部画像、期限与覆盖率阈值均保持原值。进程已终止 exit 1：1238 项中 1237 通过、1 失败、0 取消、0 跳过；测试执行 284678.9037ms。覆盖率语句/行 99.04%、分支 95.01%、函数 99.26%，覆盖率门槛通过。

上一轮四处未通过中，本次实际 Chat/Responses/Claude 代理与 direct-upload 均通过原 15s 启动门禁；首次真实请求分别 2835ms、2115ms。暂存清理及三次加密 worker 重开 18557.9696ms，四个完整 session root 的 32 MiB 精确私有历史加密重开 173483.4748ms，通过各自原 30s/180s 期限。32 MiB 仍接近上限，且这些是本次结果，不能据此宣称压力稳定性已验证或把多次运行差异全部归因于克隆优化。

唯一失败仍是 qualification command distinguishes capacity refusal from execution error：保留五档画像和两个 worker 的容量资格子进程约 60150ms 触发原 60000ms ETIMEDOUT。下一步继续针对容量真实热点优化，不缩减负载或改超时制造通过。当前整体还包含 WBIPC 双预算恢复、实际 Codex/Claude 多轮原文恢复/Hook、插件迁移回滚、真实 24h 到期与生产激活等待完成，不能把 1237/1238 当作全面交付。

证据：.hpm-acceptance/context-root-cpu-20261021-01/full-client-coverage.log、coverage-final.json、full-outcome.json（覆盖源码/统一测试入口/包脚本当前 SHA256）。本段插入前原文另存 .full.before 并逐字保留。本轮模型请求为 0，没有改日常凭据、安装插件或重启生产。


## 最新恢复状态克隆优化：扩大回归 168/168，完整并发待重验（2026-10-21 UTC；整体未交付）

对原 32 MiB 四根历史真实加密重开做 CPU 采样，单独用例通过，107684.5072ms。主线程和两次存储 worker 的采样中，恢复状态 clone 合计 self 约 26.6s，是最大的应用代码热点。完整 CPU 原件和摘要保存在 .hpm-acceptance/context-root-cpu-20261021-01。

恢复状态数组克隆改用 null-prototype length carrier 的 Array.from own data-slot 构造，保留源数组原型、own-key、逐槽 data descriptor、递归深度、共享节点与精确 JSON 字节校验。不会通过继承数字 setter 或调用者/继承 iterator 构造内容；不新增全局原文缓存。新增继承 iterator、伪装空洞、隐藏槽与访问器、空数组字节边界回归，纳入既有统一 CI 测试文件。局部交替基准中位 45.40→35.48ms，约 21.8% 改善，仅代表克隆基准。

实际 root-state、storage、storage-service、lifecycle、private-capacity 五个文件扩大回归 168/168，通过且无跳过或取消，156703.4291ms；其中 32 MiB 四根历史重开 106882.758ms、暂存清理及三次重开 12154.0915ms。另有六项针对性回归、相关 Lint/格式、check:ci 与 release:check 通过。此处扩大回归不等同完整客户端并发：没有宣称端到端提速、容量 60s 或启动 15s 已修复，下面保留最近完整门禁的四处未通过记录。

证据含 scoped.log、CPU 原件、cpu-summary.json、clone-comparison.json、normalizer.log、regression.log、改动前源码及 outcome.json 的当前源码 SHA256。未改期限、容量画像或 worker 数；未调用模型、改日常凭据/插件或重启生产。整体目标仍待完整并发和多端实际模型、WBIPC 双预算、迁移回滚、真实 24h 到期及生产激活验收。


## 最新完整客户端门禁：延迟 core 初始化后 1232/1236 通过（2026-10-21 UTC；整体未交付）

主入口通过独立 lazy core 工厂推迟请求处理模块加载；恢复生命周期仍在启动阶段组合。首次请求保持原来的认证、验证和分发，初始化失败可重试。新增回归已进入统一客户端覆盖率入口；局部扩展验证 13/13，Lint、格式、CI 入口检查和发布清单检查通过。

完整并发 npm run test:client:coverage 已终止，exit 1：1236 项中 1232 通过、2 失败、2 超时取消、0 跳过，测试执行 310705.7957ms。覆盖率语句/行 99.04%、分支 95.01%、函数 99.26%；覆盖率通过不代表行为门禁通过。

四处未通过：实际 Chat/Responses/Claude 代理启动 15s、五档容量子进程 60s、孤立暂存清理及加密 worker 三次重开 30s、四个完整 session root 的 32 MiB 私有历史加密重开 180s。所有期限、画像、两个 worker 和并发量保持原值。direct-upload 本次启动 11007ms、首次请求 2316ms；其中延迟 core 加载约 1974ms。该样本只证明真实请求执行到了延迟模块，不能证明并发启动已修复。

证据目录 .hpm-acceptance/context-startup-lazy-core-20261021-01：完整日志、coverage-final.json、outcome.json、局部 expanded.log 及 lint.log。outcome 记录覆盖源码和测试入口的当前 SHA256；本段插入前原文已备份并逐字保留。模型请求为 0；未修改日常凭据、插件安装或重启生产。下一步按完整门禁暴露的阶段瓶颈继续处理，整体仍待性能、WBIPC 双预算、真实客户端/Hook、回滚与真实 24h 到期验收。


## 最新回滚候选：新目录恢复旧行为可保留活跃读回，但旧缓存仍不完整（2026-10-21 UTC；整体未交付）

在全新隔离环境中，将真实 0.1.0 的 13 个模块制作为仅用于诊断的 0.1.2 包：12 个模块逐字节不变，MCP 模块仅将握手版本标识从 0.1.0 改为 0.1.2；同步调整包身份和清单摘要，没有修改日常安装包、源码行为或生产配置。该诊断包不是正式发布版本，也不是当前 0.1.1 的后续交付包。

原生 CLI 安装 0.1.0、升级 0.1.1、安装旧行为的新目录 0.1.2 分别约 30089/40836/37138ms，均在原 60000ms 安装期限内成功。各安装的独立 stdio 握手版本均验证；切换后原有 0.1.0 与升级后新建的两个活跃会话均仍可精确读取其原文、expiresAt 不变。它们都属于隔离私有 RPC 的合成证据，没有真实 Hook 或模型调用。

最终完整性门禁失败：0.1.0、0.1.1 目录仍存在，但 server.cjs 与 runtime-manifest.json 均已消失；只有诊断 0.1.2 的 13 模块仍完整匹配清单。新版本目录安装也不能保证旧缓存文件保留，之前的 oldCacheRetainedAfterUpgrade 仅检查目录存在，不足以证明缓存可重用。当前证据不能确定每个旧文件具体在哪一次安装被清除；不据最终状态杜撰删除顺序或原生内部实现。

结论仍为整体回滚不通过：本次只证明两代已运行的内存会话在切换后读回连续，不能证明惰性依赖、进程重开、实际 Hook 或新模型请求都安全。探针按原门禁在完整性失败处停止，没有执行后续新回滚线程验收。下一步需解决服务进程工作目录与安装缓存的生命周期耦合，并验证运行期间移除旧包时模块可用性；不能只靠递增版本号或跳过完整性检查交付。

证据：.hpm-acceptance/context-plugin-forward-rollback-20261021-01/ 下 migration-v5-result.json、phases.jsonl、outcome.json。失败终态及隔离目录保留；各原生子进程已退出、日常 0.1.0 模块哈希仍匹配原清单。当前覆盖源码和测试文件仍匹配上一轮完整门禁回执：1230/1233，剩余两项启动和一项容量超时；没有修改运行代码来试凑通过结果。容量、WBIPC、实际客户端和其他完整目标继续保留。


## 最新完整客户端门禁：1230/1233 通过，剩余启动与容量超时（2026-10-21 UTC；整体未交付）

按当前源码重新执行 npm run test:client:coverage，含原有 prepare 与完整并发，1233 项中 1230 通过、3 失败、0 取消、0 跳过，测试执行 258639.8836ms，进程 exit 1。覆盖率阈值通过：语句/行 99.04%、分支 95%、函数 99.25%；覆盖率通过不抵消行为测试失败。

之前未通过的孤立暂存清理/加密 worker 重开，以及四个完整 session root 的 32 MiB 私有历史加密重开，本次都在完整并发下通过。这只记录该次结果，不删除此前失败或声称压力稳定性、真实客户端和生产已经验收。

剩余三个失败：实际隔离 Chat/Responses/Claude JSON+SSE 代理与 direct-upload 代理各触发原 15000ms 启动期限；五档原容量资格命令触发原 60000ms 子进程期限。没有改变五档画像、两个 worker、并发量、容量和存储期限或覆盖率门槛。一次启动已到 module_graph_ready 约 13.1s、servers_created 约 14.9s，尚需完成安全凭据落盘和监听，不能靠缩减健康检查或延长期限宣称修复。

证据：.hpm-acceptance/context-client-current-gate-20261021-01/client-coverage.log、独立保存的 coverage-final.json 与 outcome.json；回执包含当前覆盖源码和客户端测试入口文件 SHA256。另有 .hpm-acceptance/context-fingerprint-buffer-20261021-01/comparison.json：局部摘要分块候选在长历史上仅约 2% 改善，未应用到运行代码，不能算容量修复。日常配置、插件和生产未因本轮门禁改动；整体仍待性能修复、实际 Hook/多端模型、WBIPC 双预算、回滚和真实 24h 到期等验收。


## 最新回滚定位：活跃旧缓存重装失败并留下不完整目录（2026-10-21 UTC；整体未交付）

补充带阶段计时的隔离验收：同步 CLI 演练在升级阶段达到原有 60000ms 安装期限，尚未到回滚。另起全新隔离环境，用异步管道持续消费活跃 app-server 输出，保持同一 60000ms 安装期限；旧版安装 21503ms、升级 42599ms 成功，已安装 stdio 身份握手、升级前原文精确读取和原 expiresAt 保持、新线程独立读取适配均通过。不能据此认定同步阻塞是前一轮超时的唯一原因。

这次活跃回滚在安装 CLI 内经过 28498ms 返回 exit 1，非超时，也未进入回滚握手。只保存错误词类 cache/used，不输出原始诊断。失败后只读检查发现 0.1.0 目录仍存在，但 server.cjs 与 runtime-manifest.json 均已消失；0.1.1 的 25 个模块仍全部匹配清单。因此目录存在不等于旧版本可用，不能采取未经验证的旧缓存复用或把失败当成无副作用。

独立 Windows 对照用自有子进程占用自有空目录作为 cwd：非递归 rmdir 返回 EBUSY，观察子进程退出后相同空目录可以删除。这支持 cwd 占用机制与上述原生失败相容，但尚未取得原生系统调用级因果证明，不把对照误写成原生错误码。失败后活跃旧会话是否仍可读未继续验收，不作保留成功声明。

回滚约束：不得在活跃宿主仍使用目标旧缓存时原地重装该版本。后续交付需要受控退出后的冷态恢复，或宿主支持且经过验收的不覆盖缓存切换；目前后者未实现、未验证。受控退出会丢失旧插件的内存证据，因此不能据冷态安装通过声称旧会话连续性或 24h 加密持久化兼容。代理新版本加密 root 的保留、权限、到期及关闭恢复后回滚仍须独立验收；不要清除新 schema 或延长旧记录期限。

证据：.hpm-acceptance/context-plugin-active-rollback-20261021-01/migration-v3-result.json，以及 .hpm-acceptance/context-plugin-async-migration-20261021-01/ 的 migration-v4-result.json、phases.jsonl、failure-inspection.json、cwd-control.json、outcome.json。所有相关子进程均观察到终态，没有模型生成请求、凭据传递、日常配置改动或生产重启。日常旧插件 13 个模块哈希与先前清单一致，源码仍匹配此前 60/60 门禁所记录哈希；本轮没有新增完整代码门禁通过声明。实际 Hook、客户端三次连续压缩、性能/容量/并发存储、WBIPC 双预算和真实 24h 到期要求继续未完成。


## 最新原生验收：隔离 Codex 安装和升级读取通过，活跃回滚未通过（2026-10-21 UTC；整体未交付）

使用当前 Codex 0.160.1 原生 plugin marketplace/add 与 app-server，在新建隔离 CODEX_HOME 中安装 0.1.1：25 模块逐文件匹配当前源码及清单，实际已安装 server.cjs 的 stdio 握手版本为 0.1.1。原生宿主发现的模型可见工具仅为两个读取工具；通过宿主私有 RPC 注入合成完成事件后，精确换行/Unicode 读取与第二线程拒绝读取通过，新会话初始为空，相关原生子进程退出已观察到。

这仍是原生安装/MCP 适配证明：隔离 Hook 已发现且 enabled，但 trustStatus 为 untrusted，没有自动信任或执行真实 Hook。没有模型调用、没有旧聊天读取或凭据传递；不得把显式私有 RPC 注入当成实际 PostToolUse 捕获，更不能当成多次模型压缩后恢复验收。

升级/回滚演练先在探针 30000ms 期限失败；补充诊断显示安装器约 42330ms 可完成切换。项目既有正式安装器本来使用 60000ms，因此另起隔离演练按这个既有边界复验，没有修改正式安装器或容量/启动门禁。该演练 0.1.0→0.1.1 升级后，原会话原文仍可读、原 expiresAt 保持不变，升级后新建会话可加载并完成独立读取适配。旧插件默认的 30 分钟内存留存没有被冒充为新的 24h 加密留存。

同一演练在活跃会话下退回 0.1.0 的阶段未通过，具体失败仍需进一步定位；已经关闭相关会话后，独立原生重新安装 0.1.0 在 34794ms 完成。后者只证明冷态重装，不能证明活跃会话回滚与旧原文连续性。故升级证据保留，回滚、实际 Hook 和多端模型验收继续标为未完成，不据此升级日常插件。

证据：.hpm-acceptance/context-plugin-native-011-20261021-01/，含 native-result.json、migration-result.json、install-diagnostic-60s.json、migration-v2-result.json、rollback-diagnostic.json、outcome.json；首轮失败与后续诊断均保留，隔离目录保留用于核对。所有原文为新建合成数据，RPC 方法白名单不含 turn/start 或其他模型生成操作。日常 0.1.0 插件的 13 个副本仍匹配先前哈希，未修改日常配置、未重启生产。前一轮 60/60 代码门禁对应源码哈希仍一致，但本轮没有新增完整客户端门禁通过声明；此前启动、容量、存储并发、WBIPC 双预算、真实 24h 到期与整体落地要求均未关闭。


## 最新交付包修复：可选插件 0.1.1 暂存包与当前源码一致，尚未安装激活（2026-10-21 UTC；整体未交付）

重新核对真实安装缓存：hpm-local-evidence 0.1.0 的 13 模块清单与其副本一致，但更新前有 8 个副本不同于当前源码；仓库暂存包有 4 个旧副本。不能把旧安装收据当成本轮交付。现已生成 0.1.1 暂存包：兼容 manifest、portable 模板、package/lock、MCP 握手版本一致；25 个依赖模块逐文件匹配当前源码与 SHA256 清单，运行目录没有清单外 JS。SDK 仍直接固定 1.31.0，没有升级依赖或改动已安装客户端。

发现并修复构建器保留退役生成模块的问题：读取有大小、数量、路径和摘要校验的旧清单，只删除清单声明且摘要不变的退役文件；全部候选验证后才删除，拒绝用户改动、链接/硬链接及权限错误，不递归删除目录或处理清单外用户文件。三个历史孤立副本与旧已安装模块哈希一致，已单独备份后移出暂存包。负例回放旧构建器可复现新增回归失败；当前构建器通过。

最新相关覆盖率回归 60/60、无失败或取消，MCP 入口和新退役边界共 129/129 语句、61/61 分支、6/6 函数全部覆盖。包含实际无凭据 stdio 子进程、暂存 server.cjs 握手、精确换行/Unicode 回读、跨线程拒绝、旧包残留检测、异常清单与链接/文件系统失败。已有测试文件由统一 unit/客户端入口发现；相关 Lint、格式、CI 入口与发布清单检查通过。此证据不等于 Codex 实际 Hook、多次模型压缩或已安装 0.1.1 加载验证。

完整五档合成容量诊断另跑完毕，最大四任务 1920 轮、400 次精确恢复及最终 drain 均完成，但 CPU profile 总时长约 88677ms，明确超过原 60000ms 资格期限。该无期限诊断不替代资格门禁，也不证明传输或持久化存储容量通过。最新热点仍在归一化 clone、规范编码和 SHA 更新；ASCII 正则候选未改善、对象编码循环候选约 2% 差异，均未应用。没有修改工作量、worker 数、并发或门禁期限。

证据：.hpm-acceptance/context-capacity-current-profile-20261021-01/，包括 plugin-static-inventory.json、plugin-static-inventory-after.json、staged-before/、version-before/、orphan-backup/、orphan-retirement.json、old-builder-negative.log、covered-complete.log、profile.log、profile-summary.json、outcome.json。安装缓存 13 个旧副本与其原清单仍逐字节哈希一致，未 reload、未改日常配置、未发模型请求、未重启生产。整体尚待完整门禁、WBIPC 双预算、真实多端多次压缩、最终安装迁移回滚、真实 24h 到期和生产验收；先前五项全量并发失败仍未关闭。


Latest candidate-default increment (2026-10-20): both built-in defaults and the
first-start example select policy version 2/native-first with recovery and
capture disabled. Existing files without metadata retain version 1. Runtime
diagnostics observe the actual shared planner options; a matching selection is
distinct from full route or installed-client qualification. The isolated proxy
test observes legacy at startup and native-first after explicit migration.
Frozen related tests passed **320/320**, the full client coverage command passed
**1092/1092**, and frontend **28/28**, coverage/build/governance passed.
Evidence: `.hpm-acceptance/context-native-defaults-20261020-01/receipt.json`.
This is candidate source evidence, not a current package, installed-host,
startup-stability or production acceptance claim. See
[implementation status](./context-recovery-implementation-status.md).

Latest explicit migration increment (2026-10-20): management preview/apply and
the browser/desktop controls retain saved recovery and persistence preferences.
Revision checks, the shared config queue and a post-commit external-write check
prevent a stale page from adopting another writer's revision. Native migration
explains evidence-dependent old-chat limitations. A saved response reports
runtime application as pending, never installed-host acceptance. Final backend
tests passed **32/32** with coverage/governance; unchanged frontend/Rust hashes
retain the first freeze's **28/28** frontend, coverage/build and **2/2**
compiled bridge checks. Evidence:
`.hpm-acceptance/context-policy-migration-20261020-02/receipt.json` and its
referenced first freeze. Final backend changes invalidate the earlier staged
runtime: final packaging, installed hosts, defaults and production remain
unqualified. See
[implementation status](./context-recovery-implementation-status.md).

Latest WorkBuddy continuation (2026-10-20): version 2 native ordinary requests
preserve the complete window without automatic folding, archival, history
branches, private reads, background summaries or payload-compaction retries.
Explicit compaction remains separate and captures no recovery evidence in native
mode. Tool identity checks remain enforced; old containers requiring evidence
return a fixed 409 rather than regaining authority. Actual isolated proxy
processes cover Chat, Responses and Messages admission against a synthetic local
host. The new negative control found a missing startup route-policy dependency,
now fixed. Final frozen tests passed **297/297** across 59 files, with
four-module coverage and format/lint/governance/gateway-build checks passing;
the first failed run is retained. Evidence:
`.hpm-acceptance/context-native-workbuddy-20261020-02/receipt.json`. New
defaults, migration UX, full client verification, installed hosts and production
remain unqualified. See
[implementation status](./context-recovery-implementation-status.md).

Previous generic-budget continuation (2026-10-20): startup and hot reload now
compose the same trusted policy capability. Version 2 preserves the complete
generic request window and reports overflow without folding or dropping history;
explicit provider-native management retains its bypass. Frozen scoped tests
passed **79/79**, with three-module coverage and
format/lint/governance/gateway-build checks passing. Evidence:
`.hpm-acceptance/context-native-budget-20261020-01/receipt.json`. WorkBuddy
proactive/background/retry integration, new defaults, full client verification,
installed hosts and production remain unqualified. See
[implementation status](./context-recovery-implementation-status.md).

Previous policy metadata continuation (2026-10-20):
`appSettings.contextPolicyVersion` is strictly parsed (absent/1 retains legacy
intent; 2 records the new selection). Full configuration saves reject losing or
lowering an existing version-two marker and refuse to overwrite unknown
versions. Diagnostics and plain-text UI separate migration/selection from
`plannerApplication:unverified`; frontend normalization and saving preserve
metadata. Frozen related validation passed 21/21, full frontend 27/27, coverage,
source gates and build. Default config and request planners are unchanged, and
no migration-apply workflow or installed-host activation is claimed. The full
client command was not repeated for this snapshot; see
`context-policy-version-20261020-01/receipt.json` and the implementation status.

Latest storage continuation (2026-10-20): duplicate target observations at
native ACL boundaries and duplicate authentication/decryption during
ordinary-row pruning are removed while retaining target and ancestor checks,
semantic validation and atomic rollback. Frozen expanded validation passed
140/140; the actual original full client command then passed 1081/1081 on the
same unchanged source/test snapshot, with coverage gates passed
(`context-storage-boundary-20261020-02/receipt.json` and `client-receipt.json`).
This supersedes historical descriptions of the latest client result below.
Earlier startup failures remain recorded; one full pass does not establish
permanent startup stability. Native-first migration, capacity, multi-client
binding, installed-host and production qualification remain incomplete.

Latest runtime policy continuation (2026-10-20): settings disable and storage
mode changes now suspend admission and invalidate old capabilities without
deleting committed originals. Expiry and cumulative budgets remain unchanged;
fresh current-request authorization is required after enabling. Explicit clear
and low-level configure/revoke APIs retain their destructive contract, and
explicit principal revocation wins suspension races. The second frozen expanded
gate passed 602/602 with source and coverage checks. The actual full client
command passed 1079/1080 with one unchanged 30-second encrypted-worker reopening
timeout; coverage passed, but the command exited 1 and overall qualification
failed. Source/test hashes remained unchanged. The first frozen run's two
startup cancellations remain recorded. Cold disabled persistence preference
remains lazy. Full native-first migration, capacity, startup variance,
installed-host and production qualification remain incomplete; see the
implementation status for current evidence.

Latest recovery continuation (2026-10-20): cold reference admission now
preserves unpublished source descriptors as quarantined ledger entries, allowing
durable reader/publication writes after interruption while keeping snapshot
visibility denied and original accounting/expiry intact. The frozen scoped gate
passed 544/544 with coverage, format, lint, gateway rebuild and governance
checks. Evidence:
`.hpm-acceptance/context-recovery-interrupted-write-20261020-01/receipt.json`.
This does not qualify installed plugins, real hosts, full-client startup
deadlines or production; see `docs/context-recovery-implementation-status.md`
for the current incomplete-delivery boundary.

Latest engineering continuation (2026-10-13): the actual Hook gate passes with
owned-tree termination and primary-error-preserving cleanup; seven lifecycle
regressions passed. The c8 report command now matches the security checker's
`coverage/proxy` path, with a before-fix failure and three passing focused
command/path tests. The 1477-file frozen literal `verify` remains failed on four
subprocess/startup cases; passing serial diagnostics do not qualify the full
suite or prove concurrency is the only cause. Startup phase evidence, exact gate
results and receipts are recorded in the newest section of
`docs/context-compaction-delivery.md`. No installed plugin/configuration update,
production restart or paid model request occurred. Historical notes below do not
supersede this incomplete-delivery verdict.

Latest offline qualification (2026-10-13): all 311 authorized research files
were formatted with semantic preservation and recoverable originals. The
working-tree format gate passed at that point. On a coherent 1468-file frozen
snapshot, 170 client tests, frontend gates, 16 Rust tests, warnings-denied
all-target Clippy and npm/Windows Rust audits passed. Literal `verify` and the
follow-up backend/integration/actual Git Hook gates remain failed; startup
readiness has not been diagnosed as concurrency-only. Six subsequently changed
working-tree files, including API-evidence HTTP and WorkBuddy recovery, are not
qualified by that older snapshot. No installed plugin/configuration update,
production restart or paid model request occurred. See the latest section of
`docs/context-compaction-delivery.md` for receipts and remaining gates.

Previous offline continuation (2026-10-13): the generic gateway CLI rejects
malformed owner arguments before importing the MCP SDK, without changing its
argument bounds, error text or deadlines. The independent parser remains
available through the runtime's compatibility export. Two added startup
regressions enter the existing unified client/CI suites. Current client coverage
passes 170 tests; actual installed-client activation is still pending.
Whole-workspace formatting remains blocked by 311 separate Tianxi research
artifacts. See `docs/context-compaction-delivery.md` for the explicit sharded
backend qualification and remaining aggregate/release gates.

## Generic MCP gateway: repository implementation, not an installed upgrade

The common path no longer requires a Codex Hook. Any compatible stdio MCP host
can connect to `scripts/start-evidence-mcp-gateway.js`, which connects to one
owner-selected downstream MCP server. It observes that connection's immediate
tool calls and provides the existing retained-evidence list/read tools plus
`hpm_list_execution_records`. The model cannot select a command, environment,
owner, thread or evidence scope. No OpenAI API call is made by this gateway.

Run from the repository, using an absolute downstream entry path where the host
has an unpredictable working directory:

```powershell
npm run build:evidence-gateway
node scripts/start-evidence-mcp-gateway.js -- node C:\approved\server.cjs
node scripts/start-evidence-mcp-gateway.js --offload-bytes 16384 --forward-env MCP_SERVER_SETTING -- node C:\approved\server.cjs
```

For a host's MCP configuration, select the Node executable and the absolute
`scripts/start-evidence-mcp-gateway.js` path directly so npm lifecycle output
cannot enter the protocol stream. The repository launcher uses a prebuilt SDK
bundle under `runtime/evidence-gateway/`; it validates the bundle digest, local
source/lock digests and Node major before loading it. Rebuild after changing
those inputs or the Node major. Missing, stale or corrupt artifacts fail with
the fixed startup error instead of falling back to the slower source graph. Unit
and client coverage npm entry points prepare this artifact automatically. This
workspace build does not establish installed-package or upgrade eligibility.

Release runtime staging now includes a separate
`scripts/start-packaged-evidence-mcp-gateway.js` entry and release-only
manifest. That manifest binds the pruned release package/lock and fixed launch
files; it does not require a development checkout or external npm modules.
Configure a host to use the release's own Node and the absolute packaged entry
path:

```powershell
& C:\approved\hpm-runtime\runtime\node\node.exe C:\approved\hpm-runtime\scripts\start-packaged-evidence-mcp-gateway.js -- C:\approved\hpm-runtime\runtime\node\node.exe C:\approved\server.cjs
```

Use owner-selected runtime and downstream paths. The isolated release
qualification exercised this entry with the bundled Node, a synthetic source
using only builtins, and a guard blocking repository/npm imports. This does not
establish MSI installation, upgrade/rollback behavior, or real installed
Codex/Claude acceptance. Staging changes no installed host configuration.

`--forward-env NAME` is repeatable and is owner configuration, not a tool
argument. The selected variables must already exist in the gateway process's
environment. Values are never read from credential files or printed. Only those
names are forwarded in addition to the SDK's safe default inherited environment.
Selection rejects missing/empty values, case-insensitive duplicate names,
accessors, invalid UTF-8/NUL, runtime-loader injection names, more than 32
names, more than 16 KiB per value or more than 64 KiB in total. This adds a
capability; it does not forward any real credentials or modify installed
configuration by itself. Do not put secrets in command-line arguments.

The gateway's limits and semantics are deliberately explicit:

- One connection is one scope. Independent connections cannot read one another;
  several chats multiplexed onto the same connection share that scope. This is
  **not** a substitute for trusted chat identity. The existing Codex Hook is an
  optional adapter for host identity and tools outside this gateway.
- Execution observations contain no arguments or output. `completed` means a
  valid MCP result returned, `failed` means an error result returned, and
  `unknown` means transport/cancellation/invalid-result uncertainty. All remain
  `verification: not_verified`. None of these states authorizes a retry.
- Results are normalized JSON, not asserted byte-for-byte wire encoding. The
  normal response is unchanged after normalization. Retention uses the existing
  memory-only 30-minute absolute TTL, 64-source/4-MiB total/1-MiB per-source
  limits. Execution observations have a separate 128-record cap; each reader has
  a 64-call/512-KiB budget and at most 16 KiB per response. Restart loses
  evidence.
- Offloading is opt-in. Only one simple text block without output schema,
  structured content, metadata or multimodal content can be replaced. The full
  normalized MCP result must be retained **before** a bounded preview/reference
  is returned. Rejection, expiry or quota failure leaves the original result.
  Follow all evidence pages until `page.nextOffsetBytes` is null and verify the
  complete source digest. Missing evidence means unavailable, not reacquisition
  authority.
- Offload admission also plans the complete source's real encoded reader pages,
  including JSON escaping, receipt metadata and result envelopes. Existing
  reader expenditure and all outstanding offloaded sources count against the
  unchanged 64-call/512-KiB budget. An individually or collectively unreadable
  result is returned in its original normalized form, not just a preview or
  reference; successful capture is not falsely labeled failed. References
  include `readerOptions.limitBytes: 16384` for the qualified paging plan. A
  known valid reference can be read directly; index lookup is needed when the
  receipt is unknown. No fresh-index requirement is imposed on ordinary
  recovery.
- Admission reservations are conservative optimization accounting, not a new
  quota or permission. Partial/seeking/duplicate reads do not release them;
  complete contiguous readback and full-source digest verification do. Source
  expiry is reclaimed on the next capture, without renewal; close clears all
  reservations. Future expiry/restart or spending the budget on other/invalid
  reads can still make evidence unavailable. Reservations do not bypass actual
  reader limits or authorize reexecution.
- Tool catalogs are capped at 512 tools/2 MiB/16 pages. Input and output schemas
  are checked for unsafe patterns and remote references before compilation;
  outputs with a schema require valid structured content except for error-only
  replies. Raw SDK protocol requests avoid precompiling unchecked downstream
  schemas. Invalid results are not retained as completed evidence.
- Only immediate tools are supported. Task-only catalogs fail closed; optional
  downstream task support is explicitly advertised as forbidden here. Task
  creation receives a fixed protocol error without dispatch. Sampling,
  elicitation, resources, prompts and task lifecycle are not advertised or
  silently synthesized. Dynamic catalog changes are refreshed atomically; only
  bounded monotonic numeric progress is forwarded, never progress message
  content. Dispatch concurrency is capped at 16; downstream requests time out
  after 60 seconds and are never automatically retried. Downstream stderr and
  raw exceptions are not relayed.

The generic-host transport tests use real SDK in-memory and stdio subprocess
chains, independent connections, synthetic environment values and retained
outputs. The labels `codex-compatible-fixture` and `claude-compatible-fixture`
do **not** establish actual installed Codex or Claude acceptance. Paid-model
strict multi-compaction qualification, API-observer real-model acceptance,
persistent retention, installed gateway adoption and production activation
remain separate requirements, not accomplished by these tests.

The generated repository Hook-plugin closure now contains **18 modules** after
moving retention/readback into the shared proxy core and sharing the exact page
budget contract with offload admission. The historically installed cache
described below still contains 13. No reinstall, Hook trust change, provider
configuration change, model request or production restart is implied by
repository package generation.

## Generic API evidence: current source, disabled by default

`appSettings.contextEvidenceEnabled` defaults to `false`. The implementation
supports prospective client-reported tool results in Chat Completions, Responses
and Claude Messages, including terminal JSON/SSE and the direct-upload path. It
leaves native requests and opaque/canonical compaction state untouched. An
initial request cannot seed evidence from an old conversation history.

With entry authentication and the explicit setting enabled, the owner creates
one connection using `POST /v1/context-evidence/session` with `{}`. The issued
`x-hpm-evidence-token` must accompany that connection's inference requests and
`POST /v1/context-evidence/mcp` requests. The MCP endpoint is a standard
stateless Streamable HTTP server exposing only the existing list/read tools.
`DELETE /v1/context-evidence/session` invalidates the capability. The token is
stored hashed, bound to the entry principal and permission snapshot, redacted
from logs/replay and stripped before upstream dispatch. Configured browser
origins can preflight the header only while the feature is enabled. Desktop
requests still require their additional Desktop authentication.

One token is an explicit connection scope, **not** automatic chat identity. API
results are labeled `observation: client_reported` and
`verification: not_verified`: seeing a reported result is not independent proof
that a client executed a tool or achieved a business outcome. The API reader has
no executor or capture endpoint. Standard MCP clients may use this common
readback mechanism without a Codex Hook, but the host still owns session wiring.

Retention is memory-only with a 30-minute absolute session TTL; restart loses
it. There are at most 16 sessions globally and four per principal. Session
retention and reader budgets remain unchanged. Calls/tombstones are capped at
128 per connection; observation leases are capped at 16 globally and four per
connection. Inference observation is bounded to 2 MiB, HTTP MCP input to 16 KiB
with a 10-second upload deadline. Overload, failed/cancelled/incomplete streams
and secret-bearing results cannot manufacture completed evidence.

The 2026-10-13 follow-up passed real isolated proxy JSON/SSE and direct-upload
regressions, HTTP SDK MCP isolation and transport-failure checks, plus callback,
Desktop/CORS and no-replay boundaries. These are local engineering results, not
production activation or actual installed Codex/Claude-host acceptance. The
repository plugin closure was regenerated; the installed cache was not updated.

`scripts/verify-generic-evidence-compaction.js` is a separately authorized,
one-shot real-model harness. Its request cap is 12 including failures and
compaction, with no automatic retries/failover. The workload uses opt-in MCP
result offloading, two preserved whole native windows, fresh exact reader input,
and unavailable evidence without source replay. It does **not** assert native
detail loss or representative long-task quality/economics. Offline tests use a
real stdio gateway/source and a model fixture; they consume no real-model
requests. Its terminal receipt is the authoritative live verdict.

### Generic real-model acceptance on 2026-10-13

The single authorized `run1` attempt terminated after **10** requests, including
two native compactions, with **strict failure**. All ten requests were HTTP
200/completed on the independently verified authorized official route. Each
recovery cycle made one exact read using a retained receipt and answered the
requested new row correctly. Neither cycle called the index again, so the
predeclared fresh-list-plus-read requirement was not met. The unchanged strict
verdict is not a claim of guessing, failed readback or lost evidence.

All seven canonical-window prefix checks passed. The missing-source scenario
called the index and returned explicit unavailable/no-replay state. The source
was dispatched once and the independent gateway recorded one source operation;
zero unsafe tool requests and zero automatic retries occurred. Protected files
were unchanged, the gateway/proxy terminated, and the temporary directory was
removed. The recorded four source hashes matched after termination.

Receipt:
`.hpm-acceptance/context-generic-model-acceptance-20261013-run1-result.json`.
SHA-256: `687dc4cb21d383a848d985fc8505bf248d3de74ca82d862930d912770c63afb9`. The
receipt remains immutable and failed. The generic Responses/stdio MCP host does
not establish installed Codex/Claude-host or HTTP API-observer real-model
acceptance. No old chats were read, installed configuration written, provider
credential created/copied, production proxy restarted or current session
switched. This one-shot authorization is spent; the remaining two request slots
are not permission to rerun it. No new paid attempt has been made.

The subsequent offline gate passed all 40 focused API/gateway/packaging tests,
including six generic-harness tests and a regression preserving strict failure
when exact direct reads skip fresh index calls. Scoped Lint/format and
CI/release governance passed. Isolated runtime preparation matched 361 runtime
sources, 368 copied build/runtime sources and 116 locked production packages.
These checks did not install a package or activate production and are not a
current full aggregate `verify`. The temporary staged runtime is retained for
inspection. Engineering record:
`.hpm-acceptance/context-generic-followup-engineering-20261013-run1-result.json`.

### Complete-read offload admission fix on 2026-10-13

Two failing pre-fix regressions reproduced the defect: a 600-KiB source was
offloaded despite a 512-KiB complete-read budget, and two outstanding 300-KiB
sources overbooked the same budget. The fix preserves original results when
complete retrieval is not admissible, without raising any limit. Regression
coverage also includes escaped-content expansion, already exhausted readers,
concurrent completion, full-read reservation release, TTL expiry, invalid
inputs/getters, malformed/foreign pages, partial/overlapping reads and digest
mismatch. No source tool is automatically retried.

The latest client/gateway/API coverage gate passed **168 tests**, with zero
failures/skips and unchanged thresholds: 98.94% statements/lines, 96.15%
branches, 97.07% functions. The eight new offload-budget tests and five added
gateway regressions are in unified CI discovery and the client coverage entry.
Six generic-harness and three plugin-package tests also passed separately.
Scoped Lint/format, CI/release governance, 1020-file JavaScript syntax and full
npm audit (zero vulnerabilities) passed. No current full aggregate `verify` or
frontend/Rust build was performed. The installed cache remains unchanged.

Current-source isolated runtime preparation passed with 362 exact runtime
sources, 369 copied build/runtime sources and 116 production packages matching
the original lockfile; manifests, bundled Node and source identities matched. No
package was installed or activated. The temporary staged runtime is retained for
inspection. Engineering record:
`.hpm-acceptance/context-evidence-offload-budget-20261013-run1-result.json`.

The spent live `run1` receipt remains failed and byte-identical. This offline
fix makes no new native-host, HTTP API-observer real-model, representative
long-task or production activation claim. No additional model request,
production restart, installed configuration change or old-history read occurred.

## Verified delivery on 2026-10-12

`hpm-local-evidence@hpm-local`, version `0.1.0`, is installed by the native
Codex plugin installer. Its cache contains the entry point, the generated
closure of 13 repository modules, and its directly declared, pinned MCP SDK
`1.31.0` dependency. The root application's model, routing, authentication
settings and unrelated configuration are unchanged. No old conversation history
or transcript is read. No extra model invocation or production proxy restart was
performed.

The user-level plugin is disabled; the trusted project's `.codex/config.toml`
enables it for HTTPS-Proxy only. The native `/hooks` review trusted exactly one
enabled `PostToolUse` MCP hook, with current hash:

`sha256:a59584acde6541a0a26349e2544dbe3f93479a3841bdd36d9111a27098461d14`

### Capability and data boundaries

- Each stdio connection owns its own in-memory ledger. Installed Codex identity
  probes showed distinct processes for two threads and host-injected
  `_meta.threadId`, overriding a synthetic supplied thread identity.
- The model-visible tools are only `hpm_list_retained_evidence` and
  `hpm_read_retained_evidence`. Neither accepts a session selector.
- `hpm_capture_completed_hook` is accepted only on the host's private stdio
  channel, is absent from `tools/list`, and requires host metadata and Hook
  session identity to agree. The project transport allowlist includes this
  internal operation so it does not accidentally block the host. Arbitrary code
  running as the same OS user is outside this tool-capability boundary.
- Capture is prospective. The event template has no `transcript_path`; there is
  no transcript replay, filesystem lookup, provider credential access or network
  transport in the capture/reader modules.
- Strings retain exact valid UTF-8 content. Structured tool responses retain
  their normalized JSON representation, not an alleged byte-for-byte copy of the
  original wire encoding.
- Known sensitive fields/patterns, old-transcript access commands, invalid
  events, oversized arguments/results, running execution handles,
  evidence-reader recapture, and conflicting completed-call IDs are rejected.
  Secret detection is conservative and is not a universal classifier for
  arbitrary opaque secrets.
- Retention is memory-only: 30-minute absolute TTL, 64 entries, 1 MiB per
  result, 4 MiB total. Reader budgets remain 64 calls / 512 KiB per connection
  and 16 KiB per response. Missing, rejected, expired or quota-exceeded evidence
  must remain unavailable; it is not fabricated.
- Successful Hook feedback is `{}`. No evidence is promoted to developer
  instructions, no tool result is rewritten, and no operation is blocked by the
  plugin. Capture failures remain visible safe Hook errors.

### Native format qualification

On the installed Codex `0.160.1`, the root portable manifest was accepted for
identity but resulted in empty MCP/Hook inventories. The supported legacy
`.codex-plugin/plugin.json` plus `.mcp.json` layout successfully loaded both.
The inactive `plugin.portable.json` is a future migration template, not a
deployed entry point. Do not rename it to `plugin.json` without repeating
installed-version qualification. `mcp.json` is the corresponding portable MCP
template.

### Evidence, not inferred success

- Isolated native receipt:
  `.hpm-runtime/context-local-plugin-native-20261012-run8-result.json` — native
  install, exact capture/read-back, two-thread isolation, and reader-only
  discovery passed. Synthetic trusted app-server calls are adapter proof, not
  actual Hook capture.
- Installation receipt:
  `.hpm-runtime/context-local-plugin-install-20261012-result.json` — non-plugin
  configuration checksum before/after registration matched.
- Installed verification:
  `.hpm-runtime/context-installed-local-plugin-20261012-run4-result.json` —
  exact read-back, trusted/enabled Hook, reader-only discovery, project-only
  scope, and unchanged protected configuration.
- Historical desktop connection attempt:
  `.hpm-runtime/context-local-plugin-current-host-20261012-result.json` — the
  CLI control proxy closed before initialization; no reload or provider change
  occurred. This failed control-path attempt is retained, not overwritten or
  reclassified.
- Current desktop chat acceptance:
  `.hpm-runtime/context-current-chat-hook-20261012-run1-result.json` — the two
  readers are available in the actual chat. Fresh synchronous shell outputs were
  captured automatically by the real Hook, without manual seeding. A 45-byte
  output read back exactly; a 30,600-byte Chinese/accented/emoji UTF-8 result
  read back exactly in three contiguous pages. An independently computed SHA-256
  matched the receipt. A valid source with the wrong digest returned safe
  `context_evidence_unavailable`, not content. Only outputs freshly generated in
  this continuation were read; previous indexed records were not read.
- A synthetic native `thread/shellCommand` completed without model invocation
  but did **not** trigger capture. This specialized path is not a positive
  `PostToolUse` acceptance test. Actual current-chat synchronous tool → Hook →
  retained original → reader is now verified; native compaction → read/continue,
  asynchronous completion and specialized-tool coverage remain unverified.
- Client gates: 72 tests passed, statements/lines 99.59%, branches 97.51%,
  functions 96.15%, with existing thresholds unchanged. Three additional
  package/config tests passed. All new tests are discovered by the unified unit
  suite; Hook and MCP tests also enter the client coverage command.
- Scoped lint/format, CI/release governance passed. Whole-workspace syntax
  passed for 3,455 JS files before the last small script additions; those
  additions are checked separately. Plugin dependency audit reported zero
  vulnerabilities.
- Full `npm run verify`, Tauri installer acceptance, real model
  recovery/compaction/concurrency/economics and production activation are not
  claimed by this delivery.

### Authorized native compaction acceptance, 2026-10-12

The user explicitly authorized one isolated attempt, up to six additional
requests, including failures and compaction, with no automatic retries and the
existing official route only. The installed native plugin package and exact
trusted Hook were loaded in an isolated temporary Codex home; no installed
model, route or authentication configuration was written. The source MCP tool
generated a fresh synthetic measurement during the actual model tool call. The
evidence ledger started empty and was never manually seeded.

Five HTTP 200/completed provider requests verified real source execution, Hook
capture, exact original read, one native compaction cycle, checkpoint reuse,
post-compaction model list/read completion with the exact original content, and
correct final state. The first visible post-compaction input did not contain the
fresh marker. Configuration/certificate guards stayed unchanged and all isolated
processes, server and temporary directories terminated. Paid aggregate is 96;
the unused request allowance is not permission for another attempt.

**The strict acceptance verdict remains failed.** The full retained page was not
observed in the next model input (only 216 aggregate tool-output bytes). Code
Mode apparently emitted a parsed projection rather than the entire read result;
this is not proof that the original Hook capture or native compaction failed.
The future diagnostic prompt now explicitly requires one page per exec and
native `text(result)` of the complete result before parsing. This prompt repair
has a regression test but has not been retested on the paid route. No schema,
quota, baseline, acceptance gate or production plugin was relaxed to turn the
result green. Async/specialized-tool coverage and matched economics remain
unverified.

Immutable original receipt:
`.hpm-runtime/context-installed-evidence-acceptance-20261012-run1-result.json`.
Separate diagnosis and source hashes:
`.hpm-runtime/context-installed-evidence-acceptance-20261012-run1-engineering-result.json`.

### Targeted authorized retest: passed

The user authorized a separate one-shot retest capped at six provider requests,
including compaction and failures, without automatic retries. Before this
retest, the historical engineering receipts were absent from `.hpm-runtime`.
They were not recreated, and their disappearance was not attributed to a
particular process without evidence. The preceding descriptions remain
historical records, not claims that those files are currently available. New
authority, attempt and result files are in the separate ignored
`.hpm-acceptance` directory. Current configuration and certificate hashes were
freshly snapshotted and checked; no old transcripts or conversation-audit logs
were used to reconstruct evidence.

`run2` passed all unchanged semantic acceptance gates in exactly **six** HTTP
200/completed requests, with zero automatic retries. The real source MCP call
returned a fresh 140-byte synthetic original; the ledger was initially empty.
The trusted Hook captured it, one native compaction cycle completed, and the
native checkpoint was reused. After compaction the model listed and read the
source, the reader result matched the original, the **complete exact reader
envelope was observed in the next native model request**, and final state was
correct. Code Mode framing is handled by matching the entire validated reader
envelope across bounded JSON escaping layers; a parsed projection, partial page
or changed envelope cannot pass this check. This is a wire-format observation
fix, not a weaker full-page gate.

All configuration/certificate guards remained unchanged. No installed Codex
configuration, model, route or authentication was written, no production restart
occurred, and the current chat was not switched. The isolated native client,
proxy and loopback server terminated, their temporary directories were removed,
and a live process check found no remaining acceptance processes. Thirty-two
related tests, scoped Lint/format and CI/release governance passed.

Receipt:
`.hpm-acceptance/context-installed-evidence-acceptance-20261012-run2-result.json`.
SHA-256: `44addba345797579da5e8ebf7954ed7c74f9a8271115568982860e6c1e5096be`. The
receipt's cumulative 102 requests uses the previously reported 96 as its
historical base, explicitly not a currently available historical receipt. Six
new requests are independently counted by this attempt. Its authority is spent.

This verifies one fresh synthetic source and one native compression/continuation
cycle. It is not evidence of long-duration production stability, automatic
failure recovery, repeated compaction cycles, all asynchronous/specialized
tools, matched economics, full project verification or Tauri installer
acceptance.

## Operation

The installed cache, not the marketplace source, is executed. Changes in
`lib/client` require rebuilding the standalone distribution with
`npm run build:evidence-plugin` and a reviewed reinstall from its generated
marketplace. The legacy closure builder remains available for old package
inspection and compatibility tests. The
installation script is a one-shot engineering action, not an unattended update
mechanism; it preserves model/provider/auth configuration and sets the user
default to disabled, with project enablement retained. Hook-definition changes
require review of the new native hash. Do not use a global trust bypass.

Current-chat adoption and the scoped native compaction/continuation retest are
verified; no refresh or client restart is required for this chat. For another
desktop conversation, verify a newly completed supported tool output appears in
that conversation's index, refreshing its plugin connection only if necessary.
Do not silently create another paid model diagnostic or read its old transcript.
Wider acceptance testing still needs separately scoped model-run authorization.
Evidence receipts refer to a bounded in-memory ledger; the durable content-free
acceptance report is not a durable backup of those outputs. Keep engineering
receipts separate from the production runtime directory.

Official contracts: [Codex hooks](https://learn.chatgpt.com/docs/hooks),
[plugin packaging](https://developers.openai.com/plugins/build/plugins).

### Current-chat asynchronous unified-exec qualification, 2026-10-12

A fresh synthetic shell command returned a running unified-exec session handle.
The same handle was polled with `write_stdin` and reached exit code zero; the
original command was not reexecuted. Comparing the before/after evidence indexes
identified its newly captured `Bash` receipt without reading earlier evidence
contents. The reader returned the complete 49-byte UTF-8 terminal output,
including Chinese, emoji and Windows CRLF. An independently computed SHA-256
matched the receipt and returned page. A preliminary LF-only calculation
differed; the verified digest uses the actual CRLF output, not a normalized
replacement.

Content-free engineering observation:
`.hpm-acceptance/context-current-chat-async-hook-20261012-run1-result.json`.
This is a current-chat tool observation, not another paid model diagnostic or
another compaction cycle. No production restart or configuration write occurred.
It qualifies this asynchronous unified-exec completion path only, not all
specialized tools, background MCP jobs or repeated-compaction recovery.

Three Hook-session regression tests cover pending polls followed by terminal
capture with the same call ID, duplicate terminal delivery, nonzero exit result
retention without claiming execution success, and completion after connection
closure. They are in the existing unified unit and client-coverage test file; no
CI threshold or production capture policy changed.

### Aggregate engineering delivery, 2026-10-12

The actual `npm run verify` command subsequently terminated with exit code zero,
including the 416-file proxy suite, security coverage, 75 client tests and
coverage, frontend coverage/tests/build, integration, Git Hook and Rust gates.
Existing Lint and frontend chunk-size warnings were retained. See
`.hpm-acceptance/context-delivery-aggregate-verify-20261012-run1-result.json`.

The subsequent existing synthetic offline replays passed the exact output
envelope contract (seven sources, thirteen retained pages) and paged readback
fidelity, with zero provider requests and no original-tool reexecution. These
are offline observations, not additional installed-client or model-semantic
acceptance. The run2 one-cycle native acceptance and current-chat asynchronous
Hook qualification retain their separate scope. Repeated native compaction,
representative long tasks, all specialized/background tools and end-user
installer acceptance remain unverified. No production restart, plugin reinstall
or model/route/authentication configuration change was performed.

### Authorized two-cycle native attempt, 2026-10-12: strict verdict failed

The user separately authorized at most twelve provider requests, zero automatic
retries, reuse of the existing official-login route and no production restart or
installed configuration change. The new `multi1` authority and exclusive attempt
record are independent of spent run1/run2 authorization. The harness resets its
observation flags/reader envelope between two same-thread cycles and stops on
failure. Twenty-two related regressions, scoped syntax/Lint and CI/release
governance passed. This harness change is not covered by the preceding full
aggregate verification.

The actual attempt stopped after **eight** HTTP 200/completed provider requests.
Cycle one passed trusted capture, native compaction, model list/read, full exact
reader-envelope ingress and correct final state. Cycle two completed native
compaction and continued with the chained opaque checkpoint. Its initial input
had no plaintext source marker, and its final state was correct, but no
list/read tool call or fresh exact reader-envelope ingress occurred. The strict
two-cycle readback verdict therefore failed. Correct state may survive in native
opaque context; this observation does not prove missing evidence, guessing or a
broken ledger. The full checkpoint-object equality flag was also false while
opaque chain reuse was true; no raw checkpoint was persisted, so the precise
object difference is unverified. No identity or semantic gate was relaxed.

Receipt:
`.hpm-acceptance/context-installed-evidence-acceptance-20261012-multi1-result.json`.
All eight route observations matched the authorized official route. Protected
files remained unchanged, no unsafe tool request occurred, and native/proxy/
loopback processes terminated before validated temporary-directory cleanup. No
old chats were read, credentials copied, production restarted or current session
switched. This attempt is spent; four unused request slots do not authorize a
retry. Prompt adherence, full-object identity diagnosis and representative
detail-loss workloads need separate scoped live-run authorization.

### Offline diagnosis and stricter checkpoint observations, 2026-10-12

The gateway had two independently reproducible observation defects. Whole-item
equality was checked while only four field differences were reported; a changed
extra property could therefore produce `equal=false` with no reported field
differences. Also, OR-accumulated equality could remain green after a later
mismatch, and last-request difference labels could erase earlier discrepancies.
These are harness defects, not proof of a production compaction defect.

The gateway now delegates to a bounded independently tested JSON comparator.
Per-request observations include unique opaque-match counts, complete-item
equality, fixed known-field labels and counts of added/removed/changed other
fields. Untrusted field names, field values and opaque bytes are never logged.
Duplicate/missing matches cannot qualify exact reuse. Aggregate complete-item
equality fails monotonically; known-field differences accumulate. No equality
gate is relaxed. All 34 focused regressions, scoped syntax/Lint/format and
CI/release governance passed, with the new test file in unified discovery. Full
aggregate verify has not been rerun for these harness-only edits.

The immutable `multi1` failure receipt remains unchanged. Its exact historical
object difference cannot be recovered from content-free diagnostics, so these
fixes do not reclassify that live attempt or claim a specific differing field.
No additional provider request, production restart or configuration write was
made. Engineering record:
`.hpm-acceptance/context-checkpoint-diagnosis-20261012-run1-result.json`.

Next representative acceptance should distinguish native chain continuity,
task-answer correctness, and forced fresh-readback execution as separate gates.
The user policy requires evidence lookup when details are unavailable; it does
not require discarding correct retained state after every compaction. Official
[compaction guidance](https://developers.openai.com/api/docs/guides/compaction)
describes opaque state carrying prior state forward and requires retaining the
canonical returned window. Never remove/change that state to manufacture loss.

A proposed next workload uses one newly emitted multi-record synthetic source,
then selects different exact-detail queries only after each compaction, rather
than asking twice for the same three already answered fields. Compare answers
against fresh source values independently; separately observe any list/read and
complete-reader ingress. If the opaque state still answers correctly without a
read, report task correctness but do not claim fresh-readback qualification or
guessing. Expired/missing evidence needs its own explicit-unavailable/no-replay
scenario. These are planned live scenarios, not completed acceptance or a new
provider request allowance. Additional live runs require separate authorization.
