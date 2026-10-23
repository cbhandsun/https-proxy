# HTTPS Proxy 多端上下文恢复实施状态

## 2026-10-23：独立 N08 托管通过，N09 重启等待实际持久应用的候选

`eae81512` 已提交并推送，独立诊断 `39999706331` 中 N08 job `120572317779` 已 success；N09 job `120572317317` 已 failure，固定阶段119。N08 的持久关闭契约候选已取得本轮托管通过证据，但独立诊断不代替完整 source-gates 后的正式业务资格。该源码 Verify `39999706510` 最近七项 job success、coverage仍运行；完整 disposable `39999706539` 的egress success、source-gates仍运行，继续原句柄。

真实 runtime/lifecycle 与内存 SQLite 的受控 catalog 初始化回归证实：管理诊断可在 `configValid=true,requestedEnabled=true,appliedEnabled=false,state=pending_application` 时已提供健康回复，之后存储完成才变为持久已应用。N09 原重启 attestation 只检查一次恢复状态；纯生命周期的管理已就绪、恢复应用仍等待夹具在旧代码先失败。候选将配置核验提前，失败固定130；健康阶段只对上述明确的待应用状态及已确认存活的同一pid等待，沿用从管理就绪前开始的原15秒总期限、原两秒HTTP期限，最多150次纯健康探测。配置、禁用、无效结构、失败状态、错误pid、HTTP或传输错误均直接失败；不重发保存、业务或模型请求，不读取原文。健康失败使用已有固定阶段，未知原始异常不输出。

新增独立纯等待模块及正常、空、非法、极端时钟、getter/Proxy、安全与失败回归；相关生命周期、等待、闭包组合48/48及五项真实内存 runtime 回归通过，ESLint、格式与CI/release治理通过。首轮新增测试有两处错误预期及顶层async返回Proxy触发Promise自身then查找的夹具问题，均修正后完整复验通过，未跳过用例或放宽期限。新模块由现有静态闭包发现、新测试由统一unit发现；是否解除托管119仍待候选验证。

当前源码原五档、两个worker的纯内存CPU剖析退出0，约77401ms，满足180秒执行预算但未满足原60秒性能目标；worker时间主要在公开窗口编码、哈希、历史克隆与GC，未据此引入未经验证的优化。私有证据目录为 `capacity-eae81512-cpu`，仍不授予传输、持久存储或24小时资格。本轮新增真实模型请求0、本机产品持久worker/DPAPI/安装器/注册表/防火墙操作0。完整范围保持未完成。

## 2026-10-23：校正 N08 关闭恢复的存储契约，修正 N09 后续开关保存的悬空路由

`bdfa65b0` 的完整 Verify `39996893217` 已 success，全部八项 job 通过；完整 disposable `39996893239` 已 failure，source-gates 与 egress success，N08 job `120570202639` 固定阶段148，N09 job `120570202734` 固定阶段115。独立诊断 `39996893337` 亦分别148/115。旧 `f825158e` 完整 disposable `39994647499` 已 failure，不能继续记为运行中。完整源码门禁通过不替代业务与安装交付资格。

真实 runtime、lifecycle 与内存 SQLite 回归证实：先启用持久恢复，再保存 `enabled=false,persistence=true` 会同步停止准入，保留同一持久 owner、已存内容及原到期时间，不隐式切换为内存或清空存储。N08 原验收同时要求关闭恢复和 `storage=memory`，与独立持久化偏好契约矛盾。候选继续严格要求 `appliedEnabled=false`，将存储断言校正为 `persistent`；原15秒期限、身份、配置回读以及后续撤权、退出、根身份、到期与防重放断言保留。保留真实状态的验收夹具在旧代码先失败约15秒，校正后通过；不据此认定托管148只由此引起。

N09 `setCombination` 与先前 N08 保存存在同类缺陷：读取配置会补入官方 profile 及内置路由，后续合成保存只替换 profile，却保留引用已移除官方 profile 的路由。使用真实 `mergeBuiltinModelRoutes` 和 `validateConfig` 的四种开关组合回归在旧代码先失败，候选在替换合成 profile 时显式清空 modelRoutes 后通过，保持私有合成凭据和单次保存。另将重启后 attestation 和开关变更的配置读取、保存、回读及健康检查标记为既有116/117/118/119，避免这些后续失败仍停在已完成的115；新增五种失败注入验证固定阶段、请求次数和独立清理。该缺陷可能解释托管115，但尚待新候选托管验证。

N09业务、生命周期、组合与输入边界纯回归69/69，N08纯回归11/11、四项相关真实内存 SQLite/runtime 回归通过；管理健康等待相关三文件先前合计44/44通过。ESLint、格式、CI/release治理和diff检查通过，新回归由统一unit入口发现。本机未执行产品持久worker、DPAPI、安装器、注册表或防火墙，新增真实模型请求0。完整I0–I5/H1、N01–N11、24小时持久容量、安装迁移回滚与生产交付保持未完成。

## 2026-10-23：N08 读回内置路由导致变更保存失效，N09 等待管理凭据发布

f825158e独立业务诊断39994647455已failure：N08 job120554897361阶段196，确认是配置校验拒绝；N09 job120554896871阶段187，已越过连接拒绝但健康回复非200，具体状态仍待新增固定状态分类验证。完整Verify39994647438八项job全部success；完整disposable39994647499最近source-gates仍运行、egress success，沿用原句柄。

纯回归复现N08后续变更保存的悬空路由：生产loadConfig会重新添加官方profile及其内置modelRoutes，验收save以两个合成profile覆盖读取结果，却保留引用被移除profile的modelRoutes，真实validateConfig拒绝。候选在每次合成save显式清空modelRoutes，保持两条合成profile、所有原变更和回读断言。disable、target-change、permission-change三种场景分别使用真实mergeBuiltinModelRoutes/validateConfig验证，旧代码RED、修正后GREEN；是否解除托管196仍待业务复验，不改生产加载行为。

生产server-lifecycle在listen回调异步发布管理凭据，credentialStartup.ready之前固定返回503及单字段初始化回复。N09候选仅把该严格匹配回复视为健康就绪探测，沿用原15秒总期限、300次上限及原HTTP两秒期限；未知503、401、额外字段、非法结构、getter/Proxy不成为可重试的初始化回复。永久初始化未完成仍期限失败。新增两次初始化探测后成功及一次配置POST的纯生命周期回归；其他HTTP拒绝复用既有162..173固定状态码，未扩大外层白名单。该窗口已在纯测试RED→GREEN，尚不能将托管187直接认定为503。

相关两端业务、生命周期、输入边界和闭包回归51/51通过，新增对抗性用例修正Promise自身then查找的夹具后独立通过；ESLint、格式、CI/release治理与diff检查通过。未增加真实模型请求，未执行本机产品持久worker、DPAPI、安装器、注册表或防火墙。原五档、两个worker的纯合成容量命令本轮退出0、五档全部功能通过，父命令耗时73076.3038ms：满足原180秒执行预算，未满足原60秒性能目标。证据capacity-f825158e-current-report.json与capacity-f825158e-current-receipt.redacted.json保存在既有私有验收目录；仅是synthetic-session-capacity，transportQualified和durableStorageQualified仍false，不授予24小时持久容量或客户端资格。完整I0–I5/H1、N01–N11、24小时持久容量、安装迁移回滚与生产资格未完成。

## 2026-10-23：N09 监听启动竞态修复候选，N08 配置 400 安全分类

99667aaf 的完整 disposable 39990378959 已 failure：源码与 egress 门禁 success，N08 job 120547932460 固定阶段162（配置保存 HTTP400），N09 job 120547932588 固定阶段191（首次管理连接拒绝）；独立诊断39990378864同样分别162/191。Verify39990378935八项 job 中七项success，unit1的纯模拟 WFP setup 测试因原25秒期限超时失败，不能称完整 Verify 通过。前一版本1d3b97a5的完整disposable39988709269亦已failure。

N09候选修正“私有预加载完成早于管理端口listen”的验收启动竞态：只对固定健康探测的连接拒绝等待，沿用原15秒总启动期限、每次HTTP原两秒期限及全部身份/状态断言。其他传输失败及HTTP拒绝立即终止，不重试配置写入、业务或模型请求。纯回归先RED后GREEN，新增模块覆盖正常、短暂拒绝、永久拒绝、期限、冻结/倒退时钟、异常时钟/等待与可执行输入；候选托管复验待完成。

N08从真实DEFAULT_CONFIG生成的合成配置通过真实validateConfig，尚不能据此认定实际HTTP400根因。候选只读取有限自有error字符串，输出固定196=校验拒绝、197=加密失败、198=解密失败、199=其余拒绝、200=无效错误结构；不输出响应正文或异常。新增集成回归先RED后GREEN，保持一次POST、失败立即停止。外层只扩大N08退出码至200，N09 primary-phase白名单不变，201继续拒绝。两端纯生命周期与管理相关回归42/42通过，新测试由统一unit入口发现。

WFP setup纯模拟改用PowerShell类作为假对象，继续覆盖原生产Add-Type调用的编译失败、安装失败及成功路径，避免为假对象额外运行C#编译器；原25秒期限和全部断言保留，单项复验通过。另一次相关纯回归25/26通过，安全子进程完整回归超过原45秒期限仍记失败；新增退出码用例曾遗漏同步计数断言，已同步，未提高期限或删除原用例。相同安全子进程文件独立复验3/3通过，其中完整子进程用例约40秒，不能据此宣称并发长尾已解决。ESLint及CI/release治理通过。本机未执行产品持久worker、DPAPI、安装器、注册表、防火墙或真实模型请求。完整两端业务、24小时容量、安装迁移回滚与生产资格均未宣称完成。

## 2026-10-23：完整 Verify 全通过，业务管理失败已排除原两秒期限

1d3b97a5 的完整 Verify 39988709235 已 success，八项 job 全通过。独立业务诊断 39988709290 已 failure：N09 job 120534564788 返回 186（管理 HTTP 的非原期限传输／读取失败），N08 job 120534565244 返回 187（配置 POST 收到非 200）。当前证据排除这两次请求触发原 HTTP 两秒计时器，但尚不能区分连接拒绝、重置、响应中断或无效响应，以及 N08 具体状态。完整 disposable 39988709269 最近 source-gates 仍运行、egress success；沿用原句柄，不重启。完整 Verify success 不替代两端业务、24 小时、安装迁移和生产资格。

候选保留 HTTP 客户端原固定错误文本与原两秒期限，新增有限故障码：191=ECONNREFUSED，192=ECONNRESET，193=响应 aborted，194=无效 JSON／对象回复，195=回复超过原字节上限。仅已知原生错误自有数据描述符进入固定映射，不读取 getter／Proxy，不把原始错误、响应或任意 code 写入日志；原生事件不能伪造本地期限。N08 非 200 配置保存复用既有 162..173 状态分类，未知或非法状态仍拒绝。两端外层 parser 同步至195，139、196及附加文本继续拒绝。没有增加请求、自动重试、模型调用或改产品存储／TTL／断言。

新传输分类回归在旧代码先 RED（固定连接拒绝码缺失），接入后 HTTP／生命周期／矩阵纯回归55/55、快照／协议54/54、实际安全 PowerShell边界3/3，共112项通过。安全子进程回归本轮完整运行约22.6秒，保留原45秒上限与全部既有用例；先前超时记录保留，不据此宣称长尾永久修复。ESLint、格式、CI/release治理及diff检查通过，新增回归由统一unit入口发现。本机未执行产品持久worker、DPAPI、注册表、安装器、防火墙或真实模型请求，完整目标保持未完成。

## 2026-10-23：新候选在快照前失败，细分管理健康与 N08 配置保存边界

5ac19e9f 已提交并推送，独立诊断 39985706079 已 failure：N09 job 120524190790 返回 115（首次健康检查），N08 job 120524191206 返回 146（配置 POST）。本轮两端未到达快照，不能宣称首次落盘时间修正已解除真实阶段 183。Verify 39985706163 最近七项 job success、coverage 仍 in_progress；完整 disposable 39985706037 的 egress success、source-gates 仍 in_progress，继续原句柄。

本候选只补充管理失败固定分类：185=原两秒 HTTP 期限，186=其他传输失败，187=非 200 响应，188=结构／回执失败，189=健康响应返回时原总启动期限已到，190=健康身份／运行状态不符。N08 配置保存与 N09 首次健康检查共用只读取 error 自有数据描述符的分类模块，不执行 accessor／Proxy，不转发原始错误、响应或内容。正常请求、原期限、原校验与资源清理保持；外层只接受新增明确范围，139、191 和附加文本继续拒绝。新增纯模拟测试进入统一 unit 自动发现；本机只运行模拟、内存 SQLite 与安全合成子进程边界，没有执行产品持久 worker、DPAPI、注册表、安装器、防火墙或真实模型请求。完整目标保持未完成。

管理分类／生命周期纯模拟 32/32、快照／两端协议 54/54 通过，ESLint、格式及 CI/release 治理通过。PowerShell 白名单曾漏同步 regex，实际安全边界测试先失败，已修；新增阶段的逐项解析、未知 139/191 拒绝在单独实际 PowerShell 纯解析中通过。完整安全子进程回归随后两次超过原 45 秒期限，仍为失败，未提高期限或关闭测试；原有真实安全子进程用例保留，新增阶段的所有值由纯解析覆盖，新增实际子进程覆盖范围端点及越界拒绝。不能把单独解析通过当成该完整回归通过。Verify 39985706163 现已终态 failure（coverage 失败，其余七项 success）；完整 disposable 原句柄仍需继续核对，不为观察而重启任务。

## 2026-10-23：两端快照阶段 183，修正首次落盘时间与根创建时间的契约差异

eb4c9cc6 独立诊断 39984308079 已 failure：N08 job 120519393318、N09 job 120519393928 均返回 183。两端均已越过 pins、密钥解封、schema、时钟及状态解密，当前失败范围是 reference 解析及元数据校验，未输出任何状态或原始异常。核对生产 context-recovery-storage-sqlite 的首次 row.created_at=time，以及 storage-record／storage-contract 的 root.createdAt<=row.created_at 契约，发现只读验收观察器错误要求两者相等。根先创建、首次异步持久化后完成是合法生产路径。

新增纯回归先在旧观察器复现正常延迟落盘被拒绝；修正观察器后，保持严格绝对到期一致、拒绝根晚于落盘和到期错配，且后续 revision 读取正常。真实内存 SQLite 回归同样改用首次落盘晚于根创建的认证 envelope。快照及两端相关测试 61/61 通过，统一 unit 自动发现；首次负例夹具因其 AAD 自身超过 24 小时被 cipher 提前拒绝，已修为合法 AAD 后重新执行 RED→GREEN。没有修改生产存储、TTL、期限、请求、负载、读取权限或 ACK，也未读取原文 blob。此修正是否解除真实托管阶段 183 仍待新候选验证，不能把契约回归当成两端通过。

补正旧终态：9c9462ed Verify 39982513085 已 failure，coverage 的 actual core responses WBIPC recovery has exclusive ownership and live credential revocation 失败，其余七项 job success；其完整 disposable 39982513196 的 32 MiB 四根重开测试返回固定 context_recovery_storage_unavailable，尚未证实超时。a20cfd4d 完整 disposable 39980129782 已 failure，source-gates/egress success、两端业务 failure。当前 eb4c9cc6 Verify 39984308056 与完整 disposable 39984308033 最近仍 in_progress，继续原句柄，不重启。完整 I0–I5/H1、N01–N11、24 小时容量、安装迁移和生产交付保持未完成。本轮真实模型请求新增 0；本机未执行产品持久 worker、DPAPI、安装器、注册表或防火墙操作。

## 2026-10-23：observed ACK 修复让两端越过 503，业务推进至恢复／快照边界

9c9462ed 的独立诊断 39982568481 已终态 failure：N08 job 120513375453 返回 154，已越过三次种入与摘要请求，进入 waitUpstreamHold（包括随后快照读取）；N09 job 120513375876 返回 137，已越过工具结果回传和摘要回执校验，进入快照创建／读取。原工具结果 503 在该次两端执行中已越过，但后续尚未通过，不能宣称 N08/N09 完成。

候选给现有只读快照观察器增加固定 174..184：创建文件观察器、首次 pin、读取包裹密钥、解封／建 cipher、打开数据库与 BEGIN、schema、header、时钟、row 解密、reference 解析、清理。两端显式传递同一固定 phase observer，范围同步进入原父边界；未知 139、185 及附加文本继续拒绝。观察器异常只返回既有固定错误，既有 rollback、database/cipher close 和最终 pins 仍独立尝试；失败后的清理不覆盖首失败阶段。不读取原文 blob，不输出密钥、行、路径、错误或用户内容，不改变 SQL、断言、请求和期限。

原有与新增快照纯回归 25/25，包括每一 observer 阶段失败后的资源清理、非法函数／accessor／Proxy 不执行，以及真实内存 SQLite 的既有 schema 与认证 envelope 读取通过。两端业务和外层安全 PowerShell parser 相关 58 项在新增 SQLite 单项之前通过，新 SQLite 单项与其余快照随后全部通过；统一 unit 自动发现。未在本机运行产品 worker、DPAPI、注册表、安装器、防火墙或模型请求。

9c9462ed 的 Verify 39982513085 最近七个 job success、coverage 仍运行；完整 disposable 39982513196 已 failure，source-gates job 120513174856 失败项为 encrypted worker reopens four full session roots with 32 MiB of exact private history，尚未据此断言超时或具体产品根因，业务未启动。既有 a20cfd4d 完整 disposable 39980129782 的原句柄仍需核对终态。完整 I0–I5/H1、N01–N11、容量、安装迁移和生产交付保持未完成。


## 2026-10-23：两端确认 503，纯回归证实 observed 持久化与下一轮准入竞态

a20cfd4d 的独立诊断 39980129686 已终态 failure：N09 job 120504944221、N08 job 120504944749 均返回 170，明确为工具结果回传 HTTP 503。该轮完整 Verify 39980129735 已 success，全部 job 通过；完整 disposable 39980129782 最近 source-gates 仍运行、egress success。较早 b1a46aaf 完整 disposable 39978412033 已 failure，source-gates job 120499004023 失败于 actual core claude WBIPC recovery has exclusive ownership and live credential revocation，业务未启动；原失败保留，未重跑掩盖。

独立纯内存存储夹具阻塞首次 observed publication 的 save ACK：首次响应已 completeObserved，但下一轮同 root beginAsync 立即返回 context_recovery_busy；释放 ACK 后，同一输入能够准入。三个正常／撤权／写入失败的新回归在旧代码先 RED，证实客户端已见响应、原观察写入仍持有 owner 的竞态。该缺陷可能解释实际两端 503，但尚无托管证据证明其为唯一根因。

候选只跟踪真实 observed publication 的待确认 Promise；异步 loader 在选定同一 root 后等待该 ACK，再重新检查授权、代际和存活，随后执行原准入。其他 principal 的新 root 不等待；实际恢复／公开生成 owner 仍按原规则返回 busy。没有重发请求、轮询上游、延长期限、绕过 durable ACK 或提前释放 owner；失败 ACK 和等待期间撤权均拒绝。五项新增纯回归通过，另有 14 项既有纯 loader／session 回归和 32 项 hosted 协议回归通过。新的 busy 夹具初次漏导出 first 引用已修正；Lint 曾发现裸 structuredClone，改为 globalThis.structuredClone 后重新验证。新增测试由统一 unit 自动发现，完整托管与业务资格仍待候选验证。


## 2026-10-23：两端首失败点收敛于工具结果回传，追加固定 HTTP 分类

b1a46aaf 的独立诊断 39978411930：N08 job 120499003138 返回 150，N09 job 120499003401 返回 134。两端配置、首次工具调用已越过；N09 工具结果回传已取得 HTTP 响应，但协议或最终文本校验失败，N08 同一步失败。该证据仍不能区分非 200、无效 JSON 或成功响应内容不符，不能断言已找到产品根因。旧完整 disposable 39975429867 已终态 failure，源码门禁与 egress success，N09/N08 分别仍为 102/71。

候选只在工具结果回传的非 200 响应增加固定分类：162..171 分别为 400、401、403、409、413、429、500、502、503、504；172 为其他合法非 200 状态，173 为非法状态。模块只处理整数状态，不读取正文、凭据或异常；200 保持原协议校验。有限范围同步接入子进程和 primary-phase parser，139、174 及附加文本继续拒绝。新增纯分类与两端真实接线模拟，原请求数量、摘要与原文断言、期限和强制清理保持。

纯分类及 N08/N09 回归 32/32、外层安全子进程 PowerShell parser 3/3 通过。新 N09 夹具初次误用不存在的方法名，已改为既有 bindVerifiedNetworkProof/startFreshBusinessHost 并重跑通过。此前提交 b1a46aaf 误绕过 hook 后，已在推送前按该提交范围补跑相同 lint-staged，全部通过且没有产生变更；后续提交恢复正常 hook。

b1a46aaf 的 Verify 39978411927 已观察到 unit3 job 120499003876 失败：actual storage native ACL independently verifies protected access and rejects junction ancestors，PowerShell spawnSync ETIMEDOUT。Rust、node-quality、integration 及其余三个 unit 分片已 success，coverage 最近仍运行；本候选不调整该期限、不重跑掩盖失败。业务恢复、24 小时容量、安装生命周期及生产交付仍未完成，本机仍无产品持久 worker、DPAPI、注册表、安装器、防火墙或真实模型请求。


## 2026-10-23：完整 Verify 通过，业务失败推进至 seed，补有限阶段诊断

原生批量解密候选 033428165b9558c96757e418244f47e70f673fef 的完整 Verify 39975430107 已 success，Rust、coverage、四个 unit 分片、integration、node-quality 全部通过。独立诊断 39975548334 的 N09 job 120489059616 返回 102，已越过配置保存、管理读回及持久应用，失败推进到 seedThroughBusinessHttp；N08 job 120489059202 仍为 71。完整 disposable 39975429867 本轮查询时源码门禁及 egress 已 success，N08/N09 仍 in_progress，继续观察原句柄，不重启。

候选将 N09 seed 拆为固定 131..138（首次请求、响应校验、工具输出请求及校验、摘要请求及校验、已提交快照读取及校验），N08 增加 140..161（controller、session、启动、配置、seed、恢复、mutation、withdrawal、清理、closure）。父边界仅接受明确范围，139 和 162 继续拒绝。原业务请求、六个场景、正确性断言、期限及资源清理保持；失败后的清理不覆盖原失败阶段，observer 抛错仍分别尝试 stop 和 closeSession，不输出异常或业务内容。

纯模拟 N08/N09 回归 29/29、外层安全子进程 PowerShell parser 3/3、既有 plan/closure/proxy-boundary 30/30 通过。新增测试由统一 test-discovery 递归发现。最初两项新夹具错误地把 close 当作显式 stop，已按既有 killOwnedJob 后 close 的驱动契约修正并重跑；没有修改产品清理行为。未在本机运行产品持久 worker、DPAPI、安装器、注册表、防火墙或真实模型。阶段细分仍待新候选托管验证，不能据此宣称原文 seed、重启恢复、N08 mutation、24 小时容量或完整交付通过。


## 2026-10-23：管理 GET 原两秒期限已确认，候选接入打包原生批量解密

分类诊断 `709bb803`／`39972986699` 的 N09 job `120480243527` 返回 127，确认实际配置 GET 触发原两秒请求期限，没有进入 profiles 或其他内容校验；N08 job `120480243216` 仍为 71。静态链路存在确定性启动成本：常规批量解密只有环境指定桌面主程序 helper 才免于 PowerShell。候选在已打包的轻量原生程序增加独立 `--hpm-profile-unprotect-v1`，沿用原 CurrentUser、无 optional entropy 的 profile 格式，不改变上下文数据密钥协议。该优化是否足以解除真实期限仍待托管验证。

原生边界严格拒绝重复／未知字段、非法／非规范 base64、空／超过 64 项、超限输入和奇数 UTF16 长度，整批解密成功才输出，失败仅固定回执。JS 复用固定程序和物理路径检查、stdin 与私有有界 pipes，严格核对整批回执和数量；常规凭据走一次轻量批处理。缺失程序／非 Windows 和大旧凭据保留既有兼容路径；已调用原生失败则固定拒绝，不走 PowerShell 或原有重试循环。已有成功解密缓存规则保持，没有新增明文缓存或延长管理期限。

两项接线回归在 HEAD 旧代码先 RED，新候选 JS 纯模拟 27/27、隔离发布 12/12、Rust 纯解析／假加解密 6/6 通过，格式、零警告 Lint、CI／release 治理及全 target Clippy 通过。实际 Windows profile roundtrip 新回归进入统一原生 CI，本机过滤执行了全部六项 parse 测试，没有执行实际 DPAPI、产品 worker、安装器、注册表、防火墙或真实模型。Tokio 升级候选 `f0be7cc6` 的 Rust job 已 success，但 coverage job `120483774241` 已失败、完整 Verify 和 disposable 最近仍运行，未以依赖修复或局部回归声称整体通过。完整目标保持未完成。

## 2026-10-23：完整 Verify 七项通过，单独更新 Tokio 修复审计阻塞

`d2e6fe05` 的 Verify `39971570468` 终态 failure，coverage、四个 unit 分片、integration 和 node-quality 七个 job 全部 success；Rust job `120475330106` 失败于 Windows Rust audit，固定诊断为 `unsound:RUSTSEC-2026-0386:tokio@1.52.3`。该次实际存储原有回归和覆盖率通过，但不据此宣称此前所有长尾永久消除；完整 disposable `39971570600` 最近仍运行。

核对 RustSec 官方公告，修复分支包含 Tokio >=1.53.3。候选只将 Cargo.lock 的 Tokio 更新为 1.53.3 及对应 registry 校验和，保留其他版本与依赖边；初次隔离解析产生的无关 windows-sys 边变化未采用，最小锁文件在隔离 HEAD manifest 上 cargo tree --locked 成功。用户 Cargo.toml 未改动或暂存。cargo audit 返回 0、漏洞列表为空、Tokio 警告为空；仓库原 Windows 审计入口通过，252 个目标包、5 项原有信息提示、锁文件摘要前后不变；既有审计治理回归通过。实际构建、Clippy 和 Rust 测试仍须新候选托管验证，没有禁用门禁、调整 baseline 或在本机启动产品／DPAPI／安装器／注册表／防火墙。整体目标未完成。

## 2026-10-23：细分管理读回失败，保持原两秒请求期限

规范 profiles 修复后的托管 N09 仍返回 118，尚不能区分 GET 传输、解密耗时或返回内容。候选只将该阶段失败分为固定 127（原管理 HTTP 定时器期限）、128（其他传输／解码）、129（非 200）、130（返回内容或一致性拒绝）；原一次 POST、两次配置 GET、所有配置／身份／隔离断言与期限保持，不披露配置、异常或响应。父边界及 primary-phase parser 只接受完整固定格式和有限阶段码，131 及附加文本继续拒绝。

生命周期与 closure 纯回归 23/23，额外业务／readiness／profile 纯回归 31/31。外层安全 Node 子进程和 PowerShell parser 回归先发现新阶段未接入正则的错误，修正后 3/3、38970ms，在原 45000ms 期限内；没有运行产品或安装器。格式、Lint、CI／release 治理通过，实际托管读回分类待验证。`d2e6fe05` 的 Verify `39971570468` 与 disposable `39971570600` 最近仍运行；Rust job `120475330106` 已失败于 Windows Rust audit，出现 `RUSTSEC-2026-0386`，依赖原因待核实，未跳过门禁。整体目标未完成。

## 2026-10-23：精确文件身份回归证实 Number 碰撞漏检，候选改用 BigInt

`1b2c81aa` 的 Verify unit2 job `120455357629` 明确为 changed-inode 场景缺少预期拒绝，而非超时。独立纯文件系统夹具在加载前替换 ACL/native 边界，模拟不同的 64 位文件 ID 转为 Number 后相等、创建时间及文件内容相同；旧实现先 RED，未拒绝读取过程中的文件替换。该证据证明精度缺陷，但不单独证明它是该次托管失败的唯一因素。

候选只在存储路径模块改用 Node bigint stat，设备、inode 与纳秒创建时间精确比较，链接数和目录容量使用 BigInt；仅已通过原有大小上限检查的读取长度转为 Number 分配 Buffer。原文件名、配额、摘要、ACL、描述符前后核验及祖先固定均保留。四组纯回归通过：同内容替换、已固定数据库与目录替换、正常写入／重开固定／空文件、硬链接和同 inode 内容／长度篡改；格式、Lint、CI／release 治理通过，新测试进入统一 unit 发现。没有执行本机原生权限、DPAPI、产品 worker、安装器或真实模型。

上一候选 `d30bb482` 的诊断 `39970599297` 已终态失败，N09 job `120471929729` 仍为 118，N08 job `120471930293` 仍为 71。规范 profile 修复没有解除实际读回阻塞；GET 传输／解密延迟与其余一致性条件尚待区分。该候选 Verify `39970599190` 与 disposable `39970599105` 本次查询仍 in_progress，沿用原句柄，不重启或改判。整体目标未完成。

## 2026-10-23：配置保存已越过两秒期限，修复有效配置读回契约

候选 `1b2c81aa` 的独立诊断 `39965909873`，N09 job `120455614220` 返回 118，表明配置 POST 已在原两秒期限内返回成功回执，失败推进到 GET 读回或一致性校验；不能据此声称持久业务通过。N08 job `120455614930` 仍返回 71。独立 Verify `39965837043` 和完整 disposable `39965837173` 均 failure；Verify 的 unit2 为 inventory descriptor read 回归失败，coverage 仍有实际加密重开、ACL 与清理等失败，未将其归为已解决问题。

纯管理 HTTP 夹具已复现确定性契约缺陷：实际 loadConfig 会向原始单合成 profile 配置补入 Tianxi／WorkBuddy 两个官方默认项，管理 GET 再遮盖合成凭据；旧 N09 configure 和 restart attest 均误要求有效配置仅一个 profile。候选增加独立纯验证模块，严格接受恰好三个固定 profile、每项恰好六个固定字段、合成 apiKey 为管理遮盖标记、两个默认项无凭据。拒绝额外／重复／缺失项、目标及协议篡改、默认项凭据、稀疏／巨大数组、getter／Proxy 及继承字段；活动 profile、entryAuth profile/port 限定、TLS、原请求期限和网络隔离断言保持。

原单项回归先 RED，修复后四文件纯回归 51/51，另三文件组合回归 19/19，零失败或跳过。fixture 区分原始 POST 与有效 GET，并模拟实际凭据遮盖；不执行本机产品 worker、DPAPI、安装器、注册表、防火墙或真实模型。新测试由统一 unit 递归发现，格式、Lint、CI／release 治理通过。完整托管结果仍待验证，I0–I5/H1、N01–N11、容量、安装迁移与生产目标均保持未完成。

## 2026-10-23：实际 POST 两秒期限已确认，移除打包凭据加密的 PowerShell 启动链候选

`8078fc64056c5a87d1539513bcceb098fe81a41c` 的独立诊断 `39963668334`，N09 job `120447821376` 返回 126，确认原管理 POST 两秒定时器触发。该证据证明期限失败，不单独证明所有耗时都在加密；原同步加密路径确实包含首次双进程 probe、各字段 PowerShell protect 和后续解密，候选先消除其中可确定的启动开销。

候选在现有已打包 native 程序中增加独立 `--hpm-profile-secret-v1` 协议，使用与既有凭据相同的 CurrentUser、UI forbidden、无 optional entropy DPAPI，并在同进程严格回读比对后才返回。上下文数据密钥继续保留原专属 entropy 和协议。JS 只执行固定物理路径，拒绝符号链接／多硬链和符号链接父目录；字段只经 stdin，输出须为有界、无重复字段的规范 JSON 和规范 base64，所有失败为固定错误。打包原生路径失败不静默转后端；源码缺少程序或非 Windows 继续原兼容路径，超过 profile 协议长度的既有大 secret 也保持兼容处理，不截断。

原生 module、运行时源码清单和隔离构建快照均纳入变更及漂移拒绝回归。两项接线回归先在旧实现失败，JS 纯模拟／发布治理相关 33 项通过；Rust 三项 parse／模拟 roundtrip／固定失败测试通过，fmt、全 target clippy 通过。这里只运行纯输入与假加密回归，没有本机 DPAPI、产品 worker、安装器、注册表、防火墙或真实模型请求。实际 Windows DPAPI roundtrip 已进入既有统一原生 CI，是否解除两秒 POST、旧格式读取和完整 N08／N09 仍待新托管结果，完整目标未完成。

## 2026-10-23：配置 POST 确认没有可用响应，继续区分原两秒期限

`7ef3a17465217215d8befdf997b64ea5e64d3488` 的独立诊断 `39962150747`，N09 job `120442560939` 返回 121：配置 POST 发生传输／解码失败，没有进入 400／409／其他 HTTP 状态或成功回执校验分支。实际原因仍可能是请求期限、传输或响应解码，不能仅凭同步凭据加密代码认定真实超时。

候选保留原管理 HTTP 客户端两秒定时器，仅为该定时器自身产生的失败附固定 `HPM_DAEMON_HTTP_DEADLINE`，生命周期映射为固定 126；其他传输异常即使携带同名 code 也不会被转发或冒充期限事件。原错误信息、一次 POST、响应大小、解码、配置断言和 Job／清理期限保持。补真实定时器加假传输的无网络回归，以及生命周期到固定退出码的组合测试；不使用本机 DPAPI 或产品进程。等待托管结果后再决定性能修复，完整目标保持未完成。

## 2026-10-23：冷启动修复已越过实际状态检查，失败推进到配置 POST

`b7204fc97acae6e21ed827295a18504285d9d25d` 的独立诊断 `39961087867`，N09 job `120438954869` 返回 117。实际 IPC 启动、private preload 等待、凭据隐私、管理健康身份和初次配置 GET 已越过；失败发生在 POST 配置请求或其响应校验，尚未 seed 原文。不能把该阶段当作完整恢复通过。N08 同轮仍失败，完整目标未完成。

下一候选保留原 POST 两秒期限、一次请求、完整配置与读回断言，仅将失败分为固定码 121（传输／解码）、122（400）、123（409）、124（其他拒绝状态）、125（200 但成功回执格式不符）。不会披露响应体或错误，也不通过增加超时假设解决问题。该诊断用于区分配置契约拒绝与加密／持久化延迟等候选原因；真实具体原因尚未确定。

## 2026-10-23：N09 越过 IPC 启动，修复冷启动就绪竞态候选

`a85eb5cf9396a8aef0c1b25f8d864ded500a5be0` 的独立诊断 `39959853373`，N09 job `120434810685` 已失败于 114。IPC lease 已返回宿主身份，失败在首个 status RPC 或其存活／凭据隐私／preload 判定，尚未进入管理 HTTP。该固定码本身不能区分具体状态字段，不能声称真实根因已确定。

静态执行链证明启动只释放 gate 后立即返回身份；preload 与管理凭据文件在子进程随后初始化。旧管理入口却仅检查一次，合法冷启动会被拒绝。纯冷启动协议回归先在旧实现失败；候选拆出独立、有界的 metadata readiness 等待，只有 alive、credentialsPrivate、preload passed 全部满足才进行原健康身份校验。进程退出、preload failed、未知字段／类型、getter／Proxy、RPC 异常均安全拒绝。等待与配置应用共用原 15 秒预算，并限制 300 次 metadata 轮询，时钟回退／到期和迟到成功不放行，不改变外层 Job 期限；没有额外模型请求。纯回归已证明该竞态缺陷和修正，但是否解决实际托管 114 仍须新候选验证。

## 2026-10-23：Verify 全部通过，N09 首失败点确认在业务宿主启动

`9f0ef0f1fb2c705ed237ad3e98cfcdc112f68a8e` 的 Verify `39957936206` 已 success；该次结果不证明此前偶发的五秒持久请求性能问题已经根治。完整 disposable `39957936200` 仍在运行，沿用原句柄继续观察。独立诊断 `39957936184` 的 N09 job `120428345859` 返回 101：进入首个 committed-observed 场景的业务宿主启动，尚未 seed 原文。按实际执行顺序，该轮此前的 TLS 和出站阻断探针已越过，不能延伸为完整业务或环境恢复通过；N08 仍失败。

下一候选将业务宿主启动细分为 109–120 固定阶段，区分 adapter 启动、IPC lease start、管理 status／health、配置 GET／POST／读回及持久存储应用。阶段观察传入真实生命周期，不改变业务操作、配置校验、清理、期限、请求数或资格断言。父边界仅接受固定整数及完整固定失败格式，继续拒绝未知码和附加文本；没有输出 token、原文、异常或原生回复。本机仅执行纯模拟与安全测试子进程，没有启动产品 worker／DPAPI／安装器／防火墙，没有真实模型请求。完整目标保持未完成。

## 2026-10-23：路径修复后 adapter 清理越过，继续定位首场景

`7dd7ce86dc4db981e3408f67f9f795e314e41e9d` 的独立诊断 `39956824308` 两端已失败。N09 job `120424616662` 返回 80，已不再返回 adapter 清理失败 98，说明该轮 adapter／listener 清理未拒绝，但首个 committed-observed 场景仍失败；网络环境恢复仍失败。N08 job `120424616253` 仍为 71，不能与 N09 混用为通过证据。

下一候选为原场景补 101–108 固定步骤：启动业务宿主、通过业务 HTTP 种入原文、首次 committed 快照、强制 kill、同目录重启、重启后快照、业务精确读回和最终会计一致性校验。所有步骤、实际方法、断言、finally kill／close 与期限保持。父边界仅扩充这些固定整数，primary-phase 解析继续拒绝 85／97／100／109、额外文本和无效编码，不输出业务数据或异常。

五文件 47/47 相关回归通过、零跳过，覆盖原顺序、八阶段逐项拒绝、非法／Proxy 观察器、已拥有资源收尾和安全子进程固定码。Lint、PowerShell 解析、CI／发布治理通过；原 44 项路径修复回归保持。该候选仍待新托管结果，本机产品／DPAPI／安装器／防火墙与真实模型请求均未执行，完整目标未完成。

## 2026-10-23：修正 N09 重定位生命周期的原生 Job 源码路径

`14683eff96b6594ea8788a69d833d667737ebf33` 的独立诊断 `39955592207` 已失败；N09 job `120420522440` 同时返回 98 和原始阶段 80，确认首个 committed-observed 场景内失败，随后 adapter 清理失败。不能从清理失败认定场景已完成，也不能认定具体启动子步骤已经越过。

静态链路核对发现独立缺陷：控制器重定位目录只写入两个控制器入口文件，而 `New-HpmN09OwnedLease` 在首次原生 Job 类型尚未加载时，仍从该目录寻找 `nsis-runtime-boundary-job.cs`。本地纯文件回归先证明生成的生命周期仍指向不存在的副本位置。候选沿用原固定 candidate Job 源码，增加独立 SHA256 准入与复制后复核，并将生命周期中的该编译路径替换为已核验原文件；不改 Job 类型、约束、ACK、期限或业务断言。

相关五文件 44/44 纯回归通过、零跳过，覆盖错误／空／非法摘要、缺失原文件、源码闭包及原业务和清理边界。没有编译或运行原生 Job／产品 worker／DPAPI／注册表／安装器／防火墙，也没有真实模型请求。该路径缺陷已被本地证明，但是否解除实际托管阶段 80／98 仍待新候选验证，完整目标保持未完成。

## 2026-10-23：N09 确认 adapter 清理失败，保留被覆盖的原始阶段

`fba58206ff2903681712149609cb26e5a66da9a8` 的独立诊断 `39954540073` 已失败；N09 job `120416971974` 返回 98，证明 adapter 清理失败、listener 清理成功。网络恢复仍失败，不授予隔离或业务资格。`103aeaf9` 的 Verify `39953340609` 也已失败；其 disposable `39953340429` 尚在运行，不重启或以观察超时替代终态。

候选仅为清理失败附加一个固定的原始阶段：N09 stderr 必须完整符合固定前缀、两位数字、换行且不含任何额外内容，父边界才披露白名单 73–84／86–96 的整数；未知码、重复字段、附加文本、超长、非法 UTF-8、空输入均不披露。stderr 沿用原 4096 字节上限，子进程失败、所有权／Job 清理、管道和期限保持；不会把原始 stderr 或异常上传。此观察用于同时定位早期业务失败与后续清理失败，不把清理失败改判为成功。实际新托管结果仍待验证。

## 2026-10-23：WFP 读回已越过，N09 清理资源细分

`103aeaf9324ea7dee389f6d92395f821b970148a` 的独立诊断 `39953340466` 已失败：N09 `120412975620` 返回 84，N08 `120412975240` 返回 71，两端网络最终恢复均失败。此前的 WFP 安装／读回阶段已越过，但不能据此认定实际正负连接、业务或恢复通过。N09 清理失败会覆盖先前阶段，需要区分具体资源，而不是重新解释为业务成功。

下一候选保留 84 为正常清理回执核对，新增仅含固定资源类别的退出码 98（adapter 清理失败）、99（listener 清理失败）和 100（两类均失败）；所有已拥有资源仍尝试清理，异常保持失败，不转发错误、对象或原文。纯组合及安全子进程回归 13/13 通过，覆盖三类失败、未知码 85／97／101 拒绝和原期限／管道／Job 清理；未运行本机产品 worker、DPAPI、注册表、安装器或防火墙。

另外，`57734593` 的 Verify `39951411860` 与 disposable `39951411856` 均已失败。独立 unit 和 coverage 的共同失败项实际为 Responses WBIPC 请求在 `client-context-target.test.js:2736` 等待响应时超时；日志中的 `ERR_SECRET_DECRYPTION_FAILED` 不是该失败的已证实根因。新候选的 Verify `39953340609` 和 disposable `39953340429` 仍须跟踪各自终态；完整交付保持未完成。

## 2026-10-23：WFP 已添加到读回阶段，修正表示等价校验

`577345935d0fa8540fca58a091c74c54a895f9e3` 的 N09 独立诊断 job `120406512607` 失败于固定 WFP 阶段 10（规则读回校验）；会话、应用身份、sublayer、至少一条规则添加和原生读取已越过，但尚未执行实际连接探针，不能宣称隔离生效。

本地合成后端复现了两个等价表示的拒绝：条件数组顺序变化，以及 SDK 定义的 INDEXED 优化标志。候选按字段 GUID 校验条件身份并拒绝重复／额外字段，仅允许无标志或 INDEXED；persistent、disabled、未知标志、动作、数量、匹配类型、应用身份字节与唯一允许 IPv4 地址仍严格校验。不是删去读回门禁，也不替代实际正负网络探针。固定读回阶段细分为 12–22，后续可明确身份、flags、动作、条件和应用字节等失败，仍不输出原生回复。

两项合成等价表示先在旧实现失败，修复后通过；扩展为 24 项拒绝，包含禁用／持久标志、重复条件和错误地址，另保留原生布局、回滚、关闭重试和 10 项路径准入。实际托管读回差异的具体项尚未证实，候选是否解除该阻塞仍待新一轮验证。本机原生 WFP 调用和真实网络请求为 0，完整目标保持未完成。

## 2026-10-23：两端负向连接成功，新增动态 WFP 隔离候选

`08b84db76cfa38fa9da9332179a2519cbabff46a` 的独立诊断 `39948896985` 已失败，N09 `120398238109` 与 N08 `120398238444` 均返回 95：受限 Node 到本机非回环地址的连接实际成功，现有 Windows Firewall 规则不能满足这项负向探针。此前仅有规则创建、读取和地址过滤核对成功，不能据此授予实际隔离资格。

候选保留原防火墙和负向探针，新增独立 C# 动态 WFP 会话：仅允许 RUNNER_TEMP 下固定 N08／N09 payload 的 Node 路径；校验实体路径和宿主标记后才调用系统 API。按应用 ID 加入 ALE_AUTH_CONNECT IPv4／IPv6 阻断条件，IPv4 唯一例外为 127.0.0.1，IPv6 全阻断；自有动态 sublayer 与 filter 均不持久化，添加后按 ID 读回条件及应用身份。原拥有子树已确认关闭后才释放会话；未确认关闭或释放失败保持失败，不授予业务资格。原 TLS、实际基线、拒绝断言、Job 和所有期限保持。

新 helper 纳入源码身份和两端 libraryPins，先校验摘要再编译。固定原生阶段 1–11 只用于定位守卫、创建、读取和关闭失败，不输出 API 状态、异常、地址或用户数据。本机仅编译并运行合成后端：原生布局、精确条件、19 项拒绝、部分添加失败回滚、关闭重试和 10 项路径准入已通过；四文件 18 项相关回归通过，原生 WFP 调用、真实网络和模型请求均为 0。实际 WFP 安装、阻断和恢复仍待隔离 Windows 托管验证，不能预先宣称修复生效；完整 I0–I5/H1、N01–N11 及交付目标保持。

## 2026-10-23：N09 网络失败定位到受限 Node 负向连接

`f63324adf8eea40df56f00452b248efe4ab31ed6` 的 N09 独立诊断 job `120394726650` 已失败，固定码 93。探针准入、监听器身份、CA、DNS、TLS、本机非回环基线和基线连接计数均已越过；受限 Node 未取得符合原断言的拒绝结果。尚不能区分成功连接与非权限类连接错误，也不能仅凭规则创建成功证明网络隔离。

候选补固定码 95（负向连接实际成功）和 96（连接错误不构成权限拒绝），只披露这两个枚举，不输出错误码、消息、地址或原生回复。两类结果均继续拒绝，白名单仍排除 85、97；正常成功路径、原期限和网络保护不变。纯夹具覆盖两类失败及原安全边界，托管复验待进行。

## 2026-10-23：清理已越过，N09 定位到网络探针

清理修复 `992e7c51bcf448b08c23ad5c8efc1c09f13fe6c5` 的独立诊断 `39946751950` 仍失败，N09 `120391167346` 返回 76（网络探针），N08 `120391167412` 返回 71。N09 清理成功后保留了原失败阶段，已越过先前 84；不能推导网络保护或后续业务已通过。

下一候选将共享探针细分为固定码 86–94：探针准入、监听器身份、CA 摘要、DNS、TLS、本机非回环可达性基线、基线连接计数、受限 Node 的拒绝探针和最终连接计数。两端入口转发固定整数，Job 白名单继续拒绝 85 和 95，不输出原始异常或原生回复。TLS、主机绑定、严格证书验证、实际基线及拒绝断言、2 秒／1 秒原期限保持。

纯 VM 夹具替代全部网络和子进程，先复现缺失阶段信息，再验证完整成功路径、逐阶段拒绝、七项实际断言失败和非法观察器；没有执行真实网络或原生存储。正式托管复验仍待进行，整体范围及发布资格保持未完成。

## 2026-10-23：托管清理阶段失败，修复连接关闭事件竞态

`ee9512f050c266cac4d2c95393cbd9203e81ed1e` 的独立诊断 `39926201116` 已失败：N09 job `120323082856` 返回 84（清理阶段），N08 job `120323083185` 返回 71。清理失败可能覆盖先前业务失败，因此不能从 84 推导其余业务阶段已通过。

本机仅用临时回环 TCP 连接确认 Node 的 server.close 回调可先于 socket.close 事件；旧共享监听器立即检查连接集合，可能将正常收尾误判失败。将关闭逻辑拆为独立模块，销毁前先订阅每条已拥有连接的 close，等待服务器及连接全部收尾后再检查集合；异常时仍尝试其他资源并保留失败。沿用外层原 Job 期限，不增加宽限、不放松清理断言、不改变 TLS 或防火墙。

同一源码的独立 Verify `39926201154` 已成功；完整 disposable `39926201197` 的 source-gates `120323083563` 和 egress 均成功，但业务 N09 `120328242962`／N08 `120328243007` 失败，不能授予完整资格。新清理模块已验证会进入两端静态依赖 pin 闭包，未执行产品代码。

旧顺序在确定性事件夹具和真实临时回环两项回归均先失败，修复后通过；相关四文件 11 项回归通过，覆盖空资源、已停止监听器、关闭异常、不完整所有权和静态闭包。没有运行产品 worker、DPAPI、注册表、安装器或真实模型。此缺陷已本地证明，但尚待新托管确认是否解除 84，其他业务失败和完整交付资格继续未完成。

## 2026-10-23：N09 组合内部固定阶段诊断

独立诊断 `39923636426` 两格均失败；N09 已返回固定入口码 71，证明失败在组合内部，不能归因于已通过的入口授权、计划或依赖闭包。新增组合内部码 73–84，依次为组合准入、业务适配器、监听器、网络探针、控制器、生命周期、复制文件复核、committed、clear、save、revoke 和清理。入口仅接收这些固定整数，共享 Job 只扩展固定码白名单，仍不转发 stderr、异常、凭据或原文；其余退出保持 `other`。业务失败后成功清理不会覆盖原阶段，清理自身失败单列 84。

纯组合回归先在旧实现失败，候选覆盖四场景成功、逐阶段拒绝、全部已获取适配器清理、清理失败和非法观察器；没有启动产品 worker、真实监听器、DPAPI、注册表、安装器或模型请求。安全子进程回归另覆盖白名单两端和 85 拒绝。当前仅完成诊断细化，尚未获得新托管业务结论；原业务断言、期限、网络保护和完整资格要求保持。

## 2026-10-23：独立业务诊断仍失败，补固定入口阶段

`8a77c934ba9fd5dce75dd0be0e61a569c9d437f2` 的独立业务诊断 `39922362542` 两格均失败：N08 `120310385644`、N09 `120310385964` 仍为 `hpm_runtime_child_failed_stage=child_exit`。stdin 无 BOM 缺陷虽已由安全子进程回归证明修复，但没有解除此托管阻塞，不能认定为其唯一根因。日志按 job ID 私有封存；正式两路门禁仍需分别跟踪。

候选为固定入口增加非零退出码 64–72，分别标记环境、授权、计划路径、计划内容、pin 文件、依赖闭包、计划契约、业务组合和最终回执；共享 Job 边界仅披露这些码，其余退出记为 `other`，始终不转发原始 stderr 或异常。19 项相关回归通过，覆盖安全子进程的前六个拒绝阶段、未知退出拒绝、BOM、管道上限、原期限及清理；当前真实源码的静态闭包核验 N08 86 文件／N09 99 文件通过，未执行产品。Lint、PowerShell 解析、CI／发布治理通过。业务诊断增加相关源码路径触发，正式门禁未改；托管阶段证据待复验，测试调度隔离尚未进入正式执行器。

## 2026-10-23：资源实验源码独立 Verify 全绿，业务诊断解耦准备

资源实验已终态：`39920379859` 中 `120303911139` 按 4→1 两档均通过，用时分别 191156／447246ms；`120303911451` 按 1→4 用时 462288／277798ms，串行通过、并发 4 失败于 Chat long-persistent 第 0 轮请求 5009ms。两次串行成功和并发档的一次失败支持进一步定位文件间资源竞争，但样本不足以证明唯一根因或正式稳定资格。全量串行明显延长执行时间，尚未修改正式测试调度；后续评估仅隔离持久请求文件。终态日志私有封存，固定数字提取器 `summarize-resource-probe-v1.cjs` 不输出原始日志或测试内容。

`41fb9a9c5a67a878f821456fdaf6dbd318f40239` 的独立 Verify `39920379670` 八个 job 全部成功，包括 coverage `120303911855`。同一源码 disposable `39920379860` 的 source-gates `120303911764` 仍在 unit 阶段因 Claude long-persistent 第 0 轮请求 5002ms 失败，N08／N09 跳过。两路结果分别保留，不从独立成功认定稳定性或完整资格。终态日志已按 job ID 私有封存。资源对照 `39920379859` 两组完整实验仍在运行，未给出并发影响结论。

新增独立 N08／N09 业务边界诊断工作流，复用原源码 SHA、payload／plan pin、网络保护、bounded Job 及业务断言；仅将定位任务与完整源码门禁解耦，不改动正式工作流的 `needs: source-gates`、完整 verify 或安全审计。该诊断不会授予发布或业务资格，当前仅完成工作流与治理回归，真实托管结果待收集；本地不执行真实 worker、DPAPI、注册表或业务原生环境。完整 I0–I5/H1、N01–N11 和交付边界保持。

## 2026-10-23：编码候选仍受持久请求期限阻塞，准备资源对照

`1e5b0f103c6b0eff4ac9c0ff003950066bb1eecf` 的 Verify `39918613152` 七个 job 成功，coverage `120298099314` 失败于 Chat long-persistent 第 0 轮的发布等待，5014ms 触发原 5000ms 期限。disposable `39918613280` source-gates `120298099656` 在 unit 阶段失败于 Chat long-persistent 第 1 轮请求，5000ms；N08／N09 跳过，因此 stdin 编码修复尚无托管业务效果结论。标准暂存已按此提交重建，536 份源码和关键程序摘要一致，回执 `current-1e5b0f10-staging-v1.json`。日志按 job ID 私有封存。

独立资源诊断工作流准备以两组 Windows runner 分别按 1→4、4→1 的文件并发顺序运行原完整客户端覆盖率命令。测试清单、覆盖率阈值、实际持久操作和各测试原期限均保持；直接读取当前 package 脚本生成 Node/c8 argv，不经过 shell、不维护缩小的测试清单。每组观察到任一次失败后仍记录另一并发档，最终 job 保留失败。诊断不授予资格，也不修改正式 Verify、完整 source-gates 或其并发配置。参数、安全拒绝及本地执行保护 3 项回归、Lint、格式、CI／发布治理通过；实验尚待托管结果，不先认定资源竞争为根因。未在本地运行真实存储 worker 或模型请求。

## 2026-10-23：完整源码门禁通过，独立覆盖率与托管业务仍失败

`9c915d26b55e9a03a5e3e33c34b4585d34cf6cc2` 的 disposable `39916258882` source-gates `120290388292` 已通过字面 `npm run verify` 和依赖安全审计；N08 `120293877914`、N09 `120293878028` 均在约 11 秒的受限子进程执行阶段失败，固定诊断为 `child_exit`。独立 Verify `39916258979` 七个 job 成功，coverage `120290387652` 失败：Claude long-persistent 第 0 轮正文 4249ms 完成，发布等待在 5004ms 触发原 5000ms 期限；附近两次 SQLite commit 分别 1288／1295ms。不能从单个源码门禁成功推导稳定性，也不能将磁盘竞争认作已证明的唯一根因。终态日志私有封存，汇总 `current-9c915d26-qualified-split-v1.json`。

同一源码的正式五档容量合成命令全部通过，工作线程用时 46723.544ms，单次达到原 60000ms 目标；负载、逐页验证、重开及最终结果断言保持。该结果不是覆盖率环境稳定性能、真实 SQLite、传输或全天活跃任务资格。标准暂存重建成功，536 份运行时源码和关键程序摘要一致，清单与上一暂存相同；回执 `current-9c915d26-staging-v1.json`、`current-9c915d26-staging-binding-v1.json`。未重跑上一四格矩阵，也未构建或执行当前 NSIS／GUI。

共同入口编码缺陷已在安全子进程中先失败后修复：当调用方提供带 BOM 的 UTF-8 stdin 编码时，原 Job helper 写入的授权不再是子进程要求的单字节 `1`。共享边界现在在启动前固定无 BOM UTF-8；测试故意保留带 BOM 调用方，证明边界自身规范化。16 项相关回归、PowerShell 解析及治理通过，真实存储 worker、DPAPI、注册表、安装器和模型请求均未在本地运行。此候选尚待托管复验，不将可复现缺陷直接等同于上述两项托管失败的已证根因。全部 I0–I5/H1、N01–N11 与安装迁移、全天和生产目标保持。

## 2026-10-22：当前暂存原生四格通过，托管持久门禁仍失败

`2717104bf4f93f6e96d7ff88da9266066ebbd46a` 的干净 delivery 工作树已完成标准 release:prepare，536 份清单源码在工作树／暂存／摘要间一致，Node、辅助程序、锁文件与发行目录通过；证据 `current-2717104b-staging-v1.json`。实际暂存 Node／代理模块两文件纯回归 70/70，工作区代理回落 0，并显式排除及阻断本机真实 worker；证据 `current-2717104b-staged-pure-v1.json`。尚未构建或运行该源码的 NSIS／ZIP／GUI。

原生 Codex／Claude 的默认／增强四格合成任务均通过，各三次原生压缩；增强精确读回旧原文，默认零恢复，私有工具未泄漏。代理模块固定到当前暂存，辅助夹具从日常根映射到当前提交；Claude MCP 合成来源使用暂存 SDK。四格均工作区代理回落 0、JS 网络拒绝计数 0、原生客户端进程已收尾、配置未变、真实模型请求 0；源码、暂存、九份私有代码夹具及两个原生客户端二进制前后摘要不变。证据 `native-matrix-2717104b-outcome.json`。受控路由／认证、合成模型、临时客户端 home 的边界保持；JS 网络保护不是原生客户端的 OS 防火墙，不授予提供方质量、计费、真实持久化、安装、迁移或生产资格。

同一源码的 Verify `39913024683` 已 failure：七个其他 job success，coverage `120280141323` 的 Claude long-persistent 第 1 轮约 5007ms 请求失败。disposable `39913024675` 也已 failure：source-gates `120280141254` 的 Responses 第 0 轮约 5008ms、Claude 第 0 轮约 5001ms 请求失败；actual idle worker 在 reopen 阶段触发原 30000ms 测试期限；独立长历史进程在原 20000ms 子进程期限 ETIMEDOUT。业务 `120284084931` 跳过。终态日志按 job ID 私有封存，原期限和全部负载保持，不从合成四格通过推导源码链通过。

独立长历史进程的测试辅助器经检查仅使用显式随机数据密钥与直接 SQLite，不创建原生 owner／DPAPI／注册表。当前源码该单项在本机原期限及覆盖率下通过，证据 `current-2717104b-loading-covered-v1.log`；本机父进程保留原生入口 guard。局部通过不能替代托管失败，也不足以将资源竞争判为唯一根因。下一步须进一步定位托管 reopen／子进程内部耗时，避免仅靠反复微优化和重跑等待绿色。I0–I5/H1、N01–N11、当前包、私有迁移、全天和生产目标继续未完成。

## 2026-10-22：创建器候选独立 Verify 全绿，完整源码链仍失败

`2b04bf2ee4abb8b8ad75bffaacc4a9ab9f4e182b` 的 Verify `39911220219` 已 success，八个 job 全部 success，包括 coverage `120274434852` 的代理／客户端／前端覆盖率。终态回执 `current-2b04bf2e-verify-terminal-v1.json` 和 job 日志私有封存；long-persistent 三协议两轮的最终发布等待均在原 5 秒内完成，最慢观察为 Responses 4619ms。这只证明这轮成功，不撤销此前失败或授予稳定性资格。

同一源码的 disposable `39911220297` 已 failure：source-gates `120274434818` 的 Chat 第 1 轮、Responses 第 0 轮、Claude 第 1 轮分别在约 5003／5010／5029ms 请求失败，业务 job `120278725886` 跳过。日志 `hosted-job-120274434818-final.log`；egress success。两路结果分别保留，完整 N08／N09 与源码链尚未通过，不取消或重启旧任务。

为精确重建资格准备，复用干净的 context-recovery-delivery 工作树切换到该源码，原 detached 提交 8a91d7f8 另以本地 codex/preserve-context-delivery-8a91d7f8 分支保留，未推送；npm ci 已退出 0，证据 `current-2b04bf2e-delivery-npm-ci-v1.log`。源码链失败后暂缓安装包重建，没有启动安装器或本机持久 worker，日常配置未改。已完成 241 项纯回归的解析器候选 c071afc9 将在安全扫描后正常推送复验；性能微基准限制仍按下节保留。完整 I0–I5/H1、N01–N11、私有迁移、全天和生产目标未完成。

## 2026-10-22：解析器规范化副本指纹候选，前一托管仍运行

`2b04bf2e` 的 Verify `39911220219` 七个 job 已 success，coverage `120274434852` 仍运行；disposable `39911220297` 的 source-gates `120274434818` 仍运行，egress `120274435254` success。不取消或重启原任务，不从普通 unit 通过推导覆盖率或 N08／N09 资格。

解析器候选保留 checkpointData 对每次未知输入完整规范化及最终尺寸限制，只将摘要投影的再次公开 fingerprintRecoveryCheckpoint 准入改为对本次已拥有字段调用内部同算法指纹。外部摘要仍逐次重算比较，语义校验和 expected 关联保持；不缓存或跨事务共享数据。新回归先在原实现因重复指纹准入失败，候选验证每调用一次输入准入、每次返回独立副本、篡改摘要／非法预算／空值／getter／Proxy 拒绝；原创建器回归只更新公开函数调用数断言，篡改摘要拒绝断言保持，另以直接准入计数证明外部边界仍执行。

六文件纯回归 241/241，显式排除 encrypted worker／actual storage worker writes 并保留本机原生入口 guard，证据 `checkpoint-owned-parser-before-v1.log`、`checkpoint-owned-parser-targeted-v1.log`、`checkpoint-owned-parser-expanded-v1.log`。随后补充旧信封缺 publications 的兼容与 null-prototype 副本断言，两项定向通过 `checkpoint-owned-parser-legacy-final-v1.log`；首次比较 plain-object 与 null-prototype 副本的测试断言失败另留存，未改变产品行为。

600 KB、预热后首轮八组实验墙钟中位数约下降 12%；随后绑定实际候选与 HEAD 源码的十六组、每组 20 次外部解析，墙钟中位数约 285.87→267.66ms（约 6.4%），CPU 中位数 266→264.5ms，且候选出现 1662.74ms 长尾，结果波动明显。两轮均保留于 `owned-checkpoint-parser-experiment-v1.json`／`v2.json`，不能据此声称稳定 CPU、完整持久请求或磁盘收益；未启动本机持久 worker、DPAPI 或注册表锚点。候选尚未推送，完整 I0–I5/H1、N01–N11、当前包、私有迁移、全天和生产目标仍未完成。

## 2026-10-22：创建器指纹复用已规范化载荷，扩大纯回归通过

前一轮 CPU 剖析后确认 createRootCheckpoint 在 checkpointData 完整准入后又通过公开 fingerprintRecoveryCheckpoint 重复规范化相同载荷。候选仅在这个同步创建器中调用内部 fingerprintNormalizedValue；载荷准入、最终信封准入、摘要算法和外部 parser 的独立摘要验证保持，不缓存原文、不改变持久事务、独立锚点、ACK、期限、预算或 TTL。新回归在原实现先因重复准入失败，候选确认创建器不重复公开准入、外部 parser 仍验证摘要并拒绝篡改，版本 1／8／9／10、数字属性、负零、Unicode／转义和副本隔离摘要一致。

六文件显式排除 encrypted worker／actual storage worker writes 并保留私有原生入口 guard，240/240 通过，零失败／取消；这是选中纯回归的结果，不含被排除的真实持久测试。证据 `checkpoint-owned-fingerprint-before-v1.log`、`checkpoint-owned-fingerprint-targeted-v1.log`、`checkpoint-owned-fingerprint-expanded-v1.log`。同一 600000 字节原文、内存 SQLite、每实现预热 20 次、16 组正反交替各 20 次快照，墙钟中位数 561.59→531.23ms（约 5.4%）、CPU 中位数 570.5→523.5ms（约 8.2%）；证据 `checkpoint-owned-fingerprint-benchmark-v2.json`、`checkpoint-owned-fingerprint-benchmark-summary-v1.json`。早期未充分预热样本另存 v1，不用于代替后续结果。该收益不证明完整 5 秒请求或磁盘性能达标，尚待新候选完整托管。原 I0–I5/H1、N01–N11、当前包、私有迁移、全天和生产目标不缩减。

## 2026-10-22：hydration 候选托管终态，发布确认仍超时

`bdc7bbe13cc2cfbd319c09869e3d26d97c125444` 的 Verify `39908900710` 已 failure，七个其他 job success，coverage `120267081278` 唯一失败为 Claude long-persistent 第 0 轮：正文 4361ms 收完，但 publication_wait_failed 在 5001ms 触发原期限。普通 unit job `120267081254` 中三协议两轮正文约 1291–1548ms，不能替代覆盖率资格。disposable `39908900514` 也已 failure：source-gates `120267080232` 的覆盖率阶段三协议失败，Chat 正文 4522ms 后最终发布等待在 5002ms 超时，Responses／Claude 请求分别在 5005／5016ms 失败；业务跳过。日志均按 job ID 私有封存，不取消或重启原任务。

新的纯内存 SQLite 80 次候选快照 CPU 剖析确认规范化、指纹编码和哈希仍占明显成本，证据 `hydration-candidate-bdc7bbe1-v1.cpuprofile`、`hydration-checkpoint-profile-bdc7bbe1-v1.json`。该诊断没有本机持久 worker、DPAPI、注册表锚点，不证明磁盘或完整期限已经修复；原期限、独立锚点落盘与 exact CAS 确认保持。

检查同一规范化边界时补充引用版本探测的 Proxy 回归：输入及 metadata 的 descriptor trap 在旧实现先执行，测试失败；候选先拒绝 Proxy，普通对象、v9/v10、大小和指纹规则保持。扩大两文件 69 pass／4 skip，显式排除 encrypted worker 并保留私有原生入口 guard；首次未筛选运行的四项均被 guard 立即阻断，69 pass／4 fail 日志保留，未授予真实持久资格。证据 `reference-proxy-before-v1.log`、`reference-proxy-expanded-v1.log`、`reference-proxy-expanded-pure-v1.log`。此安全增量未推送，不解决发布确认超时。全部 I0–I5/H1、N01–N11、当前包重建、私有迁移、全天和生产资格仍未完成。

## 2026-10-22：恢复 hydration 重复解析候选，原持久请求期限仍待复验

`ef1ee580` 的 disposable `39906224760` 已 failure：source-gates `120258696172` 的 Responses long-persistent 第 0 轮约 5009ms 触发原 5 秒期限，业务 job 跳过。独立 Verify `39906224764` 也已 failure，其他七个 job success，coverage `120258696297` 的 chat long-persistent 第 0 轮约 5011ms 失败。两路均记录四次合成上游请求；终态日志按 job ID 私有封存。已通过的 `ff05b521` 安装 mechanics 不因此撤销，也不能替代当前持久请求门禁。

候选为内部 hydration 增加 createValidatedRootCheckpoint：原创建器仍执行载荷及最终信封的尺寸／结构规范化并生成摘要，随后复用外部 parser 同一个语义校验函数；外部 parser 保留原未知输入规范化、摘要验证和 expected 关联。减少对刚创建信封的重复全量解析，不缓存原文、不跳过 blob 认证、不改事务、锚点、原期限、预算或 TTL。新回归在原实现为 3 次直接信封规范化而非 2 次，先失败；候选为 2 次，外部 parser 仍再规范化并拒绝篡改摘要。空载荷、600 KB、非法预算／快照／载荷／发布、容量超限、独立副本、getter／Proxy 与原语义错误对照均验证。版本探测提前拒绝 Proxy，避免其 descriptor trap 先运行。

四文件带私有原生入口 guard 的扩大回归 170/170，显式排除全部 actual encrypted worker 和 actual storage worker writes，不算实际持久资格；证据 `hydration-checkpoint-expanded-v1.log`。最终测试名称／格式小调整另按受影响项核验。600000 字节同一合成原文、同一内存 SQLite、八组正反交替各十次 snapshot 的墙钟中位数约 222.50→171.60ms、CPU 中位数 219.5→172ms；证据 `hydration-checkpoint-benchmark-v1.json`。这是局部快照微基准，不能推导磁盘／锚点或完整 5 秒请求已达标。原 I0–I5/H1、N01–N11、私有迁移、全天及生产资格保持未完成。

## 2026-10-22：当前源码重建安装生命周期通过

`ff05b521` 的隔离 Windows 安装 mechanics run `39905400077`／job `120256079149` 已 success。源码身份校验、基线和当前 NSIS 构建、安装／升级／回滚／卸载步骤分别 success，终态日志中精确范围回执出现一次，确认合成配置／文件及原到期字节保留。私有证据为 `hosted-job-120256079149-final.log`、`current-ff05b521-hosted-installer-v1.json`。

固定基线仍为源码 `2295c452888449e9728b3ddcc2f80f31e9433e69`，两版使用合成版本覆盖；本次不上传安装器，不触碰日常安装。该成功覆盖当前源码重建的安装机制，不覆盖私有原始安装包、真实用户迁移、加密恢复／DPAPI 迁移、签名、全天任务、提供方行为或生产。`ef1ee580` 的恢复及独立 Verify 仍按原句柄跟踪；下文此前运行中描述为历史观测。完整 I0–I5/H1、N01–N11 仍未完成。

## 2026-10-22：公开 Job API 的实际安全子进程回归通过，安装进入执行

安装 mechanics `39905400077` 的 job `120256079149` 已完成两版 runner 源码 NSIS 构建，正在执行安装／升级／回滚／卸载；尚未取得终态。`ef1ee580` 的恢复 run `39906224760` 仍执行完整 source-gates，独立 Verify `39906224764` 另行跟踪，不重启或取消原任务。

原安全子进程夹具改为直接调用导出的有界 Job API，避免模块私有作用域掩盖导出遗漏。使用实际解包 Node 执行合成子进程，原回执、输出超限、非零退出、非法 UTF-8、原期限及后代清理三项父测试通过；没有产品、持久 worker、DPAPI 或注册表调用。另补仅固定枚举的 Job 类型／创建、进程启动／分配、stdin grant、管道、期限、输出上限、退出及解码阶段诊断；不输出子进程内容、原始异常、命令或环境。六条真实合成故障严格得到 output_limit 两条、child_exit、stdout_decode、deadline 两条，私有哨兵不进入日志。最终七文件扩大回归 38/38，证据 `hosted-exported-job-expanded-v1.log`；该诊断增量尚未推送，不等同 `ef1ee580` 的托管结果。

`ff05b521` 的便携 ZIP 已实际解包：清单中 536 份源码与工作树及摘要匹配，Node／原生辅助程序／锁文件匹配，便携应用 EXE 与实际构建 EXE 一致，发行目录治理和 1 NSIS／1 ZIP 摘要清单通过。证据 `current-ff05b521-portable-source-v1.json`；仍未执行本机安装器、GUI 或改动生产。全部 I0–I5/H1、N01–N11、私有迁移及全天资格继续按原范围验证。

## 2026-10-22：有界 Job 辅助函数缺少模块导出，回归修复待托管

`ff05b521` 的 disposable `39904545105` 已 failure：source-gates 和网络诊断 success，两路业务失败。N08 `120256789496`、N09 `120256789510` 现均进入 owned-job 内部并记录 `bounded_child`，另有 network restore failure，不能授予业务或清理资格。日志按 job ID 私有封存。与上一源码没有 job-stage 诊断的失败不同，闭包调用已经越过函数解析边界。

后续模块导入回归在原代码上失败：原 `nsis-runtime-boundary.psm1` 定义但未导出 `Invoke-HpmBoundedRuntimeChild`，而两路 owned-job 都在模块外按名称调用它。候选显式导出原共享函数，保留全部原实现、120 秒外层和内部期限、stdin grant、Job 分配、4096 字节管道上限、StopAndWait 和清理规则。回归修改前 0/1，六文件扩大回归修复后 35/35，分别为 `hosted-job-export-before-v1.log`、`hosted-job-export-pure-v1.log`；原 receipt-only PowerShell 解析用例另通过 1/1，没有运行产品、持久 worker、DPAPI 或注册表。新真实托管结果待确认。

`ff05b521` 的便携包标准构建已退出 0，`verify-release-artifacts.js` 确认 1 份 NSIS 和 1 份 ZIP 的大小与 SHA256 清单通过；该检查尚不等于 ZIP 解包源码或实际安装资格。当前包与安装 mechanics 仍绑定原 `ff05b521`，不能冒称后续辅助脚本候选已通过。I0–I5/H1、N01–N11 与生产范围保持未完成。

## 2026-10-22：闭包修复源码门禁通过，当前 NSIS 构建及包内合成回归通过

`ff05b521dad2cca70bd18408130b2afa2c5f33a7` 的 disposable `39904545105` 中，source-gates `120253357790` 和独立网络诊断 `120253357551` 已 success；N08 `120256789496`、N09 `120256789510` 已启动，业务终态待确认。独立 Verify `39904545131` 四个 unit 分片、质量、集成和 Rust success，客户端覆盖率仍待终态。没有取消或重启原运行，也未增加真实模型请求。

当前源码本机标准 `npm run build` 退出 0，生成 GUI／NSIS；仅用 7-Zip 解包，没有运行安装器或 GUI。staging 和 NSIS 分别核对清单中 536 份源码均与当前工作树一致，Node、原生辅助程序和锁文件摘要匹配，实际 NSIS 解包目录通过发行目录治理。私有证据为 `current-ff05b521-build-v1.log`、`current-ff05b521-staging-v1.json`、`current-ff05b521-nsis-source-v1.json`。

使用实际 NSIS 内 Node，并将测试代理模块解析固定映射到解包目录，reader／publication 两文件合成回归 70/70，工作区代理模块回落 0；显式排除两项真实 worker 测试，另有私有 preload 阻断实际持久存储打开，证据 `current-ff05b521-nsis-pure-v1.log`。这不证明真实 worker、安装、迁移或全天能力。便携包组装另行跟踪，不能从 NSIS 结果推导 ZIP 完整性。

为并行推进当前源码安装 mechanics，正常创建精确指向 `ff05b521` 的 `acceptance/windows-lifecycle/20261022-mechanics-ff05b521`，触发 `39905400077`；job `120256079149` 已进入 runner 源码基线构建。固定基线保持 `2295c452888449e9728b3ddcc2f80f31e9433e69`，不改默认分支，不上传安装器；不授予私有原包或真实用户数据迁移资格。原 I0–I5/H1、N01–N11 与生产范围保持未完成。

## 2026-10-22：业务入口闭包作用域回归已复现，修复候选待托管

`af56e4be` 的 disposable `39902537877` 现已 failure：source-gates 与独立网络诊断 success，N08 `120251652962`、N09 `120251652989` 的载荷构建 success，固定场景 failure。两路固定诊断均为 network owned_scenario、execution owned_job，且没有进入 owned-job 函数内部的 job-stage 诊断；收尾另记录 restore failure。原终态日志按 job ID 私有封存。

模拟网络与 Job 库、复制真实 execution 入口的回归在两路原代码上均失败，显式捕获局部已加载函数后均通过：GetNewClosure 创建的动态模块不能按名称解析调用方局部 dot-source 的 Job 函数。候选在原库指纹校验和加载后捕获 FunctionInfo，闭包仅调用该对象；原固定参数、Job、120 秒外层期限、内部期限、安全检查及收尾规则保持。模拟不执行本机网络、证书、注册表或原生存储；不从该回归授予真实 N08／N09 资格。更早的请求超时、存储收尾 EBUSY 与完整 I0–I5/H1、N01–N11 范围继续保留。

修改前两条回归 0/2，证据 `hosted-closure-before-v1.log`；修复后的诊断、PowerShell 解析、工作流治理、来源身份、N09 组合与共享边界六文件 34/34，证据 `hosted-closure-pure-v1.log`。LIST／发布两个文件再次以私有原生阻断入口验证 70/70，证据 `list-debit-boundary-final-v2.log`；真实 worker 显式排除，不能算作持久存储资格。受影响 JS 的 ESLint 零警告、格式及 diff 检查通过。

## 2026-10-22：当前完整源码门禁通过，N08／N09 已进入载荷构建

当前 `af56e4beb8aa39acee449295a4b19c28a635e7ad` 的独立 Verify `39902537855` 全部 success；coverage job `120247116788` 的代理、客户端、前端覆盖率步骤分别 success。disposable `39902537877` 的完整 source-gates `120247115892` 也已 success，N08 `120251652962`、N09 `120251652989` 已进入各自 runner-local 载荷构建，业务终态仍待确认。独立网络诊断 `120247116048` 已在真实 runner 回读并确认 IPv4、两个 IPv6 /1 及完整组合的 address filter，三组均 created／verified／cleaned true；原 IPv6 /0 拒绝保持。私有固定字段证据为 `egress-ipv6-split-native-filter-v1.json`。源码门禁和防火墙诊断不替代业务、安装迁移、全天容量或生产资格。

较早 `38bdd862` 的 disposable `39902047946` 已 failure，source-gates `120245585332` 失败，业务 job 跳过。终态日志 `hosted-job-120245585332-final.log` 确认 Claude WBIPC 所有权测试发生请求超时；四根／32 MiB 原生测试在 finally 删除 `.writer.sqlite` 时 EBUSY，尚不能从收尾错误推断先前业务操作成功或锁占用根因。当前一次全绿不能撤销这些稳定性问题。

新增 LIST 安全回归覆盖最大预算预扣 ACK 前不得执行 LIST，以及写前失败、写后丢 ACK、非法 ACK、挂起时关闭的保守扣款边界。隔离变异实现故意提前执行 LIST，被回归拒绝；最终带私有原生入口阻断 preload 的两个文件 70/70，显式排除两项真实 worker 测试，证据分别为 `list-debit-boundary-mutant-v1.log`、`list-debit-boundary-guarded-v1.log`。不合并 LIST 计算与结算来换取延迟收益，产品读前扣款及不确定 ACK 不退款规则保持。I0–I5/H1、N01–N11 原范围不缩减。

## 2026-10-22：托管已定位 IPv6 /0 规则拒绝，等价地址修复待主验收

独立 egress job `120245585579`（run `39902047946`，源码 `38bdd862`）已 success。五组固定结果：original 与 ipv6 的 `::/0` 在 create 阶段拒绝，category 5、HRESULT -2146233088、nativeCode 1；ipv4、ipv6_split、full_split 均 created／verified／cleaned true。日志 `hosted-job-120245585579-final.log` 只保留固定字段，不打印原始错误。本次独立诊断由同一 runner 上单独 IPv4 成功、IPv6 /0 失败及两半 /1 成功的对照定位到地址表达式，不能泛化为所有 Windows 版本不支持 /0。

主网络规则将 `::/0` 改为 `::/1` 和 `8000::/1`，保持完整 IPv6 阻断及原 IPv4 仅排除 127.0.0.1；程序、方向、动作、profiles、启用、清理和原负向网络探针均保留。新地址回归在旧表达式上先失败（`egress-ipv6-split-before-v1.log`），随后四文件 mocked／解析／原 workflow 治理 18/18（`egress-ipv6-split-pure-v1.log`）。独立诊断还增加实际 address filter 回读比较，拒绝规则静默扩成 Any 或缺失地址；该新增回读本机仅 mock，通过不等于托管验证。网络主场景及 N08／N09 仍须原完整门禁之后验证。

暖态发布候选 `ce0ef15b` 的 Verify `39900803138` 已 failure：四个 unit 分片、集成、Rust、质量 success，coverage failure。原生客户端新合并发布断言在普通 unit 通过，但 coverage 的 chat／Responses／Claude 第 0 轮仍分别在 5006／5018／5014ms 触发原期限；合并发布记录分别 3／2／3 条，不等同全部操作成功。终态及固定字段逐阶段证据为 `hosted-job-120241692609-final.log`、`hosted-job-120241692609-final-sanitized.json`。该优化尚未解决完整性能门禁。原 I0–I5/H1、N01–N11、当前包、私有迁移、全天及生产资格仍未完成。

## 2026-10-22：网络失败已缩小到规则创建，新增独立诊断路径

`4e14f5e5` 的 disposable `39899488692` 已 failure：source-gates success，N08 `120242253238`、N09 `120242253172` 均记录 `hpm_network_failed_stage=egress_rule_create`。两者尚未启动业务场景；不能归因于 durable ACK 或宣称生命周期失败根因已修复。终态日志按各自 job ID 私有封存。`ce0ef15b` 的独立托管验收另行跟踪，不因本轮诊断变更取消或重启。

增加独立、最长 5 分钟的 egress-diagnostic job，跳过源码构建依赖仅用于诊断，不替代 source-gates → N08／N09 原验收链。一次性 hosted runner 内复制临时 Node，分别测试原三地址、IPv4、IPv6 /0、IPv6 两个 /1、原 IPv4 加两个 IPv6 /1；不启动副本、不改 hosts／证书或默认规则，不授予任何资格。仅输出固定 case、阶段、布尔结果、错误类别及数字 HRESULT／native code，原始消息与路径不外泄。每个规则使用独立随机名字，部分创建后抛错仍尝试清理；碰撞不删除原规则，清理未确认则 job 失败。临时副本和空目录按确切路径非递归删除。纯 mocked PowerShell、解析与原 workflow 治理共 13/13；尚待真实 runner 结果，实际隔离地址和主验收门禁未改。

## 2026-10-22：暖态发布合并校验候选，本机回归通过，托管待验

将已用于暖态 reader 的原子准入预条件用于 publication.prepare：仅当原能力、已知持久 revision／来源 ID 和发布视图条件均成立时，推迟独立 load-reference 到第一笔发布写事务内验证。新来源载荷仍由同一 save-reference-state 认证并保存；prepared、sending、transport-finished 各自原 durable ACK 不合并，读前预扣、CAS、旧发布记录、到期、时钟和锚点规则不变。未声明能力的适配器保持原先 load-before-save。此候选只减少一笔暖态发布前持久读取，不宣称已经修复 5 秒期限。

新回归先在原实现得到 2 次 load 不等于预期 1 次（`combined-publication-before-v1.log`）。候选覆盖三协议的 observed／prepared 两种发布、新载荷只发送一次、sending／finished 不再附带原文、未声明能力回退、预算／发布记录／revision／密文／缺载荷／ACK 故障无重试，以及 ACK 前持有所有权和挂起时关闭不能复活。两文件的显式原生排除回归 69/69；最终带本机原生入口阻断 preload 的回归独立封存为 `combined-publication-reader-guarded-v1.log`。原客户端 long-persistent 新增重开前后合并发布计数大于零的断言，尚待真实 hosted 执行。

第一次扩大命令的负向 name-pattern 未排除两项真实 worker 测试，结果为 69 pass／2 fail，二者均在 storage 初始化失败；该次本机误触记录保留在 `combined-publication-reader-pure-v1.log`，不能算作纯回归或原生资格。后续使用显式 skip-pattern，并用仅本机私有 preload 在 openContextRecoveryStorage 入口立即拒绝实际 worker，避免选择错误触发本机原生 owner；该 guard 不进入产品、发行或 CI，也不替代 hosted 原生测试。

诊断源码 `4e14f5e5` 的 Verify `39899488698` 已 failure，四个 unit 分片、集成、Rust、代码质量 success；coverage 唯一 not-ok 位于 `context-recovery-key.test.js` 的独立原生 ACL 验证 PowerShell 子进程，原 10000ms 触发 ETIMEDOUT（测试约 10190ms），不同于前一源码的 Chat 期限失败。终态日志 `hosted-job-120237497349-final.log`；不据此关闭历史客户端性能问题。其 disposable `39899488692` 仍单独跟踪，不因本机候选变更重启。原 I0–I5/H1、N01–N11 及当前包、私有迁移、全天、生产范围保持未完成。

## 2026-10-22：d1aaf83e 源码门禁通过，独立覆盖率及 N08／N09 失败

同一源码 `d1aaf83ebf2ce1ca796652bd4b9feb44cc2efde0` 的 disposable run `39897831691` 已 failure：source-gates `120232255162` success，N08 `120235315971` 与 N09 `120235315938` 都在实际场景步骤 failure。两者依赖安装和固定载荷构建通过，固定诊断均为 `hpm_network_failed_stage=egress_containment`，尚未进入业务场景，不能授予生命周期资格或把本次失败归于业务 ACK。各自终态日志按 job ID 私有封存。独立 Verify `39897831931` 已 failure：四个 unit 分片、集成、Rust、代码质量 success，coverage `120232256095` failure。两路结果分别保留，不以其中一路通过覆盖另一路失败。

为区分网络隔离初始化中的实际失败点，候选将原粗阶段细分为读取 profiles、启用 profiles、规则冲突、创建、读取、应用过滤器和身份核对。只输出固定阶段字面量，不输出异常、路径、规则内容或凭据；原防火墙地址、启用、检查和恢复语义不变。原控制块经全 mocked PowerShell 命令运行，覆盖七种故障及成功路径；包含原有脱敏回归的文件 5/5 通过，没有调用本机真实防火墙、证书、hosts、持久存储或注册表。新诊断尚待托管执行，不能声称网络根因已修复。

完成的 unit 分片 `120232256125` 中，三协议各记录 3 次 combinedAdmission，单次相关 storage 操作最大值 chat／Responses／Claude 分别为 154／147／141ms；原测试的重开前后计数断言通过。这只证明本轮接线被执行，不证明完整请求或覆盖率性能。私有证据 `hosted-job-120232256125-admission-summary-v1.json`。

覆盖率中间快照确认 chat long-persistent 第 0 轮在 5070ms 触发原 5000ms 期限；该轮已执行 2 次合并准入，仍不足以消除超时。序号 5 scan-reference 的 engine execute 为 1544ms，其中 sqlite_clock_write 111ms、sqlite_commit 1422ms；后两项嵌套于 execute，不能重复累加。snapshot 9ms、anchor 296ms，父 storage 记录 1859ms。序号 4 save-reference-state 的 COMMIT 784ms；不能将这些离散停顿外推为全部失败的共同根因。原始终态日志分别封存为 `hosted-job-120232255162-final.log`、`hosted-job-120232256095-final.log`，逐操作脱敏快照为 `hosted-job-120232256095-observation-v3-sanitized.json`。原期限、负载、并发、覆盖率与安全语义未改，本轮真实模型请求 0。完整 I0–I5/H1、N01–N11、当前包、私有迁移及生产目标保持未完成。

## 2026-10-22：暖态读前校验与预算预扣合并候选，真实期限待验

未改变 DELETE journal、FULL、secure_delete、时钟持久化或锚点确认。原生适配器新增内部 reference-admission 能力：只有已经取得持久修订号和来源 ID 集合的暖态 reader 才可把旧 load-reference 校验延后到第一笔 save-reference-state；该笔写事务同时验证实际已存状态与调用前的当前预算、绑定、策略、发布记录和 CAS，再保存预扣。返回 durable ACK 前不能 readSource 或 settleReader。冷启动、未声明能力的适配器和不适用的旧发布视图继续旧路径；没有新读权来源、隐式重试或失败退款。仅保留已知来源 ID，不缓存正文或以缓存代替存储认证。

新边界模块 `context-recovery-reference-admission.js` 使用有界描述符预检及原有语义解析，拒绝循环、深度／节点越界、访问器及嵌套 Proxy，发布比较在与普通关联校验同一次解析中完成。存储打开包装层及 Core 测试观察包装层都转发新标记；发行源码清单已增加新模块。原 native long-persistent 测试新增重开前后合并事务计数大于零的断言，原客户端输入、请求数、覆盖率、并发与 5000ms 期限保留；本机不运行该原生测试。

本地九文件纯／直接内存与普通文件回归 **155/155**，零失败／取消／跳过计数；命令明确过滤五项真实 worker 测试，不能记作原生全量通过。证据 `combined-reader-delivery-pure-v1.log`。包含三协议暖态、旧能力回退、空原文、非法调用仍扣预算、绝对到期、挂起撤权、ACK 前拒绝读取／结算及预算／发布／revision／密文／ACK 故障，无重放或错误退款。以旧 root-storage 模块替换运行的新回归先得到 3 次 load 不等于预期 1 次，随后候选通过（`combined-reader-admission-before-v1.log`）。格式、Lint、CI／发行规则及宿主闭包专项通过。

纯内存 20 次暖态 LIST 对照中，三协议操作数 60→40、load 20→0，但本轮耗时从 488–549ms 增到 901–1089ms（`reader-admission-before-benchmark-v1.json`、`reader-admission-after-benchmark-v2.json`）。减少持久事务的代价是额外校验，不隐瞒该微基准退步；尚无当前候选的托管原生净时延收益，不能宣称 5 秒问题已修复。完整 Verify、字面 verify、N08／N09、安装迁移及整体资格仍待验证。

## 2026-10-22：PERSIST 候选因已清理密文残留被否决

在不改产品的直接 SQLite 引擎实验中，保持 FULL／secure_delete，分别完成撤销与到期清理；三模式都逻辑拒读。但 PERSIST 的 journal 分别保留 21032／29240 字节，原已清理 envelope 的 208 个固定 64 字节片段仍可找到 205 个；DELETE／TRUNCATE 为 0 个。不能用整段 `journal.includes(envelope)` 检测这一边界，因为 SQLite 页头会打断连续密文，先前 v1 整段查询的 false 不证明没有残留。证据 `sqlite-journal-retention-comparison-v2.json`。这些是合成密文片段，不是用户原文泄漏或权限复活；但不应为微基准收益悄悄扩大已清理密文的目录内保留。

新增 `context-recovery-journal-retention.test.js`，3/3 通过（`journal-retention-regression-v2.log`）：当前产品的撤销、到期清理后 journal 不留已丢弃密文片段；PERSIST 负控确认相同检测能发现残留且逻辑拒读仍成立。该文件进入既有统一 unit 发现，没有更改生产配置、产品日志模式、期限或断言。仅直接 SQLite、临时普通文件与随机合成测试密钥；没有持久 storage worker、DPAPI、注册表或真实模型。PERSIST 不进入产品，后续须减少重复持久事务或从其他有证据的边界解决延迟，不能把此安全回归当成超时修复。

## 2026-10-22：be393f0a 托管终态与 SQLite 写入停顿证据

Verify `39892137258` 全部 success；独立 disposable `39892137257` 已 failure，source-gates 未通过，N08／N09 skipped。已下载 source job `120214126907` 在运行期提供的日志 `hosted-job-120214126907-observation-v1.log`：chat 与 Responses long-persistent 分别在 5024／5012ms 触发原期限。该日志为中间快照，不能把其中失败数当成最终完整失败清单。

失败 chat 场景的序号 6 load-reference 中，engine execute 1101ms，内部 sqlite_clock_write 260ms、sqlite_commit 837ms，snapshot 10ms、anchor persist 86ms。前两项嵌套于 execute，合计解释该次事务约 1097ms，证明这次停顿主要出现在 SQLite 写入与提交，不能外推所有历史超时的根因。此前 TRUNCATE 比较仍在重开第二轮 5015ms 超时，见本文件 2026-10-21 的存储诊断历史；不能忘记该负证据并直接把更换日志模式称为修复。

另做仅合成整数水位的独立普通文件 SQLite 对照（`sqlite-journal-io-comparison-v1.json`）：保持 FULL／secure_delete，40 次事务，DELETE／TRUNCATE／PERSIST 总计 193.30／98.58／86.62ms。未执行生产存储 worker、DPAPI、注册表或真实模型。该本机微基准没有重现托管停顿，也没有检查生产撤销、热 journal、崩溃或旧包兼容，不能作为更改产品日志模式或关闭 5 秒问题的依据。产品继续 DELETE，I5／H1 与完整目标仍未完成。

## 2026-10-22：be393f0a 独立容量命令本机满足原 60 秒目标

源码 `be393f0a8ceb9b9fec7382102994ea28976f17a1` 在没有其他本地重测试的情况下，原五档、两个 worker 的 CPU profile 运行功能通过，worker scope 35010.6352ms。另一次未启用 profiler 的原始 CLI 运行退出 0、五档功能全部通过；父进程从 spawn 到退出测得 `scope: capacity-command` **36088.9789ms**，worker scope 35742.9204ms，均满足原 60000ms 目标及批准的 180000ms 功能预算。没有改负载、调度、期限或断言，未执行原生持久 worker、DPAPI、注册表或真实模型请求。

私有证据为 `capacity-be393f0a-command-v1.json`、`capacity-be393f0a-command-v1-report.json` 与 `capacity-be393f0a-profile-v1/`。本次独立本机性能达标不能覆盖既往并发／覆盖率超时，不能宣称宿主环境稳定性能、持久存储、传输、真实客户端或全天容量资格；报告仍明确 `transportQualified:false`、`durableStorageQualified:false`。同源码 Verify `39892137258` 和 disposable `39892137257` 尚在运行，不因本次容量结果授予完整资格。

本轮已完成的普通 unit 1 日志 `hosted-job-120214127388-final.log` 中，严格解析 741 条阶段、0 条拒绝（`owner-sqlite-stage-plain-v1.json`）。SQLite begin／水位写入／commit 最大分别 6／19／46ms；engine execute／snapshot／anchor persist 最大分别 74／60／42ms。该组是全部三协议场景的汇总，嵌套阶段不相加；它未重现先前约 2 秒的事务延迟，不能证明覆盖率或失败环境中的 SQLite 提交为根因。当前 Verify 已进入 client coverage，独立完整门禁仍在运行；不为观察日志重启任务。

## 2026-10-22：2b3040d7 Verify 全绿，独立完整门禁仍有持久事务超时

同源码 Verify `39890689923` 已 success：四个单元分片、全部覆盖率、源码质量、Rust 与集成均通过。该结果不替代 disposable `39890689848` 的字面 `npm run verify`；后者已失败，N08／N09 未运行。其唯一失败文件为 `client-context-target.test.js`，chat WBIPC long-persistent 在原 5000ms 期限到期（5009ms）。失败前序号 6 的 load-reference：engine execute 1979ms、snapshot 6ms、anchor persist 368ms，父存储计时 2511ms。嵌套阶段不能重复相加。当前证据定位到事务开销，尚不能区分校验、SQLite 水位写入及 COMMIT 刷盘。

材料夹具所在 unit 2 本轮通过，夹具用时 12478.6875ms，但历史 25000ms 超时根因仍未证明已修复。快照候选不得因一次 Verify 全绿宣称稳定达到 5 秒目标。

测试专用 owner probe 继续细分固定 `sqlite_begin`、`sqlite_clock_write`、`sqlite_commit`、`sqlite_rollback` 阶段；原数据库方法与 statement receiver、结果及异常保留，不输出 SQL、参数或原始错误，不改产品事务、负载、期限或断言。这些阶段嵌套于 engine execute／snapshot，仅用于区分开销。纯与真实内存 SQLite 回归 **6/6**（`owner-sqlite-stage-probe-v2.log`），覆盖提交失败后的回滚、旧 revision 保留、密文参数不出日志与未知 SQL 不进入诊断；没有创建存储 worker、DPAPI 或注册表锚点。细分计时尚待托管执行，整体资格保持未完成。

## 2026-10-22：c7a7d1aa 托管终态与快照重复准入修复

Verify `39888650504` 已终态失败：coverage、源码质量、Rust、集成及 unit 0／1／3 通过，unit 2 的材料夹具仍触发原 25000ms 期限。Disposable `39888650440` 的 source-gates 也失败，N08／N09 未运行；其失败为 chat WBIPC long-persistent 在原 5000ms 请求期限到期（5003ms），不是完整验收通过。该 job 的 499 条 owner-stage 记录均通过严格解析；包含多次运行，不混作单次请求。失败前可见 engine execute 的最高记录 1210ms，其他阶段仍有开销，不能据此把根因单独归到锚点或快照。

已修复 metadata snapshot 对同一 v3 reference 的重复解析与库存核对：完整 hydrate 仍验证库存、全部原文密文、摘要与根状态，再从该次验证结果核对绝对到期时间；无跨事务缓存。新回归修改前明确失败（库存核对 2 次），修改后确认每次 snapshot 只核对 1 次，并继续拒绝重新认证后的到期错配、损坏密文与缺失库存。统一单元入口已包含该文件。

本地限定内存的该文件 **48/48** 通过，明确排除两项真实 encrypted-worker 测试；此前误跑全文件的结果是 48 通过、两项原生存储不可用失败，不作为原生或完整验收证据。内存 SQLite 每样本 20 次快照、三组基线／候选为 241.20／221.85、237.25／195.68、231.17／212.66ms，仅证明本机该微基准有收益，不证明托管 5 秒期限或整体验收已修复。证据为 `snapshot-single-admission-before-v1.log`、`snapshot-single-admission-memory-v1.log` 与 `benchmark-snapshot-single-admission-v2.json`。原有期限、负载、CI、认证与 ACK 条件保持；材料阶段诊断与本候选仍待同源码托管复验。

## 2026-10-22：c7a7d1aa 托管中间证据与材料夹具超时诊断

候选已推送，Verify `39888650504` 与 disposable Windows `39888650440` 使用同一源码。当前 Verify 源码质量、Rust、集成及 unit 0／1／3 通过；unit 2 失败，不能授予完整 Verify。失败仅定位到 `shared-hosted-materials.test.js` 的 PowerShell 文件系统夹具触发原 25000ms 子进程期限，尚无内部阶段，不能归因于 Add-Type、启动或清理。该夹具不执行网络、证书、注册表或持久存储操作。覆盖率与 disposable source-gates 仍在运行；运行矩阵尚无资格。

已通过的 unit 1 包含 `nsis-installed-runtime-boundary.test.js`、`client-context-target.test.js` 及 owner-stage probe 回归。私有保存 job `120202779938` 日志，从中严格筛选 273 条固定阶段记录，0 条非法，汇总 `owner-stage-plain-v1.json`：三协议普通运行中 load/read/save/settle 等操作的快照中位数约 46–50ms，锚点约 25–28ms；各协议总计快照约 1212–1225ms、锚点约 795–812ms、事务约 742–755ms。均为整套两轮测试的 worker 阶段累计，不是单次请求延迟，也不与嵌套 storage／session 计时相加。当前普通运行通过不能抹去历史覆盖率超时，覆盖率分段数据仍待取得。

材料夹具新增仅 stderr 固定枚举的顺序阶段，失败时父测试仅报告末阶段与耗时；保留原 25 秒／30 秒期限、清理和哨兵断言。两文件本地 5/5（`material-fixture-progress-v1.log`）；该结果只验证诊断接线，不代表已修复托管超时，也不重跑失败任务制造绿色。I0–I5/H1、N01–N11 原目标继续未完成。

## 2026-10-22：持久化分段诊断与安装夹具清理候选

WBIPC long-persistent 测试通过现有 WorkerType seam 包装原存储 worker，只在测试进程的专用 stderr 接收固定 `engine_execute`、`engine_snapshot`、`anchor_persist` 阶段、操作枚举、序号与整数耗时。原 workerData、协议、存储实现、5 秒请求期限、负载及断言保持；未知 stderr／原生错误不进入测试输出。当前尚无这三个阶段的真实 hosted 耗时，不能宣称锚点或快照已经被证明是主要瓶颈，也没有据此改变生产持久化语义。

安装边界测试的所有子用例通过后，历史 after-hook 曾在删除复制的 Node 可执行文件时 EBUSY。合成夹具现在创建时固定临时根及祖先物理身份，退出后清理最多尝试四次，仅对 EBUSY／EPERM／ENOTEMPTY 等待 75ms 后再试；身份变化、未知错误、持续占用及删除未完成仍失败，且不重跑任何安装场景。该改动处理短暂占用，不证明历史问题来自 AV 或排除了残留进程。

新增纯回归及实际复制 Node／模拟安装模块三文件 20/20（`owner-stage-and-cleanup-expanded-v1.log`）；随后调整计时异常路径以通过 Lint，诊断文件 4/4（`owner-stage-post-lint-v1.log`）。两组不累加。上述验证没有启动实际持久存储 worker、DPAPI、注册表或真实模型；真实托管 source-gates、运行矩阵与性能根因仍待验证。全部 I0–I5/H1、N01–N11 及原交付范围保持。

## 2026-10-22：保存／撤销 ACK 已接入业务与四场景托管入口，真实运行待验

lifecycle client 通过私有合成 token 验证当前 PID 的 bootstrap，延迟创建签名 mailbox client，不公开 token／派生密钥。旧 PID 句柄在停止后失效；只有原强制退出完成后才关闭通道。同目录新 PID 使用新的 bootstrap 和客户端。业务能力获取保持被动；启动、播种并精确读回之后，以只读快照作为命令前置条件，保存必须先收到 signed armed，再发起真实业务请求，最终确认只接受原生产者签名回执，撤销调用原 sessions 的 revokeAsync，不发送替代 HTTP。

最终 ACK 后不读取快照或管理接口，直接进入原 Job 强杀。保存 HTTP 的成功／失败处理器立即安装，ACK 前已知业务失败会拒绝；强杀之后才回收尚未结束的请求，避免等待响应完成冒充保存边界。armed 与最终回执共用原 15 秒预算。托管入口现在依次运行 committed、clear、save、revoke 四个独立适配器场景，原 120 秒外层期限保持；保存／撤销的结果仍为 adapter-orchestration-only，不能授予真实宿主或完整 N09 资格。

本地合成证据：托管基础设施及原控制器回归 366/366（`n09-ack-full-wiring-v2.log`）；随后补充被动能力闭包的错误脱敏及回归，业务文件 18/18（`n09-ack-callable-sanitization-v1.log`），两组不能累加为一次完整测试。新测试已进入统一 unit discovery，完整候选闭包 99 文件离线核验通过。未运行本机持久存储 worker、DPAPI、注册表、真实 daemon 或真实模型，也没有生产启用。真实 Windows 托管验证、持久存储延迟与清理 EBUSY 根因、全天容量、私有原安装包迁移及 N01–N11 完整交付仍未完成，原 I0–I5/H1 范围保持。

## 2026-10-22：启动门与重启控制器已接入宿主观察器，业务确认消费仍待接入

新增 bootstrap 合约、固定宿主安装器与纯控制器转换器。专用托管 N09 控制器在原 Job.Assign 成功后、原 stdin grant 前写入不可覆盖的 `bootstrap-<pid>.json`；同目录重启在同一位置按新 PID 写新 epoch。文件只包含源码 pins、身份与 HMAC，不写 token 或派生通道密钥。PowerShell 使用原合成 management token 签名，Node 按独立域派生 mailbox key；真实 PowerShell 的模拟文件用例验证了双方 JSON 顺序、UTF8／ASCII、签名及派生结果一致。重放写入失败且原计划不变。

启动门对无计划保持原行为；有目录却缺少当前 PID 计划时拒绝。加载任何 ACK helper 前先核签名、逐文件哈希、相对路径及完整传递依赖闭包；动态加载仅允许精确 `host-install.js` 中两处固定已安装 ACK／lifecycle 模块，其他动态 require 仍拒绝。host-install 在加载前拒绝暖 cache，加载 lifecycle 后再次确认 root-storage 尚未加载，再安装观察器。缺失依赖、签名／来源变化、异身份、非法／超限字节、hardlink、恶意 getter、初始 warm cache 与 lifecycle 提前导入 root-storage 均有纯回归。合成安装模块使用真实内存 sessions 与 ACK producer，不建立持久存储或 native worker；关闭观察器不代替真实 shutdown。

全部托管基础设施、原控制器与安装 PowerShell wrapper 扩大回归 **351/351**，零失败／取消／跳过，证据 `n09-bootstrap-expanded-v1.log`。随后补充的 hardlink／字节边界及提前导入路径按两文件复验 **6/6**，证据 `n09-bootstrap-extra-boundaries-v1.log`；两组计数不累加冒充一次完整运行。完整候选闭包离线核验 97 文件；ESLint、格式及 CI／release governance 通过。没有运行本机原生存储、DPAPI、注册表、真实 daemon 或真实模型。源码尚未取得新 hosted 运行资格。

当时尚缺 lifecycle client 私下验证 bootstrap 并创建 mailbox client、业务适配器 arm → 实际恢复请求 → 签名 ACK、确认后立即强杀及同目录新 PID 复验、原始 revokeAsync 的最终确认消费；上述接线的后续进展见本文顶部。现有 committed/clear 场景不被替换成保存／撤权证明，N09 完整资格、全天容量、私有迁移及生产启用继续为未完成。

## 2026-10-22：签名私有通道与生命周期适配已回归，安装 mechanics 托管通过

新增固定文件名的 N09 mailbox：命令、armed 控制信号、最终回执与失败信号分域签名，绑定 PID／epoch／递增序号；完整 JSON 写入并 fsync 后才发布空 ready 标记。拒绝路径选择、硬链接、目录替换、未知 getter、重放、覆盖与非法完成结果。armed 仅表示已开始观察，不能作为持久化确认。runtime-hooks 先包原始 ACK producer，再包 lifecycle factory；仅绑定目标持久目录的真实 sessions，原 shutdownAsync 严格成功后才允许替换生命周期，全进程序号不重置。close 恢复自有描述符，不代替真实生命周期关闭。

Node test runner 的 async_hooks 会为原生 Promise 附加符号数据属性，初版过严校验导致 10 项失败，已接受该属性并继续拒绝自有 constructor／then、访问器和子类。观察器撤权等待也改用同一校验，回归确认不会触发 species getter。只读审查另外发现非法返回的普通原生 Promise 拒绝可能未消费、异步 close 可能被当成功；现已消费可安全观察的拒绝、拒绝 async close，并将意外 Promise close 标为粘滞失败。不会为消费不可信 constructor／species 而执行它们。

最终扩大回归包含全部 `test/context-hosted/*.test.js` 与安装 PowerShell wrapper，**332/332**、零失败／取消／跳过，证据 `n09-mailbox-expanded-v2.log`。组合用例经过原始 ACK factory、真实内存 sessions、runtime hook 与实际临时文件 mailbox，确认撤权发生在同一 sessions、文件不含 principal 或签名密钥。ESLint、Prettier、CI／release governance 及统一测试发现核验通过。这些仍是纯／合成证据，**gate／controller／已安装模块的来源校验与真实 daemon adapter 接线尚未完成**，`liveDaemonProved:false` 与 N09 未完成状态保留。

精确源码 `0a6934b1` 的安装 mechanics run `39883291573` 已 **success**：托管 Windows 完成基线安装、当前升级、回滚、卸载及合成文件保留。该结果仅针对 runner 源码重建的安装器；不授予私有旧安装包、真实用户迁移、加密恢复／DPAPI、签名或 24 小时容量资格。

同源码的独立 Verify `39883237256` 已 failure，仅 Responses WBIPC long-persistent 的 turn 0 在 5 秒内未收到 headers，Chat／Claude 此轮均通过；request 内 begin 与两次 reply 共约 4691ms，尚不能归因具体原生操作。disposable run `39883237225` 则已因完整 source-gates 失败终止，运行矩阵跳过：安装 runtime-boundary 的 11 个子测试通过，after 清理复制的 Node 可执行文件收到 EBUSY，尚无证据证明子进程泄漏；Claude WBIPC 在 4964ms 已返回响应，5003ms 等待 publication 确认超时，finishPublicationAsync 312ms 跨过期限。两次运行不能混用结论。下一诊断需区分 engine.execute、完整 snapshot 与 anchor.persist 耗时，期限、负载和断言均未放宽。本轮真实模型请求为零。

## 2026-10-22：保存／撤权观察器纯模块已验证，真实接线仍未完成

新增 `scripts/context-hosted/n09-ack/` 的严格 HMAC command/receipt 合约与宿主观察器。命令绑定 PID、epoch、单调 sequence、已观察 root／expiry／revision；save 仅在原始 ACK factory 成功后观察修订，revoke 调用同一绑定 sessions 的原始 `revokeAsync` 并等待严格成功。principal 仅留内存；撤权回执标注最后有效保存 revision，不能冒充 tombstone revision。close、失败、并发、迟到确认、预算回退和未知 getter 路径均有纯测试。首轮扩大专项 23/24，一项夹具只改 rootId 导致 reference codec 先拒绝，已改用真实 sessions 产生另一合法 root 后再验证观察器拒绝；getter 补显式返回以通过原 ESLint 规则。修正后专项 17/17，全部托管／安装回归 301/301，零失败、取消或跳过；新测试已核对进入统一 discovery。

这些模块尚未接入启动 gate、签名私有 mailbox 或真实 daemon adapter，回执固定 `observer-boundary-only`、`liveDaemonProved:false`，不授予 N09 保存／撤权或生产资格。没有运行本机原生存储 worker、DPAPI、注册表或真实模型请求。

## 2026-10-22：记录托管终态并补充固定失败阶段

`e13c5852` 的 Verify `39880563255` 已 failure 终止：quality、integration、Rust、四个 unit shard 均成功；proxy/security coverage 通过，client coverage 仅剩三协议 WBIPC `long-persistent` 的 turn 0 请求触发原 5 秒期限。此前 38 项快速存储失败未重现；chat 保存操作记录 8164ms，replyAsync 8766ms，支持继续定位保存路径耗时，不能据此断言具体原生调用根因。

同 SHA 的 disposable run `39880563520` 已 failure 终止：其字面完整 verify/audit 的 source-gates 成功，但实际 N08/N09 均失败于固定场景阶段；不能以该 source-gates 覆盖独立 Verify 的失败。新增 qualification、execution、network、owned Job 的固定失败阶段枚举，仅通过 Information 流输出，不打印异常、路径或输入，也不改变成功 JSON、120 秒 Job 期限、网络隔离和 finally 清理。真实本地前置拒绝及合成错误 review/pin 测试验证阶段区分和私有 sentinel 不输出，未调用本机原生存储或系统网络修改。全部 context-hosted 文件及安装 wrapper 扩大回归 301/301、零失败／取消／跳过，证据 `hosted-diagnostics-expanded-v1.log`。新诊断须在下一源码的真实 hosted 运行定位剩余问题，尚无 N08/N09 完整资格。

## 2026-10-22：安装 mechanics 改用新建专用验收分支

安装 review workflow 保留旧精确分支，并接受 `acceptance/windows-lifecycle/**` 的普通新分支创建事件；限定本仓库、created、非 forced/deleted 和全零 before。不覆盖已有旧分支，不改默认分支，也不上传私有旧 installer。固定基线仍为清理后的 `2295c452888449e9728b3ddcc2f80f31e9433e69`。此路由验证源码重建的安装／升级／回滚 mechanics，不能替代原始旧安装包及加密迁移资格。扩大回归包括全部托管基础设施及安装 wrapper，共 301/301，零失败、取消或跳过，证据 `hosted-diagnostics-expanded-v1.log`；真实 disposable Windows 新分支验收待启动。

## 2026-10-22：修复 N09 启动 gate 的固定路径不一致

hosted controller 使用 candidate 中经过哈希校验的原始启动 gate，但 lifecycle 将 controller 路径改为临时复制件后，重启捕获检查仍按该复制目录推导 gate，期待了一个未复制的路径。现在 lifecycle 明确接收 candidate 和 gate 摘要，在构造前后验证该固定文件，并且只将复制脚本中的单一 gate 路径表达式替换为它；原启动 gate、argv/env、Job、网络及期限不变，未放宽成多路径白名单。回归旧代码 1 失败／3 通过，修复后 composition、closure、hosted boundary 与 source identity 四文件 18/18，零失败、取消或跳过。证据 `n09-gate-path-before-v1.log`、`n09-gate-path-after-v1.log`；尚待新源码的真实 hosted N09。

N09 纯 driver 的全部托管基础设施扩大回归另为 25 文件 284/284，零失败、取消或跳过，证据 `n09-durable-expanded-v1.log`。该扩大回归先于本次 gate 路径修改，不累加为当前完整候选通过。

## 2026-10-22：N09 保存／撤权确认后的编排补齐，真实宿主接线仍开放

独立纯 driver 已可执行保存／撤权 ACK → 强杀 → 同目录新 PID 重启。它要求受信 adapter 同步提供 callable capability，先验证 operation、PID、原文／授权身份、期限及不回退的累计消耗，确认后不插入额外 adapter I/O 即强杀。保存重启后必须精确读取且不重放工具；撤权重启后及四开关组合下都必须拒绝旧凭据。失败、部分启动、确认拒绝及清理失败保持固定错误并走独立 finally close。新增 34 条与既有 51 条合计 85/85，零失败、取消或跳过；原占位上的新回归为 0/23，证据 `n09-durable-driver-before-v2.log`、`n09-durable-driver-after-v3.log`。capability 获取中的未知 thenable／Proxy 不再先经过 await，避免校验前触发 getter。

此项只完成 adapter 编排，结果仍固定 `adapter-orchestration-only`、`hostDurableAckObserved:false`、save/revoke 资格与 N09 完整资格均为 false。当前真实宿主 adapter 尚不提供此 callable，布尔 true 仍明确拒绝；已有 committed-metadata 和 clear 路径的托管范围不变。真实接线需观察宿主实际验证过的保存／撤权 Promise 返回，不能以只读数据库快照或 HTTP finish 冒充。正在运行的 `e13c5852` 托管任务不包含此后续编排改动。

## 2026-10-22：两库安装序列回归通过，托管临时目录差异待复验

`1a745a7f` 的 Verify `39878291287` 已失败终止：node-quality、integration、Rust 与单元 shard 0/2/3 成功；shard 1 的 PowerShell wrapper 超过原 30 秒，coverage 中 proxy/security 通过后 client 阶段出现 38 项失败。hosted N08/N09 `39878291341` 的 source gates 失败，后续矩阵跳过，未获得 N08/N09 运行资格。已观察到 WBIPC 原 5 秒请求超时及独立 ACL cross-check 原 10 秒超时，尚无证据证明它们与 wrapper 为同一根因。原期限和断言保留。

安装脚本已将单库序列改为两库：旧 baseline 种入 legacy；current 必须因缺少独立锚点拒绝，确认零锚点写入、owner 释放 SQLite 锁且全部文件字节保持；current 另建 anchored 库后读取和重存；旧 reader 回滚读取两库；current 重装后重开 anchored 并再次拒绝 legacy。旧 reader 兼容磁盘格式仍不授予防回滚资格。安装、拒绝保留、HTTP/settings mock、临时目录及 coverage 治理九文件回归 63/63，通过且零失败、取消或跳过，证据 `installer-two-store-expanded-v2.log`。这仍是合成回归；public 仓库的私有旧 installer 传输门禁保留，未创建公开安装资产。

客户端覆盖率命令原来直接启动 Node，缺少 unit runner 已有的物理 TEMP 规范化；生产 anchor 会拒绝短路径别名。新增固定测试 preload 复用既有解析器，只设置当前测试进程及子进程的 TEMP/TMP/TMPDIR，保留全部生产路径校验、文件列表、并发、阈值和期限。托管快速拒绝符合这个入口差异，但日志未直接证明具体别名，仍需新 SHA 的完整托管复验。wrapper 新增固定阶段枚举及数值耗时诊断，未修改产品 wrapper 或 30 秒期限。本机未运行真实存储 worker、DPAPI 或注册表锚点。

实际 Node preload 子进程通过自有 junction 别名启动，确认 `os.tmpdir()` 为物理目录、三项临时环境变量一致、无关 sentinel 保留且父进程环境不变。与既有物理目录和 wrapper 回归共 21/21，零失败、取消或跳过；证据 `temp-wrapper-regression-v2.log`。专项 ESLint、格式、PowerShell AST、CI/release governance 与 diff 检查均通过。这些本地结果不替代真实加密 worker 的 hosted 资格。

## 2026-10-22：安装验收准备中的基线与原生 helper 接线修复

安装 review wrapper 改用历史清理后已在本地与 GitHub 核实存在的基线 `2295c452888449e9728b3ddcc2f80f31e9433e69`，旧运行记录保留原 SHA。安装驱动的精确 helper 白名单补齐 `--hpm-context-anchor-v1`，该命令不计为 DPAPI；额外参数、错误 helper 路径及未知版本仍拒绝。两处专项回归均先失败后修复，安装/私有路由/governance 三文件 41/41、零失败或跳过；ESLint、格式、diff 与 CI 治理通过。证据为 vault 中 `installer-sanitized-baseline-before-v1.log`、`installer-anchor-command-before-v1.log` 和 `installer-followup-after-v1.log`。

以上尚非安装资格。当时单 store 序列仍需拆为 legacy 拒绝保留与新 store 连续性两条检查，现已完成的脚本回归见本页最新状态；旧 reader 可解析相同磁盘格式不代表它具有新锚点的防回滚能力。public 仓库下，旧私有资产的 route、bridge 与 consumer 可见性门禁继续保留，未创建公开 installer artifact。`1a745a7f` 的完整 Verify 与 hosted N08/N09 当时仍在运行，现已失败终止；后续本地安装脚本修改不自动继承该 SHA 的资格。

## 2026-10-22：修复正常事务拒绝后 owner 被关闭的回归

独立锚点接线将 `engine.execute` 的正常事务拒绝也纳入了关闭 owner 的异常边界，导致 stale CAS 或第五条活跃状态容量拒绝后，后续合法读取失败。现在由 SQLite 引擎维持原事务回滚契约；成功执行后若锚点持久化、快照认证或路径校验失败，仍关闭 owner 且不返回成功回执。引擎自身回滚失败时的关闭逻辑保持。

新增两条回归在原 HEAD 上均失败；修复后 owner/admission/contract/sqlite 四文件 80/80，通过且零取消、跳过。容量回归保留四条已确认状态，第五条拒绝后核对锚点未变、原记录 revision/expiry/内容不变、合法更新与重开成功；原锚点落盘失败、旧备份回放拒绝和丢失 enrollment 测试继续通过。专项 ESLint、Prettier、diff 与 CI 治理通过，测试已在统一客户端覆盖率及单元入口中。证据为本地 vault 的 `owner-rejection-before-v1.log` 与 `owner-rejection-after-v1.log`；使用合成保护器与保留 backend，未执行本机注册表写入。

旧提交 `d92f6e82` 的托管 Verify 已暴露 maintenance、四根十六 MiB 和覆盖率 idle worker 失败，当前修复后的真实 Windows 复验仍待完成；不以专项通过关闭这些失败。完整候选、安装迁移、I5/H1、N01–N11、全天容量及生产启用继续按原范围验收。

## 2026-10-22：本地完整门禁通过，首次托管环境暴露交付差异

冻结候选 v5 的字面 `npm run verify` 于 `2026-10-22T20:17:24.4063849Z` 退出 0；客户端 1397/1397，零失败、取消或跳过，root/plugin 新依赖审计均退出 0。独立核对确认提交 `da9dffc86f0d84b47a4ff89338ef39d10cc254bf` 的 607 个文件与该候选原始字节、归一化 Git blob 完全相同，范围外变更为零。完整门禁资格仅属于这份源码，不自动覆盖后续修复。

[首次托管 Verify](https://github.com/cbhandsun/https-proxy/actions/runs/39852868735) 已观察到失败：Windows 临时目录的 `RUNNER~1` 短名称与工具返回的完整物理路径不一致，导致安装/插件测试夹具被原有安全边界拒绝；另有 runner 缺少 `rg`、独立 PowerShell ACL 检查一次超时。修复测试临时目录规范化时保留生产物理路径、junction、硬链接及完整性校验；真实 `rg` 测试改为直接声明的固定版本开发依赖，不依赖主机预装。后续完整托管门禁仍须取得新提交的终态。

实际私有旧安装包上传已完成，但 GitHub 将文件名中的空格规范化为点，旧校验因此拒绝。提交 `40282c3399df908e76f2bee552888dde97e15d75` 明确分开远程规范名称与本地安装文件名，回归先失败四项、修复后相关两文件 16/16。失败 draft、两份资产及本地 state 均保留，未将上传成功冒称安装通过。

N08/N09 后续业务驱动的 11 文件纯回归 75/75，零失败、取消或跳过；这不证明实际 hosted 网络、强杀或安装行为。真实安装/升级/回滚、业务在途撤权与强杀恢复、安装版客户端及全天容量仍未完成。24 小时是新记录的留存上限，不因读取、开关或重启而续期；不得仅凭 TTL 测试声称全天任务容量达标。原 60 秒性能目标另行保留为未达项。

## 2026-10-22：Rust 与驱动纯回归通过，完整 v4 在格式阶段停止

最终候选 npm run test:rust 退出 0，16 项库测试及 1 项其他测试通过，零失败或 ignored。vault N08/N09 proposal 四文件纯回归 91/91，零失败、取消或跳过；尚不覆盖实际 daemon、安装环境或后续托管网络/PowerShell 接线。证据 candidate-final-rust-v1{.log,-terminal.json}、candidate-final-n08-n09-proposal-regression-v1{.log,-terminal.json}。

完整 verify v4 已退出 1，仅插件可分发配置测试的一处格式警告，未进入后续阶段。终态后只对 test/local-evidence-plugin-package.test.js 执行 Prettier 并通过文件格式检查，原字节保留于 candidate-final-format-v2/。原 v4 的 607 源在启动时全量 SHA 复核无漂移；后续源码身份 v5 单独冻结，不覆盖 v4。完整门禁仍未通过。


## 2026-10-22：客户端受控并发全量通过，补齐此前未达门禁

原默认文件并发的 client coverage v1 已退出 1：1397 项中 1394 通过、2 失败、1 取消。chat/responses WBIPC 在响应头前触发原 5 秒期限；MCP source runtime API 触发原 15 秒外层期限。相同 c8 配置单文件对照 30/30，43.42 秒；该诊断不检查整套覆盖率阈值，不授予全量资格。

随后只将顶层文件并发改为 4 的全量诊断保持原 85 文件、全部断言、期限及覆盖率门槛：1397/1397 通过，零失败、取消或跳过，272929.8165ms；statements/lines 99.08%、branches 95.29%、functions 99.30%。这支持固定可复现的测试资源预算，不证明生产性能修复，也不改判原默认并行失败。package 仅新增 --test-concurrency=4；机器回执验证移除该参数后与原脚本逐字相同，文件清单/覆盖率参数不变。统一 unit 的治理回归 RED 1 失败后 GREEN 全部通过，拒绝筛选测试或移除覆盖率门禁。unit 四 shard 与 client 四文件 worker 只对齐顶层预算，不代表相同内部负载。

单队列补跑此前未达的 security coverage、frontend coverage、frontend tests、thinking、env、integration、hooks、frontend build，8 项均退出 0。前端构建仍有 chunk 大小警告，未放宽阈值。Rust 及最终新源码完整 verify 仍待验证；以上不是完整 verify 通过。

证据：candidate-final-client-coverage-v1{.log,-terminal.json}、candidate-final-wbipc-c8-solo-v1{.log,-terminal.json}、candidate-final-client-c8-concurrency4-v1{.log,-terminal.json}、candidate-final-client-concurrency-{red,green}-v1.log、candidate-final-client-concurrency-apply-v1/receipt.json、candidate-final-unreached-gates-v1.json。

安装剩余缺口已重新核对：现有 hosted Windows workflow/controller 可复用；N08 在途撤权完整业务 driver、N09 durable ACK 后强杀及同目录恢复仍未接通。已有 orderly reopen-clear 或管理 HTTP 四组合不能替代这些资格。24 小时完整容量、原 60 秒性能目标、最终安装版客户端及生产启用仍未完成。


## 2026-10-22：修复后真实管理 HTTP 四组合通过，最终候选已合成

最终候选完整 verify v3 已退出 1：原生恢复测试 7/7；561 个 unit 文件中 558 通过、3 失败，后续 client/frontend/Rust 门禁未执行。失败分别为 WBIPC Claude 5 秒超时、插件单测依赖本机 gitignored `.codex/config.toml`、Python 环境测试引用已排除的独立 Tianxi 研究文件。原日志与终态保留，覆盖率输出不授予完整 verify 通过。

终态后仅在独立候选修正两条测试依赖：插件改校验可分发的显式可选 TOML 示例，保留工具白名单及模型/凭据隔离断言，不自动激活插件；Python 改为真实通用 unittest 子进程，继续验证解释器及嵌套隔离环境，保留原 20 秒期限和正数测试数量断言。专项分别 11/11、6/6。WBIPC 只增加无内容的阶段耗时诊断，保留原 5 秒期限、断言及异常传播；整个 client-context-target 文件串行专项 30/30、零跳过，约 35.33 秒。该结果不消除四分片完整验证中已观察到的超时，仍待后续完整验证及负载定位。证据 `candidate-final-{plugin-policy-regression,python-regression,wbipc-phase}-v1.log`、`candidate-final-full-verify-v3-terminal.json`。

最终候选的完整 verify v2 已通过格式、1333 个 JavaScript 语法、Lint（零错误，五条既有测试警告）及 CI 治理，随后在发布清单遗漏四个恢复模块处停止。独立候选补齐 budget-reader、key、key-worker、reauthorization；新增 release inventory 回归在修复前一失败、一通过，修复后与隔离运行包测试共 13/13、零跳过，release governance 退出 0。见 `candidate-final-full-verify-v2-terminal.json`、`candidate-final-release-inventory-{red,green}-v1.log`。候选源码已包含这些显式后续修复，早期 source identity v1 保留；完整 verify 尚未通过。

root/plugin 依赖安装均已退出 0；安全下限与 SOCKS 传输回归 6/6，插件 build v2 退出 0，包版本 0.1.1、10 个文件，bundle SHA256 `b2cba52d774126fe596133b9e80fb579251ce26625ce486b15c48024592a0eae`。首次完整 verify 因 83 个已选定文件格式失败后，仅对这些文件运行 Prettier，保留原字节和前后哈希于 `candidate-final-format-v1/`；未据格式化声称行为验证通过。

候选 fresh root audit 首次发现生产传递依赖 `ip-address` 10.7.2 命中 GHSA-rxp7-6hxx-x8q5。仅在独立候选通过 npm 更新到 10.7.4，既有父依赖范围兼容；插件独立锁本来已为 10.7.4。root/plugin 两次当前审计均为零漏洞，root 重新 npm ci 退出 0；增加独立生产依赖 floor 回归并复用非法版本边界测试，未新增直接依赖。证据 `candidate-final-root-audit-v1.json`、`candidate-final-root-audit-v2.json`、`candidate-final-plugin-audit-v1.json`；测试及插件安装仍待终态。

root 单次执行 v11，退出 0（session 6703）：00/01/10/11 四组合的配置保存、应用观察、存储检查及 owned stop 均通过。原 gate/controller、readiness 与应用期限保持；新旧 payload、27 份 main harness、历史证据及既有条目不变检查均通过，四个 fresh case，零真实模型请求。证据 `daemon-http-owner-v11-terminal.json`。此项清理仍为 forced cleanup，不授予优雅退出、真实安装或最终客户端资格。

独立 managed worktree `context-recovery-final/HTTPS-Proxy` 已按冻结 v3 投影：603 个文件全部写入并经 root 独立 SHA256 复核，35 个排除基线文件保留原 checkout 字节；主工作区、旧候选及 Git index 不变。证据 `delivery-scope-audit-a9CCVy/final-worktree-projection-v3/apply-receipt.json`。隔离候选的根锁文件由 npm 重新生成，确认 SDK 1.32.1、Vite 6.4.5、ws 8.22.0，根依赖声明匹配；后续依赖安装、安全审计与完整 verify 尚待终态。本状态段作为投影后的显式文档更新同步到候选，不冒充冻结投影原字节。

## 2026-10-22：持久化 Worker 重放主进程 preload 根因已实证并修复

v10 的 11 失败现场没有恢复存储目录。调用链为配置保存后 reload/apply、runtime `configureSettings` 切换持久化、storage 创建 Worker；此前 storage 与 key 的 Worker 均未指定 `execArgv`，默认继承父进程 `--require`。固定 daemon gate 会在 Worker 内再次执行，其 stdin/入口约束只适用于原主进程，因此在存储初始化之前拒绝。隔离纯 Node 夹具确认继承参数的 Worker 入口未执行、错误退出 1，显式空参数的 Worker 入口执行并退出 0；证据 `worker-preload-isolated-proof.json`。

main 仅在两处 Worker options 增加 `execArgv: []` 和说明，stdout/stderr、gate、controller、原期限及失败策略不变。新增两条真实 Windows preload 回归覆盖 DPAPI round trip、受保护存储初始化/inspect/close；配合原 options 断言，修复前四项均失败，修复后完整八文件串行 233/233，零失败或跳过，约 126.96 秒。六文件 Lint/格式、语法、CI 治理及统一 unit/client discovery 检查通过。生产源码 SHA256：storage `fa7ab69d792c5e8f65692d85eabfe9d099436f4302534aae0ca83056b46c7dc0`，key `630cef89055306d1905e3e15272056451567ec8ae18900f1ca4023ffec9213ed`。证据：`worker-preload-fix-review-receipt.json`、`worker-preload-regression-green.json` 及原日志。

旧 payload 与 v13 均保持不变；root 已复审并启动新 UUID payload 复制，仅叠加两份修复并重建 manifest，尚待复制终态及修复后的完整 HTTP 验收。另已从原 base `1a127de1aeccc81789f78c570ea44782091c2133` 创建干净 managed worktree `context-recovery-final/HTTPS-Proxy`，供合成已拆分的交付源码；尚未投影、生成锁文件或取得该候选完整门禁。上述 main 专项结果不授予真实安装、升级/回滚、最终跨端或生产资格。

## 2026-10-22：v10 四组初始启动完成，11 在保存后的应用阶段超时

root 复审固定 spawn 副本与 runner 差异、绑定 SHA256 `7643e53c52640b661a88f6b7b1156ad4e9fcb96e237a411a4943e6378af8ae29` 后单次执行 v10，终态退出 1（session 28600）。四组均取得完整七阶段记录；从各自 gate entered 至 gate passed 分别 8287/7711/8085/7597ms，至 ports listening 分别 12888/10052/10890/10451ms。该子进程时钟不同于 ACK 后轮询时钟，不把二者混用，也不据单次成功启动认定此前失败或启动性能问题已消除。

00/01/10 的真实管理 HTTP 保存、应用、存储检查及 owned stop 均通过；11 初始启动也完成，配置保存成功，但后续应用观察为 `application_timeout`，尚未取得存储验证。controller close ACK、25 份 main harness、10 份固定诊断文件、payload manifest 与全部旧条目不变检查均通过，四个 fresh case，零真实模型请求。原 15 秒 readiness 及应用/案例期限保持，清理仍为 forced cleanup；整体 HTTP、优雅退出及真实安装资格均未获得。证据：`daemon-http-owner-v10-terminal.json`、`daemon-http-owner-v10-review.diff`。下一步定位 11 持久化切换与诊断投影，不重复原案例。

交付范围审查补齐共享入口 v3（59 个选定路径，其中 54 个有 patch）及剩余路径建议（479 条：建议纳入 144、排除 297、待拆共享 38）。这些是可复审方案，尚未应用到最终候选，不能代替闭包或完整门禁。依赖版本裁定保留 root SDK `^1.32.1`/锁定 `1.32.1`、plugin 精确 `1.32.1`、开发依赖 Vite `^6.4.5`/锁定 `6.4.5`；依据为留存安全审计及包声明，不声称本轮在线审计。证据：`delivery-scope-audit-a9CCVy/scoped-proposal-v3/`、`remaining-scope-review-v1.json`、`sdk-version-decision-v1.json`；后两者均位于该 audit 目录。

## 2026-10-22：核实容量功能预算通过，原性能目标与最终资格仍开放

重新核对冻结 v13 原全量日志：容量文件 10/10、零失败或跳过；命令用时 75500.6162ms，满足用户批准的 180000ms 功能执行预算，原 60000ms 性能目标未达。文件总用时 83509.7459ms 不与容量命令计时混用。计划 H1 表已同步区分功能预算、性能目标与完整资格；早期失败记录保留。原完整 verify 仍因 portable runtime 测试文件失败退出 1，客户端及后续阶段未执行，不能将上述功能结果解释为完整容量、最终安装版或全天任务资格。证据：`candidate-full-verify-v13.log`、`candidate-full-verify-v13-terminal.json`。

vault-only 启动阶段文件诊断已完成首轮静态复审及 8/8 纯模拟回归，固定记录七个阶段和单调毫秒数，最多 2048 字节，读回要求 owned controller close ACK。产品、原包、原期限及日常进程均未改；尚未执行带该诊断的 HTTP 启动案例。证据：`startup-phase-diagnostic-review-v1/review-receipt.json`。该产物用于定位身份校验与产品启动的时间分布，不授予 HTTP 启动通过资格。

## 2026-10-22：N09 固定安装 driver 回归通过，补齐旧 API 的非执行边界

N09 的 `reopen-clear` 已接入固定 installed module driver，要求 manifest 声明 storage 源、受 loader guard 保护的 installed runtime/storage export，经精确 capability wrapper 调用，并在执行后重新校验安装身份。完整 driver 文件 11/11，零失败或跳过；其中新增项覆盖 11 个串行合成子进程，含成功、非法导出、workspace fallback、关闭失败和执行后源码变更。证据：`installed-reopen-driver-regression-BKR2ot/result.json`。这是合成 installed API 经真实 Node/固定 driver 的回归，尚不授予真实安装存储或强杀恢复资格。

PS 安装矩阵已将该固定 case 加入 current 模块序列，保留后续 HTTP 接线及 rollback 顺序。严格 parser 要求 `complete=true` 和精确六项 checks，拒绝缺失、多余、错序、false、错误类型、重复字段和越界资格；调用端 ValidateSet 仅为三个已实现 case。轻量 parser/接线回归 2/2，PS AST、JS Lint/格式通过。随后完整 parser/child/Job 文件 3/3（17.79 秒）、相关 lifecycle/cleanup 治理两文件 2/2（41.88 秒）终态通过，零失败或跳过。证据：`nsis-reopen-ps-regression-mAyxPG/result.json`，四份源码 hash 与接线版本一致。以上仍不授予实际 NSIS 安装存储、强杀恢复或 24 小时容量资格。

root 另在原 module cases API 确认同类 `fn.bind` 读取外部函数属性问题。两条新增回归修改前均失败；改为拒绝 proxy function、通过固定 `Reflect.apply` 保持 receiver 后，完整文件 11/11，格式/Lint/CI 治理通过。原存储及关闭断言保留，没有放宽执行策略。证据：`runtime-boundary-capability-regression-v1.json`；仅 main 两文件，冻结候选未变。

启动静态拆分确认 manifest 仅 71489 字节、只串行 hash 一次；627 源及三个附加文件的逐文件校验均在 worker 内，完整 pre/post 保护合计约 15148 次 lstat 与 13894 次 realpath。原 v9 失败保留，下一步测试固定四 worker 候选是否能在保留所有检查与原期限的前提下改善该成本，未以增加观测替代修复。

四 Worker 实验完整 14 组专项通过，零失败或跳过；同包唯一一次测量 11442.84ms，成功校验 627 源，仍保留 12/15 秒期限。该样本未显示优于此前双 Worker 的 10513.10ms，不支持改善结论；不继续用于 HTTP，实验源码/测试另存后恢复已验证的双 Worker 字节。证据：`parallel-four-readonly-comparison-1792692926997/result.json`。未改 readiness、模型或日常进程。

## 2026-10-22：Windows inode 夹具专项通过，并行校验尚未接入启动

冻结 v13 的字面 `npm run verify` 已于 17:56:53Z 终态退出 1，约 23.28 分钟；全部四个 unit shard 已完成，688 个测试文件仅上述 portable runtime 文件失败，其余 687 文件通过。原命令链在 unit coverage 阶段失败后停止，后续阶段未执行，不能授予全局覆盖率或完整 verify 资格。前后 inventory 确认 1795 份源码及 11 个单列 pyc 均未改变。证据：`candidate-full-verify-v13-terminal.json` 和原日志。

main 的 portable runtime 文件完整回归已终态退出 0，44/44，fail/cancelled/skipped/todo 均为 0，约 20.81 秒。确定不同的 inode 注入保持替换拒绝和不复制断言；源码 SHA256 与前述修复一致。证据：`portable-inode-fixture-regression-v1.json`（执行 session 40426）。该结果仅属于 main，冻结 v13 未改，已有全量失败仍保留。

可选双 Worker 安装身份校验完整专项 14/14、原 serial 生命周期回归 35/35，均零跳过；真实小样本覆盖正常、篡改、硬链接与 junction，不能替代原 627 文件包的性能及 HTTP 启动证明。生产 gate 尚未切换，下一步在同一原包只读比较后再决定接入。

安装 HTTP bridge 及三个相关 NSIS 文件的最新串行回归 47/47，零失败、取消或跳过，约 45.27 秒；JS/PS 语法、专项格式/Lint 和 CI 治理通过。桥接在 current 包 module 矩阵后、rollback 前接入 HTTP 矩阵，沿用原内层期限，要求 controller close ACK；真实安装、HTTP daemon 及 Windows Job 清理仍待托管 runner 验证，资源 doubles 不算安装通过。证据：`installed-http-main-v1/result.json` 及同目录日志。以上新增源码均未进入冻结 v13。

同一原 627-source 包只读串行/并行各一次均成功，分别 12544.42ms/10513.10ms；12 秒 supervisor、15 秒父进程期限未改，源码及 manifest 前后无漂移。证据：`parallel-readonly-comparison-1792691978962/result.json`。单轮顺序采样不支持因果性能结论；preload 并行接线正在 main 实施，尚无修复后实际 HTTP 资格。

并行接线现已完成 main-only 完整相关回归 18/18，零失败或跳过；原 serial API 保持固定原校验器，新增固定 parallel API 共用原 request/ownership/path guard，preload 选择后无 serial fallback，无 CLI 或环境选择器。格式/Lint/CI 治理通过。root 已绑定 25 份相关源码，v9 离线预检通过，并启动同包四组合实际 HTTP 验收（session 54270），原 15 秒 readiness 及 45/240 秒包络不改；运行中状态不计为通过。

v9 随后已终态退出 1：初始 00 仍 `launch_failed/health_request_failed`，首次观察 preload passed 为 ACK 后 13453ms，63 次既有 health 请求均无可解析响应，最后 status 15097ms 时进程存活。controller close ACK、25 源码、payload manifest 与全部旧条目不变检查均通过，只新建一个 case，零模型请求。证据：`daemon-http-owner-v9-terminal.json`。双 Worker 未解决原期限内的启动失败，不以同轮测量或 preload passed 代替实际 HTTP 资格。

N09 main assertions 增加 trusted capability 组合边界，显式传入已校验 API 时不加载或回落 checkout 实现；自有 bind getter 不执行。最终轻量 20/20，格式/Lint 通过；最终模块默认真实受保护存储直接验收 7916ms，通过撤销与清除 ACK、旧 reader 拒读、正常关闭后重开拒读及全部 owner 关闭。合成物理 store 和安全收据保留于 `runtime-reopen-main-kmXpnC/result.json`。这仅证明 main 的 orderly reopen；安装版接线、业务强杀与最终 24 小时容量资格均未获得。

## 2026-10-22：v13 已冻结并启动全量检查，HTTP 启动失败继续保留

root 将已复审的插件发布、daemon 诊断/有效配置及安装身份校验优化共 14 路径精确合入隔离候选 v13，1 新增、13 替换；完整前后 inventory 确认其余源码与原 11 个单列 pyc 不变，1795 份源码身份 SHA256 为 `88c499a105ead064bf3ab7e89f53e2c19d31e8b85f3774ff0a76535cfb3103e3`。备份、manifest 绑定及投影收据已保存，原字面 `npm run verify` 已启动，保留 16 阶段、4 shard、覆盖率及容量完整断言，尚未取得终态结果。证据：`candidate-v13-root-reviewed-manifest.json`、`candidate-v13-delta-apply-receipt.json`、`candidate-full-verify-v13-live.json`。投影及运行中状态不授予安装或生产资格。

同轮格式、1566 个 JS 文件语法、Lint、CI/发布治理及原生恢复测试已通过；四 shard unit 仍在运行时，`test/governance/portable-runtime.test.js` 的 inode 替换子检查报告 Missing expected exception。夹具使用 `stat.ino + 1`，同一候选卷的只读观察确认 inode 超出安全整数精度、加一后不变。main 仅将注入值改为可确定不同的 0/1 并断言差异，保留原拒绝及不复制断言；候选源码不改，专项待资源时隙复验。main 测试 SHA256 `c50e426eecde0932f22d7e60dc06548110725b1fc33eb5a5f738344ae9142789`，候选原字节 `3450938e24666c46361db3cb15b1b9060e569f27f78acdb9fa6a12d6bbb08ce1`。当前全量运行已经出现失败，不得提前记为通过。

安装身份校验仅复用紧邻 guard 已取得的最终叶子 stat，并按文件大小分配最多 1 MiB 的读取 buffer；前后祖先 lstat/realpath、打开后及读取后 descriptor、硬链接和元数据检查保持。统一发现文件 `test/nsis-encrypted-lifecycle.test.js` 35/35、零跳过，相关 Lint/格式通过。同一 frozen payload 六次串行旧/新 A/B 用时依次为 7576/7202/8464/13670/12293/10038ms，存在明显时间漂移，不能据此认定有可靠提速或启动问题已解决。见 `verifier-minimal-ab-v1.json`。

保留原请求、启动起点及 15 秒期限的 v7 在 00 启动失败，`health_request_failed`，进程存活、preload 通过。v8 仅在 vault 的既有 HTTP client 外包裹有界状态码和耗时观察，不增加请求、不记录响应内容；00 同样失败，84 次既有健康请求均未取得响应，首次观察 preload passed 为 start ACK 后 13864ms，最后 status 为 15024ms。该结果支持本次窗口内服务未能给出可解析健康响应，不能解释成健康字段不匹配；passed 观察含轮询调度，也不等于纯 hash 耗时。两次均确认 controller close、harness/payload 与旧条目不变，各只创建一个 fresh case，零模型请求；四组合整体均失败。证据：`daemon-http-owner-v7-terminal.json`、`daemon-http-owner-v8-terminal.json`。不通过重试、延后起点、减检查或放宽期限改判。

逐项复核 I0–I5/H1 与 N01–N11 后，完整交付仍缺最终候选门禁、实际安装/迁移、WorkBuddy 实际长载荷、最终 HTTP/WS 在途撤权和强杀/清除后重开等组合证据。已有原单机合成样本真实 24 小时到期与重开拒读记录（`retention-after-real-deadline.json`、`client-retention-review-outcome.json`），不能表述为完全未测，也不能扩展为最终安装版或全天活跃任务容量通过。旧 Codex/Claude Core 全真实通过记录继续保留，其认证/路由 fixture 与最终安装版凭据解析边界不变。当前 NSIS lifecycle 仅接入 module API 四组合，实际 HTTP 接入正在独立 main 分线实施；其未来通过仍不能替代业务强杀、撤销或清除验收。

## 2026-10-22：分段观察确认 gate 校验占用大部分 readiness 窗口

v6 vault-only 分段诊断保留原 harness、请求、期限及起点，复用既有 controller status 记录固定枚举和单调耗时。00/01/10 再次通过全部真实 HTTP 保存、应用、存储与停止检查；11 仍失败，分类为 `ready_health_rejected`，最后状态确认子进程存活、preload 已通过。四组首次观察 passed 分别在 start ACK 后 9333、9842、9044、11623ms，最后 status 分别为 14327、14223、12451、14210ms。观察时间含轮询与调度，不等于纯 hash 耗时，也不等于产品实际 ready 时间；不能据此认定第四组健康响应中的哪个字段不符。

全部 close ACK、harness 与 payload、旧条目不变检查通过，四个新 case，零模型请求。证据为 `daemon-http-owner-v6-terminal.json`。整体 HTTP 资格继续失败；正在评估完整物理路径与文件校验中的重复 I/O，保留原 15 秒门禁，不将重试或移动计时起点作为修复。v13 合并及全量 runner 已准备但未绑定、未执行，候选仍为 v12。

## 2026-10-22：无效验收配置已修复，HTTP 前三组合通过，第四组合健康期限失败

controller 改为通过同一私有 builder 生成有效的纯本地 profile，使用空凭据，保持恢复默认关闭以及 audit、warmup、watchdog 禁用。实际 builder JSON 经真实 validateConfig 与 loadConfig 验证；旧配置变体复现 Missing activeProfile，修复配置四组合加载成功且网络尝试为零。相关回归 46/46，Lint、格式及 CI 治理通过，仅修改 harness 三路径，不改产品配置校验或期限。

root 绑定修复后的 20 份 harness 执行 v5：00/01/10 的真实管理 HTTP 配置保存、应用观察、存储检查和停止 ACK 全部通过；11 初始启动在原 15 秒期限内未取得健康响应，结果 `health_request_failed`、`preloadPhase:passed`。四组初始配置均禁用恢复，不能将此失败解释为启用持久化失败。控制器 close ACK、源码及 payload、旧条目不变检查均通过，零模型请求，整体仍失败。证据为 `daemon-http-owner-v5-terminal.json`。

只读调用同一 gate 身份检查的一次测量为 7468ms，校验 627 份源码及 Node、native、lock、manifest；该数值不代表 v5 第四组的实际耗时。原 readiness 起点之后尚未结束的 gate 校验会占用其 15 秒期限，现有 phase 没有时间戳，尚不能区分校验较晚完成与主入口启动较慢。下一次 vault-only 单次诊断复用原 channel/status，记录 start ACK 后阶段观察时间与轮询次数，不改 main harness、实际请求、原期限或计时起点；不能提前记为整体通过。

## 2026-10-22：启动 gate 通过，发现验收初始配置不满足产品校验

固定 preload 标记增量已通过 45/45 相关回归、Lint、格式及 CI 治理。root 复审并核对 20 份 harness 字节后执行新的 v4 隔离案例，终态仍为 `daemon_exited`，但 `preloadPhase:passed` 已证明 gate 身份校验完成。控制器 close ACK 成功，harness、原 payload manifest 及旧条目 metadata 不变，零模型请求。证据为 `daemon-http-owner-v4-terminal.json`。

对 v4 新生成的合成配置调用实际 `validateConfig`，得到 activeProfile 缺失及 profiles 为空两项拒绝。controller 当前生成 `activeProfile:''`、`profiles:[]`；产品主入口调用 `loadConfig({throwOnError:true})`，其补默认官方 profile 后仍缺 activeProfile，因此发现一条具体启动拒绝路径。正在修复 harness 生成的配置并补实际加载回归，不放宽产品校验。尚未取得修复后的 HTTP 四组合通过证据。

## 2026-10-22：HTTP 失败已收窄至子进程退出，尚未确认启动阶段

main 的安全失败分类增量已完成相关 42/42 回归，零跳过，Lint、格式和 CI 治理通过。仅接纳内部创建错误的固定枚举诊断，不读取外部异常 message、cause 或 getter；保留原失败与清理失败的独立分类。候选 v12 未修改。

root 复审后单次执行 main harness 的 v3 隔离验收，case 00 仍为 `launch_failed`，新增可信分类明确为 `daemon_exited`；控制器 close ACK 成功，harness 源码、原 payload manifest 和全部旧条目 metadata 前后不变，仅创建一个新 case，零模型请求。证据为 `daemon-http-owner-v3-terminal.json`。这证明实际子进程退出，但尚不能区分 preload 拒绝与产品主入口退出。

真实 Node spawn 与 .NET Process 匿名管道的延迟写入检查均通过，系统与内置 Node 字节摘要一致，本条件下 stdin EAGAIN 假设未获支持。正在增加仅含固定 entered/passed/failed 的 preload 阶段标记，并以有界字节状态机提取，不留存或转发产品原始 stderr。待回归及复审完成再执行一次新隔离案例；未观察到标记不单独证明 preload 未运行。

## 2026-10-22：v12 全量运行发现打包并发失败，HTTP 实际启动未通过

v12 全量 verify 已终态退出 1，源码前后身份不变。格式、1565 个 JS 文件语法、Lint、CI 治理、发布治理及原生恢复组件测试通过；原 4 shard 共运行 688 个测试文件，仅 bundle 文件失败两个 case，其余文件通过。覆盖率语句/行 91.32%、分支 90.08%、函数 92.15%，但 test:coverage 仍因测试失败未通过，后续 security check 和原 verify 后段均未执行。首失败是共享内容寻址 generation 的 staging rename `EPERM`，第二项复用同一准备 Promise 的失败。静态 discovery 确认 bundle/package 测试分别位于独立 shard；同期 package prepare 成功，目标 manifest 与目录摘要一致、10 个 bundle 文件检查及全部 293 个 input 摘要校验通过，支持并发发布竞争的解释。

main 已完成两路径修复：仅 Windows `EPERM` 且目标 generation 已存在时进入原完整赢家验证，所有包、文件及 marketplace 字节仍须一致；无目标、其他权限错误及篡改/链接目标均拒绝，不重试、不删除赢家。定向回归 18/18，跨进程收尾修订后 1/1；原 bundle/package 两文件完整并行验收 33/33、零跳过，约 49 秒，包含此前失败项及真实双进程同 hash 发布。ESLint/Prettier 通过，隔离配置，零模型请求；候选 v12 未修改。证据为 `bundle-publication-full-main-65b46220-ecbf-481d-8a48-a30296d7d134/result.json`，尚待合并最终候选并取得全量通过。

HTTP v1 在 daemon 启动前被 vault 快照错误拒绝：BigInt `nlink` 与数字 `1` 比较。vault v2 仅修复 `1n` 并使用新单次收据，红绿回归确认普通文件接受、硬链接及目录链接拒绝，3/3 通过。root 执行 v2 后，case 00 `launch_failed`，控制器 close ACK 成功；候选相关源码、payload manifest 及全部旧条目 metadata 前后不变，仅创建一个 fresh case，零真实模型调用。case 的配置文件已生成而 runtime 为空，现有通用错误无法区分 process start、Job assignment、gate 或 health 阶段，正在补定位；不能据此认定 preload 超时或产品 daemon 已完成启动。原 v1 attempt 与 v2 terminal 均保留，不复用或自动重试。

## 2026-10-22：v12 已合并并启动完整 verify，单独真实运行时 11 通过

root 已将冻结的 hooks 五路径、安装设置二十一路径、HTTP 五路径及进程所有权九路径精确合并到隔离候选 v12，共 40 路径（34 新增、6 替换）。全量身份检查确认 1794 份源码与原 11 个单列 pyc，投影外无变化；身份 SHA256 为 `36dee187b1d1b2d05a73545c1de014235623ae5ce6e9b6a4f094fa343e0a8998`。原字面 `npm run verify` 已启动，保留 16 阶段、4 个单元测试 shard、覆盖率阈值及原测试断言，尚未取得终态结果。合并不授予安装或生产资格。

针对原 staged 四组合失败，root 使用原不可变 payload 与三个独立新目录分别完成真实 ACL、默认 storage 初始化和关闭、默认 runtime 的 11 配置诊断。三项均通过；runtime 仅注入 `dataDirectory`，确认 requested/applied 两开关均为 true、`storage:persistent`、`state:enabled`、ready 和 shutdown ACK 均成功，约 3.7 秒。诊断未修改 loader，也未复用原失败案例。此前四组合失败继续保留，不能再据此将根因限定为 ACL；组合入口、加载校验及环境差异仍待定位。上述窄诊断不替代四组合、HTTP、installed、重启留存或 24 小时资格，零真实模型请求。

随后，使用新 UUID、逐字复用原 matrix 的加载校验、PROXY 环境清理及 config/data 布局，单独 11 诊断仍通过，ready/shutdown/expected11 均为 true，约 12.3 秒。加载校验必然导致失败的解释未获支持；原四组合的总期限、重复校验开销与物理边界断言仍待核实。

root 进一步在原 payload parent 下创建新 UUID case，沿用原 Job/gate、120000ms 单 case 期限，单次直接运行未改的原 `nsis-settings-matrix.cjs 11`。完整原 physical pins、两次 storageBoundary、关闭后 inspect 和严格 receipt 解析均通过，用时 63980ms；关闭后 wrapped key、writer、checkpoint 均存在，DACL 已保护。结果保存在新 case 的 `diagnostic-result.json`。此前失败未复现，根因仍未确认，不将此单 case 通过解释为原四组合整体、installed 或生产资格。静态对照也确认 120 秒按每 case 独立计时，原外层 540 秒未到期限；旧 `cleanupConfirmed:false` 缺乏安全错误分类，不能直接认定进程泄漏或清理超时。

候选投影首次准备曾因历史 v1–v3 identity 没有 `version` 字段而被拒绝，未修改候选。vault 校验器已按历史原始 SHA 与实际 schema 修复，14/14 离线回归通过；旧失败准备目录保留，root 在新 UUID 准备后完成本次投影。

## 2026-10-22：真实 staged 四组合未通过，安装设置接入离线通过

root 已完成 v2 隔离目录准备：627 份声明源码、4193 份依赖文件，共 4824 文件、113392833 字节，复制后及源端复验通过。随后单次真实 staged module API 四组合执行终态退出 1；失败收据保留，`cleanupConfirmed:false`，没有自动重试或复用该 prepared attempt。00/01/10 的物理恢复目录均不存在；11 仅创建空恢复目录，密钥、writer 与 checkpoint 均不存在。后置只读 ACL 检查显示目录仍继承权限，当前仅能将诊断范围收窄至目录初始化/ACL 边界，不能认定 DPAPI 根因或前三组合已经取得独立资格。见 `staged-settings-matrix-v2-be981d932a5a4d619193cb8f4a955e7a/attempt-result.json`。依赖身份仍为 lock-only，未执行安装器或真实模型请求。

安装流程的设置矩阵接入已精确备份并应用 main 四路径：显式导入 matrix、在 current 包回滚前调用真实矩阵、严格汇总收据、失败中止后续序列。新增 wrapper 与相关 encrypted/settings 回归 12/12、零跳过，PS 语法、相关 ESLint 与差异检查通过。候选尚未同步；离线结果不替代上述失败的真实 staged 执行，也不代表 installed、HTTP、重启保留或生产资格。

## 2026-10-22：main 原 hooks 完整通过，冻结候选尚待同步

补齐清理失败安全分类及固定枚举失败阶段诊断后，root 单次执行未注入 observer 的原字面 `npm run test:hooks` 已终态退出 0，2/2、零跳过，绑定十路径前后无漂移。合法代码真实 ESLint/Prettier、格式化文件及 Git index 检查，非法代码真实 `no-undef` 拒绝及 index 保留断言全部通过；原 30000ms hook 期限、5000ms 终止期限、命令及 stash 语义保持。相关 helper/PATH 回归 29/29，Lint/格式通过。证据为 `main-hooks-path-v2-terminal.json`、原日志及 `main-hooks-stage-diagnostic-v2-ready-receipt.json`。

整项测试约 33.67 秒包含 Git setup 和合法/非法两轮，不作为单次 hook 耗时或 PATH 因果改善证据。此前 timeout、partial 诊断及清理失败结果继续保留；当前通过属于 main-only，v11 冻结候选未同步这五路径，完整 verify、安装及生产资格仍未完成。

## 2026-10-22：新增独立设置矩阵，原 hooks 出现清理失败

main-only 新增独立 settings case、Node runner、PowerShell controller、统一发现测试及 PS fixture 共五路径，既有十三路径冻结增量保持不变。四组合合成完整验收 4/4、零跳过，随后仅测试追加的 accessor/拒绝边界快测 4/4、零跳过，相关 Lint 通过。受测 runtime 仅收到 `dataDirectory`，00/01/10 要求无恢复存储，11 检查落盘结构及关闭 ACK；合成 helper 是不可执行占位符，未据此声称 DPAPI、installed、HTTP 或重启保留通过。见 `settings-matrix-main-only-result-v1.json`。

受控 PATH helper 及原进程 helper 合并回归 25/25，新增 PATH 回归格式调整后再验 8/8，Lint/格式通过。仅保留五个验证后的工具目录，仍使用原 hook 命令、stash、30000ms/5000ms 和原断言；main/candidate ESLint 配置及 lint-staged 配置等价。这是固定测试运行环境的候选修复，尚未建立 PATH 根因或提速结论。

root 随后单次原字面 `npm run test:hooks` 未注入观察器，终态退出 1、1/2，绑定九路径前后不变，见 `main-hooks-path-v1-terminal.json`。本次顶层错误是 fixture 清理失败，现有 TAP 未显示原检查是否同时失败；不能据此宣称 hook 已通过或仍为 timeout。清理错误分类正在补安全诊断，原失败结果保留，未改期限或自动重跑。

## 2026-10-22：v11 hooks 分段诊断终态，保留原门禁失败

绑定 v11 的一次原命令分段诊断已终态退出 1，1760 源文件与 11 个单列 pyc 前后无漂移。合法代码钩子触发原 30000ms 期限，进程树终止回调成功，约 4451ms，未放宽期限或重试。安全事件中已完成的 Git 子进程区间去重并集约 21575ms；被终止前没有观察到 ESLint 或 Prettier 启动，因此本次超时发生在工具检查之前的 Git 阶段，尚不能据此确定底层变慢原因。

强制终止使 CLI observer 退出事件及最后一个子进程生命周期不完整，收据明确 `diagnosticComplete:false`。这些局部事件用于定位，不算完整诊断或原 hooks 通过，也不用于证明性能改善。证据为 `candidate-v11-hooks-stage-diagnostic-terminal.json` 和仅含固定枚举、数值的事件文件；未保存原始输出、命令参数或用户内容。完整 verify 与当前实际安装资格仍未完成。

## 2026-10-22：按用户选择分离容量执行预算与性能目标，v10 hooks 超时已明确

用户明确选择保留完整五档、双 worker、负载及全部功能与安全断言，将整套容量测试的运行预算重定为 180000ms，原 60000ms 独立作为未解决性能目标。CLI 记录 `capacity-workers` 耗时，统一 CI 父进程另记录 `capacity-command` 的完整子进程耗时；两种口径不混用，功能 `qualified` 不代表性能、持久化或安装资格。独立 timing 回归 2/2，新模块覆盖率 100%，静态与 CI 治理检查通过。见 `capacity-budget-separation-main-v1-receipt.json`。随后精确六路径投影为 v11：1760 源文件及原 11 个 pyc，package 仅新增一个测试路径，plan 仅插入新政策段，其他候选内容保留；见 `candidate-capacity-budget-v11r2-apply-receipt.json`。

新预算下两阶段已完整终态退出 0，1760 源文件与 11 个单列 pyc 前后无漂移：完整 timing c8 2/2、新模块覆盖率 100%；完整原 workload c8 10/10、零跳过，五档及双 worker 不变。父进程记录容量资格命令耗时 158465.3493ms，满足 180000ms 执行预算，原 60000ms 性能目标仍未满足。证据为 `candidate-v11r2-capacity-budget-gates-terminal.json` 及两份原阶段日志。容量定向运行没有执行全局覆盖率阈值，不替代全仓 coverage/security/client 门禁；历史失败证据保留，完整 verify 仍未通过。

仅将 fixture helper 的安全分类和 TAP 诊断修复两路径投影为 v10，完整 1758 源文件及 11 个单列 pyc 校验不变。候选完整 helper 回归 17/17 通过，但原字面 `npm run test:hooks` 仍为 1/2：合法代码检查明确触发原 30000ms 超时，本次 helper 的进程树终止成功返回，未将失败吞掉或提高原 hooks 期限。整项测试约 41.67 秒包含 Git setup 和终止，不能当作 CLI 本体耗时；尚不能归因到 ESLint、Prettier、Git 或环境。证据为 `candidate-v10-original-hooks-terminal.json` 及阶段日志，完整 verify 继续未通过。

## 2026-10-22：v9 Rust 通过，当前容量诊断与安装边界继续推进

原 `npm run test:rust` 已完整终态退出 0，包含 `release:prepare`，Rust 测试共 17 项通过、零忽略；1758 份源码及 11 个单列 pyc 前后无漂移。证据为 `candidate-v9-independent-test-rust-terminal.json` 与对应日志。此次隔离环境需要下载和编译依赖，整阶段约 23 分钟，不将编译等待归为产品请求延迟。先前六项独立门禁加本项均通过，但 hooks 及原容量期限仍失败，完整 verify 仍未通过。

随后在同一 v9 身份上执行完整原五档、双 worker 的原生 CPU 采样诊断，退出 0，三份 profile 完整，源码前后不变，见 `candidate-v9-capacity-cpu/terminal.json`。采样子进程约 71.51 秒；这是诊断结果，不替代原 60 秒门禁，也不与历史运行直接比较宣称提速。当前正在按采样定位下一步优化，未修改容量负载、期限或覆盖率要求。

main-only 安装边界 contract/cases 经独立源码审查及完整两文件复跑 17/17 通过。实际默认 runtime 的普通文件阻断场景验证初始化失败关闭、拒绝再次启用及失败关闭 ACK；默认值仅空目录子检查，四组合持久化分支使用合成生命周期。安装薄入口仍在接入，以上不代表实际安装包、DPAPI、管理 HTTP 或 GUI 资格。没有在日常机器运行安装器，没有新增真实模型请求。

## 2026-10-22：v9 八样本资源对比通过，继续独立后段门禁

绑定 v9 全部 1758 源文件与 11 个 pyc 的受控原生 Codex/Core 对比已退出 0：默认、增强各四样本、交替顺序、相同合成原文和提示，每样本三次原生压缩，零真实模型请求。所有样本均完成、精确恢复相关断言及配置/源码不变检查通过；默认路径验证恢复准入未调用且没有根或快照。最终收据为 `codex-controlled-cost-candidate-v9-outcome.json`，逐样本结果另存并绑定摘要。

该固定合成任务中，默认/增强上游响应数分别为 6/13，请求字节分别为 135337/339273，Node CPU 中位数约 1305/2062ms，Node 峰值 RSS 最大值约 394/400MiB；样本总时长中位数约 4014/3953ms。仅四样本/模式，不计算 p95；CPU/RSS 不含原生 CLI，首上游到达不等于首个可见文本，内存峰值轮询可能漏峰。脚本预建两种模式的 session，不能代表冷启动；本地合成响应决定答案，不用于真实模型质量、延迟、token 或费用判断。隔离 native home/provider 指向 loopback，不声称存在 OS 级外联防火墙。资源结果不替代容量、持久化、24 小时、安装或生产资格。

单 aggregate 前缀确认方向已按静态工作量先拒绝：最大档需重新 hash 约 15.13GB 正文，现 request-local leading 状态最多约 0.623GB，约 24.28 倍；计数不是墙钟性能证明，不将该原型接入产品，见 `prefix-confirmation-v1-static-cost-rejection.json`。CPU 离线归因也排除 metadata/seal 优化方向，其在原最慢 worker 合计仅约 59ms，不足以关闭容量差额。原 60 秒容量门禁仍失败；完整 verify 未通过。正在准备按原命令独立执行尚未验收的后段门禁，不跳过原门禁或更改覆盖阈值。

独立后段执行已有六项原命令终态通过：`test:frontend:coverage`、`test:frontend`、`test:thinking`、`test:env`、`test:integration`、`frontend:build`。所有阶段前后全身份无漂移；前端完整文件 28/28，覆盖率语句/行 98.2%、分支 91.61%、函数 96.77%，保留原门槛。证据均为 `candidate-v9-independent-<script-name>-terminal.json` 及原日志；这些是独立完整 stage，不宣称完整 verify。

未注入观察器的原 `test:hooks` 终态失败（1/2）：合法代码阶段已经格式化并写入 Git index，未到非法代码分支，约 39.39 秒后报进程树终止失败并保留 fixture。现 helper 丢失触发终止的原因及 taskkill 错误分类，不能严格区分原 30 秒超时、输出上限、PID 退出竞态或终止器超时；不得依据早先 v8 诊断通过关闭。已开始 main-only 安全分类及回归增量，候选未改，也未删除失败 fixture。`test:rust` 同一队列仍运行，原生密钥 helper 的 release 编译已完成，不能据此记 Rust stage 通过；沿用当前会话与进程继续观察，不启动第二份。完整 proxy/security/client coverage 仍保留原容量依赖，没有通过证明。

## 2026-10-22：v9 行为回归通过，原容量期限复验仍失败

仅将常见单条 function tool-call 消息的 descriptor clone 优化及既有 binding 测试两路径投影到隔离候选，维持 1758 份源码及 11 个单列 pyc。独立审查覆盖节点、字节、深度预算、属性顺序、冻结、可执行值与 Proxy 回退；不省略外部输入验证、不新增跨请求正文缓存。最终 49 项外部行为与安全测试在候选普通运行和 c8 运行均全数通过、零跳过。证据为 `history-function-clone-v2-outcome.json`、`history-function-clone-v2-independent-review.json`、`candidate-history-v9-apply-receipt.json`。

随后完整 `context-recovery-capacity-workload.test.js` 在 c8 下仍为 9 通过、1 失败，原资格子命令触发 60000ms `ETIMEDOUT`。三阶段已全部终态，候选所有源码与单列生成物前后无漂移，见 `candidate-v9-history-gates-terminal.json` 与对应原始日志。原五档、两 worker、期限、coverage include/exclude 均未改变；本轮没有通过容量门禁，也没有足以证明性能改善的结果。完整 verify 尚未启动，不将定向覆盖率解释为全仓覆盖门禁通过；后续继续审查 frontier 热点并推进独立安装及连接验收准备。

实际 WBIPC 能力探测首次执行记录 `probeStatus=ready`，但三帧发送计数均为零，因此探测器按设计拒绝资格，不记作真实握手通过。已定位 evidence-only 守卫在 `Socket.connect` 前设置的实例 `write` 被 Node 连接初始化覆盖；正在修正守卫安装时机并补离线回归。该次仅一次本地连接、零模型调用，前后全源码和日常配置校验不变，失败证据为 `wbipc-capability-probe-v9-result.json`。守卫修复不属于产品变更，也不替代载荷、恢复或完整客户端验收。

后续 v10r2 探测器在连接同步返回后安装不可覆盖的发送守卫，并拒绝守卫安装前的同步 connect/data/error；离线 16/16 通过。根复审后真实执行退出 0：单连接、单守卫，session_hello、session_prove、broker/GetPipe 各一帧，`capability_verified`，无拒绝帧、额外连接或子进程；没有派发 http.fetch，零模型调用，前后全源码和日常配置均未变化。证据为 `wbipc-capability-probe-v10r2-result.json`。此结果仅证明真实 HMAC 会话及声明的 wb.request/http.fetch 能力，不关闭 N06 长历史载荷恢复、模型、安装或生产资格。

## 2026-10-22：v8 完整相关回归通过，容量功能通过但原 60 秒门禁仍失败

已精确合入恢复准入复用及继承 toJSON 修复：十条路径（七修改、三新增），冻结 1758 份源码和 11 个单列 pyc。完整 admission、ledger-state、root-state 三文件分别 16/16、31/31、67/67，零跳过；包含原 512 快照、四根 32 MiB 加密重开和大正文边界，各阶段前后全身份不变。证据为 `candidate-proof-sync-v8r2-receipt.json`、`candidate-v8r2-proof-related-terminal.json`。

原五档、两 worker 的 `npm run qualify:context-capacity` 退出 0，五档覆盖和恢复计数均 qualified；包装器记录约 109 秒（包含后置身份检查），不等于原 60 秒门禁通过。随后完整原容量测试文件在 c8 下 9 通过、1 失败，资格子命令明确在约 60122ms 报 ETIMEDOUT，期限、负载均未改；证据为 `candidate-v8-original-capacity-terminal.json`、`candidate-v8-capacity-regression-terminal.json`。定向 c8 的覆盖百分比不代表全仓覆盖门禁结果。

冻结 v8 的原负载 CPU 诊断完整退出 0，子进程约 80.12 秒，三份原始 profile 和前后全身份均封存。关键 worker 中 observe/begin 约 45.69 秒，restore 约 10.87 秒、export 约 6.69 秒；主要 inclusive 热点为 frontier 计算和 history normalization。采样含 profiler 开销，不能与前一次无采样包装器耗时比较得出加速结论；证据位于 `candidate-v8-capacity-cpu/`。后续优先审查常见 tool-call 消息的 descriptor clone 开销，不扩大原文缓存、不省略外部输入验证。

原 Git hooks 两场景在诊断观察器下完整 2/2 通过，合法/非法代码分别得到预期通过和拒绝，未触发原 30 秒终止；源码不变、诊断事件有效，见 `candidate-v8-hooks-diagnostic-terminal.json`。这不是客户端产品 hook 验收，最终完整 verify 的未注入执行仍待完成。当前候选 `npm audit --audit-level=high` 退出 0，各严重度均为零，原始结果为 `candidate-v8-npm-audit.json`。最终构建、当前版本真实安装加密迁移、客户端矩阵和生产启用仍未交付。

## 2026-10-22：v7 相关门禁通过、旧包归档完成，最终恢复候选准备中

远端 review 触发路径已完成独立复审并精确合入 v7，冻结 1755 份源码及单列的 11 个 Python 字节码。完整解析、加密生命周期、传输测试及 CI、发行、Lint、格式共七阶段均退出 0，候选前后摘要一致；证据为 `candidate-routes-sync-v7-receipt.json`、`candidate-v7-route-related-terminal.json`。这仅证明候选相关门禁，不代表当前版本真实安装迁移或完整 verify 通过。

旧运行闭包及真实 NSIS 安装包归档进程已退出 0，`preserved-old-nsis-baseline-v2/archive-receipt.json` 为成功终态。归档包含 625 份源码，安装包 SHA256 为 `e7dc2ec976df82c2679eb45b336312253caec2f7cf8e7629cc4940e147b85ce6`；归档过程校验复制前后源文件和目标文件，旧构建产物不再作为唯一基线。实际加密安装、升级、回滚仍待 GitHub 临时 Windows runner 验收，未在日常环境执行安装器。

恢复准入复用已补齐原有 128 条/4 MiB 的调用内正文校验缓存；随后独立复审发现 Array.prototype 非标准父链上的继承 toJSON 会改变原序列化行为，已回退到原验证路径并补回归。修复前完整 admission 文件 14 通过、2 项预期失败，修复后完整 16/16、零跳过，相关 Lint 和格式通过；十项产品输入仅模块及其测试两项相对 v2 变化。证据为 `ledger-output-cache-v2-outcome.json`、`ledger-proof-inherited-tojson-v3-outcome.json`。当前正在准备 v8 精确投影，尚未据此通过完整三个相关文件、原五档容量、最终完整门禁或最终构建，不宣称性能改善或整体交付完成。

## 2026-10-22：v6 传输专项通过，补齐实际远端触发路径与恢复准入复用

传输链的三项复审问题已关闭：执行 commit 与 draft target 一致、失败保留未知远端资源、固定 GitHub 主机并净化环境覆盖；Git HEAD 校验同时净化继承的 Git 环境。独立复审后仅六个新文件进入 v6，冻结 1750 份源码，11 个 Python 字节码仍逐项单列。完整 transfer 测试 10/10、CI 治理、发布治理、相关 ESLint 与六文件格式五阶段全部退出 0，前后源码和生成物均无漂移。证据为 `private-baseline-transfer-implementation-v2.json`、`private-baseline-transfer-readonly-review-v2.json`、`candidate-transfer-sync-v6-receipt.json`、`candidate-v6-transfer-related-terminal.json`；没有真实上传或安装资格。

只读远端盘点确认两个新 manual 工作流尚未进入默认分支，不能将本地文件存在视作可直接 dispatch。正在补同提交的专用 review push caller 和 `workflow_call` 路径，不修改 master：已审阅 source commit 先进入独立源分支，旧包 draft 绑定该 commit，再创建同 commit 的专用桥接验收别名，取得 artifact 后创建安装验收别名。解析只允许固定仓库、新建非强推分支、严格 ref/ID/UUID/SHA 与实际 HEAD；拒绝 Unicode 尾缀和超出 64 KiB 的最终输出。相关三文件首轮 21/21，最终解析器硬化后独立 5/5；尚待独立复审和候选内完整相关复验，不继承 v6 身份。证据为 `hosted-review-trigger-current-audit-v1.json`、`windows-recovery-review-routes-implementation-v3.json`。没有实际 push、dispatch 或默认分支变更。

容量方向已开始窄产品集成：仅完整 v9/v10 恢复内部复用同一次有界 clone 的私有 proof，普通导出、公开可变副本、metadata 和 legacy 路径保留，语义验证、默认 1 MiB 输出限制、TTL 和 store 清理仍共用原实现。改前对照恰有两条真实 root 重复准入断言失败，改后 16/16 定向正确性通过，十文件摘要保持；证据为 `ledger-proof-product-v1-correctness-outcome.json`。随后只读审查发现新增结构路径会重复验证相同正文，正在按原 128 条/4 MiB 局部缓存边界补修及回归，不能沿用 v1 定向结果宣称修后资格。三个完整相关文件已准备原期限、零排除的 runner，待旧包归档结束后运行；独立五档容量、完整 verify、最终包、真实迁移和生产资格仍未完成。

## 2026-10-22：加密安装候选 v5 专项通过，传输链复审修正中

已将审核后的加密安装生命周期十文件精确合入独立候选，冻结 v5 共 1744 份源文件；11 个 Python 字节码生成物继续逐项单列。六阶段顺序检查全部退出 0：加密生命周期测试、既有 NSIS 生命周期治理、原 `npm run check:ci`、原 `npm run release:check`、相关五个 JS/test 文件零警告 ESLint，以及 workflow 与相关文件格式检查。每阶段前后源码及登记生成物摘要均一致。证据为 `candidate-nsis-sync-v5-receipt.json`、`candidate-source-identity-v5.json`、`candidate-v5-nsis-related-terminal.json`。这不是完整 verify 或真实安装迁移资格。

私有旧包传输链新增独立本地默认 dry-run 入口及手动 hosted bridge，第一轮本地回归 8/8，Lint、格式、CI 治理通过；未发生上传、dispatch 或安装执行。独立复审发现执行提交身份未绑定、失败清理可能删除未知附件、gh 主机可能受环境覆盖三项问题，正在修正并补回归；首轮通过不构成传输链最终资格。证据为 `private-baseline-transfer-implementation-v1.json`、`private-baseline-transfer-readonly-review-v1.json`。真实旧包归档仍在同一受控进程中执行，成功收据出现前不覆盖旧 staging 或安装器。

容量方向的 ledger 准入复用仍是证据目录实验，正确性对照通过，但单轮伴随归档 I/O 的 ABBA 诊断不足以建立稳定性能改善；未修改产品或通过原五档容量门禁。hooks 诊断已适配 v5 身份且仅通过语法检查，仍待归档结束后执行原期限命令。没有真实模型请求、日常配置修改或生产重启；容量、完整门禁、远端真实加密迁移和最终生产资格仍未完成。

## 2026-10-22：完整候选终态、动态闭包补齐及隔离安装替代路径

完整候选的字面 `npm run verify` 已终态退出 1，耗时约 20 分 26 秒；673 个单元测试文件中 669 通过，失败为容量工作负载、天玺 Python 授权、Python 隔离运行时及 Trae 扩展安全错误测试。1725 份事前冻结源码在运行后无修改或新增。代理覆盖率语句/行 91.3%、分支 90.05%、函数 92.13%；安全覆盖检查及后续 client/frontend/build/Rust 阶段因命令链失败没有执行，不能记作通过。证据为 `candidate-full-verify-v1-terminal.json` 与原始日志。

后续核对发现候选缺失 11 个 Python 测试及传递依赖文件，并保留了旧 Trae `extension.js`；后者缺少已有主工作区安全错误实现，其余六个关联模块已一致。仅补齐审核闭包，不放宽断言、原 10s/20s Python 期限或容量 60s 期限。新增正数 unittest 执行计数校验及边界回归，防止旧 Python 的零测试成功退出产生假通过。回归保留在统一 unit 已发现的原测试文件中。

补齐及 guard 后的 v3 冻结包含 1736 份源文件，五个 Python/Trae 专项文件普通和 c8 顺序隔离运行全部退出 0，每次前后源码摘要一致。此为专项验证，不替代完整候选门禁或全局覆盖率资格；容量超时继续未解决。证据为 `candidate-closure-sync-v3-receipt.json`、`candidate-python-guard-v3-receipt.json`、`candidate-targeted-v3-summary.json`、`candidate-targeted-v3-covered-summary.json`。动态入口审查另记录于 `candidate-dynamic-boundary-review-v3.json`，静态闭包不被视为任意计算导入、生成代码或外部原生依赖的完整证明。

随后七项独立门禁终态为五通过、两失败：原 proxy 结果的安全覆盖检查、前端覆盖、thinking、env、integration 通过；frontend 的便携包旧委派断言和 hooks 终止失败保留。前端覆盖率语句/行 98.2%、分支 91.61%、函数 96.77%，不代表完整 verify 通过。专项生成的 11 个 Python 字节码文件逐项登记路径、大小及摘要，作为生成物检查，不纳入源码身份；1736 份源文件及这些生成物均未漂移。证据为 `candidate-independent-followup-v3-terminal.json`、`candidate-targeted-v3-generated-additions-supplement.json`。

便携包脚本已由独立 runtime 模块执行完整闭包复制，旧 UX 断言仍查找脚本里的直接文件名。已更新委派契约，并新增八类真实文件拒绝回归，要求配置、token、日志和私有目录混入时在复制前失败，正常复制只包含配置模板。v4 仅投影该 UX 单一修改和完整便携包治理测试，继续排除无关 image 修改；v4 顺序隔离专项终态两文件均通过：UX 原 29 场景通过，便携包治理 44/44，通过后 1736 份源文件及 11 个字节码生成物摘要一致；证据为 `candidate-v4-scoped-terminal.json`。随后原 `npm run test:frontend` 完整入口终态退出 0，源码与生成物均无漂移，原 v3 前端失败由 v4 关闭；证据为 `candidate-v4-frontend-complete-terminal.json`。hooks 失败保留原 30s 命令期限及 5s 终止期限，没有放宽或自动重试；已知进程树与精确夹具参数快照未发现遗留，但不能由此证明所有未知孤儿进程不存在，也不能归因为环境负载。准备的诊断仅记录固定枚举与数字，不记录命令、参数、输出或环境。

没有本地 Sandbox/VM 不再作为安装验收的必要阻塞：现有 GitHub 托管 Windows runner 已实际通过旧基线 NSIS 安装、升级、回滚、卸载与合成文件保留，运行编号 39761611237。那次候选不含本次完整恢复实现，未验证加密迁移或 24 小时容量。后续将在同一临时 Windows 用户下，以 runner 本地生成的合成 DPAPI 数据验证真实旧包到完整新包的读取、原期限保留和回滚；日常密钥、数据库和原文不上传。真实旧安装器与 625 份运行时源闭包须先归档且校验通过，才允许后续构建覆盖 staging。归档、迁移计划均不是已通过的完整安装资格。

## 2026-10-22：健康探测延迟加载修复与天玺全文件诊断

健康探测首次进入管理模块时，经 `management-profile` 顶层引用提前加载 Tianxi bridge/SDK；该依赖实际只用于 Tianxi 默认探测分支。已将加载移到该分支，并保持注入 bridge 的短路行为。隔离回归先复现提前加载失败，再验证模块导入、构造、非 Tianxi、注入 bridge、默认 bridge 及加载/构造/调用失败；三个定向测试文件全部通过，语法、Lint、格式与统一测试发现检查通过。证据为 `management-profile-lazy-bridge-scoped-v1-receipt.json`。

修复后 Gemini 原 token-count 路由文件普通及独立 c8 运行均退出 0，保持原 15 秒 startup 期限、不使用模块计时 preload，7 个关键源码运行前后摘要一致。普通整命令约 5.04 秒，c8 整命令约 19.70 秒（包含报告生成，不是启动耗时）；证据为 `gemini-isolated-terminal-v2-receipt.json`。单文件 `--all` 覆盖率报告没有执行全局阈值及安全覆盖门禁，独立通过仍不替代四分片完整资格。

天玺完整 `tianxi-sdk-handler.test.js` 在隔离目录、c8 与仅记录数字阶段的探针下终态退出 0，106/106 通过，整命令约 116.6 秒，原 HTTP 5000ms 不变。探针记录前 1024 个请求并明确省略其余 140 个，不把已记录最大耗时当作全部请求上界。此次仍不是四分片完整门禁；未复现的全量失败保持未关闭。终态与安全汇总为 `tianxi-full-covered-diagnostic-v2-terminal.json`、`tianxi-full-covered-diagnostic-v2-summary.json`。未发起真实模型请求、重启生产或变更日常配置。

## 2026-10-22：本轮完整 verify 终态与下一修复

`current-startup-full-verify-v1.log` 对应的字面 `npm run verify` 已终态退出 1：四个分片共 672 个文件，669 通过，失败为 `context-recovery-capacity-workload.test.js`、`gemini-token-count-routes.test.js`、`tianxi-sdk-handler.test.js`。覆盖率语句/行 91.25%、分支 90.04%、函数 92.13%；覆盖率不替代测试通过，后续 verify 阶段没有执行。终态封存于 `current-startup-full-verify-v1-terminal.json`，修改前复核 1610 路径 `changed=[]`。该冻结仍不含前述 native、插件模板及部分顶层输入，不扩大其事前身份范围。

冻结解除后应用已有 Rust CAS 补丁：以保留 Acquire/AcqRel 的 compare_exchange_weak 循环替换弃用 fetch_update，并保留原容量、错误与 Drop 行为，新增容量拒绝、释放复用和并发争抢回归。正式 Cargo 测试 17/17、格式检查及 Clippy `--all-targets -- -D warnings` 全部通过。首轮 Clippy 拒绝新增回归中的立即调用闭包，改为具名失败函数后重新通过全部 Rust 检查，失败日志保留；没有关闭规则。证据为 `management-slot-cas-v2-receipt.json`，使用 Rust 1.92.0，未实际运行最低 1.77 工具链。此后源码身份不同，不沿用上段完整验证作为修改后资格。

插件首两项 legacy 测试改为从明确模板与递归 lib 闭包生成独立临时产物，并使用精确限定的 test-only SDK 解析；新回归先证明干净目录没有 manifest/runtime，再验证来源字节不变、忽略目录不复制、夹具隔离及非法依赖/越界/缺失输入拒绝。实际隔离完整文件 11/11，通过原 60000ms 用例期限；静态、零警告 ESLint、格式及 CI 治理通过。Verify unit/coverage 的依赖阶段显式安装插件自己的锁文件依赖，测试中不联网安装；现代 bundle 测试仍使用本机现有 nested 依赖，实际最终候选的干净 CI 安装尚未执行。证据为 `plugin-clean-isolated-full-v1-receipt.json`，不把本机已装依赖当作干净 CI 资格。

天玺原失败用例 `Unconfirmed continuation receipts...` 的请求阶段探针，在普通及覆盖率独立运行均 1/1 通过，原 5000ms 不变；这次没有复现完整分片中的超时，不据此关闭失败。延迟 history.load 的提议已否决，因为恢复后的重复 delta 请求需要其上下文签名，不能省略。仅记录数字请求号、固定阶段和耗时，无参数、内容或凭据；证据为 `tianxi-request-critical-path-original-v1.log`、`tianxi-request-critical-path-covered-v1.log`。容量、Gemini 启动与天玺整轮超时、最终候选安装/迁移及生产资格继续未完成。

## 2026-10-22：当前依赖审计通过，候选闭包继续核对

当前工作区实际执行 `npm audit --audit-level=high --json` 已退出 0，info/low/moderate/high/critical 总计均为 0。package.json 与 package-lock.json 摘要和本轮 1610 路径冻结一致，审计原始结果及摘要封存在 `current-dependency-audit-v1-receipt.json`。该结果只覆盖当前 Node 根锁文件依赖，不替代 Cargo 原生依赖、全仓门禁、远程 HEAD 基线的失败结果或生产资格。

只读源码边界分析已排除一个无足够收益的容量方向：binding restore 的整体采样成本约 2.526s，不足以支撑原容量门禁；sessions.begin 的首次归一化与 frontier 是不同工作，binding.begin 二次归一化已有私有所有权复用，仅约 2.182ms。已有被拒编码、摘要及子树优化不换名重复实施。证据为 `capacity-readonly-structural-duplication-v1.json`、`capacity-readonly-begin-hotspots-v2.json`；没有据此修改产品、降低安全校验或增加负载。当前完整 verify 仍运行，已观测容量及天玺持久化 HTTP 原期限失败，终态尚未封存。

## 2026-10-22：Node 24 原期限失败终态与远程安装推进

Node 24.19.0 下原容量命令测试已终态退出 1：1 项失败，子进程在原 60000ms 期限触发 `ETIMEDOUT`，测试约 60.21s、整命令约 63.38s。五档画像、两 worker、负载和期限均未改变。该试跑与语法检查并发，不构成 Node 22/24 的受控性能对比，也不支持通过升级日常运行时关闭容量阻塞。原始日志和 SHA256 已绑定于 `capacity-node24-original-deadline-v1-terminal.json`；没有修改日常运行时或发起真实模型请求。

真实远程 Windows 生命周期任务已终态成功：[run 39761611237](https://github.com/cbhandsun/https-proxy/actions/runs/39761611237) 的两个构建、安装、升级、回滚、卸载及清理全部通过。原日志确认 baseline→current→baseline 三阶段应用摘要，回滚准确还原 baseline，固定合成配置/数据（含到期字节）在升级、回滚和卸载后保留，卸载移除应用与注册信息。终态与安全筛选后的阶段证据保存在 `windows-lifecycle-remote-terminal-v1.json`。该候选仍仅为 9 文件安装验收分支，不包含主工作区的恢复实现，不扩大到加密迁移、24 小时容量、发行签名或生产资格。本地完整 verify 已通过格式、4053 文件语法、Lint（0 错误、5 警告）、CI 与发行治理并进入覆盖率单元阶段，终态待记录。

核查发现 `current-startup-source-freeze-v1.json` 的 1610 路径范围没有包含实际构建的 `native/` 目录；该冻结只能证明其显式目录范围，不称为所有原生构建输入的事前冻结。保留原记录，最终候选需将原生源码及构建输入纳入完整身份校验，不能以事后快照补称事前冻结。当前完整 verify 运行期间继续禁止修改其已冻结源码。

## 2026-10-22：启动重复认证修复与真实远程安装任务

历史完整 verify 的 root-state 失败栈 `context-recovery-storage.js:193` 实际对应 open 尚未 ready 的期限，而不是 execute 请求期限；该文件摘要与历史冻结一致。历史失败是否发生在第二次 open 仍为推断，不将总耗时当作阶段采样。进一步真实 SQLite/cipher 计数回归先复现 5 行认证 8 次；启动原先先做 liveUsage、再 prune，存活行重复解密/语义解析。

现改为同一启动事务先完成全部行认证，再用已有密文与完整 AAD 的小型 tag/version 凭据进行容量准入，之后才删除过期数据。没有跨事务或明文缓存，篡改、超限和失败仍回滚。新增 4/4 与原 storage/service/blobs 三文件 118/118 通过。原四根/32 MiB 带覆盖率单项退出 0，测试命令约 105.02s；两次 open 分别在 1668ms、8932ms ready，第二次 database_opened→engine_ready 为 7172ms。期限和负载未改；此次独立通过不能关闭完整套件超时，也没有受控前后性能结论。证据为 `storage-startup-admission-local-v1-receipt.json`、`storage-startup-admission-root32-v1.log`、`storage-startup-admission-progress-v1.json`。

独立安装验收已从只写脚本推进到真实远程执行。干净 managed worktree 以 HEAD 基线仅加入 9 个验收文件，独立 npm ci 后，测试、Lint、格式及 CI 治理通过，提交为 `d074b385f575dd61b8a94c0d33f29f555154c72e`，分支为 `acceptance/windows-lifecycle-20261022`。保留 workflow_dispatch，增加 required-baseline 的 workflow_call 与仅响应该分支的 push wrapper，解决默认 master 尚无新工作流时不能手动触发的问题。默认分支、签名发布流程和日常安装均未改。

[真实 Windows 安装任务](https://github.com/cbhandsun/https-proxy/actions/runs/39761611237)已启动并进入 baseline build；[原 Verify](https://github.com/cbhandsun/https-proxy/actions/runs/39761611113)同时自动触发。这里的两个产品快照是 HEAD 基线及只增加验收代码的提交，因此只验收该基线安装机制，不包含主工作区尚未提交的恢复增强和新资源修复，不能作为当前恢复候选的安装资格。后续真实终态另记，不把启动当通过。

该分支原 Verify 已返回失败：node-quality 的 npm audit 报旧 MCP SDK/Vite 两项 high，Rust stable clippy 因 `AtomicUsize::fetch_update` 弃用且 `-D warnings` 失败，单元分片包含 HEAD 缺失 `scripts/lib/installed-evidence-acceptance-runtime.js` 的失败。没有把这些基线问题修饰为 9 文件验收代码通过全仓门禁。主工作区 MCP/Vite 已为 `^1.32.1`/`^6.4.5`，仍需其自身门禁；Rust 兼容修复待当前冻结验证结束后应用，不关闭警告、不直接引入超出声明 MSRV 1.77.2 的新 API。独立生命周期任务仍在运行，安装结果待定。

Gemini 原 token-count 路由文件独立重跑仍出现 15s startup/no_stdout 失败；另一次固定模块加载探针执行通过，未得到足以支持产品修改的根因，原失败保留。原主工作区 1610 路径重新冻结，字面 `npm run verify` 已启动，日志为 `current-startup-full-verify-v1.log`，终态待记录；不沿用旧 663/670 冒充当前结论。当前 GUI/NSIS/portable 产物仍绑定上一个构建快照，不包含本段启动修复。容量、完整资格和生产启用继续未完成。

## 2026-10-22：实际 NSIS 构建与无本地 VM 的验收路径

实际 Tauri 资源映射同样遗漏 gateway scripts 与锁文件，已补齐并加入按真实映射投影安装目录的回归；修改前按预期失败，修复后 gateway/入口 7/7 通过。标准 `build-tauri-release.js` 已退出 0，完成前端、运行时准备、Rust 和 NSIS 构建。846 路径构建冻结在构建后复核一致；后续新增独立 CI 文件不扩展该冻结范围。日志为 `tauri-current-candidate-build-v1.log`。

真实安装包 `dist/artifacts/installers/HTTPS Proxy Manager_0.1.0_x64-setup.exe` 的 SHA256 为 `e7dc2ec976df82c2679eb45b336312253caec2f7cf8e7629cc4940e147b85ce6`。仅解包、不执行安装器，完整运行闭包及 625 份源码摘要校验通过。初次要求打包前后 EXE 完全同 hash 的诊断失败保留；查明 Tauri 将唯一 bundle marker 从 UNK 改成 NSS 后，第二版仅还原该 marker 并逐字节核对其余全部内容，验证通过。证据为 `current-nsis-extraction-v2.json`，不能据此声称安装、升级或回滚通过。

当前 raw GUI 与完整运行闭包已用实际 `build-portable.ps1 -SkipBuild -NoZip` 组装，终态退出 0；标准运行时刷新与发行目录检查通过。输出为 `dist/staging/portable/context-current-20261022/HTTPS Proxy Manager Portable`，没有生成新 ZIP。旧 ZIP 和校验文件已在 evidence 的 `previous-portable-artifacts-v1/` 保留。日常 GUI 具有全局 single-instance，故未启动候选 GUI，不宣称本地隔离 GUI 验收。

用户没有隔离 Windows 环境，替代路线见[独立安装生命周期验收](windows-installer-lifecycle.md)：新增手动触发的 GitHub 托管 Windows 工作流，以两个明确提交和仅版本 overlay 构建，在临时 runner 验证安装、升级、回滚、卸载与固定合成文件字节保留。本地只执行 AST、路径防护和模拟流程测试，不执行安装器；远程工作流尚未触发。需先整理可审查、无无关修改的源提交，并确认 workflow_dispatch 可用的分支条件。现有签名发布门禁保留，合成文件不代表真实用户迁移、加密恢复或 24 小时容量资格。

容量原五档、两 worker、无 CPU profiler 的原 60s 单项仍以 ETIMEDOUT 失败，证据为 `parallel-capacity-original-deadline-v1.log`。本轮没有重跑当前完整 verify、真实模型请求或重启生产/日常 GUI。容量、完整门禁、真实安装生命周期、迁移、成本资源与生产启用继续未完成。

## 2026-10-22：并行收敛存储、容量与便携包阻塞

存储 worker 的整包准入已经获得独立、受限的数据副本，原路径随后重复进行整请求归一化。本轮复用该副本进行原语义校验，并保留请求自身字节上限、深度与节点限制、冻结、跨线程重新验证和私有 WeakSet 身份。非法请求仍按原行为以有效消息 ID 负回复；非法 ID、关闭和终止行为另有实际 worker 回归。新增专项 4/4，完整 storage/service 两文件 65/65，原四根/32 MiB 覆盖率单项 1/1，均退出 0；原 180s 测试期限、30s 存储期限及负载未改。单项耗时 98.85s，不据不同主机负载下的历史耗时宣称受控性能提升。证据为 `storage-worker-fusion-v2-receipt.json`；完整套件中的存储超时尚未关闭。

容量原五档、两 worker 的当前 CPU 采样功能全部通过，但诊断耗时 92.66s，仍不符合原 60s 期限。主要成本为完整历史归一化和精确指纹。严格单工具调用形态的候选通过 584 项差分，但微对照无收益，产品改动已撤回；保留两项契约回归，完整 binding 文件 48/48 通过。证据为 `capacity-parallel-investigation-v1-receipt.json`。没有降低负载、移除校验、调整期限或将 CPU 采样结果冒充容量门禁。

插件包删除后继续精确服务的原用例在无覆盖率和独立覆盖率环境分别通过，主要耗时位于完整构建；未复现整套测试的 60s 超时，原失败仍保留。天玺原 HTTP 失败用例独立诊断通过；固定文件操作计时记录 596 次 lstat，不能将其直接相加当作端到端耗时，也未因观察结果省略祖先身份校验。

便携包混用工作区源码与 staging 依赖、遗漏 gateway scripts/锁文件的缺陷已修复。新的独立模块校验全部源码、Node、原生辅助程序、锁文件和 gateway 清单，复制完整 staging 运行闭包并前后复查，拒绝篡改、链接、路径重叠、复制失败和输入变化。最新文件系统、发布治理与入口测试 37/37 通过；格式、Lint、语法、PowerShell AST 和 CI 治理通过，新测试由统一入口发现。首次刷新会话句柄缺失且没有 manifest，确认进程不存在后保留原日志，第二次标准刷新终态退出 0。625 份发布源码与工作区及 staging 清单一致，当前真实运行闭包的隔离复制和校验通过，临时输出已删除。证据为 `parallel-portable-stage-copy-v1-outcome.json`。本阶段未构建或执行当前 GUI EXE，旧 EXE 或 `-SkipBuild` 不能证明当前完整便携程序资格；NSIS 安装、升级和回滚仍需隔离 Windows 环境，不在当前用户安装上冒充验收。

本阶段未重跑完整 verify，上一冻结的 663/670 失败结果保留；其他并发工作区修改不回退。生产进程启动时间仍为 2026-10-19 05:50:12，本阶段没有生产重启、日常配置变更或真实模型请求。容量、完整门禁、安装升级迁移回滚与生产启用继续是交付阻塞，整体目标未完成。

## 2026-10-22：修复终止器失败后夹具遗留导致验证不退出

此前完整 verify 中，Windows 树终止器失败已报错，但其自建 launcher 和管道持有后代仍存活，使测试文件不能退出。本轮只修改该测试及专用夹具：正常终止仍由原终止器、原 5s 期限负责；失败后的测试清理由独立 IPC 通道及夹具寿命上限负责，launcher 通过自己持有的 ChildProcess 句柄终止后代。清理使用专用退出码 73，正常终止断言拒绝以该退出码通过，不能用兜底清理掩盖终止器失败。

新增回归验证强制终止失败仍以原安全错误拒绝、随后关闭实际管道与两个进程、重复清理、禁止清理后再启动、拒绝无关命令及 IPC 清理失败显式报错。回归保留在现有 `test/owned-fixture-command.test.js`，原统一单元入口仍发现 670 个文件。定向格式、语法、Lint、CI 治理通过；最终普通测试 10/10 通过。中间 v2 测试 8/9：原终止器再次失败，但测试在约 19.8s 内退出，新增清理回归通过，失败日志保留，没有人工清理进程；这验证了失败收尾，不代表 Windows 终止器稳定性已解决。

产品代理模块和原终止器实现均未修改，完整 verify 仍保留上一冻结的 663/670 失败；本轮未重跑整轮或声称其他门禁通过。辅助模块覆盖率首轮 0/0，仅代表 c8 默认排除测试目录，没有有效覆盖率证据；随后单独纳入这两个辅助模块的诊断为 10/10，通过语句/行 95.79%、分支 91.11%、函数 100%，未改变 CI 排除或阈值。工作区同时存在本轮未编辑的前端测试改动，保留并单独记录，不纳入本轮修复。整体、I5/H1、安装生命周期与生产启用仍未完成。

## 2026-10-22：诊断结束后出现前端测试入口漂移

存储诊断于 `2026-10-22T08:00:33Z` 完成并校验原 1507 路径摘要一致。随后封存补充回执时，发现本轮未编辑的 `scripts/run-frontend-tests.js` 摘要已改变（文件修改时间为本机 01:02:34），当前入口加入 `image-services` 测试。保留这项工作区修改，不恢复或覆盖。原冻结路径中仅此文件改变，其余已核对路径不变；此结论不代表重新发现并覆盖所有新文件。历史 verify、包内矩阵和存储诊断各自保留原冻结边界，不扩展为修改后当前工作区的完整验收。补充封存必须明确记录漂移，不能绕过原摘要失败继续声称“当前全部一致”。

## 2026-10-22：四根/32 MiB 独立诊断通过，未复现完整套件超时

原四根/32 MiB 测试在当前冻结源码、覆盖率及固定 worker 回调计时下独立通过，测试 134300.17ms，含覆盖率收尾的整命令 188189.10ms。四次 `save-reference-state` 回调墙钟为 5111/6315/8053/8741ms，线程 CPU 为 4625/5375/6734/7734ms；四次 `load` 为 4470/3405/3930/3740ms，线程 CPU 为 3749/3266/3578/3328ms。仅记录固定操作名和数字，没有修改 SQLite 日志模式、原期限、校验或测试负载，1507 份源码及诊断脚本摘要复核一致。

此次没有复现完整套件的存储期限失败，不能据单次通过关闭问题，也不能将全部失败归因于环境争用。worker 保存/加载回调合计约 43.8s，不能覆盖测试总耗时；夹具构建、调用方校验与序列化、传输等尚未进一步分解。两个 close 仅收到 start 指标，未采得 end，不能提供 close 耗时；进程终态和原测试断言通过另有证据。回执为 `reader-single-parse-storage-timing-v1-outcome.json`，指标为 `reader-single-parse-storage-timing-v1.json`。仍需完整门禁和原容量期限通过。

安全覆盖检查独立通过：语句/行 81.97%、分支 76.12%、函数 82.97%，日志 `reader-single-parse-security-coverage-v1.log`；完整 verify 仍为本冻结的 663/670、退出 1。新增真实请求 0，生产和日常配置未变，整体未完成。

## 2026-10-22：单次解析冻结的完整 verify 已终态失败，663/670

`reader-single-parse-source-freeze-v2.json` 的 1507 份源码摘要复核不变，原 `npm run verify` 会话 40781 已退出 1。全仓格式、4043 文件/8 worker 语法、Lint（0 错误、5 条警告）、CI/发行治理和原生辅助程序 7 项测试通过。四分片均执行完毕，670 个测试文件中 663 通过、7 失败；代理覆盖率语句/行 91.26%、分支 90.03%、函数 92.13%，不构成门禁通过。因命令链在 `test:coverage` 失败，安全覆盖检查及后续阶段没有随 verify 执行；安全覆盖检查随后单独执行，不能补记为整轮 verify 通过。

失败文件为容量负载、恢复 root-state、本地证据插件包、Gemini token-count 路由、天玺历史 HTTP、自建夹具命令及天玺 handler 七个文件。容量仍为原 60000ms 子进程期限触发 `ETIMEDOUT`（约 60126ms）；四根/32 MiB 加密 worker 测试约 164464ms 后由存储期限返回 `context_recovery_storage_unavailable`；其余失败保留原错误，不能统一归因。记录为 `reader-single-parse-verify-terminal-v1.json`，旧 668/670 不再作为本冻结的完整门禁结果。

自建夹具终止器失败后留下 launcher 和持有管道的后代，导致测试文件不退出。核对固定夹具命令、PID、创建时间和父子关系后，仅清理该次自建的两个进程，原测试失败保留，未重启验证。介入回执为 `reader-single-parse-owned-fixture-orphan-cleanup-v1.json`；这项收尾介入必须随完整结果一并披露，不能称为无介入运行。

接下来用原四根/32 MiB 用例做独立操作级诊断，记录固定操作名、墙钟和线程 CPU，保留原期限、负载、校验及 SQLite 日志模式。该诊断用于定位，不能替代完整资格。生产 PID 64716、日常配置及真实请求账本保持，本轮新增真实请求 0，整体继续进行。

## 2026-10-22：读取引用单次解析落地，当前包四组原生合成验收通过

读取结算此前先做通用 12 MiB 准入克隆，再由引用解析器完整归一化，导致同一输入重复克隆。本轮将读取专用准入合入共享解析器，一次归一化后仍完整校验语义；普通解析入口保持原行为。读取路径保留旧限制的交集：精确 v10 元数据 12 MiB，其余 2 MiB，描述符读取、深度、节点、校验和、根元数据、来源容量和发布校验保持。归一化后再次核对版本对应大小，拒绝 Proxy 在选择限制与克隆之间变更版本绕过限制。

新增三个统一 CI 回归覆盖重复归一化、空/非法/访问器/循环/原型/符号/深度/节点输入、2/12 MiB 精确边界及超出一字节、变更版本 Proxy。修复前预期失败日志保留，最终三个回归通过。实际最终代码在覆盖率环境下的六组交替局部基准中，墙钟中位数 789.60→737.10ms，CPU 781→719ms，约下降 6.6%/7.9%；仅代表 32 来源元数据结算，不能外推为完整请求、存储或容量期限达标。

当前冻结为 `reader-single-parse-source-freeze-v2.json`，绑定 1507 份源码。完整原始 `test:client:coverage` 已终态退出 1：1363 项中 1351 通过、6 失败、6 取消、零跳过；覆盖率语句/行 99.07%、分支 95.23%、函数 99.29%，不构成通过。失败涉及 gateway 启动、worker/加密库生命周期、WBIPC、来源捕获、容量、冷导入及 WebSocket 长历史等路径，不能归为同一个已确认根因。原期限、负载、worker、阈值及发现范围均未改动。

标准发行准备已刷新 staging，625 份发布源码与当前工作区及包内字节一致。包内 Node v22.22.3 加严格模块重定向执行两个完整存储/读取测试文件，87/87 通过，工作区代理模块回退为零。当前包 Codex/Claude 默认与增强四组原生合成任务全部通过，各三次压缩；默认零恢复准入，增强精确读回、独立公开生成且无私有工具泄漏，配置未变、客户端终态。上游合成响应分别为 13/6/18/8，脚本不同，不能直接比较成本。

证据为 `reader-single-parse-client-v2-result.json`、`reader-single-parse-staged-tests-v1.log`、`packaged-native-matrix-v2-outcome.json` 和本轮交付回执。仍使用隔离配置、注入入口认证/路由及合成上游，尚未证明 NSIS/便携包安装、日常多端生命周期或生产资格。本轮真实请求新增 0，累计 169/177，剩 Codex 专项 1 次、Claude 专项 7 次，不能混用。生产 PID 64716 与日常配置保持；统一 verify 另以当前源码运行记录，旧 668/670 不作为本轮结果，整体未完成。

## 2026-10-21：子树编码完整覆盖率对照结束，未建立稳定收益

此前仅有局部微基准的函数子树编码候选已完成原五档、两 worker 的正反顺序覆盖率对照。正向基线/候选墙钟 103316.13/106403.34ms，CPU 121142/126093ms；反向候选/基线墙钟 89001.62/105899.30ms，CPU 109344/121187ms。四次功能报告一致，但只有两个样本/实现，环境与顺序影响尚未排除，不能宣称稳定收益；四次均超过原 60000ms 期限。诊断观察包络 180000ms 不构成原期限资格。458 项有限归一化 JSON 编码/SHA 差分、缓存饱和、转义、额外字段及输入变化检查通过；不能替代完整协议与安全验收。候选不合入，原门禁失败保持。

回执为 `.hpm-acceptance/context-plugin-vault-20261021-01/function-subtree-capacity-v1-receipt.json`，含完整结果、候选、预加载器、运行脚本与差分检查摘要。会话 46830 已终态退出 0，代表诊断完成；没有修改产品、负载、期限、覆盖范围或 worker 数。新增真实请求 0，累计账本仍 169/177，生产与日常配置未变，整体仍未完成。

发行目标核对：当前 `src-tauri/tauri.conf.json` 配置为 `nsis` 与 `app`，便携包由 `scripts/build-portable.ps1` 构建；当前没有配置 MSI 目标。后续安装、升级、迁移与回滚资格按 NSIS/便携包验收。下文历史段落中的 MSI/portable 是旧泛称，不代表存在或已验证 MSI 产物。

## 2026-10-21：设置页补齐默认策略、恢复成本与留存权限说明

设置开关改为“精确上下文恢复增强（可选）”，明确新策略默认使用客户端原生压缩；内部恢复完成后独立公开生成会增加模型调用和等待。加密留存说明明确偏好独立保存，单开留存不会开启恢复或授予原文读取权限，期限以运行状态为准、已有记录不续期。两个输入通过 aria-describedby 关联说明。未修改代理行为、默认配置或运行状态的验收声明。

静态回归进入既有统一前端测试文件；前端 28/28 文件、前端覆盖率 8/8 文件和原阈值、架构检查与生产构建通过。覆盖率为语句/行 98.2%、分支 91.61%、函数 96.77%。构建仍提示单个 JS chunk 超过 500 kB；未调整阈值。定向格式检查通过；定向 Lint 无错误，既有两条 prefer-const 警告保留。首轮新测试的闭合标签换行匹配错误、随后旧测试的属性换行匹配错误均已修正，失败日志保留。此次为静态标记与构建验收，尚无屏幕阅读器、键盘或实际安装 UI 验收。

诊断候选均未合入：批量属性描述符覆盖率微基准墙钟 114.14→166.87ms；fast-null v1 归一化加前沿组合墙钟 9543.93→9737.14ms、CPU 8859.5→9640.5ms；fast-null v2 归一化墙钟 110.69→120.09ms。后两者各 466 项有限差分一致并不构成完整资格，V8 快速属性诊断仅用于定位。未因无收益候选重跑完整容量负载。

回执为 `.hpm-acceptance/context-plugin-vault-20261021-01/recovery-settings-v1-receipt.json`。原 1507 文件冻结仅两个前端测试改变，HTML 单独绑定；此前原生与打包矩阵保持其原源码证据边界，不称为本轮完整复验。完整 verify 仍保留此前 668/670 终态，容量 60000ms 与 WBIPC 5000ms 失败未解决。真实请求仍 169/177，剩 Codex 专项 1 次、Claude 专项 7 次；未新增真实请求、修改日常配置或重启生产，整体未完成。

## 2026-10-21：包内两端默认/增强四组原生预演通过，指纹融合候选拒绝合入

在当前 staging 的 Node 与代理模块上执行 Codex CLI 0.160.1、Claude Code 2.1.292 默认/增强四组完整任务，四组全部通过，各完成三次原生压缩。默认恢复 admission/root/snapshot 均为 0；增强精确读回、独立公开生成及无私有工具泄漏通过，配置摘要不变、原生客户端终态。预加载器核对包内 Node 实际路径、将测试对工作区代理模块的引用映射至 staging，并在退出时验证没有加载工作区代理模块。全部 625 份发布源码及 1507 份产品冻结摘要一致。

本次仍使用临时客户端配置、注入的入口认证/路由和合成上游，响应数分别为 Codex 增强/默认 13/6、Claude 增强/默认 18/8。Claude 的普通 MCP 仅提供原始来源夹具。包内 Node/Core 组合已有证据，但不等于日常配置、NSIS/portable 安装、跨设备、完整真实模型或生产资格。回执为 `packaged-native-matrix-v1-outcome.json`；共享 gateway、来源夹具、预加载器与旧冻结摘要逐一复核，统一封存在 `packaged-matrix-and-fusion-rejection-v1-receipt.json`。

容量方向仅在诊断投影尝试标量指纹融合：描述符克隆时共享转义编码并计算精确指纹，避免前沿计算重复遍历。v1 因诊断代码的局部 `length` 遮蔽出现 ReferenceError，原文件保留，v2 修正后 466 项差分通过，覆盖编码预算、Unicode/转义、访问器零执行及修改后重验；这是有限差分，不是完整安全或协议资格。组合局部覆盖率基准墙钟 10988.03→10515.59ms、CPU 10609.5→9937.5ms，但完整原五档、两 worker 的正反顺序对照均变慢：基准/候选墙钟分别 92238.27/106761.63ms、110384.11/129294.38ms，CPU 分别 111547/122500ms、116812/144250ms，故拒绝合入。四次五档功能报告一致；180s 只是诊断观察包络，全部不能算原 60000ms 容量门禁通过。

对照期间只读主机快照显示总 CPU 90%、16 个逻辑处理器、约 42 GiB 可用物理内存；未取得进程负载归属，不能据此证明具体超时根因。没有调整负载、worker、期限、阈值或产品源码。真实请求新增 0，累计 169/177；完整 verify 仍为 668/670，生产未动，整体继续进行。

## 2026-10-21：当前冻结候选运行包刷新，包内 Node 回归 136/136

刷新前确认 `dist/staging/runtime` 在当前工作区内且无进程使用该目录；原 staging 中的 `context-recovery-state-data.js` 摘要落后于当前缓存分层修复。标准 `scripts/prepare-release-runtime.js` 已退出 0，重新准备原生辅助程序、包内 Node 和八个直接运行依赖，安装 116 个包；未生成或安装 MSI/portable，也未动生产进程。

新 manifest 的 625 个发布源码摘要逐一与工作区及 staging 实际字节一致，包内 Node 与当前执行 Node 摘要一致，版本 v22.22.3，原生辅助程序摘要校验通过。随后使用包内 Node 运行既有 root-state、history-map、binding 三个完整测试文件，136/136 通过，零失败、取消和跳过，总计 104761.57ms。预加载器将测试对工作区代理模块的引用重定向至 staging，三个文件均有实际重定向，退出时工作区代理模块加载数为 0；测试本身仍来自工作区，不能称为已安装客户端或完全独立安装包验收。

全部 1507 个冻结产品源码摘要复核不变；回执 `current-freeze-staging-v1-receipt.json` 绑定准备日志、包内测试日志、预加载器和 manifest。当前完整 verify 仍为 668/670，WBIPC 和覆盖率容量超时不改判；日常配置、真实请求账本和生产保持，整体继续进行。

## 2026-10-21：Codex 同输入合成成本对照完成，真实费用仍未测量

使用同一验收脚本、Codex CLI 0.160.1、实际 Core handler、相同开发者指令与用户问题、10106 字节原始工具输出、三次原生压缩，分别运行默认与增强四轮交替样本，共八次完整任务均通过。所有样本原文 SHA256 一致；默认恢复 admission/root/snapshot 为 0，增强精确读取与独立公开生成、两种模式原始工具仅执行一次、无私有工具泄漏、客户端进程终态及日常配置摘要不变均通过。合成上游在增强模式强制执行精确恢复，两种模式的最终答案均由脚本预置，不能证明真实模型回答质量。

| 指标 | 默认（4 样本） | 增强（4 样本） |
| --- | --- | --- |
| 每任务合成上游响应 | 均为 6 | 均为 13 |
| 整任务墙钟 p50 / p95 | 1781.28 / 2253.41 ms | 2413.71 / 2714.85 ms |
| 首个上游请求到达 p50 | 1502.07 ms | 1779.75 ms |
| Node CPU p50 | 594 ms | 1250 ms |
| 采样 Node RSS 最大值 | 83988480 字节 | 96591872 字节 |
| 每任务上游请求 / 响应字节 | 135217 / 18585 | 339003 / 37833 |

墙钟包含原生 CLI；CPU/RSS 只覆盖 Node Core 验收宿主，不包含原生 CLI。RSS 为 10ms 采样，可能遗漏峰值；四样本的最近秩 p95 等于最大值，不是稳定长尾估计。首个上游请求到达不是用户首字节；合成 usage 不是实际 token，更不是费用。宿主在两种模式均预先构造 sessions，不能据此证明默认冷启动完全不实例化恢复模块；未测持久库磁盘量。关闭回调尚可能排队，资源快照也不能证明句柄泄漏或无泄漏。

v1 验收脚本错误地进入真实请求禁止分支，在一个合成响应后安全失败；失败结果保留。v2 明确只派发至合成上游，八任务通过，新增真实请求 0，账本仍 169/177。回执 `codex-controlled-cost-v2-receipt.json` 绑定样本、脚本、夹具及全部 1507 个产品冻结摘要；整体完整 verify 仍未通过，未激活生产。

另一次参数对象专用克隆只在诊断投影验证，10 项有限差分一致，局部覆盖率基准墙钟 144.30→143.16ms，但 CPU 133.5→140.5ms，未建立收益而拒绝合入。`history-function-record-covered-micro-v1.json` 不是完整安全或容量资格。

## 2026-10-21：当前源码两端默认与增强四组原生预演通过

已落盘 `native-current-matrix-v1-outcome.json`：Codex CLI 0.160.1 与 Claude Code 2.1.292 分别完成默认、增强模式，四组均经过真实原生客户端和实际 Core handler，各三次原生压缩，1507 个产品源码摘要与验收脚本摘要复核一致。全部使用合成上游，本批新增真实模型请求 0。增强模式精确私有读取、独立公开生成及无私有工具泄漏通过；默认模式恢复 admission、root、snapshot 均为 0，保持原生压缩。四组上游响应分别为 13、6、18、8 次，但脚本和最终问题不同，不能据此比较真实成本。

Codex 两组进一步使用 Core 内实际 `createAuthResolver` 只读解析当前官方凭据，并验证文件保护及恢复凭据资格；构造出的真实认证头在发往回环合成上游前全部替换，回环检查未收到真实 token。这补齐只读凭据解析路径证据，不能证明服务端凭据有效性或同一任务中真实模型与此凭据路径的完整组合。四组仍注入入口认证和路由，使用临时客户端配置，不能扩展为日常安装、跨设备或生产验收。恢复本身未安装 HPM 插件；Claude 的普通 MCP 仅提供原始来源夹具。

Claude 默认 v8 的失败保留：合成上游对 `stream:true` 返回 JSON，引发原生 SDK 非流式回退，摘要请求从 3 变为 6。v9 仅修正验收上游按协议返回 SSE，保留原三次摘要断言，并增加全部 8 次请求为流式、没有回退的校验，最终通过；不是产品修复。完整 verify 仍为 668/670，两个超时失败没有改判。真实账本保持 169/177，剩余 Codex 专项 1 次、Claude 专项 7 次，不能混用；日常配置和生产未变，整体未完成。

另两个仅诊断的性能候选未合入：函数子树编码缓存在局部覆盖率微基准墙钟 247.85→237.81ms，尚无完整负载收益；小前沿一次性 SHA 候选变慢，墙钟 4734.10→5033.46ms、CPU 4601.5→4687.5ms，拒绝采用。相关回执为 `function-subtree-covered-micro-v1.json`、`small-frontier-hash-covered-micro-v1.json`，均不能作为容量资格。

随后仅在诊断投影中尝试复用指纹函数当次产生的小消息编码，避免前沿缓存未命中时重复序列化；不跨请求保留原文。24 项差分检查一致，但四轮交替覆盖率微基准墙钟 4516.41→4854.00ms、CPU 4445→4586.5ms，拒绝采用，没有进入产品源码或启动完整容量对照。此 24 项检查仅含三种 protocol 标签下同一 Chat 形状的历史与长度变化，不是三种协议的语义验收。证据为 `frontier-encoding-capture-covered-micro-v1.json`；产品冻结版本保持。

## 2026-10-21：当前完整 verify 终态，668/670 文件通过

缓存分层修复后的完整 `npm run verify` 会话 14146 已终态退出 1。原四分片全部结束，168/168/167/167 文件分别失败 0/0/1/1，共 670 文件中 668 通过；仅 `client-context-target.test.js` 的 chat WBIPC 持久化恢复第二轮请求超过原 5000ms，以及 `context-recovery-capacity-workload.test.js` 的资格命令超过原 60000ms。所有负载、断言、期限和阈值保持。代理覆盖率为语句/行 91.25%、分支 90.03%、函数 92.12%；独立运行原安全覆盖率检查通过（81.97%/76.12%/82.97%）。后续 verify 阶段未执行，不累加此前源码的通过结果。

1507 个冻结源码摘要全部一致，终态回执为 `tiered-state-cache-verify-terminal-v1.json`。WBIPC 原失败用例随后在相同 c8 覆盖率采集下单独运行通过，17 类模式保持、原 5000ms 请求期限保持，总计 11097.676ms；第二轮私有读取耗时由完整运行中的 1721ms 到此次 352ms。该结果说明存在明显的并行负载差异，不追溯改判完整失败或宣称根因已修复。原容量文件独立带覆盖率运行仍为 9/10 通过，唯一失败仍是原 60000ms 子进程超时，总耗时 65675.3753ms；因此不能将容量超时全部归因于四分片竞争。

随后对原五档、两 worker 命令进行 c8 加 CPU 剖析，诊断观察包络为 180s，不能替代原期限：五档功能报告通过，主进程墙钟 58216.09ms、CPU 85422ms，余量仍不足以宣称稳定。三个线程的剖析将主要开销定位至历史校验约 17445ms、前沿计算约 21228ms，其中消息指纹约 16586ms；为跨线程累计采样并含重叠调用，不能直接相加或当作请求延迟。减少通用标量叶子递归的第二个诊断候选在 c8 微基准也变慢（158.97→172.42ms，CPU 156.5→171.5ms），拒绝采用。缩小规模的纯缓存机制观察中，单/四 root 均无缓存驱逐，四 root 前沿命中 33040/39244 项，未支持“4 槽容量抖动”假设；这是定位用观察，不是容量资格。

状态解析标量消息快路径仅在诊断投影实现，244 项差分检查一致，但交替微基准墙钟中位数 56.89→61.14ms，CPU 62→62.5ms，未建立收益，拒绝采用，不启动无收益候选的完整容量对照。产品未改变，未增加真实请求，未动日常配置和生产。证据位于 `.hpm-acceptance/context-plugin-vault-20261021-01/`：`isolated-wbipc-covered-v1.log`、`isolated-capacity-covered-v1.log`、`capacity-covered-profile-v1/summary.json`、`capacity-covered-profile-v1/lines.json`、`frontier-cache-observation-v1.json`、`state-scalar-differential-v1.json`、`state-scalar-micro-v1.json`、`inline-history-scalars-covered-micro-v1.json`。

## 2026-10-21：当前源码 Codex 完整 Core 隔离全真实验收通过

当前 1507 文件冻结版本经 v4/v5 官方桥接零真实请求预演，各以 13 次合成调用完成三次压缩、精确读回和独立公开生成。v4 首轮真实运行在桥接未传 AbortSignal 时失败，保守扣记 1 次；失败回执保留。仅修正隔离验收脚本传参后的 v5 完整真实任务通过：14 次真实请求、三次原生压缩、原始工具一次、精确私有读回、公开请求携带完整授权原文、独立生成答案精确一致、上游全部 200、无私有工具泄漏、配置未变且进程终态。产品源码和验收脚本哈希复核一致。

本次 Core 入口认证和路由由隔离 fixture 注入，官方凭据绑定在出口桥接完成；不能扩展为 Core 自身官方凭据解析、日常安装、跨设备或生产启用证明。Claude 完整 Core 全真实结果仍属于此前源码快照；本次没有重新调用 Claude。专项授权 16 次已保守计用 15 次，剩 1 次；原有 7 次仍专留 Claude，累计账本为 169/177，不自动重试。

当前完整 `npm run verify` 会话 14146 仍运行：格式、4022 文件语法、Lint、CI/发布治理及原生恢复检查已通过，进入原四分片单元覆盖率。已有 `client-context-target.test.js` 的 chat WBIPC 撤权用例请求超时失败，须保留完整运行并继续定位，不能宣称完整门禁通过。此前缓存分层修复的原容量文件独立运行 10/10 通过，原 60000ms 时限、五档负载和两 worker 保持；该结果不改判完整门禁。

回执：`.hpm-acceptance/context-plugin-vault-20261021-01/codex-core-complete-v5-outcome.json`，真实及预演脚本、失败、授权和源码冻结均绑定 SHA256。整体仍 active；生产未重启，日常配置未改。

## 2026-10-21：修复状态字节计数缓存饥饿，开始原期限验证

重开状态的解析先遍历短标识和摘要；旧的请求内字节计数 memo 前 128 个槽可能因此耗尽，后续反复出现的大段原文无法复用计数。将 memo 分为短/大字符串两个 64 槽层，共享原 4 MiB raw-text 上限，总条目上限仍为 128，生命周期仍限一次解析。输入校验、转义字节计算、总预算、深度、节点、来源权限和状态语义均保留。

新的统一 CI 回归先在旧实现失败，修复后通过，验证短标识后重复原文的扫描有界、跨解析重新计数、少一字节仍拒绝、超过缓存字节额度的大值不继续累积。定向诊断中一次解析的大原文计数次数从 256 降为 1；原状态及历史映射投影回归 88/88，通过。原五档、两 worker 正反顺序完整对照报告一致：基准/候选墙钟分别 53116.16/50533.47ms、59834.04/58441.65ms，CPU 分别 71453/70251ms、79859/75515ms。此为 180s 诊断观察，不代替原 60000ms 门禁。

本轮产品改动仅 `context-recovery-state-data.js` 与既有统一测试 `context-recovery-root-state.test.js`，1507 文件冻结中仅此两文件摘要变化。定向格式、Lint 和新增两项回归通过；原容量文件完整运行正在进行，修复后完整门禁尚待执行。真实额度、日常配置及生产不变。证据：`state-size-cache-starvation-v1.json`、`tiered-state-cache-capacity-v1.json`、`tiered-state-cache-regression-before-v1.log`、`tiered-state-cache-regression-after-v1.log`、`tiered-state-cache-source-freeze-v1.json`。

## 2026-10-21：完整 verify 已终态，670 文件仅容量命令失败

同一 1507 文件冻结版本的完整 `npm run verify` 已终态退出 1。原四个 unit 分片全部结束，670 文件中 669 通过，唯一失败文件为 `context-recovery-capacity-workload.test.js`，失败用例是资格命令的原 60000ms 时限；未改变五档负载、两 worker、期限、断言或覆盖率阈值。代理覆盖率语句/行 91.25%、分支 90.02%、函数 92.12%，冻结源码和测试摘要全部一致。先行格式、语法、Lint、CI/发布治理、原生恢复 Rust 7/7 已通过。`verify` 在 `test:coverage` 的 unit 非零结果停止，后续客户端、前端、集成、构建及完整 Rust 门禁未由本次执行。随后单独执行安全覆盖率检查通过：语句/行 81.97%、分支 76.12%、函数 82.97%；该检查不改变完整门禁失败。

后续八项门禁按独立命令全部执行终态：前端覆盖率、前端测试、thinking、环境、集成、前端构建、完整 Rust 测试均退出 0；hooks 退出 1，第二项用例在临时目录清理时出现 AggregateError，主失败与清理失败需继续分开诊断。独立通过不改判完整 verify，当前还存在容量和 hooks 两项失败。回执为 `independent-remaining-gates-v1-result.json`，各阶段完整日志分别保留。

hooks 随后在原期限下单独运行，通过 2/2。只记录固定边界字段的诊断观察到合法/非法两次命令分别约 14.0s/13.4s，退出码 0/1，无执行失败，清理成功；该次没有重现先前的目录清理错误，不能据此确认其根因或追溯改判。完整 Rust 为主库 15 项、辅助程序 1 项通过，doc-tests 为 0 项。全部本地工作后，1507 文件冻结摘要仍一致，真实请求仍为 154/161、生产 PID 64716 启动时间仍为 2026-10-19 05:50:12，未重启。

并排插件迁移 v1 在源包核验阶段失败，尚未执行任何安装：旧证据引用的日常缓存 0.1.0 已不存在，日常缓存目录当前只有 0.1.1。v2 重新核验此前独立 vault 中含诊断 launcher 元数据的旧包，使用两个 marketplace 身份，完成活动旧会话下安装、选择新身份、新建新版会话、选择旧身份和新建回滚会话；旧/新活动原文、原到期、跨线程拒绝、两个缓存完整及终态均通过。此项为显式受信宿主捕获，不含自动 Hook，候选流程尚未接入日常安装器。保留 v1 失败，未改日常配置或生产。

Codex 新完整 Core 脚本 v2 合成验收及 v3 官方桥接零网络预演分别通过；v3 同时执行官方凭据绑定与请求规范化，再用合成响应完成三次压缩和独立公开生成，共 13 次合成响应、0 次真实请求，配置摘要不变、无私有工具泄漏。其 Core 入口授权和路由仍由隔离 fixture 注入，官方认证发生在桥接出口，不能声称验证了 Core 本身的官方凭据解析路径。完整 Core 真实 Codex 复验尚待专项请求授权；现有账本 154/161，余 7 次仅限 Claude。

新增请求内编码复用候选仅存在于诊断投影，46 项绑定回归通过。规范化加 frontier 微基准墙钟中位数 28.50→25.66ms，CPU 31→32ms；原五档、两 worker 完整负载单顺序对照中，基准墙钟 58311.83ms、CPU 78609ms，候选墙钟 59463.41ms、CPU 80578ms，报告完全一致但未建立性能收益，拒绝合入。该对照采用 180s 诊断观察窗口，不替代原 60000ms 命令门禁；产品源码及统一测试均未改变。结果为 `shared-request-capacity-v1.json`，保留候选、微基准、投影回归及完整对照日志。

证据：`native-core-complete-followup-verify-v1.log`、`followup-verify-terminal-v1.json`、`plugin-side-by-side-v1-result.json`、`plugin-side-by-side-v2-result.json`、`codex-native-core-complete-v3-preflight-result.json`。

## 2026-10-21：安装版冷升级与回滚通过，完整 verify 正在运行

使用当前实际 codex-cli 0.160.1，在新建隔离用户目录中安装日常缓存的真实 0.1.1 闭包包、切换到当前源码构建的 0.1.1 自包含包，再从独立 vault 恢复原闭包包。三轮均由原生 app-server 启动插件，暴露目录和读取两个工具；通过受信宿主适配器显式捕获合成原文后，精确读取正确、来源有原到期字段，三轮进程均终态。包完整性分别核对安装后的实际字节摘要；旧包 3691 文件、17409683 字节，新包 10 文件、1956936 字节，版本号相同而包摘要不同。全部安装/卸载/marketplace 命令退出 0，保留原 60000ms 安装期限。日常配置、项目配置和代理配置摘要均未变化，模型请求新增 0，累计 154/161。

这是每次切换前结束隔离 app-server 的冷替换及回滚证明，不能扩展为旧活动进程下的热迁移、跨重启原文保留、原文 TTL 连续性或自动 Hook 执行证明。三轮来源属于各自新建的内存会话，未迁移旧插件内存原文。此前旧版活动回滚被原生安装器拒绝的结果继续保留。

容量方向另验证单次标量工具调用消息的原生 canonical 序列化候选：逐项 SHA256 一致，六轮交替局部墙钟中位数 127.38→120.50ms、CPU 125→117ms；但原五档、两 worker 完整负载基准 71232.24ms、候选 85735.60ms，CPU 83765→97094ms，故未合入。180s 观察包络仅用于取得完整诊断报告，不替代原 60000ms 门禁。产品源码和测试仍与 1507 文件冻结摘要完全一致。

字面 npm run verify 已启动；目前全仓格式、3992 个 JavaScript 文件语法、Lint、CI/发布治理及原生恢复 7 项测试通过，已经进入原四分片完整 unit 覆盖率阶段；后续门禁仍运行中，不能宣称完整 verify 通过。当前 exec 会话 11008，日志 native-core-complete-followup-verify-v1.log；继续工作时先观察同一活进程，不因观察超时另起整套。此前完整客户端容量失败和完整 unit 旧运行失败不改判。Codex 实际 Core 的完整真实模型组合仍缺证据：现有完整真实任务是隔离 owner 路径，Core 组合为合成模型；Claude Core 全真实通过保持。

证据目录 .hpm-acceptance/context-plugin-vault-20261021-01/：native-installed-migration-v1-result.json、native-installed-and-capacity-followup-outcome.json、native-tool-call-candidate-rejected-outcome.json。整体 active；仍需容量期限、完整门禁、热迁移/实际宿主组合、Codex Core 全真实及受控生产启用。

## 2026-10-21：Claude 完整 Core 全真实三次压缩验收通过

同一完整任务脚本在真实模型下退出 0：17 次真实请求、三次原生客户端压缩、原始 MCP 工具仅执行一次、精确目录与原文读回、独立公开生成、最终答案完全一致；privateWireLeak=false、fullCoreEntrypointVerified=true、configurationUnchanged=true、processTerminal=true，全部上游响应为 200。实际 Core handler 使用隔离注入的入口认证和路由，模型、凭据复用现有配置；不把此验收扩展为日常客户端安装、跨设备迁移或生产启用。真实请求账本从 137/161 到 154/161，剩余 7 次，没有自动重试。

真实任务结束后，1507 个产品源码和测试冻结摘要全部一致，三份验收脚本摘要也与启动前冻结一致。统一回执 claude-core-complete-v6-outcome.json 绑定真实与合成结果、脚本冻结和额度授权的 SHA256，passed=true；生产 PID 64716 的启动时间仍为 2026-10-19 05:50:12.6601782 -07:00，未重启。

上一轮完整 unit 的五个失败文件单独隔离排查：codex-responses-routes、installer-process-cleanup、tianxi-sdk-history-http、tianxi-client-read-options 四文件通过；tianxi-sdk-handler 为 106 项中 105 通过、1 失败，失败是 receipt 已提交后历史保存失败用例的原 5000ms HTTP 请求超时。同一用例随后独立运行通过；没有提高期限、修改断言或改判原完整文件失败。该结果表明仍有完整文件运行下的期限问题，不能宣称全量绿色。原完整 unit、完整客户端容量 60000ms 失败和完整 verify 未通过的状态保留。

证据目录 .hpm-acceptance/context-plugin-vault-20261021-01/：claude-native-core-complete-real-v6-result.json、claude-core-complete-v6-outcome.json、isolated-prior-unit-failures-v1-result.json 和 history-save-after-receipt-isolated-v1.log。当前仍需容量优化、完整门禁、日常插件迁移与生产启用，整体 active。

## 2026-10-21：完整 Core 合成预演通过，两项 canonical 性能候选不合入

沿用当前 1507 文件冻结源码，重新组装 Claude 原生客户端 → 实际 Core handler → 恢复会话 → 上游的完整任务验收脚本。入口认证和路由由隔离 fixture 注入，不修改日常客户端或生产配置。合成模型预演退出 0：三次客户端压缩、原始 MCP 工具仅执行一次、目录与精确读回、独立公开生成、最终答案完全一致，私有工具 wire 检查无泄漏，进程终态与清理通过，完整 Core 标记为 true。共 18 次合成上游响应、0 次真实请求；这不是完整 Core 的真实模型验收。依据用户追加 17 次的明确授权，累计真实请求上限从 144 调整至 161；启动时已用 137，本轮最多 24，复用现有凭据、不自动重试、不改日常配置。真实任务正在执行，终态另记。

此前探索的两个 canonical 候选均未进入产品源码。小键排序网络的局部墙钟中位数 182.49→173.89ms，但 CPU 164.5→195.5ms，拒绝；标量 role/content 指纹缓存虽在微基准改善，原五档、两 worker 完整负载顺序比较仅 53103.67→52097.17ms，反向比较候选 83607.41ms、基准 78753.95ms，CPU 也变差，未建立稳定完整负载收益。诊断允许 180s 观察以取得完整报告，不能代替原 60000ms 容量门禁；不改变负载、阈值或期限。1507 个冻结文件摘要复核无变化。

证据目录 .hpm-acceptance/context-plugin-vault-20261021-01/：claude-native-core-complete-synthetic-v6-result.json、claude-core-complete-real-v6-harness-freeze.json、budget-authorization-161.json 和 canonical-candidates-rejected-outcome.json。容量、完整 unit/verify、日常已安装插件迁移及生产启用仍未完成，整体 active。


## 2026-10-21：常量拆分候选完整客户端仅容量失败，插件缓存移除独立通过

当前冻结版本标准 `test:client:coverage` 已终态退出 1：1358 项中 1357 通过、1 失败、0 取消、0 跳过，主体 239442.9614ms；唯一失败是容量命令原 60000ms 期限。覆盖率语句/行 99.07%、分支 95.22%、函数 99.29%，保持原阈值。此前 Core 接续、WBIPC、ACL、存储重开和网关启动在本轮通过，但不能把跨轮变化全部归因于常量拆分。本轮开始前发布准备已经结束，没有上一轮准备与测试前段的重叠。

原容量用例另在不加覆盖率、不加 CPU 剖析、没有其他验收并行的条件下独立运行，仍在 60000ms 超时退出 1；因此不能仅以完整门禁并发解释容量失败。现有剖析的调用树按样本去重归集后，主要累计路径是绑定 frontier 计算约 21.8s、历史规范化约 15.4s、重开约 12.1s、导出约 8.2s；这些范围互有包含，不能相加为独立成本。进一步优化应针对这些路径，保持原五档、两 worker、负载和期限。

插件整包移除场景随后使用隔离环境独立运行原文件，10/10 通过、22931.3294ms，保持原 60000ms 用例期限；包括可丢弃整包移除后精确读取既有原文、继续捕获、不重置到期和拒绝外线程访问。这是临时包/缓存资格，不等于日常已安装插件迁移或生产启用，也不追溯改判旧完整 unit 的超时。

完整客户端及插件独立运行后，1507 个冻结源码/测试摘要再次全部一致；六个相关产品模块的源码与 staging SHA256 均一致。原源码回归、扩大回归 43/43、无钩子 Core 4/4、原期限容量失败、完整客户端和插件结果分别封存，统一回执 `wbipc-constant-boundaries-outcome.json` 绑定所有原日志和冻结摘要。生产 PID 64716 启动时间实时复核仍为 2026-10-19 05:50:12；真实请求仍 137/144、本批新增 0，日常配置未改。

当前新版本完整 670 文件 unit 尚未运行；上一版完整 unit 8 文件失败不能由本轮定向结果改判。完整 verify、容量期限、完整 Core 真实组合、日常插件迁移及生产启用仍待完成，整体 active。证据位于 `.hpm-acceptance/context-plugin-vault-20261021-01/`：`wbipc-constant-boundaries-client-full.log`、`wbipc-constant-boundaries-capacity-deadline-isolated.log`、`wbipc-constant-boundaries-plugin-removal-isolated.log`、`wbipc-constant-boundaries-outcome.json` 和 `capacity-current-digest-profile/callpaths.json`。

## 2026-10-21：拆开 WBIPC 常量与执行模块依赖，定向回归通过

独立同步边界诊断确认，恢复转换入口首次遇到 WBIPC 分支时，入口只为读取工具发现标识导入完整 catalog，派发只为读取两个默认限制导入完整旧规划器；不合资格请求也会同步加载这些执行依赖。将原常量移至 `context-tool-discovery-contract.js` 和 `workbuddy-context-limits.js`，原 catalog/规划器继续重导出相同字段和值；恢复入口/派发改用轻量模块。资格检查、请求和协议转换、限额、重试、授权与发布逻辑未改变，新增模块进入发布源码清单。

新增统一 unit 回归在旧实现下失败，修改后通过。五文件扩大回归 43/43，通过原入口/派发、转换、catalog 和规划器用例；定向格式、Lint、CI/发布治理和 diff 检查通过。冻结 lib/test/scripts 全部 JS/CJS/MJS/JSON 与包清单和 ESLint 配置，共 1507 文件；相较上一轮仅四份既有产品模块、两份新常量模块、发布清单和回归文件改变。

六轮交替、每个样本独立子进程，在相同 Core 导入后触发同一不合资格 WBIPC 请求：新增模块数稳定 38→14，墙钟中位数约 173.47→78.31ms，CPU 中位数 172.5→78.5ms；planner/catalog 不再加载。四份旧源文件由投影还原后分别核对原冻结 SHA256 一致，未用近似旧实现比较。这是单次冷拒绝路径的局部诊断，不等于完整 Core 请求、吞吐或容量修复。

不带诊断钩子的原 Core 内存接续及 Chat/Responses/Claude WBIPC 用例 4/4 通过，37165.6576ms，均为合成模型。此前带钩子的两项存储失败受到诊断自身影响：Worker 共享 PID，按 PID 命名的出口文件碰撞导致 Worker 失败；该运行不能作为产品回归证据，日志保留，诊断命名已包含 threadId 与随机标识。发布 staging 刷新退出 0；当前容量原 60000ms 用例的独立诊断正在执行，当前版本完整客户端门禁仍待运行。真实请求仍 137/144、本批新增 0，生产未重启，日常配置未改，整体 active。

证据目录 `.hpm-acceptance/context-plugin-vault-20261021-01/`：`wbipc-constant-boundaries-before.log`、`wbipc-constant-boundaries-after.log`、`wbipc-constant-boundaries-expanded.log`、`wbipc-constant-boundaries-benchmark.json`、`wbipc-constant-boundaries-core-uninstrumented.log`、`wbipc-constant-boundaries-complete-source-freeze.json`、`wbipc-constant-boundaries-release-prepare.log`。

## 2026-10-21：当前完整客户端门禁退出 1，发布 staging 已刷新

DPAPI 冷却版本的标准 `test:client:coverage` 已终态退出 1：1357 项中 1346 通过、8 失败、3 超时取消、0 跳过，测试主体 285232.1659ms。覆盖率语句/行 98.86%、分支 95.23%、函数 99.21%，达到原阈值；1505 个冻结源码和测试摘要再次全部一致。失败及取消涉及 Core 自动接续和 WBIPC、API 证据夹具启动、原容量 60000ms、原生 ACL 独立校验、加密重开及源网关启动/清理期限，不能笼统归因或改判。

发布准备退出 0，staging 加密模块和源码 SHA256 一致。准备命令的末段与客户端门禁前段有时间重叠；保留这一诊断限制，未证明它导致失败，不用这一点抹去失败，也不把本次称为独立性能测量。回执为 `dpapi-probe-cooldown-client-terminal.json`，绑定实际统计、覆盖率、冻结复核和 staging 摘要；原日志、失败、诊断脚本各版本均保留。

本批新增真实请求 0，累计 137/144；Claude v25 隔离原生全真实新任务通过的原有证据保持，但完整 Core 入口验收仍未完成。生产 PID 64716 的启动时间实时复核仍为 2026-10-19 05:50:12，未重启，日常配置未改。完整 verify、原容量期限、系统/存储长尾、插件迁移和生产启用仍未完成，整体 active。后续应先逐项定位失败，冻结修复后再运行相应门禁，避免对相同源码反复整套重跑。

## 2026-10-21：当前完整代理门禁收尾，670 文件执行、8 文件失败

DPAPI 冷却版本的标准 `npm run test:coverage` 已终态退出 1。原四分片执行文件数分别为 168、168、167、167，失败数分别为 3、0、2、3；670 文件全部执行，662 文件通过、8 文件失败。1505 个冻结源码与测试摘要全部一致。覆盖率语句/行 91.25%、分支 90.02%、函数 92.12%，达到原阈值；后接安全检查因 `&&` 未执行，随后使用本轮覆盖率单独运行原检查退出 0，语句/行 81.97%、分支 76.12%、函数 82.97%。这不改变完整门禁失败结论。

最终失败文件为 `codex-responses-routes`、`context-recovery-capacity-workload`、`client-context-target`、`governance/installer-process-cleanup`、`local-evidence-plugin-package`、`tianxi-sdk-history-http`、`tianxi-client-read-options`、`tianxi-sdk-handler`。独立投影诊断在保持原测试逻辑的前提下向结构化输出断言前插入安全分类，仅失败时记录固定标签；第三版完整执行退出 0，没有复现本轮并发门禁中的路由 502，不能宣称已定位或修复。前两版诊断分别因插入位置不唯一和模板转义错误而未执行测试，脚本与日志均保留，不能计为产品失败或复现证据。

终态回执 `dpapi-probe-cooldown-terminal.json` 绑定分片、最终失败和全部冻结文件复核。日志 `dpapi-probe-cooldown-proxy-full.log`、`dpapi-probe-cooldown-security-coverage.log`、`codex-structured-output-response-diagnostic-v3.log` 位于 `.hpm-acceptance/context-plugin-vault-20261021-01/`。当前版本发布 staging 已刷新、准备命令退出 0，源码和 staging 的 `secret-crypto.js` SHA256 一致，准备日志为 `dpapi-probe-cooldown-release-prepare.log`；标准完整客户端门禁已启动，日志为 `dpapi-probe-cooldown-client-full.log`，尚未终态，不能计为通过。真实请求保持 137/144、本次新增 0；整体仍 active，未重启生产或修改日常客户端配置。

## 2026-10-21：DPAPI 失败探测加入可恢复冷却，完整代理门禁运行中

发现 `dpapiProbe` 仅缓存成功，失败后下一次字段加密会立即再次启动同步 PowerShell；同一批配置字段可反复等待同一种失败。现以单调时钟记录 30000ms 冷却，探测或实际 Protect 失败后，后续加密在冷却内继续使用既有 AES-v2 加密回退，到期重新进行完整 Protect/Unprotect 往返。再次失败会续设冷却；成功后清除旧失败原因。受保护密文的严格解密及原三次尝试独立执行，不被该加密探测冷却抑制。未增加配置字段或改变加密格式、主密钥、解密重试及日志输出。

新增三个统一 unit 回归，旧实现 12 项中 10 通过、2 失败；修复后与配置控制器合并 16/16 通过。覆盖冷却前后精确边界、失败续期、恢复成功、非法/空加密输入、已加密输入、缓存清理及冷却期间解密重试成功。隔离环境中的 probe、既有真实加密往返与配置迁移、配置控制器、启动凭据及运行时凭据共五文件均退出 0。当前定向格式、Lint、CI 和发布治理通过。

1505 文件清单相较上节仅 `lib/proxy/secret-crypto.js` 与 `test/secret-crypto-probe.test.js` 改变，已另存当前冻结。标准 `npm run test:coverage` 已启动，保留四分片、670 文件、原负载、期限、阈值及失败后继续执行行为；当前尚未终态，不能给出通过数或最终失败清单。日志已有 Codex Responses 路由 502、Core Responses WBIPC 和容量期限失败，均保持失败等待完整收尾，未停止或重启该次运行。完整客户端上节 1357 项结果早于本修复，发布 staging 也尚未刷新本次 crypto 修改；后续必须补齐，整体 active。

容量当前源码的完整 CPU 剖析按原五档、两 worker 执行，诊断约 76374ms，五档功能结果均通过，但诊断允许超过原 60000ms，不能计入期限资格。主要热点仍是规范化、指纹和重建。三个单独投影候选未进入产品：结构化 assistant 克隆快路径墙钟改善不足；循环 canonical 编码 CPU 中位数 125.5→148ms；ASCII 正则候选的两种负载均更慢。原候选、失败/比较证据保留。独立 ACL 原用例单跑约 3968ms 通过，不追溯改判并发超时或宣称已修复。

累计真实请求仍为 137/144，本批新增 0；生产 PID 64716 启动时间保持 2026-10-19 05:50:12，未重启，日常配置未改。未终止任何归属不明进程，初步进程调查没有形成足够证据支持清理。证据位于 `.hpm-acceptance/context-plugin-vault-20261021-01/`：`dpapi-probe-cooldown-before.log`、`dpapi-probe-cooldown-after.log`、`dpapi-probe-cooldown-expanded.log`、`dpapi-cooldown-isolated/`、`dpapi-probe-cooldown-complete-source-freeze.json`、仍在写入的 `dpapi-probe-cooldown-proxy-full.log`、`capacity-current-digest-profile/`、`native-acl-isolated-after-digests.log`，以及三个候选的 benchmark JSON/log。全量运行结束前不修改冻结中的源码和测试。

## 2026-10-21：内部重复探测复用不可变历史摘要，完整客户端仍有两项期限失败

异步 root loader 在输入规范化、结果校验和授权检查完成后，显式为本次不可变请求启用摘要复用，初次 probe、离线选择和后续 begin 可复用同一组逐项指纹。普通同步请求和未启用的规范化请求仍逐次完整计算；外部 frozen 数组、代理、原始对象和伪造标记不能获得复用资格。每个 frontier cache 最多额外保留四组、每组最多 4096 项的摘要，弱引用键不保留原文；清空、协议变更、淘汰和计算失败仍重新计算。所有 scope、连续性链、授权、TTL、存储与发布检查保留，摘要不授予恢复读取权限。

当前四文件扩大回归 91/91 通过，31940.0735ms；包括实际 loader 在授权后、首次 probe 前启用复用，未授权和非法结果不进入 probe，普通请求重复调用仍完整计算、四组淘汰、4096/4097 边界和失败不缓存。当前定向 Lint、格式、CI/发布治理及 diff 检查通过。实际 Core 的 Chat、Responses、Claude WBIPC 原负载与原期限定向测试 3/3 通过，40314.0448ms，均为合成模型，不是全真实 Core 验收。

八组 480 轮、每个工具结果 8192 字节的历史，六轮交替比较同一原始实现和当前候选；规范化不计入时间，完整 frontier 结果逐次比较一致。独立运行的重复探测墙钟中位数 572.63→340.36ms、CPU 499.50→367.00ms；普通新请求墙钟 510.63→488.05ms，但 CPU 485.00→507.50ms，未证明普通路径有稳定收益。该局部诊断不等于请求、吞吐、容量或生产性能保证。此前与回归并行运行的 v4 结果另存，不作为独立测量。

冻结 lib、test、scripts 下全部 JS/CJS/MJS/JSON 及包清单和 ESLint 配置，共 1505 文件，包含此前 65 文件清单遗漏的 `context-binding-frontiers.js`。原标准 `test:client:coverage` 终态退出 1：1357 项、1355 通过、2 失败、0 取消、0 跳过，测试主体 244900.8975ms；语句/行 99.07%、分支 95.22%、函数 99.29%，原阈值保留。失败为容量命令原 60000ms 期限和独立 PowerShell ACL 校验超时；本轮 Core 与加密 worker 重开用例通过，不将不同运行的波动直接归因为优化。结束后 1505 摘要复核一致。发布 staging 已按当前源码刷新，准备命令退出 0；三个产品模块的 staging 摘要核对一致。

Claude v25 全真实隔离原生任务的原回执再次核对：17 次真实请求、三次压缩、精确最终答案、无私有 wire 泄漏，passed 为 true，但 `fullCoreEntrypointVerified` 为 false。累计请求保持 137/144，本批新增 0。原 24h 样本真实到期拒读结果继续有效。最近完整 unit 仍为 670 文件、13 文件失败的旧运行，早于四份断言修正及本次优化，不能用本次定向结果改判。完整 verify、容量期限、系统调用/持久化长尾、日常插件迁移和生产启用仍未完成；整体 active。生产 PID 64716 启动时间 2026-10-19 05:50:12 未变，日常配置未改。

证据目录 `.hpm-acceptance/context-plugin-vault-20261021-01/`：`immutable-history-digests-expanded-v3.log`、`immutable-history-digests-benchmark-v5.json`、`immutable-history-digests-core-wbipc.log`、`immutable-history-digests-complete-source-freeze.json`、`immutable-history-digests-client-full.log`、`immutable-history-digests-release-prepare.log`。当前基准保留原始 frontier SHA256 `0bf9e2fcdcb4ad5a12efd98ed56401c3b318f0150ee798ae5a35e2d156c9fdd6` 的核对，所有失败和中间候选证据保留。

## 2026-10-21：原始 24 小时样本真实到期拒读通过，整体交付仍未完成

沿用最初于 `2026-10-21T00:55:55.109Z` 创建、绝对到期 `2026-10-22T00:55:55.109Z`
的同一加密留存样本，没有重播种、延长或重置。前八次观察保留原文与检查点摘要及原 expiresAt，最近一次到期前检查仍能精确读回。第九次在真实墙钟超过原期限后，重新打开原加密存储并加载同一 scope，返回 null；检查脚本退出 0，回执阶段更新为
`real-deadline-expiry-verified`。到期前回执与到期后回执另存副本，原记录字段和观察历史保留。

本项证明该单机、单合成样本经历原绝对期限的留存观察与到期拒读，不把它扩展为容量、全天活跃任务、多客户端或跨设备资格，也没有独立证明物理介质擦除。容量 60000ms、Core 请求及持久化重开期限等仍未全部通过。当前完整客户端门禁为 1351 项、1348 通过、2 失败、1 取消、退出 1；最近完整 unit 为 670 文件执行、13 文件失败，且早于四份旧断言修正。扩大回归 60/60 不能代替完整门禁。完整 verify 与生产启用仍待完成，整体 active。

65 个当前相关源码和测试摘要在本次完整客户端运行结束后复核一致；没有保留重复克隆性能候选。累计真实模型请求 137/144，本批新增 0；生产 PID
64716 启动时间仍为 2026-10-19 05:50:12，没有重启，日常客户端配置未变。证据位于
`.hpm-acceptance/context-plugin-vault-20261021-01/`：`preview-contract-alignment-client-full.log`、`retention-before-real-deadline-check.json`、`retention-after-real-deadline.json`、`client-retention-review-status-snapshot.md`；最终回执为
`client-retention-review-outcome.json`，分别绑定源码冻结、客户端结果、留存观察及本次文档快照。

## 2026-10-21：四份旧断言与现有安全契约对齐，扩大回归 60/60

封存上节 670 文件完整失败后，仅修改四份测试：Responses JSON 接线必须明确包含已有
`protocolOptions: PROTOCOL_OPTIONS`；串行工具由首个权限请求选中，不能用推测性预览顺序抢占；预览计划在权限确认前不发布片段，非法流失败后也保持零片段、零启动和零执行回调；合法 JSON 的错误值类型必须分类为
`payload_shape`，并另加非法 JSON 标记仍为 `wire_grammar` 的检查。

这些契约分别由现有入口注入、生产串行门禁的明确选取规则、预览暂存实现，以及独立的 production 解码/权限回归交叉确认。没有为了旧探针期望去修改产品权限、发布时点或错误分类。修改前三份旧预览测试 19 项中 16 通过、3 失败；修改后连同 runner、生产解码、权限选择、参数重试、HTTP 适配和运行时回归共 60/60 通过，5457.9904ms。实际 Responses
JSON 文件也通过。定向格式、Lint、CI、发布治理和 diff 检查通过。未改测试负载、期限、并发、阈值、测试发现或排除列表。

此前完整 unit 结果仍是 670 文件实际执行、657 文件通过、13 文件失败；本次断言修正后的完整 unit 门禁尚未重跑，不能直接宣称剩余九文件，也不把定向通过追溯计入旧完整结果。Core 请求期限、容量、原生校验与加密重开长尾，以及其他失败仍待定位；当前完整 verify 未通过。生产未重启、日常配置未变，真实请求仍为 137/144，本批新增 0。原 24h 样本仍按
`2026-10-22T00:55:55.109Z` 到期，尚未到实际观察时间，未重置。

随后对当前 65 个相关文件冻结运行标准完整
`test:client:coverage`，终态退出 1：1351 项、1348 通过、2 失败、1 超时取消、0 跳过，主体 275434.7516ms；覆盖率语句/行 99.07%、分支 95.22%、函数 99.29%，保持原阈值。失败为 Chat
Core
WBIPC 与原容量 60000ms 用例，取消为加密 worker 清理孤立 staging 并重开用例。65 个冻结摘要复核一致。与此前 7 失败、9 取消的不同运行不可直接归因为性能改进；本批没有保留恢复产品性能候选，完整门禁仍失败。日志为
`preview-contract-alignment-client-full.log`，单独记录本次修复后缺失的完整客户端证据，不覆盖已封存的 unit 结果。

另对引用事务入口的一次通用克隆加一次严格解析进行独立候选比较，保留原 12
MiB 准入；候选只存在于诊断文件。265856 字节合法私有历史、六轮交替、每轮三次 begin/save 的墙钟中位数约为原 249.17ms、候选 220.10ms，CPU 中位数约 226.50ms、219.00ms，但多轮墙钟或 CPU 未降低，不能认定稳定收益或容量修复，因此没有进入产品。第一版未构造出足够大的私有历史，第二版存储替身缺少必需能力声明，两次失败日志与脚本快照均保留；第三版通过后才产生比较结果。没有放宽实际存储能力检查或扩大原准入范围。

证据位于
`.hpm-acceptance/context-plugin-vault-20261021-01/`：`direct-responses-wiring-retained.log`、`stale-preview-contracts-before.log`、`stale-preview-contracts-expanded.log`、`root-reference-admission-benchmark-v3.json`、相应失败日志及 v1/v2 脚本快照。最终回执为
`preview-contract-alignment-outcome.json`，另保存当前相关源码冻结；与上节完整运行的冻结和回执分别保留。

## 2026-10-21：全量 670 文件执行完成，13 文件失败，安全模块覆盖率单独通过

修复 unit 执行器在单文件失败时立即结束当前分片的问题：当前分片会继续按原顺序执行全部选中文件，逐项保留失败标签，最后汇总失败数量并返回非零退出码。没有修改测试发现、排除列表、四分片并发、容量两 worker、任何原负载、期限或覆盖率阈值。异常信号也必须判失败，不能由空退出码制造成功。测试运行目录仍逐文件创建并在 finally 中清理；基础设施异常保持失败，不以忽略清理错误继续运行。

新增回归加载实际执行器源码并控制进程结果，旧实现复现首个失败后未执行后续文件；修复后覆盖多次非零/信号失败继续执行、逐项清理、空分片、全部成功、异常退出和错误内容不进入汇总。与既有实际信号子进程回归一起共 5/5 通过。测试追加到现有统一 unit 文件，没有新增测试排除。定向格式、Lint 与 CI 治理通过。

61 个相关文件冻结后执行标准
`test:coverage`，退出 1。四分片均完成，分别执行 168、168、167、167 个文件，失败数量分别为 1、2、5、5；总计 670 个文件实际执行，657 文件通过、13 文件失败。这是文件级统计，不累加各文件不一致的 TAP 格式生成虚假的总用例数。覆盖率语句/行 91.21%、分支 89.96%、函数 92.10%，达到原阈值，但不改变整体失败。后接的安全检查因命令中的
`&&`
没有执行；使用本次完整 coverage-final 单独执行原安全检查后退出 0，语句/行 81.97%、分支 76.12%、函数 82.97%。独立安全覆盖率通过不等于
`test:coverage` 或完整 verify 通过。

失败文件为
`client-context-target`、`context-recovery-capacity-workload`、`context-recovery-key`、`context-recovery-root-state`、`direct-responses-json`、`tianxi-auth-research`、`tianxi-client-read-options`、`evidence-gateway-runtime`、`tianxi-sdk-history-http`、`tianxi-preview-plan`、`tianxi-sdk-runtime-history`、`tianxi-custom-input-decoder`、`tianxi-serial-preview-gate`。已定位的失败包括 Core
Chat/Responses 请求期限、容量 60000ms、独立 PowerShell ACL 校验超时、四根 32
MiB 加密重开 180000ms，以及入口接线静态断言没有包括当前 `protocolOptions`
注入字段；其余失败保留待逐项定位，没有统一归因或改判。不能将此前分片提前停止时未执行的文件当作通过。

入口接线修正先在单独投影的测试副本中验证，补上对现有
`protocolOptions: PROTOCOL_OPTIONS` 的明确要求，整份 Responses
JSON 转换测试通过；冻结中的原测试未变，不能用副本结果追溯改判本次完整失败。另准备了引用状态重复克隆候选，首次诊断在构造足够大的合法私有历史前失败，未修改产品或放宽容量。此前 DPAPI 轮的完整失败与容量对照保持有效；产品恢复源码、本次模型用量、日常客户端配置和生产进程均未因执行器修改而改变。整体 active。

证据位于
`.hpm-acceptance/context-plugin-vault-20261021-01/`：`unit-runner-completion-before.log`、`unit-runner-completion-after.log`、`unit-runner-completion-final-regression.log`、`unit-runner-completion-source-freeze.json`、`unit-runner-completion-proxy-full.log`、`unit-runner-completion-security-coverage.log`、`direct-responses-wiring-candidate.log`。终态回执为
`unit-runner-completion-outcome.json`，封存本次源码、日志和文档摘要。

## 2026-10-21：DPAPI 失败探测及时停止，集成通过，完整代理门禁仍失败

修复 `secret-crypto`
的 DPAPI 可用性探测：Protect 未返回有效密文时立即结束失败探测，不再启动必然无效的第二次 Unprotect。诊断中两次同步 PowerShell 调用分别约 10163ms 和 8800ms，阻塞请求中的配置加载并推迟重载定时器；本次只去除失败后的无效调用，没有修改解密重试、完整成功往返验证或 AES-v2 安全回退。新增统一 unit 回归覆盖超时、空值、空白、非法返回类型、成功缓存、解密失败与不匹配、AES-v2 精确往返、非 Windows 及错误内容脱敏。旧实现 9 项中 6 项失败，修复后 9/9，通过与配置控制器合并回归 13/13。

集成测试继续暴露上游夹具固定返回
`{ok:true}`，不符合现有协议转换器要求。新增固定合成协议响应夹具，提供 Chat、Responses、Messages、Gemini 的有效成功响应，并加强请求辅助函数的 HTTP
200 与响应错误检查；原路由、凭据断言、期限及重试策略保留。实际未投影源码的
`test:integration`
已退出 0，12 项检查通过；此前凭据失败、ECONNRESET 及加载器诊断日志均保留。

本批广泛检查中，全仓格式、3943 个 JS 文件语法、Lint（0 错误、5 警告）、CI 与发布治理通过；前端覆盖率 8 个文件通过，语句/行 98.20%、分支 91.61%、函数 96.77%，完整前端 28 个文件及构建通过。Rust
16 项通过，thinking、env/config、hooks 通过。广泛静态、前端和 Rust 检查发生于本次 crypto 修复前；修复后的四个相关文件定向格式、Lint、语法及 CI/发布治理通过，隔离 home/master-key 的既有 crypto 往返也通过。没有改依赖。

58 个相关源码、测试与原始负载文件冻结后执行标准
`test:coverage`，退出 1：四个分片中三个失败，一个完整完成。失败涉及
`context-recovery-compaction` 的 30000ms 加密重开用例、`client-context-target`
的 Chat/Responses WBIPC 请求期限，以及 `context-recovery-capacity-workload`
的 60000ms 子进程期限。覆盖率语句/行 71.95%、分支 79.72%、函数 74.62% 达到原阈值，但因分片提前停止，这不是全部 670 个 unit 文件通过；后接的 security
coverage 检查没有执行。不得以覆盖率达标改判整体失败。

另外在不启用覆盖率的普通运行时执行原始容量用例，仍使用五档负载、两个 worker 和 60000ms 子进程期限，60179.3102ms 后超时失败（用例进程总计 60666.5381ms）。这是独立的失败对照，说明容量问题不只出现在覆盖率环境，不能覆盖或替代完整门禁结果。没有放宽期限、并发、负载或覆盖率阈值。最新完整客户端门禁仍是之前的 1351 项、1335 通过、7 失败、9 取消，本批尚未执行修复后的完整客户端门禁。

原 24h 样本第七次观察仍可精确读取，检查原文/检查点摘要与原绝对到期；到期保持
`2026-10-22T00:55:55.109Z`，没有重置或延长，实际到期清除仍待观察。观察前回执副本单独保留。Claude
v25 的完整真实三次压缩任务已通过，但范围仍为隔离原生 owner
HTTP，`fullCoreEntrypointVerified:false`；本批真实模型请求新增 0，累计 137/144。生产 PID
64716 启动时间仍为 2026-10-19
05:50:12，未重启，日常配置未变。整体仍未完成；容量、并行存储长尾、完整客户端与安全门禁、完整 Core 组合、日常旧插件迁移及生产启用仍待处理。

发布暂存随后重新执行
`release:prepare`，退出 0，116 个生产包安装与目录治理完成；本次修复已复制到暂存，暂存与源码 crypto 摘要复核一致。这不是生产激活，也没有以此替代完整客户端、Rust 或 verify 复验。另执行原加密重开用例的普通运行时诊断，仍触发原 30000ms 超时，1 项取消、进程总计 42378.9554ms；该诊断与暂存刷新并发，不能当作无竞争性能基线。首次启动约 12621ms，重开约 28210ms 时进入所有权获取，完整阶段日志保留。

本批证据位于
`.hpm-acceptance/context-plugin-vault-20261021-01/`：`dpapi-probe-before.log`、`dpapi-probe-after.log`、`dpapi-probe-scoped-regression.log`、`dpapi-probe-integration-valid-fixture.log`、`dpapi-probe-proxy-full.log`、`dpapi-probe-capacity-normal-runtime.log`、`dpapi-probe-compaction-normal-runtime.log`、`dpapi-probe-release-stage.log`、`dpapi-probe-source-freeze-v2.json`。最终回执为
`dpapi-probe-continuation-outcome.json`，绑定源码冻结、日志和文档摘要。冻结覆盖完整代理门禁前的源码；v2 创建时夹具集成命令已经启动，不宣称所有检查均在同一冻结之后开始。文档未计入该源码冻结。

## 2026-10-21：WAL owner 诊断未建立稳定收益，产品模式不变

完成六轮交替的实际 Core
Responses、加密 owner 与合成 WBIPC 诊断，沿用原测试全部模式及 5000ms 请求期限，没有真实模型请求。DELETE 三轮中两轮通过，第三轮 long-persistent 请求约 5025ms 失败；WAL 三轮通过，但存在加载器额外读取模块的计时混杂，不能据此比较总体延迟或认定 WAL 已通过发布资格。四个产品源码与原测试的冻结摘要复查一致。

按 worker 内部指标，DELETE 各轮 COMMIT 中位数约 9.66–10.19ms，WAL 约 5.19–5.37ms；但最长提交分别达到 1891.76ms 与 2177.91ms。较低中位数没有消除长尾，也没有证明原完整门禁的超时根因已修复。诊断 WAL 保留 FULL 与 secure_delete，并在成功操作返回前调用 TRUNCATE
checkpoint，但未检查其 busy/result 列，因此不宣称物理截断成功；WAL/SHM
ACL、崩溃恢复、恶意旁文件、配额及清除/到期语义均未资格化。产品继续使用 DELETE。

原始结果保留在
`.hpm-acceptance/context-plugin-vault-20261021-01/storage-wal-owner-compare-result.json`，逐操作指标汇总及原始证据摘要为同目录
`storage-wal-owner-review-result.json`。该回执由独立审阅脚本生成，不覆盖先前日志。本批无产品源码变更，未重复运行相同源码的完整客户端门禁；最新失败结果仍为下节 1351 项、1335 通过、7 失败、9 取消。

另检查读取结算固定 12 MiB 预规范化与 v10 引用 16
MiB 准入的差异，但尚未用合法根状态复现拒绝，因此仅记录为待调查问题，没有据此修改产品。读取前持久化预算预扣、实时授权及独立结算顺序保持。

用户授权的 Claude 新任务全真实复验已由既有 v25 回执完成：17 次请求、三次压缩、精确原文读取、独立公开生成、最终答案精确匹配，私有 wire 泄露检查通过；范围仍为隔离原生客户端 owner
HTTP，`fullCoreEntrypointVerified:false`。累计请求 137/144，剩余 7 次，不能将其扩展为完整 Core 或生产验收。完整落地仍 active，保留原 24h 样本到期时间及所有既有发布阻塞。

## 2026-10-21：引用保存去除一次重复完整校验，完整门禁仍未通过

本批保留修改在 reference-state /
storage-blobs：新增转换解析器对新、旧两个外部引用各进行完整规范化、摘要和根语义校验，再返回各自独立的安全克隆。当前格式的保存路径用返回的旧克隆做数据库载荷行关联和来源库存检查，避免先解析旧引用、再在转换比较中重复解析一次。原有 validateReferenceTransition 接口保持；旧格式迁移继续走原路径。没有跨事务明文缓存，没有跳过摘要、原到期、CAS、读取进度、迁移约束、载荷行或后续调用校验。

新增统一 unit/client 回归先在旧实现复现 3 !==
2 次根语义校验；修改后每个外部状态各校验一次。另验证返回的新旧库存互相独立且脱离输入，后续调用重新校验，空/非法输入、摘要和到期篡改、getter、非法封套及缺失载荷行均拒绝，失败后原持久化内容仍可精确读取。两文件扩展专项 84/84 通过，80649.3381ms；定向 Lint、格式、语法、CI 和发布治理通过。

47 个相关源码、测试、原始负载与文档摘要冻结后，标准完整客户端覆盖率门禁终态为 1351 项、1335 通过、7 失败、9 超时取消、0 跳过，347678.8004ms，退出 1。语句/行 99.07%、分支 95.23%、函数 99.29%。失败/取消涉及三个协议的 WBIPC、容量 60000ms、Core 和代理夹具启动、原生 ACL，以及加密存储续接、重开、退出和四根 32
MiB 重开等原有期限；未放宽任何期限、并发、负载或覆盖率门槛。相较上一轮 1349 项、1346 通过、3 失败，本轮整体结果更差，不能宣称超时根因已经修复，也不能把覆盖率达标当作完整门禁通过。

容量阶段诊断仍使用原五档与两个 worker，但没有套用原 60000ms 子进程期限，因此其完整画像通过仅作为诊断。重负载 worker 的规范化包含计时约 12806ms、绑定计算约 18404ms、导出约 6068ms、恢复约 9470ms；包含计时会重叠，不能求和或替代延迟门禁。另对请求内重复字符串共享、通用双字符串记录分支做六轮交替比较，均没有稳定收益：字符串共享墙钟中位数旧约 362.77ms
/ 候选 355.96ms，但 CPU 413.5ms / 422ms；双字符串分支墙钟旧约 943.41ms
/ 候选 1100.70ms。两个候选都没有进入产品，history-request 源码与原始备份逐字节相同。首版诊断因 CRLF 匹配失败的日志保留。

本批真实请求新增 0，累计 137/144；生产 PID 64716 启动时间仍为 2026-10-19
05:50:12，未重启，日常配置未变。原 24h 样本仍于 2026-10-22T00:55:55.109Z 到期，没有重置。容量、持久化尾延迟、完整真实 Core
/ WBIPC /
Hook 组合、旧插件日常迁移、实际到期观察、完整 verify 和最终生产启用仍待完成，整体 active。既有 WAL 原语诊断不等于真实 owner 资格；如继续该方向，必须同时验证 WAL/SHM 的安全路径、配额、崩溃恢复与清除语义，不能直接切换产品日志模式。

本批证据位于
`.hpm-acceptance/context-plugin-vault-20261021-01/`：`reference-transition-once-before.log`、`reference-transition-once-after.log`、`reference-transition-once-expanded.log`、`reference-transition-once-client-full.log`、`reference-transition-once-source-freeze.json`、`reference-transition-once-outcome.json`，以及
`history-string-sharing-benchmark.json`、`history-scalar-pair-benchmark.json`、`capacity-current-stage-v2-thread-*.json`。终态回执复核了所有冻结文件摘要。

## 2026-10-21：旧版迁移诊断完成，撤回无效的热激活候选

真实旧版 0.1.0 的二次隔离诊断再次通过升级、旧新会话精确读回与原绝对到期检查；同版本活动回滚仍失败。脱敏安装诊断归类为 cache/used，收集到 Windows
OS error
5，旧 MCP 进程的 cwd 位于原生版本缓存。安装错误没有明确包含旧缓存完整路径，因此只据此认定进程生命周期相关冲突，不宣称已定位具体失败路径。旧版执行代码不能由新版释放 cwd 的修复追溯改变。结束隔离 app-server 后，原安装命令成功，恢复版本握手为 0.1.0；失败后的旧、新活动会话仍可读取证据。

随后实现并测试了“保留执行和依赖字节、只更新包身份到新 recovery 版本”的候选。三文件回归 30/30、定向 Lint、格式、语法、CI 与发布治理通过，43 个源码/测试/负载文件冻结后进行原生验收；但新版本活动安装仍返回 1，22481ms，未超时。结束隔离进程后同命令成功，49475ms，仍在原 60000ms 期限内，安装快照与 0.1.0 执行版本均匹配。因此更换版本身份不足以提供热回滚；候选工厂及专属测试已撤回，vault 实现恢复到原冻结摘要，原始失败和停机对照不改判。

交付了独立包管理命令
`scripts/local-evidence-plugin-vault.js`，只组合现有完整性模块，支持 inspect /
retain /
restore。它不安装插件、不读取或改写客户端配置、不结束客户端进程；非法操作、参数数量、路径、篡改和重复目标均按原边界拒绝，错误输出固定码。新命令端到端回归进入既有统一 unit 测试文件，覆盖原样保存与恢复、空参数、非法参数、极端路径、越界目标、覆盖拒绝及日志脱敏。首轮因测试缺少导入失败，修正后扩展回归 27/27 通过，未删除失败日志。[插件说明](./local-evidence-plugin.md)
已列出可运行命令、结束旧会话后安装的步骤，以及包 vault 与原文存储的区别。

这不是无感热迁移完成。可选插件的原文是内存 30 分钟，结束进程会丢失；包 vault 不恢复原文。主方案仍以客户端原生压缩为默认，24 小时加密精准恢复按独立开关启用。当前 Claude
v25 已通过隔离原生 owner
HTTP 的完整真实三次压缩验收，不能扩展为完整 Core、插件或生产验收。本批真实请求新增 0，累计 137/144，剩余 7 次仍限于 Claude 完整任务和必要诊断。

最新完整客户端门禁仍为 1349 项、1346 通过、3 失败，不因插件工具变化重复跑相同代理源码来改判。容量 60000ms、两项 WBIPC
5000ms、当前真实 Core 组合、原 24h 到期观察、完整 verify 与生产启用仍未完成。生产 PID
64716 启动时间仍为 2026-10-19
05:50:12，未重启，日常配置未变。原样本到期为 2026-10-22T00:55:55.109Z，没有延长或重置。整体 active。

本批证据位于
`.hpm-acceptance/context-plugin-vault-20261021-01/`：`plugin-legacy010-diagnose-result.json`、`plugin-fresh-activation-result.json`、`plugin-activation-stopped-control-result.json`、`plugin-vault-command-regression.log`、`plugin-vault-command-coverage.log`；最终回执为
`plugin-vault-command-outcome.json`。

## 2026-10-21：真实旧版升级成功，同版本活动回滚仍被原生安装器拒绝

本轮只读取并完整校验日常缓存中的真实 0.1.0 插件包，再复制到全新临时 CODEX_HOME、APPDATA、LOCALAPPDATA 和 marketplace；没有把 0.1.1 改版本号来模拟旧包。旧包为 3678 文件、17244169 字节，快照
`5d4a5f8b354b34bc8b1783e2ccbbcb2a9da91e6389dcae6ef8694d53d5e2c82f`，保留其原 SDK 和运行时闭包。诊断仅改隔离包的 MCP 启动参数以记录原生 serverInfo，旧版运行代码未改，新版使用现有 0.1.1 自包含包。

原生 marketplace 注册、0.1.0 安装和升级安装均退出 0；安装耗时分别 17690ms、22605ms，仍使用原 60000ms 期限。独立握手与原生 app-server 的新会话均分别确认加载 0.1.0 和 0.1.1；观察记录的子进程父 ID 归属本次隔离 app-server。脚本在升级后精确读取旧会话原文、读取新会话原文并校验各自原 expiresAt，随后才进入已有阶段记录的来源删除和回滚步骤。这是合成原文的原生安装/活动会话适配器证据，不是自动 Hook 或真实模型验收。

删除 marketplace 包后，从独立 vault 恢复 0.1.0 源快照成功，完整性校验通过；但同版本活动回滚的
`plugin add`
在 22626ms 返回退出码 1，没有超时，回滚版本握手和最终新会话验证未执行。因此整项结果仍为 passed=false，不将部分升级成功描述为旧版迁移全部完成。它重现了旧版闭包包的原生回滚失败，尚未取得此次安装器错误类别，不能直接把 Windows
cwd 锁定或缓存裁剪当作已证明根因。当前诊断脚本在失败后终止了隔离 app-server 并清理临时目录；下一步需要保留失败缓存和固定脱敏的安装器错误分类，才能判断合适的回滚流程。

最终进程已终态，本轮没有真实模型请求，累计仍为 137/144；没有操作日常客户端配置、安装到日常客户端或重启生产。最新产品完整门禁仍为 1349 项、1346 通过、3 失败；源码未因本次隔离迁移改变，整体 active。证据目录
`.hpm-acceptance/context-plugin-vault-20261021-01/`：`plugin-legacy010-inventory.json`、`plugin-legacy010-migration.cjs`、`plugin-legacy010-migration-phases.jsonl`、`plugin-legacy010-migration-result.json`、`plugin-legacy010-migration-outcome.json`。

## 2026-10-21：工具调用消息规范化候选未复现稳定收益，已撤回

本轮针对容量采样中的历史克隆热点，在隔离加载器内比较单个 function-call 消息的固定结构路径。早期候选六轮交替基准曾显示较低墙钟；安全补强后最终版本的六轮结果却为旧实现中位数 263.62285ms、候选 296.49090ms，进程 CPU 中位数 250ms、候选 304.5ms，没有稳定收益。因此候选运行时和测试均完整撤回；history-request 与 binding 测试和修改前备份逐字节一致，上一轮 27 个冻结源码/测试/负载文件全部匹配。没有把约百行专用解析逻辑留在产品中。

诊断仍保留完整失败证据：旧实现回归复现固定树的递归祖先跟踪；中间候选的原五档、两 worker、60000ms 容量测试通过，51523.1355ms，但该结果不能资格化已恢复的产品。补强时另发现候选字节超限后继续扫描后续字段，先以回归复现，再改为逐项扣减立即拒绝；最终候选的正常、空、Unicode、精确单项字节、全局节点、深度、getter、稀疏/隐藏字段、循环、继承 setter 与失败路径等绑定测试 46/46 通过。最终候选仍因性能证据不足而撤回，不能把安全测试通过解释为保留优化的理由。恢复后的产品绑定测试为 41/41 通过，2857.3601ms。

未因撤回后的相同源码重复执行完整客户端；最新产品门禁仍是
`startup-atomic-outcome.json`
中的 1349 项、1346 通过、3 失败。没有增加真实模型请求、修改日常配置或重启生产。证据位于
`.hpm-acceptance/context-plugin-vault-20261021-01/`：`history-tool-call-final-benchmark.json`、`history-tool-call-budget-before.log`、`history-tool-call-binding-final.log`、`history-tool-call-restored-binding.log`、`history-tool-call-outcome.json`；未采纳的源码和测试另存为 rejected 快照。整体仍 active，后续转向真实旧版插件的隔离升级/回滚验收。

## 2026-10-21：新库启动合并为一次原子提交，完整客户端仍有三项超时

本批只修改 context-recovery-storage-sqlite 的新库启动：建表、初始认证时钟和公共启动准入在同一 writer 事务中完成，由两次提交减为一次。新建表之后仍重新验证完整 schema 和 blob
ownership，再读取公共启动数据；原有两次时钟观察、认证水位、页数配额、liveUsage、prune、DELETE
journal、synchronous=FULL 和 secure_delete=ON 保留。已有数据库仍执行原来的一次启动事务和一次时钟观察。预算预扣、原文读取、读取结算和发布事务顺序没有改变。启动后半段失败现在连同初始表和 header 一起回滚，不留下仅完成前半段的初始化状态。

新增两个回归进入既有统一 unit/client 的 storage 测试文件。旧源码复现多一次提交及启动失败后残留 schema；新代码验证新库一次提交、两次时钟检查、第二次水位在重开后仍被执行、已有库一次提交，以及时钟倒退、非法/极端时钟、时钟异常、配额失败、提交失败、schema 改变时完整回滚并可重新初始化。四文件专项 103/103 通过，36657.0497ms，包含加密重开、撤销、事务回滚和真实子进程崩溃恢复。

冻结源码后的标准完整客户端门禁为 1349 项：1346 通过、3 失败、0 取消、0 跳过，测试执行 215491.6372ms，最终 exit
1。语句/行 99.07%、分支 95.20%、函数 99.29%。失败仍为 Chat、Responses
WBIPC 原 5000ms 请求时限和容量资格原 60000ms 子进程时限。Claude
WBIPC、staging 重开以及四根 32
MiB 加密重开本轮通过，后者为 114233.4393ms，原 180000ms 上限不变。没有调整负载、并发、期限或覆盖阈值；单轮通过数和耗时变化不能证明稳定性能改善，完整门禁仍未通过。

定向格式、Lint、语法、CI 与发布治理通过；27 个源码、测试和原负载控制文件在终态回执时重新校验摘要。本批真实请求新增 0，累计 137/144；Claude
v25 的完整真实三次压缩验收仍只覆盖隔离原生客户端 owner
HTTP，不代表完整 Core、插件或生产验收。生产 PID 64716 启动时间仍为 2026-10-19
05:50:12，未重启，本批没有改日常配置。原 24h 样本仍于 2026-10-22T00:55:55.109Z 到期，尚未到观察时刻。

整体仍 active。容量内存路径不经过 SQLite，本批提交合并不能解决其主要 CPU 开销；后续需要针对原负载的历史规范化和绑定计算继续定位。同时仍待完成持久化并行尾延迟、旧版插件迁移、当前真实 Core 组合、24h 实际到期、完整 verify 和生产启用。证据目录
`.hpm-acceptance/context-plugin-vault-20261021-01/`：`startup-atomic-before-regression.log`、`startup-atomic-after-regression.log`、`startup-atomic-expanded-regression.log`、`startup-atomic-client-full.log`、`startup-atomic-source-freeze.json`、`startup-atomic-checks.json`，最终回执为
`startup-atomic-outcome.json`。

## 2026-10-21：引用元数据内部校验去除整份私有历史的重复克隆

本批保留修改只在 context-recovery-root-state：parseRoot 仍完整规范化外部根状态，再调用私有语义校验函数；validateRecoveryRootMetadata 仍完整规范化外部元数据封套，随后用本次调用的局部克隆构造更浅、更小的无原型根对象，直接执行同一私有语义校验。去除第二次完整 rootData 克隆，保留策略、身份、TTL、预算、绑定、私有历史、发布来源关联和所有恢复校验。私有函数不导出，不增加跨调用信任缓存，也不改变元数据入口的原有大小、节点和深度限制。

新增回归已进入既有统一 unit/client 的 root-state 文件。最终测试在冻结旧源码回放中复现 1
!==
0 的多余根克隆；新代码检查外部封套仍规范化一次、返回值及历史脱离原输入、后续调用重新校验、内部根无原型、非法到期变更拒绝、空/非法封套拒绝和 getter 不执行。初版测试错误假设保守增加 callCount 必然非法，实际该值可合法保守计数；已改用明确非法的 expiresAt 变更，原失败日志保留，不作为产品缺陷。四文件扩展专项 125/125 通过，97949.676ms。

隔离本地合成 Responses
WBIPC 完整恢复通过，10772.6396ms，真实模型请求 0。相同诊断流程中主线程状态规范化从 1155 次减至 1016 次；引用规范化 312 次、扫描页解析 10 次及导出元数据校验调用保持。调用计数证明重复工作减少；两次单样本耗时不构成稳定延迟或生产改善结论。

本批还诊断了存储 worker 自包含包：74 个源码模块形成 441198 字节诊断包，三轮交替执行实际 worker 的创建、加密写入、关闭、重开及精确读取，均完成且原 expiresAt 不变；启动收益不稳定，候选未进入产品代码。包只保留为隔离诊断证据，未修改 worker 入口、密钥后端、发布清单或生产进程。

最终冻结源码的标准完整客户端门禁为 1347 项，1343 通过、3 失败、1 超时取消、0 跳过，272471.6542ms，exit
1；语句/行 99.07%、分支 95.21%、函数 99.29%。Responses
WBIPC 本轮通过；Chat、Claude
WBIPC 仍触发原 5000ms 请求上限，容量资格仍触发原 60000ms 子进程上限，staging 重开仍在原 30000ms 期限取消。四根 32
MiB 加密重开通过，156814.9418ms，原 180000ms 上限未变。最近完整门禁仍失败，不将失败项数量波动或局部调用下降当作问题全部修复。

当前 Chat 失败记录显示多次数百毫秒的存储阶段在同一请求内累加，源码也确认读取会推进耐久时钟并进行同步事务提交；这为后续检查事务合并提供方向，尚未证明它是唯一瓶颈。任何后续优化仍须保留预算预扣、读取结算、取消、撤权、CAS、原到期与崩溃恢复语义，不能以减少耐久性或放宽期限达标。

定向格式、Lint、语法、CI 与发布治理通过，23 个源码、测试及原始负载控制文件在最终回执时复核摘要。本批新增真实请求 0，累计 137/144；生产 PID
64716 启动时间仍为 2026-10-19
05:50:12，未重启，日常配置未变。原 24h 样本仍于 2026-10-22T00:55:55.109Z 到期，尚未到观察时刻。容量与持久化尾延迟、旧版插件迁移、当前真实 Core 组合、24h 实际到期、完整 verify 和生产启用仍待完成，整体 active。

证据目录
`.hpm-acceptance/context-plugin-vault-20261021-01/`：`metadata-local-before-regression-final.log`、`metadata-local-after-regression-v1.log`、`metadata-local-expanded-regression.log`、`metadata-local-wbipc.log`、`metadata-local-source-freeze.json`、`metadata-local-client-full.log`、`metadata-local-module-coverage.json`、`storage-worker-bundle-diagnostic.json`；最终回执为
`metadata-local-outcome.json`，绑定本批源码、诊断、门禁及当前文档。

## 2026-10-21：快照视图省去描述符复制，容量 60 秒资格仍不稳定

本批先在修改前单独执行原有容量门禁，五档原负载、两 worker、60000ms 子进程期限保持：用例通过，58884.8064ms；这只证明一次孤立运行通过，不能覆盖此前完整并行门禁的容量失败。随后对当前容量命令采样 CPU，五档完整性、最终排空、重开和精确恢复计数均通过，但重 worker 的采样墙钟为 96227.144ms；采样不是原 60 秒资格测试，不将其算作门禁通过。原始采样文件与报告保留。

保留的源码修改仅在 context-recovery-snapshot-index：view 工厂已返回拥有实时 size 访问器的新对象，builder 和冻结 snapshot 直接使用各自新建的视图，去除两次属性描述符集合的物化及复制。没有共享可变视图，也没有改变私有 WeakMap 识别、写入封印、祖先/兄弟隔离、键语义、顺序或持久化结构。三轮交替微基准各创建 19200 个快照，旧实现墙钟为 555/539/505ms，候选为 189/186/225ms；各轮进程 CPU 也较低。此结果只证明局部分配路径减少，不是客户端或生产延迟保证。

新增回归在统一 unit/client 已有的 sessions 文件中，以旧实现复现创建两份视图时 4 份描述符集合，再检查直接视图不复制描述符、live
size、属性描述符、完整冻结、重复 freeze 身份、父子隔离、迭代顺序和封印后写入拒绝。会话、根状态和根所有权三个文件共 152/152 通过，143351.6442ms；其中四根 32
MiB 加密重开为 91946.7346ms，仍使用原 180000ms 期限。定向格式、Lint、语法、CI 与发布治理通过。未修改任何直接依赖。

最终源码再次单独执行原始容量门禁，仍发生 60000ms 子进程超时，用例失败，进程总计 61137.3889ms；没有扩大期限或重试制造绿色。因此本批不能宣称容量资格已修复或稳定达标。完整客户端没有因这项局部分配简化重复执行，前一轮 1345 项、1337 通过、5 失败、3 超时取消的完整门禁仍是最近结果；当前完整 verify 未通过。

21 个源码、测试及原始负载控制文件摘要在最终回执时复核。本批真实请求新增 0，累计 137/144；生产 PID
64716 启动时间仍为 2026-10-19
05:50:12，未重启，日常配置未变。整体 active；下一步仍需解决容量耗时与并行尾延迟，并完成旧版插件迁移、当前真实 Core 组合、原 24h 到期观察、完整 verify 和生产启用。原 24h 样本到期时间仍为 2026-10-22T00:55:55.109Z，尚未到观察时刻。

证据目录
`.hpm-acceptance/context-plugin-vault-20261021-01/`：`capacity-current-isolated.log`、`capacity-current-profile-report.json`、`capacity-current-hotspots.json`、`snapshot-view-benchmark.json`、`snapshot-view-before-regression.log`、`snapshot-view-regression.log`、`snapshot-view-capacity-isolated.log`、`snapshot-view-source-freeze.json`；本批最终回执为
`snapshot-view-outcome.json`，绑定所有上述结果、源码与文档。

## 2026-10-21：引用完整性哈希复用本次规范化结果，完整门禁仍失败

当前保留修改把原有哈希遍历原样拆入内部 context-recovery-fingerprint-value 模块。四个外部 fingerprint 入口仍先按原有大小与能力边界规范化未知输入；parseReferenceState 仍先执行完整规范化、精确形状与版本校验，再对本次调用的局部克隆计算摘要，避免原先在哈希入口再次完整规范化。后续根元数据、容量、发布状态、来源关联和授权校验保持。没有跨调用缓存或扩大外部入口，新模块已进入发布源码清单。

新增回归使用冻结旧源码复现重复规范化 2 !==
1；修复后验证仅规范化一次、返回值脱离输入、后续调用仍重新校验、输入变更拒绝和 getter 不执行。原有摘要字节、数值键排序、JSON 转义、非法输入与大小边界回归保留。四文件扩展专项 110/110 通过，40104.6158ms，新测试进入既有统一 unit/client 入口。隔离本地合成 Responses
WBIPC 完整恢复通过，主线程引用规范化从前轮 438 次降至 312 次，扫描页解析仍为 10 次；单次耗时 11143.9867ms 只作为诊断，不是稳定客户端或生产提速证明。

另一项哈希 update 分批候选未显示稳定收益，没有进入产品源码。首版诊断脚本因 CRLF 未插入最终 flush，产生摘要不一致；修正诊断脚本后再次比较，不将脚本错误描述为产品缺陷，全部失败与候选证据保留。

最终冻结源码的标准完整客户端门禁为 1345 项，1337 通过、5 失败、3 超时取消、0 跳过，231115.442ms，exit
1；语句/行 99.07%、分支 95.23%、函数 99.29%。失败包括三个协议的 WBIPC
5000ms 请求期限、容量资格 60000ms 和物理退出维护探针的 5000ms 子进程期限；取消为 staging 重开、未确认发布后的重开和重新授权重开各自原有 30000ms 期限。四根 32
MiB 加密重开通过，135822.8253ms，仍在原 180000ms 内。完整门禁较前轮仍有波动，不能把局部调用减少当作尾延迟修复成功，也没有放宽期限、负载、并发或覆盖阈值。

定向格式、Lint、CI 与发布治理通过；生产依赖 npm
audit 为零漏洞。源码及原始负载控制文件在完整运行后重新校验摘要。本批真实请求新增 0，累计 137/144；生产 PID
64716 启动时间仍为 2026-10-19
05:50:12，未重启，日常配置未变。原 24h 样本仍按 2026-10-22T00:55:55.109Z 到期，尚未到观察时刻。整体 active：持久化尾延迟、容量期限、旧版插件迁移、当前真实 Core 组合、24h 实际到期、完整 verify 和生产启用仍待完成。

证据目录
`.hpm-acceptance/context-plugin-vault-20261021-01/`：`reference-hash-before-regression.log`、`reference-hash-expanded-regression.log`、`reference-hash-wbipc-v3.log`、`reference-hash-source-freeze.json`、`reference-hash-client-full.log`、`reference-hash-scoped-checks.log`；最终回执为
`reference-hash-outcome.json`，绑定本批源码、诊断、回归和当前文档。

## 2026-10-21：worker 扫描回复去除重复解析，完整门禁仍未通过

当前保留修改只在 context-recovery-storage：scan /
scan-reference 直接交给既有完整扫描页解析器，并同时传入 pending 中保存的原始请求游标。取消同一同步处理栈中额外的通用克隆和第二次语义解析；worker 消息边界、完整字段/字节/摘要/元数据校验、请求 ID 关联与终态失败处理仍保留。此前生产适配器已在第二次解析校验游标，本次没有宣称修复生产游标准入漏洞；改动是让独立结果验证器第一次解析就完成该关联。

新增回归在统一 CI 原有两文件内。修正测试自身的普通对象/无原型对象比较后，使用冻结旧模块的独立加载回放，三项回归分别复现两种扫描的直接结果验证未使用游标，以及单条 worker 回复重复进入语义页解析器（2
!==
1）。修改后验证一次解析、错误游标拒绝、空页与非法输入拒绝、getter 不执行、返回值脱离输入、后续篡改重新拒绝及失败服务不能继续使用。相关两文件扩展回归 66/66，39382.7701ms；格式完成后关键三项再验 3/3，734.8154ms。早期断言失败及其日志保留，未追溯改判。

同一 Responses
WBIPC 全场景的隔离计数诊断前后均通过，扫描页解析器调用从 15 次降至 10 次；诊断只记录固定函数名、次数、失败次数与时长，没有参数、正文或凭据。旧/新单次耗时约 21864/16512ms 不是交替性能实验，不据此宣称客户端稳定提速，也不替代并行完整门禁。

最终冻结源码的标准完整客户端终态：1344 项，1340 通过、3 失败、1 超时取消、0 跳过，218316.7128ms，exit
1；语句/行 99.07%、分支 95.21%、函数 99.29%。失败仍为 Chat/Responses
WBIPC 原 5000ms 请求期限及容量原 60000ms；取消为 staging 加密重开原 30000ms。四根 32
MiB 加密重开本轮在原 180000ms 内通过，117945.6128ms；单轮通过不证明尾延迟根因已消除。WBIPC 日志另有单次发布状态保存约 2722ms，本次扫描去重不足以解决全部持久化超时。

15 个运行、测试及负载文件摘要在完整门禁后再次一致。定向 Lint、格式、CI 和发布治理通过，根项目 npm
audit 为零漏洞；新测试进入既有统一 unit/client 路径。所有原工作负载、期限、两 worker 与覆盖门槛均未修改。完整 verify 未通过，未激活生产；生产 PID
64716 启动时间仍为 2026-10-19
05:50:12，日常配置未变。本批真实请求新增 0，累计 137/144，整体 active。

证据目录为
`.hpm-acceptance/context-plugin-vault-20261021-01/`：`scan-reply-before-regression-v2.log`、`scan-reply-expanded-regression.log`、`scan-reply-final-regression.log`、`wbipc-parse-baseline-v1.log`
/ `wbipc-parse-after-v2.log`、`wbipc-parse-counts-v1-*` /
`wbipc-parse-counts-v2-*`、`scan-reply-client-full.log`、`scan-reply-source-freeze.json`
与 `scan-reply-module-coverage.json`；最终回执为
`scan-reply-outcome.json`。仍待处理持久化尾延迟、容量期限、旧版插件迁移、当前真实 Core 组合、24h 实际到期观察、完整 verify 和生产启用。

## 2026-10-21：编码保真优化与容量 CPU 定位，完整门禁仍失败

保持五档原负载、两 worker 与全部原期限，对容量命令进行 CPU 采样：五档原文完整性与恢复次数均通过，采样进程总计 66873ms，仍超出标准用例的 60000ms 上限。较重 worker 的主要自耗时包含 canonical 字符串编码约 6909ms、历史克隆约 6326ms、哈希更新约 5153ms；此诊断没有更改资格判定，也不覆盖真实传输或持久化。

当前保留的小优化仅在请求局部 canonical 编码器中，对不含引号、反斜线、C0 控制和代理项的字符串直接添加 JSON 引号；其余字符串仍由原生 JSON.stringify 编码。保留原 128 项/4
MiB 局部缓存，未增加跨请求原文缓存，也未改变哈希字节、授权、TTL 或预算。新增回归逐个覆盖全部 65536 个 UTF-16 单元，补充代理项组合、Unicode 分隔符、空值、大字符串、嵌套数值键及缓存饱和后的精确编码和 SHA-256。测试加入既有统一 unit/client 文件；最终三文件专项 70/70 通过，5050.1066ms。

三轮交替 CPU 微基准的最终中位数为旧编码 1126ms、新编码 1048ms；只代表这一局部运算，不是客户端或生产提速证明。另一个绕过大字符串缓存的候选明显更慢，未进入产品源码。初次正则字面量触发 no-control-regex；没有关闭规则，改为数字端点构造的同义常量模式，并在最终专项中重新验证全部 UTF-16 单元。定向 Lint、格式、CI 与发布治理通过。

正则写法修正前的完整标准客户端终态为 1342 项，1336 通过、4 失败、2 超时取消、0 跳过，317970.9253ms，exit
1；语句/行 99.07%、分支 95.22%、函数 99.29%。失败为三个协议的 WBIPC
5000ms 请求期限及容量 60000ms；取消为 staging 重开 30000ms 和四根 32
MiB 加密重开 180000ms。其中一次 load-reference 约 4724ms，证明本轮小优化不足以解决持久化路径的超时，尚不能把资源竞争或某个局部调用认定为唯一根因。该轮六文件摘要结束后复核一致；最终同义正则写法仅完成上述 70 项专项，完整客户端未再次运行，不宣称当前完整门禁通过。

本批真实请求新增 0，累计 137/144，生产 PID 64716 的启动时间仍为 2026-10-19
05:50:12，日常配置未变。可选插件分发包的输入清单不含本次编码模块，前一轮插件证据仍保留原有范围。整体 active；持久化尾延迟、容量期限、旧版迁移、当前真实 Core 组合、24h 到期观察、完整 verify 和生产启用仍待完成。

证据目录为
`.hpm-acceptance/context-plugin-vault-20261021-01/`：`capacity-hotspot-baseline.json`、`CPU.20261021.130330.435176.*.cpuprofile`、`canonical-quote-*-microbenchmark.json`、`canonical-quote-client-full.log`、`canonical-quote-client-source-freeze.json`、`canonical-quote-final-regression.log`；最终回执为
`canonical-quote-outcome.json`，分别绑定完整门禁时和最终保留的源码摘要。

## 2026-10-21：原生自动 hook 与当前包升级、独立存档回滚通过

在新建隔离 Codex 环境中，当前完整分发包的原生 PostToolUse
hook 已实际执行：仅信任该包的确切 hook，本地合成 Responses 驱动一次真实源 MCP 工具调用，经原生 Code
Mode 执行后自动留存；没有直接调用私有捕获接口。hook 开始/完成各一次，精确读回 140 字节，源工具正常完成，进程终止。此项为真实客户端、本地合成模型验收，真实模型请求为 0，不扩大为完整真实 Core 验收。

当前 0.1.1 分发包的独立原生升级/回滚探针通过：只为诊断生成身份版本 0.1.2，经实际原生安装命令升级后，旧会话和新会话继续精确读取 Unicode/CRLF 原文；物理删除 marketplace 的完整 package，再从独立 vault 恢复原始 0.1.1 并执行原生回滚，旧、新及回滚后新建会话均通过读取、跨线程拒绝和原 expiresAt 不变检查。四个安装命令均在原 60000ms 期限内结束。诊断版没有发布，生产源码和当前分发包未改变。

额外使用仅修改隔离启动元数据的只读握手观察器，核对同一原生 app-server 启动的 MCP 子进程：三个阶段新进程分别实际报告 0.1.1、0.1.2、0.1.1，每阶段两个进程的父 PID 均为该 app-server；完整升级/回滚流程再次通过。观察器只记录 PID、父 PID 和版本，握手后停止解析；运行包除诊断版身份变更外未增加业务行为。早期观察探针错误要求每阶段恰好一个进程，失败报告保留，未改判。

原生安装器仍删除退役版本缓存，nativeRetiredCacheIntact=false；通过的是独立 vault 中完整版本可验证且可恢复。以上不覆盖旧 0.1.0 源码闭包的完整迁移。可选插件仍为内存 30 分钟，主恢复的 24 小时目标不变。日常配置和生产 PID
64716 未改变，本批新增真实请求 0，累计 137/144。

本批没有产品代码修改；17 文件源码摘要与上一分发包回执一致，不重复宣称全仓测试。此前标准完整客户端 1340 项中 1338 通过、2 失败仍有效：Responses
WBIPC
5000ms 请求期限与容量资格 60000ms。持久化尾延迟、旧插件迁移、当前真实 Core 组合、24h 实际到期观察、完整 verify 与生产启用仍未完成，整体 active。

证据目录为
`.hpm-acceptance/context-plugin-vault-20261021-01/`：`plugin-bundle-hook-v7-result.json`、`plugin-bundle-upgrade-v1-result.json`（未加观察器的原包）、`plugin-bundle-upgrade-v5-result.json`（隔离启动观察）；本批回执为
`plugin-native-lifecycle-outcome.json`，绑定源码、探针、结果及当前文档摘要。

## 2026-10-21：可选插件切换自包含分发包，缓存删除与隔离安装通过

新增独立构建、包校验和薄命令入口，使用项目已直接声明的 Vite 构建完整 CJS 运行包；最终输出只允许 Node 内建运行时导入。直接读取当前源码及插件锁定的依赖，不改写旧暂存源码闭包。生成物保存在 runtime/local-evidence-plugin 的内容摘要目录，包含独立 marketplace；安装器和隔离探针都使用该同一分发源，原生旧缓存和日常配置没有迁移或安装操作。源码目录及旧包存档继续保留。

新 runtime-manifest 使用独立 bundle
schema，绑定所有运行包文件和构建输入摘要；第三方清单记录实际参与构建的依赖版本及许可证文本，绑定完整锁文件摘要。存档同时支持旧源码闭包和新 bundle，均完整清点文件、拒绝篡改、额外文件、链接、越界、过量及版本不一致。不可变产物在独立 staging 完成校验后发布；已存在的产物必须逐字节相同，并发发布只有在获胜包完整相同时才可复用，未知发布错误仍失败。命令入口只负责组合和固定错误输出。

实际分发包为 10 文件、1956936 字节；完整缓存删除回归仍保留原 60000ms 期限，完整复制、启动、留存、物理删除整个安装包后继续精确读取和捕获，并验证跨线程拒绝及原 expiresAt 不变。一次最终源码专项中构建 18205ms、复制 98ms、删除 26ms；这是本机单次观测，不是生产性能保证。此前 35 秒复制、73 秒删除的旧目录负载记录保留，没有通过过滤旧 node_modules 制造通过。

Codex 原生隔离安装 run98 已完成：实际包校验、stdio、合成捕获、精确读回、跨线程拒绝和原生进程终态均通过，0 次模型请求。其后新增并发发布保护，当前最终源码 run97 隔离复验同样全部通过。hook 在这两个新隔离环境中均为 untrusted，hookExecutionVerified 为 false，因此不能宣称真实 hook 自动触发通过。

最终源码普通专项 28/28 通过，29923.6442ms；同五文件的 V8 覆盖运行也为 28/28 通过，24138.1899ms，exit
0。构建、bundle 校验与存档三模块的专项覆盖为语句/行 99.69%、分支 94.28%、函数 100%，不是完整应用覆盖。全仓 npm
run lint、format:check、check:ci 和 release:check 全部通过；根项目及插件 npm
audit 均为零漏洞，修改模块与实际 bundle 语法检查通过。五个本批测试文件均已确认进入统一 unit 自动发现。当前完整 verify、完整单位覆盖和完整客户端没有因这批脚本修改重新执行，之前完整客户端两项失败仍有效。

新测试进入统一 unit 自动发现；没有改变现有 CI 入口、覆盖率阈值、期限、负载或并发。整体仍 active：Responses
WBIPC 请求期限、容量资格、持久化尾延迟、插件完整升级迁移与真实 hook、当前真实 Core 组合、24h 到期观察、完整 verify 和最终生产启用尚未完成。本批真实请求新增 0，累计 137/144，生产 PID
64716 未重启。

证据目录仍为 `.hpm-acceptance/context-plugin-vault-20261021-01/`，源码冻结为
`plugin-bundle-source-freeze.json`（17 文件），最终回执为
`plugin-bundle-outcome.json`，回归为
`plugin-bundle-regression-published.log`，覆盖为
`plugin-bundle-coverage.log`；原生隔离报告为
`.hpm-runtime/context-local-plugin-native-20261012-run97-result.json`。最终回执复核源码摘要并绑定上述结果与文档摘要。旧候选和失败构建日志全部保留，所有本批执行命令均已结束。

## 2026-10-21：保留引用校验解析去重，撤回索引块候选

当前保留修改为 context-recovery-reference-state 的引用关联校验去重：两个外部输入仍各自完整解析一次，随后仅在模块内部比较新解析的局部值，避免原先再次解析两份完整状态。比较 helper 不导出，没有跨调用信任缓存，也不跳过后续输入变更、权限、预算、绑定或来源不可变性校验。新增回归先以 4
!==
2 复现重复解析，再验证解析次数、返回值脱离输入、空值/数组/非法摘要/异根拒绝、getter 不执行和后续变更拒绝；测试位于既有统一 unit/client 文件内。

隔离 CPU 微基准交替执行三轮、每轮八次关联：小引用中位 CPU 109→47ms，含 512
KiB 私有历史的引用 750→391ms。这只证明局部计算减少，不能作为客户端延迟或容量资格证据。

另试验不可变索引的祖先块合并，候选的 48 项会话回归通过，但在 V8 覆盖下运行原五档、双 worker 完整负载，旧索引 66783.7105ms、候选 74634.5237ms，两版均完成所有 profile。单轮顺序对照不能证明稳定因果收益，且未运行原 60000ms 资格判定；未得到收益证据，已按本批之前备份恢复索引模块和会话测试，未撤销其他已有修改，失败与候选证据全部保留。最终源码三文件回归 125/125 通过，38231.9051ms；定向 Lint、格式、CI 和发布治理通过。

候选尚在时的标准完整客户端为 1342 项、1338 通过、3 失败、1 取消，233645.4663ms，exit
1；语句/行覆盖 99.07%、分支 95.22%、函数 99.29%。失败仍为 Chat/Responses
WBIPC 原 5000ms 请求期限和容量原 60000ms，取消为 staging 加密重开原 30000ms。四根 32
MiB 私有历史加密重开通过，131092.0327ms；不将该耗时与此前结果之差宣称为性能收益。

撤回索引后的标准完整客户端终态为 1340 项、1338 通过、2 失败、0 取消/跳过，233899.5081ms，exit
1；语句/行覆盖 99.06%、分支 95.21%、函数 99.29%。仍失败于 Responses
WBIPC 原 5000ms 请求期限和容量原 60000ms。staging 加密重开本轮 21143.1181ms 通过，四根 32
MiB 私有历史加密重开 132899.7822ms 通过；单轮通过不代表原先尾延迟根因已修复。

再次复核 Claude
v25：17 次真实请求、三次原生压缩、精确私有 READ、独立公开证据、精确最终答案和进程终态通过，privateWireLeak 为 false；范围仍仅为 owner
HTTP 入口。累计真实请求 137/144，本批新增 0；未改日常配置、安装插件或重启生产。容量、持久化尾延迟、完整插件/迁移、当前真实 Core 组合、24h 到期观察、完整 verify 和最终生产激活仍未完成，整体 active。

证据目录为
`.hpm-acceptance/context-plugin-vault-20261021-01/`：`reference-parse-once-*`、`snapshot-block-*`、`reference-and-index-client-full.log`
与
`reference-parse-only-retained-*`。候选前后及最终保留源码分别冻结 11 个运行/测试/负载文件摘要；最终回执为
`reference-and-index-outcome.json`，在完整客户端终态后复查源码并绑定证据摘要。

## 2026-10-21：事务内容量分类复用，存储回归通过，标准完整客户端仍失败

当前保留修改位于 context-recovery-storage-sqlite：保存前的清理已经对各根完成认证解密和语义校验，之后容量核算仅对完全相同的行复用其容量分类。复用键绑定密文 SHA256 和完整加密上下文（含 storeId、scope、revision、createdAt、expiresAt、kind、version）；行改变则重新解密验证。每次写事务内部新建小 Map，只保存摘要和版本，不保存明文根或密文副本，不跨提交、回滚、失败或后续请求。当前写入的新行仍正常解密分类，blob 数量和字节数仍从数据库重新核算。没有改变事务提交边界、模式 DELETE、synchronous=FULL、secure_delete=ON、加密、授权、预算、绝对 TTL 或期限。

新增回归修改前以 2 !==
1 复现同一未变根在一个写事务内重复解密；修改后验证一次解密，并在清理后、容量核算前分别篡改密文、revision、createdAt、expiresAt，确认重新认证失败且写入和篡改一起回滚。继续验证失败后正常保存，以及跨事务密文损坏连续两次拒绝且不修复证据。新增回归在既有统一 unit/client 文件内，统一发现已确认；未修改测试入口或跳过用例。存储两文件 78/78 通过，94294.4329ms；定向 Lint、语法、格式、CI 和发布治理通过，根项目完整 npm
audit 为零漏洞。

当前源码原字面 npm run
test:client:coverage（无诊断 preload、无 CPU 采样）已退出 1：1339 项、1335 通过、3 失败、1 取消、0 跳过，测试主体 297433.2241ms；覆盖率语句/行 99.06%、分支 95.22%、函数 99.29%。失败为 Chat/Responses
Core
WBIPC 原 5000ms 请求期限、五档两 worker 容量原 60000ms；取消为 staging 加密重开原 30000ms。四根 32
MiB 精确私有历史加密重开在完整并发中通过，166802.9994ms，仍在原 180000ms 内；该单项通过和失败数量变化不证明存储尾延迟已修复，也不构成端到端性能收益对照。

证据为
`.hpm-acceptance/context-plugin-vault-20261021-01/transaction-admission-outcome.json`，绑定 11 个运行/测试文件摘要并在完整客户端终态后复查一致；另有
`transaction-admission-source-freeze.json`、前后回归日志、`transaction-admission-regression.log`、`transaction-admission-client-full.log`、`transaction-admission-discovery.log`
和根审计/治理日志。生产 PID
64716 启动时间未变，未安装插件或改日常配置，真实请求仍 137/144，本批新增 0。所有本批门禁命令已结束；完整 verify、剩余持久化与容量、完整插件/迁移、当前真实 Core 组合、24h 到期观察及最终生产启用仍未完成，整体 active。

## 2026-10-21：存储等待与状态计算分别定位，完整诊断门禁仍失败

本批没有修改产品代码、日志模式、耐久性、预算、TTL、负载、并发或期限。复核 Claude
v25 原生全真实新任务报告：passed、精确私有 READ、独立公开请求证据、精确最终答案和进程终态均为 true，privateWireLeak 为 false；仍仅证明 owner
HTTP 入口，不能外推为当前完整 Core、安装插件或生产验收。真实请求保持 137/144，本批新增 0。

增加只记录固定操作名、次数、耗时和摘要的诊断。当前源码三协议 Core
WBIPC 原定向用例 3/3 通过，31910.3692ms，但其中一次 load-reference 为 1517.9931ms，COMMIT 占 1486.3575ms、线程 CPU 为 0，说明定向重跑通过不能消除长尾。随后原 test:client:coverage 命令加诊断 preload，在原负载、并发和覆盖率门槛下退出 1：1338 项、1335 通过、2 失败、1 取消、0 跳过，测试主体 248273.8214ms；覆盖率语句/行 99.06%、分支 95.21%、函数 99.29%。失败为 Chat
Core
WBIPC 原 5000ms 请求期限及五档两 worker 容量原 60000ms，取消为 staging 加密重开原 30000ms。此为带额外计时的诊断运行，不替代上批无诊断标准门禁，也不能用失败数量变化声称稳定性改善。

本次完整负载的 345 个存储操作记录揭示两类瓶颈：一次操作总计 5226.0708ms、线程 CPU
46ms，其中 COMMIT 4441.1782ms、线程 CPU
16ms；另一次 save-reference-state 总计 12685.5063ms、线程 CPU
12219ms，而 COMMIT 仅 15.4557ms。不能将后者归因于文件系统，也不能将前者归因于纯 JavaScript 计算。进一步在 c8 与 CPU 采样下运行原四根、32
MiB 精确私有历史加密重开用例，1/1 通过、82441.9304ms；三份采样的非 idle 热点集中于状态克隆、字符串字节核算、历史规范化和指纹计算。采样是墙钟归因，不能作为逐函数 CPU 用量；定向通过不替代完整失败门禁。八个运行/测试文件的 SHA256 在采样结束后复查一致。

独立 SQLite 原语对照保持 synchronous=FULL、secure_delete=ON，并验证关闭重开精确字节与当前文件密文标记清除。两轮 DELETE 提交均值 9.0314/8.3635ms，TRUNCATE
9.2807/9.3592ms，WAL
3.1970/2.9338ms；这不是 owner、崩溃耐久性或容量资格测试，产品仍为 DELETE，WAL/SHM 路径与清除语义未获资格。另以 256
KiB 加密合成负载交替比较系统临时目录与工作区证据目录，DELETE 提交均值分别 9.8052/9.3040ms 与 3.9768/4.3523ms，均验证重开及当前数据库清除。该毫秒级差异不足以解释完整负载的秒级尾部。系统磁盘队列的两次采样分别出现高队列和零队列，不能据此认定某个进程或磁盘是唯一根因，没有修改 TEMP/TMP、存储路径或系统安全配置。

下一步需分别处理事务等待和重复状态计算：任何合并事务方案都必须保持 revision、授权、读取预算、发布和清除的原子边界；减少内部重复规范化需先证明不可变数据的内部来源与所有外部边界检查，不采用跨事务信任缓存。容量资格本身是合成会话计算负载，换存储磁盘不能替代其 60000ms 门禁。当前完整 verify、插件/Hooks 与迁移、当前真实 Core 组合、24h 到期观察和生产启用仍未完成，整体 active，生产 PID
64716 启动时间未变。

证据位于
`.hpm-acceptance/context-plugin-vault-20261021-01/`：`storage-owner-current-outcome.json`（分离先前定向 43039 字节与后续完整负载计时，绑定源码和日志摘要）、`storage-owner-current-cpu-summary.json`、`storage-owner-current-cpu.log`、`storage-owner-client-instrumented-current.log`、`storage-owner-core-delete-current.log`、`sqlite-full-durability-io-result.json`、`sqlite-volume-comparison-result.json`
与 `storage-owner-disk-snapshot.json`。所有诊断进程已退出，失败记录保留。

## 2026-10-21：保留 JSON 字节核算优化，全仓格式与 Lint 通过，完整客户端仍失败

本节为本批当前结论，下方各批快照保留原结论。context-recovery-state-data 保留普通 ASCII 快路径，以固定 JSON 字符范围扫描实际转义并正确消耗代理对；稀疏文本避免逐码元遍历，密集文本按固定窗口退回原精确计数，限制 match 分配。模式仅由内部常量构造，没有请求输入参与。未改变节点/深度/字节上限、克隆和描述符校验、原文内容、预算、绝对 TTL 或授权边界，没有增加运行时语法版本要求或关闭 Lint 规则。

新增性能回归修改前失败，保留版定向 14/14 通过，包括全部 UTF-16 单元、全部补充平面码点、C0/C1、孤立代理、稀疏/密集切换、精确边界和旧 UTF-8 回退；模块语句/行/函数 100%，分支 96.46%。同进程交替微基准每轮 200 次归一化、5 轮：ASCII
CPU 中位数 156/156ms；密集转义 594/577ms；其余选定样本 CPU 比率 0.157–0.725。这些是微基准，不是单次请求延迟或容量资格。直接逐匹配和 Unicode 属性筛选的退化候选未保留；另保留一次源码冻结不一致的诊断失败，不将该次结果作为性能依据。

冻结源码的原标准完整客户端门禁为 1338 项、1331 通过、4 失败、3 取消、0 跳过，323141.6734ms，退出码 1。覆盖率语句/行 99.06%、分支 95.21%、函数 99.29%。失败/取消涉及三协议 Core
WBIPC 的持久化请求、原五档两 worker 容量、staging 重开、不确定发布重开、四根 32MiB 重开。Chat
long-persistent 本轮约 5098ms 触及原 5000ms，四根原 180000ms 等期限未调整。两轮失败数量变化不证明稳定性根因已消除，完整验收仍未通过。

全仓格式首次检查失败于 404 个诊断/临时文件。仅为根 `.codex-tmp/` 与根 `tmp/`
增加格式排除，归档内容未改写；新增统一 unit 范围回归先失败后通过，验证正式 lib、scripts、test、前端、扩展和正式源码内同名目录继续检查。排除后仅本批新建治理测试需格式修正，已仅格式化该新文件。最终字面 npm
run format:check 通过，全仓 ESLint 再次通过（0 errors、5
warnings）；格式/Lint 范围治理 2/2、CI 与发布治理通过。没有跳过正式测试、关闭规则或修改 baseline。

本批代码与门禁证据为
`.hpm-acceptance/context-plugin-vault-20261021-01/state-native-escapes-outcome.json`、`state-native-escapes-retained-source-freeze.json`、`state-native-escapes-v6-benchmark-result.json`、`state-native-escapes-retained-regression.log`、`state-native-escapes-client-full.log`、`format-scope-repository-final.log`、`format-scope-repository-lint-final.log`
和
`format-and-lint-scope-regression-final.log`。六个运行/测试文件在完整客户端终态后 SHA256 复查一致；格式范围的独立后续改动另行绑定。真实请求仍 137/144，本批新增 0；生产 PID
64716 未重启，未安装插件或修改日常配置。完整 verify、安全/构建、真实组合与生产激活未完成，整体 active。

## 2026-10-21：事务内归属校验去重与 Lint 范围治理，完整客户端仍失败

SQLite 归属检查统一移至事务入口：每次 BEGIN
IMMEDIATE 后验证 schema 和 blob 归属，再读取或清理；不跨事务缓存结果。此前 catalog、sweep 等路径会在同一锁内重复检查。新增回归先复现 2 次检查，再验证每事务 1 次，以及下一事务发生孤立 blob 后读取、清理和撤销均拒绝且不删除损坏证据。同步级别、日志模式、加密、权限、TTL、预算和事务提交边界未改变。

存储两文件回归 77/77 通过。原标准完整客户端门禁为 1336 项、1325 通过、5 失败、6 取消、0 跳过，331526.0166ms，退出码 1；覆盖率语句/行 99.06%、分支 95.20%、函数 99.29%。失败及取消包括 Core 加密续接、三协议 WBIPC、隔离代理、原五档容量、Windows 密文清除/重开、压缩日志和 staging 重开、四根 32MiB 重开。定向通过不代表原 5000/30000/60000/180000ms 门禁合格，未放宽原期限或负载。

此前全仓 Lint 错误来自诊断和冻结副本目录。现在仅排除 `**/.hpm-acceptance/**`、根
`.codex-tmp/**` 和根
`tmp/**`；新增统一 unit 治理测试验证正式 lib、scripts、test、前端和扩展仍被检查，且 no-undef 仍生效，近似目录名及正式源码内 tmp 不被排除。全仓 Lint 重跑通过：0
errors、5
warnings；修改范围格式、CI 与发布治理通过。没有关闭规则或修改 baseline。

完整插件缓存删除的阶段诊断仍失败：复制 34591.041ms、删除 72680.5141ms，原 60000ms 用例超时，不能解释为纯模型或读取逻辑延迟。诊断只记录固定阶段、计数和耗时。真实请求仍 137/144，本批新增 0；未安装插件、更改日常配置或重启生产。整体 active，容量、存储稳定性、插件完整验收和全仓门禁未完成。

证据为
`.hpm-acceptance/context-plugin-vault-20261021-01/storage-ownership-outcome.json`，绑定四个修改文件摘要并终态复查，范围仅为该批次；另保留前后回归、`storage-ownership-client-full.log`、`lint-scope-repository-final.log`、Lint 范围前后回归和
`plugin-cache-stage-timing.jsonl`。后续字符扫描候选单独验证，不把此批门禁当作之后源码的验收。

## 2026-10-21：暂存插件 SDK 安全升级，包级缓存删除期限仍未通过

复核已授权的 Claude
v25 全真实新任务：17 次请求、三次原生压缩、原始工具仅调用一次、精确私有 READ 及独立公开证据、最终答案精确且无私有工具事件泄漏。此证据仅覆盖 owner
HTTP 入口，不扩展为当前 Core、已安装插件或生产验收。真实请求仍为 137/144，本批新增 0，没有重复追加授权或重复执行该真实任务。

暂存插件 `plugins/hpm-local-evidence` 的直接 MCP
SDK 从 1.31.0 升至精确 1.32.1，更新 lockfile、安装依赖并重建 26 模块源码闭包。插件独立 npm
audit 返回零漏洞。新增版本门槛回归修改前失败，修改后通过；包清单断言同步当前版本，旧版回滚合成夹具继续保留。三个回归文件均由统一 unit 发现；定向 Lint、格式、CI 与发布治理通过。

最终三文件回归 20 项、19 通过、0 断言失败、1 取消、0 跳过，110016.2145ms，退出码 1：运行中删除完整插件缓存并继续读取用例仍超过原 60000ms。不能把安全审计和版本回归通过当作完整插件交付通过。未延长期限、跳过测试、安装插件、改日常配置或重启生产；生产 PID
64716 的启动时间仍为 2026-10-19
05:50:12。容量、存储重开稳定性、完整客户端/插件和全仓门禁继续阻塞整体交付，目标保持 active。

证据位于
`.hpm-acceptance/context-plugin-vault-20261021-01/`：`plugin-sdk-security-outcome.json`
绑定源码摘要及请求计数；另保留
`plugin-sdk-floor-before.log`、`plugin-sdk-regression-after.log`、`plugin-sdk-rebuilt-regression.log`、`plugin-sdk-final-regression.log`、`plugin-dependency-audit-before.json`
与
`plugin-dependency-audit-after.json`。中间旧清单断言和缓存超时的失败记录均保留。

## 2026-10-21：保留历史请求的 Unicode 扫描优化，存储延迟仍阻塞交付

CPU 采样发现 JSON 字节核算中的 Unicode 分类扫描热点。当前仅优化 context-recovery-history-request.js：保留 ASCII 路径，宽字符文本使用码元范围扫描与既有无损 UTF-8 校验；C0 控制字符、引号、反斜杠和孤立代理仍交给原生 JSON 编码。C1 字符及配对代理无需生成整段 JSON 副本。未改变节点、深度、逐项/总字节、冻结、预算、TTL 或授权边界。状态编码器候选在带转义 ASCII 对照中表现退化，已撤回，context-recovery-state-data.js 与本轮备份 SHA256 相同；不把候选收益套用到保留实现。

新增 C1 无副本回归在修改前失败；全 UTF-16、补充平面及旧运行时回退检查进入既有统一 CI 文件。候选 v1 期间定向 30/30，包括四根 32MiB 加密重开 101915.8671ms；这是此前候选的定向证据，不能替代当前完整门禁。当前保留版本的前后 normalizer 对照见 json-scan-normalizer-benchmark-v2-result.json：Unicode 样本有 CPU 收益，ASCII 墙钟仍有波动，不作整条请求时延保证。

当前源码完整 test:client:coverage 已退出 1：1335 项，1329 通过、3 失败、3 取消、0 跳过，主体 319355.0382ms。失败为 Chat/Responses
Core 持久化请求原 5000ms 截止时间、原五档两 worker 容量资格 60000ms；取消为加密 staging 重开 30000ms、授权恢复重开 30000ms、四根 32MiB 重开 180000ms。覆盖率语句/行 99.06%、分支 95.22%、函数 99.29%；history-request 语句/函数 100%、分支 98.16%，state-data 与 UTF-8
helper 语句/分支/函数 100%。32 文件源码冻结复核无差异。定向 Lint、语法、格式、CI 及发布治理通过，完整门禁仍未通过。

进一步的隔离 worker 计时确认一次操作 3561ms、线程 CPU
62ms、已记录文件检查约 22ms；下一次捕获 scan-reference 的 SQLite COMMIT
2911ms、线程 CPU
0ms。后一次 DELETE 诊断虽然通过，也不能撤销历史超时。仅在诊断进程比较 TRUNCATE，保留 synchronous=FULL 与 secure_delete=ON，仍在重开第二轮 5015ms 超时，因此未修改产品日志模式；运行源码仍使用 DELETE。现有证据说明存储线程内部阻塞是延迟来源之一，未证明所有超时有同一根因，也未排除系统调度或其他文件系统等待。

证据均位于 .hpm-acceptance/context-plugin-vault-20261021-01/：json-scan-regression-before.log、json-scan-regression-after.log、json-scan-normalizer-benchmark-v1-result.json、json-scan-normalizer-benchmark-v2-result.json、json-scan-client-full.log、json-scan-source-freeze.json、storage-operation-worker-timing.jsonl、storage-operation-worker-sqlite-timing-v2.jsonl、storage-operation-worker-sqlite-TRUNCATE-timing-v3.jsonl 及对应 Core 日志。诊断只记录固定操作名、计数、耗时及 CPU，无请求参数、原文或凭据；辅助脚本未进入生产路径。真实请求仍 137/144，本轮新增 0；未安装插件、改日常配置或重启生产。容量、持久化期限、完整客户端/插件与全仓门禁仍待完成，整体 active。

## 2026-10-21：实际 Core 大原文窗口回归与加密重开未通过

实际 Core 的 WBIPC 测试新增 long-json、long-sse、long-failed：约 600KB 原始工具结果超过现有 384KiB/96Ki
token 窗口，私有阶段使用可信留存引用，公开阶段使用中性占位及独立验证的 READ 证据；失败后仍能重新读取原始内容。该版本 Core 文件 30/30 通过，证据为
`.hpm-acceptance/context-plugin-vault-20261021-01/wbipc-core-window-regression.log`。使用 FakeWbipcSocket，不代表真实 WBIPC 端点。

随后新增 long-persistent，使用真实 Windows 加密存储 worker，关闭后物理重开，检查原文不出现在 SQLite 文件、来源与绝对到期时间不变、预算继续扣减及公开发布确认。当前测试仍未通过：完整文件 28/30，Responses 重开后第二轮和 Claude 第一轮超过原 5000ms；Chat 本轮通过。后续诊断还观察到普通内存模式超时，不能据此把根因归结为加密存储。最新单独 Responses 诊断在持久化第一轮完成私有读取及发布阶段，但仍超时；READ 和存储操作计时仅用于定位，未证明故障根因或修复。

新增测试保留在既有统一 CI 入口
`test/client-context-target.test.js`，原负载、5000ms 请求截止时间、预算及门禁均未放宽。阶段诊断仅记录固定测试模式、操作名、计数和耗时，不记录原文或凭据。证据：同目录
`wbipc-core-persistent-regression-v3.log`、`wbipc-core-persistent-timing-v1.log`、`wbipc-core-persistent-timing-v2.log`、`wbipc-core-persistent-timing-v3.log`。定向 ESLint 通过；新增测试后的完整覆盖率门禁尚未重跑，前次完整门禁失败保持有效。

最终当前源码复跑为 27/30，三个协议的 long-persistent 第一轮均超过原 5000ms（总耗时 125244.0704ms），0 取消、0 跳过；日志为同目录
`wbipc-core-persistent-final.log`。其中 Responses 的 settle-reader 单次 3276ms，Claude 的 load-reference 单次 1801ms，Chat 的 save-reference-state 单次 1236ms；这些是耗时观测，不能单独证明因果。此前 Chat 通过保留为历史结果，不能作为当前通过。

真实请求新增 0，累计 137/144；此前 Claude v25 的全真实验收仍仅覆盖 owner
HTTP 入口，不扩大到当前 Core、已安装插件或生产。容量、加密重开期限、真实 WBIPC、插件迁移及全仓门禁仍阻塞整体交付。未修改日常配置、安装插件、重启或激活生产；整体保持 active。

## 2026-10-21：WBIPC 双预算实现最终验证，完整门禁保持失败

冻结 31 文件运行 npm run test:client:coverage，终态 exit
1：1333 项，1328 通过、2 失败、3 取消、0 跳过，344657.0418ms。覆盖率行/语句 99.06%、分支 95.20%、函数 99.29%；三个 WBIPC 模块均行/语句/函数 100%，新窗口模块分支 97.61%。定向 97/97、Lint/格式、CI 与发布清单通过；新增测试已处于原统一客户端入口。失败为 direct-upload
fixture 启动期限及原五档两 worker 容量 60000ms 超时；三项取消为 staging 清理重开 30000ms、当前授权/读取预算重开 30000ms、四根 32MiB 私有历史重开 180000ms。上次四根提前失败与本轮明确超时均保留，尚未定位共同根因；覆盖率达标不改变失败结论。全部 31 文件 SHA256 在门禁结束后复核一致。

当前源码的 Codex 原生经实际 Core 合成复验通过。Claude 同期 v4 在原 20 秒启动期限内未发出请求并失败；在完整测试进程结束后，v5 单独复验以相同期限通过三次原生压缩、精确 READ/公开证据/最终答案、无私有事件泄漏及进程终结，失败记录保留，不能据此声称并发启动问题已修复。本轮真实调用新增 0，累计仍 137/144。

WBIPC 双预算本地代码已实现：保留完整宿主原文，仅投影已证明留存的历史结果，继续使用现有最终发布事务；2.4MB 多轮会话、私有/公开隔离、非法 UTF-8、引用篡改、独立预算、撤权与发布前取消后的原文重读均有回归。仍需补实际 Core 的大窗口发布/加密重开组合及真实 WBIPC 端点验收，不以 FakeWbipcSocket 证据代替真实传输。容量/启动/重开稳定性、完整插件/Hooks 与迁移/真实旧读取器、24h 到期实测、全仓门禁及最终空闲生产启用继续待完成；生产与日常配置未更改，整体 active。

证据：.hpm-acceptance/context-plugin-vault-20261021-01/wbipc-window-outcome.json、wbipc-window-runtime-source-freeze.json、wbipc-window-final-module-coverage.json、wbipc-window-client-full.log、claude-native-recovery-core-synthetic-wbipc-v5-result.json 与上节列出的回归/失败日志。

## 2026-10-21：WBIPC 长历史增加原文证明和双预算传输投影（完整门禁运行中）

新增 context-recovery-wbipc-window：保留宿主完整规范历史，仅在 format3 的 WBIPC 传输副本超限时，按当前会话 captured/visible 集合中的 callId、SHA256、精确 UTF-8 字节数和绝对到期证明，替换已留存的历史工具结果。私有阶段使用来源引用；独立公开阶段使用无私有目录标识的固定占位说明，并继续附带成功 READ 的已验证证据。用户消息、工具调用、工具定义和私有 READ 回执不截断；没有确切留存证明、非法 UTF-8 或替换后仍超任一预算时拒绝，不连接 IPC、不执行外部工具。引用查询不消耗或重置读取预算，不创建新保存事务；继续复用已有最终响应 prepare/sending/finished 与撤回边界。

WBIPC 入口与协议转换采用 owner 的 historyFormat，format3 允许原 32MiB 历史边界，单项和单次结果批次仍为原 2MiB；传输仍受原 384KiB 和 96Ki
Token 两项上限控制，未提高任何上限。旧 format2、凭据/endpoint 绑定、工具历史配对和认证撤销规则保留。新模块进入发布清单，新增回归位于原统一 test:client 测试文件。

四文件定向 97/97 通过（21481.1165ms），包含已有实际 Core 集成、新 2.4MB 多轮会话的投影、精确 READ 和发布前取消后再次读原文。新窗口模块定向覆盖率语句/函数 100%、分支 93.75%（新增 UTF-8/非法边界回归之前的采集）；最终标准 test:client:coverage 正在运行。当前源码的 Codex 原生经过实际 Core 合成复验通过；Claude 同期在原 20 秒 native_deadline 内未发出模型请求，待完整门禁终态后单独复验，失败记录保留。不冒充真实 WBIPC 端点或已安装插件验收。

证据：.hpm-acceptance/context-plugin-vault-20261021-01/wbipc-window-runtime-source-freeze.json（31 文件）、wbipc-window-core-regression.log、wbipc-window-owner-regression-final.log、wbipc-window-coverage.log、wbipc-window-lint-frozen.log、wbipc-window-format-frozen.log、wbipc-window-ci.log、wbipc-window-release.log、wbipc-window-client-full.log、codex-native-core-synthetic-wbipc-v2-result.json、claude-native-recovery-core-synthetic-wbipc-v4-result.json。本轮真实请求新增 0，累计 137/144；生产 PID 未重启，日常配置未改，整体 active。

## 2026-10-21：两端原生客户端经过实际 Core 的合成验收通过

新增端到端证据：原生 Claude 与 Codex 客户端经 createCoreRequestHandler 进入默认恢复路径，使用测试注入的认证、临时路由和本地合成上游。两端均完成三次原生压缩，原始外部工具只执行一次，私有 READ 后逐字节证据进入独立公开生成，最终答案精确，私有工具事件未泄漏，客户端进程结束。Claude 消耗 18 次本地合成响应，Codex
13 次，真实模型新增 0。此证据覆盖原生客户端到实际 Core 的默认恢复调用链；不覆盖完整 openai-proxy
composition、安装插件/Hooks、真实上游或生产部署。历史两端真实验收仍保持其原 owner
HTTP 入口和源码范围。

证据：.hpm-acceptance/context-plugin-vault-20261021-01/claude-native-recovery-core-synthetic-v3-result.json 和 codex-native-core-synthetic-v1-result.json。复核原 25 文件 diagnostic-source-freeze 的源码 SHA256 均一致，未通过变更恢复逻辑取得本轮通过。夹具早期路径/缺失依赖失败日志保留，最终两端均 exit
0。容量 60000ms 稳定性及完整客户端失败门禁仍未解决；插件安装/迁移与真实旧读取器、WBIPC 长历史双预算、24h 到期实测、全仓门禁和最终生产启用仍待完成。真实预算仍 137/144，生产与日常配置未更改，整体 active。

## 2026-10-21：撤回纯文本指纹候选，容量门禁保持未通过

纯文本消息的 canonical
SHA256 快路径通过 40 项等价性回归和定向 Lint，但原五档、两 worker、c8 覆盖率下的完整耗时对照为基线 58989.9289ms、候选 99477.4894ms，候选不具备可保留的稳定收益。候选在原 60000ms 资格用例中仍超时，已恢复源码和本轮候选测试；原 25 文件 diagnostic-source-freeze 的 SHA256 全部一致，恢复后绑定回归 39/39。诊断脚本的 qualified 字段只表示五档数据完整，未包含原资格命令的 60 秒期限，因此不得解释为标准门禁通过。历史完整客户端失败结果保持有效。

证据位于 .hpm-acceptance/context-plugin-vault-20261021-01/：scalar-canonical-outcome.json、capacity-scalar-canonical-baseline-result.json、capacity-scalar-canonical-candidate-result.json、scalar-canonical-restored-regression.log。后续实际 Core 与两端原生客户端的合成链路已通过，见上节；未安装插件，未更改生产或日常配置，本轮真实请求新增 0，累计 137/144，整体 active。

## 2026-10-21：原文 UTF-8 校验去除重复整段复制，完整门禁仍未通过

新增共享 isWellFormedEvidenceText：在原生 String.prototype.isWellFormed 可用时直接校验 UTF-16 是否能无损往返 UTF-8；旧运行时保留原 Buffer 往返校验。原文形状门禁和摘要校验均使用它，避免为相同校验分配整段 Buffer/字符串副本。原输出字节上限、JSON 转义预算、SHA256、逐回执校验、读取偏移、缓存上限、所有期限与负载不变。

账本回归 31/31：逐一比较全部 65536 个 UTF-16 单元，分块覆盖全部补充平面码点，同时验证原生与强制旧运行时回退等价；原生路径形状检查不分配原文 Buffer，摘要检查只创建所需的摘要/读取边界 Buffer，缓存命中仍拒绝错误摘要与非法 UTF-8 偏移。加密存储/根状态/收养三文件 72/72，包括四个根、32
MiB 私有历史的真实加密重开，整组 92395.2424ms。定向 Lint、CI 与发布清单通过，新模块已声明。

当前源码的标准 npm run
test:client:coverage（含原生工具和网关标准重建）终态为 1325 项、1323 通过、2 失败、0 取消/跳过，144479.1159ms，exit
1。全门禁覆盖率语句/行 99.06%、分支 95.18%、函数 99.29%；本次 UTF-8
helper 与两个关联模块均达到语句/函数/分支 100%。失败为原 60000ms 容量资格超时，以及四根 32MiB
fixture 在 38482ms 内恢复轮次提前失败（并非触及 180000ms 期限），具体错误码尚待诊断。已补只含 index/suffix/安全 code 的断言信息，原轮次、负载、并发与期限均未变；三文件诊断已 92/92 通过（95927.5439ms），其中原五档、两 worker 容量资格 51745.5068ms，通过原 60000ms 期限。该结果不替代全并发门禁，也未证明此前失败根因已消除。带安全断言的第二轮完整标准客户端门禁终态为 1325 项、1324 通过、1 失败、0 取消/跳过，218607.3158ms，exit
1；仅原 60000ms 容量资格超时。覆盖率语句/行 99.06%、分支 95.19%、函数 99.29%。四根 32MiB 此轮通过，但首轮提前失败未定位到根因，不能据重跑通过声称已修复。日志 evidence-native-unicode-client-diagnostic-full.log，第一轮失败记录保留。额外隔离诊断：在 c8 下只运行原容量资格用例也于原 60000ms 超时（测试总计 60557.5647ms），不能只归因于文件并发；未关闭覆盖率采集，也未放宽任何门禁。日志 capacity-coverage-isolation.log。完整失败保持失败，独立 103 项通过不替代门禁。日志 evidence-native-unicode-client-full.log。当前源码的 Codex
synthetic-unicode-v42 与 Claude
synthetic-unicode-v27 原生零模型回归均通过三次压缩、精确最终答案、无私有事件泄漏和进程终结；scope 仍是原生客户端加恢复 owner
HTTP 入口，不是完整安装插件或生产路径。新源码尚未做真实模型重验，历史 Codex/Claude 真实通过保留原证据范围。生产与日常配置不变，本轮真实请求新增 0，累计仍 137/144。容量 60000ms、全仓门禁、完整插件/Hooks 接入、WBIPC 长历史、迁移/真实旧读取器、24h 到期和最终生产启用仍待完成。整体 active。

证据目录 .hpm-acceptance/context-plugin-vault-20261021-01/：evidence-native-unicode-regression.log、evidence-native-unicode-root-regression.log、evidence-native-unicode-lint.log、evidence-native-unicode-ci.log、evidence-native-unicode-release.log、evidence-native-unicode-runtime-source-freeze.json、evidence-native-unicode-outcome.json。

## 2026-10-21：阶段计时完成，第二项缓存候选撤回

原五档/两 worker 的最大负载阶段计时（含嵌套，不能相加）：入站历史规范化 19781ms、frontier.calculate
30653ms、完整根导出 8849ms、重开恢复 16715ms。仅保留固定阶段名、次数与耗时，不记录原文或请求参数。

第二项候选用请求内 UTF-16LE 摘要加速大文本缓存比较，保留持久化规范链、每次入站校验与缓存上限；独立 60000ms 门禁仍超时。紧邻的完整原负载对照为旧实现 92529.2461ms、候选 90796.9834ms，两者功能断言全过，差距约 1.87%，不足以证明稳定收益，已撤回新模块、接线、运行清单及实验测试。23 文件与前轮冻结清单再次逐一匹配，未保留新的缓存格式。下一步优先查完整状态导出/重开中的重复处理，不放松任何校验。

证据：.hpm-acceptance/context-plugin-vault-20261021-01/capacity-stage-timing-thread-_.json、capacity-stage-timing-result.json、capacity-item-fingerprint-_-diagnostic-result.json、capacity-stage-and-rejected-fingerprint-outcome.json。本轮新增真实模型请求 0，预算仍 137/144，生产和日常配置不变。整体 active。

## 2026-10-21：容量热点采样与文本复用实验撤回，性能门禁仍失败

对原五档、两 worker 容量负载完成 CPU 采样：五档功能断言全部满足，带分析器总耗时约 134.7 秒；该结果不能替代原 60000ms 门禁。热点集中在历史克隆、规范编码、指纹 SHA 与 GC。请求内文本复用实验的定向比较虽较快，完整负载对照为原实现 120416.86ms、实验 126789.8618ms，两者功能断言均通过而性能门禁均失败，因此撤回源码与实验专用测试，原源码 SHA256 和上一轮 21 文件冻结清单全部复核一致。

实验阶段绑定/私有容量/会话回归 90/90、定向 Lint 和 CI 清单通过，仅是被撤回候选的证据，不冒充最终性能验收。本轮无新增真实模型请求，累计仍 137/144；未修改任何期限、负载、worker 上限、日常配置或生产。证据：.hpm-acceptance/context-plugin-vault-20261021-01/capacity-profile-and-rejected-intern-outcome.json、capacity-intern-_-diagnostic-result.json、CPU.20261021.080819._.cpuprofile。整体 active。

## 2026-10-21：默认隔离入口与 Claude 完整真实复验通过，整体未完成

Core 集成补充：30/30 全部通过，含 JSON/SSE、多协议转换、三次规范压缩、WBIPC 与撤权。发现 Gemini 对含先前工具历史的相邻用户消息合并会破坏公开证据边界；修复恢复路径保持原消息边界，补回归。Gemini 转换与直接 Chat 测试通过；默认入口 Codex 原生合成 v41 三次压缩通过，零真实调用。标准完整客户端首次复跑为 1322 项、1299 通过、21 失败、2 取消（306757ms）；该次混有尚未更新的旧三轮 Core 测试。Core 修复后最终完整门禁为 1323 项、1315 通过、3 失败、5 取消、0 跳过，315001.7422ms，exit
1。失败为容量资格、独立 ACL 校验和旧 DPAPI 互操作；取消涉及加密 worker 重开、加载、撤权、4 根 32MiB 历史及网关启动。覆盖率行/语句 99.06%、分支 95.18%、函数 99.28%，不因覆盖率达标改判通过。当前源码封存为 default-isolated-security-final-source-freeze.json，旧封存保留为历史。

HTTP 与 WebSocket 默认恢复入口已改为内部恢复后独立公开生成。普通 HTTP 响应只有在实际传输完成后才获得公开来源标记；普通 WebSocket 响应先准备，完成发布确认后才允许续接。旧未知来源响应、未完成公开发布均不具备公开祖先权限。无法证明公开祖先时，清理成功后返回安全的 previous_response_not_found，客户端可自行携完整公开上下文重发；代理不会自动重试。

WebSocket 增量投影加入工具目录一致性条件，避免公开阶段继承私有响应 ID。回归覆盖原生形态工具、长历史、连续三轮外部结果、分片、断线重连、客户端完整窗口重发、撤权、发布失败与加密 SQLite 关闭重开。私有阶段若返回未广告的外部工具调用，拒绝并隐藏；所有外部调用均来自独立公开阶段。相关五文件 210/210，协议转换等八文件 107/107；定向 Lint/格式通过。入口/WS 三模块覆盖率语句/行 95.89%、分支 91.08%、函数 96.15%。这些是合成上游和本地传输证据。

Claude
v25 使用真实原生客户端、新建隔离任务、真实模型贯穿 seed、三次压缩、两次中间续接和最终恢复；默认 HTTP 入口直接接管，无 isolated 选项包装。17 次真实请求、3 次原生压缩、原始 MCP 工具仅执行 1 次，精确私有读回、公开证据投影及最终答案全部通过，未检测到私有工具事件泄漏，客户端进程已终结。它验证恢复 owner
HTTP 入口，仍不是完整 Core/插件安装或生产验收。Codex
v38 的全真实通过属于先前源码，不能冒充当前源码重验。

新授权仅用于 Claude 完整复验及诊断，累计预算 137/144，剩余 7 次；没有自动重试或修改日常配置。生产未重启、未启用本次改动、未安装插件。标准完整客户端门禁仍未通过，容量/worker/ACL/DPAPI/启动问题保持待解决。容量资格单独诊断仍在原 60000ms 超时（测试总计 61202.6754ms）；未改期限、负载或两 worker 上限。依赖升级后 Windows 密钥组单独诊断 24/24 通过，原生/旧 DPAPI 双向兼容通过；不能以单组通过替代原并发门禁或认定根因已修复。WBIPC 长历史、完整 Core/插件/Hooks 多端接入、迁移与真实旧读取器、24 小时到期及最终生产启用仍未交付，整体保持 active。

安全依赖分两批升级：@modelcontextprotocol/sdk ^1.32.1、Vite
^6.4.5。按标准流程重建网关完整性产物；升级后网关/发布回归 32/32、前端构建通过，npm
audit 各严重度均为 0。完整客户端门禁发生在依赖升级前，未冒充升级后全量结果。升级后 Claude 默认入口原生合成 v26 三次压缩通过，零真实请求；精确答案、无私有事件泄漏及进程终结均通过。

证据位于 .hpm-acceptance/context-plugin-vault-20261021-01/：default-isolated-source-freeze.json、default-isolated-entry-verified.log、default-isolated-protocols.log、default-isolated-coverage.log、default-isolated-lint-final.log、default-isolated-format-final.log、claude-native-recovery-isolated-complete-v25-result.json、real-model-budget.json。

## 2026-10-21：独立公开响应来源与持久化续接边界

已补宿主来源证明：Responses 的 previous_response_id 只有在当前 principal/target/policy 绑定到唯一父快照，父响应确由独立公开生成产生且完成发布后，才可进入公开请求。私有响应 ID、旧单缓冲流程的未知来源 ID、未完成发布与歧义祖先继续拒绝。私有读取仍沿原私有状态机进行；公开请求仅延续宿主证明过的公开响应 ID，绝不取私有阶段的 response
ID，因此不需要另存完整用户历史。

持久化采用显式 publicGenerationFormat=1 和每个快照的 publicResponse 布尔值；标记保存在原加密状态中，旧无标记状态默认不具备公开祖先权限。封存器/元数据层严格校验标记类型、协议与快照关联；既有快照的来源属性在引用状态更新中不可提升或降级。旧读取器的精确字段契约会拒绝新增格式，但真实旧版二进制仍待验收。没有增加原文容量、读预算、快照上限或延长绝对到期时间。

测试已证明：完成发布后跨状态重开可续接；刚发生的私有 READ、草稿、私有响应 ID 均不进入公开请求；来源标记篡改、缺失、未知格式、未完成发布与旧状态均按边界拒绝；实际 Windows 加密 worker 关闭/重开后仍可使用公开祖先，原到期时间相同。扩展回归 153/153、持久化/绑定组 144/144、最新定向 46/46；隔离模块覆盖率行/语句 98.15%、分支 94.54%、函数 100%。定向 Lint/格式、CI 与发布清单检查通过。两端新原生合成模型验收均完成三次压缩、精确恢复、单根与无私有工具泄漏，零真实请求；不是完整 Core/插件或真实模型验收。

性能字符扫描实验未保留：替代实现未呈现稳定收益，原五档/两 worker 容量实测 60121.7393ms，超过原 60000ms 并超时。恢复了历史计量源码的原始 SHA256，保留新增穷举回归，覆盖全部 UTF-16 单元和补充平面码点与 JSON 精确字节等价。不宣称容量或性能合格。

目前来源证明仅由 isolated 宿主选项使用，默认 HTTP/WS 尚未切换；仍需验证实际发布时序、缓存失效、完整传输/插件与兼容迁移。上一轮 Codex
v38 全真实通过属于上一轮源码，不冒充本轮新字段的真实复验。真实请求预算仍 120/120，本轮新增 0；追加授权待用户回复，不能继续真实调用。完整客户端与全仓门禁尚未在这批最终源码上重跑；上一轮失败记录仍有效，整体 active，生产与日常配置不变。

证据：public-lineage-final-source-freeze.json（补充祖先注释后重封存）、public-lineage-source-freeze.json、public-lineage-outcome.json、public-lineage-_-final.log、public-lineage-coverage.log、两端 synthetic-v24/v40-result.json、history-character-_-benchmark-result.json 与 capacity-character-set-deadline-result.json，位于 .hpm-acceptance/context-plugin-vault-20261021-01/。

## 2026-10-21：私有恢复与独立公开生成（未完成整体交付）

最终冻结源码复核 SHA256 一致；最新扩展回归 274/274、定向 42/42，两端新合成原生三次压缩均通过；新模块覆盖率行/语句 98.07%、分支 93.82%、函数 100%。标准完整客户端最终终态：1314 项，1302 通过、3 失败、9 取消、0 跳过，373312.0762ms，exit
1。整体交付未完成。

全仓语法检查通过（3871 个 JavaScript 文件）；全仓 Lint 失败（7697 errors、669
warnings），本轮修改文件定向 Lint/格式及 CI/发布清单检查通过。最终完整客户端覆盖率行/语句 99.01%、分支 95.13%、函数 99.13%；失败门禁不因覆盖率达标改判。全仓 verify/build/security 全链路未完成。

用户已选择严格隔离：先内部完成恢复，再以独立公开请求生成最终输出。新增独立协调器与证据投影模块；公开侧仅收到原始可见请求、原外部工具和经宿主成功 READ 校验的证据页。目录回执、私有工具定义/调用 ID、错误、中间草稿和 thinking 不跨该边界。校验包括来源 ID、完整摘要、分页范围/总字节、UTF-8 和分块 SHA256；保留 8 轮、64 次读取、512
KiB 上限，私有最多 7 轮，为公开生成预留一轮。无可读证据时直接公开生成，避免无效私有发现。

目前仅新增宿主选项 publicGeneration=isolated，原生探针显式启用。默认 HTTP/WS 尚未切换，带 provider
previous_response_id 且缺少完整公开祖先时明确拒绝，尚需设计可验证的公开历史重建；不能称为默认无感集成或完整 Core/Hook 验收。

新隔离 Codex
v38 全程真实模型验收通过（13 次请求）：真实原文捕获一次、三次原生压缩、后续私有请求读回精确原文、独立公开请求含精确授权证据、最终值精确匹配、单根、无私有工具事件泄漏。Claude
v16/v18 全流程真实验收失败；v19 的安全结构诊断定位到公开摘要含两个 summary 开标签、一个闭标签，严格封存器正确拒绝 context_recovery_summary_invalid。没有放松封存规则；仅对已识别的原生摘要公开请求增加唯一 summary 块的系统格式要求，并关闭该请求的 thinking。v20 修复后单次真实公开摘要与原生压缩通过（种子/私有阶段合成），v21 最终真实公开生成答案严格匹配（种子/三次压缩/私有阶段合成）；二者不能合并冒充 Claude 全流程真实通过。

累计真实模型预算已获批至 120 次，现 120/120；无自动上游重试、无日常配置改动、无生产重启/激活。完整标准客户端中间门禁为 1312 项、1297 通过、14 失败、1 取消、0 跳过，306295.54ms；覆盖率行/语句 99.06%、分支 95.17%、函数 99.28%。运行期间有源码后续修正，故该轮仅诊断，不是最终冻结源码门禁。失败包括加密 worker/ACL/DPAPI 启动与重开、冷导入期限及容量资格，均保留失败记录，没有提高期限或跳过测试。

容量原负载诊断 85118ms 仍超过原 60000ms；热点包括历史 clone/编码、规范化、SHA、GC，尚不能认定性能合格。24h 原样本绝对到期仍为 2026-10-22T00:55:55.109Z，尚未实际到期验收，不重播种或延长。整体 active；仍需 Claude 修复后全真实复验、默认 HTTP/WS 与完整 Core/插件/Hook、WBIPC
format3 长历史事务与传输、旧插件迁移/真实旧读取器和回滚、全仓门禁、到期观察及最终空闲激活。

本轮证据目录：.hpm-acceptance/context-plugin-vault-20261021-01/。保留所有失败与成功报告；真实预算 real-model-budget.json，Codex
codex-http-recovery-isolated-complete-v38-result.json，Claude
claude-native-summary-stage-v19-result.json、claude-native-isolated-summary-format-v20-result.json、claude-native-isolated-final-format-v21-result.json。最终本地回归和源码摘要见 isolated-generation-outcome.json、isolated-generation-source-freeze.json。

## 2026-10-21：Claude 原生续接、流元数据与计量兼容

Claude 原生压缩后会插入 assistant 消息；旧的全 user 条件因此丢弃有效回执。现在解析完整回执，只有唯一已观察到且确实源于该回执的后代窗口才能优先于旧回执；不相关和歧义分支继续拒绝。绑定层返回本次是否真正跨摘要窗口，私有历史仅首次重建，后续继承最新映射，避免重复恢复到旧摘要。回归涵盖有/无 acknowledgment、重开后的原文精确读取与新映射保留、伪造/跨身份/跨目标/策略变更/撤回/撤权/到期和冲突分支。测试仍在统一 CI 入口。

供应商只新增 Anthropic 的精确 beta=true 路径，以及 HTTPS443、同 host、api-key 模式和 claude
profile 下 DeepSeek 的精确 /anthropic/v1/messages（含 beta=true）路径；额外查询、错 host/port/protocol/auth 和非法对象继续拒绝。对应扩展回归 61/61。

真实 Claude
v8/v9 首轮失败，v9 上游实际为 200/SSE；v10 原样转发公开响应后完成首次工具捕获，但后续恢复拒绝。安全结构诊断发现 usage.service_tier 为字符串；官方 Anthropic
SDK 明确定义 standard/priority/batch/null。新增精确枚举校验，不把档位计入数值汇总，只保留最终响应的合法档位；未知字符串、嵌套伪造和 accessor 仍拒绝。Claude
SSE 收集器另修复丢失 message_start 的 type/model/stop_sequence，并应用最终 delta 的 stop_sequence，空缺字段兼容旧 fixture，非法元数据拒绝。新增 JSON/SSE 往返、正常/空/非法/极端与安全回归 98/98，旧失败记录保留。官方类型来源：https://raw.githubusercontent.com/anthropics/anthropic-sdk-typescript/main/src/resources/messages/messages.ts
。

原生 Claude
v7 零模型通过三次实际压缩、真实 MCP 捕获一次、精确私下读取与答案、单根和无泄漏。两端新建全真实模型任务：Codex
v36=true（9 次请求），Claude
v11=false（6 次请求）。这些探针均经过恢复 HTTP 入口，并未覆盖完整 Core 或 Hook。

回执/绑定扩展回归 289/289；元数据修复前的标准完整客户端门禁 1275 项，1269 通过、3 失败、3 取消、0 跳过，291435.413ms。覆盖率语句/行 99.08%、分支 95.14%、函数 99.27%；容量资格、加密 owner 重开/启动等未通过。存储用例单独复核 21/21 通过，不替代完整门禁。原五档负载、两 worker、所有期限未改变。最终源码仅完成相关扩展回归，完整门禁没有宣称绿色；Lint、格式、语法、CI 清单、架构与发布清单检查通过。

当前真实模型预算 83/88，重复请求在探针网关拦截、不改日常配置、生产未激活。完整 Core
HTTP/WS/Hook、WBIPC 长历史事务、容量性能、迁移/旧版回滚、全仓门禁、24h 到期观察与空闲激活仍未完成，整体 active。

本轮机器证据：claude-receipt-outcome.json、claude-metadata-source-freeze.json、claude-receipt-expanded.log、claude-metadata-usage-expanded.log 与相应原生验收结果。

## 2026-10-21：Codex 工具历史边界、原生摘要格式与可选读取字段

新增 Codex
additional_tools 协议边界：普通生成把完整内嵌工具清单（含原生 id）纳入策略和精确历史；只有已识别的本地压缩可使用独立连续性指纹定位唯一已观察祖先。principal、target、instructions/system 与歧义拒绝保持；连续摘要收据使用独立索引并随根状态导出、重开、撤回和到期清理。持久化增加显式 identityFormat 标记，未知标记、跨协议和篡改拒绝；旧解析器的精确字段规则会拒绝新增状态，但尚未以真实旧版二进制完成降级验收。

原生零模型 v27 完成工具原文捕获、三次压缩、私下列目录/读取、后续请求精确原文与正确答案，且没有私有调用泄漏。v26/v27 证明探针使用 phase=final 会被当前原生客户端忽略；已支持并原样保留官方 final_answer（也支持 nullable
phase）。真实摘要形状 v33 进一步发现 output_text.logprobs；仅接受并保留空数组，非空概率、非法类型、accessor、签名/opaque 和混合工具响应继续拒绝，避免新增收据与 token 概率错位。

v34 全程真实模型执行 8 次请求，完成三次实际压缩，但最终模型只调用带 afterSourceId 的目录请求，未读回原文，保留 passed=false。官方文档说明 Responses 在省略 strict 时会尝试规范化为严格 schema；代理注入的两个读取函数现显式 strict=false 以保留原可选字段契约，不改外部工具，也不放松宿主参数验证。回归覆盖空参数、未知字段、非法游标、分页类型与上下界、必填 sourceId/digest 及其他协议。修复后 v35 用真实模型自行完成目录→读回→答案，3 次请求、精确原文字节、正确最终值与事件级隐私检查均通过；但 v35 的种子和三次摘要仍为合成响应，不能替代全程真实验收。v29 曾把用户回显误计为泄漏；原失败记录保留，v30 零模型通过事件路径证明同提示只在 userMessage 回显命中，未追溯改判 v29。

Claude
v3 零模型观察到无新对话时连续 /compact 只有一次实际压缩；v4 在压缩之间加入对话，完成三次摘要请求与三次 compact_boundary。该结果仅验证原生客户端命令/事件形状，不包含原文恢复、真实模型、Hook 或完整 Core 入口。另已只读验证生产能力检查当前拒绝 Anthropic 的 /v1/messages?beta=true 及现有 DeepSeek 的 /anthropic/v1/messages?beta=true；Claude 路由能力边界仍需精确修复和回归，尚未放宽供应商准入。

本轮先后扩展回归 92/92、93/93 与最新读取声明回归 118/118。首轮完整客户端 1270 项中 1267 通过、1 失败、2 取消；相同冻结源码仅将外层测试进程限制为 2 的诊断为 1270 项、1269 通过、1 失败、0 取消，容量资格仍在原 60 秒超时，32
MiB 加密重开在 163215ms 完成。该诊断没有进入 package/CI 配置；原五档负载、两 worker 和所有期限保持。最终 21 个源码/配置文件冻结后，标准完整客户端终态：1272 项，1265 通过、2 失败、5 取消、0 跳过，315205.9199ms；覆盖率语句/行 99.08%/99.08%、分支 95.14%、函数 99.27%。源码 SHA256 复核一致。

用户授权累计上限 64 次，目前 64/64，本轮新增真实请求 20 次；没有自动重试、修改日常模型/凭据、安装插件或激活生产。真实新任务在修复后的全程 Codex/Claude 精确恢复、完整 Core
HTTP/WS/Hook、WBIPC 长历史事务发布、容量性能、旧插件迁移/回滚、全仓门禁、24h 实际到期观察与空闲窗口生产激活仍未完成，整体 active。24h 样本仍沿原到期 2026-10-22T00:55:55.109Z，不重播种。继续使用统一预算账本；新增真实请求需追加授权。

官方依据：[assistant phase](https://developers.openai.com/api/docs/guides/reasoning)、[Responses 输出格式](https://developers.openai.com/api/reference/resources/responses/methods/create)、[函数 schema 默认语义](https://developers.openai.com/api/docs/guides/function-calling)。本轮证据：inline-tools-_-source-freeze.json、inline-tools-_-client.log、optional-reader-schema-expanded.log、real-codex-http-recovery-\*-v27/v34/v35-result.json、claude-native-compaction-synthetic-v4-result.json；最终机器记录 inline-tools-schema-outcome.json。

## 2026-10-21：省略 tools 的摘要识别修复，发现 additional_tools 历史边界

本轮先定位而未重发上一失败任务。新建 v14 真实诊断执行 3 次请求，确认原生压缩包含预期 checkpoint/handoff 提示、tool_choice=auto，但省略顶层 tools，导致旧分类器未识别摘要。累计账本 44/48，剩余 4 次；没有自动重试，也没有改日常配置或激活生产。v14 的 passed 仅表示诊断阶段完成，不代表恢复通过。

分类器现在接受省略或显式空数组 tools；显式 null、非空工具、错误选择器及非摘要继续拒绝。绑定与会话层重建内部摘要请求时省略内部 null 哨兵，避免规范化拒绝或错误策略冲突。重复收据窗口测试同时覆盖两种格式，并验证精确原文、多轮重开、单根及绝对到期时间。首次回归暴露绑定层尚未兼容的问题，修复后 3/3，完整绑定/摘要/协议/usage 扩展回归 67/67；Lint、格式、CI 与发布清单检查通过，测试仍在原统一 CI 入口。

v15–v20 使用真实原生客户端与本地合成 SSE 响应，均为零模型请求并已终止；这些实验不是真实模型验收。v16–v20 仍拒绝摘要祖先为 context_binding_compaction_unobserved，失败证据保留。无内容结构诊断观察到：原生请求首项 type=additional_tools、role=developer；压缩时该项工具由 3 个变为 0 个，同时 id 更换，其他已比较的字段不变。该差异足以改变现有精确历史指纹，但合成响应没有证实完整原生任务输出链，不能将其解释为唯一剩余原因。没有通过删除整项或宽松匹配绕过边界。

下一步需要将嵌入历史的工具策略纳入明确的 Codex 协议边界：普通生成保持完整工具策略与历史精确匹配；仅已识别的本地压缩可定位唯一已观察祖先，仍绑定 principal、target、instructions/system；摘要收据、歧义拒绝、持久化重开和旧读取器失败关闭必须同步验证。若新增祖先指纹字段，须显式处理持久化版本/降级兼容，不能挪用已有 echo 字段。之后才使用剩余额度验证实际原文进入后续上游请求与最终任务。

冻结 15 个源码/配置文件后完整客户端测试终态 exit
1：1263 项，1252 通过、4 失败、7 取消、0 跳过，耗时 341792ms；覆盖率语句/行 99.01%、分支 95.06%、函数 99.11%。11 个未通过项涉及加密冷恢复、两个入口启动、五档两 worker 容量资格、Windows 密文清理/ACL/启动/重开、32
MiB 四根重开及 source runtime
API；失败均记录原有超时，没有改变期限、负载、并发或跳过门禁。冻结 SHA256 全部复核一致。整体目标仍 active；WBIPC、真实多端精确恢复、性能/全仓门禁、24h 到期与生产激活尚未完成。证据为 omitted-tools-_.log/json、real-codex-http-summary-classifier-v14-result.json 及 real-codex-http-summary-native-local_-result.json。

## 2026-10-21：真实第二轮 usage 根因修复，完整恢复仍未通过

追加授权已记入账本，累计上限 48 次；本轮新增 17 次，目前 41/48，剩余 7 次。未自动重试，复用现有模型/凭据，日常配置及生产不变。v8/v9/v10 为独立结构诊断，只保存类型、字段名和计数是否合法，不保存原文、归因条目身份或凭据。

真实工具回传后的第二轮响应增加 usage.attribution.request_fields.tools，内容为四项非负安全整数计数。归因校验模块精确支持此已观察结构；未知字段、非法计数及 content 嵌套继续拒绝，归因仍从公开 usage 中剔除。新增边界回归进入现有统一 CI 测试文件；4/4 定向、89/89 扩展回归通过，模块语句/分支/函数/行覆盖率均 100%，Lint、格式、CI 与发布清单检查通过。

v11 隔离真实 Codex 工具调用、回传后第二轮校验、runner
release 与编码通过，2 次请求、原生进程已终止。v12 新任务连续三次真实压缩通过，5 次请求；这仍不证明精确私有原文恢复。v13 新的完整闭环探针发起 4 次请求后，在第二次压缩阶段 gateway_failed（该请求未取得响应状态），仅完成一次压缩，进程已终止；未自动重发，也未宣布最终任务/原文后续上游请求验收通过。

此前冻结的 1261 项完整门禁属于 usage 修订之前的源码；本次修订仅有上述定向验证，不能继承为完整最终门禁。当前完整目标仍 active，容量、冷恢复/启动、32
MiB 重开、WBIPC、真实多端精确恢复与 24h 到期/生产激活仍待完成。证据为 request-fields-\*.log、real-codex-http-usage-shape-v8/v9/v10-result.json、real-codex-http-usage-fixed-v11-result.json、real-codex-http-compaction-fixed-v12-result.json 及 real-codex-http-recovery-fixed-v13-result.json。

## 2026-10-21：WebSocket 延迟加载与冻结源码完整验证（整体未通过）

新增独立 lazy-websocket-proxy 模块，主入口保留共享生命周期及实时配置 getter，仅在首次 upgrade 加载 WebSocket 实现。初始化失败返回空 503，仅记录固定错误码；成功初始化缓存，实际处理器的参数、接收者及返回值保持。新增 4 项定向回归通过，覆盖真实 HTTP
upgrade 失败、安全日志、延迟加载、认证轮换及实际模块入口；扩展传输/生命周期/架构回归 101/101（第四项随后单独通过）。Lint、格式、CI 与发布清单检查通过。

冻结源码 lazy-ws-source-freeze-v2.json 的 9 个文件 SHA256 已复核一致。完整客户端门禁 1261 项，1256 通过、3 失败、2 取消、0 跳过，总耗时 332135ms。五个未通过项：加密 worker 冷恢复 30 秒超时、两个入口启动 15 秒超时、原五档两 worker 容量资格 60 秒超时、四根 32
MiB 历史重开 180 秒超时。覆盖率 statements/lines 99.06%、branches
95.09%、functions
99.27%。独立启动用例 2/2 通过不代表完整门禁下启动达标；未修改负载、并发或期限。

内容无关编码诊断记录 192 轮/四根/每根 40 次读回，耗时 11018ms，仅用于定位；另一项 scalar-layout 实验 12944ms 对比基线 12990ms 无有意义改善，已字节恢复。未保留指纹算法优化，未把小负载诊断作为容量资格。

用户已明确追加最多 24 次真实模型请求，统一账本累计上限从 24 调至 48；沿用现有模型和凭据、不自动重试、不改日常配置。后续先采集真实第二轮 usage 的无内容结构，再决定修复。生产未激活；WBIPC 事务压缩、真实多端恢复、完整门禁和 24h 到期观察仍待完成。证据位于 .hpm-acceptance/context-plugin-vault-20261021-01，整体目标保持 active。

## 2026-10-21：容量性能采样与两项撤回实验（门槛未变）

沿用现有实现，对四任务候选档执行 192 轮、每根 40 次读回的独立诊断，完成 768 次写入并精确读回；此诊断不替代原五档、两 worker、60 秒容量资格门禁。未采样基线单次耗时 12990ms，CPU 采样基线为 15191ms。采样定位到请求内编码函数，JSON.stringify 所在线 826 个采样 tick、字符串缓存查询所在行 295 个 tick；还包括校验、哈希和检查点往返，尚不能把容量超时归因于一个函数。

实验一通过完整当前文本的校验和复用旧规范指纹，41 项局部回归通过，但同规模诊断为 24124ms；实验二将请求内字符串缓存改为 FIFO，诊断为 17192ms。两项均未证明提速，已经撤回；新增实验模块和测试从工作树移除，原 package 命令、发布清单及公共窗口源码恢复，原绑定回归 38/38。仅保留诊断结果及 CPU 采样证据，不将较小负载的通过写为容量达标，也未改变负载、并发或超时。

本轮 0 次新增模型请求，账本仍为 24/24，追加额度尚未收到答复。真实第二轮 usage 差异、完整多端恢复、启动及容量门禁仍未通过；生产不变，整体目标保持 active。下一步继续沿序列化/验证调用次数定位，避免用额外哈希或缓存策略猜测替代实测。证据在同目录 capacity-profiling-outcome.json 和 capacity-diagnostic-192\*.json/cpuprofile。

## 2026-10-21：真实 HTTP 原文捕获修复与 usage 边界，整体尚未验收

本批累计真实模型请求 24/24（含失败请求），已到用户授权上限；未自动重试、未改日常模型/凭据配置、未激活生产。后续真实请求必须先获追加额度。所有本批原生探针已终止。

真实 Codex 使用 Code
Mode：外层 custom_tool_call 的 call_id 不同于客户端内层工具调用 ID；原文返回为 custom_tool_call_output.output 数组。原生回显会省略 metadata 和 internal_chat_message_metadata_passthrough 两个服务端字段。新增 context-responses-observed-echo.js，仅由独立观察到的服务端输出生成精确备用指纹；入站历史不做宽松投影，原始输出/原文保持完整。绑定、选择、现代私有历史窗口和持久化恢复支持该指纹。v3/v4 实测从两根分裂修复为单根，并观察到 visibleSources=1、24245 字节原文捕获。摘要收据允许受限 metadata/phase，仍拒绝签名与 opaque 内容。

官方 usage.attribution 是输入条目级重复计数，包含条目身份和 content 数组；新增独立校验模块，合法结构不会进入汇总计量或公开 usage，避免重复计费统计及私有条目 ID 泄漏。保持未知/非法计数与可执行对象拒绝。真实首轮 usage 校验与 JSON/SSE 编码已通过诊断，但工具结果回传后的下一轮 usage 仍拒绝，runner 记录 context_recovery_invalid_turn；尚未查清该轮具体差异，不能据此认定恢复链路通过。最后单次诊断使用合成的已有工具调用/数组结果，只支持字段结构诊断，不算真实任务验收。

本轮验证：定向回归 197/197、插件打包/存档测试 16/16；最新新增模块定向覆盖率 statements/lines/functions
100%，branches
98.36%；Lint、CI 配置与发布源码清单检查通过。插件运行闭包重新构建为 25 个模块，没有安装到日常客户端；旧存档升级/回滚的通过结论只对应原固定包，不能扩展为本次新增代理模块的原生回滚/Hook验收。

最新完整客户端运行 1257 项：1255 通过、2 失败、0 取消、0 跳过；覆盖率 statements/lines
99.06%，branches 95.09%，functions
99.27%。仍失败：原有 15 秒启动期限与 60 秒容量资格测试。 独立运行同一五档/两 worker 容量命令也于 60103ms 触发原 60 秒超时，不能归因于覆盖率并行负载。该完整运行期间 attribution 路径校验有后续局部修订，最后源码仅经上述定向验证，仍须完成一次源码冻结后的完整门禁。此前 1254 项运行的 4 失败/2 取消与更早失败证据均保留，没有加长超时、删减五档负载或更改两 worker 配置。

边界与后续：旧二进制可能拒绝新增 echo 指纹字段，旧读取器降级兼容未验收；现代窗口路径支持别名，旧逐项前缀路径不因此获得等价支持。仍待真实 Codex/Claude 三次压缩后精确读回、完整 core
HTTP/WS、插件与真实 Hook、WBIPC 事务压缩、启动/容量性能及源码冻结后的全仓门禁。24h 到期样本保留原到期时间 2026-10-22T00:55:55.109Z，尚未到期，不重置样本。

证据：.hpm-acceptance/context-plugin-vault-20261021-01 下 real-codex-http-recovery-v3/v4/v5-result.json、real-codex-http-usage-diagnostic-result.json、real-codex-http-compaction-v6-result.json、real-codex-http-stages-v7-result.json、real-codex-http-tool-array-diagnostic-v4-result.json、real-model-budget.json 与 echo-usage-outcome.json。完整目标保持 active，未宣称整体完成。

## 现有凭据真实客户端基线：连通通过，Codex 三次本地摘要连续性已观察，代理恢复未验收

用户已授权复用现有模型/凭据，以新建合成任务最多发起 24 次真实模型请求、不自动重试并保留日常配置。本批统一账本 real-model-budget.json 已计 8/24 次，包括失败请求；所有原生进程确认终止，凭据仅在内存转发，没有写入临时配置或普通输出。逐阶段转发门禁拒绝第二次请求，未将客户端重试再次转发。

Claude 保持 deepseek-v4-flash，Codex 保持 gpt-6.1-sol；两者真实原生客户端生成及精确合成标记回答通过。首个 Claude 探针重复拼接 /anthropic 导致上游 404，1 次真实请求计入总额；客户端第二次尝试被本地门禁拦截。该失败原样保留。修正后的新合成任务 exit
0、1 次尝试/转发、HTTP
200。新增 scripts/lib/claude-acceptance-target.js 明确只允许 DeepSeek Anthropic
messages 路径，正常/空/非法/极端/越界与敏感查询拒绝回归 2/2，通过统一 unit 自动发现；Lint、格式、check:ci 和 release:check 通过。

Codex app-server 真实合成线程执行 seed → compact-1 → compact-2 → compact-3 →
final，共 5 次转发、均 HTTP
200，原生 turn 均 completed，观察到 3 个 contextCompaction 完成项，最终准确返回压缩前标记。实际走 /responses 本地摘要路径，未走 /responses/compact；原探针要求远程 compact 的 passed=false 与 compactionVerified=false 原样保留。这只支持“三次真实本地摘要压缩后标记连续性”的分项结论，不支持远程 opaque
compact 通过，也不证明代理私有原文读取、插件恢复、Hook 执行或多端无感恢复完整验收。

证据位于 .hpm-acceptance/context-plugin-vault-20261021-01：real-claude-baseline-result.json、real-claude-baseline-v2-result.json、real-codex-baseline-result.json、real-codex-native-compaction-result.json、real-codex-native-compaction-phases.jsonl、real-model-budget.json、real-acceptance-outcome.json。仍待代理原文精确进入后续上游请求/最终任务、Claude 连续压缩、插件/Hook、WBIPC 双预算、容量/启动/存储压力门禁和真实 24h 到期。整体目标保持未完成，生产未激活。

## 独立存档原生升级与回滚验收通过，实际加载版本已确认（整体未完成）

隔离 Codex 原生安装及 app-server 验收确认加载版本 0.1.1 → 诊断 0.1.2 →
0.1.1。初装 30522ms、活动升级 37958ms、回退 37346ms，均在原 60000ms 安装期限内完成。两个活动线程在升级/回退后精确 Unicode/CRLF 原文和绝对到期时间保留，升级后及回退后新线程独立捕获/读回通过。诊断 0.1.2 只用于版本观察，不是产品发布。

自有临时 marketplace 源被物理删除后，从固定 SHA256 存档恢复并完成原生回退；原生安装器仍清理了退役 0.1.2 缓存，该历史完整性门禁仍为 false。独立存档再次恢复校验通过，因此回滚来源无需依赖退役缓存。首次探针因未观察到版本而终止，未执行升级/回退；v2 仅在隔离 MCP
launcher 显式传入观察环境，以握手版本作为断言，没有放宽版本门禁。

证据 .hpm-acceptance/context-plugin-vault-20261021-01/native-vault-v2-result.json 与 native-vault-v2-phases.jsonl；原生进程确认终止。0 次模型请求，未变更日常配置或生产。实际 Hook、真实模型连续恢复、旧 0.1.0 首次迁移、容量/启动/存储压力门禁、WBIPC 和 24h 到期仍待完成，不能据此宣布整体交付。

## 插件独立回滚包存档落地：真实整包删除后恢复与启动通过，原生回退验收仍待完成

新增 scripts/lib/local-evidence-plugin-vault.js，以完整文件清单和 SHA256 为寻址身份，在原生可清理缓存之外保存运行包。安装脚本在调用原生 marketplace/add 之前保存待安装包，并在回执记录 snapshotId、版本、文件数与大小；原有日常一次性安装 guard 保留，本轮没有执行日常安装。

存档包含运行模块、SDK 与依赖文件，检查三个包版本身份、lock/SDK 身份及完整 runtime
closure；拒绝符号链接、硬链接、未声明根目录、路径越界、缺失/篡改/额外文件、非法 JSON、过深结构和超大文件。文件读取按已检查大小分配有界 buffer，单文件 16
MiB、整包 128
MiB、16384 文件、32 层。先构造并验证独立暂存目录再发布；恢复拒绝覆盖已有目标，写入失败清理本次拥有的暂存目录并返回固定错误，不输出原始路径或内容。

新增 6 项边界/安全/失败回归由统一 unit 自动发现；局部覆盖率语句/行 99.25%、分支 97.67%、函数 100%，门槛通过。与原 MCP/整包删除用例合跑 20/20。Lint、格式、check:ci 与 release:check 通过。没有重跑并声称整体客户端或全仓门禁通过：上一轮完整客户端 1233/1244、5 失败和 6 取消仍保留，容量/启动/存储压力问题没有因包存档而解决。

实际整包探针使用当前暂存 0.1.1，保存 3690 文件、17291656 字节，物理删除自有临时源副本，再从固定 snapshotId 恢复。真实 restored/server.cjs
stdio 握手确认加载版本 0.1.1，Unicode/CRLF 精确原文读回及异线程拒绝通过，transport 已关闭、命令 exit
0。此证据只证明独立包来源可恢复并运行，不证明原生 Codex 已从存档完成升级回退，也不关闭旧 0.1.0 首次迁移、Hook 或真实模型恢复验收。旧原生退役缓存完整性失败没有删除或改为通过。

该存档保存插件程序包，插件证据 fallback 仍为 memory-only
30 分钟；它没有把插件改成代理的 24h 加密原文存储，也没有迁移或读取用户原文、凭据、日常客户端配置。WBIPC 仍缺会话发布事务内的双预算压缩/恢复；不能仅放宽 32
MiB 入口而称已落地。

证据 .hpm-acceptance/context-plugin-vault-20261021-01：coverage.log、coverage/coverage-final.json、expanded.log、actual-package-result.json、ci.log、release.log、outcome.json 与源码哈希。本段插入前原文独立备份并逐字保留。整体目标继续，生产未变更。

## 新启动器当前源码完整客户端门禁：1233/1244，整体未通过

原 npm run
test:client:coverage 已结束：1233 通过、5 失败、6 取消、0 跳过；测试 323787.6374ms。语句 98.78%、分支 95.02%、函数 99.1%、行 98.78%。没有修改源码、并发量、负载、期限或覆盖率门槛来改变本轮结果。

未通过项目：

- actual isolated proxy captures Chat/Responses/Claude JSON and SSE, then serves
  exact evidence through generic MCP
- qualification command distinguishes capacity refusal from execution error
- actual encrypted worker startup removes orphan staging and retains committed
  evidence across reopening
- encrypted worker reopen continues writing after an uncertain publication
  without exposing its source
- encrypted worker reopens four full session roots with 32 MiB of exact private
  history
- standalone release uses only packaged files and builtins, reads exactly and
  exits on EOF
- source runtime API discovers tools, executes once and owns downstream cleanup
- source runtime API startup failure closes transport and exposes a fixed error
- actual startup credential failure drains recovery before reporting failed
  process exit
- actual management listener rejects requests while credentials are pending and
  opens entries only after acknowledgement
- core target detection defers protocol-specific validators but the first
  matching request still validates

本轮完整门禁不能替代为前轮 1241/1242 或局部 14/14。启动、容量、存储的压力稳定性仍需修复；原生升级/回退仍保留退役缓存完整性失败及真实加载版本、Hook、模型验收边界。local-evidence-plugin-package 回归由统一 unit 发现并执行，不在当前显式 test:client:coverage 文件列表；不能把本轮完整客户端门禁说成也执行了整包物理删除回归。该回归单独结果保留在本目录 regression.log/coverage.log。

证据 .hpm-acceptance/context-plugin-cache-release-20261021-01/full-client-coverage.log、独立 full-coverage-final.json 与 full-outcome.json，含覆盖源码/测试/package
SHA256。本段插入前另存 full.before 并逐字保留原尾部。无模型请求、日常插件或凭据变更、生产重启；整体目标继续。

## 新启动器跨版本原生探针：活动升级与回退读写通过，退役缓存完整性失败（整体未交付）

隔离 Codex 中以当前待发布 0.1.1 为基线，构造仅版本身份不同、其他行为相同的诊断 0.1.2，再切回 0.1.1。诊断版本只存在于隔离 marketplace，不是产品发布。初装 18767ms、活动升级 41431ms、活动回退 41267ms，原安装命令 60000ms 期限均未改变，全部 exit
0；升级目录发生变化，目标安装闭包 25 模块校验通过。

旧活动线程精确 Unicode/CRLF 原文和原到期时间保留；升级后新线程独立捕获/读取成功；回退后两个活动线程原文/到期时间保留，最终新线程捕获/读取成功。仅证明显式私有 RPC 和目标包身份，不证明真实 Hook、模型恢复或新线程实际加载版本身份。

最后保留原退役包完整性门禁：安装器已清理诊断 0.1.2 的 server/manifest，因此探针在 retired_cache_integrity 断言失败、整体 exit
1。没有删除或弱化该断言来宣称完整升级回滚通过。后续需要由我们维护独立、校验过的回滚包来源，不能依赖原生可清理缓存；旧日常 0.1.0 进程尚有 cwd 锁的首次迁移也未解决。

证据 .hpm-acceptance/context-plugin-cache-release-20261021-01/native-version-result.json、native-version-phases.jsonl、native-version.cjs 与 version-outcome.json。原生进程已确认终止，无模型请求、日常安装/凭据变更或生产重启。当前源码完整客户端门禁另在执行，本段不预判其结果。

## 插件释放 Windows 缓存目录占用：回归 14/14，原生同版本重装通过（整体未交付）

实际 stdio 插件以缓存目录作为 cwd 时，删除整个运行包稳定触发 EBUSY。新增独立启动 helper，先加载模块并创建 runtime，再切换到系统临时目录，最后连接 stdio；普通 factory 使用者不改变 cwd。启动输入拒绝未知字段、访问器与非法函数，失败统一安全错误并尝试关闭 session。主入口只负责装配。

新增真实整包删除回归：含 node_modules 的完整暂存包在进程活动时被物理删除，旧 Unicode/CRLF 原文仍精确读取、新捕获可用、原绝对到期时间不变、异线程拒绝。修复前真实 EBUSY，修复后回归及扩大失败路径覆盖均 14/14；MCP 模块语句/行/函数 100%，分支 90.32%。待发布 0.1.1 的 25 个模块逐一与源码和 manifest 匹配。相关 Lint、格式、check:ci、release:check 在前轮通过；当前新源码完整客户端门禁仍需重跑。

实际隔离 Codex
CLI/app-server：初装 17002ms、活动同版本重装 55232ms，均在原 60000ms 期限内 exit
0；最终包完整，活动线程原文与到期时间保留，新线程捕获和精确读取通过。此原生重装证据没有 sentinel/inode 检查，不能证明安装器实际替换同版本缓存；物理删除证据来自独立回归，不能据此宣布跨版本升级回滚或 Hook 执行成功。

证据 .hpm-acceptance/context-plugin-cache-release-20261021-01：baseline.log、regression.log、coverage.log、独立 coverage/coverage-final.json、native-reinstall-result.json、native-phases.jsonl 与 outcome.json。没有模型请求、日常插件/凭据配置变更或生产重启。旧 0.1.0 进程不能追溯释放 cwd，首次迁移和跨版本回滚仍待验收；容量 60s、WBIPC 双预算、真实模型连续恢复、24h 到期及生产激活继续属于完整交付范围。

## 最新分页边界修复与完整门禁：1241/1242，剩余容量 60s 超时（2026-10-21 UTC；整体未交付）

修复实际可复现的页长选择错误：payload 100001 字节、offset 99990、limit
11、预算恰好容纳末页时，旧二分搜索只返回到 99999；因为末页 nextOffsetBytes=null 使编码大小不再严格递增。现在先检查最大候选，保留可完整放下的末页。

分页大小改为精确的小 header 加 UTF-8 文本双重 JSON 编码成本，普通文本直接计字节，转义文本使用本次至多 64
KiB 页范围的有界前缀计数。仍逐次选择合法 UTF-8 边界，返回前对真实 chunk 计算 SHA256，不将用于计尺寸的 digest 占位值作为结果。没有修改页大小、读额度或返回预算。新增全部 ASCII 字符、Unicode/控制/转义、空页/EOF、每一预算值与穷举合法 UTF-8 边界的独立 oracle 比对，以及真实 EOF 回归，直接进入统一客户端覆盖率和 unit 自动发现。

扩大回归 60 项中 59 通过，唯一失败为原容量子进程 60s 超时；分页模块语句/分支/函数/行覆盖率均 100%。候选局部对照显示普通文本和转义文本分页明显减少序列化成本，不能等同整体任务提速。Lint、格式、check:ci、release:check 通过。待发布插件 0.1.1 重新构建后 25 模块都与当前源码/manifest
SHA256 一致；这不是日常安装或实际新版 Hook/模型验收。

最新完整 npm run test:client:coverage 已终止 exit
1：1242 项中 1241 通过、1 失败、0 取消、0 跳过，测试执行 280618.7146ms。覆盖率语句/行 99.05%、分支 95.05%、函数 99.26%，门槛通过。本次实际代理启动、暂存清理及三次加密 worker 重开均通过；32
MiB 四根精确私有历史加密重开 162742.7648ms，通过原 180s 期限，仅证明本轮结果。唯一失败仍是原五档、两个 worker 容量资格命令触发原 60000ms
ETIMEDOUT，未用局部提速代替该门禁。

证据 .hpm-acceptance/context-page-sizing-20261021-01：旧包模块 page.before.js 与旧 manifest 匹配；comparison-v2.json、scoped/scoped-v2.log、expanded.log、完整 full-client-coverage.log、独立 coverage-final.json 和 outcome.json；回执含当前覆盖源码/测试入口/package 的 SHA256 与插件全部 25 模块校验。本段插入前原文备份并逐字保留。

整体仍待容量期限、WBIPC 双预算恢复、实际 Codex/Claude 连续原文恢复与 Hook、插件迁移回滚、真实 24h 到期和生产激活验收。本轮没有模型请求、日常凭据/插件安装变更或生产重启；不能宣布全面交付。

## 最新容量性能迭代：单元素安全克隆已验证，60s 门禁仍未通过（2026-10-21 UTC；整体未交付）

对恢复历史准入的单元素嵌套数组使用 array literal 创建 own data
slot，保留每槽 descriptor、原型、key 数、循环、深度、共享节点、单项 2
MiB 与总字节门禁；不调用继承数字 setter。原多元素和未知结构继续走既有完整校验。新增 exact
Unicode/CRLF、独立冻结副本、深度边界、own
accessor/iterator、隐藏槽、伪装空洞、循环、字节溢出及隔离子进程 index-zero
setter 回归，直接进入已有统一 CI 的 context-binding 测试文件。

相关绑定/会话覆盖率回归 83/83：修改模块语句/函数/行 100%、分支 98.07%，阈值通过；Lint、格式、check:ci 与 release:check 通过。包含原容量资格命令的扩大回归 93 项中 92 通过、1 失败、0 取消/跳过；唯一失败仍是原 60000ms
ETIMEDOUT。之前 1237/1238 完整门禁保留在下方，但它不是本次新源码的完整覆盖率验收。

重新对原五档和原两个 worker 的容量命令做 CPU 诊断：全部画像结束，最大档 1920 轮、400 次精确恢复、20 次 JSON 重开及最终 drain 完整；本次采样总时长 62651.631ms，最慢 worker
62249.427ms。诊断没有把超过 60s 的结果算作期限内通过，也不代表 transport/durable/model 验收。旧采样约 88.7s 与本次 62.7s 的差异同时受代码和系统负载影响，不归因为单个小优化。当前仍需容量提速，不能宣布全面完成。

另有 .hpm-acceptance/context-encoding-token-20261021-01：请求内编码 token 复用候选摘要相等，但交替基准无稳定收益，未应用运行代码；同目录保留改动前原容量 60s 单独失败证据。单元素候选交替基准、初始深度测试断言失败与修正后结果、当前 CPU 原件、cpu-summary.json、coverage/coverage-final.json、regression.log 和当前源码 SHA256 回执存于 .hpm-acceptance/context-single-array-20261021-01。

未改变五档负载、两个 worker、容量/存储/启动期限或覆盖率门槛；没有模型请求、凭据或日常插件改动、没有生产重启。整体仍包含 WBIPC 双预算、实际 Codex/Claude 连续恢复与 Hook、迁移回滚、真实 24h 到期和生产激活等未完成验收。

## 最新完整客户端门禁：1237/1238，剩余五档容量 60s 超时（2026-10-21 UTC；整体未交付）

恢复状态克隆优化后，按当前源码再次执行原 npm run
test:client:coverage，prepare、并发量、两个容量 worker、全部画像、期限与覆盖率阈值均保持原值。进程已终止 exit
1：1238 项中 1237 通过、1 失败、0 取消、0 跳过；测试执行 284678.9037ms。覆盖率语句/行 99.04%、分支 95.01%、函数 99.26%，覆盖率门槛通过。

上一轮四处未通过中，本次实际 Chat/Responses/Claude 代理与 direct-upload 均通过原 15s 启动门禁；首次真实请求分别 2835ms、2115ms。暂存清理及三次加密 worker 重开 18557.9696ms，四个完整 session
root 的 32 MiB 精确私有历史加密重开 173483.4748ms，通过各自原 30s/180s 期限。32
MiB 仍接近上限，且这些是本次结果，不能据此宣称压力稳定性已验证或把多次运行差异全部归因于克隆优化。

唯一失败仍是 qualification command distinguishes capacity refusal from execution
error：保留五档画像和两个 worker 的容量资格子进程约 60150ms 触发原 60000ms
ETIMEDOUT。下一步继续针对容量真实热点优化，不缩减负载或改超时制造通过。当前整体还包含 WBIPC 双预算恢复、实际 Codex/Claude 多轮原文恢复/Hook、插件迁移回滚、真实 24h 到期与生产激活等待完成，不能把 1237/1238 当作全面交付。

证据：.hpm-acceptance/context-root-cpu-20261021-01/full-client-coverage.log、coverage-final.json、full-outcome.json（覆盖源码/统一测试入口/包脚本当前 SHA256）。本段插入前原文另存 .full.before 并逐字保留。本轮模型请求为 0，没有改日常凭据、安装插件或重启生产。

## 最新恢复状态克隆优化：扩大回归 168/168，完整并发待重验（2026-10-21 UTC；整体未交付）

对原 32
MiB 四根历史真实加密重开做 CPU 采样，单独用例通过，107684.5072ms。主线程和两次存储 worker 的采样中，恢复状态 clone 合计 self 约 26.6s，是最大的应用代码热点。完整 CPU 原件和摘要保存在 .hpm-acceptance/context-root-cpu-20261021-01。

恢复状态数组克隆改用 null-prototype length carrier 的 Array.from own
data-slot 构造，保留源数组原型、own-key、逐槽 data
descriptor、递归深度、共享节点与精确 JSON 字节校验。不会通过继承数字 setter 或调用者/继承 iterator 构造内容；不新增全局原文缓存。新增继承 iterator、伪装空洞、隐藏槽与访问器、空数组字节边界回归，纳入既有统一 CI 测试文件。局部交替基准中位 45.40→35.48ms，约 21.8% 改善，仅代表克隆基准。

实际 root-state、storage、storage-service、lifecycle、private-capacity 五个文件扩大回归 168/168，通过且无跳过或取消，156703.4291ms；其中 32
MiB 四根历史重开 106882.758ms、暂存清理及三次重开 12154.0915ms。另有六项针对性回归、相关 Lint/格式、check:ci 与 release:check 通过。此处扩大回归不等同完整客户端并发：没有宣称端到端提速、容量 60s 或启动 15s 已修复，下面保留最近完整门禁的四处未通过记录。

证据含 scoped.log、CPU 原件、cpu-summary.json、clone-comparison.json、normalizer.log、regression.log、改动前源码及 outcome.json 的当前源码 SHA256。未改期限、容量画像或 worker 数；未调用模型、改日常凭据/插件或重启生产。整体目标仍待完整并发和多端实际模型、WBIPC 双预算、迁移回滚、真实 24h 到期及生产激活验收。

## 最新完整客户端门禁：延迟 core 初始化后 1232/1236 通过（2026-10-21 UTC；整体未交付）

主入口通过独立 lazy
core 工厂推迟请求处理模块加载；恢复生命周期仍在启动阶段组合。首次请求保持原来的认证、验证和分发，初始化失败可重试。新增回归已进入统一客户端覆盖率入口；局部扩展验证 13/13，Lint、格式、CI 入口检查和发布清单检查通过。

完整并发 npm run test:client:coverage 已终止，exit
1：1236 项中 1232 通过、2 失败、2 超时取消、0 跳过，测试执行 310705.7957ms。覆盖率语句/行 99.04%、分支 95.01%、函数 99.26%；覆盖率通过不代表行为门禁通过。

四处未通过：实际 Chat/Responses/Claude 代理启动 15s、五档容量子进程 60s、孤立暂存清理及加密 worker 三次重开 30s、四个完整 session
root 的 32
MiB 私有历史加密重开 180s。所有期限、画像、两个 worker 和并发量保持原值。direct-upload 本次启动 11007ms、首次请求 2316ms；其中延迟 core 加载约 1974ms。该样本只证明真实请求执行到了延迟模块，不能证明并发启动已修复。

证据目录 .hpm-acceptance/context-startup-lazy-core-20261021-01：完整日志、coverage-final.json、outcome.json、局部 expanded.log 及 lint.log。outcome 记录覆盖源码和测试入口的当前 SHA256；本段插入前原文已备份并逐字保留。模型请求为 0；未修改日常凭据、插件安装或重启生产。下一步按完整门禁暴露的阶段瓶颈继续处理，整体仍待性能、WBIPC 双预算、真实客户端/Hook、回滚与真实 24h 到期验收。

## 最新回滚候选：新目录恢复旧行为可保留活跃读回，但旧缓存仍不完整（2026-10-21 UTC；整体未交付）

在全新隔离环境中，将真实 0.1.0 的 13 个模块制作为仅用于诊断的 0.1.2 包：12 个模块逐字节不变，MCP 模块仅将握手版本标识从 0.1.0 改为 0.1.2；同步调整包身份和清单摘要，没有修改日常安装包、源码行为或生产配置。该诊断包不是正式发布版本，也不是当前 0.1.1 的后续交付包。

原生 CLI 安装 0.1.0、升级 0.1.1、安装旧行为的新目录 0.1.2 分别约 30089/40836/37138ms，均在原 60000ms 安装期限内成功。各安装的独立 stdio 握手版本均验证；切换后原有 0.1.0 与升级后新建的两个活跃会话均仍可精确读取其原文、expiresAt 不变。它们都属于隔离私有 RPC 的合成证据，没有真实 Hook 或模型调用。

最终完整性门禁失败：0.1.0、0.1.1 目录仍存在，但 server.cjs 与 runtime-manifest.json 均已消失；只有诊断 0.1.2 的 13 模块仍完整匹配清单。新版本目录安装也不能保证旧缓存文件保留，之前的 oldCacheRetainedAfterUpgrade 仅检查目录存在，不足以证明缓存可重用。当前证据不能确定每个旧文件具体在哪一次安装被清除；不据最终状态杜撰删除顺序或原生内部实现。

结论仍为整体回滚不通过：本次只证明两代已运行的内存会话在切换后读回连续，不能证明惰性依赖、进程重开、实际 Hook 或新模型请求都安全。探针按原门禁在完整性失败处停止，没有执行后续新回滚线程验收。下一步需解决服务进程工作目录与安装缓存的生命周期耦合，并验证运行期间移除旧包时模块可用性；不能只靠递增版本号或跳过完整性检查交付。

证据：.hpm-acceptance/context-plugin-forward-rollback-20261021-01/ 下 migration-v5-result.json、phases.jsonl、outcome.json。失败终态及隔离目录保留；各原生子进程已退出、日常 0.1.0 模块哈希仍匹配原清单。当前覆盖源码和测试文件仍匹配上一轮完整门禁回执：1230/1233，剩余两项启动和一项容量超时；没有修改运行代码来试凑通过结果。容量、WBIPC、实际客户端和其他完整目标继续保留。

## 最新完整客户端门禁：1230/1233 通过，剩余启动与容量超时（2026-10-21 UTC；整体未交付）

按当前源码重新执行 npm run
test:client:coverage，含原有 prepare 与完整并发，1233 项中 1230 通过、3 失败、0 取消、0 跳过，测试执行 258639.8836ms，进程 exit
1。覆盖率阈值通过：语句/行 99.04%、分支 95%、函数 99.25%；覆盖率通过不抵消行为测试失败。

之前未通过的孤立暂存清理/加密 worker 重开，以及四个完整 session root 的 32
MiB 私有历史加密重开，本次都在完整并发下通过。这只记录该次结果，不删除此前失败或声称压力稳定性、真实客户端和生产已经验收。

剩余三个失败：实际隔离 Chat/Responses/Claude
JSON+SSE 代理与 direct-upload 代理各触发原 15000ms 启动期限；五档原容量资格命令触发原 60000ms 子进程期限。没有改变五档画像、两个 worker、并发量、容量和存储期限或覆盖率门槛。一次启动已到 module_graph_ready 约 13.1s、servers_created 约 14.9s，尚需完成安全凭据落盘和监听，不能靠缩减健康检查或延长期限宣称修复。

证据：.hpm-acceptance/context-client-current-gate-20261021-01/client-coverage.log、独立保存的 coverage-final.json 与 outcome.json；回执包含当前覆盖源码和客户端测试入口文件 SHA256。另有 .hpm-acceptance/context-fingerprint-buffer-20261021-01/comparison.json：局部摘要分块候选在长历史上仅约 2% 改善，未应用到运行代码，不能算容量修复。日常配置、插件和生产未因本轮门禁改动；整体仍待性能修复、实际 Hook/多端模型、WBIPC 双预算、回滚和真实 24h 到期等验收。

## 最新回滚定位：活跃旧缓存重装失败并留下不完整目录（2026-10-21 UTC；整体未交付）

补充带阶段计时的隔离验收：同步 CLI 演练在升级阶段达到原有 60000ms 安装期限，尚未到回滚。另起全新隔离环境，用异步管道持续消费活跃 app-server 输出，保持同一 60000ms 安装期限；旧版安装 21503ms、升级 42599ms 成功，已安装 stdio 身份握手、升级前原文精确读取和原 expiresAt 保持、新线程独立读取适配均通过。不能据此认定同步阻塞是前一轮超时的唯一原因。

这次活跃回滚在安装 CLI 内经过 28498ms 返回 exit
1，非超时，也未进入回滚握手。只保存错误词类 cache/used，不输出原始诊断。失败后只读检查发现 0.1.0 目录仍存在，但 server.cjs 与 runtime-manifest.json 均已消失；0.1.1 的 25 个模块仍全部匹配清单。因此目录存在不等于旧版本可用，不能采取未经验证的旧缓存复用或把失败当成无副作用。

独立 Windows 对照用自有子进程占用自有空目录作为 cwd：非递归 rmdir 返回 EBUSY，观察子进程退出后相同空目录可以删除。这支持 cwd 占用机制与上述原生失败相容，但尚未取得原生系统调用级因果证明，不把对照误写成原生错误码。失败后活跃旧会话是否仍可读未继续验收，不作保留成功声明。

回滚约束：不得在活跃宿主仍使用目标旧缓存时原地重装该版本。后续交付需要受控退出后的冷态恢复，或宿主支持且经过验收的不覆盖缓存切换；目前后者未实现、未验证。受控退出会丢失旧插件的内存证据，因此不能据冷态安装通过声称旧会话连续性或 24h 加密持久化兼容。代理新版本加密 root 的保留、权限、到期及关闭恢复后回滚仍须独立验收；不要清除新 schema 或延长旧记录期限。

证据：.hpm-acceptance/context-plugin-active-rollback-20261021-01/migration-v3-result.json，以及 .hpm-acceptance/context-plugin-async-migration-20261021-01/ 的 migration-v4-result.json、phases.jsonl、failure-inspection.json、cwd-control.json、outcome.json。所有相关子进程均观察到终态，没有模型生成请求、凭据传递、日常配置改动或生产重启。日常旧插件 13 个模块哈希与先前清单一致，源码仍匹配此前 60/60 门禁所记录哈希；本轮没有新增完整代码门禁通过声明。实际 Hook、客户端三次连续压缩、性能/容量/并发存储、WBIPC 双预算和真实 24h 到期要求继续未完成。

## 最新原生验收：隔离 Codex 安装和升级读取通过，活跃回滚未通过（2026-10-21 UTC；整体未交付）

使用当前 Codex 0.160.1 原生 plugin
marketplace/add 与 app-server，在新建隔离 CODEX_HOME 中安装 0.1.1：25 模块逐文件匹配当前源码及清单，实际已安装 server.cjs 的 stdio 握手版本为 0.1.1。原生宿主发现的模型可见工具仅为两个读取工具；通过宿主私有 RPC 注入合成完成事件后，精确换行/Unicode 读取与第二线程拒绝读取通过，新会话初始为空，相关原生子进程退出已观察到。

这仍是原生安装/MCP 适配证明：隔离 Hook 已发现且 enabled，但 trustStatus 为 untrusted，没有自动信任或执行真实 Hook。没有模型调用、没有旧聊天读取或凭据传递；不得把显式私有 RPC 注入当成实际 PostToolUse 捕获，更不能当成多次模型压缩后恢复验收。

升级/回滚演练先在探针 30000ms 期限失败；补充诊断显示安装器约 42330ms 可完成切换。项目既有正式安装器本来使用 60000ms，因此另起隔离演练按这个既有边界复验，没有修改正式安装器或容量/启动门禁。该演练 0.1.0→0.1.1 升级后，原会话原文仍可读、原 expiresAt 保持不变，升级后新建会话可加载并完成独立读取适配。旧插件默认的 30 分钟内存留存没有被冒充为新的 24h 加密留存。

同一演练在活跃会话下退回 0.1.0 的阶段未通过，具体失败仍需进一步定位；已经关闭相关会话后，独立原生重新安装 0.1.0 在 34794ms 完成。后者只证明冷态重装，不能证明活跃会话回滚与旧原文连续性。故升级证据保留，回滚、实际 Hook 和多端模型验收继续标为未完成，不据此升级日常插件。

证据：.hpm-acceptance/context-plugin-native-011-20261021-01/，含 native-result.json、migration-result.json、install-diagnostic-60s.json、migration-v2-result.json、rollback-diagnostic.json、outcome.json；首轮失败与后续诊断均保留，隔离目录保留用于核对。所有原文为新建合成数据，RPC 方法白名单不含 turn/start 或其他模型生成操作。日常 0.1.0 插件的 13 个副本仍匹配先前哈希，未修改日常配置、未重启生产。前一轮 60/60 代码门禁对应源码哈希仍一致，但本轮没有新增完整客户端门禁通过声明；此前启动、容量、存储并发、WBIPC 双预算、真实 24h 到期与整体落地要求均未关闭。

## 最新交付包修复：可选插件 0.1.1 暂存包与当前源码一致，尚未安装激活（2026-10-21 UTC；整体未交付）

重新核对真实安装缓存：hpm-local-evidence
0.1.0 的 13 模块清单与其副本一致，但更新前有 8 个副本不同于当前源码；仓库暂存包有 4 个旧副本。不能把旧安装收据当成本轮交付。现已生成 0.1.1 暂存包：兼容 manifest、portable 模板、package/lock、MCP 握手版本一致；25 个依赖模块逐文件匹配当前源码与 SHA256 清单，运行目录没有清单外 JS。SDK 仍直接固定 1.31.0，没有升级依赖或改动已安装客户端。

发现并修复构建器保留退役生成模块的问题：读取有大小、数量、路径和摘要校验的旧清单，只删除清单声明且摘要不变的退役文件；全部候选验证后才删除，拒绝用户改动、链接/硬链接及权限错误，不递归删除目录或处理清单外用户文件。三个历史孤立副本与旧已安装模块哈希一致，已单独备份后移出暂存包。负例回放旧构建器可复现新增回归失败；当前构建器通过。

最新相关覆盖率回归 60/60、无失败或取消，MCP 入口和新退役边界共 129/129 语句、61/61 分支、6/6 函数全部覆盖。包含实际无凭据 stdio 子进程、暂存 server.cjs 握手、精确换行/Unicode 回读、跨线程拒绝、旧包残留检测、异常清单与链接/文件系统失败。已有测试文件由统一 unit/客户端入口发现；相关 Lint、格式、CI 入口与发布清单检查通过。此证据不等于 Codex 实际 Hook、多次模型压缩或已安装 0.1.1 加载验证。

完整五档合成容量诊断另跑完毕，最大四任务 1920 轮、400 次精确恢复及最终 drain 均完成，但 CPU
profile 总时长约 88677ms，明确超过原 60000ms 资格期限。该无期限诊断不替代资格门禁，也不证明传输或持久化存储容量通过。最新热点仍在归一化 clone、规范编码和 SHA 更新；ASCII 正则候选未改善、对象编码循环候选约 2% 差异，均未应用。没有修改工作量、worker 数、并发或门禁期限。

证据：.hpm-acceptance/context-capacity-current-profile-20261021-01/，包括 plugin-static-inventory.json、plugin-static-inventory-after.json、staged-before/、version-before/、orphan-backup/、orphan-retirement.json、old-builder-negative.log、covered-complete.log、profile.log、profile-summary.json、outcome.json。安装缓存 13 个旧副本与其原清单仍逐字节哈希一致，未 reload、未改日常配置、未发模型请求、未重启生产。整体尚待完整门禁、WBIPC 双预算、真实多端多次压缩、最终安装迁移回滚、真实 24h 到期和生产验收；先前五项全量并发失败仍未关闭。

## 最新局部改进：历史数组构造与安全回归通过，容量资格仍超时（2026-10-21 UTC；整体未交付）

本轮仅将 normalizeRecoveryHistoryRequest 外层历史数组从逐项 Object.defineProperty 改为 Array.from 的原生 own-data-slot 构造。计数载体为 null
prototype，不读取继承迭代器；原数组槽位仍逐项取 descriptor，全部输入、单项和总字节、节点、深度、原型及不可变校验保留。没有跨请求原文缓存。新增继承迭代器、空历史、晚项 getter、失败后修复重试与旧结果不可变回归；已有数字 setter 安全回归继续通过。测试文件已在统一客户端 CI 入口。

局部交替基准 16 轮、每轮 8 次标准 480 轮/1440 条历史归一化，中位数 45.60→37.58ms，约 17.6% 改善；只证明本机该函数成本下降。批量 descriptor 候选 48.93→69.94ms、嵌套数组候选 79.09→83.88ms 均更慢，未应用。各基准负载及主机状态不同，不横向比较绝对值。

绑定测试 35/35，扩展 binding/sessions/root-state/loading 覆盖率测试 162/162、无失败或取消，耗时 200247.2772ms；修改模块语句/行 100%、函数 100%、分支 97.97%。实际四根满额 32MiB 私有历史加密重开在专项中通过（145893.6084ms），不能替代完整并发验收。相关格式、Lint、CI 入口、发布清单检查通过。

之后运行原 context-recovery-capacity-workload.test.js：9/10，通过不了资格子命令原 60000ms 期限（ETIMEDOUT），总 65719.9231ms。保留五档负载、两 worker、原超时和全部断言。未为这次局部改进重跑已知失败的完整客户端门禁；上一源码快照的 1226/1231 及五项未通过仍保留在下一节，不能当成本次源码完整验收。下一步仍需降低容量整体成本并解决启动和存储全量并发稳定性。

证据：.hpm-acceptance/context-history-descriptor-batch-20261021-01/，包含 comparison-final.json、covered.log、capacity.log、outcome.json、原始源码备份与未采用候选。生产未启用、未修改安装配置、未发真实模型请求；WBIPC 双预算、多端实际客户端、安装迁移回滚和真实 24h 到期验收仍未完成。三份历史文档尾部逐字节保留。

## 最新完整门禁：1226/1231，启动依赖拆分未解决全量并发超时（2026-10-21 UTC；整体未交付）

本轮将 Responses 目标判定和上下文溢出响应拆成轻量模块；转换与规划依赖在已验证的请求分支加载。核心路由、鉴权和配置仍在就绪前加载，旧导出兼容。新增冷加载依赖拒绝、首个匹配请求验证、缺失模块传播与溢出边界回归，并将两模块纳入统一客户端覆盖率入口和发布清单。实际 core 冷加载项目模块 133→108；单次耗时受主机负载影响，没有证明启动延迟改善。

最终定向覆盖率测试 60/60 通过，语句/行 90.64%、分支 89.44%、函数 91.83%。之后按原命令运行完整 test:client:coverage，退出 1：1231 项、1226 通过、3 失败、2 取消，耗时 320369.0051ms。完整覆盖率语句/行 99.04%、分支 95%、函数 99.17%，原阈值通过；完整测试门禁仍失败。未改变并发、两 worker、五档容量负载、15 秒启动、60 秒容量或原存储期限。

同五项未通过：Chat/Responses/Claude
JSON/SSE 实际隔离代理启动、direct-upload 隔离代理启动、容量资格命令、孤立 staging 清理和多次加密存储重开、四根满额 32MiB 私有历史加密物理重开。首条启动诊断 core 约 6.56 秒，但 15 秒内整个模块图仍未完成；不能将单个 import 或单次定向通过当成完整解决。存储重开三次打开累计约 29.86 秒，随后超过 30 秒；密钥解保护单次约 0.43–0.60 秒，不能仅归因为 DPAPI。

证据目录：.hpm-acceptance/context-startup-provider-boundaries-20261020-01/，包括 covered-final.log、client-coverage-current.log、modules-before.json、modules-final.json、outcome-current.json；早期失败实验保留。下一步须定位全量并发下启动模块图、容量 CPU 和存储生命周期成本，并保持全部安全校验。WBIPC 双预算、真实客户端多次压缩、安装迁移回滚、真实 24h 到期及生产启用仍待完成；真实模型请求、安装配置修改和生产重启均未执行。三份方案原尾部逐字节保留。

## 最新完整门禁：1225/1230，启动和容量及存储重开超时待修复（2026-10-20；整体未交付）

包含新原文校验模块的原 test:client:coverage 完整运行退出 1：1230 项、1225 通过、3 失败、2 取消，302559.7993ms。覆盖率语句 99.04%、分支 95%、函数 99.17%、行 99.04%，原阈值通过，但完整测试门禁没有通过。

原两条 15 秒代理启动和 60 秒容量命令仍超时；另有 actual encrypted worker startup
removes orphan staging and retains committed evidence across
reopening 触发原 30000ms 期限。其诊断显示第一次打开约 4.9 秒，第二次打开从约 8.3 秒到 21.3 秒，清理和关闭到约 29.1 秒，第三次打开尚未完成便到期。不能把这个整体失败归因为单个 DPAPI 调用，也不能用此前专项通过替代本次完整并发失败。没有调整测试并发、工作量、worker 数、期限或阈值。

满额四根 32MiB 私有历史物理重开在本次完整并发中也触发原期限，属于取消项；此前 184/184 扩展专项通过保留，但不能证明全量并发稳定性。完整失败和取消名称共 5 项，精确列表保存在收据中。最新结果较上一源码快照额外暴露两项并发超时，尚未解决。

证据：.hpm-acceptance/context-payload-verification-20261020-01/client-coverage-current.log、full-gate-outcome.json；184/184 专项和局部基准保留在该目录。账本解析的局部性能收益没有解决完整门禁。启动、容量和多次存储重开稳定性仍需修复，WBIPC 双预算、真实多端、最终安装迁移回滚、真实 24h 到期和生产验收也未完成。未发真实模型请求、未修改已安装客户端、未重启生产；凭据选择仍待用户答复。三份方案原尾部逐字节保留。

## 最新增量：账本单次解析复用原文校验，原容量期限仍未通过（2026-10-20；整体未交付）

新增独立 context-evidence-payload-verifier，仅在一次账本解析内缓存相同不可变字符串的 UTF-8
Buffer 和 SHA-256，最多 128 项/4MiB；不跨请求、不跨解析保存。每条 source 仍独立验证原文长度、摘要、读取位置，所有者、时间、来源身份、配额和累计读取状态继续由账本解析器逐项验证。UTF-8 全文先精确往返检查，前缀位置通过 UTF-8
continuation
byte 判定边界，避免为完整前缀再分配和解码一份文本。空原文、控制字符、中英文/组合字符/emoji、孤立代理、非法和极端入参、摘要/字节/读取边界篡改、128 项/4MiB 饱和及跨解析隔离均有回归；新测试在原统一客户端门禁文件内。发布运行时清单已登记新模块，首次发布检查的缺失告警已修正，没有绕过门禁。

新增集成回归在旧解析器下失败（相同内容逐条重算 4 次摘要，预期两个不同内容各一次），最终专项账本 29/29；扩展账本、sessions、root-state、storage-blobs 和 protocol 共 184/184、0 取消，修改的两个模块语句/行 186/186、分支 111/111、函数 9/9，均 100%，原覆盖率门槛通过。四根满额 32MiB 私有历史加密 worker 重开在该扩展运行通过，约 170 秒；此前 139 秒属于不同运行，不能称本次改善该路径。Lint、格式、CI 和最终发布治理通过。

480 来源/15MiB 原文、10 种重复内容、8 轮交替、每轮 4 次解析的局部基准中位 249.5ms
->
57ms，约 77% 局部解析改善；不是整体恢复或生产提速。原容量整文件依然 9/10，原 60000ms 子进程 ETIMEDOUT，五种工作量、两 worker、并发和覆盖率要求未调整。最近完整客户端仍为上一源码快照 1227 项/1224 通过/3 失败，本次新增三个测试后的完整客户端尚待运行。

本轮另两项实验未进入最终代码：大消息单次哈希约 307ms 对现有前缀复用 95.5ms，明显更慢；共享准入编码约 184ms 对 187.5ms，收益不足以支持新增接口。后者涉及四个运行时文件及绑定测试，已对先前备份/收据逐字节核验恢复。没有保留这些实验的产品接口或测试。

证据：.hpm-acceptance/context-payload-verification-20261020-01/ 的 before.log、ledger.log、covered.log、comparison.json、capacity.log、\*-final.log、outcome.json；另外两实验结果在 context-large-fingerprint-20261020-01/experiment.json 和 context-admission-encoding-share-20261020-01/comparison.json。仍需启动与容量修复、WBIPC 双预算、真实多端、打包安装迁移回滚、真实 24h 到期和生产验收。真实模型凭据选择仍待答复；未发真实模型请求、未改已安装客户端、未重启生产。历史方案原尾部逐字节保留。

## 最新完整门禁：1224/1227，三项原超时仍待修复（2026-10-20；整体未交付）

在历史文本计数和小消息一次哈希改动后，原 test:client:coverage 完整运行测试结果为 1227 项、1224 通过、3 失败、0 取消，耗时 274348.84ms。覆盖率语句 99.04%、行 99.04%、分支 94.99%、函数 99.17%，原阈值通过，整体测试门禁仍失败。失败仍为两条 15 秒代理启动和原 60 秒容量子进程，没有修改工作量、并发、worker 数、超时或覆盖率门槛。本次其余物理存储和四任务路径通过，不能替代真实客户端或生产验收。

当前源代码的独立 CPU 诊断保留原五种容量画像与两个 worker，五种均完成，最大画像完成 1920 轮、400 次精确恢复和最终结果观察；总耗时约 83.2 秒，最大 worker 约 82.7 秒。这是超过门槛的诊断结果，不能称为容量资格通过。主要自耗时仍是历史克隆约 8.4 秒、hash.update 约 8.1 秒、canonical 字符串编码约 7.4 秒，以及大小计算和转义扫描；包容耗时不可直接相加，也不能据前后宿主负载差异作总体提速承诺。

证据：.hpm-acceptance/context-small-fingerprint-20261020-01/client-coverage-current.log、full-gate-outcome.json、profile-summary.json、profile-outcome.json。仍需修复启动与容量性能，并完成 WBIPC 双预算、真实多端恢复、打包安装迁移回滚、真实 24 小时到期和生产验收。真实模型凭据选择尚待答复；未发真实模型请求、未更改日常配置、未重启生产。历史原尾部逐字节保留。

## 最新增量：小消息指纹减少哈希对象分配，容量期限仍未通过（2026-10-20；整体未交付）

单次准入内的小 canonical 消息改用 Node 原生 crypto.hash 一次计算 SHA-256；旧运行时保留 createHash 回退，大消息继续使用既有前缀状态复制。canonical 字节、字段排序、摘要算法、128 项及 4MiB 缓存限制、认证作用域、绝对到期和持久格式不变。新增回归验证原生分支和旧运行时回退摘要一致，覆盖空对象、Unicode、孤立代理、NUL、嵌套工具、数字键序和大消息；已有缓存边界回归保留并纳入统一客户端门禁。

最终绑定、history-map、sessions、protocol 共 118/118，通过原覆盖率门槛；修改模块语句/行 181/181、分支 83/83、函数 11/11，均为 100%。作用域 Lint、格式、CI 和发布治理检查通过。实际候选在预热后 8 轮交替、每轮 12 次准入、1441 条消息的局部测量中位数 109ms
->
93.5ms，约 14%；同候选未预热测量约 2%，初始诊断约 20%，说明宿主负载和 JIT 差异明显，不能当作整体性能承诺。

原容量整文件仍 9/10，失败为原 60 秒资格子进程 ETIMEDOUT；五种工作量、两个 worker、测试并发与覆盖率阈值保持原值。最近完整客户端门禁是此前快照 1225 项中 1222 通过、3 失败，早于本次及上次文本计数优化，不能视为当前版本完整通过。完整仓库格式门禁此前仍有 404 文件告警，本轮没有批量改写或增加忽略。

证据：.hpm-acceptance/context-small-fingerprint-20261020-01/ 的 before.log、covered.log、comparison-final.json、comparison-warm.json、capacity.log、final-\*.log、outcome.json。新容量 CPU 画像是诊断，不替代原 60 秒门禁。真实客户端凭据选择仍待用户答复；没有真实模型请求、日常配置变更或生产重启。整体仍需容量和并发启动修复、WBIPC 双预算、真实多端恢复、安装迁移回滚、真实 24h 到期和生产验收。三份历史方案尾部逐字节保留。

## 最新增量：历史文本计数减少分配，容量期限仍未通过（2026-10-20；整体未交付）

历史请求规范化在每次准入内缓存未命中文字的 UTF-8 大小；普通无转义文本直接加 JSON 双引号的两字节，不再为计数生成一份同样大的 JSON 字符串。Unicode 控制字符、引号、反斜杠和全部代理字符仍走原生 JSON.stringify，保持配对/孤立代理的既有结果；descriptor、节点、深度、单项/总字节、冻结和版本准入不变。Lint 不允许显式控制字符正则，最终采用既有模块使用的 Unicode 分类正则，没有关闭规则。新增回归在计数缓存饱和后阻止长普通文本序列化，同时检查实际 JSON 字节、克隆和冻结；原 Unicode/转义/孤立代理及 2MiB 精确边界回归保留。

最终绑定、history-map、sessions、protocol 共 117/117，通过原 85/80/90/85 覆盖率门槛，修改模块语句/行 100%（221/221）、分支 98.01%（148/151）、函数 100%（9/9）。Lint、格式、CI 和发布治理通过。最终 1441 条消息/15836541 编码字节，每轮 12 次规范化、8 轮交替，中位数 128ms
->
117.5ms，约 8% 本地局部收益，不能外推生产或完整容量速度。另一项指纹编码实验未体现收益，生产文件已逐字节恢复原版本。

最终原资格命令专项仍在原 60000ms 子进程期限 ETIMEDOUT；它仍执行原五种工作量和两个 worker，没有缩小四任务或绕过最终 drain。早先本轮容量整文件两次均 9/10；最终专项针对同一个失败测试，不能称为完整容量通过。最近完整 client 仍是上一快照 1225 项/1222 通过/3 失败/0 取消，本次没有重复完整 client，新增回归后的全量仍待验证。上一轮全仓 format:check 已退出 1，404 文件告警主要是 .codex-tmp/tmp 历史诊断和生成证据；没有批量改写、忽略或提高 baseline。

证据：.hpm-acceptance/context-string-sizing-20261020-01/ 下 before.log、covered-final.log、comparison-final.json、capacity-current.log、final-\*.log、outcome.json。整体仍需处理两条 15 秒启动和原容量超时、WBIPC 双预算/实际客户端、包安装迁移回滚、真实 24h 到期及生产验收。未更改日常客户端、未发真实模型请求、未重启生产；三份历史方案原尾部逐字节保留。

## 最新完整门禁：1222/1225、三项超时、无取消（2026-10-20；整体未交付）

在存储请求不可变复用改动后，原 test:client:coverage 完整执行退出 1：1225 项、1222 通过、3 失败、0 取消，272140.9422ms。语句/行覆盖率 99.04%（23439/23665）、分支 94.98%（11280/11875）、函数 99.17%（1201/1211），原阈值通过，测试门禁未通过。两条原 15 秒代理启动和原 60 秒容量 qualification 命令仍超时；不修改并发、工作量、两个容量 worker 或期限。此前完整运行中另七个失败/取消事件本次未复现，不能据此承诺永久消除；特别是 DPAPI 与物理 worker 仍需稳定运行证据。

本次启动诊断在 15 秒截止仍未完成模块加载：core
imports 合计约 7.5/8.3 秒，并且到期时分别仍加载 profile_auth/rate_limits。该数据指导排查启动模块图，不证明已修复。容量命令为 spawnSync 原 60000ms
ETIMEDOUT。四根完整私有历史物理测试在本次统一并发中通过，无取消；先前独立 139 秒结果保留。完整仓库 format:check 另行执行，已有非本任务 .codex-tmp 历史诊断与生成覆盖率文件格式告警；不批量改写用户证据或提高 baseline。

证据：.hpm-acceptance/context-storage-request-reuse-20261020-01/client-coverage-current.log、full-gate-outcome.json、repository-format.log。整体目标仍需解决三项完整门禁失败、完成实际多端/WBIPC、安装迁移回滚、真实 24h 到期和生产验收。未发真实模型请求、未更改日常客户端配置、未重启生产。

## 最新核验：存储请求不可变复用、物理恢复剖析及客户端声明配置（2026-10-20；整体未交付）

存储 worker owner 与 SQLite
engine 对同一已解析请求重复规范化。storageRequest 现在只复用模块私有 WeakSet 登记的深冻结解析结果；原输入不会冻结，跨 JSON/structuredClone/worker 边界重新校验，外部冻结对象或伪造字段不能获得复用资格。没有修改协议、权限、scope/revision/expiry 检查或配额。新增回归覆盖冻结嵌套结构、原输入隔离、复制后重验、getter/toJSON 不执行、非法字段/版本/大小拒绝、revision
conflict、到期及关闭行为。存储、blob、service、opening、root-reader、lifecycle 共 195/195 通过；修改模块语句/行 98.91%、分支 96.44%、函数 100%，原覆盖率门槛通过；最终 Lint、格式、CI 和发布治理通过。

8MiB 请求连续解析两次的 8 轮交替局部基准，中位数 2002ms ->
986.5ms，约 51% 局部改善，不能外推整体请求速度。四根实际 session 历史、2048 快照、4096 私有调用、32MiB 私有历史的加密 save/close/reopen/load/restore 独立测试 1/1，139050.7264ms；此结果未体现整体提速，也未覆盖每根原文 16MiB 同时用满。新 CPU 剖析显示存储 worker 的 reference
state 校验、清理、容量统计路径仍重复处理大记录，下一步应针对事务内重复工作验证优化；不得省掉认证或语义验证。

只读安装和声明配置盘点：Codex CLI 0.160.1 选择 custom
provider，origin 为 http://localhost:3085；Claude Code
2.1.292 的 settings 与当前环境 origin 均为
https://api.deepseek.com，当前声明路径绕过代理。只读取
origin 和字段存在性，没有输出凭据、完整 base
path 或用户内容，没有修改配置或发真实模型请求。因此无插件 Claude 兼容尚未交付，需隔离配置实际验收。最近完整 client 门禁仍为 1221 项、1211 通过、8 失败、2 取消，且早于本次修改；不能用本次专项绿色替代完整并发失败。

证据：.hpm-acceptance/context-storage-request-reuse-20261020-01/ 下 before.log、covered.log、comparison.json、full-physical-profile.log、profile-summary.json、client-config-inventory.json、final-\*.log、outcome.json。保留原 24 小时观察数据和绝对到期时间；未重启生产。完整门禁、多端/WBIPC、安装迁移回滚及生产验收仍待完成，三份方案原尾部逐字节保留。

## 最新核验：历史克隆分配优化、完整门禁重跑及超时清理（2026-10-20；整体未交付）

历史请求 normalizer 将每个递归节点临时创建的 spend 闭包改为操作级函数，稠密数组按已验证长度直接索引，避免生成临时名字数组及回调。自有 descriptor、继承 setter 防护、冻结、单项/总字节、节点、深度及版本限制均保留，没有新增缓存或原文留存。绑定文件 32/32 通过。1441 条消息、15836541 编码字节、每轮 12 次规范化、8 轮交替基准，中位数 119.5ms
-> 111ms，约 7% 本地局部改善，不能外推整体或生产速度。

原完整 test:client:coverage 本轮退出 1：1221 项，1211 通过、8 失败、2 取消，328919.0238ms；覆盖率语句/行 99.01%、分支 94.99%、函数 99.09%，覆盖率阈值通过但测试未通过。修改 normalizer 的语句 216/216、函数 9/9、分支 149/152。失败包括原两条 15 秒代理启动、原 60 秒容量命令，以及 v7 强制退出、idle
corruption、旧 DPAPI 互通、staged 清理重开、混合期限重开、物理强制退出和新增四根满额物理测试。两条取消为原 30 秒 staged 重开及新增 180 秒四根测试；不能继续用上一轮 3 项失败描述当前全量结果。

新增存储/DPAPI/强制退出失败六条分组复核 6/6、15942.5316ms，并不证明完整并发失败已修复。日志明确记录一次 legacy_unprotect
PowerShell 后端原 10 秒 ETIMEDOUT。新增满额测试完整并发下 180 秒超时，独立成功不能替代该失败。未降低统一并发、两个容量 worker、工作量、原期限或覆盖率阈值。

为避免测试超时后的原异步函数继续构造后续根，在满额夹具循环和物理测试的 await 边界使用 runner 原取消信号；取消后进入原 finally 关闭 worker、session 并删除经校验的自有目录。新增已取消夹具回归验证在建 session/读取时钟前停止，与单根 512 快照/8MiB 实际恢复测试共 2/2；补信号后的四根物理测试独立 1/1，成功路径仍需四根、2048 个快照/4096 调用/32MiB 及相同内容/期限。此清理修正没有修复完整门禁的性能超时。Lint、Prettier、CI 与发布治理最终通过。

24 小时真实观察第 6 次仍 awaiting-real-deadline，保留原绝对截止 2026-10-22T00:55:55.109Z。完整门禁、实际多端/WBIPC、安装迁移回滚与生产验收仍未完成；未重启生产、未改已安装客户端、未发真实模型请求。本轮只对修改后的取消边界及满额成功路径做专项验证，未再次重复完整 client 命令，最近全量结论仍为上述失败。

证据：.hpm-acceptance/context-history-clone-20261020-01/ 下 benchmark.log、comparison.json、binding-regression.log、client-coverage-current.log、current-client-summary.json、failed-storage-group-recheck.log、cancellation-and-full-session.log、full-physical-cancellation-safe.log、final-\*.log、outcome.json。三份历史方案文档原尾部逐字节保留。

## 最新核验：容量性能重采样与快照索引缺失查询优化（2026-10-20；整体未交付）

原 60 秒容量门禁本轮基线仍为 9/10，耗时 72099.5716ms。另一次不作为门禁通过证据的 CPU 采样完成全部五画像，最大 worker
85395ms、主进程 85816ms，五画像均 qualified，四任务画像完成 1920 轮、400 次精确恢复、20 次重开与最终原文 drain；它只证明合成会话逻辑能完成，不能替代原 60 秒性能资格、物理存储、真实客户端或生产验收。

新采样主要耗时仍为 begin
45944ms、历史规范化 19964ms、绑定指纹/前沿 22113ms、根恢复 15175ms（包含关系有重叠，不可直接相加）。索引 has 自身约 1199ms，因此不是主瓶颈。为减少已有线性父链上的缺失键遍历，给每个私有快照索引加入固定 256 字节位图，仅记录短字符串键的非加密混合位；不保存原文或键值，不参与授权、序列化、版本或到期判断。位图阴性才直接拒绝，任何可能命中仍通过原 Map 精确遍历。每个子分支独立复制位图，父快照和 sibling 不可互相加入键；非字符串和超过 256 字符的键保留原 Map 路径。位图饱和/碰撞仅影响性能，不改变成员关系。

新增回归先在原实现得到缺失查询探测门禁失败，修复后 sessions
45/45。扩大到 sessions、root-owner、private-capacity 共 93/93，修改模块语句/分支/函数/行均 100%，原 85/80/90/85 阈值通过。覆盖父子/sibling 隔离、空键、超长键、对象不强制转换、NaN、负零、symbol、4096 个字符串饱和、重复拒绝、完整迭代与恢复。测试留在既有统一入口列出的 sessions 文件。Lint、Prettier、CI 与发布治理通过。

8 轮交替局部基准每轮 24 条 480 深度链，中位耗时 baseline 793.5ms、candidate
627.5ms，约改善 21%；仅为本地合成索引基准，不代表整体恢复或生产速度。原容量门禁修改后仍 9/10、64788.8854ms，60 秒子进程超时，未解决整体性能失败；不能以两次超时总时长推算总体提速。五画像、两 worker、工作量、原超时和覆盖率阈值均未改动。本轮未再次执行完整 client
coverage，最近全量 3 项失败仍未关闭。其余多端/WBIPC/打包安装回滚/真实 24 小时到期/生产验收仍待完成；未重启生产、未改已安装客户端、未发真实模型请求。

证据：.hpm-acceptance/context-capacity-current-20261020-01/ 下 CPU
profiles、profile-summary.json、profile-run.log、snapshot-filter-before.log、snapshot-filter-covered.log、snapshot-filter-benchmark.json、capacity-filter-after.log、snapshot-filter-outcome.json；基线原门禁为 .hpm-acceptance/context-request-encoding-reuse-20261020-01/capacity-current-baseline.log。三份历史文档原尾部逐字节保留。

## 最新核验：真实会话四任务满额私有历史的加密重开（2026-10-20；整体未交付）

新增两个测试进入已有 root-state 文件及统一 client
coverage 入口。通过真实 sessions.begin、recovery.accept、complete 生成数据，未直接注入伪造历史：每根 512 个快照、512 条私有映射、1024 次私有调用、511 个实际原文来源。首快照混合公开 lookup 与私有 LIST，后续 511 个 sibling 分支捕获各自原文并执行两个参数不同的 LIST；原防重复调用检查保持不变。先以两个真实快照测量固定开销，再填充每条精确 16384 字节，断言每根私有历史合计 8MiB。

四根实际通过 Windows 密钥保护的加密 worker 保存 reference-state，关闭所有原 sessions 和 worker，重新打开存储，逐根 load 并比较检查点摘要、全部私有历史摘要、全部原文来源及原绝对到期。随后四根批量恢复 sessions，再导出全部根并完整比对历史，单独验证 observedAt 单调递增，所有到期时间严格保持不变。总计 2048 个快照、4096 次私有调用、32MiB 私有历史。此处验证的是私有历史满额，未声称每根 16MiB 原文配额同时满额。

首次物理测试已通过加密保存/重开/读取，但错误地要求恢复后 observedAt 不变而失败；测试现按既有观察时钟语义单独检查该字段，其他历史字段完整深比较，未修改运行时代码或放宽容量/期限。最终 root-state 全文件 55/55，通过耗时 186316.783ms；四根物理测试 131748.1165ms。单根满额独立测试通过，Lint、Prettier、CI 治理及发布治理通过。保留全部夹具调试失败记录。

本轮没有再次执行完整客户端门禁，最近完整结果仍为 1214 项中 1211 通过、3 失败，两条代理启动和原 60 秒容量命令尚未修复。原五画像、两 worker、60 秒容量期限和既有覆盖率阈值均未修改。24 小时真实观察第 5 次仍 awaiting-real-deadline，原截止 2026-10-22T00:55:55.109Z；未重置或续期。后续仍需性能/重开稳定性、WBIPC 预算内恢复、全仓门禁、打包安装迁移回滚、真实多端和生产验收。未重启生产、未改安装客户端、未发真实模型请求。

证据：.hpm-acceptance/context-request-encoding-reuse-20261020-01/full-session-capacity-sixth.log、full-physical-capacity-first.log、full-session-root-suite.log、full-session-physical-outcome.json。三份历史方案文档原尾部逐字节保留。

## 最新核验：四根满容量历史的批量恢复修复（2026-10-20；整体未交付）

新增实际 history-map 满容量用例，四个 v3 根各 512 条 sibling 记录、每条两次私有调用，共 2048 条记录/4096 次调用/精确计费 33554432 字节（32MiB）；各根 8MiB、1024 次调用。每个根先通过真实 prepare/commit 和 export 生成，导出 512 个 tip，再批量恢复并逐 tip 重建，以 SHA-256 比对全部 4096 个实际结果。此用例补充此前四根各四个条目的调用上限测试，没有替换旧测试或缩小容量目标。

修复前，四根分别合法并可导出，合并 restoreContextHistoryRoots 却失败 invalid_context_history_state。证据为每根 19465 节点，批次 77885 节点、编码 33418437 字节（低于原 48MiB 总上限）；旧入口先整体规范化，错误地让四个新根共享一个 65536 节点预算。新增断言同时确认通用 normalizer 仍拒绝该批次，未扩大通用限制。

现在批量入口仅用 descriptor 校验外层数组/包装及小 scope，每根交给原版本化 parser 独立检查字节、节点、深度及语义；计入逗号/包装/scope 的 48MiB 总编码上限保持不变，最终仍执行全局数量/字节/四根配额。v1/v2 子集继续通过原整体 normalizer 保持共享节点/深度限制，只有已定义的 v3 采用独立根预算。成功前不构造 live
map。新增 malformed/sparse/accessor/隐藏字段/第五根/重复条目/末根失败等拒绝回归，验证不执行 getter、非法批次不调用 owner 时钟且既有源 map 仍可读；另验证两个分别合法的大 legacy 根仍因共享节点超限拒绝，v1/v2/v3 混合恢复保留原版本与各自绝对到期。

修复前满容量负控 0/1，修复后 1/1；history-map 全文件 25/25。扩大到 history-map、root-state、root-owner、private-capacity 四文件后 126/126，语句/行 92.73%、分支 90.33%、函数 91.66%，原 85/80/90/85 专项阈值通过；Lint、Prettier、CI 与发布治理均通过。新增测试位于原 unit 自动发现与原 client
coverage 显式列出的 history-map 文件中。

本轮没有再次执行完整客户端门禁，最近完整结果仍为 1214 项中 1211 通过、3 失败（两条代理启动与原 60 秒容量命令），不能用此次专项替代全量。满容量用例是实际私有映射的内存导出/恢复，不证明同规模加密 SQLite/真实客户端/生产资格；此前七 MiB 物理 worker 恢复也不能外推到本次 32MiB 满额目标。后续仍需满额物理根验收、启动/容量性能与重开稳定性、WBIPC 预算内恢复、全仓门禁、最终打包安装迁移回滚、真实多端/24 小时到期及生产验收。未重启生产、未改已安装客户端、未发真实模型请求。

证据：.hpm-acceptance/context-request-encoding-reuse-20261020-01/ 下 full-private-roots-before.log、full-private-roots-after.log、full-private-roots-expanded.log、full-private-covered.log、full-private-coverage/、full-private-roots-outcome.json。本次保留全部历史文档尾部，并记录新文件哈希。

## 最新核验：JSON 克隆局部优化及数组 setter 边界修复（2026-10-20；整体未交付）

通用 JSON 规范化中的空原型对象改用直接自有数据赋值，保留所有 descriptor 校验、深度/节点/字节限制、最终 JSON 转义后计量；数组仍使用 Object.defineProperty，避免继承的数字 setter。新增回归验证
**proto**/constructor/prototype、继承 setter 不执行、精确数据描述符与克隆隔离。8000 条合成记录、每轮 12 次规范化、8 轮交替顺序对照，中位数 934ms
->
819.5ms，约 12% 局部改善；这是 normalizer 微基准，不能外推整体恢复或生产速度。原五画像、两 worker、60000ms 容量子进程仍超时，回归 9/10、65571.8341ms。

沿此边界发现并修复两个实际缺陷：normalizeRecoveryStateData 与 normalizeRecoveryHistoryRequest 对数组直接赋值（后者还使用 history.push）会执行 Array.prototype 上继承的数字 setter，导致已验证值遗漏。两处独立回归在修复前均出现 setter 调用计数 1
!=
0；现在所有复制出的数组元素显式创建自有数据描述符，空原型对象保持直接赋值。请求回归覆盖外层 history 与嵌套 content 数组，检查完整 JSON 相等和冻结；状态回归检查末项、null
prototype、数据描述符及源对象隔离。无接口、版本、容量或到期语义变更。

初次四文件 87/87，但整个 envelope 模块语句覆盖 83.84% 未达 85% 门禁；补入已有 lifecycle/evidence 用例后 102/102、门禁通过。加入两处数组修复后最终七文件 135/135，三个修改模块语句/行 99.73%、分支 95.94%、函数 100%，原 85/80/90/85 阈值通过。新增测试均位于既有 unit 自动发现文件中，binding/root-state 也在 client 入口。Lint、Prettier、CI 和发布治理通过。保留首次覆盖率拒绝及修复前安全回归失败日志。

最终原 test:client:coverage 退出 1：1214 项中 1211 通过、3 失败、0 取消，188503.9393ms；语句/行 99.04%、分支 94.96%、函数 99.17%。剩余失败是两条 isolated
proxy 原 15000ms 启动期限与容量 qualification 原 60000ms 期限。存储重开本次通过，但此前全量存在超时，未确认根因，不能据此报告稳定性已修复。没有降低任何工作负载、并发、超时或覆盖率阈值。

证据：.hpm-acceptance/context-request-encoding-reuse-20261020-01/ 下 normalizer-alternating.json、normalizer-comparison.cjs、normalizer-covered.log（首次覆盖率失败）、normalizer-covered-final.log、normalizer-security-covered.log、normalizer-capacity-original.log、state-array-setter-{before,after}.log、history-array-setter-{before,after}.log、client-coverage-normalizer-security.log、normalizer-security-outcome.json。整体仍未交付：启动/容量性能及重开稳定性、满容量私有存储和混合失败路径、WBIPC 预算内原生恢复、全仓门禁、打包安装迁移回滚、真实多端与 24 小时到期观察、生产验收未完成。未重启生产、未改已安装客户端、未发真实模型请求。

## 最新核验：全量剩余超时与三协议私有调用边界（2026-10-20；整体未交付）

原 test:client:coverage 重跑退出 1：1205 项中 1202 通过、2 失败、1 取消，193398.5769ms；语句/行 99.04%、分支 94.94%、函数 99.17%，覆盖率达标但测试门禁未通过。失败仍包括 isolated
proxy
15000ms 启动期限、容量 qualification 原 60000ms 子进程期限，以及真实加密 worker 三次重开测试的 30000ms 期限。最后一个测试第三次 ready 在 29957ms 才到达，尚未完成最终读取；不能报告恢复验收通过。未降低原工作负载、两 worker、并发、期限或阈值。

修正三个测试中的旧版本假设：v10 是合法版本，非法版本改为 v11，新增 v9/v10 正常与超限解析覆盖。四文件定向测试 104/104。测试诊断增加受控 CPU
user/system 累计毫秒，与墙钟耗时并列；固定标签、整数、限长，拒绝 getter/非法/倒退采样且不影响原操作。全量内存首请求从 first_start
1241ms 到 storage_load_start
3303ms，CPU 增量约 594ms；这只表明耗时差异，不足以确认超时根因。

随后新增七个进入既有统一 unit/client 门禁的 history-map 回归，最终该文件 22/22：Chat/Responses/Claude 分别在旧私有版本 64 次和新版 1024 次调用后拒绝第 65/1025 次、祖先重复 ID 和版本切换；拒绝不改变存量计费；JSON 导出恢复逐条比对全部私有结果；到期前可读、绝对到期时引用与字节均清零。另一个实际 history-map 用例同时保留四个根、每根 1024 次调用，拒绝第五根且不丢已有结果，跨 scope 不可重建，并逐根导出恢复精确比对。它验证 8 个实际条目中的 4096 次调用，不等同于四根各 512 条/8MiB 的满容量物理存储验收。

新增测试首轮因 Claude 公开字符串 content 的结果提取写法失败 2 项，改用 Array.isArray 后通过；保留失败日志。Lint、Prettier、CI 和发布治理均通过。最终 22/22 边界文件是在上述全量运行之后修改，尚未再次纳入完整并发重跑，不能把两个结果合并成新的全量通过。

真实 Windows 密钥链加密留存第 4 次独立检查通过，仍 awaiting-real-deadline；原绝对到期 2026-10-22T00:55:55.109Z 未改，无后台任务。未重启生产、未改已安装客户端、未发真实模型请求。容量性能、启动/重开超时根因、四根完整条目/字节边界及混合/失败清理集成、WBIPC 预算内原生恢复、全仓门禁、最终打包安装迁移回滚、真实多端与生产验收仍未完成。

证据：.hpm-acceptance/context-request-encoding-reuse-20261020-01/ 下 client-coverage-cpu-current.log、full-failure-fixes-focused.log、private-call-boundaries.log（首轮失败）、private-call-boundaries-final.log、private-four-roots-final.log、boundary-followup-outcome.json；留存使用原 receipt.json，未重置计时。

## 最新核验：容量实验撤回与 v10 独立进程验收修正（2026-10-20；整体未交付）

原始容量测试仍为 9/10，qualification 子进程在原 60000ms 上限超时；不带采样的完整五画像诊断随后也触及 180000ms 观察上限，未取得完整报告，不能据此宣称内容或性能通过。诊断超时没有替代或修改原门禁。

尝试在单请求内复用规范化阶段的字符串 JSON 编码，跨请求仍重验全历史。1441 项历史、480 个 32KiB 工具输出、每轮八次完整 admission 的三轮局部对照，中位数由 1016ms 变为 1660ms，未证明收益。候选已撤回，history-request、public-window、binding-frontiers、binding 四个运行时文件与实验前备份逐字节一致；不保留该优化，不外推整体速度。

修正了 v10 验收夹具遗漏：publication 容量新增 v10 正向断言并用 v11 检查未知版本；Codex 摘要 schema 断言更新为 v10，仍检查未知版本拒绝；独立 owner 辅助程序接受已支持的 v10，并保留 7/8/9。修正前绑定/摘要回归 39/41，两个子进程因辅助程序不接受 v10 失败；修正后 41/41，通过 Windows 加密存储的两独立 owner 精确读取，以及强制终止 owner、重开读取、提交撤销后再强制终止再重开的完整序列。publication 专项另为 1/1。Lint、格式、CI 与发布治理通过，测试位于既有统一 CI 入口。

证据：.hpm-acceptance/context-request-encoding-reuse-20261020-01/ 下 capacity-before.log、baseline.json、admission-baseline.json、admission-candidate.json、after-restore-regression.log（失败记录）、after-helper-regression.log、outcome.json 和文档保尾收据。整体仍需容量性能与全量并发门禁、WBIPC 预算内恢复、全仓验证、最终安装/迁移/回滚、真实客户端、真实 24 小时观察结束及空闲窗口生产启用。已有留存观察不得重新 seed 或续期；未重启生产、未修改已安装客户端、未发真实模型请求。

## 当前阶段：v10 私有历史容量、引用持久化及实际 worker 冷恢复（2026-10-20；整体未交付）

新根版本为 v10，私有历史为绑定 rootId 的 v3：每根最多 512 条、8MiB、1024 个祖先私有调用；最多四根合计 2048 条/32MiB。旧根及 v1/v2 私有历史保持原共享 256 条/4MiB/64 次限制，不隐式升级；期限仍为原创建时间起 24 小时，不滑动续期。v9/v10 容量策略对象独立，禁止引用状态转换静默改变根容量类别。

修复引用状态摘要仍受 2MiB 旧上限限制的问题：只有显式 v10 元数据可选择 16MiB 引用解析和摘要能力；请求、策略与普通摘要边界不扩大。加密落盘清单也按 v10 选择 16MiB+4096 字节封装上限，旧清单与普通加密状态仍为 12MiB。AES-GCM 在认证和解析后按明文版本再次检查实际长度，旧版有效认证密文也不能借用新版配额。原文继续分块；单块、原文总量、物理存储总配额及四任务边界保持原规则。

验证分两组：引用与会话扩大回归 193/193，六模块专项覆盖语句/行 99.09%、分支 88.61%、函数 100%；随后新增封装与 worker 回归首次 150/151，暴露旧测试仍将 v10 视为未知版本，补充 v10 正向/越界断言并以 v11 作为未知版本后，原五文件复跑 151/151，三模块专项覆盖语句/行 98.12%、分支 93.09%、函数 100%。两组覆盖均保持既定 85/80/90/85 阈值；Lint、格式、CI 与发布治理通过。新回归位于统一 unit 自动发现文件，私有容量专项也纳入 client
coverage 命令。

超过 3MiB 的实际会话私有历史通过加密 SQLite 保存、扫描、加载、原文还原、篡改拒绝及原期限到期拒读。新增真实 Windows 密钥链/加密 worker 用例：7MiB 私有历史在关闭会话和 worker 后重开，引用与完整根摘要一致，七段隐藏消息和原文逐字节匹配，可重新构建下一轮模型输入。另有 13MiB 合成清单的加密层往返、精确上限/+1 拒绝、跨 scope 与密文篡改拒绝；此项是加密层边界验证，不等同于 13MiB 完整有效业务根验收。

真实时钟 24 小时观察已启动：专用加密目录位于 .hpm-acceptance/context-retention-observation-20261020-01/context，收据不保存原文/密钥，只记录摘要、原期限与观察结果；首次写入后重开及独立进程再次重开均通过。固定到期时间为 2026-10-22T00:55:55.109Z，目前 phase=awaiting-real-deadline，未完成真实到期验收。后续使用 .hpm-acceptance/context-private-capacity-20261020-01/observe-retention.cjs
check 检查，禁止重置创建时间；没有后台定时器或自动任务。

证据：.hpm-acceptance/context-private-capacity-20261020-01/ 中 reference-outcome.json、reference-covered.log、manifest-cipher-first.log、private-worker-first.log、manifest-covered.log（首轮失败）、manifest-covered-final.log、coverage-manifest-final/、retention-seed.log、retention-check-initial.log 及本次文档保尾收据。以上均为局部验证，不替代原全量并发门禁；原 60 秒容量性能失败尚未重新解决。WBIPC 预算内恢复、全仓验证、最终打包/安装/迁移回滚、真实 Codex/Claude 和其他客户端验收、实际 24 小时观察结束及空闲窗口生产启用仍未完成。未重启生产、未修改已安装客户端、未发真实模型请求。

## 当前阶段：去除原文写入配额的整表复制（2026-10-20；整体未交付）

无采样原五画像基线 118163ms，文本计数候选 158630ms，均完成原内容覆盖/恢复校验；该候选没有证明收益，history-request.js 已逐字节恢复。保留另一处独立改进：artifact-store 的同步 admission 直接遍历已提交和待提交 Map，不再每次写入复制全部记录为新 Map；保持待提交同键覆盖优先级、全部全局/owner/session 字节与数量额度、原期限及事务边界。交替顺序三轮、2048 条混合已提交/待提交记录对照，中位数 662ms
-> 602ms，约 9% 局部收益；不能外推成整体恢复或生产提速。

新增六种配额在 live/pending 混合下的拒绝、回滚后释放、发布后不丢计费、发布不双计费、跨 owner 拒绝，以及已提交/待提交各自到期的回归。初次 10/10 但专项覆盖门禁未达标，补入已有 renewReferences 生命周期与账本测试后扩大为 43/43，语句/行 98.03%、分支 95.81%、函数 96.77%，保持原专项阈值并通过；Lint/格式/CI/发布治理通过。新测试位于既有 unit 自动发现文件中。原容量回归仍 9/10、60000ms 子进程超时，完整五画像、两 worker 和原门禁均未缩减。证据在 .hpm-acceptance/context-history-encoding-benchmark-20261020-01/outcome.json 及其引用日志。完整并发失败、WBIPC、私有历史配额、最终安装/迁移/回滚、真实客户端及实际 24 小时留存、生产启用仍未完成。

## 当前阶段：四任务容量 CPU 定位（2026-10-20；性能门禁未通过）

保留原五画像、两 worker、480 轮/四任务/32KiB 工具输出、400 次精确恢复和 20 次重建，增加 CPU 采样。五画像内容校验均通过，最大 worker 采样耗时 110108ms；这是带 profiler 的诊断时间，不是原门禁时延或生产时延。最大画像 inclusive 采样主要为 begin 约 56916ms、绑定摘要约 29187ms、请求规范化约 22730ms、根重建约 20800ms；这些调用时间有重叠，不可相加。原始工具用合成时钟和 JSON 重建，仍不证明真实传输、SQLite 或 24 小时观察。

尝试不生成无转义文本的 JSON 编码副本后，原始容量回归仍 9/10、子进程 60000ms 超时；Lint 也拒绝了控制字符正则。该尝试已完整撤回，history-request.js 与实验前备份逐字节一致，不保留未经证实的性能改动。新增 JSON 字节边界回归保留：ASCII/CJK、控制及转义字符、成对/孤立代理字符、恰好 2MiB 单项及超一字节。绑定文件 31/31、专项覆盖率阈值及 Lint/格式/CI/发布治理均通过；统一 client
coverage 已包含此文件。没有降低工作负载、超时、worker 数、并发或全量覆盖率阈值。

证据：.hpm-acceptance/context-capacity-profile-20261020-02/ 下 baseline.log、CPU
profiles、profile-summary.json、capacity-after.log、byte-coverage.log、outcome.json。原始全量并发失败及容量性能仍未修复；下一步围绕重复的全历史验证和冷重建成本开展结构性改进，保持完整输入校验、不跨请求缓存原文。此前恢复功能修复和未交付范围见下文。

## 当前阶段：加密长历史冷恢复及完整窗口重建（2026-10-20；整体未交付）

新增并验证两个独立 Node 进程的加密 SQLite 长历史交接：密钥仅由 stdin 传入；约 2.7MiB
Unicode 历史在新 owner 中恢复后，LIST/READ 精确命中原文，并可继续发布。受控时钟从 1000 变为 2000，绝对到期仍为 86401000，没有滑动续期。此项使用测试随机密钥，不代表 DPAPI 全链路或真实 24 小时观察。

WebSocket 冷重开分别覆盖响应 ID 增量续接和客户端重发完整历史。完整窗口用例修正测试输入位置后，仍在新连接发送阶段失败；原因是 assertRebuiltPendingResults 把公开/上游整段历史重新按私有结果的 2MiB 总量校验。现在由实际 binding.historyFormat 传入已有请求规范化模块：受信格式 3 的历史总量 32MiB，单项仍为 2MiB；默认/旧格式保持原限制。私有 pending 结果解析仍是原 2MiB/16 项，不扩大。公共历史不得冒入私有结果；上游必须按顺序恰好出现一次调用及其精确结果。

新增回归包含可信长历史、空历史、默认及非法格式、重复/篡改/倒序结果、公共窗口混入私有结果、非法节点、单项及总量超限、私有结果超限，以及 getter/toJSON 不执行。首次两个文件回归 134/134；最终 root-state、websocket、sessions、loading 四文件专项 203/203，退出 0。pending-results 模块语句/行/函数 100%，分支 97.29%；Lint、Prettier、CI/release
governance 均退出 0。证据位于 .hpm-acceptance/context-long-cold-reopen-20261020-01/，主要为 pending-coverage.log、pending-window-after.log 及 pending-{lint,format,ci,release}.log；修复前负控为 full-window-corrected-before.log。统一 client
coverage 已包含这四个测试文件，没有另建不进入门禁的独立测试入口。

此前完整原始 test:client:coverage 退出 1：1187 项中 1167 通过、12 失败、8 取消，耗时 428953ms；覆盖率语句/行 98.78%、分支 95.01%、函数 98.99%，但测试未通过。失败含真实 worker 重开/storage_unavailable、fixture/原生辅助进程启动和容量 60 秒超时，不能把原因统一认定为环境负载，也不能以本次专项取代全量门禁。原工作负载、60 秒容量超时、并发与覆盖率阈值均未降低。

对全量失败中的 idle、policy-basis、publication 三文件做诊断复跑，普通运行 44/44、测试耗时 43546ms；保留 V8 覆盖率采集后仍 44/44、测试耗时 74672ms，两个命令均退出 0，未修改测试期限。后者仅是子集诊断，没有启用全量覆盖率验收阈值，不能代替原始全量门禁；全量并发下的失败仍未定位。证据为 storage-failure-recheck.log 与 storage-failure-covered-recheck.log。

仍需完成 WBIPC 预算内恢复策略、版本化私有历史配额、全量并发失败根因、全仓验证、最终安装包与迁移回滚、真实 Codex/Claude 接入、实际 24 小时留存观察及空闲窗口生产启用。未重启生产、未修改已安装客户端、未发真实模型请求。

## 当前阶段：WebSocket 长历史与共用异步加载入口修复（2026-10-20；整体未交付）

真实压缩/分片 WebSocket 回归先复现两个阻断：旧消息/调度边界拒绝大历史；修复这些边界后，受信会话异步加载仍因 storageData 的 2MiB 总量返回 context_recovery_storage_unavailable。为异步 owner
admission 单独增加负控，在修复前同样失败，随后将共用加载入口改为已有 normalizeRecoveryHistoryRequest(input,3)，保留单条消息和策略各 2MiB、总量 32MiB、深度/节点、所有者和旧根匹配限制。这个加载入口也被 HTTP 使用，先前 HTTP 发送验证不能替代真实异步会话验收。

WebSocket 客户端消息在已授权连接内可先按 32MiB 暂存并验证每条历史及元数据，随后必须由实际 session 的 historyFormat 明确授权；没有可用绑定或格式 2 的大请求在发送前关闭，不通过普通转发绕过。默认消息解析、上游接收、客户端发送和累计响应仍是 2MiB。入站 ws 解压总量和上游发送按 32MiB 有界。连接保留原 16 个活跃回合、32 个待处理请求/命名流限制，所有在途请求合计不超过 32MiB；普通小请求合计仍按原 2MiB 限制计费，不借新大历史额度扩大。关闭/完成同步回收相应字节计数。

恢复调度从 session 接收格式后，按同一额度校验请求与私有前缀合并；仍只保留逐项摘要来判断精确祖先，不能把修改过的历史投影为增量。warmup
receipt 的下一条长历史只改变本地 admission，继续要求同连接/流、策略一致、单次使用、原 60 秒到期，并把实际请求原样发给上游。私有 deferred 结果自身的 2MiB 边界和延续总量没有在此阶段扩大，版本化私有历史配额仍是后续工作。

新增真实本地上游用例完成：空 warmup -> 约 2.7MiB
Unicode 历史（压缩、分片）-> 公开外部工具调用 -> 上报原文 -> 私有 LIST
-> 私有 READ 精确命中 -> 公开最终响应。客户端事件未出现私有 LIST/READ 工具。另覆盖格式 2 调度拒绝、格式 3 长历史逐条保真与后续增量、恰好 32MiB/超一字节、单条/元数据超限、响应不扩容、没有受信绑定禁止发送，以及大请求队列溢出清理。测试使用生产 WS/会话/读取模块和本地合成上游，不代表真实 OpenAI 或 Codex 客户端验收，也未证明长历史断线后的冷恢复。

最终冻结专项 185/185 通过；七个修改运行时模块合计语句/行 97.30%、分支 92%、函数 98.27%，原阈值未调整。零警告 Lint、格式、CI 治理和发布治理通过；1469 个源码/测试/配置文件摘要在验收前后一致。旧版拒绝、队列、取消、混合结果、加密重开和私有读取的既有回归均保留。证据目录：.hpm-acceptance/context-websocket-long-history-20261020-01/，包括原始失败、加载负控、真实链路中间失败、最终 coverage.log、receipt.json 和源码摘要。

整体仍未交付：完整客户端覆盖率与全仓 verify 尚未通过；WBIPC、版本化私有历史配额、长历史冷恢复、最终包和隔离安装迁移/回滚、真实 Codex/Claude、真实 24 小时留存及生产激活仍需完成。没有修改生产进程、已安装客户端或调用真实模型。

## 当前阶段：九条 HTTP 转换路径的长历史资格与发送验证完成（2026-10-20；整体未交付）

本轮补齐 Chat/Claude 到 Responses、Chat/Responses 到 Claude
Messages，以及 Chat/Responses/Claude 到 Gemini 的七条转换路径，与此前 Responses/Claude 到 Chat 合计九条。受信 session 的 historyFormat=3 经转换工厂传递，转换前后请求均使用已有 32MiB 总量、单条记录及非历史元数据各 2MiB 的边界；旧格式保持 2MiB。Gemini 出站请求只将 contents 作为历史，systemInstruction、工具和生成参数仍计入独立元数据预算。没有改变原生协议入口支持种类、上游权限或响应预算。

同时修复长历史保真比较的隐藏瓶颈：请求侧事件数组使用版本化历史摘要，指令仍使用原有小额度摘要，工具定义与响应保真比较也保留小额度。Messages/Gemini 的原有投影先后比较均继续验证每条事件、角色、工具 ID/参数/结果及顺序，不通过跳过投影来放行长历史。请求体里的 historyFormat 字段不能申请受信额度。

七个新转换用例在旧源码下 7/7 失败；修复后专项最初 77/77，最终包含真实本地 HTTP、四个转换家族、原生协议和 HTTP/入口的冻结验收 121/121 通过。新增本地真实 HTTP 用例逐一发送九条路径约 2.7MiB 的多条 Unicode 历史，校验完整原文、原顺序、Content-Length 与实际发送字节一致；使用真实生产转换函数与 HTTP
dispatcher，但上游响应是本地合成，未调用真实模型，也不代表真实客户端和恢复会话全链路验收。资格回归额外检查七条新路径只有受信格式 3 才进入 provider 资格检查，未接管观察器。

新增边界覆盖旧格式拒绝、空历史、超大单条消息、超大元数据、超过 32MiB 总量、请求体伪造格式、访问器不执行、输入不变与各路径逐条保真；已有响应协议回归继续通过。五个修改运行时模块合计语句/行 99.22%、分支 90.22%、函数 100%，阈值未调整。零警告 Lint、格式、CI 治理、发布治理通过。验收前后 1469 个源码/测试/配置文件摘要一致。新测试均进入已有统一单测发现和客户端覆盖率入口。

证据：.hpm-acceptance/context-conversion-long-history-20261020-01/receipt.json、regression-before.log、coverage.log、http-long.log 及 source-before/source-after.json。前一轮完整客户端覆盖率的 5 项失败、4 项取消仍未解决，本轮专项不能替代它；修复后全量及全仓 verify 尚未通过。

进一步核对发现 WBIPC 当前代码默认请求预算为 384KiB、输入 token 预算为 96Ki
tokens，这是当前代理策略，并非本轮实测的服务端物理上限。其入口和转换仍需单独设计及验收，不能直接把 HTTP 长历史额度复制过去。WebSocket 的消息、调度、延续及缓存也仍有独立小边界。下一步仍包括这些路径、版本化私有历史配额、原完整并发超时、最终包/隔离安装迁移和回滚、真实 Codex/Claude、真实 24 小时留存及生产激活。整体仍未交付。

## 当前阶段：转换到 Chat 的长历史补齐；完整门禁仍失败（2026-10-20）

本轮保留两项增量：容量验收命令以估算负载降序分配到原来的两个 worker，最大档立即开始，五档内容、60 秒子进程超时及测试并发均未改变；Responses
/
Claude 转 Chat 的恢复转换器接收受信 session 的 historyFormat=3，使用已有 32MiB 请求历史总量，同时维持单消息和非历史元数据各 2MiB、旧格式总量 2MiB，以及响应独立 2MiB。请求体不能自行声明格式。其他转换家族、WBIPC、WebSocket 长历史尚未补齐；放宽公共入口总量不会绕过它们各自的资格检查。

容量单独回归 10/10 通过，但之后运行原 test:client:coverage 完整命令仍失败：1168 项中通过 1159、失败 5、取消 4；语句/行 99.03%、分支 94.95%、函数 99.16%。失败涉及容量命令原 60 秒子进程超时、隔离代理 15 秒启动、故障注入子进程 10 秒启动、DPAPI
10 秒后端，以及加密 worker/运行时 30 秒测试。覆盖率过线不代表门禁成功。这次完整运行发生在长历史转换修复之前，不能证明修复后的全量状态。

长历史新增回归在旧源码下 3/3 失败；修复后两个文件 18/18 通过，随后包含四种转换家族、HTTP/入口和协议的专项 112/112 通过。两个修改模块合计语句/行/函数 100%、分支 96.11%；零警告 Lint、格式、CI 治理及发布治理通过。测试覆盖约 2.7MiB 中文/Unicode 历史逐条保真、受信和旧格式区分、超大单条/元数据/总量、请求体伪造格式、超大响应及发送前失败。真实客户端与生产上游仍未验收。

三个候选运行时优化均因完整工作负载无收益而撤回：历史分配微优化、状态字符串缓存分区、快照负查询过滤。候选通过记录不作为当前源码验证；撤回证据保留在 context-history-allocation、context-state-encoding、context-snapshot-filter 各自验收目录。当前容量调度只是验收命令调度改进，不是生产恢复提速的证据。

证据目录：.hpm-acceptance/context-capacity-scheduling-20261020-01/。下一步仍需解决原完整并发门禁超时，补齐其余协议长历史与私有历史配额，并完成最终包、隔离安装迁移/回滚、Codex/Claude 实际客户端、真实 24 小时留存及生产激活。整体未交付。

## 当前阶段：重建来源策略的有界复用（2026-10-20，整体仍未交付）

同一源码的串行对照：仅将来源策略复用替换为原逐来源解析，五档内容仍 5/5，未采样耗时 73633
ms；启用复用的最终冻结为 69594 ms，单次配对减少 4039
ms（约 5.49%）。该对照每档仅一次，不能推导稳定生产提速，也不能把历史 87571
ms 与本次值的全部差异归因于本改动。新模块语句/分支/函数/行独立覆盖均为 100%，范围仍只代表该模块。

CPU 采样定位到检查点恢复对相同来源原文反复执行完成状态/敏感内容/编码字节校验。本轮新增独立模块 context-recovery-source-policy，只在一次根重建调用内复用成功校验。调用 ID 每次仍检查格式，缓存同时固定工具名、调用 ID 长度和原文；ASCII
ID 长度参与整体 JSON 字节边界，不能用较短 ID 的成功放行较长 ID。只保存最多 128 个成功组合、合计 4
MiB，达到任一上限后继续完整校验；失败不缓存，函数结束不保留缓存。来源摘要、UTF-8、字节数、期限、所有者、预算和父子关联仍由原导入器逐条校验。

负控用原逐来源解析行为时，重复校验回归明确失败（2 次对目标 1 次）；修复后通过。新增回归覆盖相同/不同工具和 ID 长度、编码恰好及超一字节、敏感文本、未完成响应、非法标识、钩子、Unicode/代理项、1
MiB 原文、128 项和 4
MiB 缓存边界，以及新操作不复用旧操作。第一冻结专项 284/284 和格式/Lint/治理/发布清单/网关准备通过，随后为排查末尾换行假设主动停止；独立实测证明当前 JavaScript 正则拒绝末尾换行，假设不成立，生产缓存逻辑未因此改动，中断记录保留。

最终冻结证据 .hpm-acceptance/context-source-policy-20261020-02/receipt.json：专项 284/284，零失败/取消/跳过，格式、零警告 Lint、CI 治理、发布清单、网关准备及独立新模块覆盖门槛通过，1468 个源码文件摘要一致。原五档容量内容目标 5/5，四任务 1920 轮、400 次精确恢复与 20 次 JSON 重建保持；未采样命令耗时 69594
ms，原 60 秒性能门槛仍未通过。原目标、超时、测试并发和覆盖率阈值未放宽；未执行完整客户端覆盖或全仓 verify，不能把专项通过当成整体交付。

协议转换、WBIPC/WebSocket 与私有留存的大历史资格、启动稳定性、完整门禁、最终包、迁移/回滚、多端实机、24 小时实际留存观察和生产激活仍待完成。未重启生产、修改已安装客户端或请求真实模型。

## 当前阶段：原生 HTTP 与私有恢复长历史（2026-10-20，整体仍未交付）

本轮后续修复（2026-10-20）：两份方案曾被不兼容 CRLF 的段落替换误截短，现已从原始备份及成功历史写入精确重建。恢复时 SHA-256 分别与截短前记录完全相同，原生优先方案 45088 字节、多端方案 208338 字节；随后只更新顶部版本 9 进展，历史正文逐字相同，见
`context-v9-http-20261020-02/doc-recovery/restoration-receipt.json` 和
`post-doc-check.json`。源码 1467 文件哈希不变。另运行原五档容量命令的 CPU 采样，`context-capacity-profile-20261020-03/receipt.json`：内容 5/5，四任务 1920 轮/400 次精确恢复目标保持，带采样总耗时 92924
ms。此值含采样成本，不能替代未采样的原 60 秒性能门禁。长任务 Worker 的含子调用采样热点为 begin 约 48.7%、绑定前沿约 24.6%、检查点恢复约 23.5%，各项有嵌套、不能相加；检查点导出另约 9.6%。尚未修改这些性能路径，不能声称性能已修复。采样原始文件、汇总和调用路径已留存；未修改门槛、并发或任务规模。

原生 Chat、Responses、Claude 请求在协议解码、会话恢复、规范摘要、私有轮次拼接、HTTP 接管/发送和后续映射重建间贯通格式 3 的 32
MiB 总预算。新模块 `context-recovery-request-data.js`
按描述符克隆并累计编码字节，共享深度/节点限制；每条消息和独立元数据仍各限 2
MiB，响应仍独立限 2
MiB。默认调用保留格式 2，格式选择来自已绑定任务与会话能力，不能由请求字段切换。HTTP 压缩输入同时限制压缩前缓冲和解压后字节；旧格式任务重开后仍按原额度拒绝长历史，不自动升级。

规范历史摘要使用专用入口，保留旧的排序和数组顺序；通用策略/请求指纹默认额度未放宽。Codex 长历史摘要请求继续走单独的 compaction 分类，不会误当普通生成。公有历史进入和离开私有映射时也按绑定格式校验，私有尾部保留额度仍独立为旧界限。测试使用实际观察到的公开工具调用作为后续绑定锚点；普通文本不因增加恢复逻辑而变成可跨请求定位的身份。

冻结
`.hpm-acceptance/context-v9-http-20261020-02/receipt.json`：23 个统一入口中的相关文件
**469/469**，零失败/取消/跳过；格式、Lint（零警告）、CI 治理、发布清单、网关准备退出 0；1467 个源码/配置文件哈希前后一致。新增归一化模块独立覆盖 S/L
**92.1%**、B **95.65%**、F **100%**，覆盖率运行的相关测试
**59/59**。不是完整客户端覆盖或全仓 verify。

证据覆盖三种原生协议各 2.7
MiB 聚合历史的压缩/非压缩准入、私有读取续轮、公开输出提交与下一请求精确重建；格式 2 根恢复后拒绝超额历史；32
MiB 编码恰好允许和多一字节拒绝；单消息/元数据独立超额、空/非法/稀疏/原型/访问器/toJSON/循环输入；实际本地 HTTP 发送超过 2
MiB 的请求，仍拒绝超过原界限的响应。均为合成内容与本地服务，没有真实模型调用或已安装客户端验收。早期
`context-v9-http-20261020-01`
的 107/107 仅覆盖私有续轮；随后 178/179 暴露完整续接测试缺少公开观察锚点，补齐真实工具调用锚点后才完成当前全链路断言，失败日志保留。

协议转换入口、WBIPC/WebSocket、独立私有历史留存还有各自的旧界限；本轮只运行它们的既有回归，不能称为大载荷资格通过。仍需解决原容量命令 87571
ms 超过原 60 秒门禁和启动超时，完成完整统一门禁、最终包、迁移/回滚、多端实机与至少 24 小时真实留存观察。整轮缓冲仍是默认；未重启生产、修改已安装客户端或发起真实模型请求。

## 上阶段：版本 9 加密持久化与 Worker 字节链路（2026-10-20，整体仍未交付）

明确的版本 9 检查点、引用请求、完整加载/扫描和 Worker 消息现在按版本选择编码预算。通用 opaque/direct-root 状态仍限 12
MiB，单个加密来源与清单仍限 12
MiB；完整大检查点先分离来源再加密，不把整个大载荷塞进单个密文封装。旧根与不透明状态共享原 32
MiB，新根四任务物理总额度为 512 MiB、每根最多 128 MiB；原文仍按每根 16
MiB 校验。数据库文件上限 1 GiB，目录包含回滚日志的上限为 2 GiB + 2
MiB，均为上限而非预分配。队列最多 8 项，合计 128 MiB，旧请求仍独立共享 16
MiB 在途额度。

物理配额类别来自已认证且经过语义校验的存储表示，伪造版本不能获得真实 SQLite 保存资格。完整快照写入也固定容量类别、预算版本与绑定格式；完整快照继续支持既有暂存来源替换，增量引用保持其独立的不可变来源约束。配额统计保留旧完整检查点的暂存语义，不将它错误转换成引用状态。旧任务的绝对到期时间不更新。

冻结证据：`.hpm-acceptance/context-v9-storage-20261020-02/receipt.json`，16 个统一入口中的相关测试文件
**351/351**，零失败/取消/跳过；格式、Lint（零警告）、CI 治理、发布源清单、网关准备均退出 0；1466 个源码/配置文件哈希前后一致。实际 Windows
DPAPI 加密 Worker 完成四任务合计 **64 MiB**
原文的保存、关闭、重开、摘要/期限核验、精确原文页及完整加载/扫描；第五任务拒绝后原四任务保留。另覆盖超过旧 12
MiB 编码界限的控制字符原文、旧 32
MiB 聚合额度、跨类别替换拒绝、队列释放、事务回滚、混合期限和精确到期清理。测试使用合成内容与受控时钟，不代表 24 小时真实等待观察。

失败证据保留在
`context-v9-storage-20261020-01`：首轮存储 67/71，扩大运行 350/351，分别暴露测试原型断言/来源编码准入、新配额统计误拒暂存来源、完整保存误套增量语义、旧清理回执上限断言；修复后才运行最终冻结。相关测试沿用统一单元和客户端入口，新增模块已进入发布源清单。完整客户端覆盖和全仓 verify 本轮未执行。

仍须贯通 HTTP/私有生成长历史，解决原容量命令 87571
ms 超过原 60 秒门禁及启动超时，完成完整统一门禁、最终包、安装迁移/回滚、Codex/Claude 多端实机与至少 24 小时实际留存观察。本轮不能将内存容量画像中的
`durableStorageQualified:false`
自动改为 true：实际存储测试已经通过，完整画像尚未组合存储与 HTTP 链路。整轮缓冲仍为私有恢复默认，额外公开生成请求未获选择；未重启生产、修改已安装客户端或请求真实模型。

## 上阶段：版本 9 内存容量与检查点引用转换（2026-10-20，整体仍未交付）

新根版本为 9，每根原文从 4 MiB 增至 16
MiB，调用/来源/快照数量沿用版本 8 的 1024/512/512；版本 1–8 保留原字节配额，旧任务不自动升级或续期，仍为原来的绝对到期时间。完整根与检查点使用显式 112
MiB 编码预算，覆盖原文 JSON 转义膨胀；按描述符逐项克隆和累计字节，不构造完整原文 JSON 来做准入。旧检查点仍限 12
MiB，默认策略/请求指纹仍限 2 MiB，通用归一化器上限未提高。

版本化准入已贯通完整检查点创建、解析、摘要、引用写入转换和引用状态重建。实际 16
MiB 原文可经引用转换、完整重建及已有原文的空增量写入保持相同摘要和期限。引用原文批次根据已校验的来源版本选择编码预算，默认仍为旧界限。绑定优化保留原规范摘要：跨请求只保存有界摘要链；小消息及字符串编码缓存限于单次请求。时钟每次校验，只有到达最早期限才扫描过期索引；撤回和回滚仍即时失效。普通文本用原生 Unicode 类别扫描跳过无需转义的逐字符循环；控制字符、Unicode 和单独代理项继续精确计费。

本轮复现并修复引用接收端的跨类别替换漏洞：原接收端会接受同一根从版本 8 升级到 9 的有效引用，尽管发送端已拒绝。接收端现在同时固定容量类别、读取预算版本及绑定格式；回归覆盖升级、降级、预算变更、同类别合法续写，以及真实加密内存 SQLite 事务拒绝后修订号、旧原文和期限保持。复现证据为
`.hpm-acceptance/context-v9-reference-category-before.json`，不涉及生产数据。

最终专项冻结
`.hpm-acceptance/context-v9-checkpoint-codec-20261020-03/receipt.json`：六个统一客户端入口中的测试文件共
**224/224**，零失败/取消/跳过；格式、Lint、CI 治理、发布清单和网关准备均退出 0，全部被测源哈希前后一致。当前源码独立容量命令耗时
**87571 ms**，五档内容目标
**5/5**：第五档完成四任务合计 1920 轮、400 次精确恢复、20 次 JSON 重建及末轮排空。但独立耗时仍超过原 60 秒门禁，不能将内容合格解释为性能或完整客户端门禁通过。目标、超时、测试并发和覆盖率阈值未放宽。

失败记录完整保留：较早完整冻结 `context-v9-root-bytes-20261020-02`
的相关 449/450、完整客户端 1144/1146（一项失败、一项取消）；检查点第一冻结
`context-v9-checkpoint-codec-20261020-01`
的相关 495/496、完整客户端 1147/1149（一项失败、一项取消），主要为容量 60 秒与网关 15 秒超时。它的相关 11 模块 S/L/F 为 100%、B 为 95.78%，该覆盖证据早于最终接收端修复，不能充作最终源码的完整覆盖通过。第二轮扩大运行
`context-v9-checkpoint-codec-20261020-02`
相关 486/497、七项失败和四项取消，包含多个启动/子进程超时与两项正则 Lint 错误；已显式终止该运行树，完整客户端未启动，Lint 随后已修正。不能将这些失败归因于单一环境问题，根因仍须定位。

**新容量尚未贯通持久化与传输。**
检查点/引用编解码的通过不证明 Worker、存储请求/响应、加密封装、物理总配额或四任务同时持久化合格；这些仍存在旧的 12/32
MiB 边界。HTTP/私有生成仍有独立的 2
MiB 准入及私有历史预算，需按版本贯通，不能只提高通用上限。五档画像的
`transportQualified` 和 `durableStorageQualified`
均为 false。后续依次补版本化存储字节链路与物理配额、HTTP/私有交换、性能与启动根因、完整统一门禁、最终包及安装/迁移/回滚、多端实机和至少 24 小时真实留存观察。整轮缓冲仍是隐藏恢复中间内容的默认；额外公开生成请求方案仍待用户决策。未激活生产、改变已安装客户端或发起真实模型请求。

## 当前阶段：原文列表逐条校验（2026-10-20，版本化扩容尚未启用）

新增
`context-evidence-payload-envelope.js`，完整账本和引用写入的原文列表逐条复制校验，小元数据独立归一化，原文按 UTF-8 及 JSON 转义的实际字节累计。此处不再序列化包含全部原文的数组或对象，也不再为计算转义体积构造单条原文的 JSON 副本。输入只接受普通/空原型记录、稠密数组和自有可枚举数据字段，不调用访问器或
`toJSON`；来源元数据为标量，列表最多 512 条。摘要、owner、重复身份、时间、策略及读取进度仍由原账本/引用校验器验证，安全日志不含原文。

本轮保持旧的 12
MiB 编码后总界限，单来源界限仍由调用方提供；没有升级根版本、提高每根 4
MiB 原文额度或延长 24 小时绝对期限。它是后续版本化扩容的基础，不代表已贯通检查点、存储 Worker、加密封装或 HTTP 的大载荷链路；这些上层仍有整对象归一化和各自的字节门禁。

新增回归覆盖精确 12
MiB 与多 1 字节、转义膨胀、全部控制字符、Unicode、空与 512 条列表、非法 UTF-8、原型/访问器/非枚举/符号字段、嵌套元数据、单条及累计超额、独立副本，以及原回执、读取计数和到期时间。测试监测序列化调用，确认这两处校验不序列化原文。用例进入既有统一单元和客户端门禁，新增模块进入发布源清单。

冻结 `.hpm-acceptance/context-payload-envelope-20261020-01/receipt.json`：相关
**293/293**，三个相关模块联合 S/L/F **100%**、B **94.98%**，新增模块单独 S/L/B/F
**100%**；字面 `npm run test:client:coverage`
**1139/1139**，零失败/取消/跳过，S/L **98.99%**、B **94.80%**、F
**99.14%**。格式、Lint、CI 治理、发布清单、网关准备均退出 0，源码冻结哈希一致。

容量 CLI **16895
ms**，仍因第五组第 130 轮应有 129 来源、实际 128 的原文缺口退出 1，四组通过、整体
`capacityQualified: false`；目标、配额、超时和覆盖率阈值均未放宽。完整 verify、启动偶发故障根因、HTTP/私有生成长历史、版本化原文与物理存储扩容、最终包、多端实机、迁移回滚与至少 24 小时生产验收仍未完成。未激活生产、改变已安装客户端或发起真实模型请求。

## 当前阶段：内部会话长历史格式 3（2026-10-20，原文容量与传输链路仍未完成）

新会话根的绑定格式为 3，内部请求总准入上限 32
MiB；每个历史条目及策略等其余元数据仍分别限制在 2
MiB，全请求仍共用 65536 节点和 64 层深度约束。根版本仍为 8，数量、每根 4
MiB 原文、存储字节、读取预算与 24 小时绝对期限不变。已存在格式 2 或无格式记录恢复后继续导出格式 2，普通续写不升级历史准入；格式 3 只适用于新根。旧解析器拒绝格式 3，不构成旧安装包回滚兼容承诺。

新增独立历史请求模块，在未知输入的描述符、原型、数组密度、字段和 JSON 值校验过程中逐条克隆并累计转义后的精确字节数，随后冻结新克隆。绑定与会话复用同一份不可变请求，不构造完整历史的规范 JSON 来计算大小。字符串字节计数和规范编码各使用单次请求内的 128 项/4
MiB
UTF-8 计量缓存，结束后不跨请求保存；绑定注册表仍只保存摘要与因果元数据。数组顺序、对象键规范编码和已有摘要语义保持。

绑定导出、独立/多根恢复、全根与引用元数据校验、持久引用转换和服务接纳均识别格式 3。已有根的历史格式固定，保存前和首次写入前也拒绝跨格式升级或降级。回归覆盖 2/32
MiB 精确边界、空数组、元数据加空历史的总字节溢出、重复与不缓存文本、JSON 转义、数值/Unicode、总节点和总深度、稀疏数组、原型、访问器、不可变复用以及旧根保留原限制。内部超过 12
MiB 历史的实际会话导出和重建后，可以精确读回原文，期限不续期。这些测试进入原有统一单元和客户端入口。

第五组目标仍为 4×480 轮、每份 32
KiB、每任务 100 次恢复，没有缩小。内部长历史已从第 65 轮拒绝推进到第 130 轮的真实原文缺口：四任务完成
**516** 轮、**104**
次精确恢复、5 次 JSON 重建后，根 0 应有 129 个来源而实际只有 128，符合原每根 4
MiB 原文上限。画像现在在已记录首个覆盖缺口后停止继续修改任务，成功条件、目标轮次和完整排空要求不变；失败后少执行后续轮次不能使画像合格。五画像仍为
**4/5**，`capacityQualified: false`。

第一冻结 `context-history-v3-20261020-01/` 保留容量 CLI
60 秒超时及网关启动 15 秒超时；不延长期限、不改覆盖阈值或测试并发入口。优化后第二冻结
`.hpm-acceptance/context-history-v3-20261020-02/receipt.json`：相关
**433/433**，历史模块及规范编码模块联合 S/L/F **100%**、B **97.38%**；字面
`npm run test:client:coverage` **1134/1134**，零失败/取消/跳过，S/L
**98.98%**、B **94.79%**、F
**99.13%**。格式、Lint（零警告）、CI 治理、发布清单和网关准备均退出 0，冻结源码哈希一致。五画像命令
**16659 ms**，因第五组缺口如实退出 1。第二轮通过不关闭原先偶发启动失败根因问题。

本阶段只贯通内部会话历史准入。HTTP 恢复入口、私有生成状态机及私有历史重建仍有独立 2
MiB 限制，尚未扩大或证明大载荷传输；原文与存储仍需版本化预算和分块校验/持久化。因此不能把内部 32
MiB 准入视为完整端到端支持。完整 verify、私有交换长期容量、启动稳定性、最终安装包、多端实机、升级回滚和生产验收均未完成。本轮未切换生产、修改已安装客户端或发起真实模型请求。

## 当前阶段：版本 8 持久发布容量贯通（2026-10-20，大载荷及整体资格仍未完成）

检查字节链路时发现真实持久化服务仍将所有根的发布记录合计限制为 256，未使用版本 8 的数量容量。现在发布记录按已验证根版本准入：每个新根最多 512，所有已保留根合计最多 2048；旧根自己的发布记录合计仍最多 256，与新根共存也不自动升级。容量版本在服务内固定，跨容量类别的再次接纳被拒绝。

新增独立的发布计数校验放在已有容量模块，验证未知输入、严格字段、版本、每根及总数边界，不执行访问器或用户转换。写入在等待存储前预留发布额度，并计入其他任务的并发准入；写入错误可能发生在持久提交之后，因此保留失败根的占用，不能以错误回执再次释放额度。根仍需原有 owner 租约和 CAS，未增加任何恢复授权。

新增实际会话回归先在内存形成 511 个已提交快照，再通过原有异步发布链路提交第 512 个，写入加密的内存 SQLite，随后异步读回最早精确原文；独立持久化服务实例重新加载并保存 512 条发布记录，期限不变。该用例验证一次批量持久发布及重新接纳，不证明 512 轮逐轮持久化、磁盘文件重开或全天资源资格。另以合法撤回记录构造四根各 512 条的门禁用例，验证合计 2048 的加载和保存；这不是四根各 512 次真实客户端发布。旧根的 256 上限、并发抢占及不确定写入占用均有回归，沿用统一测试入口。

冻结证据
`.hpm-acceptance/context-publication-capacity-20261020-01/receipt.json`：相关
**308/308**，容量与持久化服务两模块联合 S/L/F **100%**、B **95.41%**；字面
`npm run test:client:coverage` **1128/1128**，零失败/取消/跳过，S/L
**98.98%**、B **94.84%**、F
**99.12%**。格式、Lint、CI 治理、发布清单和网关准备均退出 0，源码冻结哈希一致。完整五画像
**20130 ms**，仍因第五组失败退出 1，保持四组通过及 `capacityQualified: false`。

本轮只接通已经声明的数量容量与并发门禁，未扩大历史、原文、存储字节或 24 小时期限。第五组所需的版本化长历史和分块原文存储仍待实施；启动偶发失败、完整 verify、最终安装包、多端实机、升级回滚和生产验收也未完成。未修改生产进程或已安装客户端，未发起真实模型请求。

## 当前阶段：大检查点摘要边界修复（2026-10-20，整体容量资格仍未完成）

发现根状态允许 12 MiB，但写前检查点摘要沿用请求指纹的 2
MiB 限制，导致合法大原文能导出却不能创建检查点。新增显式
`fingerprintRecoveryCheckpoint`，仅用于完整检查点创建、解析和启动暂存清理，保持 12
MiB 存储边界；请求、策略、授权及引用元数据的默认指纹仍限制 2
MiB。没有调整原文字节预算、磁盘格式、根版本、读取预算或绝对到期时间。

摘要在验证未知输入后增量写入 SHA256，不再另外构造完整的排序对象和其 JSON 字符串。保留旧摘要的 JSON 属性顺序：数组索引键按数值顺序，其他键按字典序；数组顺序、转义、负零和 Unicode 语义保持。正常、空值、数字键极值、孤立代理字符、访问器、toJSON、循环、非有限数字、稀疏数组、非法原型以及原始/转义字节溢出的回归进入现有统一测试入口。

实际会话生成 7 份各约 400 KiB 的大量反斜杠原文，约 5.6 MiB
JSON 检查点经加密 SQLite 保存、重开、引用状态转换及再次重开后，全部原文字节一致，期限不续期，到期后不可读取。该用例也断言旧的 2
MiB 指纹入口仍拒绝这个载荷。这里验证的是本地加密存储引擎重建，不构成真实客户端或全天磁盘资源资格。

冻结证据
`.hpm-acceptance/context-checkpoint-fingerprint-20261020-01/receipt.json`：相关
**361/361**，摘要模块 S/L/F **100%**、B **93.33%**；字面
`npm run test:client:coverage`
**1124/1124**，零失败/取消/跳过。格式、Lint、CI 治理、发布清单和网关准备均退出 0，冻结源码哈希一致。完整五画像仍因第五组失败退出 1，前四组保持通过，`capacityQualified: false`。

第五组仍受 2 MiB 长历史与每根 4
MiB 原文预算限制；下一步需要版本化的字节预算、历史绑定及分块存储链路，不能仅提高单个上限。偶发启动失败根因、完整 verify、私有交换长期容量、最终安装包、多端实机、升级回滚和生产验收仍未完成。本轮未修改生产进程或已安装客户端，未发起真实模型请求。

## 当前阶段：版本 8 数量容量贯通（2026-10-20，四个小载荷画像通过，大载荷及整体资格仍未完成）

新增独立
`context-recovery-capacity.js`，用根状态版本选择不可变数量约束。新任务根版本 8：每根累计 1024 次观察调用、512 个来源、512 个已提交快照；共享绑定注册表总上限 2048，仍只容纳 4 个根。单次结果/观察调用仍最多 128 项，原文每根 4
MiB、单来源 1 MiB、历史请求 2 MiB、根状态 12 MiB、存储 32
MiB、任务读取预算和绝对 24 小时期限不变。这是数量容量升级，没有扩大原文字节预算。

版本 1–7 的旧记录继续使用累计 128 调用、64 来源、256 快照；恢复和接纳仍检查旧记录合计最多 256 个快照，普通续写不升级容量。根状态、检查点、引用写入、引用状态转移及 SQLite 来源索引使用同一版本容量；检查点对比和已有引用转换拒绝跨容量类别升级/降级。旧 schema 的兼容重导出继续使用 6/7，旧预算及到期时间保持。旧解析器拒绝新根版本 8；这不构成旧安装包可读新任务或升级回滚资格声明。

会话提交再检查容量，多个同时待提交的分支不能共同超过已提交上限。覆盖率观察按根版本允许 128/1024 个调用，旧默认接口仍限制 128，避免新根超过 128 调用后 LIST 因旧投影边界拒绝。来源页、载荷选择、持久确认后卸载及加密来源索引的数量边界同步接通；配额不足不淘汰已有原文。私有历史快照引用的导出/恢复支持 512 个 tips，旧根仍限制 256；私有交换自身的 256 条全局保留上限和 4
MiB 字节预算保持，更多实际私有恢复轮次仍需另行容量设计和验收。

回归验证累计 1024 调用及单轮/累计溢出、512 快照和并发提交溢出、旧来源 64 的缺口保留、旧根合计快照拒绝，以及 512 个精确来源进入加密引用存储、重开实例、JSON 重建并读回最早原文。第 513 个来源不挤掉旧原文。另验证超过 256 个快照引用同一已保留私有历史的导出和重建；这不等于 512 次私有模型恢复或 SQLite 全天资源资格。

固定画像的前四组已按原目标通过：day-small 288 轮/24 次恢复、active-small
480 轮/30 次恢复、four-tasks-small 共 384 轮/32 次恢复、frequent-recovery
96 轮/96 次恢复；均排空最后结果且无覆盖缺口或读取失败。第五组 four-tasks-candidate 仍在第 65 轮、共完成 256 轮后因长历史 2
MiB 限制拒绝，未达到 4×480 轮/32
KiB 原文目标。这里仍是合成时钟下的实际会话与 JSON 重建画像，传输、持久长时资源和真实模型资格均为 false。

扩大运行暴露容量 CLI 的串行五画像在并发测试下超过原 60 秒，第一冻结失败保留于
`context-capacity-v8-20261020-01/`。现在两个固定工作线程完整执行五组画像并按原顺序汇总；不改期限、画像、并发测试入口或覆盖阈值。线程回复经限长、画像/字段/计数/状态一致性校验，必须恰好一个有效回复并正常退出；错误、畸形或提前退出不能被解释为容量拒绝，剩余线程会终止回收。纯边界和实际 CLI 测试沿用统一入口，独立线程模块 S/L/F
**100%**、B **98.43%**。

最终冻结 `.hpm-acceptance/context-capacity-v8-20261020-02/receipt.json`：相关
**370/370**，两个新增模块联合 S/L/F **100%**、B **98.64%**；字面
`npm run test:client:coverage` **1121/1121**，零失败/取消/跳过，S/L
**98.97%**、B **94.87%**、F
**99.03%**。格式、Lint、CI 治理、发布清单及网关重建退出 0，源码冻结哈希一致。完整五画像命令
**20905 ms**、仍因第五组未达标退出 1；回执明确四个 `qualifiedProfiles`，并保持
`capacityQualified: false`、`rootVersion: 8`、`oldRootCapacityPreserved: true`、`quotasChanged: true`。此前第一冻结及各轮诊断失败均保留，没有提高原 60 秒期限或减少画像。

完整 verify、偶发启动失败根因、第五组大载荷、隐藏交换长期容量、最终安装包、多端实机、升级回滚和生产验收仍未完成。本轮未切换生产、修改已安装客户端或发起真实模型请求。

## 前一阶段：持久读取稀疏结算（2026-10-20，全天容量仍未整体达标）

持久读者此前每次结算都发送全部来源的进度，消息大小与保留来源数量一起增长。新增结算版本 2：单次预扣只允许一次读取，结算最多携带一个改变了 coveredThrough/readComplete 的来源；LIST、拒绝读取以及进度未变的重复读取携带空数组。owner 在预扣前记录进度基线，生成差异；确认或释放租约时清理基线。磁盘根状态、来源身份、权限、TTL、来源配额和读取预算不变。

应用版本 2 时，省略的来源保留原进度；未知来源、多个来源、进度回退、越界、非法 UTF-8、预算版本/调用数变化、到期续命及跨根更新继续被拒绝。仍先落盘最大预算预扣，再读取并结算；失败保留保守扣款，不能通过重试、回退或取消恢复权限。引用存储只认证实际改变来源的原文载荷，未选择来源保持原关联；事务失败回滚到预扣状态。

旧结算版本 1 继续要求完整的存活来源进度清单，省略来源仍被拒绝；版本 2 是独立且严格解析的内部事务消息，旧解析器会拒绝它。新消息不是新的恢复根或模型工具接口，不承诺旧安装包可处理新版事务，安装升级回滚仍需单独验收。16
KiB 消息上限及所有旧容量目标保持，不通过放宽消息上限或缩小画像获得通过。

回归覆盖新旧结算语义、非法/空/极端/访问器输入、64 个来源时空增量消息小于 512 字节、SQLite 加密重开、非选择来源损坏隔离、事务故障回滚，以及实际 session 的 LIST、重复读取、拒绝读取、空/大原文和 staged 来源结算。测试加入已有 owner、reader、storage-blobs 文件，沿用统一单元和客户端覆盖入口。第一冻结
`context-sparse-settlement-20261020-01/`
保留两项旧测试仍假定完整来源清单的失败；更新后分别验证版本 1 完整清单与版本 2 稀疏语义，没有取消旧格式检查。

最终冻结
`.hpm-acceptance/context-sparse-settlement-20261020-02/receipt.json`：相关
**348/348**，结算模块 S/L **98.06%**、B **96.29%**、F **100%**；字面
`npm run test:client:coverage` **1113/1113**，零失败/取消/跳过，S/L
**98.96%**、B **94.90%**、F
**99.03%**。格式、Lint、CI 治理、发布清单及网关重建退出 0，冻结源码哈希一致。容量命令仍退出 1，五个画像未整体达标；回执明确
`capacityQualified: false`、`wireFormatChanged: true`、`quotasChanged: false`。

本轮只消除扩大来源数量前的结算消息增长约束；来源 64、调用累计 128、全局快照 256 和长历史 2
MiB 限制仍在。偶发启动失败、完整 verify、最终包、跨端实机、升级回滚及生产验收继续未完成；本轮没有修改生产进程、配置、已安装客户端或发起真实模型请求。

## 前一阶段：分支索引结构共享（2026-10-20，全天容量仍未整体达标）

实际会话此前每次 begin 都复制祖先的 calls/captured/visible，提交时又复制来源关联和可见集合；恢复路径也重新构造每个完整祖先视图。新增独立的
`context-recovery-snapshot-index.js`：已提交节点不可再写，子节点只能继承可信的已封存同类父节点，每轮只保存本轮新条目。父分支和兄弟分支互不写入，未知/可变/伪造父节点及过深链被拒绝，遍历按原插入顺序迭代完成，不递归展开整条祖先链。

会话、原生压缩提交和根状态恢复均使用同一索引模块。根导出直接枚举本轮增量，来源可见性汇总也按增量取并集，不再对全部祖先视图逐项展开再过滤。磁盘格式及调用、来源、快照、历史、字节、TTL 和预算限制不变；旧记录仍走原来的身份、权限和关联校验。新模块已进入发布运行源清单，测试进入现有统一单元和客户端覆盖入口。

真实会话回归连续观察 60 次工具调用并排空最后结果：61 个已提交快照的完整逻辑视图共 5550 个索引条目，实际只保存 180 个增量条目；JSON 根状态重建后两项计数一致，完整可见来源仍为 60，最早原文精确读回。这里是已提交索引的条目数，不是 RSS/堆字节、SQLite 全天容量或真实宿主性能结论。内部 inspect 只新增两项数字计数，不暴露键、调用参数或原文。独立 480 层测试保存 480 个本地条目，完整逻辑视图共 115440 条，另覆盖封存后写入、伪造父节点、分支隔离和 4096 层迭代边界。

本轮冻结证据在
`.hpm-acceptance/context-shared-index-20261020-01/`，最终结果以回执为准。来源 64、累计调用 128、全局快照 256 和长历史 2
MiB 的限制仍在；本轮解决扩大额度前的内存复制问题，不能据此宣称全天画像通过。启动偶发失败、完整 verify、最终包、跨端实机、升级回滚及生产验收继续未完成。

最终冻结 `context-shared-index-20261020-01/receipt.json`：相关
**343/343**，新增模块 S/L/B/F 均 **100%**；字面 `npm run test:client:coverage`
**1108/1108**，零失败/取消/跳过，S/L **98.95%**、B **94.90%**、F
**99.03%**。格式、Lint、CI 治理、发布清单及网关重建退出 0，冻结源码哈希一致。容量命令仍退出 1，五个画像未整体达标；回执明确
`capacityQualified: false`、`wireFormatChanged: false`、`quotasChanged: false`。

## 前一阶段：启动失败诊断与原生助手准备幂等性（2026-10-20，稳定性仍未关闭）

对前一轮全量失败增加仅用于本地验收的 native 调用探针，保留原并发、原超时和原始客户端覆盖入口。探针只记录 ACL/密钥类别、固定结果分类和耗时，不记录路径、参数、输入、密钥、原生回复或异常文本。该诊断运行
**1099/1099**，S/L **98.95%**、B **94.88%**、F **99.02%**；证据在
`.hpm-acceptance/context-startup-native-probe-20261020-01/`。本轮没有复现原始失败，不能替代前一失败回执或证明原因已修复。采样中本机 ACL 调用最高 2895ms、密钥调用最高 2300ms，仅是该次测试的观测。

确认原生构建准备每次都会替换内容完全相同的运行时助手。现在成功构建后读取固定身份、限长且无符号链接祖先的产物；已安装文件字节一致时保留其文件身份和时间。字节不同则写入独占临时文件、fsync 并校验后原子替换，发布失败清理本次暂存文件并保留旧助手。已有运行时目标仍拒绝硬链接、目录和 junction；构建输入允许 Cargo 正常的缓存硬链接，但只作固定身份的数据读取，复制为独立运行时文件，不能把缓存链接直接发布成运行时助手。

新增回归覆盖真实文件身份复用、变更发布、非法/空/超大输入、运行时链接拒绝、Cargo 输入兼容、比较时身份替换和发布失败清理。测试加入现有密钥测试文件，进入统一单元发现及客户端覆盖入口。第一轮真实构建暴露了过严拒绝 Cargo 输入硬链接的问题，失败证据保留在
`context-native-artifact-20261020-01/`；修正后的最终冻结在
`context-native-artifact-20261020-02/`，最终门禁结果以其回执为准。这项改动减少无谓的可执行文件替换，尚不能证明它就是先前 worker/网关超时的根因。

最终冻结 `context-native-artifact-20261020-02/receipt.json`：相关回归
**184/184**、完整客户端覆盖 **1104/1104**，均零失败/取消/跳过；覆盖率 S/L
**98.95%**、B **94.88%**、F **99.02%**。原生 fmt、Clippy、测试
**7/7**、实际构建准备、格式、Lint、CI 治理和发布清单检查均退出 0。源码冻结哈希一致；实际构建准备前后，已安装助手的内容摘要、inode、创建时间及修改时间全部保持，`identicalNativeRetained: true`。回执仍明确记录
`originalStartupFailureResolved: false`，单轮门禁通过不关闭此前偶发失败。

本轮不更改运行中的代理进程、用户配置、已安装客户端或模型请求。全天容量、启动稳定性、完整 verify、最终安装包、跨端实机、升级回滚和生产验收仍未完成。

## 前一阶段：全天任务读取预算分层（2026-10-20，容量仍未整体达标）

新建恢复任务使用独立预算版本 2：任务累计上限 4096 次调用、16
MiB 编码结果；每个请求视图仍限制 64 次调用、512 KiB，单个结果仍限制 16
KiB。这是覆盖冻结容量画像的候选工程配置，不能作为全天容量或真实客户端资格声明。失败和非法调用也占用调用额度；读者异常或结果无法确认时保留本轮最大输出预扣额度，避免通过异常循环绕过单轮限制。

根任务的累计预算随检查点持久化；读取继续执行最大扣款先落盘、读取、结算确认的顺序。重开请求可以获得新的单轮额度，不能重置任务累计消耗。新请求与并发读者共用同一任务预算；持久化结算、检查点比较、引用写入及引用状态转移不能改变预算版本。独立网关预算接口仍只接受原来的版本 1，不能通过提供版本 2 获得更大额度。

旧任务恢复保留预算版本 1、已消耗额度及原到期时间，仍执行终身 64 次/512
KiB 上限。预算版本不做静默升级。旧软件不支持新任务的预算版本 2，因此回滚验收必须覆盖拒绝此类记录的行为；当前没有旧软件继续读取新任务的兼容承诺，不能据此宣称升级回滚已完成。

新增回归覆盖新旧预算解析、危险访问器、非法/极端输入、共享任务耗尽、单轮异常字节额度、保守预扣、异步失败、旧任务恢复，以及实际持久化读取跨 35 轮/70 次的累计消耗。测试进入已有统一单元发现和客户端覆盖入口。第一冻结
`.hpm-acceptance/context-task-budget-20261020-01/`
的客户端覆盖 1098/1098，但测试 getter 的 Lint 失败；失败证据保留。修正并增加独立网关版本拒绝测试后的最终冻结目录为
`.hpm-acceptance/context-task-budget-20261020-02/`，最终结果以该目录回执为准。

固定容量画像复测中，`frequent-recovery`
从只能验证 32 次恢复提升为 96/96，五个画像的首个读取失败均为空；它们仍全部未整体达标。此处重开仍指合成时钟下的 JSON 根状态重建，不是 SQLite 长时容量、传输或真实模型验收。单独的加密存储和 worker 重开回归通过，也不构成五个容量画像的持久化验收。

这一阶段只处理读取预算。来源 64、调用累计 128、全局快照 256 和长历史 2
MiB 的限制仍在，完整容量画像继续按原目标执行；不会缩小画像来取得通过。生产、最终安装包、多端实机、完整 verify 和整体目标均未完成。

最终冻结回执 `context-task-budget-20261020-02/receipt.json`：专项
**170/170**，格式、Lint、CI 治理、发布清单和网关重建退出 0，源码冻结哈希一致。完整客户端覆盖
**1096 通过、2 失败、1 取消**，因此门禁未通过；覆盖率 S/L **98.95%**、B
**94.88%**、F
**99.02%**。全量运行中加密 worker 生命周期重开和根状态重开发生固定存储错误，网关源运行时测试超过原 15 秒限制。没有更改超时、并发或覆盖阈值。

同一源码下针对生命周期、目录边界和网关运行时的诊断 **67/67**
通过（`startup-diagnostic.log`），只能证明较小范围可通过；不能覆盖全量失败，也未单独重复根状态失败项。启动稳定性原因仍待定位，不能以重跑成功关闭风险。完整 verify、安装包和生产验收继续未执行。

## 前一阶段：候选新安装默认与运行选项观察（2026-10-20，I1/I2 部分完成，未发布）

候选源码的 `DEFAULT_CONFIG` 与 `proxy.config.example.json`
均明确设置策略版本 2，恢复、持久化偏好和原文捕获默认 false。Node 缺文件启动与从示例创建配置都选择原生优先；现有文件缺版本仍解释为 1，读取及普通前端规范化不补 2。缺文件和兼容回退返回独立默认副本，调用方修改不能污染后续默认。专项验证旧文件字节保持、偏好保留、新模板有效性及新默认传入真实策略合成；桌面/PowerShell 的安装包首启仍需单独验收。

策略合成在共享选项中记录私有、不可序列化的观察标记；运行配置控制器将诊断关联到实际共享选项引用，启动和热加载均可观察。诊断新增
`runtimeApplication`（unverified/unavailable/matched/mismatch）、`appliedVersion`
和
`appliedPolicy`，区分未关联、选项不可识别、一致及不一致。比较的是进程配置与共享规划选项，不是磁盘保存 ACK，也不证明每个 handler、在途请求或客户端已取得完整资格。标记不授予恢复权限，JSON/字符串/供应方选项不能伪造它；矛盾能力、访问器和异常描述符均不被当作成功。

界面保留旧版状态兼容，区分策略选择、代理已载入及整体未验收。隔离代理进程证明旧文件启动载入 legacy，显式迁移后通过健康接口观察到版本 2/native-first，并验证认证转发继续成立；上游仍为本地夹具，未调用真实模型或修改生产。

最终冻结
`.hpm-acceptance/context-native-defaults-20261020-01/receipt.json`：相关
**320/320**（69 文件），五模块 S/L **97.70%**、B **95.54%**、F **98.07%**；字面
`npm run test:client:coverage` **1092/1092**，零失败/取消/跳过，S/L
**98.95%**、B **94.87%**、F **99.02%**。完整前端入口 **28/28**、前端覆盖入口
**8/8**（S/L **98.20%**、B **91.61%**、F
**96.77%**）、构建、格式（包含通常被忽略的新模板）、Lint、CI 治理、发布清单、网关重建均退出 0。lib/test/scripts、前端、入口、包、模板及 Rust 冻结哈希一致。新默认测试进入统一单元发现和客户端覆盖命令，未改任何超时、并发或覆盖阈值。

本次单轮通过不能关闭此前启动稳定性风险。未执行完整 verify、最终运行时/安装包重建、安装版 Codex/Claude、完整传输/多主机组合或生产验收；旧 staging 不代表当前候选。容量目标、私有流式和 steering、普通配置自动绑定的完整多端资格、升级回滚及最终发布仍未完成。`plannerApplication: unverified`
和完整目标保持未完成，新源码默认不等于现网已切换。

## 前一阶段：显式策略迁移与管理界面（2026-10-20，I1 部分完成，新默认当时未激活）

新增管理接口
`GET /v1/local/context-policy/preview`、`POST /v1/local/context-policy/apply`（同时支持
`/local/`
前缀）。预览只返回固定策略投影、配置修订号和静态影响提示，不返回配置内容或历史清单。应用要求显式确认、目标版本 2 与精确修订号，复用完整保存的串行队列；保留两个恢复开关、存储偏好及无关配置，不读取、续期或迁移原文。缺失配置、未知版本、非法偏好或配置冲突均拒绝，不自动生成配置或覆盖旧选择。

管理界面增加“核对并应用新上下文策略”：原生模式说明超限报错及依赖恢复原文的旧聊天不能直接继续；增强模式保留已保存偏好。页面草稿不参与本次操作，也不因成功响应被丢弃。确认期间页面配置变化、超时、丢失响应或异常回执均不自动重复提交。接口只报告已保存和
`runtimeApplication: pending`，异步重载不被当成生效或客户端验收证明。桌面桥只放行对应方法及精确路径，浏览器/桌面桥模拟均覆盖。

额外回归覆盖外部程序在提交后改写配置：原子写入返回本次文件的修订号，响应前发现实际文件不一致就返回固定未确认错误，不把外部版本号授权给旧页面。实际隔离代理验证管理凭据、入口凭据隔离、来源限制、迁移保存及原有认证转发；上游为本地夹具，没有真实模型或生产请求。

最终冻结
`.hpm-acceptance/context-policy-migration-20261020-02/receipt.json`：后端
**32/32**（11 文件），两个新增后端模块 S/L/F **100%**、B
**96.61%**；格式、Lint、CI 治理、发布清单、网关重建全部退出 0，冻结哈希一致。统一单元发现包含新测试。前一冻结
`context-policy-migration-20261020-01` 的前端 **28/28**、前端覆盖入口
**8/8**（S/L **98.16%**、B **91.46%**、F
**96.73%**）、前端构建和编译后的 Rust 桥接 **2/2**
均通过；最终冻结校验对应前端、测试、Rust、脚本及包文件哈希相同，复用这些证据。构建仍有原有大 chunk 提示。

第一冻结做过发布运行时准备，随后后端并发修复使那份 staging 过期；不能称为最终源码的新包验收。本次未运行完整 verify、完整客户端覆盖、渲染后的 UI 操作或安装包验证。新默认、统一有效状态、更广 I2 请求路径、容量与启动稳定性、私有流式、多端普通配置、升级回滚和生产验收仍未完成。整体
`plannerApplication: unverified` 保留，I1/I2 和完整目标继续进行。

## 前一阶段：WorkBuddy 原生优先请求路径接入（2026-10-20，I2 部分完成，新默认未激活）

版本 2 且恢复未开启时，WorkBuddy 普通请求只测量完整窗口并发送一次：跳过预折叠、主动/后台规划、历史分支、工具发现、原文归档、私有读取和载荷拒绝后的压缩重试。字节或操作额度不足返回固定错误，保留原窗口，不把操作预算描述为已确认的模型上限。`force`
不能越过原生策略；异步准备使用请求开始时的能力快照，后续配置切换不能把该请求升级成增强规划。缺字段/1 保留旧路径；版本 2 显式开启仍走自己的增强规划入口，尚不代表增强整体资格。

新增纯测量/响应检查模块
`workbuddy-native-context.js`，验证数据描述符、JSON 安全性、大小/深度/节点及完整工具历史；无历史副本留存、存储事务或摘要调用。响应仍检查已提供工具、参数形态和退役/重复调用 ID，拒绝私有工具调用，不把关闭恢复当成取消工具安全校验。

客户端显式压缩保留独立兼容路径，原生模式生成摘要/可信容器时不捕获恢复原文；JSON/SSE 续接和退役调用 ID 均有回归。原有容器如依赖证据回执，切到原生模式后明确返回
`409/context_recovery_disabled`，不读取或续租旧证据、不静默丢状态、不自动重开增强。需在迁移 UI 中说明这一连续性限制，不能把这种组合称为无感切换。

实际代理入口发现并补齐 `createProxyHandlers`
的共享策略传递；原始 Chat 的核心处理和 Claude→Chat 的 HTTP 桥也传入策略。大历史负控在实际隔离代理进程中覆盖 Chat/Responses/Messages：旧语义可规划，版本 2 原生在宿主调用前拒绝；API
Key/本机桥接及旧/新策略四组基础入口、显式压缩和错误响应均通过。本机桥接与供应方由本地夹具代替，没有真实模型请求或已安装宿主验收。

首轮冻结 **296/297**，新增实际入口负控暴露漏传策略，失败保留于
`.hpm-acceptance/context-native-workbuddy-20261020-01/receipt.json`。修复后最终冻结
**297/297**（59 文件），四模块 S/L **97.14%**、B **94.59%**、F
**97.61%**；格式、Lint、CI 治理、发布清单和网关重建均退出 0，lib/test、入口、包及发布清单哈希一致。证据：`.hpm-acceptance/context-native-workbuddy-20261020-02/receipt.json`。新测试由既有统一单元发现入口收录，未提高任何期限或降低覆盖/并发要求。

未执行此源码的完整客户端覆盖命令、完整 verify、安装包、真实客户端或生产验收。新默认、迁移 apply/旧容器提示、统一有效状态、容量及启动稳定性、私有流式、多端普通配置、升级回滚和最终发布仍待完成。整体诊断继续保留
`plannerApplication: unverified`，I1/I2 与完整目标均不标完成。

## 前一阶段：通用请求预算接入策略（2026-10-20，I2 部分完成，新默认未激活）

启动与热加载共用
`composeContextProtocolOptions`，从策略版本生成不可通过 JSON 伪造、可随协议选项 spread 传递的内部能力。缺字段/1 保持旧规划，2 的恢复关闭/开启组合均禁止通用预算器直接折叠或删除历史；保留完整窗口并测量超限，由现有固定
`context_length_exceeded`
错误入口拒绝。增强恢复需要独立合格的归档规划入口，不能借通用裁剪绕过归档。配置不被修改，旧版 nullable 偏好不因本次接入额外拒绝；热加载清除旧能力，非法版本不会改写共享选项，复制数据属性不触发
`__proto__` setter。

已验证客户端 truncation
auto/disabled 均不能覆盖版本 2 的通用保留策略；供应方明确原生管理的 disabled/none 旁路继续有效，未知模型窗口仍不编造额度。回归覆盖固定输入超限、完整工具链、空/非法输入、访问器、伪造字段、序列化、模式切换和实际 Claude→Responses 转换。

冻结范围 **79/79**，三个模块 S/L **98.60%**、B **94.83%**、F
**97.05%**；格式、Lint、CI 治理、发布清单和网关重建均退出 0，运行前后 lib/test、入口与配置清单哈希一致。证据：`.hpm-acceptance/context-native-budget-20261020-01/receipt.json`。测试仍通过既有统一单元发现入口执行，没有降低期限、并发或覆盖阈值。

本次没有执行整个客户端覆盖命令、完整 verify、安装包或真实宿主/生产验收。WorkBuddy 的主动/后台规划、历史分支、工具发现和超限重试仍需独立接入及资格验证；新默认、迁移 apply、多端普通配置、容量、启动稳定性、私有流式和最终发布仍未完成。管理诊断保留整体
`plannerApplication: unverified`，因为通用入口通过不能代表所有规划入口已生效。

## 前一阶段：策略版本识别及保存保护（2026-10-20，I1 部分完成，新默认未激活）

新增独立纯模块 `context-recovery-policy.js`，冻结配置元数据名为
`appSettings.contextPolicyVersion`。缺字段或数值 1 表示 legacy、需要迁移；数值 2 表示已选择新策略，其主项 false/true 分别投影 native-first/enhanced，保存偏好独立保留。只接受数值 1/2，字符串、null、未来版本及可执行属性均固定拒绝，不调用 getter 或把非法值默认成新策略。决策不可变，不修改配置、不访问模型/磁盘，也不授予历史读权。

配置校验已接版本解析。管理面完整文档保存增加版本边界：当前已为 2 时，遗漏标记或写回 1 返回固定 409
`context_policy_version_conflict`，不写文件、不刷新代理；当前未知版本也不被旧写入覆盖。旧版 1/缺字段的普通保存仍保留旧语义，显式 2 可保存为意图元数据。该保护只针对当前包的完整配置保存，不等价于已安装旧包懂得新字段，也不是已交付升级/回滚迁移工具。

健康诊断新增 `policy`，分开返回 version、migrationRequired、requestedPolicy 和
`plannerApplication:unverified`。界面以纯文本区分“旧版尚未迁移”“已选择原生优先/增强，普通请求规划尚未核验”，兼容没有该字段的旧代理；非法/未知诊断使用固定未核验文案，不渲染输入内容。前端 normalize 与表单保存保留已有及未知版本，不在普通读取/保存中偷偷补 2。

负控先确认原 validator 接受非法版本、原 diagnostics 缺少策略投影；修复后冻结
`context-policy-version-20261020-01/receipt.json`：相关回归
**21/21**，策略/诊断/展示三个模块语句/行 **100%**、分支 **98.50%**、函数
**100%**。格式、零警告 Lint、CI/发布治理、网关重建、完整前端
**27/27**、前端覆盖入口 **7/7** 及前端构建退出 0；前端覆盖语句/行
**98.08%**、分支 **90.51%**、函数
**96.47%**。新模块进入发行源清单，回归进入统一 unit/原完整客户端入口，前端回归继续由统一入口发现。运行源、前端源及测试摘要前后一致。构建仍有现存 chunk 大于 500
kB 警告，未提高警告阈值。

本阶段未重复完整客户端；最近实际完整通过仍属于前一阶段
`context-storage-boundary-20261020-02` 的
**1081/1081**，不能冒充本次源码完整资格。`DEFAULT_CONFIG`、普通请求规划及用户安装配置均未改变，I1 的新默认/显式应用迁移操作及 I2 仍待完成；版本 2 目前只表达选择，不能据此声称已停止普通轮次裁剪或 WorkBuddy 主动摘要。容量、多端绑定、私有流式、安装升级回滚和真实宿主/生产验收继续待完成。

## 当前阶段：存储重复校验与解密消除（2026-10-20，当前完整客户端通过，整体未完成）

消除两处确定的重复工作。原生 ACL 的目标类型检查和精确身份记录现在共用同一次 BigInt
lstat；同步和异步调用保留调用前后两道校验、完整祖先验证、硬链接拒绝及每次重新检查，不跨调用缓存权限。负控每次目标观察 4 次，修复后 2 次。存储清理原先对同一普通/到期/撤销记录先解密再在 decode 中重复解密，现把当前事务已认证值传入同一个语义校验函数；新负控三条记录为 6 次认证解密，修复后 3 次，损坏仍阻止整批删除，原事务及回滚规则保留。

真实 DPAPI/ACL 空存储诊断位于 `context-storage-profile-20261020-01/profile.json`
及 `-02/profile.json`。重开 lstat 次数 **357→349**，首次创建
**373→365**，空 catalog 仍为 38 次；耗时样本波动，不能从这两组样本推导稳定提速或完整超时根因。未删安全边界、调整期限或降低并发。

最终冻结 `context-storage-boundary-20261020-02/receipt.json`：五文件扩大
**140/140**、零失败/取消/跳过；两个变更模块语句/行 **99.24%**、分支
**93.52%**、函数
**100%**。格式、零警告 Lint、语法、CI/发布治理及覆盖退出 0，运行源和测试摘要前后一致。新增回归由统一 unit 自动发现，SQLite 回归也在原完整客户端文件中；原生 ACL 回归由 unit 覆盖。

同一冻结源码随后执行原
`npm run test:client:coverage`（含原构建前置步骤），`context-storage-boundary-20261020-02/client-receipt.json`：**1081/1081**、零失败/取消/跳过，命令退出 0，语句/行
**98.94%**、分支 **94.82%**、函数
**99.01%**，源和测试摘要一致。先前失败的实际加密 worker 连续重开测试本次也通过。这证明当前源码的一次完整客户端资格，不证明启动波动永久消失、完整全仓 verify、发行安装版或生产已验收；回执
`startupTimeoutFixed:false` 有意保留该边界。

下文 1079/1080 与更早失败属于对应历史冻结，均保留。本节取代历史段落对最新客户端结果的描述。原生优先 I1/I2、全天容量、多端普通绑定、私有流式/steering、MSI/portable 安装升级回滚和真实宿主/生产验收继续待完成；未重启生产、修改已安装配置或调用真实模型。

## 当前阶段：关闭及模式切换保留原文（2026-10-20，专项通过，完整门禁仍失败）

用户设置关闭和内存/持久化模式切换现在调用独立的 suspension 路径：同步停止准入、使旧 capability 和事务失效，排空在途存储，再保留已提交原文及原到期、累计预算。重新开启必须由当前请求重新授权并从存储加载，不恢复旧权限；模式切换不自动搬运内存历史。保留主体拒绝索引，暂停期间及暂停后的显式主体撤销仍能删除对应数据。显式清除继续调用破坏性 configure(false)，即使先前已暂停也会升级为真正清除；底层原 configure/revoke/close
API 的删除语义保留。

补充到期条目释放准入配额、撤销优先于暂停、关闭期间不返回成功、未完成发布租约失效，以及缺少暂停能力时拒绝而非退回删除路径。新增真实 SQLite 和 Windows 加密 worker 回归覆盖 Unicode 原文、重新授权、旧权限拒绝、原到期和预算保留。定向生命周期
**7/7**、runtime/clear/controller **37/37** 通过。

首次冻结 `context-recovery-retaining-disable-20261020-01` 为
**599/601**、零断言失败但两项原启动期限取消，范围门禁失败；覆盖和其余源门禁通过，未启动完整客户端。之后修正到期准入、撤销竞争和模式切换保留边界，第二次冻结
`context-recovery-retaining-disable-20261020-02/receipt.json` 的扩大测试
**602/602**、零失败/取消/跳过，31 模块语句/行 **98.63%**、分支 **94.82%**、函数
**99.05%**。格式、Lint、网关构建、语法、CI/发布治理退出 0，运行源及测试摘要前后一致，专项门禁通过。

随后实际执行原
`npm run test:client:coverage`：**1079/1080**，0 断言失败、1 取消、0 跳过；语句/行
**98.94%**、分支 **94.82%**、函数
**99.01%**，覆盖门禁通过，但完整命令退出 1，整体资格失败。唯一取消是实际加密 worker 清除孤立 staging 后连续三次重开的原
**30 秒**
测试；第三次 worker 在约 23.4 秒启动、28.9 秒完成密钥解封，随后未在总期限内完成。主测试线程事件循环最大延迟约 197 毫秒。记录只定位到累计启动/文件及数据库验证成本，尚不能证明具体根因；未提高期限、降低并发或重跑追绿。冻结运行器进程自身退出 0 只代表回执已写入，不能替代回执中
`overallGatePassed:false` 和
`results.client.code:1`。首次失败保留，并发启动波动仍待修复。

本节取代下面历史阶段中“设置关闭仍 revokeAll”的当前状态描述。I1 配置版本/迁移、I2 普通轮次原生优先、全天容量、启动波动、多端普通绑定、私有流式、MSI/portable 安装升级回滚及真实宿主/生产验收仍未完成。未重启生产、修改安装配置/认证或调用真实模型。

## 当前阶段：关闭恢复时的保存偏好冷启动（2026-10-20，专项通过，整体未完成）

修复 `contextRecoveryEnabled=false, contextRecoveryPersistenceEnabled=true`
仍创建默认 session/存储所有者的问题。保存偏好现在只被记住，默认 runtime 的 ready、关闭和普通配置应用不因此加载生命周期、准备目录或打开 worker；已有内存所有者也不会为关闭状态提升到持久模式。显式开启会按最新保存偏好完成模式切换，在持久模式就绪前不短暂授予内存恢复权限。目录准备期间关闭时只建立关闭的内存所有者，不再打开过时持久实例；显式移除持久偏好仍可排空已有持久所有者。

修复前的负控已失败：默认模块加载守卫捕获非预期所有者创建，100 次关闭状态偏好切换产生 50 次目录准备。修复后新增偏好/显式开启和无所有者显式清除回归，并加强实际 core
composition、配置控制器及异步目录准备测试。默认所有者保持冷状态，显式清除仍使用独立有界路径；非法配置、初始化失败、撤销、关闭、清除和晚到启用等原门禁保留。

冻结
`.hpm-acceptance/context-recovery-disabled-preference-20261020-01/receipt.json`：扩大
**594/594**，0 失败/取消/跳过；31 模块语句/行 **98.68%**、分支 **94.93%**、函数
**99.04%**。格式、零警告 Lint、工作区网关重建、语法、CI/发布治理全部退出 0，运行源及测试摘要前后一致。运行测试进入统一 unit，恢复 runtime 回归继续由原完整客户端入口包含；未重复完整客户端、修改任何门禁期限/并发/阈值或激活生产。

边界：本轮未完成原生优先的配置版本/迁移和普通轮次规划策略。已有持久所有者的关闭仍沿用旧 session
`configure(false) -> revokeAll`
路径，因此方案要求的“关闭不删除尚未到期数据”尚未实现；后续需区分停止准入、在途排空与显式删除，并验证重新开启不能恢复旧 capability。全天容量、启动波动、多端绑定、私有流式、安装升级回滚及真实宿主/生产验收仍待完成。

## 当前阶段：中断发布后的冷恢复持久续写（2026-10-20，专项通过，整体未完成）

修复引用冷接纳的确定性故障：投影正确剔除未完成发布的分支，却同时遗失其仍有效的来源描述，导致后续 LIST/发布的持久事务被严格来源转换校验拒绝。修复前新增真实 SQLite 回归在首次 LIST 返回失败，修复后通过；没有放宽
`validateReferenceTransition` 或存储关联检查。

引用投影现在返回独立的 `metadata,stagedSources`
信封。被剔除分支的描述和原 staged 描述一起作为冷账本条目恢复，继续占用原配额并保留身份、计数、读取进度和绝对期限。`linkRoot`
仍只用已发布来源建立描述及快照可见性；隔离来源不能列出、读取或满足已发布快照的来源关联。旧裸元数据导入兼容，完整载荷 importer 继续拒绝该信封；旧完整投影路径未切换。

新增三项回归进入统一 unit 和完整客户端入口：四种 prepared/sending/uncertain/withdrawn 状态下继续持久读者/发布、再次关闭与冷接纳后继续写入；真实 Windows 加密 worker 关闭重开后保持隔离和写入；信封的原 staged 来源保留、零载荷驻留、逻辑账本保留、重复/超额/载荷混入/期限/可见性篡改及 getter 拒绝。测试确认被拒来源不触发
`read-source`，保存仍保留原文、原到期时间和计数。

冻结证据
`.hpm-acceptance/context-recovery-interrupted-write-20261020-01/receipt.json`：扩大
**544/544**，0 失败/取消/跳过；28 模块语句/行 **98.86%**、分支 **95.20%**、函数
**99.21%**。格式、零警告 Lint、工作区网关重建、语法、CI/发布治理全部退出 0，运行源和测试摘要前后一致。未重跑完整客户端，未改变期限、并发、阈值或 CI 入口；最新完整客户端仍为下述
**1051/1058**，不能用本轮专项替代整体资格。

下一步仍需处理并发启动波动、全天容量、新默认策略、私有流式/steering、多端普通绑定、MSI/portable 安装升级回滚及真实宿主/生产验收。未重启生产代理、修改安装配置/认证或调用真实模型，整体目标保持未完成。

## 当前阶段：发行运行目录与独立网关资格（2026-10-20，专项和隔离发行资格通过，整体未完成）

新增独立
`scripts/start-packaged-evidence-mcp-gateway.js`，不使用发行目录中不存在的源码/开发锁文件清单。发行清单解析及
`lib/release/evidence-gateway.js`
暂存模块复制六份固定启动/校验文件和同一个经过工作区验证的不可变 bundle。清单绑定六份文件、发行 package/lock、校验所需三份 proxy 模块、Node 主版本及包摘要；固定集合、顺序、字段、大小和摘要全部校验，错误固定拒绝，不回退工作区清单或源码。该机制是构建一致性检查，不是签名认证。

`prepare-release-runtime.js`
在清理生成目录前先准备/校验包，生产依赖裁剪后暂存网关；运行 manifest 记录网关与新增运行源摘要，发布治理要求有效发行网关。隔离快照纳入实际 bundle、全部声明输入及发行启动文件；副本校验并复用产物，不需要重新安装 Vite。隔离验证核对 bundle、原 source
snapshot、Node/原生助手、生产依赖与原锁；probe 在显式参数验证后自动准备工作区包。

新增 **5**
项回归进入统一 unit 和完整客户端入口，覆盖发行锁区分、工作区清单替代拒绝、文件/包/Node/清单变更、空/超大/危险清单、参数脱敏、非法根/输出 junction 拒绝及目标哨兵保留。真实独立 stdio 测试在无
`node_modules`、`lib/client`
和 runtime 源模块的临时目录运行，加载守卫禁止导入目录外文件或 npm 模块，验证工具发现、仅一次执行、Unicode 原文、EOF 自行退出与下游回收。原隔离发布测试新增网关身份篡改检查，保留原依赖身份断言；自洽锁篡改 fixture 同时更新合成发行清单，继续验证与原锁不一致时拒绝，未放宽生产校验。

最终冻结
`.hpm-acceptance/context-recovery-gateway-release-20261020-01/receipt.json`：扩大
**50/50**，0 失败/取消/跳过；网关与发行模块语句/行 **98.52%**、分支
**94.56%**、函数
**100%**。格式、零警告 Lint（含 fixture）、网关构建、语法、CI/发布治理全部退出 0，运行源和测试摘要前后一致。开发首轮 16/17，旧锁篡改 fixture 被新增网关锁校验提前拒绝；修复 fixture 自洽元数据后，冻结中保留并通过原依赖身份断言。

同一冻结完成真实隔离发行暂存，根为
`C:\Users\juhon\AppData\Local\Temp\hpm-isolated-release-PioRN5`，未覆盖工作区既有
`dist/staging/runtime`。**595** 份运行源、**624**
份构建输入、Node/原生助手/manifest 摘要与快照一致，**116**
个实际生产依赖版本和 integrity 匹配原锁，发行目录治理通过。随后从无关 cwd 使用发行自带
`runtime/node/node.exe` 运行新入口，禁止工作区与外部 npm 导入：连接 **2050
ms**，完整验证 **2249
ms**，原文、仅一次执行、EOF 和回收均通过。合成下游仅使用 Node 内置模块，不借用工作区 SDK；发行临时目录和回执保留。

边界：这是实际发行运行目录构建与独立网关资格，没有生成或安装新 MSI/portable 包，也没有真实 Codex/Claude 接纳、升级/回滚或生产结论。未重启当前代理、修改客户端配置/认证或调用真实模型。最近完整客户端仍是
`context-recovery-gateway-build-20261020-01/receipt.json` 的
**1051/1058**（4 失败、3 取消，启动/重开/子进程期限）；本阶段未为追逐绿色重复完整命令。并发启动成本、投影后持久续写、全天容量、新默认策略、私有流式/steering、多端绑定和安装迁移/生产验收仍待完成。

补充严格独立性验证：对同一发行目录进一步禁止加载**发行目录内部的
`node_modules`**，也禁止工作区和外部模块；发行自带 Node 仍完成相同原文、仅一次执行、EOF 和回收断言。该次连接
**1599 ms**、完整 **1725 ms**，独立回执
`context-recovery-gateway-release-20261020-01/standalone-no-npm/receipt.json`。这是单次合成验证，不是生产延迟保证；初次发行资格的守卫只限定在发行目录内，不能把初次回执单独解释为已经阻止内部 npm 导入。

## 当前阶段：工作区网关正式打包入口（2026-10-20，专项通过，整体门禁仍未通过）

新增 `scripts/prepare-evidence-gateway.js` 和
`scripts/lib/evidence-gateway-artifact.js`，以现有直接开发依赖 Vite 构建单个 CommonJS
runtime。默认 `scripts/start-evidence-mcp-gateway.js`
已加载经过校验的产物；导入 composition
root 仍不加载 SDK，参数非法时在加载包前拒绝。构建记录 **36**
项本地源码/构建脚本/包与锁文件摘要，加载前核对 Node 主版本、本地输入、固定格式清单、路径/大小及实际包摘要。源码/锁/Node/包不一致、缺失文件、目录替代或符号链接均固定拒绝，无源码回退。这里是本地构建一致性检查，不是签名认证或抵御可同时修改源码与清单的本机攻击者的权限边界。

构建在读取本地模块的同一次 load 中捕获内容，并在发布前复核输入；按内容摘要命名不可变包，最后原子替换 manifest，保留此前生成的包。`build:evidence-gateway`
提供显式构建；unit、unit:serial、proxy/client coverage 及 `evidence:gateway`
的 npm 生命周期自动准备，输入未变时校验并复用。真实 MCP
host 应直接配置 Node 和绝对脚本路径，避免 npm 生命周期文字进入协议 stdout；工作区使用说明已更新。当前包约
**6.19 MB**，含单份原始 inline source map；未提高 **8 MiB** 上限，没有新增依赖。

新增 **7**
项回归进入既有统一 unit/客户端文件，覆盖产物有效与调用方修改隔离、源/锁/Node/包损坏、空/非法/超大清单、缺失/重复/越界来源、危险原型、路径穿越/大小/目录/符号链接、实际单份映射及 runtime 对应源码、构建 CLI 参数与错误脱敏。另对导出 runtime
API 单独以真实 stdio 子进程验证工具发现、仅一次执行、EOF 下游回收及启动失败；已有真实打包 CLI、双宿主隔离和错误测试继续使用正式入口，没有改成源码 fixture。

冻结回执
`.hpm-acceptance/context-recovery-gateway-build-20261020-06/receipt.json`：专项
**34/34**，0 失败/取消/跳过；网关模块语句/行 **97.57%**、分支 **96.02%**、函数
**100%**；格式、零警告 Lint（含新 fixture）、构建、产物语法、CI/发布治理全部退出 0，运行源及测试摘要前后一致。产物摘要
`ba5590f2c7d7e4e2ad5f430597fcf96dc29cc5fc058a5bd67fef8b8f9ffc6b1f`，回执记录实际大小与范围。发布治理通过只证明源码治理检查通过，不代表构建了新发行包。

本阶段最近一次原完整客户端命令在
`...-01/receipt.json`：**1051/1058**，4 失败、3 取消，总门禁未通过。包括双宿主连接超过原 30 秒、加密 worker 接纳/重开超时、两项代理 fixture 初始化期限、容量 CLI 子进程和独立 ACL 核验期限；双宿主第一连接约
**12470 ms**，第二连接达到 **30001 ms**
时已超过整项期限，不能声称打包已消除并发启动波动。完整覆盖阈值通过，功能失败记录仍有效。之后没有只为追逐绿色结果重跑完整命令；当前增加的 API/构建回归仅完成专项资格。

开发失败全部保留：01 行覆盖不足；02 手工附加映射与原 inline map 重复，超过原 8
MiB 而构建拒绝；03 去除 vendor 内容后仍未计入 runtime；04 单份映射与 remap 后过滤仍未解决路径表示问题；05 新测试 prefer-const 警告导致零警告 Lint 拒绝。先前“缺少 source
map”的判断不准确。诊断实际证明 Node coverage cache 中的原源码为 `file://`
URL，而当前 c8 的源码筛选使用本机路径；不能把原文 URL 与本机路径不匹配计为源码函数没有执行。最终恢复 Vite 原始单份完整映射和原 c8 参数/阈值，补上导出源码 API 的独立行为验证，同时保留正式包协议测试，不修改 c8 或依赖内部实现。04 的诊断脚本/原始报告与其失败回执均保留。

下一步仍须定位并发下游/worker/代理模块启动成本，并将包及启动器纳入发行目录、独立安装、升级与回滚资格；当前 manifest 要求本地输入存在，不能直接把它拷到裁剪后的发行目录当作已安装支持。中断发布投影后的持久续写、全天容量、新默认策略、私有流式/steering、多端普通配置和生产验收继续未完成。未构建新发行包、部署、重启、修改用户客户端配置/认证或调用真实模型，整体目标保持未完成。

## 当前阶段：网关打包启动原型测量（2026-10-20，隔离验证通过，未接入正式入口）

为定位原完整客户端双宿主 30 秒超时，在
`.hpm-acceptance/gateway-bundle-profile-20261020-01/`
使用已声明的直接开发依赖 Vite，将现有网关 runtime 及 SDK 图打为约 **1.88 MB**
的 CommonJS 文件。未直接调用未声明的 Rollup/esbuild 包，未新增依赖，未改变运行源、客户端命令、测试期限、并发或覆盖阈值。构建有两条上游 Zod 注释标注警告，保留原输出；产物实际可加载和运行，不能将警告解释为正式构建已合格。

交替启动独立 Node 子进程的三轮模块加载样本：源码 **2601 / 12862 / 6731
ms**，打包 **400 / 540 / 573 ms**，导出名称一致。`result.json`
保留逐轮数据，说明本环境的模块图加载确有可消除成本，但样本不能推导并发完整门禁的稳定上界。

`qualification.json` 记录同一真实 stdio 下游合成 fixture 的两宿主对比：源码整段
**9143 ms**，打包 **3777
ms**；连接、工具发现、载荷卸载引用、精确读取、执行记录、跨宿主拒绝、指定环境变量转发及关闭后进程不存在断言均通过。下游仍使用原源码 fixture，没有为提速更换下游或删减断言。宿主名称是协议兼容测试身份，不代表真实 Codex
/ Claude 客户端验收。

`eof-receipt.json` 单独证明：打包入口连接 **1893 ms**、整个 EOF 流程 **1989
ms**；直接结束 stdin 后 3 秒内以 code 0 退出，下游已回收，未先调用 SDK
close 强杀掩盖退出故障。另以模块加载守卫拒绝所有非内置依赖，独立 runtime 仍可加载。产物 SHA256 保存在回执中。这里未证明完整 CLI 可脱离工作区安装，原型 wrapper 仍引用现有配置解析和 shutdown 模块。

下一步须把构建、入口选择、产物源码一致性、发布清单及独立安装资格接入正式生命周期，并在相同原期限下重跑原完整客户端门禁；不能仅在测试中改用打包入口或复用过期产物。当前只是隔离原型及性能证据，**原完整门禁失败仍有效**。中断发布投影后的持久续写、全天容量、默认策略、流式/steering、多端普通配置、迁移回滚及生产资格仍未完成。没有生产重启、配置/插件/认证变更或真实模型请求。

## 当前阶段：持久 ACK 后自动卸载来源载荷（2026-10-20，范围通过，完整客户端门禁未通过）

新增
`context-recovery-durable-ack.js`。引用事务仅在保存 CAS 的 revision 回执通过校验、生命周期屏障仍有效后，生成进程内不透明回执；回执不可经 JSON/克隆传递，只保留根身份、账本策略摘要及已保存来源的不可变身份，不保留原文或整份历史。owner 在有效租约和当前 session
capability 下，重新验证独立元数据、根身份/原期限/策略以及整批来源的 ID/摘要/字节/时间/调用关联，再调用已有“整批载荷认证完成后才丢弃”的卸载原语。旧回执只能释放其已确认且身份未变化的来源，不会释放后来新增的来源；不重置预算、进度、计数或原绝对期限。

默认引用读者在读取前的持久预扣保存成功并复查 owner 后卸载，随后继续原授权异步页读取和持久结算。引用发布在 durable
prepare 保存与 owner 复查后卸载，发送/终态仍走原 journal 与持久屏障。缺少引用状态/页读取/增量结算能力的旧适配器不自动卸载；引用失败不回退完整导出。回执未返回、非法回执、写前/写后失败均不触发卸载；晚到回执不能复活已释放租约、已中止、撤销、关闭或到期的 capability。卸载本身失败会停止该根后续存储 I/O，保留已经认证的磁盘记录，不能通过重试制造成功。

增加独立受信
`exportContextRecoveryRootMetadata`，沿用完整导出的根/时钟/租约屏障，返回明确的元数据封套；旧同步完整导出继续拒绝冷来源，不伪造空字符串。需要旧 importer 完整输入的测试夹具改为显式读取存储完整记录，字段/字节/权限断言保留。新增
**9**
项回归进入既有统一 unit 和原完整客户端文件，覆盖不透明/伪造/危险访问器/非法 revision、身份变化、真 SQLite
ACK、幂等卸载、旧 ACK 与新增来源、延迟 ACK、保存失败、租约/撤销/到期、卸载失败停止 I/O、准备发布及精确读回。fixture 修复后原重新授权/投影
**12/12** 通过。

冻结证据
`.hpm-acceptance/context-recovery-ack-eviction-20261020-02/receipt.json`：扩大
**534/534**，0 失败/取消/跳过；28 模块语句/行 **98.86%**、分支 **95.16%**、函数
**99.21%**，格式、零警告 Lint、语法、CI/发布治理退出 0，运行源和测试摘要一致。完整客户端
**1054/1055**，0 失败、1 取消：双实际 stdio 宿主用例超过原
**30 秒**。该次第一宿主连接约 **11161ms**，第二宿主连接约
**28752ms**，两宿主工具调用均已完成；第一宿主关闭完成约
**29800ms**，第二宿主关闭及最终断言未在期限内完成。完整覆盖阈值满足但命令退出 1，总门禁未通过，不能据范围通过宣称启动/关闭耗时波动已修复。未改变超时、并发、阈值或客户端命令。

失败证据保留：01 冻结范围
**520/522**（双 stdio 和 EOF 初始化两项取消），完整客户端
**1043/1055**（12 项旧夹具仍调用冷来源同步完整导出而失败）；此前冷加载与引用阶段失败同样保留，没有用后续通过覆盖失败回执。本轮未构建新包、部署、修改用户配置或调用真实模型。

边界：卸载的是原文 artifact 的来源载荷引用，不保证整个会话或进程没有其他原文副本；调用方 request、历史映射等仍可能持有内容，尚无堆内存/延迟改善测量。普通已发布路径的持久确认后卸载、重开冷接纳和精确页已在源码贯通，但完整门禁、网关启动成本、中断发布投影后的持久续写、全天容量、新默认策略、私有流式/steering、多端普通配置、旧发行包迁移/回滚、新包及生产资格仍未完成。

## 当前阶段：引用扫描与冷会话接纳（2026-10-20，范围通过，完整客户端门禁未通过）

SQLite、实际 worker 和显式适配器新增 `recoveryReferenceScanVersion:1` /
`scan-reference`。每页校验请求游标、整代 catalog、scope/root/principal/原绝对期限/revision 和独立引用摘要，拒绝重复根、变化代次和危险访问器。普通 format
3 启动发现只扫描元数据并登记撤销身份；存在中断暂存来源时，先完成整代验证，再显式完整认证所有待清理记录，之后才执行原清理事务。不在引用路径失败后回退旧 load。

会话加载在引用扫描、引用状态、精确页和增量结算四项能力均明确存在时，使用独立元数据发布投影、联合选择与原子接纳。完整元数据图先验证再裁剪，只保留 transport-finished 且祖先已发布的快照；当前请求仍单独校验身份、策略、绑定与歧义。恢复来源不创建原文 artifact，保留预算、计数、历史和原到期时间；旧完整导出拒绝冷来源。能力缺失的旧适配器继续原完整路径，已选引用路径发生错误则停止接纳。

真实加密 worker 重开及策略省略的原生压缩续接测试使用冷会话，精确读取成功；SQL 记录证明接纳不查询原文载荷，读页与进度结算分别认证选定来源。后续保存和发布仍使用引用格式。损坏的未选中密文不阻断元数据扫描或其他根的读取；选择损坏来源时读取失败并停止该根后续 I/O，不能把元数据接纳成功当成字节已认证。新增空/四根、能力缺失、畸形页、代次变化、getter、授权撤回/撤销/禁用/关闭/到期回归，进入既有统一 unit 与原完整客户端入口。

冻结证据
`.hpm-acceptance/context-recovery-cold-loading-20261020-02/receipt.json`：范围
**465/465**，27 模块语句/行 **98.56%**、分支 **94.15%**、函数
**98.65%**；格式、零警告 Lint、语法、CI/发布治理退出 0，运行源和测试摘要一致。原完整客户端
**1044/1046**，0 失败、2 取消：双 stdio 宿主在第二宿主连接期间超过原
**30 秒**，第一宿主连接约
**20600ms**；孤立暂存清理与三次实际加密 worker 重开测试，在第三次 worker
ready 约 **29968ms** 后超过原
**30 秒**，尚未完成最后重开比较与清理断言。范围内双宿主通过但耗时约
**23043ms**，不能用它覆盖完整门禁取消。完整客户端覆盖阈值满足，命令仍退出 1，总门禁未通过。未改变期限、并发、阈值或客户端命令；01
runner 在执行任何门禁前因误把范围内 composition 治理测试要求纳入客户端脚本而失败，bootstrap 失败及源码快照保留。

边界：冷接纳已接入源码，但尚未获得完整客户端资格。普通 format
3 的来源载荷避免全量加载；旧格式或孤立暂存清理仍可完整认证，历史字段也可能保留证据页，不能声称整份会话零原文或已有内存/延迟收益。持久 ACK 后自动卸载仍未接入，新捕获来源仍驻留；中断发布投影后的持久续写、旧发行包冷迁移/回滚、全天容量、新默认策略、私有流式/steering、多端普通配置、新包及生产验收仍未完成。未部署、修改用户配置或调用真实模型。

## 当前阶段：冷账本与独立根元数据恢复（2026-10-20，范围及完整客户端门禁通过）

账本新增私有
`restoreContextEvidenceMetadata`，只接受严格元数据账本并按受信 owner/thread/policy 恢复。非空来源不创建 artifact，保留来源描述、原期限、captured/readCount 和连续读取进度；空来源保留确定的空内容。冷来源只能经既有授权异步存储页路径读取，页仍核验来源/摘要/字节/UTF-8/范围。同步原文读取明确不可用，旧完整导出及选定冷来源载荷导出拒绝，不伪造空内容或暗中重载。冷状态在内部集合记录，不进入模型描述或序列化元数据。

`restoreRecoveryRootMetadataStates`
使用独立入口，先校验根元数据图，再按当前 binding 校验身份和策略、恢复绑定/历史/预算并关联冷账本。旧完整 importer 仍拒绝元数据格式，新 importer 拒绝完整原文根；临时组件或失败恢复的账本均关闭。当前版本的公开/私有历史关联、预算和绝对期限保持，过期根不创建可用 owner。元数据恢复不证明原文字节已读取，也不自行授予当前请求授权。

新增私有 `evictContextEvidencePayloads` 及只返回数量/字节的
`contextEvidenceResidency`。卸载选择有界、唯一且必须存在；整个选择的驻留内容先经完整类型、字节、摘要、UTF-8 和原期限验证，再统一丢弃 artifact，保留来源元数据。重复卸载幂等，零字节来源不创建虚假冷载荷。卸载不退预算、不改进度、不续期。捕获新增来源时还计算含冷来源的逻辑总字节，避免释放驻留内存后绕过原 maxBytes；来源槽位上限保持。

新增五项回归进入原统一 unit/完整客户端入口，覆盖 0 驻留字节的冷恢复、正常/空来源、精确异步页、进度/预算/期限、非法/重复/极端来源选择、错误身份和 payload-bearing 元数据、过期/关闭、逻辑容量与幂等卸载。故障子进程扩展七种 artifact.read 错误（含内容与声明摘要不符），并证明批量卸载第二个来源失败时第一个仍驻留。相关开发
**124/124**，扩展 helper 独立执行成功。

冻结 `.hpm-acceptance/context-recovery-cold-ledger-20261020-01/receipt.json`
扩大 **455/455**、完整客户端 **1036/1036**，0 失败/取消/跳过；18 模块语句/行
**98.39%**、分支 **94.09%**、函数
**98.77%**，格式、零警告 Lint、语法、CI/发布治理及原完整客户端覆盖门禁全通过，运行源和测试摘要一致。开发首次断言因普通/null-prototype 数据对象差别失败，按值规范化比较后通过，失败日志保留。此次网关并发测试通过不能证明此前初始化波动的根因已修复，上一阶段失败回执保留。

边界：这是冷恢复和卸载的内部能力，尚未将卸载接在持久 ACK 后，也未将 startup
scan、发布投影、候选选择与 adoption 切换到根元数据 importer。默认 artifact 仍驻留，不能声称默认内存下降、完整冷重开或全天容量达标；旧版本根的完整冷迁移也尚未单独验收。下一步贯通上述调用链和确认屏障，随后仍须新默认策略、流式/steering、多端配置、容量、新包、迁移回滚和生产资格。未改用户配置、构建新包、部署或调用真实模型。

## 当前阶段：默认持久会话引用读写（2026-10-20，范围通过，完整客户端仍有网关初始化超时）

持久读者和发布事务在适配器显式支持引用状态、来源页和增量结算时，改用 owner 元数据构造独立引用状态，`load-reference`
之后以当前 owner 的身份、策略指纹、绑定 scope、账本 policy/owner、精确预算及单调来源/计数核验存储返回值。存储元数据不能自授当前授权。尚未声明完整能力的旧适配器保持原协议；一旦选用新路径，错误会使该根停止后续存储 I/O，不重试或退回完整原文。

账本新增私有 `exportContextEvidencePayloads`，owner 的
`payloads(capability, sourceIds)`
受原 lease/capability/lifecycle 屏障保护。完整校验有界、唯一且存在的来源 ID 集合后，才读取选定 artifact，验证字节、摘要、期限与 UTF-8，并只返回 sourceId/output；不更新模型预算或读取进度，不暴露 locator。保存时由持久引用集合计算缺失来源，仅这些来源经过载荷导出；重复预算和发布状态保存不物化其它原文。旧完整导出共用相同内容验证，失败仍为固定安全错误。

新增五项回归进入既有统一 unit 和原完整客户端入口，并扩展六种载荷故障及实际 Windows
worker 发布/重开测试。Chat/Claude/Responses 证明
`load-reference → save-reference-state → read-source → settle-reader`，重复保存不再传载荷；禁止完整 checkpoint 的 owner 仍可完成读/List/再读，导出 ID 集合精确为首次一个来源、后续空集合。预算/policy/外层回执伪造、错误 ACK 与存储拒绝均停止根，不产生额外读取或旧协议回退。相关开发
**103/103**，之后补充的读者文件 **34/34**。

冻结 `.hpm-acceptance/context-recovery-reference-host-20261020-01/receipt.json`
扩大 **450/450**，18 模块语句/行 **98.37%**、分支 **94.06%**、函数
**98.75%**；格式、零警告 Lint、语法、CI/发布治理及范围覆盖全部退出 0，源和测试摘要一致。原完整客户端
**1030/1031**，0 失败、1 取消：`actual initialized gateway exits on host EOF and reaps its downstream`
在 `connect_started` 后未完成初始化，超过原
**15 秒**期限；尚未执行 EOF 断言。完整客户端覆盖阈值满足，但测试退出 1，因此总门禁未通过。未延长期限、减少并发、跳过测试或改客户端命令。

独立补充运行同一网关文件 **7/7**，初始化约 **2849ms**、EOF 发送后约 **63ms**
观察到正常退出并回收下游，记录
`gateway-independent.log`。此结果不能抹去并发门禁失败，也不证明初始化耗时波动已修复；旧启动诊断和失败回执全部保留。

边界：默认持久会话的读写/发布源路径已接入引用协议，但原文仍驻留 artifact，启动 scan/adoption 仍全量加载，历史字段也可能含证据页；尚未实现确认后的载荷卸载和完整冷恢复，无内存/延迟改善测量。后续仍需处理该门禁波动、冷恢复、全天容量、新默认策略、流式、多端配置、新包及生产验收。此次未构建新包、改用户配置、部署或调用真实模型。

## 当前阶段：引用状态读取结算（2026-10-20，范围及完整客户端门禁通过）

`settle-reader` 对已保存的 format
3 使用元数据结算，不再完整解密全部来源或写回 format
2。完整检查点和引用结算共用同一预算/计数/进度规则：root/time 关联、单次读取与成功计数增量、预留字节回收上限、来源完整集合及不倒退进度仍严格检查。引用结果经 blob
owner 对实际变化来源的内容/UTF-8 校验后，在同一 CAS 事务提交；旧 inline/format
2 结算路径保持兼容。

新增两项回归进入统一 unit 和原完整客户端入口，真实 SQLite 证明结算只查询变化来源密文，保留 format
3、原期限及预算；未选中损坏密文不被解密或覆盖，完整 load 仍拒绝。覆盖非法 root/time/预算/计数/来源、UTF-8 中间偏移、陈旧 revision、零来源 LIST，以及实际状态 SQL 写入后故障回滚预算与 revision，重试成功。相关开发
**59/59**。

冻结
`.hpm-acceptance/context-recovery-reference-settlement-20261020-01/receipt.json`
扩大 **445/445**、完整客户端 **1026/1026**，0 失败/取消/跳过；17 模块语句/行
**98.47%**、分支 **93.98%**、函数
**98.67%**，格式、零警告 Lint、语法、CI/发布治理及原完整客户端覆盖门禁全部退出 0，运行源与测试摘要一致。此轮未更改任何期限、覆盖阈值或客户端命令。

边界：消除的是 format
3 存储结算的全量物化和格式退回；默认 host/owner 尚未切换新引用协议，因此默认行为仍不能据此声称冷恢复或内存/延迟改善。下一步仍为受信当前策略核验、选择性载荷导出、默认保存/加载接入及确认后安全卸载；全天容量、新默认行为、多端配置、新包和生产资格仍未完成。未改用户配置、部署或调用真实模型。

## 当前阶段：独立引用持久状态（2026-10-20，范围及完整客户端门禁通过）

新增
`context-recovery-reference-state.js`：元数据、暂存来源和发布 journal 使用独立摘要，不再依赖含完整原文的 sourceDigest。严格校验根关联、策略、期限、预算和来源描述；转换要求根身份/原绝对期限及保留来源身份不变，计数和读取进度不得倒退，未过期来源不得消失。它是内部存储协议，不授予当前请求接纳或读取权限。

存储适配器显式声明 `recoveryReferenceStateVersion:1` 后支持
`save-reference-state` /
`load-reference`，未声明的包装器不推断支持。真实 SQLite 保留 schema
2，在加密 envelope 中引入 format
3：只保存引用元数据，新增来源分别加密。重复保存和引用加载校验 blob 表头及存在性，不读取保留来源密文；读取进度变化时只认证变化来源并验证 UTF-8 前缀。选定来源读取仍核验内容。旧 inline/format
2 首次迁移完整验证，保留来源 ID、预算、绝对期限；旧完整 load 仍可完整还原，新状态经显式旧 save 可写回 format
2。此为模块级兼容验证，不能代替实际旧发行包回滚验收。

完整性边界：未选中来源密文损坏时，引用加载和不改变该来源进度的保存允许继续，且不覆盖损坏密文；选中损坏来源读取、旧完整加载、撤销和到期清理均拒绝。元数据摘要不证明原文字节可用，不能把引用加载成功当成所有来源已解密验证。缺失/额外 blob、错误表头和非法 envelope 拒绝，实际 SQL 写入故障回滚状态与新增 blob，原密文保留。

新增 12 项回归进入既有统一 unit 和原完整客户端入口，覆盖空/零来源、Unicode 边界、进度倒退、非法回执、危险访问器、损坏密文、CAS、迁移、重开、撤销及绝对到期。实际 Windows
worker 验证新保存/加载、精确页、旧完整 load、重开，数据库无合成原文明文。开发最终
**38/38**。冻结
`.hpm-acceptance/context-recovery-reference-state-20261020-01/receipt.json` 扩大
**443/443**、完整客户端 **1024/1024**，均 0 失败/取消/跳过；17 模块语句/行
**98.47%**、分支 **93.94%**、函数
**98.66%**，格式/零警告 Lint/语法/CI 与发布治理全部退出 0，运行源和测试摘要一致。前期开发失败记录保留；未放宽任何门禁。

边界：默认 host 保存、加载及 owner 仍未切换到新引用协议；读取结算仍可能完整物化并写回 format
2，artifact 仍驻留内存。当前请求的可信策略核验、选择性载荷导出、确认后的卸载和冷恢复还需贯通。全天容量、新默认策略、流式、多端配置、新包及生产验收未完成；本轮未构建新包、部署、改用户配置或调用真实模型。

## 当前阶段：根元数据关联校验与租约导出（2026-10-20，范围及完整客户端门禁通过）

`context-recovery-root-state.js` 新增独立 `validateRecoveryRootMetadata`，只接受
`{metadata, stagedSources}`
且根 kind/version 为独立元数据格式。沿用原根 policy/版本/期限、账本元数据、预算、绑定祖先和历史组件校验，并复用原关联检查：快照与绑定顺序、父子 calls/captured/visible、来源匿名关联、暂存与已发布隔离、映射 tips/父关系、pending
results、private-history 连续性及读取计数。验证器不创建账本载荷或返回运行时 token；临时绑定和历史 registry 在 finally 关闭。完整恢复仍先检查每份原文的完成来源契约，并保留原账本完整摘要与 UTF-8 校验。元数据的来源摘要/字节/中间 UTF-8 偏移仍须在读取载荷时验证，当前请求的授权/接纳也仍独立执行。

owner 新增 `metadata(capability, reservation)`，复用当前 owner
lease、读 capability、reservation 校验及撤销/关闭/到期屏障，由账本索引直接导出已发布与暂存来源，不读取 artifact。返回保留原预算、时间、绑定和历史的脱离内部引用的数据；已结算 reservation 使用原相同预算导出契约，不能使用未知 reservation。模型工具和恢复接纳入口没有增加新权限。旧
`checkpoint` 仍导出完整原文。

引用写入解析器在物化前调用根关联校验；发布 journal 也提取为共用的有界严格解析，旧完整检查点与引用路径均检查快照状态、重复 ID、未知字段和缺失快照的允许终态。v1 根没有 policyBasis，元数据验证仅按原存储 binding 校验其指纹与祖先，不伪造 null
policy；v2+ 继续以保存的策略基础校验绑定。实际接纳仍要求当前原策略，新增非空策略的 v1 回归保持原指纹及旧到期时间，未授予 v1 自动接纳权限。

新增五项测试进入既有统一 unit/完整客户端文件，扩充既有暂存隔离、租约失效和 v1/v2 保留期限测试；载荷故障子进程增加实际 session
owner 的六种 artifact.read 故障验证，证明根元数据导出和关联验证均不访问载荷，而旧完整 checkpoint 仍拒绝故障。owner 开发
**33/33**；开发中缺少 binding
history 参数及一次无变化的空 tips 断言已按真实组件契约修正。

冻结 `.hpm-acceptance/context-recovery-root-metadata-20261020-01/receipt.json`
扩大范围 **431/431**、完整客户端
**1012/1012**，均 0 失败/取消/跳过，runner 最终退出 0。16 个运行模块语句/行
**98.59%**、分支 **94.04%**、函数
**98.58%**；格式、零警告 Lint（含故障 helper）、语法、CI/发布治理及原完整客户端覆盖门禁均退出 0，运行源与测试摘要前后一致。本轮双真实 stdio 宿主和独立 native
ACL 均通过，仍保留此前三份引用写入及一份账本元数据冻结失败，不据本轮通过宣称启动耗时波动或其根因已修复。未提高期限或覆盖阈值，未更改原完整客户端命令。

边界：owner 元数据出口已具备，但现有事务和加载尚未切换到它。引用 v1 的 sourceDigest 仍依赖旧完整检查点；worker 保存/结算及 load 仍全量物化，历史字段也可能包含证据页。下一步需要独立版本的引用持久状态和显式 load 能力，先完成安全迁移及确认，再允许卸载载荷；不能删掉原文后依赖旧完整导出，也不能以无载荷元数据冒充旧恢复根。元数据校验是内部一致性边界，未来 load/adoption 必须另以当前受信策略核验额度和权限，不能以存储 policy 自身作为接纳依据。冷重开、全天容量、新包及生产、多端普通配置和迁移回滚仍未完成。

## 当前阶段：账本元数据独立校验与内部导出（2026-10-20，范围通过，完整客户端未通过）

`context-evidence-ledger-state.js` 在共用有界纯数据校验内新增独立
`parseEvidenceLedgerMetadata`。元数据沿用独立 kind、严格字段集合及 256KiB 归一化界限，检查 owner/policy、来源身份、重复 sourceId/callId、时间/绝对到期、单源及累计容量、读取进度和计数，不接受 output 或私有 locator。旧完整状态接口仍强制原 kind、output、完整内容摘要及 UTF-8 前缀校验，不能通过新增参数选择元数据模式。元数据本身不证明内容字节、摘要真实性或 UTF-8 中间偏移，也不授予恢复权限；原页/完整状态验证继续承担这些边界。

账本增加私有 WeakMap 管理的 owner 元数据导出，直接复制索引字段并校验，不调用 artifact.read，也不导出 locator。引用式写入的解析器在载荷物化前独立校验已发布和暂存来源的合并元数据；实际保存仍走原完整验证。新增四项回归进入已有统一 unit/客户端文件，六种真实 artifact.read 故障的子进程同时证明元数据导出不读取载荷、无可变引用外泄；覆盖空原文、到期/关闭、错 owner、旧/新格式互拒、非法计数、重复身份、容量和危险数据。相关开发回归
**44/44** 通过。

冻结 `.hpm-acceptance/context-recovery-metadata-index-20261020-01/receipt.json`
沿用原期限/覆盖阈值，含此前真实 stdio 测试。扩大范围
**426/426**、0 失败/取消/跳过；14 个运行模块语句/行 **98.36%**、分支
**93.93%**、函数
**98.44%**，格式、零警告 Lint、语法及 CI/发布治理均通过，运行源与测试摘要前后一致。完整客户端
**1006/1007**、1 失败/0 取消/跳过，两个实际网关测试通过；唯一失败为独立 native
ACL 测试中读取四个目标 DACL 的 PowerShell 核验子进程超过原 10 秒期限，抛 ETIMEDOUT，未到 ACL 判断结果。runner 终态退出 1，总门禁未通过，不能将此归类为已证实权限错误或已排除权限错误；单独复核结果见同目录
`acl-diagnostic.log`。没有增大期限或降低门禁。

ACL 同一现有测试独立复核 **1/1** 通过，测试约
**2.73 秒**，包含四个目标的独立 DACL 判断及 junction 拒绝，原 10 秒子进程期限未变，证据同目录
`acl-diagnostic.log`。此结果证明该独立样本，不清除完整客户端的 ETIMEDOUT，也不证明并发资源争用或单一根因。

网关进一步独立诊断
`.hpm-acceptance/gateway-startup-profile-20261020-01/result.json`
使用固定阶段词表的测试预加载器，不修改运行代码、不输出任意模块名/原始 stderr/用户数据。两次真实初始化/列工具/调用合成工具路径连接分别约
**5.47/4.94 秒**；网关模块图加载各约 **2.39 秒**，其中首次 SDK
Client 导入约 1.85/1.76 秒，AJV 导入约 0.70/0.65 秒；下游进程启动及握手约
**2.42/2.02 秒**。这些为独立诊断样本，不代表完整并发运行、不构成修复或性能改善结论。此前三份失败冻结仍有效。

本阶段只建立独立元数据边界；owner 导出完整检查点、load、worker 保存/结算仍物化原文，未实现安全卸载和冷重开。下一步须以受版本约束的根元数据验证覆盖绑定/历史/分支/publication/预算，再引入显式引用加载能力和持久确认后的载荷卸载，禁止用元数据绕过旧恢复授权。全天容量、新包、生产、多端普通配置及迁移回滚仍未完成。

## 当前阶段：引用式检查点写入（2026-10-20，范围通过，完整客户端未通过）

真实加密 worker 新增显式 `recoveryReferenceWriteVersion:1` 能力和内部
`save-reference`
操作，opening 只转发实际适配器声明。宿主保存时传递独立版本的根/账本元数据、原完整检查点摘要及新增来源的
`{sourceId, output}`；已有来源只传描述，不重复传其 output。无能力声明的旧适配器保留原 save。根、来源、SQLite 持久格式及模型工具接口不变；引用传输格式不是恢复权限。根身份和来源不可变字段固定，拒绝替换旧原文、重复/缺失/多余 payload、摘要不匹配、未知字段、危险原型/访问器及非法 UTF-8。worker 还原、验证完整检查点后，在原 SQLite 事务内复用 blob 并提交状态；已有到期时间不延长。

八项新增回归进入既有统一 unit/完整客户端文件。覆盖 Chat/Claude/Responses 首次传原文、后续复用、混合新旧来源仅发新 payload、空原文/无来源、身份和完整性拒绝、真实 blob/state 写入后的原子回滚及确认异常保留最坏预留。实际 Windows
worker 路径已验证
`load → save-reference → read-source → settle-reader`、重开及加密文件无合成原文明文。新增运行模块
`context-recovery-reference-write.js` 已进入发布源清单。

首次冻结 `.hpm-acceptance/context-recovery-reference-write-20261020-01/` 范围
**394/394**，完整客户端
**1002/1003**；失败为 idle 清理测试固定等待 150ms 时实际 sweep 尚在执行。测试改为由成功且观察到已推进时钟的定时回调 Atomics.notify，观察端等待实际完成并继续用独立 SQLite 连接证明过期行已删除，未发送 owner 命令触发清理。未更改生产间隔、测试总期限或成功断言；新增等待通知断言通过。

第二次冻结
`.hpm-acceptance/context-recovery-reference-write-20261020-02/receipt.json`：含 idle 回归的扩大范围
**406/406**，13 个运行模块语句/行 **98.29%**、分支 **93.66%**、函数
**98.38%**；格式、零警告 Lint、语法、CI/发布治理通过，运行源和测试摘要前后一致。完整客户端
**1001/1003**，0 失败、2 超时取消：双 generic host
stdio 测试超过原 30 秒，初始化后 EOF 测试超过原 15 秒。两份失败回执保留，不能标为工程通过；后续为这两个真实宿主测试增加仅固定阶段名和耗时的诊断，定位连接、调用及关闭边界，未提高期限或修改生产逻辑。

独立覆盖诊断两个实际宿主测试 **2/2** 通过，证据
`...-02/gateway-diagnostic.log`：双宿主总约 12.9 秒，两次 connect 约 4.35/7.87 秒，关闭各约 0.24 秒；EOF 测试总约 4.65 秒，connect 约 4.34 秒，发送 EOF 后退出约 0.23 秒。该独立运行等待主要在连接阶段；不能据此证明完整并发运行的超时根因或性能修复，也不能清除失败门禁。

第三次冻结 `...-03/receipt.json` 加入两份诊断测试，扩大范围
**421/422**、0 失败/1 超时取消，完整客户端
**1003/1003**、0 失败/取消/跳过；覆盖率、格式/Lint/语法及治理通过，运行源和测试摘要前后一致，runner 最终退出 1，总门禁仍未通过。范围中双宿主首个 connect
**19.10 秒**、第二个
**9.56 秒**，调用完成后关闭第二个宿主时达到原 30 秒总期限；EOF 专项约 11.06 秒通过。完整客户端双宿主约
**20.32 秒**通过，两次 connect 约 9.47/9.80 秒。同一源码在不同运行下启动耗时波动明显，当前诊断仍将模块加载、进程启动与下游握手合在 connect 内，下一步须分段测量，不能将偶然通过视为根因已修复。三次冻结均保留，期限与阈值未变。

边界：只去掉重复传输的来源 output；元数据仍含既有绑定和历史，可能含历史中的证据页，不能声称整个请求不含原文。宿主仍导出/持有全量检查点，sourceDigest 仍全量计算，load 和 worker 保存/结算仍还原全量原文，artifact
store 仍驻留载荷。现有指纹归一化另有 2MiB 限制，12MiB 名义根上限不代表可用容量；全天容量画像仍失败。下一步先定位完整客户端超时，再实现真正独立校验的引用 owner/加载/淘汰及分层预算。无新包、生产激活、客户端配置/认证变更或真实模型请求，整体目标未完成。

## 当前阶段：读取结算只传预算与进度（2026-10-20，范围及完整客户端门禁通过）

真实 SQLite/加密 worker 新增内部 `settle-reader`
操作及显式能力声明，opening 仅转发实际适配器声明，默认 worker 在启动前声明。支持该能力的根读取在完整预留检查点提交、原文读取结束后，改为由当前 owner 导出预算、根 ID、观察时间和每份来源的连续读取进度；结算请求不再携带 output、完整 root、绑定、发布 journal 或用户历史。未声明能力的旧适配器保留原完整检查点结算路径。模型工具接口未改变，不能直接指定结算、scope 或预算。

新增 `context-recovery-reader-settlement.js`，有界归一化并严格解析 version
1 的内部增量。应用时以已有、完整校验的检查点为基准，固定根身份，拒绝时间回退/过期、调用数改变、超过单次预留的退款、成功数和账本读取数不匹配、来源新增或未过期来源遗漏，以及读取进度回退、伪造完成、非 UTF-8 边界等。只更新当前读取相关的预算与进度，保留原文、来源期限、绑定、快照和 publication 状态，重建原检查点摘要后再次校验。源/检查点/SQLite 格式保持现有版本；增量属于内部传输协议，不是新模型权限或新的恢复根格式。

账本增加内部 metadata-only 进度导出；故障子进程在六种真实 artifact.read 故障下确认该导出不访问原文，并验证调用方修改不会影响内部进度。支持增量结算时，预留提交后的权限复核改为 owner 当前 capability/lease 检查，避免为权限检查和结算再次调用全量 owner.checkpoint。事务层仍持有本次已保存的完整检查点用于校验；worker 仍还原原有完整检查点、校验、应用增量并在同一真实 SQLite 事务内保存，不回退失败的结算，不更改绝对期限。

新增七项回归进入既有统一 unit/客户端文件，覆盖 READ/LIST、暂存来源、大于单页的 Unicode 原文与空原文；结算请求只含四个受限顶层字段且小于 16
KiB；篡改身份/时间/预算/来源/进度、额外字段及访问器固定拒绝且不执行钩子。真实加密 SQLite 验证已有 blob 密文逐字不变、CAS 和错误 scope 拒绝、正常物理 owner 重开后原文/预算/进度/期限保持，以及撤销后拒绝结算。实际 recovery_state
SQL 写入后注入异常能原子回滚，保留旧预留；确认前后异常均不自动重试或回退同步路径。结算确认被阻塞时结果不提前公开，abort/撤销/禁用/关闭/到期不能恢复权限。取消后若正常收到已持久提交的结算确认，允许沿用既有规则确认计数，但仍不返回内容；确认异常则保留最坏预留。

实际 Windows 加密 worker 会话顺序已变为
`load → save → read-source → settle-reader`，关闭重开验证原文、预算与期限保持，磁盘不含合成原文明文；测试代理明确转发两种能力，不再以旧路径代替新路径。最终冻结扩大
**386/386**；12 个运行模块语句/行 **97.80%**、分支 **93.43%**、函数
**98.26%**。范围格式、零警告 Lint（含故障 fixture）、语法、CI/发布治理及原完整客户端命令全部退出 0，完整客户端
**995/995**，0 失败/取消/跳过；运行源与测试摘要前后一致。证据
`.hpm-acceptance/context-recovery-reader-settlement-20261020-01/receipt.json`，新增模块已进入发布源清单。开发中一条取消断言误将“已收到正常结算确认”视为确认失败，按原允许晚确认计数但不复活权限的契约修正；生产规则未因此放宽。

边界：本阶段去掉的是**结算请求中的完整原文及多次 owner 原文导出**，不是所有预算更新或检查点复制。初次预留、load、root/checkpoint/IPC 的其它路径仍携带全量原文；事务/worker 仍复制和校验已有完整检查点，私有 artifact
store 仍驻留原文。没有完整冷存储、内存/延迟改善或全天容量达标结论。下一步必须将引用状态贯穿预留/加载和安全载荷卸载，再升级调用/快照容量及分层预算；原全天容量失败结果仍有效。未构建新包、部署、改变用户配置或调用真实模型，整体目标继续未完成。

## 当前阶段：持久化异步原文分页读取（2026-10-20，范围及完整客户端门禁通过）

真实加密 SQLite/worker 增加内部 `read-source`
操作；只有明确声明 source-page 能力的存储走新路径，旧注入适配器继续既有同步读接口。opening 转发实际适配器能力，默认 worker 能力在启动发现前声明。模型仍只提供既有 sourceId、digest 和范围，不能提供 scope、内部引用或文件路径。session
owner 在当前主体/策略/分支和租约有效时，先确认最坏预算预留已持久提交，再按当前 scope/revision 读取选定来源，返回后复查权限、来源期限和页数据；结算持久提交后才返回结果。LIST、非法参数、失效或兄弟分支来源不因此获得原文读取权限。

新 `context-evidence-stored-page.js`
对来源描述及页作有界纯数据校验，核对来源、字节、摘要、UTF-8、范围、续页及序列化结果预算；整份页同时验证整体摘要。标识规则与既有账本一致，拒绝访问器、自定义原型、额外字段和危险数据，不执行数据钩子。blob 读取认证 manifest 和指定来源密文，只查询选定 blob，不把其它来源全部还原；它仍依赖可信 owner 已授权、完整校验且提交的检查点及匹配 revision，存储选择器本身不是模型权限。原来源/根绝对期限保持，读取不续期。

回归发现并修复新异步错误路径：存储抛错、非法 Promise 或返回损坏页时，上层工具会转换为安全失败，若事务层未标记失败，仍可能继续结算并释放预留字节。现在
`readSource`
的异常会使该根的存储路径失败，拒绝后续结算和读取，保留最坏预留；绝不回退驻留内存原文。合法的固定范围/预算拒绝仍按既有失败计数结算。异步账本读取在开始前校验范围，等待后重新检查来源，只有有效成功页才更新连续读取进度和计数。

新增 18 项回归进入统一 unit 和完整客户端入口，覆盖 Unicode/空原文/末尾空页、分页和完整摘要、极端边界、模型结果预算、固定错误、危险数据、revision/scope/描述不匹配、缺失/损坏密文、旧 inline 兼容、异步单次预留及并发阻挡。真实 SQLite 分别阻塞预留、页和结算确认，证明结果不会提前公开；abort/撤销/禁用/关闭/到期发生在真实页读取后但确认前，均不能返回内容。Chat/Claude/Responses 三种会话保留原 LIST、参数和安全失败语义，随后仍能精确读取。实际 Windows 加密 worker 路径确认
`load → save → read-source → save`，关闭重开后原文、预算和期限保持，文件不含合成原文明文。

最终冻结扩大 **379/379**；11 个运行模块语句/行 **97.78%**、分支 **93.41%**、函数
**98.15%**。范围格式、零警告 Lint、语法、CI/发布治理全部退出 0；原完整客户端
**988/988**，0 失败/取消/跳过，覆盖率门禁通过。运行源和测试摘要前后一致，回执
`.hpm-acceptance/context-recovery-stored-page-20261020-02/receipt.json`。新增运行模块已加入发布源清单。首个 runner 因引用不存在的 checkpoint 测试路径在格式检查退出 2，失败回执保留在
`...-01/`；修正 runner 路径后另建冻结运行，未降低阈值。开发期间测试对 owner 锁内导出、SQLite
Uint8Array、已关闭账本异常及既有错误脱敏的错误预期均按真实契约修正，未放宽生产权限。

边界：完成的是**指定来源的异步持久读取链路**。每个选中 blob 仍整体解密后构造页；私有 artifact
store 仍驻留原文，root/checkpoint 导出、IPC、load 和预算保存前验证仍物化全量原文，不能声称完整冷读取或内存/延迟改善。下一步仍须引用状态贯穿检查点/IPC/恢复并实现安全载荷卸载，再处理调用/快照容量和分层预算。全天容量画像仍未通过；新默认策略、完整流式/steering、多端普通配置、迁移回滚和生产资格仍未完成。此次未构建新包、部署、修改用户配置或调用真实模型，旧包资格不能用于当前源，整体目标继续未完成。

## 当前阶段：账本索引载荷分离与单次检查点导出（2026-10-20，范围及完整客户端门禁通过）

账本 sources/calls 索引在捕获和恢复时不再保存 output，仅保留元数据与内部 artifact
handle；原文仍由既有私有 artifact
store 持有。可信旧格式导出时按当前 owner/scope/handle/digest 取回原文，核对类型、字节、摘要和原期限后才交给既有 ledger 状态解析器。空来源按零字节规则导出。失败只返回固定 invalid_evidence_ledger_state，不从隐藏的旧 output 字段回退，不把内部 handle 暴露给模型。该 owner 导出不增加 readCount、coveredThrough、readComplete 或模型预算，读取/重开不延长原绝对到期。

root 导出共用一次 partitionRecoveryRootState；新增内部 exportRecoveryRootCheckpoint 以同一次账本导出划分已发布与暂存来源，持久 owner.checkpoint 不再先导出 root 后再导出全部 ledger。reservation 仍按原契约使用：未读前保存最坏预留预算，读取后才允许导出结算预算；未知 reservation 在物化原文前拒绝。主体/策略/分支和 lease 检查保持原路径，暂存来源不会因进入检查点获得 root 发布权限。没有改变 root/ledger/checkpoint 或 SQLite 格式和公开工具定义。

新增三项统一回归覆盖大于模型单页的 Unicode 原文及空来源的重复导出/恢复、预算与 TTL 不变；隔离子进程注入真实 artifact 读取边界的缺失/类型/字节/摘要/期限/异常六类故障，确认失败后不回退原文字段，正常恢复后仍能精确导出；混合已发布/暂存来源的 checkpoint 关联、调用方修改隔离、预留/实际结算、伪造 capability/reservation 和释放后拒绝。fixture 只在子进程加载时拦截模块，生产无新注入选项或模型载荷 provider。开发时新 owner 测试误用解析器对象引用相等及读取前结算参数，按已有克隆/预留契约更正，未放宽生产预算或断言目标。

实际旧封存包的 ledger/artifact 模块复核与其 manifest 对应，使用相同故障 fixture 得到 Missing
expected
exception 负控，证明旧路径绕过了 artifact 读取失败；当前生产路径拒绝六类故障。负控和校验回执位于
`.hpm-acceptance/context-recovery-ledger-payload-20261020-01/negative.log` 与
`negative-receipt.json`。首轮专项 46/46，新增项最终单独 29/29；最终冻结扩大
**320/320**，三个运行模块语句/行 **96.75%**、分支 **91.71%**、函数
**97.61%**。格式、零警告 Lint（含新 fixture）、语法、CI/发布治理及原完整客户端命令全部退出 0，完整客户端
**970/970**，0 失败/取消/跳过，运行源与测试摘要前后一致，证据同目录
`receipt.json`。新增项进入既有统一 unit/客户端测试文件。

边界：只移除了**索引上的原文字段和检查点二次账本导出**。私有 artifact
store 仍将原文保存在内存中，旧导出协议、IPC、持久化加载仍物化完整原文；没有内存/延迟改善的测量或完整按需冷读取资格。下一步必须引入可独立验证的引用状态及异步按页读取，预算需先持久预留、返回前再次检查当前 lease/撤销。条数、累计调用、快照和任务累计预算未扩大，全天容量仍未达标。当前源码不沿用旧包资格，本轮未构建新包、重启/部署、修改用户配置/认证或调用真实模型；整体目标继续未完成。

## 当前阶段：SQLite 原文与检查点磁盘分离（2026-10-20，范围与完整客户端门禁通过，完整冷存储未完成）

已接入真实存储主路径：第一次保存合规 recovery-write-ahead 检查点时，在原 BEGIN
IMMEDIATE 事务内新增 recovery_blob 严格表、升级 user_version 至 2、更新已认证 header 的布局版本，并保存只包含 outputRef 的加密检查点及按来源独立加密的原文。blob 的 AAD 绑定 store、root
scope、内部引用及原创建/到期，引用由 sourceId、摘要、字节和原期限确定；它仅是内部定位，不授予主体/策略/分支权限。未改变公开 LIST/READ 接口或主体验证。重复预算保存重用原 blob 密文，不重新插入整份原文。

布局 2 严格识别完整 DDL；原布局 1 的数据库在读取时不迁移，旧 inline 记录在布局 2 中也继续可读，当前检查点保存才转换为引用格式。root/ledger/write-ahead 的公开可信状态版本未变：存储内部封装为 version
2、kind=recovery-referenced-checkpoint，当前加载边界会认证并完整还原旧状态后再交给已有解析器，不能把 root
v7 重新标号当作新权限格式。数据、引用、布局和时间水位在同一事务提交；新增 blob、发布 manifest 或批量撤销的实际 SQL 写入后故障均回滚，保留旧记录。撤销/过期同时删除原文及引用；损坏、缺失、重复、越 scope、畸形内容或孤儿引用失败关闭，不通过清理掩盖损坏。逻辑配额和 inspect/sweep 字节计数包含 blob 密文，32
MiB/4 root 及其他上限未提高。

11 项新增回归进入统一 unit 和原完整客户端入口，覆盖正常、空原文/零来源、暂存来源、旧格式迁移、原预算/期限、重复保存、真实写入故障、畸形 manifest、UTF-8/字节/摘要/来源身份、跨 scope 密文替换、到期损坏及大载荷配额。首次开发回归暴露还原 source 为普通对象而旧数据契约为 null
prototype，已修正生产边界返回归一化数据；随后修正一个测试的旧状态预期。首个冻结 runner 在 Lint 因未限定 structuredClone 全局名退出 1，失败回执保留；改为 globalThis.structuredClone 后建立新冻结 runner，未更改规则、原阈值或期限。

最终冻结扩大 **300/300**，四个存储模块语句/行 **100%**、分支 **93.39%**、函数
**97.05%**；格式、零警告 Lint、语法、CI/发布治理及原完整客户端命令全部退出 0，完整客户端
**967/967**，0 失败/取消/跳过，运行源/测试摘要前后一致。新增模块进入发布源清单。证据
`.hpm-acceptance/context-recovery-storage-blobs-20261020-02/receipt.json`；完整客户端覆盖亦包含既有实际加密 worker、跨物理 owner 正常重开和 v7 提交确认后强杀路径，不代表迁移确认前所有进程崩溃窗口。

另用上一封存包实际 storage-sqlite 模块在真实 SQLite 文件写入 inline 检查点，核对该包
**582** 个源文件和 manifest SHA256
`4eb1ea482224541c14e7ccddabbb94d75dd2cb698a14a78f6745f11eef43b66f`。新模块读取后保存迁移至布局 2，重开后 checkpoint/sourceId/原文/预算/期限逐字段保持；实际旧包读取器拒绝布局 2，文件 SHA256 前后未变；新模块撤销后重开仍 load=null 且 blob 为 0。迁移完成与撤销后数据库均未发现合成原文明文。探针使用临时内存随机密钥，不是 OS 密钥保护或跨设备资格。证据同目录
`migration-receipt.json`，不是新包验收或完整降级回滚资格。

边界：这里只完成**磁盘存储分离**。ledger 仍保有 output，root/checkpoint 导出、IPC 和加载仍带全量原文；预算保存虽不重写原文密文，仍有全量验证/还原开销，未证明延迟或内存改善。不得据此宣称完整冷存储或全天容量完成。下一步须把可信来源 handle 贯穿 ledger、root/checkpoint 和异步按页读取，再同步处理调用/快照和分层预算。旧备份撤销水位、迁移提交前强杀、完整回滚、实时流式、多端普通配置和生产仍未完成。本轮未构建新包、重启/部署、改变用户配置/认证或调用真实模型；整体目标继续未完成。

## 当前阶段：固定容量验收入口（2026-10-20，工具门禁通过，容量验收明确失败）

新增正式命令 `npm run qualify:context-capacity`，任务构造及读取验证拆入
`scripts/lib/context-recovery-capacity-workload.js`。五个不可变画像采用独立 workloadVersion
1，保留 24 小时小结果、8 小时密集任务、四并发任务和频繁恢复，并加入四任务各 480 次调用、32
KiB 原文、100 次恢复的工程候选。候选是工程验收输入，不是已经达到或用户认可的容量承诺。参数先做有界纯数据校验，拒绝访问器、额外字段及非法/极端值；输出仅含画像、计数和固定错误码，不包含原文或异常。

修正旧一次性测量的成功判据：最后一次 complete 只观察到工具调用，未必收到其结果，因此必须额外 begin 排空最后结果后才能报告成功；恢复次数按画像精确安排，不向下取整到较低次数；固定首份 sourceId 的原文必须按 READ 分页全部拼接、校验每页及整体摘要，并在重开后逐字比较。重开明确只指 JSON 检查点重建，实际仍是 chat 累计公开历史、合成时钟和核心 API，不包含原生压缩、传输、SQLite 持久性、安装客户端或真实模型资格。尤其 32
KiB 候选在第 65 轮 begin 返回 invalid_context_binding，不能把这个未细分的拒绝直接归因为某个单独配额，也不能宣称是压缩后任务容量测量。

容量命令现有实际退出码为
**1**、qualified=false，五个画像均未通过；执行错误单独返回
**2**，只有所有画像达到完整要求才返回
**0**。四个历史画像继续出现 64 来源、128 调用、256 快照及 32 次恢复组合的缺口；候选四任务仅完成总计 256 轮即拒绝。测试通过仅证明验收工具正常工作，不能替代容量命令通过。原始容量结果见
`.hpm-acceptance/context-recovery-capacity-workload-20261020-01/qualification.json`
及 `qualification-exit.json`。

六项新增回归进入统一 unit 自动发现和原完整客户端命令，覆盖输入/安全、空来源、最后结果排空、多页原文、重开、缺口及 CLI 退出码区分。冻结扩大
**235/235**，新增工具语句/行 **100%**、分支 **92.42%**、函数
**100%**；格式、零警告 Lint、语法、CI/发布治理、原完整客户端命令均退出 0，完整客户端
**956/956**，0 失败/取消/跳过，运行源与测试摘要前后一致，证据
`.hpm-acceptance/context-recovery-capacity-workload-20261020-01/receipt.json`。此前首次开发测试 3/5 保留在工具输出：错误使用 READ 的 range 容器，按真实顶层 offsetBytes 契约修正后通过，未修改运行代码、原门禁或预算。

本阶段只建立可维护的验收入口，没有改变代理运行源码、存储格式或任何容量上限，没有新包或部署。原文/检查点分离、预算分层、实际压缩与多端长任务资格等仍待实现；整体目标继续未完成。

## 当前阶段：分支留存覆盖反馈（2026-10-20，完整客户端门禁通过，容量仍阻塞）

修复容量负控中“新原文未留存，但索引只返回已有来源”的反馈缺口。自动恢复会话的 LIST 现在增加
`coverage`：仅以已授权当前分支的 calls 和仍可见、未到期来源计算
`observedCalls`、`availableSources`、`unavailableOrPendingCalls`，状态分别为
`no_observed_calls`、`complete_for_observed_calls`、`incomplete_or_pending`，scope 明确为
`observed_calls_on_branch`。不观察共享 ledger 的条数，不返回原文、参数、来源名或错误内容。它不能区分尚待返回、策略拒绝或容量丢失，因此保留不确定性；即使当前已观察调用全部有来源，也不声称整个聊天完整。

非平凡投影拆为 `lib/proxy/context-evidence-coverage.js`
并进入发布源清单。计数受当前 128 次调用契约限制，畸形/极端输入固定拒绝，不执行值转换钩子；未来容量契约升级须同步修改该校验。新回归在旧源码先失败：第 65 份结果被容量拒绝时索引缺 coverage。修复后确认 65 个已观察调用/64 个可读来源会报告缺口；兄弟分支只能得到自己的 0 个可读来源，序列化重开后仍能重建同样缺口，同时可精确读取第一份原文。状态派生自已有持久化字段，不新增存储格式或在重启时清账。两个新增测试进入既有统一 unit/客户端会话测试文件。

首轮单文件 **31/31**；最终冻结扩大 **260/260**，新投影模块语句 **30/30**、分支
**13/13**、函数 **1/1**
全覆盖。格式、零警告 Lint、语法、CI/发布治理及原完整客户端命令全部退出 0，完整客户端
**950/950**，0 失败/取消/跳过，运行源与测试摘要前后一致。证据
`.hpm-acceptance/context-recovery-coverage-20261020-02/receipt.json`。首个冻结 runner 的完整客户端
**949/950**
失败保留：共享工具描述变更改变了历史 benchmark 语料摘要。恢复原共享说明后建立新冻结 runner，未更新历史摘要、提高 baseline 或关闭断言；最终运行源仅修改会话投影、增加投影模块及发布清单，共享工具说明保持原值。

本轮没有扩大量、调用、快照或读预算，全天容量阻塞仍成立；coverage 是缺口反馈，不是容量修复。当前运行源已超过上一隔离包，旧包 429 项及安装客户端资格不能用于证明新投影，包内/实际客户端新行为仍待验收。未部署、安装插件、改变用户配置/认证或调用真实模型，整体目标继续未完成。

## 当前阶段：全天容量负控（2026-10-20，已确认首发容量阻塞）

本轮只新增隔离测量脚本，没有改变运行源码、测试、配额或配置。对当前真实 session/binding/ledger/reader 实现推进合成时钟，每轮生成一个合规工具调用、下一轮报告合成原文，并定期序列化/重开；通过正式 LIST/READ 固定读回第一份原文。四个画像均未达到其请求的任务长度：

| 合成任务画像                                         | 实测最先出现的缺口                                                   | 后续硬限制                                                                   |
| ---------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 24 小时，每 5 分钟一轮，每份 1 KiB，定期恢复         | 第 66 轮首次有 65 份已报告结果但仅 64 份可见（5 小时 25 分）         | 第 129 轮 complete 返回 invalid_recovery_calls，完成 128 轮（10 小时 40 分） |
| 8 小时，每分钟一轮，每份 1 KiB                       | 第 66 轮首次缺留存（65 分钟）                                        | 第 129 轮不能继续提交（128 分钟）                                            |
| 四任务各 8 小时，每 5 分钟一轮，每份 512 字节        | 四任务各完成 64 轮后                                                 | 第 65 轮 begin 返回 context_binding_quota，总计 256 轮（5 小时 20 分）       |
| 8 小时，每 5 分钟一轮，每轮 LIST+READ，每份 512 字节 | 第 34 轮的第 33 次恢复组合在 LIST 返回 evidence_read_budget_exceeded | 成功恢复 32 次；后续同样出现 64 份来源上限                                   |

这些结果不是实际耗时或真实客户端/压缩负载验收，而是按明确事件频率推进的容量负控。定期重开未清空预算或延长期限；已有第一份原文在成功读回时仍逐字一致，没有通过驱逐旧来源伪造容量。单份和总字节都很小，已经暴露条数、调用数、快照及读次数的独立约束，不能把问题归结为大文件。`final.rejectedCaptures`
是重开后 owner 的当前计数，不是全天丢失总数；首次可见来源缺口及公开失败才是该测量的依据。

源测量
`.hpm-acceptance/context-recovery-daily-capacity-20261020-01/result.json`；沿用已封存隔离包、实际包内 Node 和 session/reader 模块运行同一画像，四份 profile 与源结果逐字段一致。`.hpm-acceptance/context-recovery-daily-capacity-package-20261020-01/milestone.json`
复核当前运行源/包与原 manifest 摘要一致，明确
`capacityShortfallConfirmed:true`、`fullGoalComplete:false`。测量脚本退出 0 仅表示负控成功执行，绝不表示全天容量通过。

因此当前只能描述为“原期限最长 24 小时，受较小容量约束”，不能宣传“已覆盖全天长任务”。首发容量是实质阻塞；后续须同步处理来源冷存储、累计调用、快照保留及分层读预算，不通过简单放大单个上限、重开清账、按连接合并或驱逐仍有效原文解决。详细实施方向已补入完整方案。未部署、改变用户配置或调用真实模型；此前 948 项客户端及 429 项包内回归仍只证明其对应功能，不证明全天容量。

## 当前阶段：v7 提交后强杀及撤销持久性（2026-10-20，完整客户端及原包范围通过）

扩展已有跨物理拥有者回归，使用真实默认加密存储，新增四个不同 PID 的路径：保存 v7 检查点并收到提交确认后，通过
`process.kill(process.pid, 'SIGKILL')`
杀死拥有者，明确跳过 SQLite/worker 正常关闭；新进程重开后正式解析检查点、重建授权并精确读回旧原文；随后第三个进程完成撤销提交后再次强杀，第四个进程重开确认原 scope 的 load 为 null、目录中无原记录。父测试检查提交确认和跳过关闭的回执、强杀子进程非零退出、正常读进程退出 0，排除超时清理冒充成功。原到期不变，存储文件不含合成原文明文。正常退出两进程路径继续保留。没有运行源变更，新增路径位于既有统一 unit/客户端测试及其 fixture。

首次摘要文件专项 **10/10**，冻结扩大
**126/126**；格式、零警告 Lint、语法、CI/发布治理以及原完整客户端命令全部退出 0，完整客户端
**948/948**，0 失败/取消/跳过。运行源及测试摘要前后一致，证据
`.hpm-acceptance/context-recovery-v7-crash-20261020-01/receipt.json`。

本次沿用上一阶段隔离包
`hpm-isolated-release-Wr2O5s`，不重复构建。实际包内 Node/模块运行更新后的测试
**429/429**，含提交后强杀和撤销后强杀；源码、包文件与 manifest SHA256
`4eb1ea482224541c14e7ccddabbb94d75dd2cb698a14a78f6745f11eef43b66f`
逐项匹配，新的测试及 fixture 摘要一致。封存
`.hpm-acceptance/context-recovery-v7-crash-package-20261020-01/milestone.json`
明确
`runtimeRebuilt:false`、`unchangedPreviouslyBuiltRuntime:true`，链接上一包 milestone 摘要。复用 runner 中的
`packagedProxyRuntimeChanged`
历史字段不作为本轮新增运行源或新包证据，以封存的实际摘要核对为准。安装版客户端前阶段资格仍对应同一未改变的包，本轮未重复其探针。

该资格仅证明 v7 **已确认提交后**
的进程强杀恢复及撤销持久性。尚未证明 v7 发布事务在确认前的所有崩溃位置、机器断电、文件系统故障、旧备份恢复的撤销水位或完整回滚流程。未部署、修改用户配置/认证或调用真实模型。实时流式/steering、全天容量及多端普通配置等原目标仍未完成。

## 当前阶段：v7 加密跨宿主与新隔离包资格（2026-10-20，范围及完整客户端门禁通过）

新增统一回归
`v7 summary survives two physical owners through real encrypted storage without extending expiry`，以及专用子进程 fixture
`test/helpers/context-recovery-v7-owner.cjs`。使用真实时间、默认 Windows
CurrentUser 密钥保护和加密 SQLite worker：一个拥有者进程保存 v7
write-ahead 检查点并正常退出，另一个不同 PID 重新打开后通过正式存储记录解析器和会话重建，沿公开 Responses 请求重新授权，逐字读回旧原文；导出期限与保存前相同，存储目录中的文件不含该合成原文明文。子进程只输出固定结果字段，失败只输出固定错误，不转发异常或原文。该测试已进入既有 Codex 摘要测试文件及统一 unit/原客户端命令。此项是正常退出后的跨物理进程重开资格，不能替代强杀、断电、跨设备或真实模型资格。

首次专项 **9/9**。最终冻结范围 **125/125**，修改的版本模块覆盖语句/行
**99.82%**、分支 **95.89%**、函数
**100%**。格式、零警告 Lint（包括新 fixture）、语法、CI/发布治理以及原命令
`npm run test:client:coverage` 全部退出 0，完整客户端
**947/947**，0 失败/取消/跳过，覆盖语句/行 **98.90%**、分支 **94.75%**、函数
**99.05%**。终态运行源和测试摘要一致，证据
`.hpm-acceptance/context-recovery-v7-host-20261020-01/receipt.json`。

新隔离包为
`C:\Users\juhon\AppData\Local\Temp\hpm-isolated-release-Wr2O5s\dist\staging\runtime`，核对
**582** 个运行源、**595** 个构建源、**116** 个锁定运行依赖。manifest SHA256
`4eb1ea482224541c14e7ccddabbb94d75dd2cb698a14a78f6745f11eef43b66f`，包内 Node
SHA256
`780f44f2c53c108bae261ada21a525b4bfe733c020ac85e41bfe94479090ac9b`。实际包内 Node 和模块回归
**428/428**，包括 v7 跨物理拥有者、旧期限/策略和原生 ACL 边界；复制测试只转换模块解析和子进程工作目录，不改断言、期限、并发或覆盖率门禁。新 fixture 也解析到包内模块，测试使用的 SDK 环境函数显式解析到包依赖。

安装版隔离 Codex 用新包实际恢复入口完成四次默认本地摘要，固定同一旧 sourceId 的四次读取逐字一致，root 保持 1；Claude 三次原生压缩、三次精确读取及四物理宿主正常退出重开通过。客户端无私有工具泄露，合成原文未在存储文件中发现明文。父进程及其 fork 使用包内 Node。资格仍限定脚本循环上游和隔离配置；Codex 原生错误项的干净资格、真实模型、官方 HTTPS 和普通安装配置尚未建立。

最终 `.hpm-acceptance/context-recovery-v7-package-20261020-01/milestone.json`
对源、构建副本、包、测试、manifest/锁/Node 摘要及两类安装客户端结果进行封存，`packageScopePassed`
和 `clientGatePassed` 为 true，`fullGoalComplete`
为 false。未部署、安装插件、修改用户配置/认证或进行真实模型请求。完整实时流式/steering、全天容量、崩溃及完整迁移/降级/回滚、多端普通配置与全仓 verify 等仍待完成。

## 当前阶段：Responses 摘要检查点版本边界（2026-10-20，当前完整客户端门禁通过）

修复此前 Codex 本地摘要窗口仍沿用 recovery-root
v6 标签的问题。`exportRecoveryRootState` 仅在已发布绑定含 Responses
summary 窗口时导出
**v7**；普通根继续导出 v6，旧格式按原有规则读取。当前读取器明确支持 v7，并拒绝把 Responses
summary 状态重新标为 v1–v6；未知版本、空/超长绑定数组和访问器均安全拒绝，访问器不执行。新增回归还确认失败不撤销当前活跃 owner 的权限，正常重开仍为 v7，原绝对到期时间不变。未引入 SQL
schema 迁移、旧记录续期或就地重写。此前未发布候选中若存在带 Responses
summary 的 v6 检查点，当前版本会拒绝，而不会猜测其版本或继承权限。

新回归先在旧源码失败（预期 v7，实际 v6），证据
`.hpm-acceptance/context-recovery-stdio-eof-20261020-02/schema-negative.log`。使用上一阶段实际隔离包的旧策略读取器（SHA256
`f91f8a021f16c50f0a6cdb45ad54c8de035cc554c5c206624ef012bd7908c651`），验证 **6**
个 v7 检查点全部被拒绝，普通 v6 检查点仍被接受；这是实际旧模块的读取边界资格，不是完整旧程序启动或回滚操作资格。最终证据
`.hpm-acceptance/context-recovery-summary-schema-20261020-03/old-reader.json`。

冻结范围 **124/124**，0 失败/取消/跳过；两个修改模块覆盖语句/行 **99.82%**、分支
**95.89%**、函数 **100%**。格式、零警告 Lint、语法、CI/发布治理及原命令
`npm run test:client:coverage` 全部退出 0，完整客户端
**946/946**，源和测试摘要前后一致。新回归位于既有 Codex 摘要测试文件，统一 unit 自动发现与原客户端命令均包含。首个 runner 的未声明 structuredClone 全局 Lint 失败保留；改用已有 JSON 数据复制方式后，第二个冻结 runner 完整通过，再补畸形输入边界后建立最终第三个 runner，完整通过，未改变门禁阈值或期限。

本次运行源码已超过上一阶段隔离包，不沿用该包 417 项及安装版客户端的资格来证明新版本行为；新包及真实加密持久化的 v7 跨宿主资格仍待建立。旧读取器拒绝新版本只是回滚保护之一，安全备份/撤销水位、降级停写、回滚操作、崩溃与恢复仍需单独验收。未部署生产、修改配置/认证、安装插件或调用真实模型。完整流式/steering、全天容量、多端及整体交付继续保持未完成。

## 当前阶段：可选 stdio 网关 EOF 修复（2026-10-20，当前完整客户端门禁通过）

使用实际 SDK
Client/StdioClientTransport 完成网关 initialize、目录发现及下游工具调用后，测试直接结束其拥有的子进程 stdin，独立等待退出，避免 SDK
`client.close()`
的两秒后强杀掩盖 EOF 缺陷。修改前网关三秒内未退出，回归失败；证据保留于
`.hpm-acceptance/context-recovery-codex-summary-package-20261020-01/stdio-eof-regression-negative.log`。这次是有效的握手后 EOF 负控，不沿用之前未完成握手的两个手工探针。

`scripts/lib/evidence-gateway-shutdown.js` 现在将 stdin
end/close、绑定时已结束/销毁的输入和 SIGINT/SIGTERM 接入同一个幂等关闭事务，并一起移除监听器。实际回归要求网关正常退出码 0、无宿主强杀，并确认下游 PID 已退出；单元边界同时覆盖重复事件、已结束输入和 dispose。新增测试位于已有
`test/evidence-gateway-runtime.test.js`，已核实统一 unit 自动发现及原完整客户端命令均包含该文件。未修改 SDK、期限、并发、覆盖率阈值或客户端配置。

首轮两文件 16/16 通过；冻结扩大范围 **38/38**
通过，关闭模块语句/分支/函数/行覆盖率均
**100%**。首个 runner 因测试变量 prefer-const 警告失败，保留
`.hpm-acceptance/context-recovery-stdio-eof-20261020-01/`，修正测试清理 PID 持有方式后建立第二个冻结 runner。最终
`.hpm-acceptance/context-recovery-stdio-eof-20261020-02/receipt.json`
确认格式、零警告 Lint、语法、CI/发布治理、范围覆盖率和原命令
`npm run test:client:coverage` 全部退出 0；完整客户端
**945/945**，0 失败/取消/跳过，覆盖语句/行 **98.90%**、分支 **94.74%**、函数
**99.05%**，运行源及测试摘要前后一致。

此前两个完整客户端超时在本轮未复现，但只确认当前冻结组合通过一次完整客户端门禁，不声称代理启动性能根因已修复，也不抹去历史失败。启动/目录发现期间的提前 EOF、非合作下游的强杀降级、跨平台与普通安装配置仍需分别验证。本次变动是仓库内可选 MCP 网关，未扩张代理包发布范围；上阶段代理隔离包资格仍仅覆盖其原有 417 项。未部署、安装插件、修改认证或调用真实模型。全仓 verify、完整实时流式/steering、容量、迁移/降级/回滚与多端真实模型验收仍未完成，整体目标保持未完成。

## 当前阶段：最新恢复源码的隔离包资格（2026-10-20，包内范围通过，完整门禁仍未通过）

已为包含异步原生 ACL 和 Codex 本地摘要修复的当前源码建立新隔离包，不再沿用 WS 身份阶段旧包。包目录
`C:\Users\juhon\AppData\Local\Temp\hpm-isolated-release-GDMBUC\dist\staging\runtime`；**582**
个运行源、**595** 个构建源与工作区匹配，**116**
个运行依赖与原锁文件匹配，发布目录治理通过。manifest SHA256
`a7ad0d47c0a43834fe8d7e7632bd6a9429f140819cda571c598bc0d81be48b05`；包内裁剪锁文件 SHA256
`762f7ba751ba65e0158313e5cf1f949327a3b3ddbd86eca94995d41ee69f55ef`；Node SHA256
`780f44f2c53c108bae261ada21a525b4bfe733c020ac85e41bfe94479090ac9b`。包内裁剪锁与项目完整锁是不同对象，不能直接比较文件摘要。首次 seal 错用了该比较并失败，修正比较对象后通过，失败记录保留；原完整锁仍通过构建副本逐字摘要校验。

使用包内 Node 和包内模块执行 **417/417**
回归，0 失败/取消/跳过。范围在上一包回归基础上加入本地摘要、异步/同步原生文件保护及重命名边界。复制的测试仅改模块解析到包目录及其子进程工作目录，不改变断言、期限或并发；复制前的源测试摘要进入回执，终态后再次核对。实际 Windows 原生助手异步保护测试执行通过。

安装版隔离 Codex 使用该包的实际 WS 恢复入口：四次默认本地摘要后 root 始终为 1，固定第一次摘要后锁定的同一 sourceId，四次私有 LIST/READ 均逐字读取摘要前原文；客户端 WS 帧和 stdout 无私有工具名，退出 0。原生 error
item 仍存在，此项不宣称干净的完整真实客户端输出资格。安装版 bare
Claude 使用包内 Node 的实际 HTTP 入口、加密 SQLite 和 CurrentUser 密钥：三次原生压缩、三次精确原文读取、两次私有历史重建，通过四个物理宿主正常退出后重开；无磁盘明文原文或客户端私有工具名泄漏，退出 0。该范围没有重做进程崩溃资格。

完整工程状态没有被包内通过覆盖：上一阶段原完整客户端
**941/943**、1 失败/1 取消的结果仍有效，15 秒代理启动和 30 秒双宿主 stdio 超时未修复。本轮增加 stdio 诊断 preload，仅记录方法阶段/时长而无参数、工具结果或 stderr 内容；带 V8
coverage 的独立原文件 **9/9**，两个 stdio connect 约 **3691/3961 ms**、close 约
**2040/2033
ms**。此时隔离包也在构建，这个单文件样本不能解释或清除完整命令中的超时。SDK 服务端没有 stdin
end 的关闭接线、当前 CLI
shutdown 只绑定信号，属于下一步待验证边界；尚未实施修复或据此认定 30 秒超时根因。

额外 EOF 探针未取得行为资格：首探针误把仅供仓库使用的可选 MCP
gateway 当作代理包内入口，因该文件未分发而在初始化前退出；第二探针改用正确仓库入口，但在原 15 秒探针初始化期限前未就绪，未实际发送 EOF。两次失败及终态保留，不是成功的 EOF 负控，也不说明应把可选 gateway 静默纳入代理包。该网关仍按
`docs/local-evidence-plugin.md`
的仓库路径提供，未安装或修改用户配置。后续需补足可靠的 EOF 生命周期回归及诊断。

证据目录
`.hpm-acceptance/context-recovery-codex-summary-package-20261020-01/`，`milestone.json`
封存包、测试和两类客户端探针；终态后重新逐项核对当前运行源、构建副本、包内源、包内 Node、裁剪锁及复制前测试摘要。`packageScopePassed:true`，`aggregateGatePassed:false`，`fullGoalComplete:false`。全程没有生产激活、共享服务重启、真实模型请求或真实认证变化；仍限隔离配置和脚本循环上游。24 小时绝对 TTL、旧到期时间不续期不变。普通配置、官方 HTTPS、IDE/Desktop/远端、全天容量、私有实时流式/steering、迁移/回滚及完整门禁仍未完成。

## 当前阶段：Codex 默认本地摘要恢复链修复（2026-10-20，范围验证通过，完整门禁未通过）

上阶段实际安装版默认本地摘要的 root 分裂现已修复到当前源码。新增独立
`context-recovery-codex-summary` 模块：只把空工具目录、auto tool
choice、无 provider previous
ID 且带已知默认摘要指令的请求识别为本地摘要；通过既有 compaction 专用索引匹配唯一已观察历史，继承原完整工具 policy 的绑定 scope。未观察或存在歧义的摘要不能创建继承权限，普通生成的完整 policy 校验不变。摘要文本本身及同一连接不提供绑定权限。

已接纳的本地摘要复用既有私有恢复 coordinator 和发布事务，产生随机摘要回执、摘要片段 SHA256 与长度；只有成功发布后的回执可选择同主体/目标/完整 policy 下的已提交分支。Responses
wire 上不能直接把该内部回执当作 provider
`previous_response_id`。摘要采用后建立新的公开窗口并丢弃旧私有映射的重放依据，同时保留祖先原文权限及原到期时间。HTTP
JSON/SSE、WS 及无原文来源的已观察摘要都进入同一发布边界；取消、撤销、未封存、非法或混合工具输出不能发布摘要回执。签名/不透明或歧义摘要输出当前失败关闭，尚未证明完整真实模型输出矩阵。没有新增固定的“恢复后再独立公开生成”请求或改变待决的实时流式方案。

新增七项回归位于
`test/context-recovery-codex-summary.test.js`，另补一项 HTTP 零来源摘要入口回归；统一 unit 自动发现，并显式加入原客户端覆盖命令。正常、空、非法、超限、getter、Unicode、回执篡改/重复、跨主体/工具 policy、到期、未发布/撤销/失败、连续摘要及序列化重开均覆盖。新增集成回归先在旧逻辑上以可见原文为 0 失败，证据
`context-recovery-codex-compaction-20261020-01/local-summary-negative.log`
保留。新模块加入发布源清单。

最终冻结证据在
`.hpm-acceptance/context-recovery-codex-summary-20261020-01/`。11 个修改文件的格式、9 个 JS 文件零警告 Lint/语法、CI/release 治理通过。扩大范围
**288/288**，0 失败/取消/跳过；七个生产模块覆盖语句/行 **96.43%**、分支
**90.46%**、函数 **95.8%**，达到原阈值。完整原客户端命令 **943**
项：**941 通过、1 失败、1 取消**，退出 **1**；覆盖语句/行 **98.83%**、分支
**94.69%**、函数
**98.84%**。两项未通过分别为双宿主实际 stdio 测试的原 30 秒超时，以及实际代理原 15 秒启动失败（仅 preload/catalog/crypto/lifecycle 已到达）；stdio 超时本轮尚未定位，不能归因于负载或宣称无关。没有延长期限、降低并发/覆盖门槛、跳过断言或无改动重跑完整失败命令。

上述门禁终态后，用同一最终源码运行安装版 Codex 的实际恢复 WS 入口（`native-proxy-v13`）：**四次默认本地摘要、root 始终为 1**；每次摘要采用后调用私有 LIST/READ，固定读取第一次摘要后锁定的同一个 sourceId，四次结果都与摘要前捕获的原文逐字相等。客户端 WS 帧和 stdout 未出现私有工具名，探针和客户端均退出
**0**。v11 首次逐字读取探针未正确处理 provider 的增量私有结果，失败保留；v12 修正脚本对 delta 的处理，v13 又固定原 sourceId，避免用内容相同的新来源冒充旧原文。该修正没有改变生产恢复逻辑。

`milestone.json` 汇总日志与回执摘要；冻结运行/构建/测试源、安装版探针及 **1426**
文件的原生检查前后摘要一致。资格仍限于隔离 HOME/config、合成认证和脚本循环上游，不包含真实模型、官方 HTTPS、普通用户配置、IDE/Desktop、磁盘进程崩溃或新发布包；原生 error
item 仍存在，不宣称干净的完整安装版验收。根状态序列化重开回归通过，但新增 Responses
summary 窗口尚未完成旧包降级/回滚资格。未启用生产、安装插件或调用真实模型。24 小时绝对 TTL 与旧记录不续期不变。完整目标仍包括启动/stdio 门禁、新包、多端及真实输出矩阵、实时流式/steering、全天容量、迁移和回滚。

## 当前阶段：安装版 Codex 默认本地摘要的恢复连续性负控（2026-10-20，未修复）

实际安装版 Codex 的隔离自定义 Responses provider 不只使用独立
`/compact`。以默认 compact prompt、10000 context
window、1000 自动压缩阈值及脚本 usage 触发时，它通过 WS 发送普通生成形状的本地摘要请求：`tools: []`、`tool_choice: auto`、没有
`previous_response_id`，input 包含默认 `CONTEXT CHECKPOINT COMPACTION` /
`handoff summary`
指令。摘要之后恢复原 9 项工具目录，并采用脚本返回的摘要窗口。这是当前安装版本及隔离配置的实测，不推论官方 HTTPS、真实模型或 IDE/Desktop 的行为。

发现过程保留在
`.hpm-acceptance/context-recovery-codex-compaction-20261020-01/`。v4 的默认摘要发现没有证明实际工具目录和结果；v5/v6 增加目录和脱敏错误分类，确认
`get_goal`
存在，观察到四个工具结果；v7 只改变合成请求的模型标签，不调用真实模型。各版本仍有原生 error
item，不能据退出 0 宣称干净验收。没有保存原生错误全文、用户内容或认证材料。上述探针不替代统一 CI。

v8 首次连接当前源码的实际 `createWebSocketProxy` /
`createContextRecoverySessions`，复现会话分裂。v9 在此基础上加入摘要请求/摘要采用的 admission 分类、root 计数及显式失败断言，并冻结前后
**1424**
个运行、构建及测试源文件摘要。四次本地压缩、四个采用摘要的后续窗口、四个无 unknown-tool 标记的工具结果，客户端进程退出
**0**；但是 admission 的 roots 从 **1 → 2 → 3 → 4**，全部已接纳请求的
`visibleSources` 为 **0**，之后五次 admission 返回
`context_recovery_quota`。因此 runner 明确退出
**1**，`discoveryPassed:true`、`recoveryContinuityPassed:false`、`fullQualificationPassed:false`。工具结果计数及无 unknown-tool 标记不证明逐字原文恢复；本轮没有这项成功证据。

权威记录为
`native-proxy-v9.json`、`native-proxy-v9.log`、`native-proxy-v9-source-snapshot.json`
和
`native-proxy-v9-receipt.json`。回执确认源文件及探针未变、子进程已终止；安装版二进制 SHA256 为
`9e7c59c05cc1ce5677b1f94e835b2ac038ca3be14504e78d558eacdb0ea3f55d`。脚本退出 1 是恢复连续性负控，不是安装客户端崩溃。循环上游、隔离 HOME/config 和合成认证；无真实模型请求、用户配置修改或生产激活。没有新包或生产代码修改，上一阶段完整客户端启动失败仍未解决。

源码边界检查解释了待修复路径：Responses 普通请求绑定完整工具 policy；既有 standalone
compaction 的省略工具专用索引只识别 tools/toolChoice 均缺失；Claude 的摘要回执延续仅适用于 Claude。此次本地摘要既改变 policy，又在下一次请求用摘要替换完整窗口，当前没有对应的已观察摘要过渡。后续必须建立窄化且可撤权的本地摘要过渡、摘要回执及持久化连续性，覆盖篡改/过期/跨主体/跨 policy/并发分叉，并在同一真实入口验证连续压缩后的逐字原文读取。不能用增大 root 配额、全局忽略工具 policy、按连接/文本相似度合并或普通生成退出 0 替代修复。

私有恢复实时流式的额外公开生成请求仍是未选定的架构取舍。用户要求更多决策材料，尚未同意增加请求或切换默认模式；本轮没有实现这项变更。新原文 24 小时绝对 TTL、旧记录不续期保持既定要求；完整流式/steering、多端矩阵、容量、迁移/回滚、启动门禁和受控激活均未完成。

## 当前阶段：异步管理凭据复用原生 ACL（2026-10-20，完整门禁未通过）

检查当前源码发现同步敏感路径已有原生 ACL 操作，异步文件保护仍固定执行 whoami/icacls 兼容链。默认 Windows 异步文件路径现复用同一现有原生助手：私有路径通过 stdin 传递，固定参数、最小系统环境、5 秒期限、128 字节输出上限、隐藏子进程；等待成功回执并复查目标 inode 后才发布缓存成功。stdin 失败终止拥有的子进程，错误统一脱敏。助手执行失败不回退兼容后端；仅默认可选助手确实缺失时保持已有兼容行为，显式文件系统/进程/SID/环境适配器保持原路径。

没有降低 ACL 标准或提前开放管理端口；原生操作仍负责目标与祖先固定、DACL 原子替换和读回验证。新增七项回归覆盖异步等待、stdin/回调/stderr 失败、固定执行参数、缺失/非法/极端/硬链接输入、替换竞态、缓存/force 失败撤销，以及实际本地助手；与异步 ACL 和凭据发布测试首次验证 18/18，进入既有统一 unit 自动发现。本地助手验证不称为新包资格。

冻结候选 `.hpm-acceptance/context-recovery-async-native-acl-20261020-01/`
已通过三文件格式、零警告 Lint、语法及 CI/release 治理。初次范围测试 172/172，函数覆盖 88.23% 低于原 90% 门禁，定位为范围清单遗漏既有文件重命名测试，两项既有函数未覆盖；此失败保留，未降低覆盖率要求。原完整客户端独立诊断 934/935，无取消/跳过，退出 1，覆盖语句/行 98.84%、分支 94.70%、函数 98.84%。唯一失败仍为原 15 秒真实代理启动，到期时模块图尚未就绪，pending 为 trae_official；第二项真实代理全部端口在 11662
ms 就绪。这不能证明完整启动修复或等条件性能改善。

首次 runner 终态之后，在逐项复核同一冻结摘要后，把既有
`secure-file-rename.test.js`
加入范围清单，补全范围 180/180，无失败、取消或跳过，覆盖语句/行 96.24%、分支 90%、函数 94.73%，原阈值全部通过。`complete-scope-receipt.json`
保留初始回执关联，未重跑同一完整客户端失败命令；运行/构建源和全部测试结束后摘要一致，combinedGatePassed 仍为 false。源码/测试冻结期间未修改实现，未延长原启动 deadline 或降低并发。

本轮没有新包或安装版资格，上阶段包的资格不沿用至这次源码。24 小时绝对 TTL、已有记录期限和完整目标保持不变，生产未启用，未修改真实认证、安装插件或发起真实模型请求。启动、私有流式/steering、多端连续压缩矩阵、全天容量及迁移/回滚继续列为未完成。

## 当前阶段：WS 双响应身份校验（2026-10-20，完整门禁未通过）

用户再次确认新原文采用 24 小时绝对 TTL；旧记录保持原到期时间，不因读取、恢复或配置更新续期。

修复 WS 事件同时含有 envelope `response_id` 与嵌套 `response.id`
时，前者掩盖后者冲突或非法值的问题。现在两个存在的字段均独立校验并与当前响应身份核对，在事件入队、公开进度和终态提交之前失败关闭。显式 null、空串、超长或非字符串身份不能被另一个合法字段掩盖；未发布分支撤销，不授予历史恢复权限。

新增连接级非法/匹配身份回归及真实 socket 冲突终态回归；已有真实流式正例同时携带匹配的双身份。旧源码负控失败，WS 文件独立验证 78/78。冻结候选
`.hpm-acceptance/context-recovery-ws-dual-identity-20261020-01/`
格式、零警告 Lint、语法、CI/release 治理通过；范围 213/214，完整客户端 934/935，均无取消或跳过。唯一失败均为原 15 秒真实代理启动期限，完整门禁仍未通过。范围覆盖语句/行 98.37%、分支 93.54%、函数 100%；结束后运行/构建源和全部测试摘要保持一致。

本次修复是响应身份边界，不代表私有恢复已支持实时流式或 steering。当前源码新隔离包匹配 581 个运行源、594 个构建源和 116 个锁定依赖，发布目录治理及源码/依赖摘要检查通过。实际包内 Node 和模块回归 386/386，无失败、取消或跳过；包含新支持模块、runtime、清除管理和 WS 身份测试。首次转换仍有初始化成本，未宣称整体提速。

同一新包的安装版隔离 Codex
0.160.1，经实际 WS 恢复入口和本地脚本上游完成混合搜索/私有 READ/外部调用及缓存失效后的自动全窗口补发：原目录保留、原文和私有历史精确、搜索回执各一次、混合顺序一致，无私有工具名泄漏。安装版 bare
Claude
2.1.292 也完成连续三次原生压缩、三次精确读取、两次私有历史重建，四个物理宿主正常退出后重开实际加密 SQLite 与 CurrentUser 密钥恢复通过，磁盘文件不包含明文原文。两项探针均退出 0，使用实际包内运行环境；仅为隔离配置/本地脚本上游/对应组合入口资格，不能外推普通完整配置、官方 HTTPS、全 core、真实模型或其他终端；本阶段没有重做强制终止资格。

证据位于同一候选目录的
`packaged-execution.json`、`native-codex-hosted-mixed-packaged.json`、`native-persistent-packaged-drained.json`。此前包的资格不沿用；完整门禁仍失败。生产未启用，未改真实认证、安装插件或发起真实模型请求。整体剩余范围仍包括启动、私有流式/steering、连续压缩客户端矩阵、全天容量、迁移和回滚。

## 当前阶段：协议转换支持按首次使用初始化（2026-10-20，完整门禁未通过）

实际启动继续卡在模块加载及管理凭据就绪之前。检查发现转换路由已有 lazy 工厂，但 handlers 在组合时仍加载 Responses 历史/语义桥接和请求校验器。新增
`lazy-conversion-support`，与既有路由延迟加载边界衔接：原生透传的组合不导入这两类支持模块；显式查看历史或首次转换调用才创建对应真实工厂，复用同一个历史 Map 与所有方法。Responses 普通转换缓存也在该工厂首次使用时读取，首次转换仍承担加载成本，不承诺模型首字延迟改善。

支持模块和工厂返回使用 own data
descriptor 校验，不执行 getter；初始化失败与递归进入终态，固定脱敏 503，不在后续请求重复创建。正常方法在初始化后保持原同步/异步返回、receiver 和异常身份，不能把业务校验异常改写为初始化失败。新增模块已加入发布源清单。

独立进程回归在旧源码上复现 eager-conversion-support 导入失败，证据
`.hpm-acceptance/context-recovery-conversion-cold-20261020-01/negative.log`。四项新支持模块测试覆盖 cold
composition、真实方法目录、共享状态与实例隔离、空/非法模块和工厂、极端参数原样转交、加载/方法异常、getter 和捕获递归异常后仍不能复活；与现有路由及 Responses 状态检查
**8/8**。新增文件和既有 cold-process 回归由统一 unit 自动发现，冻结 runner 复查发现结果；本次没有修改字面客户端测试清单，新增失败注入单测不宣称单独进入该清单。

首冻结候选停在 Lint：新增测试两处 getter 缺少 return，runner 又把 JSON 清单传给 ESLint 产生忽略警告。修复显式 return 和 JS/JSON 检查分工，未关闭规则或警告门禁；首失败回执保留。第二候选
`.hpm-acceptance/context-recovery-conversion-cold-20261020-02/`
的全部五文件格式、四 JS 文件零警告 Lint/语法、CI/release 治理通过。扩大范围
**135/136**，唯一失败仍是第一项真实代理原 15 秒启动；五模块覆盖语句/行
**98.13%**、分支 **92.63%**、函数 **100%**。handlers 导入 **65
ms**，且没有两类支持模块的加载项；模块图就绪 **13232 ms**、服务器创建 **14120
ms**，到期前管理凭据仍未就绪。这只能证明加载边界改变，不能据不同负载的样本声称整体提速。

runner 按失败停止，未自动运行完整客户端；随后在逐项复核同一冻结摘要后，首次单独运行该源码的原完整客户端命令，作为独立诊断，不覆盖扩大范围失败。该命令
**930/932**，两项实际代理启动失败，0 取消/跳过，退出 1；覆盖语句/行
**98.84%**、分支 **94.70%**、函数 **98.84%**。第一项 core **9278
ms**，到期时 runtime HTTP agents 尚在加载；第二项模块图 **13074 ms**、服务器创建
**14456 ms**，到期前管理凭据未就绪。`client-diagnostic-receipt.json`
确认运行/构建源和全部测试摘要仍一致，并保留
`overallGatePassed:false`。未无改动重跑相同失败命令。没有新包或安装版资格。

24 小时绝对 TTL、旧记录到期、读预算、原 deadline 和并发保持不变；生产服务与真实认证没有修改，未安装插件或发起真实模型请求。启动的完整工程资格仍缺失；WS 流式/steering、客户端连续压缩矩阵、容量及回滚等整体范围继续保留，不能被这些加载优化替代。

## 当前阶段：关闭状态不创建恢复会话所有者（2026-10-20，完整门禁未通过）

上阶段完整门禁的唯一启动失败仍有效，本阶段不改变 15 秒期限或并发。进一步检查发现默认 runtime 在构造时就创建 disabled 生命周期，core 在恢复关闭的每个普通请求上也读取 sessions；这要求启动先加载完整会话图。现在默认 runtime 在关闭状态仅保留配置和生命周期状态，配置启用或显式请求 sessions 才创建真实生命周期；启用配置同步开始创建，持久模式仍等待原 storage
ready 屏障。core 的注入路径不再静态导入生命周期，关闭恢复的请求不读 sessions。未引入假 session、替代权限对象或跳过已启用服务的初始化。

调用方注入 createLifecycle 的构造期严格校验不变；已有会话的禁用、切换、撤权、清理和 shutdown 保持原状态机。未分配会话时清除仍处理 inactive 存储，清除期间的新启用不能提前放行；退出或失败后不能新建所有者。首次 lifecycle 模块加载失败脱敏进入终态，不从请求重试或回退到内存恢复。

新增四项回归进入统一 unit 和既有客户端覆盖入口，覆盖真实 core 的关闭请求路径、启用后真实身份及同步禁用、无所有者清除期间的较新启用/禁用/退出/失败、未使用服务退出和首次模块加载失败。冷图回归在旧代码上失败，记录保留在
`.hpm-acceptance/context-recovery-disabled-owner-20261020-01/negative.log`；首次四文件检查
**48/48**。第一冻结范围 **119/120**，唯一失败为现有主入口 **1201 行超过 1200**
预算，未运行完整客户端。仅删除组合区一处空行，保留全部代码及原预算，单独治理与格式检查通过；此失败回执保留，不删除测试或放宽断言。

第二候选 `.hpm-acceptance/context-recovery-disabled-owner-20261020-02/`
的格式、零警告 Lint、四文件语法、CI/release 治理与扩大范围 **120/120**
通过，覆盖实际 core、WS、配置切换、清除及组合入口；runtime/lifecycle/inactive-clear 三模块覆盖语句/行
**97.52%**、分支 **92.09%**、函数 **100%**。完整客户端
**931/932**，0 取消/跳过，退出 1；覆盖语句/行 **98.84%**、分支 **94.70%**、函数
**98.84%**。完整门禁结束后运行/构建源和全部测试摘要一致。

唯一失败仍是第一项原 15 秒实际代理启动：core **8100 ms**、handlers **1309
ms**，到期时 cli-session-routing 尚在加载，未到模块图就绪。第二项 core **4678
ms**、handlers **751 ms**，全部端口 **13909 ms**
就绪。首次加载的生命周期耗时项已从 core 图消失，但不能从不同负载的单次结果推定总提速或启动问题解决。没有在相同源码失败后无改动复跑，没有重建包或沿用旧包/安装版资格；包内验证脚本只完成准备，尚未执行。后续需继续处理实际未使用转换支持模块的启动加载及完整门禁。

24 小时绝对 TTL、旧记录到期和读预算不变；未安装插件、启用生产、重启共享服务或发起真实模型请求。后续仍需包内资格、WS 流式与 steering、安装版连续压缩、容量/迁移/回滚及客户端矩阵，完整目标没有缩小。

## 当前阶段：持久化执行加载边界（2026-10-20，完整门禁未通过）

上一轮嵌套加载诊断已经结束：`.hpm-acceptance/context-recovery-nested-startup-20261020-01/receipt.json`
确认运行/构建源及测试冻结一致，格式、零警告 Lint、诊断 **6/6** 通过；完整客户端
**923/925**，两项实际代理仍超过原 15 秒期限，0 取消/跳过。覆盖语句/行
**98.83%**、分支 **94.67%**、函数 **98.83%**。第一项 core 导入 **8802
ms**，超时时 handlers/request validators 尚在加载；第二项 core **6402
ms**，模块图就绪 **12490 ms**，创建服务器 **13366
ms**，在全部端口就绪前到期。与此前一项失败的快照分别保留，不将诊断变化解释为性能改善。

嵌套计时使用精确拥有文件和固定标签，覆盖 core 与 handlers 的直接导入；不输出模块路径、参数、异常内容或用户数据。独立小范围测得 core 约 379/385
ms，不能与完整并发覆盖门禁作等条件速度比较。耗时分散，现有证据不足以认定单一模块是全部超时的根因。

检查确认内存生命周期和 runtime 的 inactive-clear 模块在组合时也会导入存储执行图。当前将 storage-opening 移到目录生命周期的已有构造事务中，将 storage 执行导入移到 inactive-clear 完成输入与现有目录/checkpoint 检查之后。无目录、空目录和内存模式不需要打开存储；有效清除仍走原 worker 的 revoke-all/inspect/close，不直接删除数据库。模块首次加载异常仍在原脱敏失败边界内，模式切换失败后旧会话保持关闭，不创建内存替代所有者。

新增三项回归进入既有统一 unit 和客户端覆盖入口：内存组合/启用/禁用/退出不加载持久化执行、保留真实 session 身份；首次打开模块失败撤销旧准入并拒绝恢复；无效/空/缺失存储不加载执行模块，真实 checkpoint 加载失败脱敏且不改文件。第一项在旧代码上失败，记录保留于
`.hpm-acceptance/context-recovery-storage-cold-20261020-01/negative.log`。五文件相关回归
**89/89** 通过。

最终冻结候选的格式、零警告 Lint、三文件语法、CI/release 治理通过；七文件范围
**95/95**，两项修改模块覆盖语句/行 **98.67%**、分支 **95.50%**、函数
**100%**。完整客户端 **927/928**，0 取消/跳过，退出 1，覆盖语句/行
**98.83%**、分支 **94.67%**、函数
**98.83%**。运行/构建源和所有测试在门禁结束后摘要一致，回执为上述候选目录的
`receipt.json`。唯一失败仍是第一项原 15 秒实际代理启动：core 导入 **11392
ms**，超时时 runtime HTTP agents 尚在加载；第二项 core **6667 ms**，全部端口
**13904 ms**
就绪。不同运行的加载时间有明显波动，不能从失败数量变化推定性能改善。本轮未证明完整启动修复，没有重建或沿用旧包/安装版资格到当前源码。

新原文 **24 小时绝对 TTL**、旧记录原到期、读预算、原 15 秒/150
ms/30 秒检查及并发均不变；未安装插件、启用生产、重启服务或发起真实模型请求。完整落地目标继续执行。

目标：完整落地
`context-recovery-multi-client-plan.md`，包括免手动 token 的接入、统一内部恢复、持久化、WebSocket 和实际客户端验收。当前目标仍在执行，以下里程碑不代表整体完成。

## 当前阶段：HTTP 恢复执行模块冷加载（2026-10-20，完整门禁未通过）

真实完整客户端门禁中的 15 秒启动超时仍未解决。本轮仅把 HTTP 私有 runner、进度解析、dispatch、client-wire 和 hosted-output 五个执行模块移出启动加载图；普通 provider 资格、授权、观察和会话初始化保留原边界。dispatch 在合格请求的准备事务内加载，runner 与输出编码在已接管的 execute 事务内加载；模块缺失或损坏仍归入原来的脱敏 502、未发布分支 abort 和清理流程，不能回退普通转发。编码加载失败发生在上游已完成之后时保留轮数与 usage。

两项新增回归在旧源码上均失败，初次修复后 HTTP entry **13/13**
通过。冷启动回归在独立子进程阻止这五个执行模块加载，再组合实际 core
handler；首次加载失败覆盖 dispatch/runner/编码，校验不合格输入不触发加载、不发布、不重试、脱敏结果及监听器清理。随后加强 usage 保留与下一次正常请求不被失败污染的断言，已进入当前冻结验证。测试仍在统一 unit 自动发现和现有字面客户端覆盖入口内。

实际 core handler 与 API evidence socket 路由 **3/3**
通过。隔离无覆盖率的单样本 core 导入图从 **191 模块降至 186 模块**，耗时 **649
ms → 1033
ms**；不能声称启动加快，不能将模块数下降当成完整启动超时修复。没有延长期限或降低测试并发。第一候选
`.hpm-acceptance/context-recovery-http-cold-20261020-01/`
的格式/Lint/语法/治理、范围 **368/368** 通过，覆盖语句/行 **97.82%**、分支
**92.37%**、函数 **97.15%**；扩大 **506/507**，实际加密 worker 的原 150 ms
idle 观察未取得 ACK。runner 据原顺序停止，未运行完整客户端门禁；失败与全部未变摘要保留。

该失败的诊断显示观察开始前已有定时回调在执行，原探针仅允许“回调开始时已观察中”确认，不能区分旧回调是否随后读到了新时钟并完成清理。新增时钟耦合探针：仅在实际 sweep 事务读取观察中的时钟且成功返回后，才允许定时回调完成确认；读取时先检查观察状态，再读时钟，再核对状态。普通命令、未读时钟、陈旧时钟和失败事务不能 ACK；确认后后续定时数据库工作仍暂停，独立只读连接检查物理删除。保留旧四字节通用回调探针，实际时钟探针另使用八字节控制，均有严格形状校验。

新增确定性竞态回归在旧探针上失败，修正后 HTTP/idle 两文件
**25/25**，实际物理删除、活记录、重开和失效写回继续通过。这里是测试确认机制修正，未改生产清理代码，未延长原 150
ms 断言、30 秒用例期限或降低并发；既有失败不能因此改记通过，也未证明所有并发时序已修复。

随后补充时钟读取先后约束，第二候选
`.hpm-acceptance/context-recovery-http-cold-20261020-02/` 范围 **369/369**，扩大
**507/508**，idle 物理删除与重开通过；唯一失败为新增 core 冷加载子进程超过原 10 秒期限，约 10574
ms 退出。原 15 秒真实服务启动用例并未运行，不能写成其已修复。为使模块依赖回归直接验证变更边界，改用当前进程里重新加载实际 core 与 HTTP
entry，并断言 HTTP
entry 是新模块实例；在 finally 中恢复加载器和原缓存，保留同一禁加载断言与 10 秒测试期限。注入一条启动 eager
runner require 后，新测试仍失败，`isolated-module-negative.log`
保留，不能将缓存命中当成通过。新测试不再证明独立进程冷启动速度；原完整客户端的实际 15 秒启动检查不变。

第三候选 `.hpm-acceptance/context-recovery-http-cold-20261020-03/`
的格式、零警告 Lint、语法、CI/release 治理及范围 **369/369**、扩大 **508/508**
通过，0 失败/取消/跳过；范围覆盖语句/行 **97.82%**、分支 **92.37%**、函数
**97.15%**。运行/构建源码和全部测试摘要在门禁结束后保持冻结一致。完整客户端
**925 项中 924 通过、1 失败**，0 取消/跳过，退出 1；完整覆盖语句/行
**98.83%**、分支 **94.67%**、函数 **98.83%**。仍为第一项真实代理约 15381
ms 启动超时，core 导入约 9233 ms、deadline 时 handlers 尚未结束。第二项约 14785
ms 才完成所有端口监听，本轮通过但余量小；idle、密钥和新增回归通过，不能据此撤销历史间歇失败。没有放宽原门禁。

最终冻结源码的安装版 Codex 混合搜索、私有原文及缓存失效自动补发探针再次通过，退出 0、公开目录保留、原文/私有 payload/搜索回执精确且各一次、原混合顺序一致、无私有工具名泄漏。实际 WS 恢复入口及 loopback 脚本上游的适用范围不变。

新隔离发布包位于
`C:\Users\juhon\AppData\Local\Temp\hpm-isolated-release-ZK8Ubh\dist\staging\runtime`，匹配
**580 个运行源、593 个构建源、116 个锁定依赖**，目录治理及源/锁摘要一致。实际包内 Node/模块的相关回归
**344/344**，0 失败/取消/跳过。包内 Codex 探针再次通过上述精确原文、混合搜索位置和自动完整窗口补发断言；包内 bare
Claude 经
**3 次实际原生压缩、3 次精确原文读回、2 次私有片段恰好一次重建、4 个物理宿主正常退出重开**，实际加密 SQLite 与 CurrentUser 密钥被新进程打开，全部发布 outcome、退出 ACK 和进程退出成功，最终 root
1，无私有工具名泄漏。本次沿用已修正的探针，等待所有已接管请求的发布 outcome 后再退出，未修改运行期限或生产代码凑绿。检查专用留存目录没有完整合成原文的明文字节，不代表所有片段或整个数据库的安全审计。

以上安装版验收均为独立 HOME/配置、拥有的合成文件、合成凭据和 loopback 脚本上游，分别走实际 WS 恢复入口和 HTTP
entry/observer 组合，不代表全 core/生产 HTTPS、真实模型、普通完整目录、IDE/Desktop/远程组合或本候选强制终止宿主资格。当前最终回执
`final-milestone.json`
绑定冻结源、测试、包、原失败与负对照、原生探针和文档；上一阶段资格不静默沿用。

新原文仍为 24 小时绝对 TTL，旧记录不续期。生产未启用，完整目标未完成。

## 此前阶段：Responses 搜索与私有读取混合轮的位置重建（2026-10-20，完整门禁未通过）

此前 `web_search_call`
与私有 LIST/READ 同轮会在读取前拒绝。本轮增加私有历史中的公开输出位置引用：仅保留公开项的输出索引和精确内容摘要，公开搜索回执、文本、函数/custom 调用本体仍由客户端窗口提供。提交时核对实际公开输出，重建时先验证完整公开窗口，再按引用恢复原始混合输出顺序并消费对应公开位置一次；不把搜索内容静默藏进私有 tail，也不复制另一份公开正文。内部确认请求仍剔除尚待客户端执行的外部调用；保存给历史映射的序列单独保留完整原始输出，再接已完成的私有结果。代理不执行外部工具或搜索，不新增原文选择器。

历史映射增加严格
`format:3`，保存位置引用；无引用的数据继续导出原 format。新读取器保留 format
1/2 兼容，旧读取器不认识新格式时拒绝，不能将旧包资格沿用到新数据或降级后继续写入。输入引用的正常/空/非法/极端/访问器、重复历史与公开位置、私有工具伪装、提交内容篡改、跨协议、旧格式降级伪装和 restore 均有回归。签名/不透明混合输出仍在读取前拒绝；私有确认阶段新出现 hosted/外部工具继续拒绝。24 小时绝对 TTL、旧记录期限、既有读预算与发布事务不变。

当前专项四文件 **118/118**
通过。覆盖 HTTP 式确认和 WS 延迟结果两种模式、搜索在输出前/中/后、普通函数及 namespace
custom 混合调用、同 root 精确原文、两类公共窗口的链式位置重建，以及完整 root 导出/恢复。一个初始测试缺少 policy 的 system:null，另一个未调用实际发布 finish
ACK，均修正测试组合后通过，没有放宽发布保护。

安装版 codex-cli
0.160.1、隔离 HOME/忽略用户配置、本地脚本上游与实际 WS 代理入口的初次探针已通过：保留 function/namespace/web_search 原目录，搜索回执 + 私有 READ + 外部 get_goal 同轮后，原文精确读回；一次固定缓存失效后，原生客户端自动补发完整公开窗口，四项私有 payload 摘要一致且各一次，搜索回执摘要一致且一次，原始混合输出位置顺序一致。2 个连接、1 次错误、5 个脚本生成请求、客户端退出 0、无私有工具名泄漏。该探针不调用真实模型，不代表 core/生产 HTTPS、普通完整配置、IDE/Desktop 或所有搜索形态。最终冻结源码须独立重验，初次探针不替代最终回执。

冻结候选范围 **366/366**、扩大回归 **505/505**
通过，0 失败/取消/跳过；范围覆盖语句/行 **97.81%**、分支 **92.37%**、函数
**97.15%**。格式、零警告 Lint、语法及 CI/release 治理通过；门禁结束后全部运行/构建源及测试摘要未变。完整客户端
**922 项中 920 通过、2 失败**，0 取消/跳过，退出 1；完整覆盖语句/行
**98.83%**、分支 **94.67%**、函数
**98.83%**。两项仍为原 15 秒真实代理启动超时：第一项 core 导入约 9722
ms，deadline 时 diagnostics 尚未结束；第二项约 12624 ms 完成模块图，约 13235
ms 创建服务器，尚未监听就到期。本次密钥兼容用例通过，不能据此撤销此前实际 DPAPI 失败。没有延长期限、降低并发或重复执行未变失败。

最终冻结源码另经安装版 Codex 重验，`native-codex-hosted-mixed-final.json`
的精确原文、完整公开窗口自动补发、四项私有 payload 各一次、搜索回执各一次和混合输出顺序全部通过；保留原工具目录，客户端退出 0，无私有工具名泄漏。适用范围仍为隔离 HOME、本地脚本上游和实际 WS 恢复入口，不代表整个 core/生产 HTTPS 或真实模型资格。

新隔离发布包匹配
**580 个运行源、593 个构建源、116 个锁定依赖**，目录治理和源摘要一致；位于
`C:\Users\juhon\AppData\Local\Temp\hpm-isolated-release-iVjx4G\dist\staging\runtime`，未安装或启用。包内 Node 和实际包内模块的相关回归
**341/341**
通过，0 失败/取消/跳过。另以包内 Node、全部包内恢复模块及 ws 依赖重跑安装版隔离 Codex，`native-codex-hosted-mixed-packaged.json`
的精确原文、自动完整窗口补发、私有/搜索各一次与混合位置顺序均通过，客户端退出 0，无私有工具名泄漏。本次没有沿用旧包的正常退出或强制终止 Claude 宿主资格，也未宣称当前包完成该项重验。

候选和证据目录
`.hpm-acceptance/context-recovery-hosted-mixed-20261020-01/`，最终回执
`final-milestone.json`
绑定冻结源、测试、包、原失败日志、原生客户端结果和文档。新原文 24 小时绝对 TTL，旧记录原到期不变。生产未启用，整体目标未完成。

## 此前阶段：密钥分阶段诊断与包内宿主强制终止恢复（2026-10-19，完整门禁未通过）

本轮运行源码未改变，仅为已有 Windows
native/旧 DPAPI 兼容测试增加固定后端标签、耗时和有限错误码诊断，不输出执行参数、stdin、stdout、stderr 或原始异常。原 10 秒子进程、30 秒测试期限及整套并发不变。增加观测后执行一次完整诊断门禁：**918 项中 917 通过、1 失败、0 取消/跳过**，退出 1；完整覆盖语句/行
**98.83%**、分支 **94.68%**、函数 **98.83%**。四步 native protect 158
ms、旧 PowerShell unprotect 3480 ms、旧 PowerShell protect 3164 ms、native
unprotect 421
ms 均成功；不能据此证明此前密钥失败已修复，原失败仍有效。第一项真实代理仍约 15371
ms 启动超时，core 导入约 9078
ms，deadline 时 handlers 尚未结束。新增最小隔离环境的无覆盖率冷加载单样本为 190 模块、约 659
ms，仅作为定位差异的证据，不作为优化收益或单一根因结论。未提高期限、降低并发或盲目复跑。

`native-persistent-packaged-crash.json`
经上阶段摘要一致的新包、包内 Node 和实际模块，使用安装版 bare
Claude、隔离 HOME、完整三工具目录、合成凭据及本地脚本上游。在
**3 次真实原生压缩边界后的已提交发布 ACK 之后**，不调用旧宿主 shutdown，直接终止进程；4 个不同 PID 的宿主顺序重开实际加密 SQLite 和 CurrentUser 密钥。三次精确原文 LIST/READ、两次私有 payload 恰好一次重建、同 root/最终 7 快照全部通过；前三个进程确认 SIGTERM，末个宿主正常 ACK/退出，全部已接管请求 outcome 成功，客户端退出 0、无私有工具名泄漏。这证明进程强制终止后的已提交数据恢复，不代表断电、写入中断、实际 HTTPS/core、真实模型或普通完整配置验收；探针不触碰共享服务。

证据与回执位于
`.hpm-acceptance/context-recovery-startup-profile-20261019-01/`。本轮没有重建包：运行源未变，仅测试诊断与独立探针有增量，包来源绑定见回执。新原文仍为 24 小时绝对 TTL，旧记录不续期；完整门禁和多端目标仍未完成，生产未启用。

## 此前阶段：Claude 原生摘要回执与新窗口接续（2026-10-19，完整门禁未通过）

已接入免插件的 Claude 原生总结回执：仅在当前请求已绑定父快照、符合安装版原生总结请求形态、且最终响应为无签名/不透明字段的单个纯文本块时，私有 runner 在摘要内部追加随机回执。回执包含 24 字节随机值、摘要精确摘要值与字符长度，复用现有已发布 response-key 索引；不新增按 session/root 自报标签查询的路径。客户端带回完整摘要片段时仍须满足当前主体、路由、完整策略、已提交父节点、原 root 期限和撤权核验。仅持有相似文字、摘要 hash 或 metadata 不够；没有成功发布的随机回执不能选择旧记录。Claude 外部
`previous_response_id`
字段拒绝，只有严格解析的摘要回执可形成内部续接键。后续完整窗口使用其新观察锚点，不让残留旧回执覆盖更新的后代。

这是有明确协议痕迹的自动适配：回执位于总结文本，可能出现在 verbose/stream-json 输出；它不是“原始协议零变化”的支持声明。普通响应 observer 仍逐字节保真，不签发或修改回执；签名 thinking、多块响应、未知 envelope/块字段、歧义 summary 标签、空摘要和超出响应字节预算的形态不做注记。没有修改用户配置或安装插件。为解决本次实际 checksum 变化，协议准入和 runner 的策略比较只对首个完整纯文本 billing 块中已知 CLI/sdk-cli 格式的三位窗口校验后缀作相等投影；客户端版本、entrypoint、其他 system 块及所有未知字段继续显著，实际上游 system 不改写。

新 `summary`
窗口种类标记“保留同 root 的已授权原文，但不把旧私有对话插入摘要窗口”。增加导入验证以拒绝非 Claude、无父节点、无父 response-key、无锚点或非法计数的 summary 窗口；新的私有 map 从此窗口独立开始。初次二次重建测试发现旧 map 父关联不适用于摘要重置，修正后验证两次完整 root 导出/重建，旧私有 LIST 不插回，新私有 LIST/READ 能重建，原文与绝对到期不变。仍使用现有 root/binding/history
schema 与严格枚举，旧读取器不认识新窗口种类时拒绝，不把它推断为普通全窗口。

专项 4 项包含正常/Unicode/空/非法/极端/访问器/签名/失败路径、回执轮换、发布前不可读、篡改、主体/路由/策略隔离、撤权、到期、withdraw 和二次重建。首轮撤权用例错误使用自造 principal，修正为协议实际派生主体后通过；门禁规则未放宽。测试已加入字面客户端覆盖命令与统一 unit 自动发现，新模块加入 release
manifest。

安装版 Claude 2.1.292、独立配置 bare 模式的本地脚本端到端已完成
**1 次真实 compact_boundary
→ 回执自动带回 → 同 root 续接 → 私有 LIST/READ 各一次、精确 Unicode 原文 → 后续 native
Read 结果上的四项私有 payload 各一次重建**，根数 1、快照 4、客户端退出 0、原生三项目录完整保留、未见私有工具名泄漏。证据
`.hpm-acceptance/context-recovery-claude-compaction-20261019-01/native-recovery-after.json`。首个安装版尝试因原生总结指令有 379 字符前导而未签发，保留失败；匹配仅用于注记、并不授权，支持该前导后通过。一次失败探针的脚本在注入缺失时仍发送私有调用，导致该隔离探针的客户端看到私有名；后续脚本在缺失时先终止诊断，此失败未被删除或当成生产安全验收。源码门禁最终候选还须独立复验。

当前冻结候选
`.hpm-acceptance/context-recovery-claude-receipt-20261019-01/`，范围
**362/362**、扩大 **501/501**，0 失败/取消/跳过；范围覆盖语句/行
**97.76%**、分支 **92.29%**、函数
**97.08%**。格式、零警告 Lint、语法及 CI/release 治理通过，运行源和全部测试摘要在门禁后复查未变。完整客户端
**918 项中 915 通过、3 失败**，0 取消/跳过：两项仍为原 15 秒真实代理启动超时，另一项为实际 native
helper 与旧 DPAPI 包装兼容测试中的密钥保护不可用。前者的第二项约 14957
ms 才完成模块图；后者错误已经脱敏，现有证据尚不能证明它仅由负载造成。未延长期限、降低并发或盲目复跑。完整覆盖语句/行
**98.83%**、分支 **94.68%**、函数 **98.83%**；日志 SHA-256
`0509382823d75d10a32c85a9c7b7fdfc40bbcc7315554cc6f7523141e3c21245`，完整门禁退出 1。

最终源码另经安装版 bare Claude 重验：`native-recovery-final.json`
一次压缩通过；`native-three.json` 连续
**3 次实际 compact_boundary、3 次精确原文 LIST/READ、2 次完整私有片段恰好一次重建**通过，原生三项目录不变、root
1、快照 7、客户端退出 0、无私有工具名泄漏。`native-persistent.json`
使用相同 13 次有界脚本上游交互，但把实际恢复入口放进
**4 个不同 PID 的顺序宿主进程**；每次原生摘要后正常退出旧宿主，实际 SQLite
worker、CurrentUser 密钥保护及加密文件由新宿主重新打开，再由当前请求重新核验绑定。三次压缩和精确读回、两次私有历史重建全部通过，4 次关闭 ACK/退出均成功，最终 root
1/快照 7。关闭后检查留存目录文件均不含该合成原文的完整明文字节。这证明本探针的正常进程退出后恢复，不代表崩溃恢复、全部内容无任何明文片段或整个数据库的安全审计。

当前新隔离包匹配
**579 个运行源、592 个构建源、116 个锁定依赖**，目录治理及摘要一致；位于
`C:\Users\juhon\AppData\Local\Temp\hpm-isolated-release-lFaC5O\dist\staging\runtime`，未安装或启用。使用包内 Node 和实际包内模块的回归
**337/337**，0 失败/取消/跳过。`native-persistent-packaged-drained.json`
再经包内 Node、入口和存储模块完成三次实际原生压缩、四个物理宿主、三次精确读回及两次私有历史重建，全部发布 outcome、关闭 ACK 与宿主退出成功。原
`native-persistent-packaged.json`
的客户端虽退出 0，末次 outcome 为 502：验收脚本在最终持久化发布 ACK 前发起了 shutdown；该记录保留且不计为通过。修正脚本先等待全部已接管请求的 outcome，再关闭宿主，并加强每轮成功断言；没有修改运行源码、期限或并发凑绿。最终回执为本目录
`final-milestone.json`，绑定冻结源、测试、原失败与新成功证据、文档和包。

上述安装版验收均使用隔离配置、bare 三工具目录、合成凭据、拥有的合成文件和 loopback 脚本上游；直接组合实际恢复入口，未走整个 core/生产 HTTPS 资格，也未调用真实模型。不能外推普通完整配置、IDE/Desktop/远程宿主或所有上游。此前包资格不沿用。新原文 24 小时绝对 TTL，已有到期不变。生产未启用，整体目标未完成。

## 此前阶段：Claude 原生压缩前的 assistant 缓存锚点兼容（2026-10-19，整体未完成）

在安装版 Claude 2.1.292 的真实客户端压缩边界探针上接入源码
`beginContextRecoveryRequest`
与实际响应 observer 后，发现压缩总结请求已在进入新摘要窗口之前失去绑定：Claude 会给此前观察到的 assistant
`tool_use` 添加 ephemeral
`cache_control`。旧投影只处理 user 块；前后普通策略摘要一致、首条用户输入投影相等，但 assistant 输出仅该缓存字段发生变化，导致第二次请求误建 root、无法捕获并继承该次原生 Read 结果。

现把**assistant tool_use**
上经过严格验证的 ephemeral 缓存元数据纳入既有相等比较投影。仍仅用于绑定和私有 history
map 的哈希比较；不改发给客户端或上游的消息、工具参数或目录。assistant 文本、thinking/redacted_thinking、未知块类型、签名及其他字段不参与此项忽略；不扩展 assistant 字符串/数组等价。缓存类型、ttl、未知字段、实际调用 ID/名字/参数变化、角色变化和协议变化继续隔离。旧持久状态未写入的新指纹不能反向制造匹配权限。

两个回归在旧实现上均失败，修复后通过；新增绑定回归覆盖缓存添加/删除、5m/1h、非法/空缓存、内容/角色/协议变化、导出重开、未知字段和不执行 getter，现有会话回归增加 assistant 缓存迁移并验证私有读回/历史重建与公开 payload 保真。四个相关 CI 文件冻结验证
**97/97**，变更身份模块行/语句、分支、函数覆盖率全部
**100%**；格式、零警告 Lint、语法、CI/release 治理通过，源码/测试摘要未变。回执
`.hpm-acceptance/context-recovery-claude-compaction-20261019-01/receipt.json`；这些测试已经位于统一 unit 和客户端覆盖入口，没有新增旁路测试入口。

安装版原生 compaction 诊断的前后证据位于
`.hpm-acceptance/context-recovery-startup-20261019-01/claude-compaction-binding-{before,diagnostic,after}.json`。相同受控场景下，第二次准入
**isolated_request / 0 条可见原文 → observed_continuation /
1 条可见原文**，roots
**3→2**，三次 observer 发布均成功，客户端实际发出 1 次 compact_boundary。第三次压缩后请求仍为隔离窗口、可见原文 0，整个恢复目标断言仍退出
**1**，失败没有被局部修复改写成通过。此探针直接组合源码准入和响应观察，不是全 core 路由、私有 runner 恢复、跨进程物理存储或真实模型资格；仅 bare 的三项原生工具、拥有的合成文件、本地脚本 SSE、独立 HOME/配置与合成凭据，没有用户配置变更。

后续结构诊断确认第三次请求的 `.system.0.text` 是客户端 billing header，差异位于
`cc_version`
的三位校验后缀；仅在诊断内替换该后缀后三次摘要相同。生产代码**没有**忽略或重写这个字段，不能把诊断投影当成准入规则，也不能据此推断所有 system 差异均为无害元数据。压缩后旧工具锚点消失的问题仍需独立可信过渡；相同 metadata、摘要文字或自报 session
ID 不足以授权。

本轮按变更风险只运行相关冻结范围，没有重复上轮仍有两项启动失败的完整客户端门禁，也未建立新隔离包资格。下节的 357/357、496/496、911/913 属于上一份冻结源码，不能沿用为当前源的完整资格。新原文 24 小时绝对期限、旧记录原到期、撤权和 reader 预算不变，生产未启用，整体目标继续执行。

## 此前阶段：恢复冷加载与存储初始化故障定位（2026-10-19，整体未完成）

此前回合完成 Claude 缓存元数据兼容、两个安装版的本地脚本原文读回与重建；完整客户端仍有两项 15 秒启动失败，包内首次 storage
owner 初始化另有一次安全失败。上述失败没有被这次独立诊断覆盖为通过。

对 core 导入树的独立剖析显示 193 个模块、约 754.7
ms；在完整并发覆盖门禁中，先前 core 导入约 7–11 秒。恢复会话现仅在完成历史/策略/继承结果检查、真正执行 recovery 时加载 coordinator，不再在禁用 owner、普通观察、精确 reader 或导出路径提前加载生成状态机。冷模块因果回归旧实现
**0/4**、新实现 **4/4**；新增首次加载异常验证安全失败且不消耗 reader 预算，合计
**5/5**。独立 core 模块数 **193→190**，后样本约 783.1
ms，**未显示实际加速，不能宣称启动问题已修复**。

对上轮实际隔离包的独立阶段诊断只使用 fixtureKey 和新合成目录，首次 owner 本次成功，四项 ACL 操作约 99–184
ms，总初始化约 766
ms。它没有复现原始失败，不是重跑原门禁，也不足以证明原失败由系统负载、ACL 超时或 SQLite 引起。新增固定阶段
`paths_started`、`ownership_started`、`key_write_started/finished`、`database_prepare_started/prepared`，使失败可定位到路径、锁、密钥写入或数据库打开之前；仅发出静态阶段和耗时，所有原有期限、消息验证、失败关闭、身份及文件/链接检查保留。首次 owner 的原 CI 用例使用相同观察协议报告阶段，测试的操作和断言不变；观察者异常仍不能改变 owner 结果，新增阶段不授予 worker
readiness，也不能重置原 deadline。

专项会话/存储
**49/49**，首次诊断扩展曾发现旧的阶段预期未更新（48/49）；增加精确阶段序列预期后通过，旧日志保留。冻结目录
`.hpm-acceptance/context-recovery-startup-20261019-02/`
已结束，源码与测试摘要未变；范围 **357/357**、扩大
**496/496**，格式、零警告 Lint、语法及 CI/release 治理通过。范围覆盖率行/语句
**97.64%**、分支 **91.95%**、函数 **97.02%**。

完整客户端 **913 项，911 通过、2 失败、0 取消/跳过**，退出 1；覆盖率行/语句
**98.8%**、分支 **94.59%**、函数 **98.82%**，不能替代失败的测试。失败仍为
`context-api-evidence-routes.test.js` 两项原定 15 秒启动门禁：首次
`no_stdout`、core 导入约 10918 ms、support 尚未返回；第二次
`no_stdout`、module_graph_ready 14501 ms、composition_ready 14993
ms、websocket 尚未返回。未更改期限、并发或断言，未重跑相同失败候选。完整日志 SHA256
`04e823718e81ad443ea68ed7c75011f95978165b48b8ad8f0bbe88a56dba81b9`；回执
`receipt.json`
保留全部结果。未创建此源版本的新隔离包，上一轮包和宿主资格仅属于上一轮源，不能沿用为当前候选发布资格。生产未启用，新原文 24 小时绝对期限与旧记录到期均未改变；整体未完成。

### Claude 原生压缩边界诊断（尚未接通压缩后原文恢复）

冻结门禁结束后，使用相同安装版 Claude、独立 HOME/配置、合成 key、本地 Messages
SSE 脚本上游、拥有的合成 Read 文件和
`--autocompact 100k`，不接代理恢复。首次探针只在 message_start 报高用量，未触发压缩，不能计为成功。第二版在 message_delta 同样提供合成 input/cache 用量并使用 stream-json 观察事件，得到
**1 次
`system/compact_boundary`**；三个请求依次为原用户输入、含原工具调用/结果的总结请求、仅含合成摘要的新窗口，消息数
**1→3→1**。第三版独立采样再次得到一次边界，补充仅摘要和结构的诊断：metadata（仅 user_id）摘要三次相同，context_management 摘要三次相同，工具目录三次相同；旧工具调用在第三次请求消失。metadata 相同不是授权证明，不能凭 session
selector、摘要词命中或相同目录直接继承原文权限。

证据在
`.hpm-acceptance/context-recovery-startup-20261019-01/claude-compaction-shape{,-v2,-v3}.json`，不保存原客户端输出、请求消息或凭据。这证明安装版在本地脚本用量下确实进行了客户端压缩，不证明真实模型、整个代理入口、压缩后绑定、跨进程恢复或普通完整工具配置已经合格。下一步须建立“已授权旧窗口→已观察总结响应→新窗口”的可信过渡并覆盖伪造、重复摘要、并发分叉、过期/撤权和持久重开；无法建立唯一过渡时继续拒绝继承。

## 此前阶段：Claude 安装版缓存标记兼容及原文精确读回（2026-10-19，整体未完成）

Claude Code **2.1.292**
的独立 HOME/配置、`--bare`、无会话落盘、无用户插件/MCP 配置探针，保留该模式原生提供的 3 项工具目录，已通过本地脚本 Messages
SSE 上游执行两次拥有的合成文件 Read。它不是普通完整配置/IDE/Desktop 目录资格，不应把 bare 模式的目录数量当成常规客户端全目录。未读取真实凭据、未发真实模型请求、未变更用户配置或生产。

安装版实际恢复探针发现两项连续的身份缺口：首轮单个 user text block 含 ephemeral
cache_control，下一轮变为同文字符串；随后旧 tool_result 的缓存标记又移动到新结果。首轮普通调用观察成功，但旧实现均按原始 JSON 指纹匹配，分别造成全新隔离分支，或误匹配更早祖先、丢失已提交私有片段。安全结构诊断仅保存路径、摘要、类型与数量，不落原始客户端 stdout/stderr/消息内容；失败回执保留。

新增独立 Claude 身份投影，仅在**绑定和私有历史映射的相等比较**中，把 user 单个纯 text
block 与字符串视为同文，忽略 user
text/tool_result 上经过精确校验的 ephemeral 缓存元数据（ttl 缺省、5m、1h）。多块内容不拼接；未知字段、非法缓存策略、签名、实际文本/结果、角色和协议仍有区别。不会把 tool_result 的数组内容转成字符串，不修改上游公开历史、工具目录、签名/opaque 块、root
TTL 或现有记录期限。旧持久指纹无法匹配时保守不授予继承权限。绑定、导出/恢复、映射重建与客户端上游字节保真回归进入既有 unit/client
CI 文件，新模块纳入 release manifest。

安装版源码探针已验证：原目录保持一致，私有 LIST/READ 各一次、原文完全一致；提交后第二次真实客户端只读结果触发续接，上游四项私有调用/结果逐项摘要一致且各出现一次，两个原生 Read 调用/结果无重复，3 个快照，客户端退出 0 且未见私有标记。其实际入口为
`tryHandleContextRecoveryHttp`、observer、session 和真实 loopback HTTP
transport，供应方 HTTPS/官方认证资格在探针组合层明确绕开，生产供应方策略未放宽；未经过整个 core 路由，更不代表真实模型、原生 compaction、跨进程存储或生产验收。

因果测试在旧实现明确失败于 isolated_request，修复后通过。首个冻结 `-02/`
在 Lint 发现测试 getter-return 后停止，未绕过规则；补显式拒绝且验证 getter 未执行后，新冻结
`-03/` 格式、零警告 Lint、语法、CI/release 治理通过，范围
**356/356**，后续扩大/完整门禁及隔离包结果以下方最终回执为准。安装版及诊断证据在
`.hpm-acceptance/context-recovery-claude-client-20261019-01/`。用户再次确认首发新原文
**24 小时绝对 TTL**，已有期限不延长，整体仍未完成。

最终冻结范围 **356/356**、扩大 **495/495**。范围覆盖语句/行 **97.56%**、分支
**91.93%**、函数 **96.95%**；完整客户端
**912 项中 910 通过、2 失败、0 取消/跳过**，测试执行约 83.8 秒、退出 1，两项仍为原 15 秒隔离代理启动期限，分别 no_stdout 与 servers_created 后未就绪。原 150
ms idle 断言通过。完整覆盖语句/行 **98.78%**、分支 **94.58%**、函数
**98.82%**。冻结运行源和全部测试摘要未变；完整日志 SHA-256 为
`d2508e79cc82a245e6ddca4fc0eeeb3de698dd290630463cf56de64072c0ff30`。未放宽期限、并发或安全规则，也未重跑未改动失败凑绿；完整门禁仍未通过。

新隔离包匹配
**578 个运行源、591 个构建源、116 个锁定依赖**，目录治理与摘要通过，路径
`C:\Users\juhon\AppData\Local\Temp\hpm-isolated-release-XeSW7q\dist\staging\runtime`，未安装或启用。包内实际 Node/模块回归
**320 项中 319 通过、1 失败、0 取消/跳过**，退出 1：`storage owner has an exclusive lifetime lock, persists a fixture key and detects key changes`
在首次 createStorageOwner 抛固定
`context_recovery_storage_unavailable`。该用例使用 fixtureKey，不是真实 OS 密钥保护验收；具体初始化失败阶段尚未定位，不能断言是环境抖动，也未重跑未改动失败凑绿。因此包的完整资格仍为失败，独立宿主探针不升级该结论。

独立安装版 Claude 再经这个包的实际 HTTP
entry/observer/session/transport 验证：原生 bare 目录保持一致，LIST/READ 各一次、原文精确、4 项已提交私有 payload 精确重建且各一次，两次原生 Read 调用/结果各一次，3 个快照、退出 0、无私有标记泄漏。安装版 Codex 使用同一包的实际 WS 模块仍验证原目录、精确 READ、一次安全 cache
miss、2 连接和公开 7→完整 11 项重建，4 项私有 payload 逐项一致，退出 0。两种客户端均为隔离 loopback 脚本上游；Claude 未走整个 core 路由，也没有原生 compaction 或跨进程持久存储资格。冻结、失败门禁、包与两个宿主探针由
`.hpm-acceptance/context-recovery-claude-client-20261019-03/final-milestone.json`
分别记录，整体完成标志仍为 false。

## 此前阶段：原生工具目录与空 warmup 准入、安装版私有原文读取（2026-10-19，整体未完成）

本轮修复两个独立前置缺口，不能只依据客户端退出 0 判断恢复成功。恢复 turn 原先仅接纳平面 function；新增工具目录模块按
`(namespace, name)` 精确索引 function/custom，保留原目录和 opaque
schema，不 flatten 或改名。命名空间、子工具和响应调用均检查私有名称冲突、重复身份、类型不符与伪装；custom 输入按原始文本保留，只把外部调用交还客户端，代理没有外部 executor。支持已准入 web_search/preview 的独立 terminal 输出，校验搜索 action 并原样保留 hosted
metadata；JSON 与重建 SSE 均保留 custom namespace/input 和正确 custom 输入事件。

**同一上游响应混合 hosted 搜索结果与私有读取仍不支持**：在任何私有读取执行前失败，避免把搜索结果悄悄隐藏、重复发布或破坏重建顺序。它需要独立的公开输出位置契约，不能将本轮目录准入宣称为所有工具组合完整兼容。签名/opaque 混合轮次、私有流式与 steering 等原有退出条件继续保留。

安装版第一次探针在工具修复后仍然
`privateTools:false`。仅在独立探针进程增加安全状态诊断后确认：前两次准入均为
`context_binding_previous_unavailable`，最后完整窗口才建零来源 root，未执行恢复 coordinator。原因是 Codex 的首次生成引用空
`generate:false` warmup ID，而代理没有对此 ID 创建恢复快照。官方
[WS 文档](https://developers.openai.com/api/docs/guides/websocket-mode)明确 warmup 无模型输出、可返回供续接的 ID；非空预填也合法，因此不能把所有 warmup 都当成空历史。

新增连接私有 warmup 模块，仅记住成功投递、completed、input/output 均为空、没有真实祖先的 warmup。凭据主体与目标由连接 pin，记录额外绑定 lane、模型及指令/tools/tool_choice 策略摘要，单次使用、最多 33
lane、60 秒到期；更改策略、跨连接/lane、到期、时钟倒退、非空预填、带祖先或有输出均不能借此准入。匹配时仅移除**本地准入副本**的空前驱，实际发给供应方的 previous_response_id 和目录保持不变，不创建空恢复快照，不保存 warmup 用户内容，也不修改 24 小时 root 到期策略。

新增 warmup 快照断言在旧路径失败；工具目录及 client
wire 新回归在旧路径 5 项中 4 项失败，日志保留。修复后的三文件组合
**140/140**，包括真实双 socket：空 warmup
→ 观察客户端工具调用 → 捕获精确 UTF-8 原文 → 私有 LIST/READ
→ 完整 hosted 搜索与 namespaced
custom 输出发布；客户端未见私有调用或结果。还覆盖 reserved
namespace 伪装、歧义同名、错误类型、malformed/超限目录、custom
opaque/空输入、非法搜索 action/URL、lane/策略/连接/到期/时钟和 getter 边界。新增测试进入既有 unit/client
CI 文件，新增三个模块纳入 release manifest。

Windows 安装版 codex-cli **0.160.1**
在独立 HOME、原生未删减的 function/namespace/web_search 目录及实际 WS 代理路径，已观察私有工具注入、一次 LIST、一次 READ、原文摘要完全一致、一次固定安全 cache
miss、两个 WS 连接和客户端自动完整窗口补发，退出 0、无私有标记泄漏。该探针的私有读取后紧接缓存失败，其未提交分支不能作为已提交私有片段重建证据；后续独立探针须验证提交之后再失效。所有上游均为 127.0.0.1 脚本服务，准入策略明确注入 loopback 测试适配，无真实模型或认证请求、无用户配置改动，不能等同官方登录、原生 compaction 或生产资格。因果及宿主证据在
`.hpm-acceptance/context-recovery-native-tools-20261019-01/`。

后续更强的独立安装版探针已验证**先提交私有片段，再缓存失效**：私有 LIST/READ 完成后发布第二个客户端只读调用，收到其结果后才返回一次固定 cache
miss。客户端新连接主动补发 7 项公开窗口，代理按位置插入此前已提交的 4 项私有调用/结果，上游收到 11 项；两次外部调用和结果、LIST/READ 调用和结果各恰好一次，原公开前缀精确一致，原工具目录摘要在每轮保持一致，最终 3 个快照、退出 0。此探针未关闭重开存储、未触发原生 compaction，仍是脚本上游资格；其数量校验也不能替代包内更强的逐项私有 payload 摘要核验。证据为
`codex-ws-private-committed-events-source.json`。

首个冻结目录 `-02/`
仅格式阶段发现新增 mixed 测试的格式问题后停止，日志未覆盖。完成格式修正后重新冻结
`-03/`；范围 **354/354**、扩大 **493/493**，覆盖语句/行 **97.49%**、分支
**91.76%**、函数
**96.91%**，格式、零警告 Lint、语法和 CI/release 治理通过，冻结源与全部测试摘要未变。完整客户端
**910 项中 908 通过、2 失败、0 取消/跳过**，退出 1，约 68.8 秒；均为原 15 秒隔离代理启动超时 no_stdout。第一项 core 导入约 9968
ms、runtime_http_agents 尚未结束；第二项 14448 ms 才 module_graph_ready。原 150
ms idle 断言通过，期限和并发未放宽、未重复运行未改动失败凑绿。完整覆盖语句/行
**98.78%**、分支 **94.56%**、函数 **98.82%**，完整日志 SHA-256 为
`42fa94e0f0d5c17782ee92e3a7d3ae6923053d796ea14cde3cb15eeb2d1f86c7`。包内资格以本目录独立回执为准，不沿用此前包资格。新原文仍为用户确认的 24 小时绝对 TTL，旧记录不续期；整体未完成、生产未启用。

最终隔离包匹配
**577 个运行源、590 个构建源、116 个锁定依赖**，摘要、锁定依赖和目录治理一致。包内实际 Node/模块回归
**291/291**，0 失败/取消/跳过，包括新目录/输出、空 warmup、真实 socket 和原 idle 断言；未执行包内真实 core
HTTP socket。包路径为
`C:\Users\juhon\AppData\Local\Temp\hpm-isolated-release-rK7clw\dist\staging\runtime`，未安装或启用。安装版 Codex 再经此包实际 WS 模块验证先提交后失效的路径，原目录保持不变、原文 READ 精确、2 连接、1 固定安全错误、7→11 项重建、两次外部调用/结果均各一次，客户端无私有标记，退出 0。此包探针额外对重建后的 LIST 调用、LIST 结果、READ 调用、READ 结果逐项比较提交前的完整 payload 摘要，**4 项完全一致**；客户端结果也不是 unknown-tool 错误。`packaged-execution.json`、`codex-ws-private-committed-packaged.json`、`final-milestone.json`
关联冻结源、测试、日志、文档和实际包，整体完成标志仍为 false。

## 此前阶段：安装版 Codex 的受控 WS 回退与 stream 控制兼容（2026-10-19，整体未完成）

用户确认新原文首发保留
**24 小时绝对 TTL**，沿用现有版本化实现；已有记录保留原到期时间，读取、重启和迁移均不续期。生产尚未启用本候选。

已使用 Windows 安装版 codex-cli
**0.160.1**，在独立临时 HOME/CODEX_HOME、空工作目录、忽略用户配置和规则、ephemeral/read-only 模式下，连接只监听 127.0.0.1 的脚本上游。使用合成入口和上游凭据，未读取真实认证、未调用付费模型、未执行 shell 或子代理工具，也未修改用户配置。该脚本上游不是模型，验收不代表官方登录、真实模型或生产资格。

原生 Codex 的 WS warmup 和生成帧都携带
`stream:true`，旧解析器在首个上游生成请求之前拒绝。这轮只允许字段缺省或精确布尔 true，并移除该冗余 HTTP 控制后发送 WS 上游；false、null、数字、字符串、数组、对象和 background 仍拒绝。新增真实双 socket 回归保留 function、namespace 和 web_search 目录。最初 fixture 曾用 Buffer 误发二进制帧，其失败不作为因果证据；修正后的文本帧测试在摘要核验过的旧包 wire 模块上失败、新模块上通过，见
`stream-legacy-text-before.log` 与 `stream-fixture-fixed.log`。

安装版 Codex 已分别在直连脚本上游与实际 `createWebSocketProxy`
路径验证：一次 warmup、三次生成请求、一次固定 cache
miss、两个 WS 连接，原生客户端清除 previous_response_id 后自动补发完整公开窗口。原始前缀精确一致，外部调用和结果各一次，固定错误投递一次且不含私有错误标记，客户端退出 0。实际代理探针明确注入仅供 loopback 的供应方准入策略，不能冒充生产 HTTPS 供应方资格。源探针证据在
`.hpm-acceptance/context-recovery-native-client-20261019-01/`。

**原文私有恢复仍有明确缺口**：安装版实际目录含 namespace 和 web_search，当前恢复 turn 仅接纳平面 function。探针每次
`privateTools:false`，因此上述成功证明原生完整窗口回退和普通代理兼容，不证明安装版自动读取原文。下一步必须保留真实工具目录，补 namespace 的函数/custom 身份、保留私有名称冲突检查，以及 hosted
web_search_call 输出契约；不能删工具或关闭搜索来取得无感兼容结论。Claude Code
**2.1.292** 目前仍只检查版本和 help，未完成实际恢复验收。

本候选冻结范围 **311/311**、扩大
**484/484**，格式、零警告 Lint、语法和 CI/release 治理通过；源与全部测试摘要未变。完整客户端
**901 项中 899 通过、2 失败、0 取消/跳过**，约 69.4 秒，退出 1。两个失败均为原 15 秒隔离代理启动超时：一项 no_stdout、core 导入约 9999
ms、尚有 runtime_http_agents 导入未结束；另一项接近期限才创建 servers。idle 原 150
ms 断言通过。未放宽期限或并发，未重复运行未改动失败凑绿。范围覆盖语句/行
**97.27%**、分支 **92.02%**、函数 **96.59%**；完整覆盖语句/行 **98.77%**、分支
**94.54%**、函数 **98.8%**。完整日志 SHA-256 为
`2aa129e50156d7bdb7fc11bc74ab9f9f075952b9246635125f184c852d8d73b7`，冻结回执在
`.hpm-acceptance/context-recovery-native-client-20261019-02/`。当前隔离包及其安装客户端探针资格见该目录的独立回执，不沿用旧包资格。

最终隔离包匹配
**574 个运行源、587 个构建源、116 个锁定依赖**，源与依赖摘要、目录治理一致。包内实际 Node/模块回归
**248/248**，0 失败/取消/跳过，包含本轮 stream 控制、存储及原 150 ms
idle 断言；未执行包内真实 core HTTP
socket。使用此包实际 WS 代理模块再次驱动安装版 Codex，确认相同的两个连接、一次固定安全错误、完整前缀及调用/结果各一次、退出 0；仍是 loopback 准入策略注入，且全部请求
`privateTools:false`。包目录为
`C:\Users\juhon\AppData\Local\Temp\hpm-isolated-release-AK24UW\dist\staging\runtime`，未安装或启用。`packaged-execution.json`、`codex-ws-proxy-packaged.json`
和 `final-milestone.json`
分别记录包内回归、受控宿主探针和冻结摘要；整体完成标志仍为 false。

## 此前阶段：空闲清理耗时定位与无效写入消除（2026-10-19，整体未完成）

本轮保留原 150 ms idle 观察断言、25
ms 测试加速周期、15 秒代理启动期限、默认测试并发和全部安全断言。先增加仅测试使用的共享计数诊断，确认失败时定时器已经触发：观察开始前的 sweep 仍在执行，150
ms 后下一轮也已开始但未完成，回调近期耗时约 112–116
ms。进一步诊断区分 SQLite 引擎与外围验证：引擎约 2–20
ms，主要耗时在重复的同步文件检查，不能把原失败归为未启动或随机跳过。

生产改动有两处。认证时钟与已持久水位相等时，不再重加密并 UPDATE 相同 header，从而避免只读命令和空 sweep 无意义的 FULL 同步写盘；仍逐次认证 header、校验 schema、验证并清理到期行，时间前进仍写入，时间倒退仍拒绝。新增回归在原实现确认 inspect/load/catalog/scan/sweep 五次无效 UPDATE，并覆盖时间前进、准确到期删除、空 sweep、倒退和损坏 header 拒绝。单独消除写盘后 idle 仍失败，原日志保留，不将这项优化单独称为根因修复。

文件 inventory 现复用本轮已校验的文件 stat，在读前与读后仍核对 exact
inode、大小、硬链接数和 pinned
digest，整轮前后仍逐一核验全部祖先身份；独立 read 也保留自身前后祖先验证。不缓存跨轮可信状态、不关闭检查、不改变权限或配额。本地探针对 10 次 inventory 的 lstat 从 360 次减少为 180 次，测得总时长约 273.6→97.2
ms；这是本机探针而非生产吞吐承诺。新增文件丢失、同内容换 inode、读中新增硬链接和读后替换目录的拒绝回归；Windows 打开子文件时可能拒绝目录重命名，因此目录攻击发生在真实 close 后、整轮最终检查前，不能用操作系统拒绝替代应用边界验收。

因果证据保留在 .hpm-acceptance/context-recovery-idle-causality-20261019-01/：诊断前后的失败、无效写入回归原失败、阶段探针与最终专项
**68/68**
均保留。只有诊断改动的完整客户端仍为 895/898，证明不是靠新增观测取绿。源码冻结后的最终候选范围
**310/310**、扩大
**483/483**，格式、零警告 Lint、语法与 CI/release 治理通过；冻结运行源和所有测试摘要未变。

最终完整客户端
**900 项中 899 通过、1 失败、0 取消/跳过**，退出 1，约 61.9 秒。idle 保留原断言且通过，诊断 observation=2，最近 sweep
54 ms、最大 63
ms；范围与扩大回归也通过同一原断言。剩余失败为真实隔离代理未在原 15 秒期限启动（no_stdout），诊断 core 导入约 9671
ms，期限结束时仍有 lazy_protocol_handlers 导入未结束。另一 direct-upload 启动用例本次通过，但没有独立的启动根因修复，不宣称该类启动问题已解决。未重复运行未改动失败凑绿。

范围覆盖语句/行 **97.27%**、分支 **92.01%**、函数 **96.59%**；完整覆盖语句/行
**98.77%**、分支 **94.54%**、函数
**98.8%**。最终完整日志 SHA-256 为 f804ff38f77b9553de582bcfc646dfbe54163e894ccef5067bf9fbb45c52ac2b。证据位于 .hpm-acceptance/context-recovery-idle-optimization-20261019-01/。最终隔离包匹配
**574 个运行源、587 个构建源和 116 个锁定依赖**，源码/依赖摘要和目录治理一致。实际包内 Node/模块回归
**247/247**，包含本轮 SQLite、maintenance、文件替换边界和原 150 ms
idle 观察，后者 observation=2；同时执行此前 WS/HTTP
dispatch/entry、WBIPC、绑定及片段重建回归。包内未执行真实 core HTTP
socket，未安装或启用。包目录为
`C:\Users\juhon\AppData\Local\Temp\hpm-isolated-release-V6Optb\dist\staging\runtime`；receipt、packaged-execution 和 final-milestone 关联最终冻结源、测试、日志、文档和因果证据。

已以只读 --version 确认当前 Windows 命令入口为 codex-cli **0.160.1** 与 Claude
Code **2.1.292**，没有改配置或发模型请求；已保存实际 CLI
help：Codex 支持 --ignore-user-config/--ephemeral，Claude 提供 bare 模式并说明认证要求，后续可用于隔离本地上游验收；本轮没有发起生成。版本和选项存在不证明自动完整窗口回退或恢复已生效。当前持久化格式、24 小时新记录期限、旧记录原到期、预算和恢复协议均不变。仍待启动根因修复、安装宿主自动回退、私有 WS 流式/steering、完整并发、全天容量及全仓发布门禁；生产未激活，整体未完成。

## 此前阶段：缓存失效安全投影与有界客户端完整窗口回退（2026-10-19，整体未完成）

新增独立 cache-miss 边界，只接纳有真实 previous_response_id、严格 UTF-8、有界 JSON、明确 type/code/param 的 previous_response_not_found。HTTP 限于原生 Responses 的 400
application/json；WS 还核对 lane、单一错误事件、总事件数及 wire/event 一致性，已经有进度的响应不冒充纯缓存失效。分类只记布尔结果，不保留或转出供应方原始消息、私有 ID 或输入。

未发布分支先完成 abort
ACK，且当前授权和连接仍有效后，HTTP 返回固定 400/no-store，WS 返回固定 lane 错误并保持连接。清理失败、撤权、关闭、取消及发送失败不发布可恢复错误；未知私有错误仍按既有安全失败路径处理。代理不自动重放模型请求、旧响应或任何外部工具。HTTP
200 SSE 内承载的 cache miss 尚未接入此新增分类，不能据此声称所有上游形态兼容。

真实双 WS 连接回归中，一个有界合成客户端收到固定错误后只补发一次完整公开窗口；私有调用及结果精确插回一次，外部结果保持原样，另一独立 lane 可继续完成。另有真实本地 HTTP
socket 验证 400 传输及错误码、状态、协议、编码、前驱缺失拒绝；WS
capability 回归验证等待清理 ACK、清理失败、撤权、关闭和投递失败。这些是受控测试客户端，不能代替已安装 Codex/Claude 的自动回退验收，也不证明同 root 的并发 fork 已合格。

初始 WS 与 HTTP
entry 回归在原实现失败，证据保留于 .hpm-acceptance/context-recovery-cache-miss-20261019-01/。补充测试曾因 fixture 没有真实准入 session 而被取消，已改为明确的受控 session
capability；其失败日志保留，不计通过。首个冻结候选仅格式通过，因测试 Node
globals 的 Lint 声明失败而停止，证据保留在 -02/；修正为 globalThis 后另建 -03/，没有覆盖原记录。

最终冻结候选范围 **242/242**、扩大
**415/415**，格式、零警告 Lint、语法和 CI/release 治理通过；运行源与全部测试摘要未变。范围覆盖语句/行
**97%**、分支 **91.91%**、函数 **96.16%**。完整客户端
**898 项中 895 通过、3 失败、0 取消/跳过**，退出 1，约 68.8 秒：两项真实隔离代理在原 15 秒启动期限失败，分别为 no_stdout 与 stdout_seen；加密 idle
worker 在原 150 ms 观察等待后状态为 1 而非 2。完整覆盖语句/行 **98.76%**、分支
**94.52%**、函数
**98.8%**。原期限、并发和失败断言未放宽，不重复运行未改动失败以凑绿色。完整日志 SHA-256 为 3d88a7a6978d05fe681bd5a0bb8f3330e7055377599a3cbb49a9237762a35014。

最终隔离包匹配
**574 个运行源、587 个构建源和 116 个锁定依赖**，源码与依赖摘要及目录治理一致。使用实际包内 Node/模块执行 WS、HTTP
dispatch/entry、WBIPC、binding、root-state 和 history map 回归
**179/179**，含真实双 WS 连接、真实本地上游 HTTP
socket 和独立加密 worker 重开；未执行包内真实 core HTTP
socket 或安装版宿主，不扩大资格。包目录为
`C:\Users\juhon\AppData\Local\Temp\hpm-isolated-release-aNPmrz\dist\staging\runtime`，未安装或启用。`-03/receipt.json`、`packaged-execution.json`
与 `final-milestone.json`
关联冻结源、测试、日志、隔离包和文档摘要。新原文仍按用户选择保留
**24 小时绝对 TTL**，旧记录保留原到期，读取、重启与迁移不续期。容量、实际宿主自动补发、私有 WS 流式/steering、完整并发与发布门禁仍待完成。没有安装插件、共享服务重启、生产激活或真实模型请求；整体目标未完成。

## 此前阶段：私有增量片段与完整公开窗口重建（2026-10-19，整体未完成）

上一阶段仅修复累计公开绑定，Responses 的 previous-response-ID 轮次仍跳过私有 history
tail。本轮复用原有 history
map 的 prepare/commit、撤权、配额与加密 checkpoint，保存精确私有调用/结果以及累计公开窗口的指纹和位置。公开用户/system 输入不另存副本；公开与 continuity 指纹使用相同 canonical 编码。完整窗口续接时核验每段的请求及已发布指纹、位置和分支链，再按原位置插入；同连接 ID 续接仍依赖已验证的上游祖先，不重复插入旧片段。

混合内部读取与外部工具的 pending 结果已经在私有片段中时，full-history 路径要求原调用与精确结果各一次，客户端原始历史不得含该私有 call
ID，不再追加第二份。纯私有多轮保留允许的 opaque
reasoning；外部调用仍交还客户端，不执行或重放。原 4 MiB history
map、每段 1024 项、公开 16384 项、输出 128 项、root/调用及传输预算不扩大，旧 30 分钟和新 24 小时到期不变。

新 root 统一导出 schema **6**，每个快照持久保存
`privateHistoryComplete`。带累计片段的 history 使用 format **2**；binding
format 仍为 2，history/binding 的 version 仍只表示 TTL。旧 Responses schema
1–5 无法证明是否缺少曾经发生的私有轮次，因此导入后完整性为未知，不能因新增一个片段变成完整；该状态跨导出重开保持，完整窗口生成受控拒绝。旧 Chat/Claude 仍按既有完整历史契约恢复。经过已验证的原生 compaction 后，私有映射与完整性在新窗口重新开始，旧片段不插入新窗口。

新增回归在修改前确认：完整窗口 pending 续接拒绝；首个实现还会把缺少旧私有轮次的历史当作可重建。两项原失败均保留。最终候选涵盖连续私有增量、精确 Unicode/opaque 数据、位置/指纹/账本/版本/分支状态篡改拒绝、旧完整性不升级及 compaction 重置。实际 Windows 加密 worker 关闭、重开所有 owner 后可精确重建；两条真实 WS 连接验证新连接主动提供完整公开窗口时只插回一次，公开事件无私有工具。这个测试没有模拟原生客户端自动 cache-miss 回退。

首个冻结候选范围 **206/206**、扩大 **379/379**；完整客户端
**886 项中 884 通过、2 失败、0 取消/跳过**，退出 1，原启动期限和 idle 观察失败保留。其后新增完整性回归在该候选源码失败，补强后的范围
**95/95**、完整性/compaction 重置专项通过；最终冻结结果见下段，不沿用首个结果。证据在
`.hpm-acceptance/context-recovery-private-window-20261019-01/`、`-02/`、`-03/`。`-01`
的首个冻结工具因已有 lint 日志而在写入新日志前终止，未据此声称完成验证；后续使用独立目录。

补强后的最终冻结候选专项 **207/207**、扩大
**380/380**，范围格式、零警告 Lint、语法、CI/release 治理通过。完整客户端
**887 项中 885 通过、2 失败、0 取消/跳过**，退出 1，耗时约 66.6 秒；一项隔离代理未在原 15 秒期限启动（no_stdout），一项 idle
sweep 在原 150
ms 观察等待后状态为 1 而非 2。原期限、并发、失败断言未放宽；运行源与所有测试的冻结摘要不变，不将首个候选或单跑结果合并为完整通过。

专项覆盖语句/行 **96.95%**、分支 **91.37%**、函数 **95.88%**；完整覆盖语句/行
**98.76%**、分支 **94.48%**、函数 **98.78%**。完整日志 SHA-256 为
`251646cddffe31116d925972835d2955e3aebc7e263e6df227d6c4274135e035`。新 public-window 模块纳入显式客户端覆盖统计，新增回归均进入既有 unit 和客户端入口；覆盖达标不代替完整门禁通过。

最终隔离包匹配
**573 个运行源、586 个构建源及 116 个锁定依赖**，目录治理和源码摘要一致；实际包内 Node/模块执行 WS、HTTP
entry、WBIPC、binding、root-state 和 history map 回归
**144/144**。包内包含真实双 WS 连接和独立的真实加密 worker 重开测试，但未执行真实 core
HTTP socket 用例或原生客户端，不扩大声称整机链路合格。目录为
`C:\Users\juhon\AppData\Local\Temp\hpm-isolated-release-zRkZUH\dist\staging\runtime`，未安装或启用。`-03/receipt.json`、`packaged-execution.json`、`final-milestone.json`
关联冻结源码、测试、日志和文档摘要。

本轮重新获取的
[OpenAI WebSocket Mode](https://developers.openai.com/api/docs/guides/websocket-mode)
明确：连接缓存失效、`store=false`/ZDR 或 `previous_response_not_found`
时，客户端清除 previous response
ID 并发送该 lane 的完整上下文；可关联的错误按 stream 返回，其他 lane 可继续。文档与来源摘要保存在
`-03/official-websocket-{mode.md,source.json}`。这只是公开 API 契约，不能证明官方登录端点或当前安装的 Codex/Claude 已自动执行；下一步按该边界实现固定安全错误投影并验收宿主回退。

仍未完成：cache
miss 的安全错误/公开 ID 投影与宿主自动完整窗口回退、私有 WS 流式进度和 steering、所有 HTTP/WS 并发 pending 形态、全天容量及实际安装宿主/真实模型验收。新格式回滚必须保留存储并禁用恢复，或走独立验证的清理流程；不得删字段伪造旧格式。尚未激活生产、安装插件、重启共享代理或调用真实模型，整体目标保持未完成。

## 此前阶段：累计公开窗口绑定与旧期限迁移（2026-10-19，整体未完成）

已验证 response
ID 的增量现在接到父快照已发布的累计公开指纹，完整当前窗口可重新选择最新分支，包含磁盘状态导出和重新导入后的原文视图。携带完整窗口与 ID 的请求不重复拼接；原生 compaction 重新开始窗口。新增独立 window 模块只保存 full/delta/compaction/unavailable 标记及有界位置，不保留新的用户原文。请求局部 count/bytes 契约保持原样，累计位置单独存储。

新导出统一为 root schema **5**、binding format **2**；binding
version 仍仅表示旧 30 分钟或新 24 小时期限。旧 schema
1–4 可导入，缺失的窗口完整性保持 unavailable，不通过迁移推断完整；已有记录绝不续期。新增旧 schema
3/4 的 24 小时边界测试验证精确原文、升级、续接及到期拒绝；加上原 30 分钟回归，持久化专项
**29/29**。该补充发生在下述完整冻结之后，只改测试，未重复运行未改动的完整失败门禁。

修改前累计窗口回归失败；冻结范围专项 **187/187**、扩大回归
**360/360**，格式、零警告 Lint、语法及 CI/release 治理通过。完整客户端
**878 项中 877 通过、1 失败、0 取消/跳过**，退出 1；失败是既有 idle
worker 在原 150
ms 观察等待后状态仍为 1 而非 2。此前代理启动失败本次未出现，不据此认定根因已修复。运行源与全部测试的冻结摘要未变；随后仅补上述两项旧 24 小时格式测试，单独格式/Lint 通过。

专项覆盖语句/行 **96.62%**、分支 **90.84%**、函数 **94.97%**；完整覆盖语句/行
**98.79%**、分支 **94.48%**、函数 **98.77%**。完整日志 SHA-256 为
`627b0fab385924637cdd6dcf54e71a42b0714f02b02424dfc62558cc218ebcd2`，原失败仍保留。证据在
`.hpm-acceptance/context-recovery-cumulative-window-20261019-01/` 与
`-02/`；首个冻结候选的 Lint 失败也保留，不合并为通过。

本轮新隔离包匹配
**572 个运行源、585 个构建源和 116 个锁定依赖**，目录治理、锁定依赖和运行源摘要一致性通过。实际包内 Node 与模块运行 WS、HTTP
entry、WBIPC、binding 和 root-state 回归
**126/126**，包含本轮累计窗口及旧 24 小时格式迁移测试；仅重定向生产模块/依赖导入，保留原断言与期限。目录为
`C:\Users\juhon\AppData\Local\Temp\hpm-isolated-release-shEqqp\dist\staging\runtime`，包内未执行真实 core
HTTP socket 用例，不能扩大资格。`packaged-execution.json` 与
`final-milestone.json` 关联最终源码、测试、日志及文档摘要；完整客户端仍未通过。

此增量只完成方案 8.3.1 的绑定基础。server-continuation 的私有片段尚未按累计位置保存并重建，full-history
pending 仍明确拒绝；cache
miss 自动回退、私有 WS 事件投影、公开/内部 ID 映射与 steering 仍未接通。新格式不能被旧构建读取；回滚应保留存储并禁用恢复，或走单独验证的清理流程，不能删除字段伪造兼容。安装版、真实模型、全天容量和生产激活均未验收，整体目标仍未完成。

## 此前阶段：接纳失败不回落转发与 WS 接纳调度（2026-10-19，整体未完成）

在上一阶段持久 pending 结果基础上，发现恢复接纳返回 busy、存储不可用或绑定改变时，普通 HTTP 和 WS 会继续进入原始转发；HTTP 内部恢复准备失败也返回“未处理”。这可能向上游发送缺少内部结果的续接。本轮增加独立、仅检查数据 descriptor 的 rejection 分类模块，核心入口只组合固定错误响应。已知存储、授权状态、绑定冲突及并发失败在普通 HTTP 入口返回固定 503，尚未执行上游请求；WS 沿现有安全失败契约关闭连接，不转发不完整请求。目前这仍会终止同连接其他流，不代表已交付逐流恢复错误协议。

HTTP 已接纳会话的内部准备失败、能力调用/dispatch 构造异常或 observer 接管失败，现在进入受控错误与 abort 清理，不再返回旧 handler 重试。只有三个明确的不支持控制/工具/工具名碰撞错误可在接管前走原有允许路径。畸形或不支持的原始请求、缺少身份、未知上游 previous
response 和新 root 配额仍保留原策略，未把所有接纳失败都描述为恢复成功。WBIPC 三协议复用相同发布器，没有启动旧循环、原生传输或外部工具重放。

直接拒绝 busy 的初版暴露了单连接 16 个同时响应与 loader
8 项接纳队列的差异；现仅串行执行同连接的接纳步骤，排队仍包含在原有 16 在途/32 请求和字节预算内，loader 原上限不变。完成接纳后模型响应可并行；关闭、撤权或超时后排队接纳不再执行。不串行整个模型响应，也未放宽任何期限、并发或原失败断言。

新回归在旧模块上确认：WS 向上游发出不完整请求；HTTP entry 允许回落；真实 core
HTTP 返回 200 而非拒绝；WBIPC 旧发布器也允许回落。当前受控回归通过，验证固定无内容错误、上游零请求、abort、观察器/监听器清理、排队取消、并行模型响应及原 16 流上限。scope
**139/139**，扩大 HTTP/WS/会话/真实 core/WBIPC 回归
**312/312**。新增用例均在既有 unit 和显式客户端测试入口。

首个冻结候选客户端
**872 项中 867 通过、5 失败、0 取消/跳过**，退出 1；两项代理启动、idle
sweep 观察，以及两个 WBIPC 资格测试桩失败。后两个测试桩用无 code 的 `{ok:false}`
作为旧提前退出哨兵，缺少 HTTP 发布器接口；现将“明确不支持控制项”的资格哨兵标明真实错误码，同时新增三个 WBIPC 协议的真实 EventEmitter 发布失败测试，不关闭规则或跳过失败。生产源码保持首个冻结候选不变，最终冻结结果见下方后续记录。

最终冻结完整客户端
**873 项中 871 通过、2 失败、0 取消/跳过**，退出 1，测试耗时约 66.7 秒。剩余一项隔离代理启动在原 15 秒期限失败（preload/lifecycle 已加载，尚无 stdout），一项 idle
worker 在原 150
ms 观察等待后仍为 sweep 握手状态 1 而非 2。另一启动用例本次通过，不据此关闭其历史间歇问题。最终范围格式、零警告 Lint、语法、CI/release 治理通过；运行源和全部测试摘要未变。scope 覆盖语句/行 95.52%、分支 88.67%、函数 93.50%；完整覆盖语句/行 98.79%、分支 94.42%、函数 98.76%。覆盖达标不代替完整门禁通过。完整日志 SHA-256 为
`4feb4b4cd114004366404e0bfefdfd2cdb2049c62ca1de5877fd8d8dec141652`。

新隔离包匹配
**571 个运行源、584 个构建源、116 个锁定依赖**，运行源摘要未变，目录治理通过。使用实际包内 Node/运行模块执行同一 WS、HTTP
entry 与 WBIPC 三组回归
**77/77**，只重定向生产模块/依赖导入并复制测试专用转换 fixture，保留原期限和断言。真实 core
HTTP 入口回归在工作区扩大/完整测试中执行，此次包内 77 项没有执行该 core
socket 用例，不能扩大声称包内真实 core 入口合格。隔离目录为
`C:\Users\juhon\AppData\Local\Temp\hpm-isolated-release-oCPhbu\dist\staging\runtime`；包与测试摘要在
`isolated-package.log`、`packaged-execution.json`、`final-milestone.json`
关联。此包未安装或启用，完整客户端门禁仍未通过。

证据在 `.hpm-acceptance/context-recovery-admission-boundary-20261019-01/` 与
`-02/`；前者保留旧源、修改前失败、首轮完整日志和回执，后者封存补强后的最终候选。整体仍未完成；下一项核心实现为方案 8.3.1 的跨连接累计窗口及私有片段重建。已知失败拒绝的回归不等于所有 HTTP/WS 并发 pending 状态均已验收。未改共享运行配置、安装版宿主或生产，未发真实模型请求。

## 此前阶段：混合工具的内部读回结果持久续接（2026-10-19，整体未完成）

用户选定新原文留存 24 小时，已有记录保持原到期时间。此前混合内部读回与外部工具调用的 pending 结果只在 WS 连接内保存，连接关闭后丢失；现在将已完成的内部只读结果绑定到获准接纳的父快照，通过既有加密 checkpoint 保存。新连接只能读取已完成发布、当前 owner 获准的父快照结果；未完成发布、撤权、到期、跨 owner、重复 call
ID 或不支持的续接形态均拒绝。会话层在 verified previous response
ID 的 delta 前拼接一次内部结果，WS 不再重复拼接；不执行外部工具，也不重新执行内部读取。

新增独立 pending-results 校验模块，仅接受最多 16 项有界 function_call_output 数据，每 root 累计 pending
payload 上限 2 MiB。携带 pending 结果的导出使用 root schema
4，保留发布 readiness；不携带结果时保持原 schema 2/3。schema
4 按 binding 版本保留旧 30 分钟或新 24 小时绝对期限，读取、重启与迁移均不续期。旧构建不能读取 schema
4；回滚必须保留存储并禁用恢复，或执行另经验证的清理流程，不能通过删除 pending 字段伪造兼容。

首个冻结候选专项 121/121、扩大回归 271/271；完整客户端 866 项中 862 通过、3 失败、1 取消。随后补强 schema 校验时发现直接调用校验函数可触发嵌套数组 getter；受控回归修改前失败，现通过 descriptor 检查拒绝 getter、自定义属性和稀疏数组，不执行输入代码。正常加密恢复入口预先规范化输入，此发现不等于已证明远程可利用。

最终候选专项 **121/121**、扩大回归
**271/271**，覆盖语句/行 95.40%、分支 88.25%、函数 93.33%。强化 WS 回归使用磁盘 SQLite 和真实 AES 加密：关闭连接、关闭 owner、关闭数据库，重开同一文件并创建新 owner，再接回内部结果与外部结果各一次；检查加密 envelope 不含指定合成明文。它不等于原生 worker/DPAPI 或真实客户端验收。pending 解析、未完成发布拒绝、授权/到期、schema
mutation、总量上限和旧期限回归进入既有 unit 与客户端入口。

最终冻结完整客户端
**866 项中 863 通过、3 失败、0 取消/跳过**，退出 1，测试耗时约 71.6 秒。两项代理启动在原 15 秒期限失败，一项加密 idle
worker 在原 150
ms 观察等待后未完成 sweep 握手（状态 1，预期 2）。保留原并发、期限和断言，未重跑以制造通过。格式、零警告 Lint、语法、CI/release 治理通过；运行源及所有测试摘要未变。完整日志 SHA-256 为
`a9b547d86fa6f7c6b64703afcfe2ef2e16ed05a061e7d017c57694b9f1ac138d`。

证据分别保存在 `.hpm-acceptance/context-recovery-pending-results-20261019-01/`
与
`-02/`；前者保留首次候选和失败对照，后者包含补强回归的原失败、最终冻结源、日志及
`receipt.json`。

本轮新隔离包匹配
**570 个运行源、583 个构建源和 116 个锁定依赖**，运行源未变、目录治理通过。实际包内 Node 与模块执行相同 WS 回归
**59/59**，包括磁盘数据库关闭重开；仅替换测试导入路径，保留原期限和断言。包目录为
`C:\Users\juhon\AppData\Local\Temp\hpm-isolated-release-HsLYyf\dist\staging\runtime`；`isolated-package.log`、`packaged-execution.json`
与 `final-milestone.json`
关联源码及日志摘要。完整覆盖语句/行 98.78%、分支 94.36%、函数 98.87%，不代替完整客户端通过。此包未安装或生产启用。

**剩余边界**：本轮合成上游接受原 response ID，未证明 `store:false`
跨连接缓存失效后的完整历史重建；full-history
pending 续接目前明确拒绝。私有 WS 流式投影、公开/内部 ID 映射、steering、HTTP/WS 并发 pending 接纳和负向 cache-miss 尚未完整验收。2
MiB/root
pending 限额不构成全天容量证明。安装版宿主、真实模型及生产启用均未执行，完整门禁仍失败，整体目标保持未完成。

## 此前阶段：WS 普通响应实时进度与持久终态分离（2026-10-19，整体未完成）

此前普通 WS 也将
`response.created`、文本增量等全部缓冲到上游终态，客户端无法在生成期间获得响应 ID 或内容。本轮为未注入私有恢复工具/结果的普通 dispatch 增加内部
`onEvent`
发送能力：通过既有身份、流、顺序和字节校验的非终态事件按发送确认串行发布；最终
`completed`
仍等待所有进度发送确认、持久 prepare 和 sending 确认后发布，再完成 finished。普通失败仍先 abort 未提交分支，再返回终态。早期进度不是已完成历史，不能授予续接原文权限。

含私有恢复 coordinator 或 deferred 结果的 dispatch 不获得此发送能力，继续隐藏内部事件；没有把 private
response
ID 或私有工具调用直接暴露。此改动接通普通响应实时进度，但**尚未完成私有恢复轮次的流式投影、公开/内部 ID 映射、steering 或自动 successor 生命周期**，不能据此声明完整 WS 兼容。

发送队列仍有界：每个 dispatch 保留原 2
MiB/4096 事件上限，即使公开事件已发出也不重置累计计数；同流 FIFO、16 在途/32 请求、32 命名流及原期限不变。终态后追加事件、非法身份/顺序、发送失败、关闭或撤权继续终止；取消后未开始发送的 delta 和终态不得继续调用 transport，已经调用的发送可能晚到确认，不能将其当作终态成功。没有新增日志或模型/外部工具重放。

新增回归进入既有 unit 和客户端入口。对照使用此前隔离包中与冷加载最终候选逐文件 SHA-256 一致的 connection/turn 模块，其余依赖和新增测试不变：真实 socket 等待早期 delta 的用例超时，三个发布子用例收不到早期 created 而失败，终态 5 项中 0 通过、4 失败、1 超时取消。新源码 WS 专项
**58/58**，三模块覆盖语句/行 97.98%、分支 94.47%、函数 100%；扩大 HTTP、WS、coordinator、会话和发布回归
**229/229**。新测试另覆盖发送确认顺序、关闭、撤权、发送失败、极端事件数量及无效持久 ACK；既有失败断言、并发、预算和期限未放宽。

冻结候选完整客户端
**862 项中 858 通过、3 失败、1 超时取消、0 跳过**，退出 1，总耗时约 101.6 秒；本轮 WS 新增回归全部通过。两项代理启动仍在原 15 秒期限失败，一项独立 PowerShell
ACL 读取原期限超时，实际 stdio
CLI 用例在原 30 秒期限取消。idle 用例本次通过，不能单次关闭此前的间歇问题。范围格式、零警告 Lint、语法、CI/release 治理通过，运行源与所有测试冻结摘要未变。完整覆盖语句/行 98.77%、分支 94.39%、函数 98.86%，覆盖达标不代替完整门禁通过。完整客户端日志 SHA-256 为
`1b1226eebe85c8d9db914432dcff377eec5144228d09ceaa6970c8108623b058`。

证据位于
`.hpm-acceptance/context-recovery-ws-public-progress-20261019-01/`，包括旧模块摘要校验 preload、原失败、新专项、扩大回归、冻结源、各日志摘要和
`receipt.json`。本次重新获取的官方 steering/WebSocket mode
Markdown 也保存在该目录；不将公开 API 文档推定为 Codex 官方登录端点的实际支持证明。

本轮重新生成的隔离包匹配
**569 个运行源、582 个构建源和 116 个锁定依赖**，源摘要未变，目录治理通过；使用实际包内 Node 和运行模块执行同一 WS 测试
**58/58**，保留原测试期限、断言和 socket 行为，仅将测试导入指向包内模块与依赖。该包同时包含此前的冷加载 root-contract 模块，但本次 58/58 的测试范围是 WS，不能代替该模块全部包内专项。`isolated-package.log`、`packaged-execution.json`、执行日志及
`final-milestone.json`
保留包与测试摘要关联。完整客户端门禁仍未通过，尚未取得安装版宿主、真实模型或生产资格。

## 此前阶段：恢复冷路径按需加载与观察器读锁竞争（2026-10-19，整体未完成）

恢复会话不再在普通构造时导入 root
restore/loading、存储 reader/transaction/startup、checkpoint 和 publication 模块。异步接纳时才创建本会话唯一的 loader；存储附件、checkpoint 和可信状态导出/重建在实际调用处加载。错误工厂移到无状态的小型
`context-recovery-root-contract.js`，root-state 继续导出相同工厂，保持 TypeError 与固定错误码契约；无效可信查询也无需加载整个重建图。尚未创建的 loader 不因 configure/drain/关闭而被实例化，已创建的 loader 仍完整 drain。

禁用/关闭的异步接纳直接返回既有存储不可用结果。首次 loader 模块初始化失败时关闭本会话，清除能力并保持失败状态，不重试、不输出原生异常；已有存储清理和 drain 仍须完成。原有输入校验、当前授权、generation/revocation 复查、队列、原期限、账本和存储预算未改。

四项独立进程回归在修改前 0/4、修改后 4/4：阻断全部九个冷模块时，纯内存同步捕获/Unicode 精确读回、异步完成、撤权和关闭仍完成；首次异步接纳只初始化一次 loader；首次可信导出/重建保持 schema
3、24 小时原期限；模拟加载异常关闭 owner，后续接纳/启用/关闭不能制造成功且加载只尝试一次。回归位于既有 sessions 测试，进入原 unit 与客户端入口。扩大九文件专项 172/172，通过。

独立进程导入清单显示 sessions 本地模块数 58→44、core 158→144、runtime
69→55，九个冷模块均未进入三个入口的初始图，本地源码减少约 69
KB。单次耗时样本分别为 140→177、462→778、151→264
ms，未显示加速，不作速度比例、因果或稳定性结论。证据为
`.hpm-acceptance/context-recovery-cold-state-20261019-01/{before,after}-imports.json`。

该生产候选冻结完整客户端终态 850 项：848 通过、2 失败、0 取消/跳过，退出 1，运行源及全部测试摘要未变；范围格式、零警告 Lint、CI/release 治理通过。覆盖语句/行 98.77%、分支 94.37%、函数 98.86%。一次启动仍在 claude_filters 导入前到期，core 约 9272
ms、配置调用约 735 ms；另一次 ports_listening 约 11069
ms，通过原期限。剩余另一失败为真实 idle
worker：本次原始错误确认是 external_probe 阶段待执行请求因 worker
exit 被拒绝，已不再被 finally 的 close 错误遮蔽。完整客户端日志 SHA-256 为
`00f794d860e1345659b2a0e833b13e0778c8d3c5862902e9d60a924af0472fd0`；终态
`receipt.json` 保留。

随后在独立合成存储上持有只读 SQLite 事务，真实 25 ms idle 调度触发 worker
exit，后续读/close 均按原契约拒绝；受控复现退出 0，未使用真实内容或凭据。这证明独立观察器本身能与唯一 writer 的清理提交竞争，不能把该测试动作视为无侵入观察。未改变生产 SQLite
busy/失败策略。

现仅在测试 preload 增加共享观察握手：推进既有 SQLite 逻辑时钟后 arm，等待一次真实定时回调完整返回，再暂停后续定时 tick，独立只读连接验证过期行已删除，连接关闭后立即恢复。保留原 25
ms 加速间隔、150 ms 固定观察等待、30 秒用例期限、300
ms 保存延迟、精确删除/活数据/重开/续期拒绝断言；没有插入可顺便清理的 owner 命令。观察控制字段在生产 worker 解析前移除，错误维护仍会终止 worker，第二项 corruption 测试无观察暂停。新回归先失败后通过，覆盖 callback
receiver/参数、异常不 ACK、在途旧回调不能 ACK 后来的 arm、非 idle
timer 不变、恢复及非法控制输入；idle 专项 11/11。此专项结果不能替代下面的最终并发结果。

最终冻结候选 `.hpm-acceptance/context-recovery-cold-state-20261019-02/`
完整客户端
**851 项中 848 通过、3 失败、0 取消/跳过**，退出 1，总耗时约 86.1 秒。范围格式、零警告 Lint、CI/release 治理通过；运行源与全部测试冻结摘要保持不变。两项代理启动在原 15 秒期限失败：一项 core 导入约 10374
ms 后仍在 handlers，另一项已到 servers_created，但未在期限内确认监听。idle 物理用例在固定 150
ms 等待后观察状态仍为 1，未达到回调完成的状态 2，因此在独立 SQLite 读取前失败。握手避免未完成时进入读锁竞争，但尚未证明该用例在原并发与期限下稳定；不能删除握手断言、延长等待或将其解释成清理成功。新增握手独立回归和四项冷加载回归在本次完整入口通过。完整客户端日志 SHA-256 为
`1d743a20c68a02a7161d3e4ceabdaa23b833518789d3a4e36b390beca67bc45d`；原失败候选及两次回执分别保留，不合并为通过结果。下一步应针对启动加载和定时完成延迟取得受控因果证据，再修改并验证，不能仅重复完整入口直到通过。

此增量晚于前一 ACL 包，尚未取得新源码的包内、安装版或真实客户端资格。未调用真实模型、重启共享代理、安装插件或激活生产，完整 WS、全天容量与其余发布门禁仍未完成。

## 此前阶段：普通私密文件复用原生 ACL（2026-10-19，完整门禁未通过）

固定调用计时确认配置读取包含 Windows 同步 ACL 工作，随后在同一合成文件上交替比较既有兼容与原生操作：旧路径首次 whoami + 两次 icacls、约 457
ms，缓存 SID 后两次 icacls、约 305 ms；既有原生操作各一次子进程、约 157/176
ms。这只证明这些局部样本的调用数和耗时，不能直接归因为整体启动失败，也不能承诺整体加速比例。

现将恢复专用 native private-path dispatch 提取为无恢复状态依赖的共享模块
`private-path-native.js`。普通同步私密文件/目录的默认本地路径复用同一固定原生命令，缓存与 force 语义不变，执行前后验证文件身份；显式文件系统、执行器、SID 或不同环境适配器保留原路径。UNC、超长路径和卷根目录也保留既有通路。目标/祖先的链接、硬链接、错误类型及无效原生程序在边界拒绝；已发出的原生请求错误、异常 ACK 或目标替换均安全失败，不降级重试或写入成功缓存。仅默认原生程序不存在时允许原兼容路径；恢复存储继续对外统一返回原 storage 错误，不暴露原生异常。异步日志/PID 等文件保护路径未改变。

原生程序随发布准备流程从匹配源码构建；新增共享模块进入发布源清单。源码直接运行时，存在的原生程序也必须支持既有 private-path-v1 命令，不能以错误后重试兼容后端掩盖旧二进制。普通目录的原生成功不依赖旧的
`.hpm-secured` 标记授信；进程内仅缓存已确认的文件身份。

默认入口回归先复现 3 次子进程而失败，修改后验证一次原生调用、命中缓存、force、替换后重保、失败后无缓存和无自动重试。另覆盖缺失/非法原生程序分流、目标替换及异常输出；新测试由未变更的统一 unit
selector 发现。扩大专项 129/129，范围格式、零警告 Lint、CI/release 治理通过。三模块专项覆盖语句/行 94.89%、分支 90.44%、函数 89.47%，该覆盖报告不代替统一客户端阈值门禁。真实 Windows 原生程序经独立 PowerShell
ACL 读取验证普通与恢复目录/Unicode 文件的三主体 FullControl、禁止继承及内容不变，原 30 秒用例期限保持。

冻结候选完整客户端终态 846 项：835 通过、4 失败、7 取消、0 跳过，退出 1；运行源及测试冻结摘要未变。四项失败为两个代理启动、独立 PowerShell
ACL 读回超时及旧 DPAPI 包装互操作 key_unavailable；七项取消为实际 stdio、核心 HTTP 加密重建、inactive 密文清除、两项 idle 物理测试、staged 清理重开及加密重建。两次启动失败均未进入被测配置调用：一个 core 导入约 11172
ms 后仍在 runtime_config_controller，另一个仍在 core。此证据表明本次 ACL 复用尚未解决核心加载阻塞，不能因为局部调用更少或专项通过就宣称整体更快、稳定或可发布。完整客户端覆盖语句/行 98.76%、分支 94.36%、函数 98.86%，不改变门禁失败。

完整运行结束后仅补强新测试中的恢复存储兼容后端断言，生产源码未变；普通入口与存储入口均验证缺失默认原生程序可用兼容路径、非法原生程序不派发、兼容执行器的 5 秒/输出/环境边界保留。随后边界 17/17，三模块专项覆盖语句/行 96.28%、分支 84.56%、函数 94.73%；这是不同测试集合的独立报告，不合并覆盖率或重复完整入口以求绿色。证据目录
`.hpm-acceptance/context-recovery-shared-acl-20261019-01/`；原冻结
`receipt.json` 与 `source-snapshot.json` 保留，完整客户端日志 SHA-256 为
`f9140982d7194ecf2d72a6c685884eaf24f21b6d1b6ce03db6e148f253a6587a`。

隔离发布准备退出 0：568 个运行源、581 个构建源与 116 个原锁定依赖匹配，运行源未变，发布目录治理通过。随后使用包内 Node、实际原生程序及打包的共享 ACL/存储模块执行专项：真实普通目录/文件各一次原生 ACL 调用，独立 PowerShell 核对三主体权限；实际加密 worker 保存 24 小时记录、物理关闭重开、原期限及状态不变、续期拒绝，并在数据库文件中确认不出现合成载荷原文。原生调用保持 5 秒边界，独立 ACL 读取 10 秒、包内整个探针 30 秒；未借用真实认证或用户环境。`packaged-execution.json`
记录包内专项退出 0 与前后源摘要一致。这不等于完整发布通过、实际应用安装/启动器采用、真实客户端效果或生产资格；以上完整客户端失败仍有效，下一步启动排查须转向核心导入路径。

未修改 24 小时/旧记录期限、调用与存储预算，未改并发或期限，未修改真实认证、重启共享代理、安装插件或激活生产。完整 WS、容量、真实客户端及发布资格继续保留在总目标内。

## 此前阶段：启动调用诊断与空闲清理失败核查（2026-10-19，整体未完成）

24 小时生产候选源码保持下节冻结版本。仅在测试 preload 增加固定词表的首调用计时：迁移、配置读取、HTTP
Agent、代理 transport 和 runtime
support。包装保留函数属性、receiver、返回值及抛出对象，不执行访问器，不记录参数、错误正文或原文；监听完成后恢复原 loader。独立进程回归先复现缺少调用计时，修改后验证返回/抛出身份、重复调用仅计时一次、访问器不执行与私密内容不输出。专项 7/7、范围格式、零警告 Lint、CI/release 治理通过。

完整客户端终态 846 项：844 通过、2 失败、0 取消/跳过，退出 1。运行源及测试冻结摘要未变，生产源码与 24 小时最终候选一致。启动失败样本的 core 导入约 11578
ms，截止时仍在 support 导入，尚无任何被测函数调用；另一启动通过样本的 ports_listening 约 13971
ms，配置调用约 1277 ms、Agent 构造约 1279
ms。配置调用嵌套在 Agent 构造中，两者不可相加。这些样本不能证明配置或单个导入就是根因，也不证明启动已提速。证据目录
`.hpm-acceptance/context-recovery-startup-calls-20261019-01/`；终态
`receipt.json` 固定日志摘要，完整客户端 SHA-256 为
`a01899fdaa40327234dfd151b66133d692758a3a5fb54cbbeb99b73fc45c181a`。

另一失败为真实加密 idle worker：固定阶段定位到 independent SQLite
external_probe，但 finally 中的 close 拒绝遮蔽原始错误，不能据此推断为删除失败、SQLite 锁冲突或此前的时钟竞争。现把清理移入 node:test 的 after
hook，使原始断言/SQLite 错误与清理失败分别报告，保留原 30 秒期限、25
ms 加速调度、150
ms 观察等待及全部存储断言；仅修正诊断，不修改生产清理策略。该诊断版本的 idle 专项 10/10 通过；随后完整入口的 idle 用例也通过，但原始错误未复现，间歇失败不关闭。

诊断候选最终完整客户端为 846 项：841 通过、3 失败、2 取消、0 跳过，退出 1；运行源及全部测试冻结摘要未变，生产源码仍与 24 小时最终候选一致。三项失败为两个代理启动及真实加密重建存储不可用；两项取消为实际 stdio
CLI 和 staged 清理重开原 30 秒期限。清理重开的第三次打开在约 28325
ms 完成密钥解封，尚未进入 database_opened，不能把该样本归为扫描或关闭耗时。范围格式、零警告 Lint、CI/release 治理及启动专项 7/7 通过，不改变完整入口失败。证据目录
`.hpm-acceptance/context-recovery-idle-diagnostics-20261019-01/`；终态
`receipt.json` 固定各门禁、源码及日志摘要，完整客户端 SHA-256 为
`55765dadbf29648078ccb86c6a12141cd6187fbacd43635601638803a7b36d4d`。没有降低并发、延长超时或重跑至绿；后续须定位具体启动/重开耗时及失败，不能将本轮 idle 通过当作根因修复。

未重跑已知未变化的全仓格式失败，未重启共享服务、调用真实模型、安装插件或激活生产。完整 WS、实际宿主、容量及发布资格仍未完成。

## 此前阶段：24 小时版本化留存候选（2026-10-19，整体未完成）

首发选择已落入候选源码：新 recovery root 为 schema
3、绝对有效期 24 小时；binding/history 的新版组件为 schema 2。旧 schema 1/2
root 保留 30 分钟期限及原账本策略，导入、继续、读回、重新导出均不续期；旧 root 的政策信息可按既有规则补全为 schema
2，但不会变为 24 小时。重建后的新独立 root 使用新策略。原文账本保持默认 30 分钟供其他调用者使用，仅恢复会话显式采用 24 小时；账本可接受的上限同步改为 24 小时。

存储、目录/worker 回复、密文 AAD 校验和 WS 私有结果续接统一接受最多 24 小时的原期限；SQLite
schema、密钥包装和 AAD 编码不变，不重加密旧记录，也不修改其期限。原 CAS 规则仍拒绝延长已有记录。root 导入同时验证版本、根期限、binding 版本、非空 history 版本和账本期限一致性，防止只重标版本或混用期限。清除操作编号的独立 30 分钟有效期未修改。管理诊断的留存策略版本为 2，前端显示 24 小时并明确已有记录保持原到期时间；旧诊断版本仍可展示。

新增回归在修改前因 root 仍为版本 2 而失败，修改后在 24 小时到期前 1
ms 重建、精确原文读回、期限不变及到期拒绝均通过。另覆盖旧 schema
1/2 的原期限、继续后不续期、新旧 root 共存、错误期限/版本/账本混合原子拒绝、账本上限及 WS 原期限。真实 Windows 加密 worker 新旧记录共存用例通过（约 3578
ms）：物理关闭并重开后旧记录按 30 分钟删除，新记录在 24 小时到期前仍精确读回，到期清理后独立只读 SQLite 确认无剩余记录，续期请求被拒绝。时间推进仅通过已有测试专用 SQLite 时钟完成，真实 worker、DPAPI、文件系统及 30 秒用例期限保留。

此前扩大专项 158/158，通过；随后加入跨组件一致性检查的冻结候选 306 项中 304 通过、2 失败。失败来自发布投影删除全部私有历史后保留了合法 schema
2 空历史，而新增检查只接受 schema
1 空历史；现空历史可保持任一已支持的组件版本，非空历史仍须匹配 root 策略，两项对应回归通过。两份失败候选回执及日志保留于
`.hpm-acceptance/context-recovery-retention-24h-20261019-01/` 与
`-02/`，前者还记录测试 helper 全局符号 Lint 的修正。

候选 `-03/` 扩大专项 306/306，前端 coverage
7/7 文件、独立目录构建、范围格式/Lint/CI/release/前端架构均通过；前端语句/行 98.06%、分支 90.44%、函数 96.42%。完整客户端 846 项中 844 通过、2 失败、0 取消：一个原期限隔离代理启动，另一个发布用例仍在逻辑时间 30 分钟触发“到期”。后者改为独立断言根期限精确等于创建时间 100 +
86400000，再推进至该到期点；原墙钟期限、并发、失败断言均保留，修改后对应回归通过。

最终候选 `.hpm-acceptance/context-recovery-retention-24h-20261019-04/`
专项 325/325；完整客户端终态 846 项中
**845 通过、1 失败、0 取消/跳过**，退出 1，整体未通过。覆盖语句/行 98.76%、分支 94.40%、函数 98.86%。唯一失败仍为原 15 秒隔离代理启动；该样本 core 导入约 10987
ms，截止时所有被记录的顶层导入已完成、尚未记录 composition_ready，不能只据此认定根因。候选运行源及全部测试冻结摘要未变；与
`-03/`
的唯一差异为该发布测试，因此前端与构建资格按摘要复用，不重复运行。`receipt.json`
同时记录复用依据与各入口/日志摘要；完整客户端日志 SHA-256 为
`58f76afd6f05df8b686065135f428a4ad254aa77af44bc259110c74e6b47bf6e`。所有历史失败保留，不将本轮密钥、stdio、重建和清理重开通过归因于留存改动，也不据此关闭其稳定性需求。

4 个活动 root、每 root 64 来源/4
MiB、恢复调用与分页预算、全局存储限制均未扩大。24 小时是最长保留期限，尚不证明全天真实任务的容量/延迟满足要求；达到容量时仍按既有安全规则拒绝，不淘汰有效原文。不把该源码候选表述为当前共享进程已加载、实际宿主已验收或生产已激活。旧程序的 30 分钟存储边界无法接管新记录，回滚必须关闭恢复并保留新版本存储，或通过新版已验收的清除流程及持久 ACK 后另验旧版接管；不能依靠把 root 版本号改回旧值。完整 WS 生命周期、接入诊断、真实 Codex/Claude 路径、完整门禁、发布和回滚资格仍待完成。

## 此前阶段：覆盖环境修正与首发留存决策（2026-10-19，整体未完成）

用户已确定首发原文留存目标为
**24 小时**。这是待交付目标，当前运行契约仍为 30 分钟、4 个活动 root；已有记录保持原到期时间，读取、重启和迁移均不自动续期。24 小时尚未接入生产，不把本次决策表述为实现完成。

隔离测试此前显式启用逐夹具 Node compile cache，同时继承 V8 coverage。按 Node
v22 官方 module compile
cache 文档，此组合可能降低反序列化函数的覆盖精度。现测试环境统一设置
`NODE_DISABLE_COMPILE_CACHE=1`，清除大小写变体，保留隔离路径和 V8
coverage；生产启动缓存设置不变。实际 Node 子进程回归在修改前得到 cacheEnabled=true 而失败，修改后验证缓存关闭、覆盖开启及覆盖文件确实生成。此修正用于保证覆盖环境，不证明解决启动性能问题。

冻结专项 50/50，范围格式、零警告 Lint、CI/release 治理通过。字面完整客户端终态 838 项：832 通过、3 失败、3 取消、0 跳过，退出 1；源码与冻结测试摘要未变。失败为两个隔离代理启动期限及 native
helper 与旧 DPAPI 包装互操作的 key_unavailable；取消为实际 stdio、加密 HTTP 重建及 staged 清理重开。覆盖语句/行 98.75%、分支 94.37%、函数 98.86%，整体未通过。终态已确认，无需继续轮询该运行。证据目录
`.hpm-acceptance/context-recovery-test-cache-20261019-01/`；`receipt.json`
固定各入口及日志摘要。完整客户端日志 SHA-256 为
`13f2a3b2a93db3164815e69e66773f73f9cf53bbe707629b941d940b4b88775c`。

后续提速采用小范围修改与专项门禁，稳定候选再跑完整入口，不重复未变化的全仓格式失败，不放宽原超时、并发或覆盖阈值。24 小时实现须同时覆盖 binding/history、ledger、root
checkpoint、存储/AAD、维护清理及诊断投影；其中 ledger 当前最大 2 小时，不能仅修改 sessions 常量。必须区分新策略与旧记录，保留旧到期时间；4
root、每 root 及全局字节预算、128 调用预算能否覆盖全天任务仍需独立验证。之后完成 WS 生命周期、实际宿主和发布资格。当前未调用真实模型、未重启共享代理、未生产激活。

## 此前阶段：分页整代认证去重与 idle 回归时钟（2026-10-19，整体未完成）

四页读取在上一候选中会全量读取密文 8 次：每页认证一次，再为目录重复加载所有密文。新增实际 SQLite 计数回归在修改前得到 8 而失败。现目录查询仅取有界元数据，第一页与最后一页各执行整代认证/过期清理，中间页单独读取并认证选中记录；每页目录指纹、完整 checkpoint 与当前授权复查仍由既有遍历器执行。四页全量密文读取现为 2 次，与原 catalog/load/catalog 的整代边界一致；单页在同一事务内完成，不添加缓存或放宽字节/并发限额。最后一页通过前不导入 root、不注册 denial
index、不执行 staged 清理。

新增回归覆盖中间记录密文损坏立即拒绝、第一页之后损坏的过期 tombstone 在最后一页拒绝且事务不删除任何记录，以及后页失败时启动发现/请求恢复均不导入部分 root。首次扩大运行 52 项中 51 通过、1 失败，失败来自新增夹具试图同时创建第 5 条活动记录；已改为先创建并撤销 tombstone，再填充 4 条活动记录，未改变限额。随后三个对应回归 3/3 通过，最终统一验证另行记录。

idle 清理物理用例存在独立墙钟竞争：其第一条保存只有 250
ms 有效期。对首条保存注入 300
ms 传输延迟后，旧用例确定在 expired_save 失败；固定阶段诊断保留该初始阶段，不输出错误正文。现复用已有测试专用 SQLite 共享时钟，两个保存和过期前读回完成后才推进到 expiresAt+1，再经真实空闲定时清理与独立 SQLite 连接检查；重开使用相同测试时钟，真实 worker、DPAPI、文件系统和原 30 秒用例期限保持。注入延迟保留，额外断言精确创建/到期时间，过期重写继续拒绝。专项修改后 1/1 通过，随后扩大运行中的该用例也通过。该修复证明夹具竞争被消除，不证明上一全量 idle
worker 的全部失败根因已确定。

四条记录的真实加密 worker 顺序交替样本：legacy 6 次调用耗时 350/289/296/268
ms，当前 scan 4 次调用耗时 205/191/196/202
ms。只是未控制其他系统负载的局部读取对照，不推算冷启动或实际宿主整体收益。证据目录
`.hpm-acceptance/context-recovery-scan-generation-20261019-01/`，`baseline-results.json`
校验两项修改前预期失败，并固定源码/日志摘要。最终候选扩大回归 145/145，格式、零警告 Lint、CI/release 治理通过。

完整客户端终态 838 项：837 通过、1 失败、0 取消/跳过，退出 1；运行源与冻结测试摘要未变。覆盖语句/行 98.75%、分支 94.37%、函数 98.86%；SQLite 模块语句 334/334、函数 12/12、分支 168/177。`final-receipt.json`
固定各入口结果与日志摘要，完整日志 SHA-256 为
`fd3b728ae22ce98803966af1ee6eb6fc8f5c57df369edf24171f5162b2a320e1`，整体未通过。idle 用例在全量下通过（约 10451
ms）；stdio、staged 清理重开及授权重建本次也通过，不将全部变化归因于本次优化。唯一失败为隔离代理启动；固定阶段显示 core 导入约 10887
ms，原期限到达时仍在 runtime_http_agents 导入，未建立单一根因。保留所有原超时、并发、断言与前序失败，不用此次通过数推定稳定性。当前源码未取得新的隔离包/实际宿主/生产资格，未重启共享代理或调用真实模型。

## 此前阶段：有界事务分页读取（2026-10-19，整体未完成）

存储新增内部 `scan`
协议：每次 SQLite 事务验证 schema、时钟、全部行认证与过期清理，返回完整有界目录和一条记录。空库/单条/四条记录分别为 1/1/4 次调用，原流程分别为 2/3/6 次。每页仍按 scope 顺序验证目录、记录元数据与完整 checkpoint，多页目录指纹必须一致；身份过滤前校验所有记录，等待前后保持当前授权检查。单页响应和在途请求字节预算未增加，schema 与留存期限未改变。

只有 execute 函数显式声明版本 1 才选择新协议；异步打开适配器传递真实能力声明，未声明的适配器使用原目录/加载/目录协议。已选择 scan 后的任何失败不会降级或重试。会话重建与启动 denial-index
discovery 共用遍历模块，暂不改变 staged 清理写入与 CAS/读回校验流程。发布源清单包含新模块。

首次扩大回归 121/121，通过；随后修正测试计时包装不传递能力声明的问题，使真实 core
HTTP 加密重开夹具实际走 scan，并断言两次 discovery 与三次请求共 5 次 scan、没有 catalog 调用。该夹具及计时器专项 32/32；最终冻结候选扩大回归 124/124，格式、零警告 Lint、CI/release 治理通过。完整客户端终态 835 项：829 通过、3 失败、3 取消，退出 1；运行源与冻结测试摘要未变。覆盖语句/行 98.75%、分支 94.38%、函数 98.85%，不改变整体未通过。`final-receipt.json`
记录各入口退出码与日志摘要，完整客户端日志摘要为
`7b1ceb9013a93b06ef308e9d8144101d9664d372209c35fd44e72a49e8dc47f1`。当前候选尚无新的隔离发布包、实际宿主或生产资格。

完整失败为两个原期限代理启动及实际 idle worker 存储不可用；取消为实际 stdio
CLI、staged 清理重开和加密重建授权。idle 用例最终 close 报错可能遮蔽原始失败，尚不能归因；其 250
ms 墙钟有效期与 25
ms 加速清理属于下一步核查点。清理重开探针显示第二次关闭约 29532
ms 才结束，原 30 秒用例在第三次打开前到期，不证明单次 scan 为根因。所有原期限、并发、断言与失败证据保留。

同一真实加密 worker 顺序交替对照，单条记录 discovery 的旧协议 3 次调用，样本耗时 434/494/458/624
ms；新协议 1 次调用，样本为 171/131/178/183
ms。四条记录的另一组对照，旧协议 6 次调用、378/711/625/542
ms，新协议 4 次调用、1029/476/538/360
ms，未显示稳定的延迟收益。当前新协议逐页认证全库，四页的解密工作量高于原两次目录认证，后续优化需要保留原整代认证边界；不能只凭调用数宣称四条场景更快。以上仅局部读取样本，未控制系统其他负载，不测冷启动，不作为整体启动或真实客户端加速比例。真实 HTTP 重开夹具新路径本次通过，但不据此关闭历史并发/启动失败。

证据目录 `.hpm-acceptance/context-recovery-bounded-scan-20261019-01/`，初次
`receipt.json` 与最终候选 `final-*`
文件分别绑定各自源码；不合并为一次验收。另只读核对当前 PATH 首选 Codex
CLI 为 0.160.1，Claude
Code 为 2.1.292；这只是安装版本，不证明实际请求传输、路由、模型、应用加载版本或三次压缩验收。未调用真实模型、未重启共享代理、未激活生产，整体目标继续执行。

## 此前阶段：存储读取计时与提速优先级（2026-10-19，整体未完成）

新增测试专用固定阶段计时器，只记录阶段和整数耗时，不记录用户内容、路径、标识或异常正文；不改变生产代码、原请求 5 秒信号、用例 30 秒期限或并发。专项 32/32 通过，范围格式与零警告 Lint 通过，新计时器回归已确认由统一 unit
selector 发现。

完整客户端终态为 826 项：823 通过、2 失败、1 取消；运行源和冻结测试摘要未变，退出 1。失败为两个代理启动入口，取消为 staged 清理重开。实际加密存储 HTTP 重开本次通过，不代表此前请求失败根因已消除。完整覆盖语句/行 98.74%、分支 94.32%、函数 98.96%。终态回执与日志位于
`.hpm-acceptance/context-recovery-storage-request-probe-20261019-01/`。

本次通过样本以首次 worker_started 为时间零点，首次 engine_ready 约 4548
ms，重开 worker_started 约 7788 ms、reopened 约 14806 ms；恢复请求约 18084
ms 开始、19797 ms 收到 headers、21023
ms 完成持久化确认。多次存储往返达数百毫秒，后续一次 save 约 2494
ms。事件循环最大延迟约 113
ms。该样本支持优先评估减少存储往返，不证明启动失败与取消具有相同根因。

提速顺序：先专项验证，候选稳定后运行完整门禁；不重复扫描未变化的已知全仓格式失败。产品路径优先评估有界原子分页读取，保留整代一致性、全部记录校验、撤权复查与原 IPC 字节预算。该优化尚未实现，不以缓存或跳过校验替代。当前没有真实模型调用、安装版宿主验收、共享代理重启或生产激活，整体目标未完成。

## 此前阶段：恢复 WS 栈按需加载（2026-10-19，未封存、整体未完成）

启动探针扩展为固定词表的开始/完成记录，并共享同一白名单给写端和读端。新增独立进程回归验证失败模块仍记录完成、未知模块与错误内容不输出、重复加载不重复计数，并在 ports_listening 恢复原 loader；真实 HTTP 捕获入口与探针专项 4/4，通过零警告 Lint 和 CI 治理。新增探针测试由未变更的递归 unit
selector 发现。

该探针对应的完整客户端结果为 826 项：822 通过、2 失败、2 取消，冻结运行源与测试摘要未变。两个启动失败中，一个仍在 core 导入，另一个已经进入 composition_ready（约 14870
ms），未完成 websocket 导入；后者不能归为模块图未完成。其余取消为核心 HTTP 加密重开及 staged 清理重开。固定事件循环最大延迟样本分别为约 401/96
ms，不能单独据此确定性能根因。终态回执及完整日志在
`.hpm-acceptance/context-recovery-startup-imports-20261019-01/`。

现将恢复专用 WS
transport 的加载移至入口认证、当前路由和恢复准入检查之后；普通 HTTP 启动与普通 Upgrade 转发不再提前加载该 transport 和
`ws`。恢复已准入后的模块加载或初始化失败，以固定错误日志关闭当前 lifecycle，不落回普通转发，也不输出原生异常。未关闭恢复功能、改变原 deadline 或降低并发。

新增独立进程回归在修改前失败，修改后通过，分别覆盖普通转发、提供方不准入和恢复准入后加载失败；最后一种必须没有普通上游请求且关闭客户端。HTTP/WS/探针扩大回归 62/62，0 失败/取消/跳过；范围格式、零警告 Lint 与 release 治理通过。新进程模块清单验证修改前实际加载 transport/`ws`、修改后两者均未加载；该依赖边界证据不是整体启动加速或稳定性证据。随后实际 WS 专项覆盖入口 58/58，通过；仅
`websocket-proxy.js`
范围覆盖语句/行 88.65%、分支 69.56%、函数 100%，它不是完整客户端覆盖或发布门禁。

最终字面完整客户端为 826 项：824 通过、2 失败、0 取消/跳过，运行源与冻结测试摘要未变，退出 1。直传入口约 13713
ms 进入 ports_listening，在原期限内通过；另一入口的 core 导入约 11252
ms，原期限到达时仍在 runtime_http_agents 导入。第二项失败是实际加密重开的 HTTP
fetch，原 5 秒请求信号和 30 秒用例期限保持，日志不足以确定请求失败根因。完整客户端覆盖语句/行 98.74%、分支 94.32%、函数 98.96%，不改变门禁失败。样本波动很大，不能将通过数变化归因于本次拆分；没有取得当前源码的隔离包、真实宿主或生产资格。证据与终态
`client-receipt.json` 位于
`.hpm-acceptance/context-recovery-lazy-ws-transport-20261019-01/`，失败日志和修改前源文件均保留。

## 此前阶段：留存限制展示与完整客户端诊断（2026-10-19，整体未完成）

管理状态新增实际留存策略投影，界面显示从代理建立恢复记录起最多保留 30 分钟、读取与重启不续期、整个代理最多同时维护 4 个活动聊天且分支共享限额。这是活动恢复名额，不代表磁盘只能保留 4 条记录。会话新建、持久化 root 接纳与诊断共用限额常量；未改变期限、准入或过期规则，也未解决全天任务的容量需求。旧版服务没有该字段、策略版本不支持、异常数值或访问器均显示“留存期限与聊天容量未核验”，不推定当前能力。响应仍为原状态 schema 的新增可选字段，不授予读取权限。

专项 43/43、运行时/生命周期/策略/重建扩大回归 82/82 通过，包括实际第 5 个独立聊天拒绝、到期前保留、绝对到期后释放并重新接纳，以及诊断快照隔离和前端正常/空/非法/极端/异常输入。不展示 root 标识、用户内容或凭据；状态仍通过已有文本呈现路径输出。回归位于已有统一客户端、递归 unit 和前端 coverage 测试文件，发布源清单包含新常量模块。前端统一 coverage
7 文件通过，语句/行 98.05%、分支 90.41%、函数 96.42%；范围零警告 Lint、CI/release 治理、前端架构和独立目录 Vite 构建通过。构建仍报告大于 500
kB 的 chunk 警告，未提高阈值。证据目录
`.hpm-acceptance/context-recovery-retention-display-20261019-01/`；实际界面与安装版尚未验收。

上一 IP 依赖拆分候选的完整客户端结果为 824 项：821 通过、2 失败、1 取消；运行源摘要未变。失败为两个隔离代理启动和 staged 清理重开超时，证据在
`.hpm-acceptance/context-recovery-validator-boundary-20261019-01/client-receipt.json`。

随后仅增加测试启动分段诊断的完整客户端结果为 824 项：816 通过、4 失败、4 取消，运行源及冻结测试摘要未变。两个原 15 秒代理启动均未到 module_graph_ready；一个只完成 logger/metrics 导入，另一个记录 core 导入约 7317
ms，随后经过 config/cert/routing 导入，但同样未完成整个模块图。因此证据定位到模块加载阶段，尚未确定单个根因。其余失败/取消涉及实际 stdio、加密重开、独立 ACL
PowerShell 验证与 DPAPI 兼容，不作同源结论。focused routes
2/2 通过，不能替代完整入口失败。证据及终态回执在
`.hpm-acceptance/context-recovery-startup-phase-probe-20261019-01/`，日志摘要
`d8a4de4c168b937c5bb8e3fc98d60e0a35f3b1cd6d8c758c337748e988b09ee3`。

最终文案澄清活动限额后，文本专项 6/6 通过；最终格式、零警告 Lint、前端统一 coverage 和独立目录构建均退出 0，门禁前后 9 个范围源码/测试/发布清单摘要未变。`local-receipt.json`
绑定上述结果与各日志摘要，仅表示本地范围资格；前面的 43/43、82/82 是各自变更时点的范围结果，不累计成一次完整客户端验收。

本批先运行与变更相关的测试及门禁，不因历史全量失败重复启动相同扫描；冻结候选仍须取得完整工程、实际宿主和生产资格。当前整体未通过，未调用真实模型、未安装插件、未重启共享代理或生产激活。

## 此前阶段：启动校验依赖拆分与维护回归时钟（2026-10-19，整体未完成）

逐项检查完整客户端失败时，确认维护用例存在墙钟竞争：第一条记录仅存活 1 秒，而后续正常保存同样会执行过期清理；负载高时该保存已清掉第一条，随后显式 sweep 的精确删除数断言误报。现仅在测试 worker 的可信 preload 中向现有 SQLite
`now`
参数注入共享时钟，进入真实 worker 前移除该测试字段；两个保存完成后才推进时间。保持真实文件、DPAPI、worker 协议、清理与重开，以及原 30 秒超时、原删除数/字节/预算/过期重写拒绝断言；另增加精确创建时间和有效期断言。最终维护专项 8/8 通过，不能据此声称其他存储打开失败或锁错误已解决。

原配置 validator 为一个 IP 分类函数加载整个外网探测模块及 DNS/HTTPS。新增独立进程回归在修改前因加载探测模块失败；现把同一地址分类函数与封锁网段原样移入
`public-ip-address.js`，validator 直接依赖该模块，探测模块仍重导出相同函数。发布运行源清单已包含新增模块，不改变地址规则或执行网络请求。该回归在新的进程中禁止探测模块、DNS/HTTPS 加载后仍完成真实配置校验。

格式完成后扩大回归 26/26 通过，覆盖配置、外网探测、管理入口、实际代理捕获入口、空闲清理、维护和 lazy
routes；随后维护时间断言补强后的专项 8/8 通过。范围格式、零警告 Lint、CI/release 治理通过；新模块范围覆盖语句/行 100%、分支 90%、函数 100%。最新单次核心导入为约 763
ms、197 个缓存模块，测量条件与此前约 1885
ms 样本不同，不作加速比例或稳定性结论。本轮修改晚于下方包内候选，尚未取得本轮完整客户端/发布包资格。证据目录
`.hpm-acceptance/context-recovery-validator-boundary-20261019-01/`；首次维护验证保留在上一构建输入目录中。

## 此前阶段：Windows 存储权限启动候选（2026-10-19，整体未完成）

针对加密存储多次重开超时，新增原生私有路径权限入口及 JS 存储边界。每次权限设置由一个有界原生调用完成，保留句柄固定、禁止 reparse/hardlink、受保护 DACL 替换与读回校验。已发出的原生调用失败不转兼容后端；仅默认 helper 缺失时允许原有权限实现。存储 schema、期限和权限要求未改变。

原生协议现明确拒绝控制字符、通配符、保留设备名、重复/未知字段、相对/UNC/根路径与过长 UTF-16 路径。原生 fmt、零警告 Clippy 与 7 项测试通过，包括实际 Windows 文件/目录权限、类型与硬链接拒绝、Unicode 和 I/O 固定错误输出；CI 与发布源治理通过。源码与本地 helper 已更新，但尚无本轮完整客户端和隔离发布包资格。

首次扩大存储回归 124 项中 123 通过、1 项原 30 秒超时取消，失败保留。该 staged 清理重开用例单独运行在 16.17 秒内通过；它不能证明原并行入口问题消失。初步三次 owner 打开探针从 24 次 icacls、1 次 whoami、3 次 key
helper 变为 15 次 helper 调用，后两次 engine_ready 约 3.23/3.05 秒，但首次约 10.75 秒，三次总延迟没有明确下降。冷启动原因及稳定收益尚未证实，不能宣称整体加速完成。

证据目录 `.hpm-acceptance/context-recovery-startup-targeted-20261019-01/`
保留原 profile、候选 profile、首次扩大失败、单独复跑与原生门禁。本轮边界更新并重建 helper 后，原 7 文件并发入口扩大回归 124/124 通过，0 失败/取消/跳过，总计 53.14 秒；此前超时的 staged 清理重开用例 20.80 秒通过。范围格式、零警告 Lint、CI/release 治理通过；未放宽期限或调整并发。一次通过与此前失败并存，不能据此声称稳定性或性能根因已解决。

冻结运行源后的字面完整客户端结果为 824 项：809 通过、11 失败、4 超时取消。失败包括两个原 15 秒代理入口启动、原生 ACL 独立 PowerShell 验证超时、DPAPI 兼容及多个存储打开失败、SQLite 锁错误和维护断言；不能把这些失败全部归于同一原因。覆盖语句/行 98.74%、分支 94.32%、函数 98.96%，不改变整体未通过。字面 verify 仍为同一 404 文件格式问题，日志摘要仍是
`6c5fbd7968885629a06ee54c457a8dda244a465f551196fe89bf850d7401df4c`。

本轮第一次隔离包准备失败。独立原生构建诊断确认 Rust
`E0583`：隔离构建复制清单遗漏新增 `src/private_path.rs`。已补齐
`lib/release/isolated-runtime.js`，新增回归在修复前 0/1、修复后治理测试 11/11；测试由现有递归 unit
discovery 纳入统一入口。首次失败工作区未删除，诊断使用独立 target；修复后的构建/包内资格另行记录，不沿用此前包内结果。该修复只改变构建输入，已冻结的客户端运行源摘要保持不变。

顺序 ABBA owner 探针每个新进程执行首次打开及两次重开：兼容后端两组约
`[3480,1928,1459]`、`[1824,1282,2004]` ms，原生两组约
`[1652,2078,3184]`、`[1763,1618,2268]`
ms。每组三次打开的子进程调用从 28 降到 15，但总体耗时没有显示稳定收益；该探针没有控制 OS 冷缓存，也不是实际宿主性能验收。不得据此宣称已提速。

完整失败、ABBA 探针与首次冻结回执位于
`.hpm-acceptance/context-recovery-native-acl-20261019-01/`；构建输入修复与后续资格位于
`.hpm-acceptance/context-recovery-native-acl-build-input-20261019-01/`。修复后范围格式、零警告 Lint、治理测试 11/11、CI/release 治理通过；隔离包匹配 564 个运行源、577 个构建源、116 个锁定依赖，源码摘要未变。包内实际 Node、模块与独立构建原生 helper 执行同一 7 文件存储回归 124/124 通过，0 失败/取消/跳过，总计 35.40 秒。

首次包内探针误要求独立编译 helper 与本地 helper 字节相等，尚未运行任何包内测试即失败；独立 Windows 构建不保证这一条件。保留该脚本与失败日志，修正探针按发布清单的
`contextRecoveryNativeSha256`
核对实际 helper，同时保留构建源、运行源和测试源摘要检查，再取得上述包内结果。此校正不改变任何业务测试的断言、期限、并发或覆盖门槛。完整客户端的 11 失败/4 取消及全仓格式阻断仍未解决，未取得真实宿主或生产资格。以下 WS 结果属于此前封存源码。

## 此前阶段：WS 命名流错误与安全边界（2026-10-19，整体未完成）

主方案已补齐首发执行决策，统一代理恢复核心、一次接入助手、实际能力诊断及验收/回滚产物；当前 30 分钟/4
root 的容量限制纳入首发条件。真实宿主、模型及生产资格仍未取得，不用旧阶段通过数推定当前工作区整体合格。

WS stream
admission 修改 wire、connection 与既有 websocket 测试文件，收紧命名流 ASCII/长度边界，并以固定错误回复非法 ID 或超出 32 个命名流的请求，保留已有流。错误回复发送前重新检查授权，发送失败关闭，最多 32 个在途回复；超限关闭并阻止排队回复继续发布。拒绝不分配流或改变请求/字节额度；非法上游 ID、畸形 JSON 和二进制保持关闭。编码器只接受固定错误码和合法标量 ID，不调用对象转换器或回显非法输入。

新增三条基本回归在修改前 0/3、修改后 3/3；补充五条边界测试后，聚焦 8/8。首次完整 WS 回归为 45/46：旧容量测试将第 33 个新命名流当作请求预算溢出。现改为在 32 个待处理请求后向已有流追加请求，保留原关闭和字节归零断言，新增满额前的 16
active/16 queued/32
lanes 断言；命名流上限的保留连接由真实压缩 socket 独立验证。原失败保留，不放宽期限、并行或断言。

| 检查                                 | 冻结候选结果                                             |
| ------------------------------------ | -------------------------------------------------------- |
| 完整 WS 专项                         | 46/46，通过；范围语句/行 99.04%、分支 95.38%、函数 100%  |
| HTTP、转换、会话、协调和 WS 扩大回归 | 187/187，通过                                            |
| 范围静态与治理                       | 格式、零警告 Lint、3 文件语法、CI/release 治理通过       |
| 隔离发布包                           | 563 个运行源、575 个构建源、116 个锁定依赖匹配，摘要未变 |
| 实际包内 Node/模块                   | 164/164，通过，无失败/取消/跳过                          |
| 字面完整客户端                       | 821 项，813 通过、2 启动失败、6 超时取消；整体未通过     |
| 字面全仓 verify                      | 相同 404 文件格式问题，退出 1，后续全仓阶段未运行        |

完整客户端覆盖语句/行 98.78%、分支 94.31%、函数 99.07%，不改变门禁失败。两项启动失败仍在 lifecycle 预加载后未进入 server_start；六项取消分别是实际 stdio
CLI、核心 HTTP 加密重开、压缩日志重开、staged 清理重开、维护重开及重新授权重开，均触及原 30 秒期限。当前不能断言这些超时同源，也不能把包内通过当作它们已修复。

证据位于
`.hpm-acceptance/context-recovery-ws-stream-errors-20261019-01/`。本阶段 runner 冻结并复核 6 个源码/清单输入，保留修改前、首次完整失败、最终范围/包内成功、完整客户端和全仓失败。最终回执同时绑定日志、包内运行源与两份文档。这些修改晚于下方启动候选，旧回执不覆盖当前增量。

公开 steering 文档要求先收到 response.created，再发送 response.steer，并跟踪自动续接；当前恢复路径的整轮事件缓冲尚不满足该完整交互。接下来需实现公开事件生命周期、内部身份映射和发布边界，不能只增加控制事件分支。当前查阅的 Responses
WS 文档未建立 response.cancel 契约，不声明其支持；停止、断连、steering 与副作用工具分别验证。

本批只实施上述 WS 边界和回归，不安装插件、不改真实认证、不调用模型、不重启或激活服务；历史失败与回执保留。下一步针对启动及真实 worker/stdio 超时取证和修复，再完成完整传输、容量与真实宿主验收。

## 实际入口基线与可选插件候选（2026-10-19，未激活）

只读核对本机 Codex CLI 0.160.1、Claude Code
2.1.292；进程元数据显示正在运行的 Windows 桌面分发为 26.1013.4894.0。Codex 用户级简单配置指向 localhost:3085、Responses；本项目配置没有观察到覆盖的模型入口。Claude
Code 用户配置及当前 shell 的入口为远程 HTTPS，本项目已检查的设置文件没有入口覆盖。这里只读取指定配置层，不是完整 TOML/宿主有效配置解析，也不能证明已运行进程采用当前 shell 的环境。

TCP 探测确认 3085、3443、3445、3543 接受连接，3545 拒绝。3543 的只读 health 返回预期代理 appId、PID
64716、约 38689 秒运行时间，以及 requestedEnabled=false、appliedEnabled=false、state=disabled；入口路径指向当前工作区。路径相同与包版本 0.1.0 不证明新源码已经加载。没有发模型请求、发送管理写请求或重启服务。

插件逐文件摘要核对发现：仓库生成包的 18 个清单文件自洽，但其中 2 个与当前源码不同；现有安装缓存的 13 个清单文件自洽，但其中 6 个与当前源码不同。对当前宿主仅发 initialize 与 hooks/list 的查询以 native_rpc_stream_closed 结束，控制子进程已终止；没有创建聊天、信任 Hook 或重载配置，加载及信任状态保持未验证。

在独立 candidate-final 目录重新构建插件运行闭包：21 个模块与当前工作区摘要一致，复制的 95 个依赖版本匹配插件锁文件。实际 Node 子进程通过 stdio 启动候选 server.cjs，验证只暴露两个只读工具、可信合成捕获入口不在工具列表、原文中文/Unicode 精确读回与摘要一致、跨会话索引/读取拒绝及非法参数拒绝，最后关闭传输。依赖版本匹配不是 registry 字节完整性验收，也未证明安装后的宿主 Hook 执行。

第一次隔离候选复制过滤器误排除依赖包内部的 runtime 目录，stdio 初始化失败；candidate.json 保留失败。最终过滤器只排除插件根 runtime，candidate-final.json 记录成功。未修改业务断言、已安装插件、共享代理或真实认证。源码、仓库生成包和安装缓存均保留原样。

证据目录 `.hpm-acceptance/context-recovery-host-baseline-20261019-01/`
包含 observations.json、health.json、hooks.json、plugin-files.json、两次候选与脚本。此轮没有修改运行源码，不新增源码资格；下面启动候选的完整客户端 2 项失败和全仓门禁阻塞仍然有效。下一步需修复启动、完整传输和容量，再按宿主实际支持方式更新有明确内容身份的插件候选、核验信任/加载与真实连续恢复，不能只覆盖相同 0.1.0 缓存就宣称升级完成。

## 当前阶段（异步启动凭据屏障，2026-10-19，整体未完成）

新增独立启动屏障，管理端口取得后异步写入凭据；目录保护先于文件创建，两个文件的权限设置可以并行等待。持久化确认前管理请求返回 503，业务入口不启动。关闭时立即撤销恢复能力，并等待在途写入结束后释放管理端口，防止晚到写入影响后续进程。保留原同步凭据接口；主入口仅组合依赖。

范围回归与覆盖入口 20/20 通过，范围格式、零警告 Lint、语法及 CI/release 治理通过。范围覆盖语句/行 80.95%、分支 86.06%、函数 90.47%，不替代完整客户端门槛。完整客户端 813 项中 811 通过、2 失败、0 取消/跳过；两项均为原 15 秒期限内未就绪：第一项在 lifecycle 预加载后未进入 server_start，第二项约 14.27 秒开始 server_start、14.35 秒完成 servers_created 后未就绪。该结果不能证明启动问题已修复，没有放宽期限或降低并行度。

隔离包匹配 563 个运行源、575 个构建源和 116 个锁定依赖；包内实际 Node/模块执行 156/156 通过，无失败/取消/跳过。字面全仓 verify 退出 1，仍为相同 404 文件格式问题，日志 SHA-256 为
`6c5fbd7968885629a06ee54c457a8dda244a465f551196fe89bf850d7401df4c`；后续全仓阶段未运行。

证据目录 `.hpm-acceptance/context-recovery-startup-credentials-20261019-01/`
保留修改前缺少异步接口的 0/3 对照及旧生命周期收到异步 writer 后错误返回 200 的 0/1 对照。旧同步 writer 本身不因此判为泄漏。`milestone.json`
确认 12 个冻结输入未变；`final-milestone.json`
复核各阶段日志、包内测试与所有运行源，并绑定最终文档摘要。范围与包内通过不更新真实产品支持清单或生产状态。

本次方案整理补充一次接入助手的检测、配置差异、备份/回退与分层验证设计，并重新读取 OpenAI
Compaction、Codex MCP/插件打包及 Claude Code
Hooks 官方页面。设计补充没有安装插件、修改真实认证或激活生产。

## 此前阶段（Responses 显式空祖先的恢复兼容，2026-10-19，整体未完成）

官方 Responses WS 重连契约允许 `previous_response_id: null`
携带完整窗口重新开始。旧实现将 null 传入私有绑定 ID 校验，且内部 WS 调度器拒绝 null；普通请求可能继续，但无法进入原文自动恢复。三条新增回归在修改前全部失败，覆盖同步/异步协议准入、内部连续性投影和真实压缩 WS 的原文精确读回。

现仅在 Responses 协议边界将 null 解释为未指定祖先，保留外发请求的 null 与完整输入；内部后续只对精确历史后代投影到刚得到的真实 response
ID。会话比较同样允许 null 与省略等价；私有绑定接口仍拒绝 null，已绑定真实祖先的请求仍拒绝替换、省略或用 null 清空。原测试中“无祖先请求携带 null 必须失败”的断言按官方契约改为独立正向测试，其他非法 ID 与祖先篡改断言保持。

HTTP/WS、协议、会话与协调扩大回归 136/136 通过；范围格式、零警告 Lint、语法和 CI/release 治理通过。协议与调度两模块范围覆盖为语句/行 99.73%、分支 91.11%、函数 100%，不替代完整客户端门槛。完整客户端 797 项中 795 通过、2 启动失败、0 取消/跳过；语句/行 98.75%、分支 94.25%、函数 99.07%。两项分别在 lifecycle 预加载后未进入 server_start，以及约 12.83 秒开始 server_start、12.88 秒完成 servers_created 后未在 15 秒内就绪，未证明启动问题已解决。

隔离发布包已匹配 562 个运行源、574 个构建源和 116 个锁定依赖，冻结输入未变；包内实际 Node/模块执行 140/140 通过，无失败/取消/跳过。包内测试只重写模块解析和子进程工作目录，业务断言、期限与门槛保持。

字面全仓 verify 最终退出 1，仍为 404 文件格式问题，日志摘要与此前相同；后续全仓门禁未运行。`final-milestone.json`
再核对九个冻结输入、全部阶段日志、包内测试输入、562 个工作区及包内运行源，并绑定最终两份文档摘要；不将专项或包内通过升级为整体合格。

证据目录 `.hpm-acceptance/context-recovery-null-continuation-20261019-01/`
保留修改前源码、0/3 失败对照、修复后回归及冻结输入。当前真实 socket 用例是在活动连接上提交完整窗口，不能将它描述为断线重连、跨 HTTP/WS 或真实 Codex/Claude 已验收。没有新增依赖、安装插件、修改认证、发起真实模型请求、重启共享服务或激活生产。完整目标继续执行。

## 此前阶段（WS 握手兼容与方案核对，2026-10-19，整体未完成）

补齐恢复传输中被丢弃的选定握手响应元数据，并将上游握手拒绝从 socket
reset 改为有界 HTTP 拒绝。新增独立纯模块校验头与拒绝体：固定允许列表、拒绝访问器与重复头、限制单值及总量，不复制凭据、Cookie 或帧级握手头；两跳独立协商。拒绝体最多 64
KiB、读取绝对期限 10 秒，异常不发布部分原文，不自动重试。连接、握手、拒绝读取及发布持续检查当前授权，撤权关闭连接。

| 检查                      | 握手候选记录                                                                        |
| ------------------------- | ----------------------------------------------------------------------------------- |
| 修改前真实握手回归        | 0/2，复现元数据缺失及上游拒绝变为断连                                               |
| 最终 WS/传输/生命周期专项 | 53/53，通过，无取消/跳过                                                            |
| 范围静态与治理            | 格式、零警告 Lint、3 文件语法、CI/release 治理通过                                  |
| 范围覆盖                  | 语句/行 91.94%、分支 82.82%、函数 100%；不替代全入口门槛                            |
| 实际隔离包                | 562 个运行源、574 个构建源、116 个锁定依赖匹配，源码快照不变                        |
| 包内实际 Node/模块        | 126/126，通过，无失败/取消/跳过                                                     |
| 字面完整客户端            | 793 项，792 通过、1 启动失败、0 取消/跳过；语句/行 98.75%、分支 94.25%、函数 99.07% |
| 字面全仓 verify           | 退出 1，404 文件格式问题，后续全仓门禁未执行                                        |

证据目录为 `.hpm-acceptance/context-recovery-ws-handshake-20261019-01/`。原
`milestone.json` 如实保留首次打包调用漏传 `--prepare`
而在构建前被拒绝；更正调用后的成功见
`isolated-package-final.log`、`package-probe-final.log` 与
`packaged-execution.json`，没有覆盖原失败。包内回归只调整模块解析和子进程工作目录，保持业务断言与期限。

完整客户端仍在 API-evidence
fixture 的 15 秒启动期限失败，约 2.43 秒完成 lifecycle 预加载后没有进入 server_start；未修复启动根因。方案整理再次核对六个冻结输入摘要与包内报告、最终日志，未重跑代码测试。本阶段只形成握手本地资格；取消/steering、任意并发分叉、断连重连、跨 HTTP/WS 及持久混合结果仍待完成。公开 API 文档没有证明特定 Codex 版本必须使用
`x-codex-turn-state`，实际宿主仍需核验。

没有安装插件、变更真实认证、发起真实模型请求、重启共享服务或激活生产。实际 Codex/Claude、容量与保留策略、完整工程门禁及发布仍未完成。

## 此前阶段（恢复位置与能力状态诊断，2026-10-19，整体未完成）

修正诊断与设置页仍将 WebSocket 描述为透传的陈旧状态，改为受限实验路径、完整兼容未验收；新界面继续识别旧代理返回的透传枚举。此状态描述源码能力边界，不代表当前连接已经接管或实际宿主已经验收。加密留存的文案也改为跨重启读回尚未完成验收，避免将缺少产品资格混同于没有实现。

管理 health 的 runtime 元数据新增实际代理主机名和 `DATA_DIR/context-recovery-v1`
绝对目录。总览与设置页共用状态格式化器，标明目录只在开启加密留存后使用，不推断已有数据。路径支持 Windows 和 POSIX，拒绝控制字符、超限、相对路径、访问器和异常对象；使用 textContent 展示，包含 HTML 字样的合法目录不进入 HTML 解析。管理连接失效后清除旧位置。没有将路径、原文或宿主元数据加入日志、模型请求或恢复权限。

回归在改动前的 backend 源码上复现两个失败，保留 before.log。新增与扩展回归沿现有 unit、客户端和前端 CI 入口执行，没有新增依赖或运行模块。首轮 Lint 拒绝控制字符正则，最终改用有界字符码校验，保留原失败，不关闭规则。

| 检查                                     | 本阶段结果                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------------ |
| 定向 backend、格式化器与真实状态刷新模块 | 10/10，通过                                                                    |
| 最终修改范围格式与零警告 Lint            | 通过                                                                           |
| CI 与 release 治理                       | 通过                                                                           |
| 最终前端覆盖入口                         | 7/7 文件通过；语句/行 98.02%、分支 90.20%、函数 96.38%                         |
| 最终前端完整入口与构建                   | 27/27 文件及生产构建通过；保留既有大包警告                                     |
| 字面完整客户端                           | 786 项，785 通过、1 启动失败、0 取消；语句/行 98.82%、分支 94.29%、函数 98.95% |
| 字面全仓 verify                          | 退出 1，404 文件格式问题；后续全仓门禁未执行                                   |

完整客户端唯一失败仍为隔离 API-evidence
fixture 的 15 秒启动期限：约 2.59 秒完成 lifecycle 预加载后，期限内未进入 server_start。另一实例约 14.39 秒监听就绪。这次通过数变化不证明启动问题已修复。

记录在
`.hpm-acceptance/context-recovery-product-diagnostics-20261019-01/`。`milestone.json`
绑定首轮八文件快照与所有门禁，`final-milestone.json`
绑定前端校验写法修正后的最终快照和重跑结果，并证明 backend 与测试输入未变；未重跑与该前端修正无关的完整客户端。此前实际发布包的 119/119 资格属于此前源码，不能用于本阶段；本阶段未重新构建隔离发布包。未进行视觉或实际安装版宿主验收，未安装插件、改变真实认证、调用模型、重启服务或激活生产。完整目标继续执行。

## 此前阶段（恢复转换器按路由加载，2026-10-19，整体未完成）

核心模块加载的 CPU 取证中，失败实例墙钟约 10.79 秒、CPU 约 2.56 秒；文件取证记录 197 次模块解析约 7.89 秒，包含真实路径解析约 1.15 秒，另有 157 次源码读取约 1.55 秒。计时类别有包含关系，不能相加；也不能据此区分所有调度、文件系统与执行成本。两次临时完整诊断分别为 786 项中 783 通过/2 失败/1 取消，以及 784 通过/2 失败/0 取消；它们不替代正式门禁。CPU 与 I/O 独立目录的历史回执保留。显式扩展名的冷进程对照没有减少探测：缺失探测 1073→1098、总探测 1731→1786，加载模块均为 203；未将该试验应用到生产源码，时长差异不当作稳定性能收益。

冷加载回归另复现四类恢复转换器在普通代理入口中提前加载。现将各工厂移到对应转换路径通过既有资格检查后加载；未知/不适用路由不加载，WorkBuddy 继续使用其独立分支。导入位于请求形态拒绝的 catch 之外，四类模块缺失或加载异常保持原错误，不静默沿旧 handler 转发。没有新增模块、依赖、配置或重试策略。

| 检查                                             | 当前冻结候选结果                                                                |
| ------------------------------------------------ | ------------------------------------------------------------------------------- |
| 扩展冷加载与既有转换/WBIPC/transport/lazy routes | 23/23，通过；新增冷加载断言先失败再通过                                         |
| 范围静态与治理                                   | 3 文件语法、格式、零警告 Lint、CI/release 治理通过                              |
| 隔离发布包                                       | 561 个运行源、573 个构建源、116 个锁定依赖匹配，快照不变                        |
| 实际包内 Node/模块                               | 119/119，通过                                                                   |
| 字面完整客户端                                   | 786 项，784 通过、2 失败、0 取消/跳过；语句/行 98.82%、分支 94.29%、函数 98.95% |
| 字面全仓 verify                                  | 退出 1，404 文件格式问题；后续全仓门禁未执行                                    |

两个完整客户端失败均为隔离 API-evidence
fixture 启动超时：第一实例约 2.07 秒完成预加载后没有进入 server_start；另一实例约 13.15 秒进入启动、13.20 秒创建服务器，期限内尚未准备好管理令牌。加密 worker 重开本次通过，不证明此前超时已修复。按需加载已证明减少不适用组件的初始化，但完整启动问题尚未解决。管理令牌现有同步准备保证请求处理前完成凭据持久化，不能不加就绪门禁就换为异步调用。

最终回执
`.hpm-acceptance/context-recovery-lazy-conversion-20261019-01/milestone.json`
复核源码、测试及包内所有运行源摘要；模块解析与工作目录改写仅用于实际包探测，业务断言不变。回归继续沿原 unit/客户端/CI 入口，未放宽期限、并行、断言或阈值。下一步仍需收敛核心依赖解析及安全初始化累计成本，并完成完整 WS、容量保留与真实宿主资格。未安装插件、修改真实认证、调用真实模型、重启服务或激活生产。

## 此前补充取证（启动与加密 worker 阶段计时，2026-10-19，整体未完成）

生产源码沿用上一阶段候选。本次完整客户端诊断运行使用进程内临时 preload，只记录固定导入/原生调用类别、存储打开阶段及单调耗时，没有修改测试期限、并行、断言或覆盖率阈值；786 项中 785 通过、1 隔离代理启动失败、0 取消。此结果是诊断证据，不替代上一阶段字面原门禁失败，也不证明此前 worker 超时已修复。

失败代理的核心模块导入约 11.07 秒，约 13.96 秒才进入 whoami，随后触及原 15 秒启动期限；另一代理核心导入约 3.72 秒，约 14.30 秒完成监听。安全权限初始化也有可见成本，现有证据尚不能把模块导入差异归因于某个单独模块、并发或原生工具。

同次实际加密 worker 的前三次打开约为 7.35、8.80、3.61 秒；密钥保护/解保护分别约 0.84、0.70、0.16 秒。路径准备、所有权建立、文件保护和数据库打开共同占用剩余时间，不能仅凭此前整体超时认定 DPAPI 是根因。worker 本次成功不消除上一阶段 30 秒重开超时的未决状态。

已在原生命周期回归中加入最多 64 条固定阶段名及毫秒耗时，覆盖三次打开、staging、shutdown、close、清理初始化及最终清理，并报告事件循环最大延迟；不输出目录、内容或原生错误。原业务断言与 30 秒期限保持。首次计时 fixture 错误引用未导出的阶段常量，已改为本地固定白名单，原失败日志保留；修正后生命周期 41/41，通过语法、格式、零警告 Lint 与 CI 治理。该文件仍沿统一 unit/客户端/CI 入口运行；新计时版本未重新取得完整客户端资格。

证据及摘要回执位于
`.hpm-acceptance/context-recovery-startup-profile-20261019-02/milestone.json`。下一步继续区分核心模块加载中的执行与等待，以及路径/权限初始化的累计成本；不跳过安全初始化或放宽门禁。未安装插件、修改真实认证、调用真实模型、重启服务或激活生产。

## 此前阶段（可选 WorkBuddy 依赖延迟加载，2026-10-19，整体未完成）

冷子进程回归先复现普通代理入口导入时即加载 WorkBuddy
planner、桌面宿主通信与 WBIPC 恢复入口。现将 HTTP
transport 的执行依赖移到原有目标、认证和凭据检查之后，转换恢复入口只在命中既有 WorkBuddy 官方登录分支时加载 WBIPC 实现；没有改变提供方资格、注入依赖优先级、工具执行或请求重试行为。

同一冷进程回归验证普通路由、空值与不适用凭据不加载可选执行栈，合格 WorkBuddy
transport 和恢复分支仍按需加载；模拟模块导入失败时保留原错误，后续有效初始化不受失败缓存影响。回归位于既有
`context-recovery-converted-http.test.js`，沿原 unit/客户端/CI 入口运行；没有新增运行模块或依赖。

| 检查                                                  | 当前冻结候选结果                                                               |
| ----------------------------------------------------- | ------------------------------------------------------------------------------ |
| 冷加载、转换恢复、WBIPC、transport 与既有 lazy routes | 23/23，通过；原冷加载回归 0/1 失败对照保留                                     |
| 范围静态及治理                                        | 3 文件语法、格式、零警告 Lint、CI/release 治理通过                             |
| 隔离发布包                                            | 561 个运行源、573 个构建源、116 个锁定依赖匹配，摘要不变                       |
| 实际包内 Node/模块                                    | 119/119，通过，含新增冷加载、WorkBuddy 与既有 WS/会话/协调回归                 |
| 字面完整客户端                                        | 786 项，784 通过、1 失败、1 超时取消；语句/行 98.82%、分支 94.29%、函数 98.95% |
| 字面全仓 verify                                       | 退出 1，404 文件格式问题，后续全仓门禁未执行                                   |

完整客户端仍在隔离代理启动 15 秒期限失败：约 2.36 秒完成预加载后没有进入 server_start；另一 fixture 约 12.92 秒开始服务启动、14.98 秒完成监听。真实加密 worker 的 staged 清理与连续重开用例本次在 30 秒超时，未证明与启动失败同源。模式切换本次约 8.21 秒完成两轮请求，不能据此宣布此前问题已修复。延迟加载已证明改善依赖边界，但没有解决全部启动成本；未调整测试期限、并行或覆盖率门槛。

阶段目录 `.hpm-acceptance/context-recovery-lazy-startup-20261019-01/`
保留修改前源码、原失败、最终回归、完整失败日志、范围检查、隔离包及
`milestone.json`。回执复核当前候选摘要及全部包内运行源；测试只改模块解析与冷子进程工作目录以指向实际发布包，保持业务断言。下一步对加载后到 server_start 的安全初始化及真实 worker 重开继续取非内容性阶段计时。本阶段未安装插件、修改真实认证、调用真实模型、重启服务或激活生产。

## 此前阶段（WS 普通错误保真及集成失败取证，2026-10-19，整体未完成）

普通转发的 WS 请求收到上游 `error`、`response.failed` 或 `response.incomplete`
时，旧 turn 会进入完成响应解码并断开连接，客户端拿不到原错误。现先等待本轮未提交分支的 abort
ACK，再原样发送这些事件；失败输出不登记完成快照，不自动重试请求，连接可以接受客户端选择的下一轮。已注入私有结果或进入内部恢复的错误继续留在恢复边界内，不向客户端暴露内部工具和原文。

真实 socket 回归用前阶段发布包的原 turn 源码、当前工作区依赖和同一测试参数复现三个终态全部断连，再对新源码确认三种事件完整返回、零失败快照及下一轮成功。另覆盖等待 abort
ACK、abort 拒绝、撤权、发送失败，以及待合并私有工具结果注入后的错误不泄漏、不重放。初始 fixture 曾误发 binary
Buffer，在进入上游前被正确拒绝；改为协议要求的文本消息后，另存旧 turn 的有效失败对照。后续两项断言修正分别比较 JSON 传输值和终态数量，保留全部字段及隐藏数据检查，未修改期限、并行或覆盖率门槛。

| 检查                               | 当前记录                                                                   |
| ---------------------------------- | -------------------------------------------------------------------------- |
| 协调/异步/会话/WS 专项             | 99/99，通过                                                                |
| HTTP、root、历史与既有 WS 扩大回归 | 191/191，通过；范围与此前 192 项不同，不累计或直接比较数量                 |
| 范围静态与治理                     | 格式、无警告 Lint、生产模块语法、CI/release 治理通过                       |
| 隔离包                             | 561 个运行源、573 个构建源、116 个锁定依赖匹配，源码及依赖闭包不变         |
| 包内实际 Node/模块                 | 99/99，通过                                                                |
| 完整字面客户端                     | 784/785，1 失败、0 取消/跳过；覆盖语句/行 98.82%、分支 94.29%、函数 98.95% |

新增非内容性阶段计时与事件循环最大延迟。较早 trace 完整客户端为 774/775，失败代理没有 stdout 或 server_start 阶段；新冻结候选 784/785 中，同一代理仍未就绪，但子进程在约 0.65 秒进入 preload，约 2.17 秒完成 catalog/crypto/lifecycle 预加载，剩余时间尚未进入服务器启动。另一 direct-upload
fixture 在约 11.60 秒进入 server_start，约 13.11 秒完成监听。这排除了“子进程根本没启动”的推断，但尚未定位预加载后到启动前的具体耗时点，也不能断言并发是唯一原因。模式切换当前两次 trace 均通过，不能反证此前 HTTP 请求失败已修复。

当前阶段证据目录为
`.hpm-acceptance/context-recovery-integration-diagnosis-20261019-01/`，包括冻结摘要、原失败、新回归、完整门禁日志、实际包探测及已验证的
`milestone.json`。当前全仓 verify 重跑仍因 404 个文件格式问题退出，后续阶段未运行。额外的有界无内容 profile 将失败窗口缩小到
`core-request-handler`
模块加载：失败实例约 2.05 秒进入该导入后未返回，另一实例该段约 5.04 秒。后续嵌套 profile 的失败实例记录路由导入约 2.51 秒、WorkBuddy
HTTP
transport 约 1.89 秒、恢复生命周期约 1.06 秒，累计到约 14.22 秒才开始系统身份初始化。该嵌套实验保存在
`client-startup-profile-nested.log` 和
`startup-profile-419340.json`，不计入原门禁通过证明，也未写入此前回执；证据支持继续检查累计启动成本，尚不证明单一模块或并发是根因。此前 WS
cache 阶段也已补真实失败汇总
`milestone.json`，两份回执均明确为专项/包内通过、完整客户端及 verify 失败，不授予发布资格。本阶段未新增运行依赖、安装插件、改变真实认证、调用真实模型或激活生产，整体目标保持未完成。

## 此前阶段（WS 连接缓存与混合工具续接，2026-10-19，完整客户端门禁仍失败）

公开
[OpenAI WS 契约](https://developers.openai.com/api/docs/guides/websocket-mode.md)
明确：每条 lane 保留最近响应的连接内缓存，`store:false`
无持久回退。此前测试桩没有模拟缓存失效，内部恢复每轮一直引用最初响应 ID 的问题未被覆盖。新真实 socket 回归只接受最新缓存 ID，先复现失败；独立
`context-recovery-websocket-dispatch`
现在对完整输入和前轮输出做精确指纹匹配，只有确切后代才改为最新响应 ID 并仅发送增量。配置、原始输入和工具参数不被原地修改；错误、未知或不同分支不被猜测重写。保留逐项摘要，避免额外保存原文，也避免合法请求和响应分别在限额内、合并摘要时却超过 2
MiB 的错误。

混合轮次通过仅由 WS 组合层传入的 `deferMixedResults`
能力处理。代理完成内部只读查询后保留当前上游真实响应 ID，仅发布外部调用；不通过额外模型生成让该 ID 失去缓存。`context-recovery-websocket-continuation`
将已完成的内部结果在下一次客户端工具结果前合并。普通 HTTP 协调器沿用原混合轮次行为。该连接内桥接最多 256 条、合计 2
MiB，继承原 root 绝对到期时间；原会话失效、撤权、到期、坏时钟或连接关闭时清除。暂存、提交和丢弃使用进程内能力 token；公开响应 ID 本身不授予读权限，下一请求必须重新通过现有会话和策略绑定。重复私有结果不能由客户端替换或再次注入。

真实 socket 测试覆盖 `store:false`
下两次纯内部精确读回，以及连续混合索引/外部调用、混合原文读取/外部调用和最终续接。检查每轮真实缓存 ID、完整工具配对、精确 Unicode、零隐藏事件外泄和没有额外生成。另一回归持有最终发布确认，确认另一条 lane 的后代排队等待；确认失败会撤回分支并清空排队，不向上游发送已撤回的私有结果。桥接另覆盖非法输入、getter、授权、克隆隔离、配额、绝对到期和空闲清理。这些都是本地合成上游，未调用真实模型。

| 检查                          | 当前冻结源码结果                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| Node 22 聚焦协调/异步/会话/WS | 89/89，通过                                                                          |
| Node 22 扩大回归              | 192/192，通过，含 HTTP/转换、root 状态/所有权、既有 WS 生命周期及 header 隔离        |
| 范围静态与治理                | 语法、格式、无警告 Lint、CI/release 治理通过；新模块在发布清单，测试沿统一入口发现   |
| 隔离发布包                    | 561 个运行源、573 个构建源、116 个锁定依赖匹配；源码未变、目录治理通过               |
| 包内 Node 和模块执行          | 同一四文件测试 89/89，通过；仅重写测试的模块解析路径                                 |
| 字面完整客户端最终复跑        | 774/775，1 失败、0 取消/跳过；覆盖语句/行 98.81%、分支 94.20%、函数 98.95%，门槛未变 |
| 字面全仓 verify               | 退出 1，404 个文件格式问题，后续全仓阶段未运行                                       |

完整客户端首次记录为 775/775，期间为修复 Lint 做了两处局部语法调整，因此随后按冻结源码复跑。第一次冻结候选复跑失败于隔离代理启动，阶段停在证书就绪；第二次失败于加密模式切换后的 HTTP 请求。两次失败均保留。相应用例分别单跑为 2/2 与 1/1 通过，不能据此证明完整套件通过，也尚不能把两类失败认定为同一原因或归因于并发。没有调整超时、覆盖率、断言、统一测试命令或内部并行度。

隔离包第一次因快照后修复 Lint 导致 `release_isolated_source_changed`
被正确拒绝；失败记录保留，随后在源码稳定后重建并通过。早期边界测试的 null-prototype 对象比较失败也保留，断言调整为比较实际 JSON 传输值，仍验证每个字段、参数、顺序和原输入不变。依据为
`.hpm-acceptance/context-recovery-ws-cache-20261019-01/` 内的
`source-snapshot.json`、`scope.json`、`packaged-execution.json`
及各次测试日志。后续在修改 WS turn 前，补齐并验证历史
`milestone.json`：561 个包内生产源及对应工作区摘要匹配，完整客户端两次失败如实记录；没有把该失败阶段升级为整体合格。

当前桥接仅在同一活动连接中保留待合并结果，不冒充跨重连、跨 HTTP/WS 或跨重启的完整恢复。任意并发多流分叉、取消/steering、错误和握手保真、真实提供方/官方登录、容量留存、实际客户端及完整工程门禁仍待完成。最近两个完整客户端失败继续作为待定位项；不能因为 WS 专项和包内测试通过而报告本候选整体合格。未安装插件、改变真实认证、启用生产恢复、重启共享服务或发起真实模型请求；完整目标保持未完成。

## 此前阶段（WebSocket 消息恢复与增量连续性，2026-10-19，完整兼容未完成）

新增独立 wire、turn、connection、transport 模块，`ws@8.22.0`
声明为直接运行依赖并进入发布闭包。使用成熟帧实现处理压缩、分片、UTF-8 和掩码；消息大小、队列字节、多流数量、单流 FIFO、活跃请求、事件数量和请求期限有界。接管仅用于受信配置准入的 Responses 路径，当前请求持续复查入口身份、profile 和凭据出处。外部工具仍交客户端执行，内部只读工具不发布给客户端。

初轮真实 socket 超时发现原始生命周期暂停后没有恢复 ws 的客户端读取，补
`client.resume()`
后通过。后续第三次客户端请求失败，现保留原失败日志，并将测试等待器改为在连接关闭时立即拒绝，避免用 15 秒超时掩盖真实失败位置。根因是把已经验证的
`previous_response_id`
增量输入交给完整窗口的私有历史映射。Responses 服务端续接现在保留其 ID 与输入增量，不重复插入祖先私有交换，也不为该服务端续接建立完整窗口映射；无 ID 的完整窗口继续走原映射。恢复能力还验证传入 body 的响应 ID 与准入请求完全一致，拒绝增加、替换或省略已绑定的服务端祖先。

真实压缩/分片连接回归连续发送四次客户端请求，包含两次索引/精确 Unicode 原文读回、后续空增量，共八轮上游响应；验证同一 root、输入增量和响应 ID 保持、内部工具不外泄。另覆盖多流交错与同流 FIFO、非法身份/序列/消息、撤权、断连、超时、发送失败、队列额度及关闭时释放占用。实际加密 SQLite 内存库测试持有真实写后的 ACK，确认 ACK 前没有客户端输出，非法 ACK 安全失败；不能将该用例表述成物理 worker 或安装版的端到端证明。

| 检查                  | 当前候选结果                                                                        |
| --------------------- | ----------------------------------------------------------------------------------- |
| Node 22 WS 与会话专项 | 30/30，通过                                                                         |
| Node 22 扩大回归      | 121/121，通过，含既有 WS 生命周期、HTTP、协议、历史及 root 状态                     |
| 字面完整客户端覆盖    | 763/763，通过，0 失败/取消/跳过；语句/行 98.79%、分支 94.16%、函数 98.93%，阈值不变 |
| 范围静态与治理        | 语法、Prettier、无警告 ESLint、CI/release 治理通过；新增测试进入统一客户端入口      |
| 隔离发布包            | 559 个运行源、571 个构建源、116 个锁定依赖匹配；源码快照未变、目录治理通过          |
| 包内执行              | 包内 Node 与真实包模块、`ws@8.22.0` 执行相同 WS/会话测试 30/30，通过                |
| 字面全仓 verify       | 退出 1，404 个文件格式问题；后续全仓阶段未运行                                      |

最终阶段回执见
`.hpm-acceptance/context-recovery-ws-messages-20261019-01/milestone.json`。初始、恢复读取前后、连续性失败和最终结果分别保留，不累加历史通过数。包内测试只重写测试的模块解析指向实际发布目录，没有改动业务断言或测试期限；发布模块与工作区摘要逐项匹配。

当前仅形成受支持 `response.create`
轮次的本地资格，尚未完成取消/steering、错误透传、握手响应细节、同 root 多流分支、重连、跨 HTTP/WS 恢复及混合外部工具下服务端 ID 续接的完整兼容。API
WS 的服务端历史与缓存可用性、官方登录形态和真实 Codex/Claude 未验收。容量/保留、在线失效分支清理、完整门禁、UI 支持矩阵、实际安装采用和生产激活仍待交付。没有启用生产恢复、安装插件、改变真实认证、重启共享服务或调用真实模型；整体目标保持未完成。

## 此前未合格增量（WebSocket 消息级恢复，2026-10-19）

已有基于 `ws` 的消息传输、连接调度、单轮内部恢复和协议校验草稿，并将 `ws@8.22.0`
声明为直接运行依赖。现有日志
`.hpm-acceptance/context-recovery-ws-messages-20261019-01/publication-after.log`
记录 9 项测试中 8 项通过、1 项超时取消；失败项是实际压缩/分片 WS 下私有读回后继续下一次客户端请求。尚未定位根因，不能将此前短序列通过作为当前连续性通过。

当前草稿没有最终里程碑回执、完整客户端复跑或包含新依赖的新隔离发布包资格。取消/steering、同 root 多流、重连、HTTP/WS 并发及实际 Codex/Claude 仍待验证。此前生命周期和存储回执仅对应各自冻结快照。主方案第 0 节汇总交付顺序；本次仅整理文档，没有重跑测试、安装插件、发起模型请求或重启服务。

## 此前合格增量（WebSocket 连接生命周期，2026-10-19，消息级恢复未完成）

实际 upgrade 已接入独立
`websocket-lifecycle`：凭据等待期间断开不再产生迟到请求，客户端关闭会销毁待升级的上游请求；两端 EOF/错误关闭连接，迟到的 upgrade
socket 被销毁。升级后的错误只关闭连接，不再向已升级的字节流写 HTTP
502。握手前 head 与后续原始字节合计上限 2
MiB，几何增长缓冲避免小块数据导致无界对象分配；完成握手后先暂停，再恢复全部输入，交回原生 pipe 背压。日志改为固定事件码，路径、查询、profile
ID 和原生异常不进入该模块日志。

回归先复现旧版两个取消缺陷。初轮真实 socket 用例和 Node 22
mock 隔离失败记录保留：测试中的半关闭上游在 EOF 后主动关闭其写端，同一测试两次 mock 改成独立测试，既有 header 隔离 fixture 补齐实际 socket 的 resume 契约。没有提高期限或删除业务断言；最终真实网络回归覆盖客户端取消、head 和提前分块完整有序到达。

| 检查                   | 冻结候选结果                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------- |
| Node 22 WebSocket 专项 | 17/17，通过                                                                        |
| Node 24 扩大专项       | 30/30，通过，含 header 隔离、连接守卫和代理传输                                    |
| 完整客户端             | 753/753，通过；0 失败/取消/跳过                                                    |
| 新生命周期模块覆盖     | 语句、行、分支和函数均 100%                                                        |
| 两个 WS 模块合计覆盖   | 语句/行 88.88%、分支 80.48%、函数 100%，未放宽任何既有门槛                         |
| 范围静态及治理         | 格式、无警告 Lint、CI/release 治理通过；新模块进入发布清单，新测试由统一 unit 发现 |
| 字面全仓 verify        | 退出 1，404 个文件格式问题；后续阶段未运行                                         |

冻结摘要、失败对照及回执见
`.hpm-acceptance/context-recovery-ws-lifecycle-20261019-01/final2/milestone.json`。这是实际原始 upgrade 的生命周期修复，不是 WebSocket 消息级内部恢复；本批没有为新增 WS 模块重新制作隔离安装包，也没有安装宿主或生产激活证据。此前存储隔离包资格保持对应原候选，不替代当前发布资格。

另只读确认本机 Codex CLI
`0.160.1`，用户配置为 Responses、`localhost:3085`、要求 OpenAI 认证；Claude Code
`2.1.292`，全局配置指向
`api.deepseek.com`。尚未核对项目覆盖与实际流量、HTTP/WS、Desktop/IDE 版本。没有输出凭据或改变配置。公开 API 的 WS 多流并发/分叉契约已补入主方案，不能由此推定 Codex 官方登录端点支持相同形态。

剩余首发路径仍包括消息重组与压缩、多流调度、内部恢复、共享发布事务、容量/保留策略、实际 Codex/Claude 验收、完整门禁及发布。`goalComplete:false`、`productionActivation:false`、`websocketRecoveryImplemented:false`。

## 此前合格源码快照（启动遗留 staged 回收，2026-10-19，整体未完成）

新增独立
`context-recovery-storage-staging`，在新所有者 session 初始化的 discovery 屏障内回收旧所有者遗留的不可导入 staged 原文。先验证整个有界 catalog、全部记录与 staged 字节，并复查稳定代次，再规划所有写入；原 revision
CAS 写回，严格 ACK、认证读回摘要与最终更新 catalog 复查。仅删除 stagedSources，保持 root、已发布原文与 ID、publication
journal、预算、计数、创建时间、绝对期限和字段版本。空 stage 不写，修订号溢出在任何写入前拒绝。

所有存储 await 前后检查当前所有者生命周期；关闭、读回不一致或存储失败保持启动失败，不授予会话权限、不重试模型或外部工具。每 root 独立提交：中途失败可已清理前一 root，但本轮不登记任何 root；新 owner 完整扫描后只处理剩余 stage。这不是跨 root 全局事务，也不清理仍活跃的在线 pending 数据。

回归覆盖正常与空、上限、损坏、后续 root 损坏、写失败、错误及可执行 ACK、缺失或不一致读回、catalog 变化、CAS/关闭竞争、多 root 部分失败后的新 owner 续清；真实 Windows
DPAPI/SQLite
worker 经关闭、初始化清理、再重开保持结果。初始缺陷复现、摘要封装与物理 fixture 参数失败日志保留；未通过调整期限/并行/阈值或移除断言制造通过。

| 检查                                 | 当前冻结源码结果                                                                                     |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Node 22 生命周期                     | 41/41，通过                                                                                          |
| 扩大专项                             | 176/176，通过                                                                                        |
| 字面完整客户端                       | 753/753，通过；0 失败/取消/跳过                                                                      |
| 覆盖率                               | 语句/行 98.90%、分支 94.34%、函数 99.01%，原阈值保持                                                 |
| 范围静态/统一发现                    | 语法、格式、无警告 Lint、unit/client 注册通过                                                        |
| CI/release/composition/coverage 治理 | 通过                                                                                                 |
| 实际隔离发布                         | 554 运行源、566 构建源、115 锁定依赖匹配，源码摘要不变                                               |
| 包内实际执行                         | 生产模块清 stage、root/计数/预算/TTL 保持、CAS；无启动权限；当前请求重新授权后已发布原文精确读回通过 |
| 字面全仓 verify                      | 退出 1，404 文件格式问题；后续全仓阶段未运行                                                         |

证据为
`.hpm-acceptance/context-recovery-staging-20261019-01/milestone.json`。包内探测使用包内 Node
v22.22.3 和实际 SQLite 内存库；真实 Windows 加密文件关闭/清理/重开是另一项物理用例，不拼接为安装版物理端到端资格。新模块进入 release，回归进入原生命周期测试文件和统一 unit/client/CI；无新依赖。

在线失效分支的数据与内存额度回收、容量/保留策略、实际 WS、真实 Codex/Claude、完整工程门禁、产品发布与回滚仍待交付。`goalComplete:false`、`restartRetention:false`、`productionActivation:false`；未安装插件、调用真实模型、修改真实认证或重启生产。

## 此前合格源码快照（schema 准入与事务回滚，2026-10-19，整体未完成）

新增独立结构准入模块，检查 v1 版本、application
ID、完整规范 DDL 和预期对象，拒绝额外表/索引/视图/触发器、临时对象、未知列、缺失约束或 STRICT、超长元数据及未知版本。启动在磁盘 PRAGMA 和应用表读取前检查，所有事务在
`BEGIN IMMEDIATE`
内复查，新建提交前验证完整结构。未知布局固定安全失败，不迁移、覆盖或回填权限。

另修复启动首次结构检查后、读取 header 前的跨连接改库窗口：header、容量读取与启动回收现均位于锁内复查之后。真实双连接回归证明在获取锁前改结构时，应用表读取为零，原文/时钟不变；真实进程在首次建库 COMMIT 前退出后，SQLite 恢复空结构/版本，随后可完整初始化。

初轮 27 项中 25 通过、2 失败的日志保留。旧触发器故障 fixture 改为受控数据库 facade，在真实 upsert/delete 之后抛错；明确确认两条撤销更新、原文更新和到期删除确实发生，再核验全部密文、revision 和认证时钟回滚。故障错误仍只返回固定码，未放宽期限、阈值、并行或业务断言。非平凡逻辑独立模块，新模块进入 release 清单，新回归由原测试文件进入统一 unit/客户端/CI。

| 检查                                 | 当前冻结源码结果                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------------------- |
| Node 22 存储与维护                   | 29/29，通过                                                                         |
| 扩大专项                             | 113/113，通过，含真实 Windows worker、双连接竞态和进程崩溃                          |
| 字面完整客户端覆盖                   | 746/746，通过；0 失败/取消/跳过                                                     |
| 覆盖率                               | 语句/行 98.89%、分支 94.34%、函数 99.01%，原阈值保持                                |
| 范围语法/格式/Lint                   | 通过，无 Lint 警告；统一 unit 发现确认                                              |
| CI/release/composition/coverage 治理 | 通过                                                                                |
| 实际隔离发布                         | 553 运行源、565 构建源、115 锁定依赖匹配，源码摘要不变                              |
| 包内实际 Node/模块/helper            | DPAPI 互通、读取上一合格包生成的规范 v1、异常启动/在线结构拒绝及密文/时钟保持均通过 |
| 字面全仓 verify                      | 退出 1，404 文件格式问题；后续全仓阶段未运行                                        |

证据和冻结摘要见
`.hpm-acceptance/context-recovery-schema-20261019-01/milestone.json`。范围 Lint/语法/格式只证明记录范围，隔离包不是实际安装宿主验收。没有修改无关文件以消除全仓格式失败，没有安装插件、修改真实凭据、调用真实模型或重启生产。

结构准入不代表通用迁移器完成；有效 root 的 staged 整理、容量/保留策略、真实 WS、实际 Codex/Claude、完整工程门禁及灰度回滚继续推进。`goalComplete:false`、`restartRetention:false`、`productionActivation:false`，整体未交付。

## 此前合格快照（原生 DPAPI helper 与隔离发布包，2026-10-19，客户端门禁通过，整体未完成）

新增独立 Rust crate
`native/context-recovery-key`，主入口仅组装参数和标准流，库模块负责精确 JSON/字段/规范 Base64 验证、Windows
DPAPI 与有界读写。使用原有 CurrentUser、`hpm/context-recovery/data-key/v1`
熵值和 `hpm-context-dpapi-v1:`
包装格式；新保护结果在同一进程内先解保护并比较，再返回成功。与旧 PowerShell 实现真实双向互通，无密钥格式迁移或明文替代。密钥只经 stdin/stdout 管道传输；固定协议错误不包含输入或原生异常。

Node 密钥边界优先使用应用内
`runtime/native/hpm-context-recovery-key.exe`，验证普通文件、单硬链接和非 junction/符号链接祖先；仍保留原 10 秒进程期限、缓冲上限和最小环境。没有已构建 helper 的源码检出保留原固定 PowerShell 后端；已分派原生调用失败时不通过其他后端重试。发布目录门禁要求 helper 存在，隔离发布同时核对其 SHA-256。

新增构建脚本使用独立 Cargo.lock 和 release 构建，产物先完整暂存再改名。`test:unit`、后端覆盖和客户端覆盖的前置步骤构建相同 helper；原客户端 c8 命令、测试列表、阈值、期限和并行策略未修改。统一 verify 增加
`test:recovery-native`，包含 Rust 格式、拒绝警告的 all-targets
Clippy 和测试；Windows
CI 增加相同入口及该锁文件的依赖审计。发布包携带 helper，使用者不需要 Rust 工具链。

| 检查                                                         | 最终源码结果                                                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| 扩大专项                                                     | 61/61，通过，包含真实 DPAPI 互通、物理清除/重开、硬链接/junction、严格输入和发布治理 |
| 原生 Rust                                                    | 3/3，通过；格式、Clippy 通过；依赖审计无漏洞                                         |
| 完整字面客户端覆盖                                           | 742/742，通过，0 失败/取消/跳过                                                      |
| 客户端覆盖率                                                 | 语句/行 98.89%，分支 94.34%，函数 99.01%，门槛不变                                   |
| 原失败的物理清除/重开                                        | 完整负载约 14.7 秒，在原 30 秒期限内通过                                             |
| 隔离发布                                                     | 552 个运行源、564 个构建源匹配，115 个锁定依赖匹配，目录与 helper 摘要通过           |
| 包内实际执行                                                 | 用包内 Node v22.22.3、模块与 helper 完成真实保护/解保护，恰好两次原生调用            |
| 范围语法、Lint、格式；CI、release、composition/coverage 治理 | 通过                                                                                 |

完整客户端使用 Node v24；隔离发布及包内探测使用具备 npm 的 Node
v22.22.3。首次用不含 npm 的捆绑 Node 准备隔离发布时失败，原失败记录保留；后续用开发发行版 Node 在新隔离目录中完成最终源码构建与验证，没有复用失败目录冒充新鲜结果。包内测试不是已安装宿主或完整 Node
22 客户端套件验收。

最终门禁、冻结摘要、失败对照和包内执行回执见
`.hpm-acceptance/context-recovery-native-helper-20261019-01/milestone.json`；最终源码日志位于该目录
`final/`。原 737 项负载超时保留在上一阶段，不被此次独立或完整通过覆盖。完整 verify 仍需消除全仓格式失败后运行其余阶段；未启用生产恢复、修改真实认证、安装插件、重启服务或调用模型。`restartRetention`
的产品资格仍为 false；清理迁移、容量与保留策略、实际 WS、真实宿主及发布激活继续保留在完整目标中。

## 此前候选（清除撤销、结束查询与有界轮询，2026-10-19，整体门禁仍失败）

prepared 操作现在可经严格确认的 POST
cancel 原子变为 cancelled，迟到或重传的 start 返回同一终态，不执行清除。running 或已终结操作的取消只返回实际状态，不中断清除、不改写终态。管理鉴权、Origin 防护、128 字节精确输入、方法与 Rust 桥白名单均覆盖新增入口。

页面提供两个不同的明确确认操作：撤销未启动操作，以及结束本页结果查询。后者必须完成 sessionStorage 删除读回才释放当前查询，不发送后台请求，不代表旧操作成功或失败；再次清除仍需新确认。running 状态每次查询完成后间隔 1 秒、最多 30 次自动 GET；每请求保留原 10 秒期限，未知即停止自动查询，手动查询保留。不会自动重发 start。

真实隔离 Chrome 与实际管理 router、合成生命周期验证了取消、迟到启动、页面重载仅 GET、真实定时查询、丢失响应后结束查询不发送请求，以及再次清除独立确认。浏览器验证不是实际安装宿主或真实模型验收；实际独立代理鉴权集成验证取消入口拒绝无管理 token、仅入口 key 和恶意 Origin，全段管理测试没有上游调用。

| 检查                                                                | 本轮最终结果                                                         |
| ------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 扩大专项，含实际 Windows 加密库清除/重开                            | 48/48，通过                                                          |
| 完整字面客户端覆盖                                                  | 737 项，736 通过，1 项超时取消，退出 1                               |
| 客户端覆盖率                                                        | 语句/行 98.89%，分支 94.33%，函数 99.01%；阈值不变                   |
| 前端 / 前端覆盖入口                                                 | 27/27 文件、7/7 文件，通过；语句/行 97.98%，分支 90.12%，函数 96.34% |
| Rust 桥 / Clippy                                                    | 2/2，通过；all-targets、拒绝警告，通过                               |
| 范围 Lint、格式、语法；CI、release、composition/coverage 治理；构建 | 通过                                                                 |
| 字面 verify                                                         | 格式门禁报告 404 个文件，退出 1；后续阶段未执行                      |

完整客户端的同一物理测试仍在原 30000ms 期限取消：种子库关闭约 11.8 秒，内存模式清除约 20.7 秒，第三次重开尚未完成。独立计时诊断保留测试原期限，完成实际清除/重开/拒绝旧写入；只记录工具类型、线程、耗时与成功位，没有参数、路径、原生输出或密钥。三次打开共启动 3 次 PowerShell、24 次 icacls、3 次 whoami；本次隔离 PowerShell 约 1.35–1.94 秒。该结果确认原生调用成本，不证明全量并发下的唯一根因，更不能替代完整失败结果。

回执及冻结源码摘要位于
`.hpm-acceptance/context-recovery-clear-finalization-20261019-01/milestone.json`；原失败日志保留。未改变超时、断言、覆盖率或并行策略，未批量格式化无关文件、安装插件、启用生产恢复、重启服务或调用真实模型。下一步仍需修复全量负载下原生启动稳定性，再推进清理迁移、实际 WS、真实宿主和完整发布。

## 此前候选（清除操作编号、终态查询与页面续查，2026-10-19，整体门禁仍失败）

方案复核补充：下述回执只覆盖已记录的两阶段清除候选。当前工作区另有 prepared 撤销、本地结束查询和最多 30 次自动 GET 查询的源码及测试草稿，尚未获得修改后验证回执；下文“没有自动轮询”等描述指已记录快照，不代表后续草稿。新增代码存在不等于已合格，本次仅整理方案。

新增两阶段管理协议：先取得 prepared 操作编号，页面写入并读回 sessionStorage 后才发送带明确确认的 start。准备和 GET 查询不执行清除；同编号在运行中和终态均幂等，其他编号在已有操作运行时不能启动。只有严格 runtime
ACK 能形成 succeeded，非法或拒绝 ACK 形成固定失败，不输出原生异常。

registry 最多 32 条，只存编号、状态和期限；prepared／终态从创建起 30 分钟到期，running 不回收，时钟水位不回退。过期或未知编号从不重建；服务重启丢失进程内状态后旧编号不能执行，也不能据此认定清除成功。原同步接口继续兼容。每次管理请求沿用 10 秒期限。

页面不确定时保留编号，刷新后仅 GET，不重发 start；新增“查询清除结果”按钮。存储不可用不发送 start；查询看到 prepared 也可能有延迟 start 在途中，继续保持未知。当前没有自动轮询或应用层重试；未知且无法恢复的旧操作仍缺后续处理流程，不能用 health 或新编号冒充旧结果。

新增 6 项 registry／HTTP、6 项前端 client、2 项控件续查回归，进入统一 CI 与覆盖入口；新模块进入 release。实际隔离代理验证 prepare/start/status 拒绝无管理 token、仅入口 key 和恶意 Origin，完整操作与重复启动通过，模型上游调用为零；浏览器／桌面桥合成链路通过。

| 检查             | 本轮结果                                                                                                                          |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 扩大专项         | **36/36，通过**，含独立真实 Windows 清除／重开                                                                                    |
| 字面完整客户端   | **733 项中 732 通过，1 超时取消，退出 1**；原物理清除用例仍触发 30 秒期限，deadline、断言、并行方式保持                           |
| 客户端覆盖率     | 语句／行 98.89%、分支 94.32%、函数 99.00%；不抵消超时                                                                             |
| 前端／覆盖率     | **27/27 文件、7/7 文件，通过**；语句／行 97.81%、分支 89.24%、函数 96.05%                                                         |
| 静态、治理、构建 | 范围 Lint／格式、CI/release、composition／coverage 治理、前端构建通过；Rust 管理桥 **2/2**、all-targets Clippy `-D warnings` 通过 |
| 字面全仓 verify  | 退出 1，仍停在 **404 文件格式问题**，后续阶段未执行                                                                               |

隔离 Chrome 使用实际控件、client、HTTP
management/router 与合成 lifecycle。响应前断连导致 Chrome 自动重传同编号 POST，后台只执行一次；首次等待“未知”的假设因此失败，轨迹保留。补充响应已开始后中断，验证真正未知；两种场景刷新后均仅查询并最终确认，一次清除。断言调整针对已观测的传输行为，原重复执行防线保持；不代表完整 Tauri 或真实存储／客户端验收。

证据为
`.hpm-acceptance/context-recovery-clear-operations-20261019-01/`，保留首次空 body 边界失败、修复后专项、完整客户端失败、浏览器诊断和门禁。整体仍缺物理启动稳定性、用量／目录／保留策略、staged 整理迁移、WS、真实 Codex／Claude／模型及完整发布；`restartRetention:false`，未安装插件、修改真实凭据、请求模型或激活生产。目标继续执行。

## 此前候选（加密留存与主动清除界面，2026-10-19，前端门禁通过，整体未完成）

设置表单已独立读写
`contextRecoveryPersistenceEnabled`，保持既有默认关闭与配置归一化；新增实验性加密留存控件，明确原期限不延长、跨重启读回尚未完成验收。自动恢复说明不再将所有模式描述为仅内存。

新增独立 `context-recovery-controls`，composition
root 仅注入并绑定。清除对话说明代理原文、插件独立库、原生聊天、审计的范围，以及清除后继续按已保存设置捕获。确认和请求期间禁用重复点击；仅在后端返回精确 ACK 后显示成功。使用固定状态文本和 textContent，不渲染原生异常或服务端错误内容；网络失败、非法 ACK、超时均显示结果未知并阻止页面内重复提交，不自动重试。桌面原生桥仅新增固定 POST 清除路径的白名单，沿用管理认证和现有 10 秒期限，GET 与路径后缀仍拒绝。

**当前仍有操作查询缺口。**
原生桥可能在实际清除完成前结束等待；中止前端等待不证明后端已停止。结果未知后本页禁止再次清除，但尚无持久操作编号和只读终态查询，不能通过 health 把它提升为清除成功。该缺口与完整客户端物理启动期限问题保留，后续补操作状态协议并做实际桌面／真实存储闭环；本轮不放宽既有 deadline。

新增 8 项前端行为／安全回归，进入统一前端测试与覆盖率入口；现有表单回归验证两个设置独立往返，现有桥测试验证浏览器与桌面 native
IPC 都只发一次固定 POST，renderer 不传管理凭据。前端
**26/26 文件通过**；覆盖率运行
**6/6 文件通过**，语句／行 97.45%、分支 87.46%、函数 95.23%，保持原门槛。范围 Lint 无警告与格式检查、CI/release 治理、composition
root、前端构建通过；构建保留既有大 chunk 提示，未提高警告阈值。Rust 管理桥
**2/2 通过**，范围 rustfmt 检查通过。

Rust all-targets Clippy 在 `-D warnings` 下通过，未新增依赖或放宽规则。

隔离 Chrome 组件检查使用实际 HTML 控件、构建 CSS 和生产控件模块，连接合成管理服务，验证取消零请求、留存开关独立、处理中禁用、成功 ACK、失败固定反馈和无页面错误；不读取生产配置或连接生产服务。首次 Playwright 默认浏览器缺失，使用已安装 Chrome 的独立临时 profile 后通过，没有下载浏览器。此证据不代表完整管理应用或已安装 Tauri 的端到端验收。

本轮证据位于
`.hpm-acceptance/context-recovery-ui-20261019-01/`。未重跑完整后端客户端或全仓 verify，不以本轮前端通过覆盖下节保留的 727 项中 1 项超时，以及此前全仓格式失败。用量／目录／保留策略、操作查询、物理启动稳定性、staged 清理迁移、WS、实际客户端／模型和发布仍待完成；`restartRetention:false`，未安装插件、请求真实模型或激活生产。整体目标继续执行。

## 此前候选（主动清除后端与管理鉴权，2026-10-19，完整客户端门禁失败）

新增 runtime
`clearAsync()`：第一个 await 前废止在线能力，串行等待已有模式切换与在途 checkpoint，然后等待全部持久撤销确认。清理期间的请求不能重新开启读取；重复清除共享在途任务，结束后应用最新设置，新的禁用、模式切换或退出不会被旧策略覆盖。错误保持固定码，清理失败停止恢复接管。诊断将 clearing 投影为等待应用。

新增独立
`context-recovery-clear-storage`，处理当前为内存模式但磁盘仍保留旧记录的情况。仅打开现有、路径合法的数据库，通过真实加密 worker 认证并 revoke-all，再检查可读原文条目和字节均为零，关闭并释放锁；空目录或缺失目录不创建库，异常布局拒绝。保留未到期撤销标记和原期限，拒绝旧写入复活；不导入会话权限，不删除数据库/密钥，不声称介质安全擦除。清除范围仅为代理恢复数据，插件独立内存库、客户端原生日志和审计日志不在此范围；成功后新数据继续遵循当前捕获设置。

管理路由新增 `POST /v1/local/context-recovery/clear` 及
`/local/context-recovery/clear`，请求仅接受 128 字节内的
`{"confirm":true}`，不接受文件路径、会话选择器或任意内容。复用现有管理 token 与 Origin 检查；回复只含固定状态，失败不泄漏原生错误，不自动重试或重放工具。代码已进入实际 composition
root，但未激活共享生产。

本候选最新扩大专项 **68/68，通过**，独立真实 Windows 物理诊断约
**7.6 秒通过**，实际代理子进程鉴权集成通过：无 token/仅入口 key 均 401，恶意 Origin
403，管理 token 200，模型上游调用为零。范围 Lint/格式、CI/release、composition
root/模块图及统一 unit 发现通过；新增模块进入发布清单，新测试进入字面客户端和既有集成 CI。

**字面客户端门禁尚未合格。** 两次完整命令均为
**727 项中 726 通过、1 超时取消，退出 1**；原 30 秒期限、断言、并行方式和覆盖率阈值均保持。第二次增加固定阶段/耗时诊断：seed 约 10.2 秒关闭，闲置库清除约 20.8 秒确认，第三次打开约 25.4 秒进入 DPAPI 解包，随后触发整个物理用例 30 秒期限。没有证据证明首次超时完全同源，也不以单独通过或清除已确认改写整例失败。下一步继续诊断完整运行下的真实原生启动和解包耗时，达到既定门禁后才能提升资格。

证据目录为
`.hpm-acceptance/context-recovery-clear-20261019-01/`，初轮两个失败及无原型 ACK 比较修正、两次完整门禁失败和独立诊断分别保留。当前覆盖率为语句/行 98.99%、分支 94.34%、函数 98.98%，覆盖率达标不抵消用例超时。字面全仓 verify 仍在
**404 个文件格式问题**处失败，后续全仓阶段未运行；该次 verify 在最终测试诊断补充之前执行，生产代码未因此改变。未批量格式化无关文件或放宽规则。用户清除界面、用量、保留策略、staged 整理、WS/真实客户端/模型与完整发布仍未完成，`restartRetention:false`
保持；未安装插件、修改真实凭据、请求模型或重启生产。目标继续执行。

## 已合格阶段（worker 空闲到期回收，2026-10-19，客户端门禁通过）

新增独立
`context-recovery-storage-idle`，由真实加密存储 worker 每 60 秒执行一次私有 sweep；定时器不维持进程存活，禁止重入，关闭先取消，再排空 owner。非法/异步 ACK 或清理失败终止 owner，父服务随后拒绝操作，不重试请求，不续期证据或恢复旧权限。取消异常为持续失败，无法用第二次关闭制造成功。

扩大相关专项 **84/84**；字面客户端覆盖
**713/713，通过，退出 0**，语句/行 99.01%、分支 94.44%、函数 98.97%。范围 Lint 无警告、格式、CI/release、composition
root 与模块图通过；80 个 JS/CJS 语法通过，82 个枚举源码/测试/清单摘要无差异，不宣称完整依赖闭包。新测试已进入统一 unit 发现及字面客户端覆盖，新模块已进入发布清单。

真实 Windows 加密 worker 的空闲删除通过独立只读 SQLite 连接观察，不借其他 owner 命令触发回收；损坏回归证明 worker 退出、后续操作拒绝及 writer 锁释放。物理测试用专用 preload 把该定时器加速至 25 毫秒，只证明生产回调路径，不证明实际 60 秒墙钟清理时限，也不承诺介质不可恢复或数据库文件立即缩小。

最终范围 Lint、其他治理和候选摘要已补齐，阶段回执为
`.hpm-acceptance/context-recovery-idle-20261019-01/milestone.json`。首次 Lint 失败和其他失败记录保留。新一轮字面
`npm run verify` 仍退出 1，停在既有
**404 个文件格式问题**，后续全仓阶段未运行，未批量改写无关文件或放宽门禁。`restartRetention:false`；实际 WS/宿主/模型、主动清除完整界面、容量与完整发布仍未交付。没有修改真实凭据、安装插件、发起模型请求或激活共享服务。

## 此前合格阶段（绝对到期回收与清理崩溃恢复，2026-10-19，客户端门禁通过）

新增独立
`context-recovery-storage-maintenance`，在同一 SQLite 事务及认证时钟内先认证全部有界记录，再删除绝对到期的 payload 与撤销标记。未到期撤销标记不能回收，仍有效的原文、预算、revision、TTL 和发布状态保持。原始迟到 save 的期限已到或 revision 不符，不能因回收旧行而重新落盘；时钟水位保持，回拨拒绝。256 条记录上限不变，清理过期标记后可容纳新的不同 scope，不通过驱逐仍有效撤销记录释放容量。

回收接入实际 engine 启动、catalog 和 save；另有私有 `sweep`
请求和严格 ACK 校验，可经现有 worker/opening 通道调用。没有新增模型工具或公开清理端点。SQLite
schema、密钥和 write-ahead 版本保持原值，不进行破坏性格式迁移。启动先检查数据库容量，再运行回收；新回归先复现“超额打开失败前已删除记录”，调整顺序后保持数据。坏密文、错误元数据、删行触发失败或事务故障均不提交部分删除，错误只含固定码。

本批相关六文件扩大专项
**84/84 通过**，包含真实进程在清理 COMMIT 前退出：SQLite 恢复未提交删除和时钟更新，再重新清理；以及真实 Windows
DPAPI/SQLite
worker 回收、关闭重开、迟到保存拒绝和有效预算保持。初轮扩大专项 83 项中 82 通过、1 失败来自 fixture 将无原型 ACK 与普通对象比较；按既有安全归一化契约比较后通过，没有改变业务断言。首次缺失维护能力回归、容量检查顺序回归和中间失败均保留。

证据目录：`.hpm-acceptance/context-recovery-maintenance-20261019-01/`。新模块进入 release；新测试进入字面客户端覆盖和统一 unit 发现。

| 检查               | 结果                                                                            |
| ------------------ | ------------------------------------------------------------------------------- |
| 相关扩大专项       | **84/84，通过**；含清理进程崩溃和真实加密 worker                                |
| 最终字面客户端覆盖 | **703/703，通过，退出 0**；语句/行 99.02%、分支 94.48%、函数 98.95%             |
| 范围静态与治理     | Lint 无警告、格式、77 个 JS/CJS 语法、CI/release、composition root 与模块图通过 |
| 枚举候选一致性     | 79 个源码/测试/清单文件摘要差异 0；不宣称完整依赖闭包                           |

本批字面 `npm run verify`
退出 1，停在既有 404 文件格式问题，后续全仓阶段未执行；未批量改写无关文件或放宽门禁。客户端覆盖不能代替完整工程资格。历史失败、既定 deadline、断言和覆盖率阈值保持，没有新增依赖。

当前是启动/访问/写入时的机会式回收，不能宣称空闲时到点物理删除。`secure_delete`
和 DELETE
journal 沿用原配置，不承诺介质不可恢复或数据库文件立即缩小。尚未交付空闲清理调度、用户主动清除完整体验、活跃检查点中不可发布 staged 数据整理、未来 schema 迁移、实际 WS/宿主、容量与完整产品发布；`restartRetention:false`
保持。没有修改真实凭据、安装插件、发起模型请求或激活共享服务。

## 此前合格阶段（原策略依据与物理 HTTP 重开，2026-10-19，客户端门禁通过）

完成 root
v2 的私有原策略依据：新建 root 保存规范化策略，导出与读取检查点验证依据的指纹；未知版本、空对象、额外字段、访问器、超限和关联篡改均拒绝。v1 记录仍要求当前完整策略匹配，验证通过后升级；write-ahead 封装与 SQLite
schema 保持 v1。省略工具策略的离线压缩用已验证依据完成导入校验，联合候选选择继续使用原始当前请求。不同工具策略共享同一历史时仍拒绝歧义；主体、路由、指令、system 和显式工具冲突继续约束准入。策略依据不进入模型读取信封或来源描述。

扩大专项先复现空对象通过局部形状边界，显式拒绝非 v1/v2 后相关七文件
**101/101 通过**。随后新增真实 Windows DPAPI/SQLite
worker 关闭重开，使用全新 runtime 自动接纳省略工具策略的压缩请求，提交规范下一窗口，再精确读回原文；策略专项
**9/9 通过**，保留原 30 秒期限、预算与绝对 TTL。

实际核心 HTTP 原有内存用例保留 10 秒期限，新增真实加密 worker 用例采用现有物理重开用例的 30 秒期限：HTTP 前瞻捕获并提交 → 普通生命周期退出 → 关闭 worker
→ 检查数据库不包含明文 → 重开同一加密库 → 新生命周期 HTTP 自动续接 → 原文精确读回；预算和到期时间不变。两种模式
**2/2 通过**，本次形成同一物理存储与实际核心 HTTP 链路，不再仅以两个 fixture 拼接。它仍是合成提供方和本地 HTTP 客户端，不是实际 Codex/Claude、共享服务物理进程重启或真实模型验收。首轮新增预算断言误用子快照 ID 调用只接受 root
ID 的导出接口，改为原始 root ID 后通过；业务断言未放宽，失败日志保留。

证据目录：`.hpm-acceptance/context-recovery-policy-basis-20261019-01/`。

| 检查               | 结果                                                                                   |
| ------------------ | -------------------------------------------------------------------------------------- |
| 最终字面客户端覆盖 | **695/695，通过，退出 0**；语句/行 99.02%、分支 94.50%、函数 98.95%                    |
| 新模块和测试注册   | 原策略模块进入 release；新测试进入字面客户端覆盖和统一 unit 发现                       |
| 范围门禁           | Lint 无警告；格式、74 个 JS 语法、CI/release、composition root 与模块图通过            |
| 原失败证据         | 原 7/8 失败、当前修复前复现、HTTP 断言 fixture 失败均保留；未修改 deadline、阈值或依赖 |

本批字面 `npm run verify`
退出 1，仍在格式检查报告 404 文件问题，后续全仓门禁未运行；未批量改写无关研究文件或放宽门禁。客户端覆盖不能代替完整工程资格。完整清理迁移、物理进程故障重启、长期启动稳定性、日常 WS、真实客户端/模型、容量与用户设置以及发布仍未交付。`restartRetention:false`
保持；没有安装插件、修改真实凭据、发起模型请求或激活共享服务。下一步完成清理迁移与故障重开，并推进首发实际传输。

## 此前工作区状态（原策略依据草稿，2026-10-19，失败记录保留）

以下是本批修复前的只读核对记录，保留失败边界；不代表上节修复后的资格。此前异步加载与 HTTP 准入的 685/685 结果不覆盖后续草稿修改。

工作区新增 `context-recovery-root-policy.js` 和
`context-recovery-policy-basis.test.js`，并修改 root 导出/导入、检查点、会话及加载路径，尝试以 root
v2 私有保存并校验原策略依据，支持离线压缩省略工具策略。write-ahead 与数据库 schema 保持 v1；联合选择应继续使用当前请求。

证据目录 `.hpm-acceptance/context-recovery-policy-basis-20261019-01/`
中，`focused-first.log` 记录初步相关 30/30 通过；扩大后的 `policy-first.log` 为
**8 项中 7 通过、1 失败**。源码核对发现未知版本回退为空字段表，空对象因此通过局部形状校验。须显式拒绝未知版本、保留失败回归，完成新文件的统一 CI/覆盖/release 注册，并重新验证物理重开及 HTTP 闭环。当前不得把这批草稿报告为完整支持或发布候选。

主方案新增多端交付矩阵与下一批 A–E 工作包；整体仍未完成，`restartRetention:false`
的产品边界保持。未安装插件、修改认证、请求真实模型或激活共享服务。

## 最近合格阶段（同所有者异步加载与 HTTP 准入，2026-10-19，客户端门禁通过）

新增
`context-recovery-root-loading`，将在线/离线联合选择、已发布状态投影、异步存储加载和原子接纳接到现有 session 的
`beginAsync`。每所有者最多八个在途准入任务，串行加载且只接纳唯一选中的离线 root；同 root 后续请求复用已有所有者和预算，不创建独立可写副本。重复 catalog 校验和每次 ACK 前后当前权限复查阻止过时接纳；其他在线聊天和 pending
capability 保留。普通退出排空加载，禁用和撤权代次阻止迟到 ACK 复活能力。请求授权使用独立、不可逆的守卫，返回后的读回和发布仍受其约束，不作为共享时钟。

新增协议异步入口复用原解析、解压、身份及目标派生。核心 HTTP 普通请求和独立压缩路径已调用异步准入；原同步转发回调外增加异步错误边界，失败返回固定错误且不重放请求，发送后失败终止连接。存储等待后复查请求权限和取消，正常 finish 后的 close 允许观察提交继续完成。最初没有可信官方凭据绑定的 fixture 导致 403；补齐可信测试前提，并保留未获可选恢复准入时普通转发仍可用的产品行为，另有独立回归证明等待期间撤权不会进入旧 handler。

本地证据分别覆盖：实际核心 HTTP 经前瞻捕获、持久提交、新生命周期所有者自动接纳和精确原文读取；真实 Windows 加密 worker 关闭重开后实际 runtime 自动接纳，保持原预算与绝对期限。前者使用合成内存 SQLite，后者是真实 DPAPI/文件/worker 重开；两者不能拼成一次真实客户端经物理进程重启的端到端验收。物理用例仍使用原 30 秒期限，完整运行通过也不证明长期启动稳定性。

证据目录：`.hpm-acceptance/context-recovery-loading-20261019-01/`。

| 检查               | 结果                                                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------------------- |
| 扩大相关回归       | 107/107 通过；随后新增的普通转发/安全失败回归另有独立通过及最终统一覆盖                                         |
| 最终字面客户端覆盖 | **685/685，通过，退出 0**；语句/行 99.02%、分支 94.47%、函数 98.95%                                             |
| 覆盖范围           | 选择与加载测试进入统一 unit 和字面客户端；新增模块进入发布清单；抽出的 context-binding-selection 也纳入覆盖统计 |
| 范围静态与治理     | Lint、格式、CI/release、composition root 与模块图通过；最终源码摘要及语法结果绑定阶段回执                       |
| 完整字面 verify    | 退出 1，在 404 文件格式问题处失败，后续阶段未运行；没有批量格式化无关研究文件或放宽门禁                         |

首次加载测试 9/10，失败来自测试误读分页字段；扩大协议测试 47/48，失败来自普通对象与安全解析后的 null
prototype 比较；二者修正为现有 page.text 与无原型对象契约。HTTP 新转发失败用例首次在已发 header 后抛错，连接按契约终止，不能再期待 502
JSON；改为注入发送前失败以验证该分支，未改变发送后失败规则。相关失败日志、最初两份清单格式失败以及未纳入抽出选择模块的第一次覆盖结果全部保留；加入覆盖 include 后重新运行原门槛命令，未变更 deadline、阈值、断言目标或依赖。最终客户端覆盖比此前 663 项多 22 项，不累加不同历史阶段。

当前离线导入要求完整策略指纹匹配。独立压缩省略原生成策略且无法与离线策略匹配时，安全拒绝本次恢复准入，保留普通压缩转发；尚无可信原策略依据来恢复该形态，不能宣称所有压缩续接已支持。`restartRetention:false`
保持；清理迁移、日常 WS、真实 Codex/Claude、产品界面、长期稳定性和完整发布仍未完成。没有安装插件、修改真实认证、激活或重启共享服务、发起模型请求。

下一步补齐离线压缩省略策略的可信依据与续接，验证全部已提交/不可发布分支及并发场景，再继续清理迁移、实际传输和真实宿主验收。当前目标保持未完成。

## 此前候选边界（现有会话内原子接纳，2026-10-19，最终客户端门禁通过）

新增私有 `adoptContextRecoveryRoots` 及独立
`context-recovery-root-adoption`，将已由可信所有者授权的 root 接纳进现有会话集合。仍通过完整 root
importer 验证关联；绑定 registry 与私有 history
map 先准备、检查配额和冲突，再在没有 await、时钟或外部回调的同步提交段更新。保留原集合、在线与待完成 capability、ledger、预算和映射，不通过替换全局 session 恢复旧记录。临时导入对象在成功和失败时均释放，失败不清除无关在线聊天。

同一 root
ID 重复接纳被拒绝，不能覆盖已用预算；root、绑定快照及私有历史总容量继续受原限制约束，不驱逐在线 root。接纳期间重入 begin 返回 busy，重入接纳安全失败。新增回归先复现最终时钟检查期间到期未阻止接纳，再补最终绝对期限检查及主体撤权 generation；禁用、撤权和退出不能被迟到接纳反转。存储新增 admitRoot，区别于只登记拒绝依据的 registerRoot，拒绝已撤销或失败的离线 root。

专项验证在线聊天与 pending 分支继续读回/完成、导入私有历史和精确 Unicode 原文、预算保持、重复接纳、非法批次/getter、空/过期输入、root/绑定/历史容量、重入和检查期间撤权/到期，以及使用现有持久 owner 的 CAS 读回与发布。首轮容量用例错误地用超过单次输入上限的条目构造总容量边界，改为多个合法条目后验证总量拒绝，未放宽任何上限。最终四文件扩大专项
**73/73 通过**，其中新增接纳文件 9 项；已有实际加密 worker 回归包含在扩大范围内，不代表新 API 已在 HTTP/runtime 物理重启路径自动调用。

证据目录为 `.hpm-acceptance/context-recovery-root-adoption-20261019-01/`：

| 检查                 | 结果                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------ |
| 首次字面客户端覆盖   | 663 项，662 通过、1 取消，退出 1；既有独立压缩物理重开在原 30 秒期限取消                   |
| 相同物理用例独立诊断 | 1/1 通过，约 7.9 秒；保留原期限与原文、发布日志、预算、TTL 断言                            |
| 最终字面客户端覆盖   | **663/663，通过，退出 0**；语句/行 99.03%、分支 94.52%、函数 98.91%                        |
| 范围静态及治理门禁   | Lint 无警告、格式、65 个 JS 文件语法、unit 发现、CI/release、composition root 与模块图通过 |
| 源码冻结             | 67 个枚举源码/测试/清单文件摘要差异 0，不宣称完整依赖闭包                                  |

首次完整运行中，物理用例首次 ready 约 15.9 秒，关闭约 19.5 秒，重开解包约 29.1 秒，未在期限内完成；独立诊断及最终完整运行通过，最终完整运行重开验证约 23.1 秒。各日志分别保留，不将独立通过抵消首轮失败，也不以一次最终通过认定长期性能稳定或全部失败同源。范围 Lint 首次报告的测试 global/const 问题也保留，修正后无警告。期限、断言、覆盖率阈值和依赖均未改变。新模块进入发布清单，新测试进入字面客户端及统一 unit 发现。本批没有重复全仓 verify；此前阶段的字面 verify 在 404 文件格式问题处失败仍未解决，不能宣称完整工程通过。两份文档在业务门禁后单独检查格式并绑定摘要。

下一步实现在线/离线候选联合的非变更式唯一续接判定、同一所有者内的异步加载串行化，再把当前授权校验和原子接纳连接到实际 runtime/HTTP 入口；请求级取消不能成为共享会话的时钟或生命周期。当前只有私有接纳 API，尚未实现自动重启恢复调度，继续
`restartRetention:false`。清理迁移、WS、真实客户端/模型、产品界面与完整发布仍未完成。未安装插件、修改真实认证、启用或重启共享生产、请求真实模型。

## 此前候选边界（授权重建原语与完整记录校验，2026-10-19，客户端门禁通过）

实现并验证
`context-recovery-restore-projection`、`context-recovery-reauthorization`。先完整验证 root，再保留发布状态为 transport-finished 且祖先仍可见的分支；移除不可见来源及私有映射，绝不导入 stagedSources，全部已用预算和原绝对期限保持。当前可信请求必须唯一匹配已观察续接，才创建新的受限能力；主体、路由、策略、历史或响应 ID 不匹配不授予权限。授权在存储 ACK 前后复查，返回后的能力仍受不可逆的授权守卫约束。

新增回归先复现不匹配当前主体的记录会跳过检查点摘要校验：期望安全拒绝，实际返回 null。抽取
`context-recovery-storage-record`，供启动发现和授权重建共用；校验目录元数据、root 范围、主体格式、期限和检查点后才按当前身份筛选。修复前失败日志保留为 record-regression-before.log，修复后相同回归通过。没有扩大读取范围或自动修复损坏记录。

本批专项与存储服务集成 30/30 通过，包含两个独立 root 匹配同一历史的真实歧义、不可发布父节点下的已完成子节点、非空 stagedSources、私有历史筛选，以及读回 save
ACK 期间撤权后无内容泄露、预算不回退。真实 Windows 加密 worker 关闭重开保持原 30 秒测试期限，验证精确原文、绝对 TTL 和读回扣账。最初 8 项日志及扩大 10 项日志保留，最终扩大专项包含 12 项授权重建测试。

新测试进入字面 test:client:coverage 及统一 unit 发现，三个新增模块进入发布清单，无新增依赖。最终完整客户端覆盖
**654/654，通过，退出 0**；语句/行 99.01%、分支 94.62%、函数 98.89%，期限、断言和阈值未改。范围 Lint 无警告、格式、61 个 JS 文件语法、CI/release、发现与 composition
root 通过；63 个枚举源码/测试/清单文件摘要差异 0，不宣称完整依赖闭包。证据目录为
`.hpm-acceptance/context-recovery-reauthorization-20261019-01/`。

本批重新执行字面
`npm run verify`，退出 1，仍在格式检查报告 404 文件问题，后续全仓阶段未执行。原失败日志保留，未批量改写无关临时研究文件或放宽规则；该结果不能被客户端覆盖通过替代。两份状态/方案文档在业务门禁后更新并单独检查格式、绑定摘要。

该原语尚未接入 runtime，也未完成单 root 所有者与现存在线聊天的原子接纳，`restartRetention:false`
保持不变。不能在每个请求中独立创建可写副本，不能将请求级授权回调直接变成其他请求共享的会话时钟。下一步按主方案第 7.5 节完成所有权和授权生命周期集成，再补实际 runtime/HTTP 共存、并发与重开回归。清理迁移、WS、真实客户端/模型、产品界面与完整发布继续未完成。未安装插件、修改真实认证、激活或重启共享服务、请求真实模型。

## 最近合格阶段快照（外部运行目录与原生密钥边界，2026-10-19，客户端门禁通过）

新增独立 context-recovery-runtime-directory，仅在选择持久化、旧 owner 完成撤权和排空后异步准备应用运行目录。逐级验证目录类型与祖先身份，拒绝 junction、符号链接、文件和身份替换，限制深度；不对未检查路径执行递归 mkdir，不改已有祖先权限，不触碰原文文件。worker 仍负责专用叶目录、ACL、系统密钥和数据库检查。失败进入安全终态，准备期间的新设置或退出不能启动旧设置要求的持久 owner；默认内存路径不创建目录。

修复前真实 Windows 回归证实：尚未创建的嵌套运行目录导致就绪返回存储不可用。修复后相同测试通过，实际核心 HTTP 模式切换也覆盖该形态。回归覆盖非法/极端路径、访问器、EEXIST 竞争、祖先替换/消失、原生失败、真实 junction 和重复准备。模块进入发布清单，测试进入统一发现和字面客户端覆盖入口，无新增依赖。

原生密钥脚本严格接受内部固定编码器产生的双字段报文，拒绝额外/重复字段。修复前实际子进程回归证实额外字段被接受；修复后两类输入均拒绝。保持 stdin 传密钥、最小环境、固定系统程序、CurrentUser
DPAPI 和 protect 后解包一致性回验；通过固定强名称系统程序集、有界报文匹配和固定 JSON 回复，移除 Add-Type/ConvertFrom-Json/ConvertTo-Json 的 Utility 模块加载依赖。没有调整原生、worker 或测试期限，没有密钥缓存或明文 fallback。

以下证据目录均位于 .hpm-acceptance/：

| 检查                                   | 当前结果                                                                      | 证据                                                                 |
| -------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 目录修复前真实回归                     | 1 项失败：存储不可用                                                          | context-recovery-runtime-directory-20261019-01/regression-before.log |
| 目录修复专项/扩大专项                  | 19/19、59/59，通过                                                            | 同目录 focused.log、integration.log                                  |
| 目录中间快照字面客户端                 | 641 项，640 通过、1 取消，退出 1；原压缩重开仍超时                            | 同目录 client-coverage.log、client-coverage-result.json              |
| 原生密钥修复前回归                     | 1 项失败：未拒绝额外字段                                                      | context-recovery-native-startup-20261019-01/regression-before.log    |
| 密钥/真实 worker/目录/runtime/压缩专项 | 61/61，通过                                                                   | 同目录 focused.log                                                   |
| 最终字面客户端覆盖                     | **642/642，通过，退出 0**；语句/行 99.01%、分支 94.62%、函数 99.01%，阈值未改 | 同目录 client-coverage.log、client-coverage-result.json              |
| 模块覆盖                               | 目录语句/行/函数 100%、分支 96.96%；密钥模块四项均 100%                       | 同目录 coverage/coverage-summary.json                                |
| 范围工程门禁                           | Lint 无警告、格式、语法、CI/release、发现与 composition root 通过             | 同目录 gates.json                                                    |
| 源码核对                               | 59 个枚举源码/测试/清单文件，摘要差异 0；不是完整依赖闭包                     | 同目录 baseline.json、source-check.json                              |

本轮完整客户端中，实际独立压缩重开约 27.3 秒完成，原期限以及精确原文、预算、TTL、发布日志断言保留；一轮通过不证明长期稳定性或全部历史失败同源。早期单次保护/解包探针只作诊断，没有受控性能结论。本轮实际执行 npm
run
verify，退出 1，仍在首个格式门禁报告 404 文件问题，后续全仓门禁未运行；本批范围格式检查通过。失败记录见同目录 verify.log、verify-result.json。未批量改写其他研究文件，也未放宽忽略或检查规则。客户端覆盖不能替代全仓发布资格。

跨重启当前授权重建、发布状态过滤和清理迁移、WS 恢复、真实客户端/模型验收、持久化 GUI、容量策略和完整发布仍未交付。保持 restartRetention:false 和默认恢复/持久化关闭。未安装插件、修改真实认证、激活或重启共享服务、请求真实模型。下一步进入当前授权重建，复用现有导入、身份和持久撤销边界，不能把磁盘检查点直接导入为读取权限。

## 此前候选边界（独立持久化策略与目录源码接线，2026-10-19，完整客户端仍未通过）

本节依据已有日志、源码及结果文件整理，不代表本次重新执行测试或激活服务。新增
`context-recovery-runtime`，在主入口通过 `DATA_DIR` 创建，独立读取
`contextRecoveryEnabled` 和
`contextRecoveryPersistenceEnabled`，两者默认均关闭。持久化选择
`DATA_DIR/context-recovery-v1`；默认仍使用内存。配置控制器立即应用完整设置；核心入口每个请求取得当前 session，避免切换后持有已关闭的旧 session。

模式切换立即废止旧范围，等待持久撤权和旧 owner 排空，再创建最新设置要求的 owner；中间设置可被更新设置取代。普通进程退出仅排空关闭，保留已提交数据，不按禁用处理。非法设置、能力、ACK、状态投影和存储失败产生固定安全错误，无隐式迁移、自动恢复旧权限或静默内存 fallback。诊断区分内存、持久化、切换和失败；`restartRetention:false`
仍成立。前端尚无持久化开关控件，不能视为完整用户流程。

证据目录：`.hpm-acceptance/context-recovery-storage-policy-20261019-01/`。

| 检查                                | 已记录结果                                                                          | 证据                                   |
| ----------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------- |
| 最终扩大专项                        | 68/68，通过；含真实 Windows 加密 runtime、HTTP 模式切换、配置、诊断、退出及前端模型 | `integration-final.log`                |
| 字面 `npm run test:client:coverage` | 634 项，628 通过、4 失败、2 取消，退出 1                                            | `client-coverage.log`                  |
| 客户端覆盖率                        | 语句/行 99%、分支 94.61%、函数 99%；阈值未改                                        | 同上                                   |
| 前端覆盖/测试/构建                  | 三项退出均为 0；覆盖入口 5/5，前端测试入口 25/25；构建保留 chunk 大小警告           | `frontend-results.json` 及三个前端日志 |
| 范围工程门禁                        | Lint、语法、格式、CI/release、发现与 composition root 通过                          | `gates.json` 及对应日志                |
| 验证源码范围                        | 57 个枚举文件，原记录摘要差异 0；不宣称完整依赖闭包                                 | `baseline.json`、`source-check.json`   |

完整客户端失败涉及 stdio
CLI、隔离代理启动、真实加密 HTTP 模式切换、分支/私有历史重开、预算 worker 重开和独立压缩重开。新 HTTP 测试专项通过，但完整运行在存储就绪时失败；不能用专项抵消该失败。独立压缩重开仍触及原 30 秒期限。各失败尚未建立统一根因，不调整期限、断言或阈值制造通过。

当前源码已接目录选择及持久化策略，但跨重启当前授权重建、发布状态过滤、清理迁移、真实 WS、实际宿主和完整门禁仍未完成。外部自定义运行目录的父目录准备顺序尚需验证：存储边界要求父目录已存在，不应只因传入了路径就宣称所有启动形态可用。原 30 分钟 TTL、最多 4
root 不支持隔天续接承诺。全仓 `verify`
本批未重跑，历史格式失败保留；未安装插件、修改真实认证、重启生产或请求真实模型。

## 此前候选边界（异步存储打开与启动屏障，2026-10-19，完整客户端仍未通过）

新增
`context-recovery-storage-opening`：提供同步 capability，在后台打开实际 storage
worker，并立即接入既有 session 启动屏障。生命周期所有者现在可接收显式
`directory`，无需等待 worker 就绪才创建 owner。严格验证目录、选项及 storage 能力；拒绝同时传入 directory/storage，开启或非空 session 在打开目录前拒绝。主入口仍未传目录，默认保持内存，没有启用生产持久化或重建当前读取授权。

打开入口一次调用工厂，校验并克隆请求，最多排队 8 项和 16
MiB。已接受操作等待打开；关闭立即停止新准入，等待已接受操作和实际 worker 关闭，幂等返回同一关闭 Promise。非法结果、revision 或撤销数量不匹配会使入口终态失败；普通操作失败只返回固定安全错误，不自动重试。复用原 worker 结果验证器，不放宽其 schema。修复异常 native
Promise 回复未进入终态失败的问题，增加 constructor
getter 和 prototype 回归，不执行其访问器。

生命周期 directory 回归验证非法目录、storage 冲突、active
session、getter 在文件副作用前拒绝；实际 SQLite/session 回归覆盖打开期间迟到启用与较新禁用/退出。真实 Windows 目录测试验证系统密钥、实际加密数据库打开、启动未完成前不得启用，以及 worker 排空后才清理服务 PID。原物理 lifecycle
owner 测试首次打开改经新入口，保留真实重开、持久撤销、旧 revision 拒绝和无原文落盘断言及原 30 秒期限。

证据目录：`.hpm-acceptance/context-recovery-storage-opening-20261019-01/`。

| 检查                                  | 本阶段结果                                                     | 证据                                     |
| ------------------------------------- | -------------------------------------------------------------- | ---------------------------------------- |
| 草稿初次专项                          | 43 项，40 通过、3 失败；安全解析返回无原型对象与测试预期不一致 | `focused.log`                            |
| 修复后打开/生命周期/worker 三文件专项 | 62/62，通过，含真实 Windows worker 与物理重开                  | `focused-fix.log`                        |
| 字面 `npm run test:client:coverage`   | 620 项，619 通过、0 失败、1 取消；最终退出 1                   | `client-coverage.log`                    |
| 新打开模块在该客户端运行中的覆盖      | 语句/行 98.93%、分支 96.87%、函数 100%                         | `coverage/coverage-summary.json`         |
| 范围工程门禁                          | Lint、格式、语法、CI/release、发现与 composition root 全通过   | `gates.json` 及对应日志                  |
| 验证源码范围                          | 47 个枚举运行/测试/清单文件，摘要差异 0；不宣称完整依赖闭包    | `fix-baseline.json`、`source-check.json` |

客户端总覆盖为语句/行 99.07%、分支 94.72%、函数 98.97%，阈值未改。唯一取消仍为真实加密 worker 独立压缩重开：初次 ready 约 15.5 秒、关闭约 17.8 秒、重开解包开始约 24.9 秒，触及原 30 秒期限；不能据此证明全部历史失败同源。实际生命周期 owner 在该完整运行中完成重开和撤销验证，约 28.1 秒；专项通过不抵消完整门禁失败。

本阶段将已验证的异步打开接口连接到已有生命周期屏障，尚未完成生产目录选择、持久化设置、当前授权重建、清理迁移、WS 和真实客户端验收。未重跑全仓库 verify，历史格式失败继续有效；未安装插件、修改真实认证、重启生产或发起真实模型请求。下一步完成受控目录/持久策略与当前授权恢复，并继续定位真实重开期限问题；整体目标保持未完成。

## 此前候选边界（运行设置与服务退出接线，2026-10-19，完整门禁仍失败）

主入口现在创建并注入同一个
`contextRecoveryLifecycle`，供运行配置控制器、核心请求处理器和服务退出使用。初始化应用既有布尔开关，配置更新完成时立即通知所有者，不必等待下一个请求才撤权。重复值仍由所有者合并；退出后的配置不能重新启用会话。默认仅创建内存会话，没有打开持久化目录或重建旧权限。

新增独立
`server-shutdown`，在首次退出调用内立即停止恢复准入，等待全部 HTTP 监听器及恢复事务排空，再停止 PID 写入并清理 PID；重复退出共享同一 Promise。恢复 ACK、监听器错误或 PID 清理失败均不能得到成功退出；非法回复、getter、thenable、原生 Promise 异常及同步/异步报告异常有回归。监听失败、管理凭据初始化失败均进入同一排空路径。修复取消初次 PID 写入时，未生成文件的
`ENOENT` 被错误判断为清理失败的问题；其他读取错误仍失败。

新增接线最初触及主入口既有 1200 行门禁，没有提高限制或删除空行应付检查。将请求关联和异步日志作用域包装移到既有
`request-observability`，通过惰性派发保持原行为，并补作用域、响应头与断连回归；主入口恢复为 1198 个物理行。新模块进入发布清单，新测试进入统一 unit 发现，无新增依赖。

证据目录：`.hpm-acceptance/context-recovery-runtime-wiring-20261019-01/`。

| 检查                       | 结果与范围                                                                         | 证据                                                 |
| -------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 初次运行接线专项           | 10 项，9 通过、1 失败：主入口行数超限                                              | `focused.log`                                        |
| 提取请求包装后专项         | 11/11，通过                                                                        | `focused-fix.log`                                    |
| 扩大专项首次运行           | 21 项，20 通过、1 失败：未生成 PID 的退出返回 1                                    | `runtime-focused.log`                                |
| PID 修复及最终运行专项     | 22/22，通过，包含实际 HTTP 与隔离服务子进程                                        | `runtime-focused-fix.log`、`runtime-final.log`       |
| 新退出模块覆盖专项         | 7/7，通过；语句、分支、函数、行均 100%，阈值未降低                                 | `shutdown-coverage.log`                              |
| 前一源码快照字面客户端覆盖 | 609 项，607 通过、1 失败、1 取消、退出 1                                           | `client-coverage.log`、`client-coverage-result.json` |
| 最终源码字面客户端覆盖     | 609 项，608 通过、0 失败、1 取消、退出 1                                           | `client-coverage-final.log`、`final-results.json`    |
| 最终范围门禁               | Lint 无警告、格式、语法、CI/release、发现与 composition root 通过；45 文件摘要一致 | `*-final.log`、`source-check-final.json`             |

最终客户端覆盖率为语句/行 99.07%、分支 94.67%、函数 98.97%。唯一取消为真实加密 worker 的独立压缩重开测试，仍使用原 30 秒期限：首次就绪约 16.2 秒、关闭约 18.7 秒，重开系统解包完成约 29.5 秒，随后未能在期限内完成。未修改 deadline，不把取消算作通过。包含新服务退出协调器的真实生命周期 owner 物理测试在完整运行内通过：约 27.9 秒，保持持久撤销、关闭排空、重开拒绝旧 revision 等原断言。这些结果不证明系统启动稳定性或所有历史失败同源。

隔离服务子进程验证：真实监听器在 PID 权限操作挂起时继续响应 health；退出立即关闭实际恢复会话，等待 PID 操作结束后返回 0 且不重建 PID。另一个隔离进程在合成凭据初始化失败时保持退出等待，实际恢复会话先关闭，释放恢复排空后才返回 1。上述是本地运行与合成故障证据，不是已激活服务或真实凭据验收。

生产目录打开与完整存储生命周期、当前授权重建、清理迁移、WS、真实客户端及完整工程门禁仍未交付。当前阶段接通源码中的设置和退出路径，不授予完整发布资格；没有启用生产持久化、重启生产、安装插件、修改真实认证或请求真实模型。完整 verify 本阶段未重跑，历史 404 文件格式失败保留。下一步继续定位剩余物理启动期限问题，并接入受控生产存储打开及当前授权重建。

## 此前候选边界（设置策略所有者与真实 worker 接入，2026-10-19，完整门禁仍失败）

独立 `context-recovery-lifecycle`
协调一个 session 和可选的已打开 storage，合并重复布尔设置，等待启动与持久撤销 ACK，并在普通退出时先停止准入、排空 session 及策略，再关闭 worker。核心 HTTP 入口已使用该所有者；实际本地 HTTP 回归验证两次连续请求只应用一次启用、关闭后旧读取能力立即失效。修复外部关闭 session 后
`ready()`
仍可能报告成功的问题，并验证内存配置异常会终止准入。非布尔、访问器、非法 ACK、thenable、启动失败、迟到启用、关闭失败和排空顺序均有回归。

新库密钥写入现在返回已设置权限、fsync、读取核对并固定身份/摘要的包装字节，owner 复用本次结果，避免紧接着对相同文件再次设置权限；已有库及新 owner 重开仍使用
`pinKey()`
并由系统解包。新增落盘内容不一致拒绝与持久 pin 回归。没有调整 ACL/原生进程/worker/test 期限，没有跨重启明文缓存。

证据目录：`.hpm-acceptance/context-recovery-policy-owner-20261019-01/`。

| 检查                                | 当前结果                                                        | 证据                                                 |
| ----------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------- |
| 接入前首轮生命周期                  | 32 项，31 通过、1 取消、退出 1；仅对话输出记录                  | `initial-observation.json`                           |
| 核心 HTTP 与生命周期首次接入        | 56 项，55 通过、1 失败、退出 1                                  | `focused.log`、`baseline.json`                       |
| 文件写入优化后三文件专项            | 75 项，66 通过、9 失败、退出 1；多项未越过目录初始化            | `focused-fix.log`、`fix-baseline.json`               |
| 字面 `npm run test:client:coverage` | 609 项，598 通过、10 失败、1 取消、退出 1                       | `client-coverage.log`、`client-coverage-result.json` |
| 实际生命周期 owner 物理专项         | 1/1，通过，约 12.8 秒，原 30 秒期限                             | `physical-owner.log`、`physical-owner-result.json`   |
| 范围工程门禁                        | Lint、格式、语法、CI/release 治理、发现与 composition root 通过 | 对应 `*-fix.log`、`discovery-composition.log`        |

客户端覆盖率为语句/行 99.04%、分支 94.67%、函数 98.97%，阈值未改；覆盖率通过不能抵消测试失败。新边界回归在统一客户端运行中通过。完整失败仍涉及 stdio
CLI、隔离代理、系统密钥和各实际加密重开路径。独立合成目录探针观测到 `whoami.exe`
约 5.8 秒触及既定 5 秒超时，且完整运行后段的实际 storage
worker 可以打开和重开；随后才单独核验新 owner 物理路径。该证据定位了一项原生命令失败，不证明全部失败同源，也不是稳定性或性能资格。

物理 owner 专项使用实际 Windows 加密文件、实际 session 初始化、持久禁用、owner 排空关闭及全新 worker 重开；验证离线 root 不被自动导入、撤销记录不可读取、旧 revision 不可复活和数据库不含原文。它不验证当前读取授权恢复或生产组合。`extended-fix-baseline.json`
将未变化的 33 文件修复基线扩展为包含 storage-paths 的 34 文件枚举范围；最终摘要核对见阶段回执，不宣称完整依赖闭包。

尚未连接生产目录打开、应用设置事件及实际服务退出；当前权限重建、清理迁移、WS、真实 Codex/Claude 组合与完整统一门禁继续未完成。默认生产存储设计仍是内存，没有启用持久化、安装插件、修改真实认证、重启生产或请求真实模型。下一步完成设置变更与退出接线，并继续定位原生启动失败；本阶段不重跑或改写历史全仓 verify。

## 此前候选边界（启动阶段诊断与密钥初始化，2026-10-19，客户端门禁仍失败）

方案整理补充：工作区另有 `context-recovery-lifecycle`
与核心入口接入草稿，用于合并重复设置、协调已打开存储的初始化与退出。初次运行记录为 32 项、31 通过、1 取消、退出 1，物理重开仍触及原 30 秒期限；见
`.hpm-acceptance/context-recovery-policy-owner-20261019-01/initial-observation.json`。未取得完整集成资格，尚未接通生产目录打开、设置事件、服务退出和当前读取授权重建。本次只整理方案和核对既有记录，没有重跑测试或产生新合格里程碑。下文启动诊断数字仍属于原阶段快照。

新增独立
`context-recovery-storage-progress`，提供有界、单调的固定阶段与非内容性耗时。实际 storage
worker 在加载、目录保护、取得所有权、密钥包装/解包、打开数据库和引擎就绪时发送严格校验的启动帧；普通 ready
ACK 仍是准入条件。未知、重复、倒退、附加内容、访问器和 ready 后的阶段帧拒绝；进度不重置原启动 deadline。可选观察器的同步/异步失败不改变业务结果，不执行任意 thenable，不转发原生异常、目录、密钥或用户内容。

实际重开测试增加固定步骤诊断。在仅补诊断、尚未优化密钥初始化的快照中，字面客户端 596 项有 594 通过、2 超时取消；随后三文件物理专项 52 项有 50 通过、2 超时取消。阶段记录证明两个业务都已经完成首次提交与关闭，但首次打开耗时约 20–23 秒，重开时超过原有 30 秒测试期限。这只定位了这两次运行的阶段，不能解释所有历史失败。

修复新库重复启动原生进程的问题：DPAPI 的固定 protect 程序在同一进程内立即解包并比较原密钥，成功后才返回受保护字节。owner 写入并固定文件、核对落盘 wrapping 后复用原生成密钥；已有库与重开仍必须从已固定文件读取并由系统解包。没有缓存跨重开的明文密钥，没有改变 stdin-only、CurrentUser、目录身份、事务或现有 10 秒原生超时，也没有回退明文。新增真实原生 wrapping 篡改拒绝测试与 fresh/reopen 调用次数回归。

修复后四文件专项 63/63 通过；两项原超时测试观测到约 21.4 秒、18.6 秒完成，仍使用原 30 秒期限。这不是受控性能基准，不承诺固定加速比例。新增共 7 组回归进入已注册测试文件，新增运行模块进入 release 清单，无新增直接依赖。修复范围 Lint/格式、31 个枚举文件内 JS 语法、CI/release 治理、发现与 composition
root 测试通过。

修复后字面客户端覆盖输出为 598 项，588 通过、9 失败、1 取消。失败/取消仍涉及 stdio
CLI、隔离代理启动、实际加密 ledger/分支/预算/独立压缩/生命周期/root
reader 重开以及系统密钥 worker；专项通过不能抵消完整失败。生命周期记录进一步显示初始包装阶段约 10 秒后失败；目前没有足够证据将所有失败归于单一 DPAPI、并发或其他根因。最终进程退出码、覆盖摘要与源码摘要以
`.hpm-acceptance/context-recovery-startup-diagnostics-20261019-01/`
的回执为准；本阶段不得获得完整发布资格。

该目录分别保留诊断前后运行、`baseline.json`、`physical-baseline.json`、`fix-baseline.json`，避免把不同源码混用。默认生产存储生命周期和当前授权重建仍未接通；没有激活功能、修改真实认证、安装插件、重启生产或发起真实模型请求。完整 verify 未重跑，历史失败不改写，整体目标未完成。

## 此前候选边界（实际会话启动屏障，2026-10-19，客户端门禁失败）

本次方案整理核对既有源码与证据，确认此前客户端运行句柄已终结、退出码为 1；未重跑工程测试、未修改运行代码、未创建新的合格里程碑。重新核对
`.hpm-acceptance/context-recovery-startup-20261019-01/baseline.json`
的 26 个枚举代码/测试/清单文件，0 不匹配。

候选新增 `context-recovery-storage-startup` 和可信
`initializeContextRecoveryStorage`，仅允许全新、空且未启用的实际 session。先登记存储事务，完成有界发现，等待启动期间排队的禁用、主体撤销或关闭 ACK，再同步安装 reader/publication；不导入旧 root、不恢复读取权限、不自动启用。失败保持终态，不回退内存或自动重试。禁用 generation 防止较旧异步启用跨越较新禁用；普通退出与撤销性关闭分开，普通退出之后仍可显式持久撤销。

生命周期文件新增 9 组，现为 24 组；覆盖目录扫描各阶段的撤权、非法 discovery/ACK/thenable、启禁竞态、重复 attachment、安装时钟失败，以及真实 Windows
worker 经 fresh
session 初始化、撤销、重开后不能由旧 revision 复活。首两次 fixture 失败保留；修正使用真实已观察函数调用锚点，并由同步假后端直接返回恶意 thenable，未放宽绑定或输入边界。

| 验证               | 已有结果                                 | 本阶段目录内证据                           |
| ------------------ | ---------------------------------------- | ------------------------------------------ |
| 生命周期专项       | 24/24，通过                              | `lifecycle-attempt3.log`                   |
| 十五文件扩大专项   | 187/187，退出 0                          | `focused-final.log`、`focused-result.json` |
| 字面客户端覆盖     | 591 项，582 通过、6 失败、3 取消，退出 1 | `client-final.log`、`client-result.json`   |
| 范围语法/Lint/格式 | 24 个 JS 语法无失败；Lint/格式退出 0     | `scoped-gates.json`                        |
| CI/release 治理    | 两项退出 0                               | `governance.json`                          |

证据目录为
`.hpm-acceptance/context-recovery-startup-20261019-01/`。客户端失败/取消涉及真实 stdio
CLI、隔离代理启动、实际加密 ledger/私有历史/预算 worker、独立压缩物理重开、系统密钥 worker 和生命周期物理重开；不能以专项全通过抵消，也没有证据判定单一并发或 DPAPI 根因。该阶段为部分通过，完整目标未完成。

默认生产 `core-request-handler` 仍构造内存 session 并逐请求同步
`configure`，没有调用新初始化接口。诊断保持 memory、无重启保留、WS 透传是正确边界。剩余重点为失败诊断、当前授权重建与发布筛选、生产设置/服务生命周期所有者、staged 清理、实际 WS/HTTP 并发、当前版本 Codex/Claude 验收及完整发布门禁。未核验生产加载版本，未安装插件、修改真实凭据、调用真实模型、激活持久化或重启服务。历史完整 verify 失败保留。

## 此前候选边界（启动发现与撤权登记，2026-10-19，扩大门禁失败）

本批新增私有存储 `catalog` 操作及 `context-recovery-storage-discovery`
模块，未改变模型侧工具、生产设置、真实认证或运行服务。目录操作有界查询至 257 行并限制总记录 256，认证包括过期记录及 tombstone 的每条密文，再返回最多 4 个未过期 state 的 scope、revision 与原始时间元数据，不返回正文或能力。

发现模块逐条读取并校验检查点、scope 与 rootId 摘要绑定、主体、期限及目录 revision，最后复查目录 generation；读取失败、损坏、记录消失或并发变动均拒绝整批。`createRecoveryRootStorage().discover()`
在初始空注册表上建立准入屏障，扫描完整成功后才登记撤权索引；失败保持关闭，关闭竞态不能复活准入。登记后的主体撤权可覆盖尚未在线读过的未过期 root，其他主体保持隔离。它不导出正文、还原 ledger 或创建会话能力，也不把 prepared/sending/uncertain 当作发布成功。

新增 7 组测试进入原有统一 CI 文件：catalog 输入及认证过滤、worker 元数据 ACK、离线主体撤权、空库与准入屏障、损坏/读取失败/目录变化、可执行输入和扫描关闭；既有真实 Windows
worker 重开测试增加 catalog/撤销后空目录断言。新运行模块已加入发布清单，无新增直接依赖。

证据目录为
`.hpm-acceptance/context-recovery-discovery-20261019-01/`。首轮三文件专项 42/42 通过；枚举源码冻结后十五文件专项 178 项中 176 通过、2 取消，退出码 1，取消为独立压缩和生命周期物理重开 30 秒超时。字面
`npm run test:client:coverage`
为 582 项中 572 通过、9 失败、1 取消，退出码 1；不得据 98.99% 行/语句覆盖率宣称通过。失败包含 stdio
CLI、两个隔离代理启动、ledger/branch/budget/compaction/lifecycle 的加密 worker、系统密钥，以及凭据日志隔离子进程未在其原有期限内退出；尚未证明单一根因。

本轮还在修改前对此前生命周期候选独立复测，575 项中 567 通过、5 失败、3 取消，退出码 1，见
`.hpm-acceptance/context-recovery-lifecycle-20261019-02/`。该结果属于修改前源码，不与新候选混用。无密钥 PowerShell 启动探针的单次约 1.3–1.6 秒、8 并发约 5.2–5.8 秒及系统密钥专项 9/9 只能证明观测到启动成本，不足以给所有失败定因。

范围 Lint/格式、23 个 JS 语法、CI/release 治理通过；25 个枚举源码/测试/清单摘要核对 0 不匹配。首轮 Lint 发现新增测试的全局
`structuredClone` 名称未声明，已改为 `globalThis.structuredClone`
并通过；没有降低 timeout、门槛、断言或用模拟 worker 替换真实测试。冻结源码的最终三文件实际 worker 复测 42/42 通过，结果单列于
`focused-physical-final-result.json` /
`focused-physical-final.log`，不覆盖扩大门禁失败。阶段回执 `milestone.json` 标记
`partial-gates-failed`、整体未完成和未激活生产。

剩余边界：发现原语尚未接到真实 session 的启动 attachment/生产 composition
root，当前授权重建及发布筛选、staged 清理、设置/服务退出接线、WebSocket 和真实 Codex/Claude 验收仍未交付。默认生产证据仍在内存；没有新合格里程碑、没有生产激活。本轮未重跑完整 verify，历史全仓格式失败保留。下一步先定位启动失败并完成有屏障的异步启动 attachment，随后接当前授权恢复；整体目标保持未完成。

## 此前候选边界（持久生命周期，2026-10-19，扩大门禁失败）

本次整理重新读取源码、日志和退出码文件，并核对生命周期 baseline 的 24 个枚举文件摘要，0 不匹配；未重新运行工程测试、未核验生产进程加载情况。最近完整通过所述客户端门禁的快照仍是下方独立压缩发布阶段。生命周期候选尚无新的合格 milestone，不据部分通过宣称完整交付。

当前候选包含以下变化：

- 存储契约与加密 SQLite 引擎增加原子
  `revoke-all`、`revoke-scopes`。终态撤销覆盖最新持久 revision，保留原期限，批量损坏/写入失败回滚，旧保存不能复活已撤销记录。
- root
  storage 登记主体、scope、原期限及在途 I/O；全局撤销阻止新事务，等待旧事务结束后撤销磁盘全部记录，包括未在线登记记录。主体撤销仅覆盖已登记的匹配 root；启动发现未接通，不能宣称覆盖未知磁盘主体。
- 实际 session 在同步禁用、撤销、关闭时立即废止在线能力，同时发起持久操作；`configureAsync`、`revokeAsync`、`closeAsync`
  等待持久确认。撤销失败保持失败状态，阻止重新启用，不自动重试原不确定写入。
- `shutdownAsync`
  明确用于普通进程退出：停止在线能力并排空 I/O，保留已提交字节供重启重新授权；它与终态撤销性的
  `closeAsync` 不同。已有真实 worker 留存测试改用普通退出语义。
- 新增 `test/context-recovery-lifecycle.test.js`
  的 11 组回归，并注册到字面客户端覆盖入口；存储引擎和 worker
  ACK 回归进入既有注册文件。无新运行模块或直接依赖。

已留存的验证结果：

| 验证                 | 结果                                                    | 证据目录内文件                                                      |
| -------------------- | ------------------------------------------------------- | ------------------------------------------------------------------- |
| 六文件专项           | 87/87 通过，包含 11 组生命周期回归及真实 Windows worker | `focused-attempt2.log`                                              |
| 十五文件扩大专项     | 171 项，169 通过、2 取消；退出码 1                      | `focused-attempt3-timeout.log`、`focused-attempt3-result.json`      |
| 首次字面客户端覆盖   | 575 项，563 通过、9 失败、3 取消；退出码 1              | `client-attempt1-startup-failed.log`、`client-attempt1-result.json` |
| 第二次字面客户端覆盖 | 575 项，569 通过、3 失败、3 取消；退出码 1              | `client-final.log`、`client-result.json`                            |
| 范围检查             | Lint/格式/diff 通过，22 个 JS 语法无失败                | `scoped-gates.json`                                                 |
| CI/release 治理      | 两项退出码均为 0                                        | `governance-gates.json`                                             |

证据目录为
`.hpm-acceptance/context-recovery-lifecycle-20261019-01/`。第二次客户端失败/取消分别涉及真实 stdio
CLI 超时、隔离代理启动超时、加密 ledger
worker 不可用、独立压缩物理重开超时、系统密钥 worker 不可用、生命周期物理重开超时。首次部分运行存在重叠；第二次仍有失败，不能以重叠解释全部失败，也不能据此断言 DPAPI 是唯一根因。覆盖率百分比和范围门禁通过均不抵消测试失败，不放宽 timeout 或替换实际 worker 来获取资格。

剩余交付：失败诊断与门禁恢复、启动发现/完整主体登记及当前授权重建、生产存储服务/设置/退出接线、staged 清理、WebSocket 与 HTTP 并发、当前版本 Codex/Claude 实际验收、完整工程门禁与受控激活。本次仅整理文档，没有调用真实模型、安装插件、改变凭据、启用功能、重启生产或更新历史回执；完整 verify 的历史失败继续保留。

## 此前交付边界（独立原生压缩持久发布，2026-10-19）

主方案已重排为产品边界、架构、数据/事务、各端适配、实施与验收。首发拟聚焦 Windows、Codex 日常入口和 Claude
Code；这不是新增支持声明。最新独立压缩持久发布阶段新增 14 组回归，十二文件专项 136/136，字面客户端覆盖 559/559；真实 Windows
worker 重开验证独立压缩发布日志、精确原文、已用预算和绝对期限。此前 HTTP 发布的 160/160、545/545、读回的 527/527、所有权的 507/507、完整 root 的 94 项及异步阶段失败均保留各自源码快照，不据当前通过结果改写历史，也不宣称全仓库或产品已完成。

完整设计及当前差距统一见
[多端无感上下文恢复方案](./context-recovery-multi-client-plan.md)。此前分支/私有历史状态阶段为客户端覆盖 455/455、六文件专项 67 项；原文 ledger 阶段为 440/440、七文件专项 67 项，存储服务阶段为 421/421、专项 35 项，预算阶段为 431/431、专项 58 项。各阶段数字只覆盖其源码快照，不累加，也不表示整体目标通过。

`context-evidence-budget-state` 与 `context-recovery-budget-reader`
的预算读回原语已完成下述阶段验证，统一客户端覆盖更新为 431/431。它仍由调用方提供在线已授权 ledger，不能从预算记录重建原文权限；生产会话的完整授权、分支、来源、历史与预算恢复均未完成。

当前生产证据仍为内存；没有已启用的统一持久化目录。WebSocket 恢复、真实日常 Codex/Claude 组合验收、完整统一门禁与生产激活继续保留为未完成项。最近已记录的完整
`verify`
停在 404 个文件格式问题，本阶段没有重跑或改写该结果。下方按阶段保留历史事实；其中“尚未实现”均须结合本节及后续阶段判断。

## 独立原生压缩异步持久发布（2026-10-19）

真实 session 增加 `completeCompactionAsync`，完整存储 attachment 通过现有 root
publication 服务在 owner 租约内完成独立压缩提交，复用共享 CAS、预算、私有快照身份和发布日志；没有另建存储或重置额度。同步
`completeCompaction`
仍禁止绕过持久化。默认内存模式在首个 await 前提交，原有同步兼容入口继续保留。

独立压缩 publication 增加可等待的准备、发送意图和 finish 确认；native
collector 与 core request
handler 已接线。收齐完整 UTF-8/JSON 规范窗口并校验后才准备，持久 ACK 和当前授权都通过后发送原始 wire，保留空白、未知字段与不透明块。正常 upstream
end→close 不取消待提交发布；真正客户端取消或错误立即阻止迟到发布。finish 标记同步登记，正常 finish→close 不撤回正在等待的最终 ACK；报告成功前再次检查授权。任何字节已发出后失败只终止与安全报告，不追加替代 JSON、不重试模型或原工具。

新回归还发现共享 root
publication 的一个竞态：finish 保存最终获确认、同时 capability 已被撤回时，清理仍沿用 sending 并尝试写 uncertain，转换被拒绝。现在在 ACK 后同步登记 transport-finished，随后撤销保存 withdrawn；未确认或发送中的失败仍保守处理。普通 HTTP 与独立压缩各有回归，不能把本端 finish 解释为客户端处理完成。

新增 14 组覆盖三个 ACK 等待、取消/授权变化、私有身份、非法/空/超大/getter 输入、异常与非法 ACK、部分写、无 fallback/重试、重复 finish、异步回调拒绝与 thenable 不执行、终态报告异常、在线撤权/禁用/到期/关闭、连续三次规范压缩与精确 Unicode 读回、原生窗口不变和累积预算。真实 Windows 加密 worker 关闭重开验证 transport-finished 日志、精确合成原文、两次已用调用/一次成功读取、原绝对期限及数据库无合成原文明文字节。

全局关闭仍会使在线能力立即失效，但服务关闭后不能继续写持久 tombstone，关闭竞态下磁盘可能保留 prepared；测试明确验证其不得发布成功，并不把该状态视为可恢复授权。该缺口和 principal 全局持久撤销、启动筛选及清理属于下一阶段；没有据此开启生产存储或提供跨重启产品承诺。

冻结十七个枚举代码/测试/清单文件，十二个实际存在的测试文件专项 136/136；字面
`npm run test:client:coverage`
559/559，语句/行 98.95%、分支 94.40%、函数 98.89%。范围 Lint/格式、十五文件语法、CI/release 治理、composition
root 和统一发现通过。新增用例位于既有已注册测试文件，无新增运行模块或依赖；最终枚举摘要再次核对。客户端覆盖率的 include 范围保持原样，不将其百分比冒充 core/collector 或全仓库覆盖率。

回执为
`.hpm-acceptance/context-recovery-compaction-publication-20261019-01/milestone.json`，资格
`local-native-compaction-durable-publication-qualified`。首轮失败、数据对象原型比较的测试建模修正和源码摘要保留；其中共享发布竞态作了产品修复，关闭持久化限制继续明确保留，没有放松门槛。首次扩大专项误填一个不存在的 discovery 测试路径，Node 多文件运行未报告缺失；保留原日志后逐项检查路径，改用真实
`test/test-discovery.test.js`
重跑十二文件专项，未沿用原 135 项结果宣称发现门禁通过。

仍需完成全局持久撤权/关闭、生产存储生命周期和设置、staged 清理、启动发现及当前授权恢复、WebSocket 与实际 Codex/Claude 组合验收、完整工程门禁与受控激活。本轮未调用真实模型、安装插件、改变凭据、启用功能或重启生产；全仓库 verify 未重跑，历史 404 文件格式失败不改写。整体目标仍在执行。

## 实际会话异步最终提交与 HTTP 发布（2026-10-19，此前阶段）

新增共享 `context-recovery-root-storage`、`context-recovery-root-publication`
与安全调用边界 `context-recovery-publication`。可信组合层可使用
`attachContextRecoveryStorage`，让实际 session 的读取和发布使用同一个 root
CAS/revision/quarantine 与发布日志；此前 reader-only
attachment 保持独立语义，默认生产构造仍未连接存储。owner 新增私有
`identity`，使用真实 session WeakMap 中的 snapshot
ID，修改 capability 的公开 snapshotId 不能选择发布对象。

完整存储模式提供 completeAsync/completeObservedAsync/startPublicationAsync/finishPublicationAsync/withdrawAsync/abortAsync；同步 complete 和独立压缩 completeCompaction 返回 async_required，不能绕过持久化。普通默认内存模式维持同步提交发生在首个 await 前。独立压缩的异步 collector 接入仍待完成，因此本次不具备生产持久化激活条件。

HTTP 核心入口（WBIPC 共享该入口）现在等待准备提交、发送意图与本地 writer 完成的三个确认，持有 root 租约到实际发布结束；确认前不发布最终字节，取消/授权变化后不发布迟到成功。正常 finish 后 close 不再误取消等待中的完成确认；报告回调异常不撤回已成功输出，异步撤回失败也不能打断安全失败通知和监听器清理，使用独立内容无关计数 publicationCleanupFailed。

写前封装增加发布日志，保留旧五字段封装校验兼容。每个快照区分 unobserved/prepared/sending/transport-finished/uncertain/withdrawn；转换矩阵禁止跳过发送阶段及终态复活，后续读取保留日志。总发布日志最多 256，跨四 root 共享，load/save 均检查；有合法摘要但与私有已知 journal 不一致的回滚也会隔离该 root。transport-finished 只证明本端传输完成，不是远端 ACK。已完成视图显式撤回会取当前完整检查点再保存 withdrawn，保留兄弟读取后的共享预算；没有当前在线能力时安全失败，不用旧缓存补造权限。

普通透传观察器通过 completeObservedAsync 在 finish 后捕获，消费存储拒绝并撤回该视图；这不构成发送前持久化。模块不会把 prepared/sending/uncertain 写前记录自动导入成可信会话，也不会自动重跑模型或外部工具。全局 principal 撤销、configure(false)、服务关闭的持久撤销及重开筛选仍未闭环，本阶段只验证在线失效及迟到结果不能成功。

18 组新增测试覆盖三协议真实 session/runner/HTTP 的内部原文进入后续请求和最终私有历史、三个 ACK 延迟、正常 finish→close、各边界取消/授权变化、部分发送/write-error、存储异常/非法 ACK、读取后的日志保留与预算撤回、私有身份、关闭/到期/禁用/根撤权、发送后观察、非执行 getter/thenable/非法输入、30 种转换组合、合法摘要回滚、全局日志配额及实际 Windows 加密 worker 重开。新测试进入统一 unit 发现和字面客户端覆盖，三个新运行模块进入 release 清单；未降低超时、覆盖率、断言或安全门槛。

冻结十二个枚举代码/测试/清单文件后，十二文件专项 160/160，字面
`npm run test:client:coverage`
545/545；语句/行 98.98%、分支 94.49%、函数 98.88%。范围 Lint/格式、十文件语法、CI/release 治理、composition-root 与 unit 发现通过，最终枚举摘要无漂移。真实 worker 关闭原 runtime 与 worker 后重开同一临时数据库，验证已完成发布日志、精确 UTF-8、预算与原绝对期限；检查数据库无合成原文的明文字节。这不是生产启动授权恢复或真实客户端验收。

回执
`.hpm-acceptance/context-recovery-publication-20261019-01/milestone.json`，资格
`local-http-durable-publication-qualified`。保留首轮新增测试的失败日志与源码摘要；该轮包含 JSON 转义比对错误、观察器测试头部错误及把已确认 finish 后撤回误期望成 uncertain 的测试建模错误，修正为实际数据解码与发布契约后验证，没有借此放松产品保证。后续全局配额和安全输入回归均进入最终冻结候选。

仍需交付：原生独立压缩异步发布、生产存储生命周期/设置、全局持久撤权/关闭和 staged 清理、启动发现与当前权限恢复、WebSocket、真实客户端和完整工程门禁。最近全仓库 verify 的 404 文件格式失败保持原记录；本阶段未重跑全仓库 verify，未启用生产存储、安装插件、重启服务、改真实凭据或发起真实模型请求。

## 实际会话异步存储读回事务（2026-10-19，此前阶段）

新增
`context-recovery-root-checkpoint`、`context-recovery-root-reader`，会话增加可信组合层专用
`attachContextRecoveryReaderStorage`。连接后实际 `session.replyAsync`
经同一 root 的存储事务执行；模型没有新增 scope、rootId、存储地址或 session
selector。同步内部读工具返回固定
`context_recovery_async_required`，不能绕开存储回落内存。默认构造及生产入口尚未连接此适配器，当前生产默认路径仍为内存，本次未启用新设置或目录。

一次读回独占 root，校验已有记录的主体/协议/目标/策略、原绝对到期、版本、摘要、绑定结构、ledger 来源与预算；参数在首次 await 前做无执行快照，非法尝试继续按既有 parser 错误扣额。以 CAS 将最大调用/字节预扣、内部已提交 root 投影和待提交来源写入同一 scope，确认前不触碰 ledger；读后写入实际进度与预算，确认后才返回完整页。存储异常、非法确认、回滚或 CAS 冲突使该 root 的存储读回进入失败状态，后续不再尝试存储或走同步 fallback，不自动重试模型或原工具。四 root、12
MiB 单记录、现有总容量及读取额度不变。

写前格式为独立 `recovery-write-ahead`：`root` 是内部已提交投影，`stagedSources`
保存该 root 尚未进入投影的原文，摘要用于一致性检查，不能授予权限。来源只保存参数摘要和精确文本，不保存原工具参数。该封装不是
`recovery-root`，现有会话 importer 拒绝直接导入；即使可信调用方单独验证并恢复
`root`
投影，也无法枚举或读取旁侧 staged 来源。内部 committed 仍不等于客户端网络发布成功，后续必须单独处理发布和撤销状态。

每个异步边界复核会话、取消、关闭和到期。未确认结算失败或取消保留最大扣额；若实际结算写入已确认、同时发生取消，新增可信
`confirmBudget`
只同步已确认的计数，使内存与磁盘一致，不恢复租约、读回、提交或发布权限，也不返回已取消的原文。普通
`settleBudget`
的有效租约要求保持不变。租约一直保留到当前存储操作结束，再在 finally 释放，避免旧写入尚未结束时新修改进入。

20 组新回归覆盖三协议实际 session/runner 的 list→read→完整页进入下一请求、待提交原文隔离、两次确认等待、并发、每个存储边界的取消、撤权/关闭/到期、写入前后异常、非法 ACK、无执行 Promise/thenable、损坏记录、回滚/CAS 竞争、原 parser 错误、参数修改、空来源、额度耗尽、四 scope 与绝对过期、封装拒绝导入、绑定/敏感来源拒绝及真实存储重开。真实 Windows
worker 关闭原会话和 worker 后重开，验证精确 UTF-8、同一 scope 的预算和原期限，并检查数据库未出现合成原文的明文字节；这验证未发布写前数据，不是生产会话授权恢复或服务重启验收。

最终十文件专项 148/148，字面 `npm run test:client:coverage`
527/527，语句/行 99.08%、分支 94.62%、函数 98.99%；范围 Lint/格式、四文件语法、CI/发布治理、统一 unit 发现及 diff 检查通过。两个运行模块进入发布清单，新测试进入显式客户端覆盖和统一发现；六个枚举运行/测试/清单文件与最终验证前摘要匹配。回执为
`.hpm-acceptance/context-recovery-root-reader-20261019-01/milestone.json`，资格
`local-session-storage-reader-qualified`。此前失败日志和原门槛、超时及断言均保留。

仍需交付：生产存储服务生命周期/设置接入、最终输出与私有历史的持久化提交、prepared/sending/uncertain 发布状态、持久化撤权与 staged 数据清理、启动 root 发现及当前权限恢复、WebSocket 和真实客户端验收。现有 HTTP/WBIPC 仍同步 complete，本阶段没有把未发布记录当成可自动续跑的授权，也不启用跨设备迁移。没有安装插件、重启生产、改真实凭据或调用真实模型；完整
`verify` 未重跑，最近 404 文件格式失败继续保留。

## 完整 root 所有权与共享预算预扣（2026-10-19，此前阶段）

新增 `context-recovery-root-owner` 和
`context-evidence-budget-owner`。会话增加仅可信服务可使用的
`acquireContextRecoveryRoot`：返回私有租约，以显式 capability 操作该 root，不能把 JSON、root 标签或外来 session 当成权限，也不使用环境式异步上下文继承所有者身份。普通绑定、读回、提交、原生压缩、恢复历史准备和 root 导出在租约持有期间返回 busy 或安全错误，其他 root 可以继续工作。恢复出的 root 重建新的所有权实例。

abort、withdraw、撤权、关闭和绝对到期会立即使租约失效；失效不提前解锁，调用方必须等待在途写入结束并在 finally 释放，避免旧保存尚未完成时新状态进入。迟到租约不能再读、结算、提交或导出。该边界处理在线所有权，不等于已实现持久化撤权；原磁盘状态及提交不确定性仍需后续生命周期处理。

预算实现移到独立模块，原有创建、导出、恢复及 reader 契约保留。写前预扣直接修改既有预算对象，所有已创建 reader 都看到同一次调用和最大页字节扣额；不替换其闭包引用。未确认期间普通 reader 暂停，每个私有 reservation 只允许匹配预算的一次读取。候选结算状态可写进同一个完整 root，确认后原位更新实际计数；未结算就释放或取消时保留最大扣额。64 次、512
KiB、单响应 16 KiB 和全局四 root 上限不变。

17 组新增回归覆盖独占、空和伪造租约、跨 root、同步入口、异步确认期间取消、撤权/过期、原生压缩窗口不变、共享旧 reader、一次读取、保守失败、非法/执行性输入、极端预算和完整状态恢复。加密 SQLite 测试由调用方顺序保存预扣、结算和最终完整 root，只有一个存储记录；关闭原会话、重开同一内存数据库上的存储引擎后，创建全新会话验证精确 Unicode 和预算保持。这是引擎及所有权集成验证，不是生产服务或 worker 重启验收。

首轮扩大专项 127 通过、1 失败，首轮字面客户端覆盖 506 通过、1 失败；失败是拆分预算后
`createContextEvidenceTools`
的非法预算错误文本改变。通过私有预算成员校验恢复原 TypeError 契约，原断言未改动；原始日志和对应源码摘要分别保留为
`focused-attempt1-contract-failed.log`、`client-attempt1-contract-failed.log` 和
`baseline-attempt1.json`。另修复空 token 在没有租约时被误报释放成功的分支，并补断言。

修复后冻结七个运行/测试/清单文件，17 组新专项及九文件 128 项均通过；最终字面
`npm run test:client:coverage`
507/507，语句/行 99.05%、分支 94.60%、函数 98.96%，原门槛和超时不变。范围 Lint/格式、五文件语法、CI/发布治理、统一 unit 发现和 diff 检查通过。两个新运行模块进入发布清单，新测试进入显式客户端覆盖与统一发现。七个枚举文件与最终验证前摘要全部匹配；回执为
`.hpm-acceptance/context-recovery-root-owner-20261019-01/milestone.json`，资格
`local-root-ownership-qualified`。历史失败不改写，本阶段也不声称已修复此前宿主启动超时的根因。

生产 `replyAsync`
仍包装内存 reader，HTTP/WBIPC 完成入口尚未等待完整 root 存储。待提交新来源的持久化、发布状态、持久化撤权、启动 root 发现、清理/设置、WebSocket 及实际客户端验收仍需接通。本阶段没有启用功能、重启生产、安装插件、修改真实凭据或调用真实模型，完整
`verify` 未重跑。

## 异步 reader、协调器与 runner（2026-10-19，此前阶段专项部分通过）

coordinator 把已有同步状态机抽成单一 generator，保留同步 `accept`，增加异步
`acceptAsync`，同一个 busy 门禁止重入和重复读回。只等待普通原生 Promise，拒绝其他 thenable 和执行性结果；同步入口不能释放尚在进行的异步读回，并消费普通 Promise 的迟到拒绝。reader-result 限制结果为经过无执行校验的文本和固定成功状态；progress 独立校验轮数、调用数及有界数值用量。

runner 优先等待
`acceptAsync`，把读取等待纳入原有总超时及取消竞态；等待结束后再次检查取消。失败从可信 run 读取经过校验的进度，保留已经完成并可能计费的上游用量。coordinator 在迟到读回后复核 terminal 与权限；session 在异步返回后再次检查当前有效性，禁止取消后暂存或提交私有历史。没有增加上游重试或外部工具执行路径。

新增异步专项 15 组、实际 session 异步历史/取消 2 组；测试进入显式客户端覆盖和统一 unit 发现，两个新运行模块进入发布清单。覆盖三协议内部/混合调用、busy、取消和撤权、拒绝/非法/超限/getter/toJSON/thenable 数据、同步迟到拒绝、读取等待中的超时和取消及用量保持、实际私有历史精确读回与分支隔离。受控 CAS 存储测试把预扣和结算确认分别挂起，证明预扣前不访问 ledger、结算前不发下一次模型请求；它使用独立预算记录及在线 ledger，不能作为生产完整 root 持久化验收。

三文件专项 67/67；冻结九个明确运行/测试/清单文件后的八文件扩大专项为 106 通过、2 失败，失败均为既有实际存储 worker 打开时返回
`context_recovery_storage_unavailable`。原始失败保留在
`.hpm-acceptance/context-recovery-async-20261019-01/focused-final.log`，不修改超时、断言或门槛。范围 Lint/格式、七文件语法、CI/发布治理、统一测试发现和 diff 检查通过。统一客户端覆盖结果和合成密钥隔离诊断见本阶段回执；不能沿用此前 455/455 或完整 root 的 94 项宣称当前候选完整通过。

字面 `npm run test:client:coverage`
退出 1：490 项中 478 通过、10 失败、2 取消。未通过项涉及原有 stdio CLI 启动、API
proxy fixture ready、Windows
DPAPI/存储 worker 和依赖其完成的用例，新增 17 组均通过。失败测试运行产生语句/行 98.81%、分支 94.44%、函数 98.89% 的覆盖率，超过阈值不抵消测试失败。完整日志为
`client-final.log`。随后仅用新建随机合成数据密钥做隔离诊断，当前用户 DPAPI 子进程在原有 10 秒期限内超时；没有输出或保存密钥、原生错误和 stdout/stderr。该观测说明密钥保护启动路径也能独立超时，不证明所有 fixture 失败具有同一原因。

本阶段机器可读回执为
`.hpm-acceptance/context-recovery-async-20261019-01/milestone.json`，资格为
`partial-gates-failed`；九个枚举文件与验证前源码摘要匹配。合成密钥诊断和既有 worker 失败不能据此降低生产密钥保护要求或改用明文。当前仍未获得本候选的完整客户端门禁通过。

另一个不传任何密钥或凭据的固定程序探针使用相同 Windows
PowerShell 可执行文件、最小环境和 10 秒期限：空宿主输出探针耗时 10,223
ms 并超时；随后加载 Security 程序集的探针在 8,851 ms 成功。记录为
`powershell-startup-diagnostic.json`，不保存子进程输出。这确认至少一次基础宿主启动也能超过当前期限，但不能据此认定 DPAPI 算法、权限或所有失败测试的根因。后续应定位宿主启动延迟并维持原有失败保护，不能直接提高期限或豁免真实 worker 测试。

`replyAsync` 当前仍调用内存 reader，HTTP 完成路径仍同步调用
`session.complete`。完整 root 的生产保存、读前预扣与结算、发布、撤权和清理尚未统一接通，也未解决同步入口与异步保存之间的状态所有权。因此当前状态仍是“持久化底座与受控恢复已分阶段验证，生产生命周期集成未完成”。

本阶段未安装插件、启用恢复开关、重启生产、修改真实凭据或调用真实模型。完整
`verify`
未重跑，最近 404 个文件格式失败保留。后续继续接入完整 root 所有权、持久化预扣/结算、发布不确定状态与撤权生命周期，再进行 WebSocket 和实际客户端验收。

## 完整 root 受控导出与新会话恢复（2026-10-19）

新增 `context-recovery-root-state`，会话模块增加可信调用方专用的
`exportContextRecoveryRoot` 与
`restoreContextRecoverySessions`。完整 root 原子状态包含当前主体/目标/策略关联、绝对时间、绑定树、观察调用、每快照可见来源、原文 ledger、共享读取预算与已提交私有历史。会话观察调用只保留工具名和参数摘要；原参数首次观察时仍执行既有敏感字段、旧 transcript 与大小策略，未来结果重新执行结果策略，再关联原参数摘要。

导出仅选已提交且祖先完整的分支，来源按已提交快照可见性裁剪；pending、abort 和 withdraw 分支的原文不能因共用底层 ledger 被导出。调用配额与读回计数保留已消耗值，不按有效分支重新计数。快照保存调用、来源和捕获的增量，避免每个后代重复保存整个继承视图。恢复逐字段验证新捕获必须对应父快照先前观察的调用，并核对工具名、参数摘要、来源 ID、内部调用摘要和创建时间；私有历史 tip 与快照映射及其祖先逐一对应。

当前可信调用方必须先认证存储 root、复核当前权限与持久化撤销，再提供当前 binding
basis。保存的标签/哈希不能自行授予权限，JSON 中不恢复旧 capability。恢复重建新的会话、ledger、预算、绑定及私有历史 token；完整批次先通过校验再返回新实例，失败关闭新建对象，不改变原在线会话。批次最多四 root，共享原有全局绑定快照与私有历史配额；逐 root 校验 12
MiB，支持合法批次总量超过单次 normalizer 的 16 MiB 上限，不扩大存储服务的 32
MiB 总额度。恢复后继续使用真实时钟，root、来源和历史保持原绝对期限；整个 root 到期后不保留较晚创建的后代。

十八组新回归覆盖精确 Unicode、预算/读取进度、未来结果关联原摘要、原参数不入检查点、原参数敏感策略、兄弟分支隔离、pending/撤回排除、私有历史继承及二次恢复、Responses 原生压缩窗口、Claude 来源、非法链接、执行性输入、安全错误、时间回拨、到期/撤权、空及多 root 歧义、超过 16
MiB 的合法批次与全局 256 快照上限。实际 Windows 加密 worker 保存完整 root 后关闭原会话和 worker，重开存储并重建新会话，验证同一来源精确读回、原预算与私有历史续接；不依赖旧在线 ledger。

八文件专项 94 项通过，范围 Lint/格式、四个 JS 语法、CI/发布治理和统一 unit 发现通过；新模块进入发布清单，新测试进入显式客户端覆盖。字面统一客户端命令两次未通过：首轮 470 通过、2 失败、1 取消；单独重跑 469 通过、3 失败、1 取消。错误涉及既有 stdio 网关 30 秒超时、代理 fixture 启动期限及一次既有存储 worker 不可用。失败日志分别保留为
`client-attempt1-startup-failed.log` 和 `client-attempt2-startup-failed.log`。

保持全部用例、超时和阈值不变，仅降低测试进程并行度的对照为 472 通过、1 失败；剩余 direct-upload
fixture 在 `server_start_requested,certificate_ready`
后未在原期限内 ready。随后不带覆盖率运行原
`context-api-evidence-routes.test.js`，两个真实隔离代理用例均通过，未修改该测试。该对照不替代字面统一命令，不足以证明并行度是唯一原因，因此未修改统一入口的并行度或任何门槛。当前不宣称客户端门禁通过。六个明确源码/测试/清单文件与本阶段验证前摘要匹配；最终结果和日志定位见
`.hpm-acceptance/context-recovery-root-state-20261019-01/milestone.json`。

这是完整状态恢复模块及调用方驱动的真实存储重开验证。生产会话尚未在捕获、读回、发布、取消或撤权时等待完整 root 的持久化事务；异步协调器/runner 接入、发布不确定状态、持久化撤销、清理和设置、WebSocket、真实客户端及最终整体门禁仍待交付。当前生产证据仍为内存；未启用功能、重启服务、安装插件、修改真实凭据或调用真实模型。完整
`verify` 本阶段未重跑，最近 404 文件格式失败记录保留。

## 分支注册表与私有历史受控恢复（2026-10-19）

新增 `context-recovery-binding-state` 与
`context-recovery-history-state`，既有绑定注册表及历史映射增加可信调用方专用的导出/恢复函数。导出经模块私有 WeakMap 访问，不增加网络或模型导入接口。注册表按 root 导出已提交且祖先完整的树，记录原始窗口/公开窗口与压缩连续性指纹、响应别名哈希、策略、锚点和绝对时间，不保存公开聊天原文。恢复依据当前可信绑定基础逐字段验证后重建窗口、压缩输入及响应别名索引，生成新 token；旧 token 与字符串 ID 不能操作新实例。

私有历史只导出明确请求的已提交 tip 与其完整祖先，拒绝 pending、已丢弃、已失效或外部范围的 token。持久状态只包含公开项指纹及允许的私有交换，保留顺序、插入位置、原始到期与字节计数；恢复重新执行已有三协议工具配对校验，拒绝高权限角色、外部工具、孤立结果、祖先重用调用、前缀冲突、缺失/循环父节点和不可达额外项。保留原生及签名块数据，不重新解释或改写它们。

批量恢复最多四个 root，并合并重建共享索引。重复窗口或响应别名继续保持歧义隔离，不能分别恢复后把多个候选缩成一个；绑定总快照上限及历史全局 256 条/4
MiB 仍共用，不能按 root 重置。时间水位取批次最大值；旧 root 到期时整个树失效，不剥离祖先后保留更新的孩子，也不延长私有历史期限。调用方必须先认证当前 root 并复核撤销，状态哈希本身不授予权限。

十五组新回归覆盖三协议精确私有交换、签名块保持、新旧 token、公开文本不落入状态、siblings、撤销、pending/丢弃/关闭、策略与主体变化、祖先和工具配对非法状态、各类执行性输入、根过期/时钟回拨、空批次、多 root 歧义、全局快照/容量和重复导入。实际 Windows 加密 worker 一次保存分支与私有历史后关闭原实例、关闭重开存储，再用新注册表与新历史 map 验证自动续接和精确 Unicode 私有交换。

最终 `npm run test:client:coverage`
455/455，语句/行 98.97%、分支 94.33%、函数 98.82%；新分支状态、既有绑定/历史、会话、压缩和 composition
root 六文件专项 67 项通过。五文件语法、范围 Lint/格式/diff、CI/发布治理、统一 unit 发现通过；两个运行模块进入发布清单，新测试进入显式客户端覆盖及统一 unit 发现。七个代码/测试/清单文件与验证前摘要一致，回执为
`.hpm-acceptance/context-recovery-branch-state-20261019-01/milestone.json`。

这完成受控状态恢复模块，生产会话尚未调用它们。这里的 committed 是模块内部提交，不是客户端网络发布成功的证据；完整 root 仍需原子保存授权、可见来源、调用观察、原文、预算、分支与历史关系，接通异步读回、发布确认、失败/取消撤回及持久化撤销。尚未完成生产聊天跨重启恢复、WebSocket、清理/设置、真实客户端或整体门禁。本阶段未重跑完整 verify，最近 404 文件格式失败不变；未启用功能、重启服务、安装插件、修改真实凭据或调用真实模型。

## 原文 ledger 受控导出与恢复（2026-10-19）

新增
`context-evidence-ledger-state`，既有 ledger 增加仅供可信调用方使用的导出/恢复函数，通过模块私有 WeakMap 访问导出闭包，不增加模型读工具或网络导入接口。快照记录版本、当前 owner/thread 的绑定摘要、完整配额策略、时钟水位、累计捕获/读取数，以及原来源 ID、调用 ID、工具名、参数摘要、内容摘要、字节数、创建/绝对到期时间、精确文本和连续读取进度；不保存原工具参数或私有 artifact
locator。

恢复要求调用方提供当前可信 owner/thread 与配置，并在进入本模块前认证完整 root。绑定摘要与配额必须完全匹配；摘要不是授权凭据。状态经 12
MiB 有界无执行规范化，字段、重复来源/调用、顺序、总字节、UTF-8、摘要、进度边界及计数一致性均严格检查。校验成功后创建新的私有 artifact 句柄，使用来源原创建时间建立原 hard
expiry，不重计 TTL；当前已过期的来源不重建，时间回拨拒绝。失败关闭新 ledger，不改变旧实例。恢复后的来源仍计入既有存储配额。

九组回归覆盖精确 Unicode/CRLF、不可变快照、来源 ID 与读取进度、空 ledger/空结果/全部过期、seek 与完整读回、绝对到期、时钟、主体/聊天/策略不匹配、重复及篡改、配额/顺序、非法 getter/toJSON/原型/循环，以及实际 Windows 加密 worker 关闭重开。实际测试关闭原 ledger 后，由新 ledger 使用原 receipt 读回内容；不复用原在线 ledger，但也不据此声称分支、私有历史和认证已恢复。

最终 `npm run test:client:coverage`
440/440，语句/行 98.91%、分支 94.22%、函数 98.77%；ledger 状态、预算、会话、既有 reader、SQLite、系统密钥与 composition
root 七文件专项 67 项通过。三文件语法、范围 Lint/格式/diff、CI/发布治理及统一 unit 发现通过。新运行模块进入发布清单，新测试进入显式客户端覆盖和统一 unit 发现；五个代码/测试/清单文件与验证前摘要一致。回执为
`.hpm-acceptance/context-recovery-ledger-state-20261019-01/milestone.json`。

生产入口尚未调用这些导出/恢复函数。下一步是可信分支注册表与已提交私有历史恢复、完整 root 的原子保存及发布/取消衔接，包括读取进度与预算结算失败之间的一致性。来源读取进度证明 ledger 页读取成功，不证明模型或客户端已经收到内容。过期清理、WebSocket、真实客户端及统一完整门禁仍未完成。本阶段未重跑完整 verify，最近 404 文件格式失败不变；未启用功能、重启服务、安装插件、修改真实凭据或调用真实模型。

## 持久化读取预算与写前预扣（2026-10-19）

新增预算状态校验与异步持久化读取器，既有同步 reader 增加受控计数导出/恢复。恢复生成新的私有预算 token，不接受序列化 token 作为 capability；只迁移调用数、已返回字节和成功读取数，不建立来源、分支或认证权限。未知数据经过有界且不执行 getter/coercion 的规范化，保存确认也严格验证单一整数 revision；异常内容不进入输出。

每次已准入的读取先重载最新状态，以 CAS 持久化一次调用及本页最大字节预扣，确认后才访问在线 ledger；然后持久化实际计数，收到合法确认才返回原文。预扣失败不访问 ledger；结算失败或进程中断保留最坏扣额，不重试。跨实例版本冲突只允许一方访问 ledger；同实例在途并发拒绝。关闭期间检查每个异步边界，已关闭请求不发布原文。64 次/512
KiB/单响应 16
KiB 上限不变，非法参数和失败尝试仍计入预算，撤销记录不能重新初始化为零。

十组回归覆盖正常、空/非法/极端/可执行状态、隔离计数、重开后耗尽、预扣/结算失败、撤销、合法元数据下的非法记录、各阶段非法确认、近字节上限、ledger 异常、CAS 竞态、关闭时预扣未确认及错误依赖。实际 Windows 存储 worker 保存后关闭重开，使用原在线 ledger 验证精确计数保持；这不是从磁盘恢复 ledger 授权。一次新增断言曾因 SQLite 规范对象使用 null
prototype 而失败，随后改为比较其规范 JSON 数据，计数及失败行为断言保留。

最终 `npm run test:client:coverage`
431/431，语句/行 98.89%、分支 94.12%、函数 98.74%；预算、会话、既有 reader、SQLite、系统密钥与 composition
root 六文件专项 58 项通过。范围 Lint、格式、四文件语法、diff、CI/发布治理、统一 unit 发现通过；两个新运行模块加入发布清单，新测试加入显式客户端覆盖及统一 unit 发现。六个代码/测试/清单文件与验证前摘要匹配，回执为
`.hpm-acceptance/context-recovery-durable-budget-20261019-01/milestone.json`。

这是持久化预算原语的资格验证，未接入生产会话。当前独立预算记录只服务测试/集成边界；完整 root 接入时须把预算与授权、来源、分支和历史保存在同一检查点，不能额外分配 root 绕过四 root 配额。真实来源和已提交历史的可信导出/恢复、发布事务、过期清理、WebSocket 及实际客户端仍待交付。本阶段未重跑全仓库 verify，最近 404 文件格式失败仍有效；未启用功能、重启服务、安装插件、修改真实凭据或发出模型请求。

## 专用存储 worker、文件所有权和系统包装密钥（2026-10-19）

新增存储异步接口、专用 worker、文件边界与连接所有者四个模块。生产入口尚未调用它们；实际测试均使用独立临时目录。父线程只传经过校验的目录和有界请求，数据密钥留在 worker 内；SQLite 和 ACL/DPAPI 原生操作均在 worker 执行。每实例最多八个普通在途请求、16
MiB 请求总字节，初始化、操作及关闭都有期限；非法/重复响应、异常、超时和意外退出使实例永久失败，不重试。关闭必须收到合法确认并观察到正常退出，确认后不退出也会超时失败。

存储目录仅创建指定专用叶目录，父目录必须已存在。初始化与每次操作验证祖先及固定文件身份，拒绝符号链接/junction、硬链接、未知文件、超限文件、UNC 和替代数据流路径；只接受固定文件名。先检查目录内容，再运行权限设置，防止已有权限标记硬链接被改写。目录和文件使用现有私有权限实现，原生 ACL 工具额外限制五秒超时和输出大小。持有独立
`.writer.sqlite` 的 SQLite
EXCLUSIVE 事务作为整个所有者生命周期的单写入锁，数据事务使用另一连接；不通过 PID 文件猜测锁状态。

首次初始化生成随机 32 字节数据密钥，严格 CurrentUser DPAPI 包装后在私有目录创建
`.data-key`
并 fsync；只有系统包装串写入文件。重开只解保护现有包装密钥，验证数据库认证头；已有数据库缺少密钥时绝不生成替代密钥。密钥文件内容摘要与文件身份在服务生命周期内固定，变化后关闭所有者。首次密钥写入中断留下的部分文件不自动修复或重置；仍需显式恢复/清理策略。其他平台的系统密钥库仍未实现，真实 worker 明确失败，不使用测试注入的兼容后端。

八项新测试组覆盖空/非法/可执行参数、过长路径、目录 junction、根/文件替换、硬链接、超限密钥、权限标记硬链接、系统保护失败、密钥丢失/变化、并发所有者、队列数量/字节、失败/非法/重复回复、初始化与操作超时、关闭确认后未退出。真实 Windows
worker 使用 DPAPI 在临时目录完成保存、并发第二写入拒绝、精确 Unicode/序列化预算读回、关闭重开和再次重开后的撤销；没有直接向真实 worker 传递明文数据密钥或测试保护函数。文件层注入后端仅用于独立测试，不是可配置的生产回退。

最终统一客户端覆盖 421/421，语句/行 98.86%、分支 94.06%、函数 98.71%；存储服务、SQLite 引擎、系统密钥、既有同步/异步私有文件及 composition
root 六文件专项 35 项通过。范围 ESLint、Prettier、五文件语法、diff、CI/发布治理和统一 unit 发现通过。四运行模块进入发布清单，新测试进入显式客户端覆盖和统一 unit 发现。最终七个代码/测试/清单文件摘要与验证前基线匹配；较早同为 421 项的结果未覆盖最后补充的标记硬链接与极端路径场景，最终结果以
`client-final.log` 和 `focused-final.log` 为准。回执为
`.hpm-acceptance/context-recovery-storage-service-20261019-01/milestone.json`。

这完成了可运行的本地存储服务底座，未完成聊天跨重启恢复。可信授权/分支/来源、私有历史、运行读取预算与撤销的导出恢复、客户端发布事务及取消后的持久状态、过期回收/清除和设置接入仍待实现。整库外部回滚保护、实际服务进程崩溃后的所有权恢复、磁盘满及系统密钥轮换仍需专项验证；不能把正常 worker 重开当成这些门禁已通过。生产原文仍仅在内存，未启用生产、重启服务、安装插件、修改真实凭据或发出模型请求。完整 verify 本阶段未重跑，最近已记录的 404 文件格式问题仍未收口。

## SQLite 加密检查点事务引擎（2026-10-19，此前阶段）

新增独立存储契约、AES-256-GCM 内容封装和 SQLite 同步事务引擎，未接入生产入口。每条检查点使用随机 12 字节 nonce；storeId、scope、revision、创建/绝对过期时间、记录类型和版本均参与认证。SQLite 仅保存最小化元数据和密文；数据库头中的时钟水位也经过认证，错误密钥、元数据或密文篡改拒绝读取。UTF-8 严格解码，未知输入经过有界、无 getter/强制转换执行的规范化；错误统一为固定 503，无原始异常或原因链。

保存使用 expectedRevision 比较与单事务提交；已有条目的 TTL 只能缩短，不能重新计时。撤销用同一事务替换为加密 tombstone，重新打开数据库后仍拒绝旧范围的保存和读取。失败事务不改变原版本与已提交内容；ROLLBACK 自身失败则永久关闭该引擎和密钥边界。引擎不自动逐出活跃检查点或撤销记录，最多四个活跃检查点、256 条记录，规范状态每条 12
MiB、活跃密文合计 32 MiB，数据库页上限 64
MiB。这里是完整检查点容器上限，不扩大既有单条工具证据、root、TTL 或 reader 配额；会话层原有配额仍需分别保持。过期回收、清除与容量耗尽处理尚需存储服务接入。

十一项新测试组覆盖正常、空/非法/极端数据、可执行对象、每个认证字段的篡改、错误密钥、随机 nonce、隔离范围、版本冲突、TTL、撤销、时钟回拨、未知 schema、配额和事务失败。真实临时文件关闭重开验证精确 Unicode 和序列化预算值；磁盘不含新生成的合成 ASCII 标记、中文原文或明文密钥。另以独立子进程提交后开启未提交修改并直接退出，由父进程重开数据库，验证只保留原提交、完整恢复原文且 integrity_check 正常。这是存储事务的实际进程退出测试，不是宿主聊天恢复或完整服务的崩溃验收。

最终 `npm run test:client:coverage`
为 413/413，语句/行 98.97%、分支 94.30%、函数 98.63%；存储、系统密钥和 composition
root 三文件专项 21 项通过。范围 ESLint、Prettier、五文件语法、diff、CI/发布治理与统一 unit 发现通过。三运行模块进入发布清单，新测试显式进入客户端覆盖并由统一 unit 发现。七个明确代码/测试/fixture/清单文件与验证前摘要匹配；新增进程退出测试前的较早 412 项结果不覆盖最终测试快照。回执为
`.hpm-acceptance/context-recovery-sqlite-engine-20261019-01/milestone.json`。

当前引擎要求调用方提供独占连接和数据密钥，不自行打开文件或访问密钥库，尚无专用 worker、异步队列、受限目录/文件身份验证、独占进程所有权或 DPAPI 包装密钥生命周期接入。检查点 state 目前仅作有界 JSON 保存，不据此建立可信 capability；序列化预算值保持也不等于运行预算已经恢复。授权、分支、私有历史、来源出处、预算与撤销的可信导出/恢复及发布事务接入均待交付。认证加密不提供对整份旧数据库被外部替换的可信防回滚保证。当前生产证据仍仅在内存。

本阶段未重跑完整
`verify`；最近记录的 404 文件格式失败仍未收口。未启用生产、重启服务、安装插件、操作真实凭据或发出提供方请求。下一阶段将以专用 worker、目录与文件所有权、系统包装密钥管理为入口，随后接入可信会话状态恢复。

## Windows 系统数据密钥保护（2026-10-19）

新增四个独立模块：密钥请求与响应契约、严格 DPAPI 原生执行器、一次性 worker 和异步保护接口。数据密钥必须是规范 base64 编码的 32 字节；包装密钥使用明确版本前缀和有界编码。未知输入经过无 getter/强制转换执行的数据校验，所有失败返回固定 503 错误，不携带原始错误或原因链。

Windows 使用当前用户 DPAPI 和固定命名空间熵。原生程序路径、脚本及参数固定；密钥只走有界 stdin/worker
IPC，不进入命令行。子进程只继承必需的 Windows 目录变量，隐藏窗口，有独立超时和输出上限。此实现不调用现有凭据兼容加密，不回退到文件主密钥；非 Windows 平台明确失败，其他系统密钥库尚未实现。未写入真实密钥或用户内容。

保护接口每实例最多两个并行 worker，没有队列或重试。只有单一合法结果并随后正常退出才成功；重复或非法消息、异常、提前退出、非零退出及超时安全失败。终止失败时请求虽已拒绝，容量继续占用，直到实际观察到 worker 退出，避免释放仍在运行任务的名额。worker 输出被消费但不转发到日志。

九项新测试组覆盖正常、空、非法、非规范 base64、最大值、超限、可执行对象、原生进程错误/非法输出、stdin 与环境隔离、worker 启动/发送/消息/退出错误、终止失败、超时与并发。实际 Windows
worker 使用新生成的合成随机密钥完成 DPAPI 保护、解保护、密文篡改和无效 blob 拒绝；没有提供方请求或真实凭据操作。

最终 `npm run test:client:coverage`
为 402/402，语句/行 98.92%、分支 94.26%、函数 98.56%；新测试与既有 secret-crypto、天禧恢复 key、composition
root 四文件专项共 14 项通过。范围 ESLint、Prettier、五文件语法、diff、CI/发布治理及统一 unit 发现通过。四个运行模块进入发布清单，新测试显式进入客户端覆盖并由统一 unit 发现。七个明确代码/测试/清单文件与验证前摘要一致；不代表全依赖或整个工作区冻结。回执为
`.hpm-acceptance/context-recovery-system-key-20261019-01/milestone.json`。

这是 Windows 系统密钥保护模块的本地资格验证，不是持久化恢复完成。SQLite 加密存储、授权与分支恢复、持久化预算与撤销、存储配置接入、故障注入和跨重启验收仍待实现。完整
`verify`
本轮未重跑，最近 404 文件格式问题仍未收口。未启用生产、重启服务、安装插件或发出模型请求。

## 恢复发布与结果报告隔离（2026-10-19）

新增回归先复现共享 HTTP 恢复发布缺陷：客户端已收到成功结果后，`onOutcome`
同步抛错会进入恢复失败分支，产生第二次终态通知并撤回已提交历史。修复将报告失败限制在独立边界内；同步异常和返回 Promise 的拒绝只增加固定类别
`reportingFailed`，不保存异常内容，不重试请求，不改变已发布结果。异步报告不阻塞失败响应或清理。该计数在配置尚未应用或随后关闭时也可记录，避免遗漏边界错误。

新专项覆盖成功、上游失败、写入失败和取消各自的同步/异步报告异常；断言仅一次通知、正确提交或撤回、502 安全错误、单次上游请求及监听器清理。三类实际本地核心 WBIPC 测试增加报告持续失败模式，仍完成两轮客户端请求、六次内部续接和下一轮私有历史精确读回，同时断言旧 handler 不执行，完成和失败计数不产生错误翻转。这里仍是合成认证和本地握手，不是提供方或安装客户端验收。

最终统一客户端覆盖 393/393，语句/行 98.89%、分支 94.15%、函数 98.51%；五文件相关专项 14 项通过。范围 Lint、格式、五个 JS 语法、diff、CI/发布治理及 composition
root 检查通过；七个明确代码/测试/清单文件按验证前基线复核未变，文档随后单独检查。新增回归已在现有统一客户端覆盖文件内；没有变更覆盖率阈值或测试入口。回执为
`.hpm-acceptance/context-recovery-publication-reporting-20261019-01/milestone.json`。

本阶段未重跑完整 verify，最近已记录的 404 个文件格式问题仍未收口；未安装插件、改变真实凭据、发起真实模型请求或启用生产恢复。持久化、WebSocket、完整能力诊断、策略与不透明历史、真实客户端及最终发布仍待交付。

## 运行诊断与设置入口（2026-10-19）

新增进程内
`context-recovery-diagnostics`，核心请求入口记录 Chat、Responses、Messages 的绑定成功/不可用，以及内部续接完成/失败的固定类别计数；管理 health 返回该模块的安全投影。配置请求状态与进程实际应用状态分开：未应用、配置无效、关闭和受限开启均有独立状态。配置检查不执行 getter，诊断不保存目标、身份、参数、原文、凭据、来源引用或原始异常；返回的是脱离内部状态的副本。关闭后仍允许已在途请求的终态计数，避免丢失撤权后的失败记录。

应用设置新增默认关闭的“自动上下文恢复”，沿现有表单读取、收集、保存和配置加载路径生效，不扩展旧 evidence 开关。首页沿既有 health 刷新展示进程累计绑定与续接计数，并明确原文仅存内存、重启丢失、WebSocket 透传、插件和实际客户端验收未核验。续接完成计数不证明模型发生了精确原文读取或最终任务正确。旧版、缺失、非法和不兼容状态显示不可用，不根据任意返回文本标记支持。

最初前端测试和构建在架构门禁失败：domain 不允许直接导入新增模型函数。已修正为 bootstrap 组合入口注入 formatter，未修改或放宽门禁。最终前端完整测试 25/25 文件通过，前端覆盖命令 5/5 文件通过，语句/行 97.13%、分支 86.15%、函数 94.82%；前端生产构建通过，保留单 chunk 大于 500
kB 的构建警告。统一客户端覆盖 391/391 通过，语句/行 98.89%、分支 94.14%、函数 98.50%；六文件相关专项共 9 项通过。三协议本地核心 WBIPC 测试同时断言真实执行对应的绑定、完成与失败计数。

范围内 Lint、格式、15 个 JS 语法、diff、unit 发现、CI/发布治理和 composition
root 门禁通过。初始 17 文件基线中的 tool-status 在架构修复时变化，另新增 bootstrap；修复后的 18 文件基线用于最终前端、构建与范围检查。客户端覆盖、前端模型覆盖和后端专项所对应的代码/测试/清单与初始基线匹配，未将两次验证间的前端变更宣称为全程冻结。文档随后单独检查。回执为
`.hpm-acceptance/context-recovery-diagnostics-20261019-01/milestone.json`。

本阶段重新执行字面
`npm run verify`，在格式检查报告 404 个文件问题后退出 1，未进入其后统一阶段；保留完整输出，没有通过排除目录或批量格式化无关工作取得绿色结果。检查运行期间发生上述前端架构修复，因此该全仓库失败不是完整冻结源码快照的验收。范围检查与最终前端构建另行通过，不能替代全仓库 verify。

这是聚合运行诊断与设置的阶段交付。逐客户端/传输/上游组合的实时能力矩阵、插件实际加载版本、存储用量与清除入口仍待完成；加密持久化、WebSocket、策略与不透明历史、真实验收及完整发布继续待交付。未启用生产恢复、重启运行服务、安装插件、修改真实认证或发起真实模型请求。

## WBIPC 共享核心入口与唯一接管（2026-10-19）

新增 `context-recovery-wbipc-entry`，核心入口为 Chat、Responses、Claude
Messages 的受限文本/普通函数工具形态选择共享恢复协调器。恢复资格要求认证解析器绑定的加密 WorkBuddy 凭据出处、已知 HTTPS 目标、固定路径与有效模型；预设、优化策略、旧 artifact/discovery 工具及不支持内容在接管前拒绝。旧路径仍负责未取得共享资格的请求；共享路径接管后的任何失败终止本轮，不调用旧 handler、原工具或旧恢复循环。

认证绑定覆盖配置与解析后的身份、完整凭据来源摘要及有界读取的实际认证文件字节，避免将另一版本文件绑定到旧解析结果。仅加密凭据分支获得资格。账号或凭据内容变化使旧授权失效，且新的 session
target 与原账号隔离。加强回归先提交真实调用锚点并读取到来源，再用换账号后完全相同的续接窗口确认来源数为零；不是只用空会话证明隔离。

共享 HTTP 发布器在转移 observer 所有权前构造并验证 dispatch/conversion，构造失败取消未发布计划。WBIPC 私有调度沿用固定 endpoint/ticket、实际发送前与响应后复查、无自动启动和不重试策略。请求或历史中出现旧工具时由旧入口独占；接管后上游产生旧 artifact/discovery 工具调用则返回固定失败，不将其释放为外部工具或再次进入旧循环。

三类实际本地核心 HTTP 测试分别使用合成认证文件和带认证握手的 WBIPC
socket，覆盖客户端 JSON/SSE、连续两次客户端请求及六轮内部恢复、精确 Unicode 原文、隐藏历史重建、混合外部调用的 ID/原参数保留，以及功能撤权、凭据变化、endpoint/ticket 变化、管道发现期间变化、500、opaque 输出、两类旧工具输出及取消。所有接管场景断言旧 handler 与旧 Chat
transport/Claude
conversion 调用为零。此处客户端 SSE 和调度模块已有的上游 SSE 契约分别验证，不能声称本阶段核心测试覆盖上游 WBIPC
SSE。

新模块进入发布清单，专项文件进入显式客户端覆盖及统一 unit 发现。最终
`npm run test:client:coverage`
为 388/388，语句/行 98.88%、分支 94.10%、函数 98.48%；十一文件相关契约共 47 项通过。范围内 ESLint、Prettier、13 个 JS 文件语法、diff、unit 发现、CI 治理、发布治理和 composition
root 门禁通过。15 个明确列出的代码/测试/清单文件按验证前摘要复核不变；这不是完整依赖或全仓库冻结。文档随后独立格式检查并绑定最终摘要。回执为
`.hpm-acceptance/context-recovery-wbipc-entry-20261019-01/milestone.json`。

尚未执行真实 WorkBuddy/Code
Assist 请求或实际客户端验收；没有启用生产恢复、安装插件、修改真实认证或重启服务。完整
`npm run verify`
本阶段未重跑，其最近已记录的格式失败仍未收口。持久化、WebSocket、不透明历史、预设/优化策略、受控用户文本归档、运行诊断和全端发布继续待交付。以下固定调度记录是此前快照，不能覆盖本节的新入口状态。

## WBIPC 固定调度能力（2026-10-19，此前阶段）

新增
`context-recovery-wbipc-dispatch`，为后续共享入口提供独立传输能力。创建时固定模型、Chat 路径及 discovery
endpoint/ticket；每次请求前、WBIPC 管道发现后实际发送前、响应返回后重新校验授权与端点。原 WBIPC 客户端增加可选
`authorizeRequest` 能力，严格要求同步
`true`，异常或其他值拒绝；未提供时沿用原行为。私有调度关闭自动启动，失败不重试、不切换端点、不调用已有 artifact 恢复循环或外部工具。

请求先规范化未知输入、验证完整 Chat 历史与工具配对，再按现有 384 KiB 字节及 96
Ki
token 估算上限中适用的更严格配置准入；不裁剪历史或修复配对来取得通过。只生成传输所需的 content-type/accept，不携带入口凭据或内部 header。响应有界校验，取消、撤权和原始 IPC 异常统一转为固定安全错误；不暴露 ticket 或内容。

新增八项测试组覆盖正常、空/非法/可执行对象、极端预算、getter 不执行、端点/ticket 变化、握手期间撤权、取消、单次派发、JSON/SSE，以及生产 Responses/Messages 转换器组合。共享 runner 通过带认证握手的 WBIPC
socket 测试桩完成三轮索引、精确 Unicode 原文读取与最终输出，并验证下一轮私有历史重建。测试已加入统一 unit 发现及客户端覆盖，模块已加入发布清单。最终客户端覆盖为 379/379，语句/行 98.84%、分支 94.06%、函数 98.42%；八个既有 WorkBuddy 测试文件共 31 项通过。

本阶段回执位于
`.hpm-acceptance/context-recovery-wbipc-dispatch-20261019-01/milestone.json`。验证期间发布清单摘要发生变化；代码、测试及 package 四个范围文件匹配验证前摘要，当前清单另行完成发布治理和格式核对。没有将清单变化归因于某个进程，也没有将范围摘要核对声明为全仓库源码冻结。

这是传输模块与共享 runner 的集成验证，主 HTTP 入口尚未选择该 WBIPC 能力，旧 WorkBuddy 路径仍拥有原恢复循环。尚需完成认证出处、唯一接管、核心入口和双循环互斥回归；不能把新增模块或 socket 测试桩视为真实 WorkBuddy/Code
Assist 验收。持久化、WebSocket、运行诊断、真实客户端及完整统一门禁继续待完成。本阶段未运行全仓库 verify、启用生产恢复、重启服务、安装插件或发起真实模型请求。

## 已落地的源码

- HTTP 与 WebSocket 共用
  `context-transport-policy`，在向上游发送前删除内部证据、目标绑定与工具发现 header；WebSocket 在入口认证启用时也删除入口凭据，然后使用独立上游凭据。
- 转发头复制不调用 accessor 或未知对象的字符串转换，校验非法头名、CRLF、过大值和非法数组，并保留原始入站 header 供本地验证。
- 新增 `context-binding`
  基础模块，只持有指纹和因果元数据。纯文本相同不建立聊天身份；已观察输出窗口、显式响应关系和完整原生压缩窗口支持受限续接。
- 相同候选窗口有歧义时隔离，不回退到更短祖先，也不合并候选；并行续接创建独立分支。认证主体、策略、协议或目标变化隔离；冲突、过期、非法时钟、伪造 capability 和配额耗尽安全失败。
- 新模块加入发布源码清单；新测试已确认由统一 unit 发现器收录。

- 新增 `context-recovery-sessions`、`context-recovery-protocol` 和
  `context-recovery-observer`，并在普通 HTTP 核心入口接通受
  `contextRecoveryEnabled`
  开关保护的自动绑定与前瞻留存；默认关闭。显式 token 路径继续独立使用。
- 会话服务按快照限定可见原文，兄弟分支不互读；同一根的不同读取视图共用预算。协议观察覆盖 Chat、Responses、Messages 的 JSON/SSE，观察器不改写客户端字节、不调用模型或外部工具。

主 HTTP 入口现已接入受开关及提供方判定保护的内部恢复执行器，范围见下方最新阶段。其余转换、官方登录桥和不支持目标仍沿原观察/透传路径。协议适配器仍须完善输出 ID、调用 ID 和原生检查点来源及语义的能力校验；不能因为任意兼容服务返回一个 id 字段就认定其全局唯一。

## 内部恢复与历史映射新增实现

- `context-recovery-turn`
  转换三种协议的只读工具定义、调用、结果与续接请求。禁止工具、强制工具、严格输出格式、不支持的托管工具和命名冲突不允许注入；外部工具没有执行器。
- `context-recovery-coordinator`
  管理最多 8 轮及 64 次内部调用、循环指纹、混合调用暂存和外部调用释放。外部调用保留原 ID 与参数；含不透明 reasoning 或签名的混合响应当前明确拒绝拆分，未声明该组合已支持。
- `context-recovery-runner`
  通过组合层注入的已授权 dispatch 执行 JSON/SSE 续接；统一处理取消、总时限、失败和逐轮 usage。它自身不选择上游、不重试、不执行外部工具、不写客户端响应。Claude
  SSE 的起始与结束 usage 已合并保留；失败续接仍返回已完成轮次的用量。
- `context-history-map`
  使用私有 capability、公开历史指纹和内部工具交换重建下一轮上游历史；校验授权范围、完整前缀、工具配对、提交状态及祖先关系。上限为 256 个暂存或已提交记录、4
  MiB 内容与指纹计费、30 分钟绝对有效期，不淘汰有效引用接纳新记录。该阶段尚未接原生压缩替换窗口，后续专项进展见下文；仅增量客户端输入及跨重启映射仍待完成。
- 会话能力新增
  `recovery(body)`：重建已授权祖先映射，暂存内部交换，并在公开输出与计划输出匹配后提交映射及绑定。取消、撤销、关闭和根过期释放相关映射。该阶段先交付会话服务集成；后续主入口接线见下方最新阶段。
- 修复显式 response
  ID 指向普通文本后代时，与较旧历史锚点发生的合法续接冲突。只允许完整历史窗口匹配且候选锚点均为已确认祖先的情况；编辑和异支冲突继续拒绝。
- 新测试加入既有 unit 发现和
  `test:client:coverage`，发布源码清单加入所有新模块；未调整覆盖率阈值。

新增回执与最终客户端门禁日志保存在
`.hpm-acceptance/context-recovery-coordinator-20261018/`。该目录中的早期专项覆盖对应各自源码快照，不代替最终客户端门禁。

最终 `npm run test:client:coverage`
为 252/252 通过；语句与行 98.74%，分支 94.46%，函数 98.03%。最终修改范围的语法、Lint、格式、unit 发现、发布清单、CI 治理与 composition
root 检查通过。`milestone.json` 绑定源码摘要和覆盖率报告摘要，明确
`automaticEndpointRecovery:false` 与 `goalComplete:false`。

## HTTP 调度与最终输出模块（2026-10-19）

- 新增
  `context-recovery-http-dispatch`，固定组合层提供的目标和凭据快照，每次调度、收到响应及完成响应时重新调用授权检查。去除内部 header 和旧压缩/长度 header，发送有界 identity
  JSON；不重试、不切换路由。提前关闭、截断、取消、超限、压缩响应、网络错误和授权异常均返回固定安全错误并销毁请求。
- 新增
  `context-recovery-client-wire`，为 Chat、Responses、Messages 编码最终 JSON 或完整 SSE，汇总已完成内部轮次的数值 usage，保留外部工具 ID、参数及不透明字段。两种输出模式都拒绝发布内部工具调用，移除响应中的内部工具定义；编码本身不写客户端、不提交会话。
- 观察器新增发布前的
  `detach()`，允许恢复执行器接管仍有效的会话；开始观察任何字节后拒绝转移，避免重复提交或把已公开事件当作未发布。
- 新增真实本地 HTTP 集成，连接会话服务、runner、HTTP 调度、客户端 SSE 编码和下一轮历史映射：经过三轮上游测试桩完成索引、精确 Unicode 读回及外部调用释放，确认内部调用和原文不出现在最终客户端输出。该测试不证明压缩后的恢复，也不代替主入口或真实模型验收。
- 新测试加入 `test:client:coverage`
  和统一 unit 发现；两个模块加入发布源码清单。该阶段尚未接主入口；后续提供方判定、权限/目标复查和发布逻辑见下方最新阶段。默认恢复开关未改变。

本阶段最终
`npm run test:client:coverage`：275 项通过，0 失败；语句/行 98.66%，分支 94.05%，函数 98.08%。修改范围语法、ESLint、格式检查及发布、CI、composition
root 治理检查通过，已确认新增测试被统一 unit 发现。回执位于
`.hpm-acceptance/context-recovery-http-20261019-01/milestone.json`。未重新运行全仓库
`verify`，此前全仓库格式失败仍未解决；不将本阶段门禁作为整体通过。

## 主 HTTP 入口与发布阶段（2026-10-19）

- 新增
  `context-recovery-http-entry`，由核心入口组合实际 transport、固定请求选项、会话、观察器和终态登记。只有已有可读来源、完整请求可解析、工具策略允许且观察器尚未发布字节时才接管。
- 默认提供方判定限于 HTTPS 443 的 `api.openai.com` Responses/Chat 与
  `api.anthropic.com`
  Messages 原生路径，并排除官方登录和环境重定向到其他主机/端口。兼容上游、转换路径、WorkBuddy、官方 Codex 登录桥及 WebSocket 尚未接入此通用入口恢复；不能将默认判定规则视为这些客户端已通过验收。
- 授权闭包固定初始 Principal、完整 live
  profile 及影响转发的环境设置；从当前配置重新做入口认证、路由授权、开关和凭据/目标检查。每次内部请求、收到响应、响应完成及发布前均复查，不沿用入口开始时的旧配置。恢复请求不参与原有自动重试与切换路由。
- 最终结果完成有界编码和会话提交后才发布，保留客户端原始 JSON/SSE 选择；等
  `finish` 再登记成功。错误、断开或发布前撤权不登记成功。新增
  `withdraw`，在提交后发布失败时撤回本分支及后代响应别名/映射，保留祖先与兄弟分支。
- 实际 `createCoreRequestHandler`
  本地 HTTP 测试经过主入口、真实本地上游和三轮内部恢复，覆盖 JSON、最终 SSE、权限撤销、一次终态登记以及内部内容不公开。该测试显式注入仅供测试的本地提供方 capability；生产默认不接受 loopback 作为已验证提供方。尚未发起真实模型请求，不证明各客户端整体完成。

本阶段客户端测试最终独立复跑为 283 项通过，0 失败；覆盖率及源码摘要绑定
`.hpm-acceptance/context-recovery-http-entry-20261019-01/milestone.json`。修改范围语法、Lint、格式、unit 发现、发布清单、CI 及 composition
root 治理通过。前两阶段数量与覆盖率均保持各自快照含义。整体目标、持久化和多端验收仍未完成。

并行执行全仓库格式检查时，有一次客户端复跑为 282/283：既有 direct-upload 集成的隔离服务在 15 秒启动期限内只到达证书就绪，未进入请求断言。保留失败日志；全仓库检查结束后，以未修改超时、断言和阈值的相同客户端命令独立复跑通过，不将失败记录删除或算作通过。未证明该超时只可能由资源竞争造成。

本阶段字面 `npm run verify`
在格式检查报告 399 个文件问题后退出 1，其余整体验证未执行。检查期间共享工作区仍有修改，最终范围另行完成格式及 Lint；不将 399 项都认定为既有问题，不批量改写临时文件或降低门禁。

## 独立原生压缩映射专项核对（2026-10-19）

当前源码新增 `context-recovery-compaction`，在受支持的原生 Responses
compact 路径接通会话映射与发布检查。省略生成工具定义的 compact 请求使用独立连续性索引定位已观察父快照，继承其完整策略；普通生成与读取不放宽策略校验。完整规范输出提交后保留原响应字节，撤权、取消和发布失败撤回对应映射。压缩替换时清空该分支旧的私有工具历史，继承可授权证据，不修改不透明块。

本次方案整理重新执行以下六个测试文件：`context-recovery-compaction.test.js`、`context-binding.test.js`、`context-recovery-sessions.test.js`、`context-recovery-protocol.test.js`、`client-context-target.test.js`、`native-compaction-response.test.js`，62 项通过，0 失败。包含真实本地核心 HTTP 连续三次独立压缩及后续精确 Unicode 原文读回、规范响应字节不变，以及歧义、非法输入、超限、过期与撤权等专项回归。上游为测试桩，不是真实提供方或安装客户端验收。

上述 62 项为方案整理时的源码快照。后续当前阶段的客户端覆盖与源码回执见下一节，不将上一阶段 283 项结果视为当前源码的重新验收。恢复映射 2
MiB 边界与原生压缩通道 16
MiB 上限分别适用。官方登录、服务端阈值压缩、增量输入、跨重启与 WebSocket 恢复仍未完成；默认开关和生产运行状态未改变。

## 三协议 HTTP 连续性与原生压缩阶段（2026-10-19）

新增实际核心 HTTP 的 Chat 与 Messages 测试，分别验证最终 JSON/SSE、两次客户端请求和六轮内部调用、精确 Unicode 读回、内部工具及原文不出现在最终客户端输出、聚合 usage、一次终态登记，以及运行时关闭功能后停止继续请求。与此前 Responses 回归共同覆盖三协议本地核心入口，上游均为本地测试桩；默认生产提供方判定没有扩展。

新测试先复现了真实连续性缺陷：普通文本输出没有自己的观察锚点，下一次 Chat/Messages 请求会选择较旧的祖先，使上轮私有恢复历史缺失。修复后，只有完整包含已确认锚点窗口且唯一关联父快照的后代，才继续索引其公开历史。纯文本根、缺失完整窗口的增量 response-ID 续接不能建立文本查找身份；相同完整后代仍歧义隔离。回归覆盖跨主体、纯文本、增量、重复窗口及撤回分支，不放宽普通策略或原有配额。

本阶段 `npm run test:client:coverage`
为 300 项通过，0 失败；语句/行 98.69%，分支 94.51%，函数 98.20%，阈值未变。新增测试位于已有统一 unit 发现和客户端覆盖入口；修改范围语法、Lint、格式以及发布清单、CI、composition
root 门禁通过。源码与覆盖摘要回执保存在
`.hpm-acceptance/context-recovery-native-continuity-20261019-01/milestone.json`。

本阶段未重跑全仓库
`verify`；上一阶段 399 个文件格式问题的失败仍有效，不宣称其后整体阶段通过。未发起真实模型请求、启用恢复开关、安装插件或重启生产服务。官方登录、转换、持久化、WebSocket、实际客户端与整体门禁仍是完整目标的未交付项。

## Codex 官方登录 HTTP 适配（2026-10-19）

新增
`context-recovery-auth`，由现有认证解析器为已解析的 OpenAI 官方凭据建立进程内出处能力。配置 profile 与解析后 profile 分别绑定摘要，支持既有的 ChatGPT 后端地址重写和配置密钥/本地登录文件两种来源。JSON、入站 header 或同名属性不能伪造该能力；正常的可信请求规范化保留能力。授权复查同时验证当前入口主体、完整 live
profile、环境与凭据出处，不再错误要求配置中的占位 key 和解析后的 token 相等。

默认恢复提供方判定新增严格的 HTTPS 443
`chatgpt.com/backend-api/codex/responses`，独立压缩对应
`/compact`；仅允许具有认证解析器出处能力的
`official-login/openai`。不扩展到其他官方登录提供方或兼容主机。原生 API 判定继续保留；本地 HTTP 只由测试依赖显式允许。Codex 仍要求完整 input、`store:false`
和上游 SSE，拒绝 `previous_response_id` 与 API
`context_management`，客户端的 JSON/SSE 偏好由最终发布层保留。缺省 instructions 以该后端规范化后的空字符串参与绑定。

本地登录文件出处只做摘要校验，不输出或保存原文。复查最多读取 128
KiB，文件变化、删除、变成目录、超限或不可读使该请求的恢复授权失效，不静默换凭据重试。该上限约束可选恢复资格，不扩大原认证解析器的普通转发能力。凭据加载错误改为固定日志，并用隔离子进程验证原异常内容不会进入日志。

内部 Responses HTTP 调度现在在收到完整 `response.completed`
SSE 数据块后结束已完成请求，释放仍开放的上游连接，再由既有 runner 验证完整协议结果。不会因 event 名、文本中的标记或缺失空行的半个 SSE 块提前完成；非法 JSON、失败/不完整终帧和撤权安全失败。保留完整响应大小、取消、读回预算和无自动重试规则。

实际本地核心入口新增官方登录 JSON/SSE 与凭据文件变更测试；使用真实认证解析器和独立临时合成登录文件，没有读取真实登录凭据。另有官方登录形态连续三次独立压缩、规范输出字节不变和精确原文读回；所有上游均为本地测试桩。该阶段不代表已安装 Codex 版本或真实提供方验收，不代表 WebSocket 支持。

本阶段最终门禁、覆盖率与源码摘要记录在
`.hpm-acceptance/context-recovery-official-http-20261019-01/milestone.json`。未启用生产恢复、修改真实登录文件、重启服务或调用真实模型；完整目标保持未完成。

## 首批转换入口恢复（2026-10-19）

新增 `context-recovery-conversion` 与
`context-recovery-converted-http`。核心入口在旧转换 handler 接管前，尝试 Responses
→ 原生 Chat、Messages
→ 原生 Chat 的共享恢复；组合层注入已有生产纯转换器，内部历史仍以客户端协议保存，逐轮转换请求并验证原上游与转换后的响应。内部请求使用固定 HTTP 调度，不复用会重试、刷新认证或发布输出的完整 handler。入口与原生恢复共用授权复查、发布提交、取消和终态登记。

首批只准入可验证的文本、普通函数工具和明确支持的控制项。未知字段、签名 thinking、不透明压缩项、多模态、托管工具、强制工具及未支持的选项不被过滤后继续；在接管前保留原有允许路径。提示词预设、上下文优化、官方登录转换与 WorkBuddy 暂不接管。工具定义丢失或生产参数清理改变外部调用时安全失败。工具调用 ID、名称及参数经过转换前后校验，外部工具仍由客户端执行。

恢复上游请求使用非流式 Chat，接收 JSON 或合法 SSE；客户端最终 JSON/SSE 偏好仍保留。实际本地核心入口覆盖两次客户端请求与六轮内部恢复、精确 Unicode 原文、隐藏历史续接、聚合用量、内外部混合暂存、撤权、未完成响应安全失败和客户端取消。接管后的失败不调用旧 handler 重放。测试清除转发环境覆盖并使用合成 key，所有上游为本地测试桩。

新增测试进入统一 unit 发现及客户端覆盖，模块加入发布清单。本阶段客户端覆盖 321/321 通过，语句/行 98.75%、分支 94.59%、函数 98.30%；专项 51 项及 3 个既有转换契约测试文件通过。修改范围 Lint、格式、31 个 JS 文件语法、unit 发现及 CI、发布、composition
root 门禁通过。未重跑全仓库 verify，历史格式失败仍有效。

本阶段最终门禁与源码摘要见
`.hpm-acceptance/context-recovery-conversion-http-20261019-01/milestone.json`；以实际回执为准，不累加历史测试数量。未启用生产恢复、修改真实认证、安装插件、重启服务或发起真实模型请求；完整目标尚未完成。Chat/Messages
→
Responses、反向 Messages、Gemini、WBIPC、预设与优化策略、更多历史形态仍待分批交付。

## Chat/Messages 到 Responses 转换恢复（2026-10-19）

新增 `context-recovery-responses-conversion`，复用生产 Chat/Claude →
Responses 请求与响应转换器，并抽取共享
`context-recovery-conversion-guards`。核心转换入口新增 `chat->responses` 与
`claude->responses`；原生 API 与具有认证解析器出处能力的 Codex 官方登录分别资格检查。组合层继续只注入转换函数；内部历史、客户端工具执行权与最终发布事务不变。

每轮请求都保留完整历史，比较转换前后的文本、调用 ID、名称、参数、结果和错误状态；校验工具 schema、控制项与模型没有被改变。Chat 指令只允许连续前缀且不混合 system/developer 优先级，无法无损表示的历史在接管前沿既有允许路径处理。缺省指令保留空字符串，不额外注入默认角色提示。普通函数默认显式
`strict:false`，防止上游隐式改变非严格 schema 契约。禁止内部工具策略被转换器静默改成强制工具。

修复生产 Claude → Responses 转换器未响应 `nativeContextManagement:true`
的缺口：该明确选项现在与 Chat 转换器一样禁用本地历史裁剪，普通调用仍沿原策略。既有直接转换契约增加激进预算下的完整保留回归，新增适配器也在相同预算下检查原文未丢失。

上游固定使用完整 input、`store:false` 和 `stream:true`，官方登录仍不支持 API
`previous_response_id`/`context_management`；最终客户端可选择 JSON/SSE。原始与转换后响应都经过验证，工具 ID 与参数漂移、文本丢失、非法配对和控制项漂移安全失败。含签名 thinking、不透明 reasoning/压缩项、托管工具及其他无法无损映射的形态仍未支持，不能因官方登录合成测试通过就宣称真实后端所有响应形态可用。失败后不重放旧 handler。

实际本地核心测试现按六类转换/认证组合运行：已有两类到 Chat、新增 Chat/Messages 到 API
Responses 及到官方登录形态 Responses。覆盖连续两次客户端请求、六轮内部恢复、精确 Unicode 原文、隐藏历史衔接、外部混合调用暂存、最终 JSON/SSE、上游 SSE、撤权、未完成与不透明响应安全失败、取消，以及真实认证解析器读取合成登录文件后变更撤权。默认生产资格规则不接受测试的 loopback；实际宿主和提供方尚未验收。

本阶段最终客户端覆盖 337/337 通过，语句/行 98.83%、分支 94.31%、函数 98.33%；专项 54 项及 4 个既有转换契约测试文件通过，其中直接 Claude 转换测试包含 1650 个差分案例。修改范围 Lint、格式、36 个 JS 文件语法、统一 unit 发现及 CI、发布、composition
root 门禁通过。38 个代码和清单文件在验证前冻结摘要并在最终回执生成时复查；两份文档在验证后更新，单独检查格式并绑定最终摘要。

本阶段回执为
`.hpm-acceptance/context-recovery-responses-conversion-20261019-01/milestone.json`。未重跑全仓库 verify，历史格式失败仍有效。未启用生产恢复、修改真实认证文件、安装插件、重启服务或发起真实模型请求。反向 Messages、Gemini、WBIPC、预设/优化策略、不透明历史映射、用户文本归档、持久化、WebSocket、UI 和完整统一门禁继续保留在总目标中。

## Chat/Responses 到 Messages 转换恢复（2026-10-19）

新增 `context-recovery-messages-conversion`，接通核心入口的 `openai->claude` 与
`responses->claude`。Chat 复用生产 Messages 请求及 Chat 响应转换器；Responses 经受校验的生产 Chat 转换衔接。抽出共享
`context-recovery-conversion-projection`，与到 Responses 的适配器共用有序文本、工具调用和结果投影。组合层只增加生产转换器注入。

每轮关闭转换器的本地历史裁剪，验证完整文本、指令、工具配对、ID、参数、schema、strict、输出上限、采样和并行工具策略；比较中间 Chat 表示与最终 Messages 表示。转换前保存独立工具与控制项快照，拒绝转换器原地改写源对象后继续。未知输入、有歧义指令、孤立工具结果、空响应、重复 ID、文本/调用重排和转换漂移均安全失败。

该入口使用固定 `/messages`、`x-api-key` 与
`anthropic-version:2023-06-01`，不携带 OpenAI
Bearer 头。资格限制为受验证的原生 Anthropic 目标；官方登录、其他版本或 beta 请求头、服务层级、预设、优化策略及尚不能无损表示的历史继续沿未支持边界管理。上游生成使用非流式请求，但可验证上游返回的 JSON 或完整 Messages
SSE；客户端最终 JSON/SSE 选择保持。签名 thinking、托管与多模态内容尚未支持；接管后的失败不调用旧 handler 重放。

实际本地核心测试扩为八类转换/认证组合，新增两类分别覆盖连续两次客户端请求、六轮内部恢复、精确 Unicode 原文、多轮隐藏历史、外部混合调用、客户端 JSON/SSE、上游 Messages
SSE、撤权、取消、未完成及不透明响应。回归测试进入统一 unit 发现和客户端覆盖，两个新模块进入发布清单。

本阶段客户端覆盖 352/352 通过，语句/行 98.75%、分支 94.45%、函数 98.36%；专项 69 项与 4 个既有转换契约测试文件通过。范围内 Lint、格式、39 个 JS 文件语法、unit 发现及 CI、发布、composition
root 门禁通过；41 个代码/清单文件按验证前摘要复查，两份文档随后单独校验并绑定最终摘要。回执为
`.hpm-acceptance/context-recovery-messages-conversion-20261019-01/milestone.json`。

未重跑全仓库 verify，历史格式失败仍有效。未调用真实模型、改变运行服务、安装插件或修改真实认证。Gemini、WBIPC、预设/优化、更多不透明历史、API 服务端压缩/增量输入、受控用户文本归档、持久化、WebSocket、UI 和真实客户端验收仍未完成。

## 三协议到 Gemini API 转换恢复（2026-10-19）

新增
`context-recovery-gemini-conversion`，为 Chat、Responses、Messages 客户端接通原生 Gemini
API 的内部恢复。每个适配器通过组合层工厂创建独立的生产 Gemini 转换器，不复用含工具状态的全局单例。请求历史统一校验，再逐项比较文本、指令、调用与结果、参数及控制项；生产转换中的参数清理、名称修复或历史文本化一旦改变原语义，恢复安全失败。

Gemini 原生请求入口使用固定 `generateContent` 路径、`x-goog-api-key`，或既有
`ya29.` OAuth 格式的 Bearer 头。默认资格限定
`generativelanguage.googleapis.com`、HTTPS
443 和原生路径，环境重定向或兼容主机不能直接取得资格。官方登录、Code
Assist/WBIPC 和其他桥接后端未纳入本阶段。

新增内部 `nativeContextManagement:true` 选项，关闭 Gemini
Chat 适配器与最终 builder 两处历史裁剪；同一选项保留已验证的历史函数结构，即使混合阶段只向模型提供私有读取工具，也不把先前完成的外部工具历史改写为文本。普通转换仍沿既有裁剪和文本化策略。激进预算下的回归同时验证普通路径裁剪与恢复路径完整保留。

工具声明通过 Gemini 的 `parametersJsonSchema` 保留原始 JSON Schema，替换旧
`parameters`
的有损投影；不同时发送两字段，也不冒充支持 strict。2026-10-19 从公开
[Gemini v1beta discovery](https://generativelanguage.googleapis.com/$discovery/rest?version=v1beta)
核对该字段、对象约束及互斥契约。此处是协议依据，尚非真实模型验收。严格工具、不能保证的禁止并行策略、超出现有原生输出预算的控制项、服务层级与其他未支持选项仍不接管。

响应先验证原生 JSON/SSE、单候选 STOP 终态、调用完整性与用量，再复用生产响应转换器。保留提供方已有调用 ID；缺少 ID 时生成本次调用独立的随机 ID，不按名称和参数复用身份。转换器内部的工具 ID 包装经过明确校验后映射回原 ID；下一轮函数调用与结果继续携带同一 ID。多帧 SSE 合并用量字段，后帧仅有输出用量时不得清零先前输入用量。签名 thought、分片函数参数、多模态、托管输出及未完成/过滤终态继续安全失败，尚未声明这些组合可用。

恢复解码使用新的 `preserveExternalToolCalls:true`
选项，禁止生产转换器将超大 Write 调用落盘暂存并改写为 Bash。回归拦截暂存目录创建，验证完整参数仍交还客户端；普通转换的既有行为保持独立。另有两个独立适配器用相同调用 ID、不同参数反复转换的缓存隔离测试。

实际本地核心回归现为十一类转换/认证组合；新增三类覆盖两次客户端请求、六轮内部恢复、精确 Unicode 原文、隐藏历史、混合外部工具、客户端 JSON/SSE、上游 Gemini
SSE、撤权、取消、未完成和不透明输出。最终客户端覆盖 371/371 通过，语句/行 98.82%、分支 93.99%、函数 98.40%；专项和既有契约最终结果及源码摘要以
`.hpm-acceptance/context-recovery-gemini-conversion-20261019-01/milestone.json`
为准。

保留首轮完整覆盖率中的 stdio 网关 30 秒超时记录；单独检查与最终完整复跑均通过，未修改超时或阈值。多帧用量回归先复现输入用量从 2 变为 0，再修复并纳入统一 CI。未运行全仓库 verify，历史格式失败仍有效；未安装插件、启用生产恢复、重启服务或发起真实模型请求。WBIPC、预设/优化策略、不透明状态、API 服务端压缩/增量输入、受控用户文本归档、持久化、WebSocket、UI 与真实客户端验收仍待完成。

## 此前验证记录

以下为此前快照的验证记录；本阶段最终门禁结果单独记录，不叠加历史数量。

本次方案核对重新运行以下五文件，共 42 项通过，0 失败：`context-binding.test.js`、`context-recovery-protocol.test.js`、`context-recovery-sessions.test.js`、`client-context-target.test.js`、`context-transport-policy.test.js`。其中实际核心入口测试使用本地 HTTP 与上游测试桩，证明不带证据 token、不依赖插件即可自动关联先前观察调用并精确读回后续原文；不代表真实模型、完整应用或客户端整体验收。

以下为先前里程碑的验证记录，不将其覆盖率或门禁结果视为当前全部源码的重新验收：

- WebSocket 凭据转发回归先失败，再通过。
- 13 项分支绑定测试及 4 项传输策略测试通过。
- 相关五文件测试共 37 项通过，包含既有 WebSocket 与 API 三协议隔离集成。
- 两个新增模块的专项覆盖率：语句与行 99.44%，分支 97.32%，函数 100%。这是该源码快照的专项覆盖，不是整体覆盖率门禁。
- 语法、相关 ESLint、Prettier、发布清单、CI 治理和 composition root 门禁通过。

回执位于
`.hpm-acceptance/context-recovery-implementation-20261018-01/milestone.json`，专项覆盖位于同目录
`coverage/`。回执绑定源码摘要，标记
`goalComplete:false`、`productionActivation:false` 和
`automaticEndpointIntegration:false`。随后仅调整了传输测试的合成上游认证方式，避免读取环境 API_KEY，并重跑该文件 4 项测试通过。

## 2026-10-23 托管超时诊断候选

长历史独立进程新增固定阶段与整数毫秒诊断，覆盖模块加载、数据库打开、恢复、读取、发布及清理；父测试只解析白名单阶段，不转发原始 stderr。真实空闲 worker 的打开及重开沿用已有安全启动阶段回调。原有负载、断言和 5 秒请求、20 秒子进程、30 秒空闲测试期限均未放宽。本次是诊断补充，尚未证明托管超时根因已修复。

本地带覆盖率验证通过 38 项测试，真实 worker 测试由名称筛选排除并由本地 native storage 保护脚本兜底；覆盖直接 SQLite 合成长历史跨进程恢复、纯逻辑和诊断安全边界。首次筛选遗漏真实空闲 worker 测试，被保护脚本拦截后修正重跑，不计为真实 worker 验收。新增回归由统一 unit 测试自动发现；修改文件 Lint、CI 治理及发布治理通过。没有实际存储 worker、DPAPI、注册表、安装器或真实模型请求的本地执行。完整托管门禁仍待候选提交后的结果。

## 仍需交付

1. 完善运行状态诊断和提供方/客户端组合能力清单；已完成阶段的模块与本地回执不能代替真实验收。
2. 扩展原生及官方登录 HTTP 恢复到协议转换与 WorkBuddy；补原生 API 服务端压缩/增量输入、不透明混合工具和真实客户端验收，完善取消后的用量诊断。官方 Codex 后端保持其完整 input 契约，不冒充支持 API 增量参数。
3. 接通受控历史用户文本归档；保留现有保护、来源引用及事务不变量。
4. 实现 SQLite worker、内容加密、系统密钥保护、授权与预算重启恢复、清理和迁移。
5. 实现 WebSocket 协议感知留存与恢复，完成重连、背压、帧边界和 HTTP 并发验收。
6. 接通设置、运行状态、兼容迁移与可选插件升级诊断。
7. 运行完整统一门禁及按客户端、传输、上游组合的真实验收；按版本绑定生产候选与激活证据。

协调器里程碑曾执行字面
`npm run verify`，在全仓库格式检查报告 400 个文件问题后以退出码 1 停止；后续整体验证阶段未执行。该历史检查期间工作区仍在修改，最终修改范围另行完成格式与 Lint 验证，不把中途结果当作最终源码的全仓库门禁。主入口阶段的最新结果见上方，未批量改写临时证据或降低规则。

未安装或升级客户端插件，未启用持久化，未发起真实模型请求，也未修改运行中的共享服务。后续按完整方案继续实施，不将模块测试或注入 dispatch 的离线执行替代实际入口和客户端交付。
