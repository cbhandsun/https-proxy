# 上下文恢复换机交接

**最新接线证据：** 2bb4325后独立Core内存串联已跨过seed与三次摘要，却在最终LIST发现验收解析器遗漏生产coverage字段。现要求该固定单调用/单来源的完整五字段coverage精确相等，原文、分页和provenance断言保持；163项相关回归通过，本机Core串联13次合成请求、精确READ/独立公开生成通过，仍非安装/DPAPI/CLI资格。Claude模块预置首个真实tool call后的Core HTTP也已复现seed合法私有请求被合成上游拒绝，尚待下一批修复。2bb4325原安装40125667621仍在原完整门禁，不重启；五秒/60秒失败及其余范围保持，详情见状态顶部。

**当前安装阻塞优先：** 25acc53原安装运行40123107840终态failure，完整门禁、构建及实际升级回滚/DPAPI均success，客户端停在codex-enhanced-cli，Claude未执行。真实会话另复现增强seed首次工具结果后进入私有恢复，旧合成上游却一律拒绝seed私有工具；本批修正为私有回复后必须独立公开READY，保持原文、工具次数和私有隔离断言，163项相关回归通过，仍须新候选Windows复验，不宣称旧有限日志已证明唯一根因。五秒COMMIT和原60秒重开失败仍未关闭；增加的仅COMMIT当前worker线程CPU计数用于定位，不是性能修复。最新证据和剩余范围见实施状态顶部。

**最新失败证据优先：** 951a2cc正式Windows `40123574934` / source-gates `120960131561`失败，Claude long-persistent首轮请求5001ms触发原五秒截止。sequence=6的准入save-reference-state耗时4567ms，其中SQLite COMMIT为4126ms，anchor为314ms；此前scan为556ms。已定位本次主要等待边界，尚未确认底层原因或修复，不能删准入持久化、提前ACK或降低FULL/DELETE。7556263的原60秒重开失败独立保留。25acc53原安装运行40123107840已通过完整候选门禁、正在构建，尚无最新安装两端结论；不重启它。详细证据及边界见实施状态顶部。

**当前优先阻塞：** 7556263独立Verify八项成功，但安装链40121484825在原60000ms真实默认runtime撤销/清空重开门禁失败，尚未构建/执行客户端。46条阶段事件显示revoke已消耗59476.59ms，随后clear初次ready跨过总期限；不得把最后阶段当成已确认根因，也不提高期限。后续批次另修复客户端四组初始协议：Claude两组应从启动即用Claude，保存配置不会切换现有Responses监听器；206项相关回归通过，本机实际HTTP接线通过，不替代Windows安装。详细证据和边界见实施状态顶部。继续保留失败、完整门禁及原交付范围，不碰冻结长测，核对额度前不调用真实模型。

**最新续接：** ac32f58完整Verify八项及正式Windows四项均通过；安装链40119078841的完整门禁、构建及实际升级回滚/DPAPI生命周期成功，但客户端在codex-default-auth失败，尚未进入CLI。当前后续批次修正观察器对正确默认冷态（真实runtime存在、尚无会话）的误拒绝；产品默认行为和认证保持，150项相关回归通过，仍须新候选完整CI和安装四组。具体身份、失败边界及剩余交付见实施状态顶部。不要把已通过的安装生命周期扩为客户端资格；不访问、修改或重启冻结长测，额度核验前不调用真实模型。

记录日期：2026-10-24。用户要求先暂停，提交推送后换电脑续接。此文件是工作检查点，不代表功能全部交付。

## 仓库与续接入口

- 仓库：`https://github.com/cbhandsun/https-proxy.git`
- 分支：`acceptance/context-recovery/anchor-sanitized-v2-20261022`
- 本检查点的父提交：`d1669a83f57b88b2b266483b1d83380e4b21f71d`
- 最后已取得隔离安装生命周期证据的生产候选：`44d3f7467c090b9253dcce5c7a13f98712b474a3`
- 实施历史与证据边界：[实施状态](context-recovery-implementation-status.md)。本交接和状态文档顶部优先于下方旧条目中的进行中描述。

新电脑使用单独目录克隆该分支，避免覆盖其他工作区：

```powershell
git clone --branch acceptance/context-recovery/anchor-sanitized-v2-20261022 --single-branch https://github.com/cbhandsun/https-proxy.git HTTPS-Proxy-context
cd HTTPS-Proxy-context
git log -1 --oneline
git status --short
```

恢复工作后先确认Windows、Node.js和Rust构建环境。原机器使用Node.js 22.22.3；其他版本需要重新验证。依赖使用锁文件安装，原生助手在新机器本地构建。下面命令不调用真实模型：

```powershell
npm ci
node scripts/prepare-context-recovery-native.js
node --require ./test/helpers/physical-test-temp.cjs --test --test-concurrency=1 test/context-recovery-capacity-persistent.test.js test/context-recovery-capacity-clock.test.js
```

本机`.codex-tmp/`中的诊断脚本、冻结源码和报告没有上传，Git克隆不会带走这些文件。后续原生预检需从本提交的模块重新组合入口，并重新冻结、校验源码和可执行文件身份；不能引用原机器的进程号、绝对路径或旧冻结清单来证明新机器运行。

## 已完成和保留的结果

- 父提交d1669a83的Verify `40076052487`八项通过，独立诊断`40076052488`两项通过，正式Windows `40076052496`四项通过。正式N09 `120823367353`最终probesPassed、ownedTreeEmpty、tlsVerified、nonLoopbackBlocked均true。
- 第六个故障场景证明私有READ完成、公开生成被上游挂起时强杀，客户端未收到公开字节，同目录新PID可精确恢复，持久版本和预算不回退，外部工具不重放。未覆盖SQLite COMMIT内部或持久发布转换内部强杀。
- 本检查点将固定容量负载提取为共用命令序列，新增实际异步存储关闭/重开驱动和真实时钟节拍器。生产`lib`、`src`、`src-tauri`及`native`未因本检查点改变。
- 新增两个测试文件共16项通过，覆盖实际加密文件SQLite多根、多页、重开、清理、abort拒绝以及时钟边界；统一测试入口自动发现。Lint、格式、CI及发布治理检查通过。这些测试不证明原生DPAPI、OS锚点或真实24小时运行。
- 扩大运行18项中17通过，完整五档命令在既有180000ms预算下超时；失败保留。单独按同一预算顺序对照，旧版160762ms、新版152028ms，五档完整通过；最大档1920轮、400次精确恢复、20次重开。这不能消除混合运行超时或证明稳定性能提升。原60000ms性能目标仍未达到。
- 两个先前实际文件SQLite小档分别完成288轮/24次恢复/12次重开和384轮/32次恢复/4次重开，使用合成时钟且没有原生owner、DPAPI或OS锚点。最大档运行按用户暂停要求终止，没有最终通过报告。
- 安装候选44d3f746的隔离NSIS生命周期曾通过（运行`40062089174`，job `120777671704`），但安装守护进程管理矩阵仍为clientQualified=false、gracefulDrainQualified=false、forced_cleanup。不得据此宣称最终安装客户端验收完成。

## 当前失败与下一步

**a9836cd门禁结果优先：** Verify `40114984440`八项、正式Windows `40114984375`四项全部success。三份真实默认worker重开回执约3.75/4.82/4.23秒；本候选24次固定持久HTTP发布1175–3973ms，原五秒门限保留，旧失败不删。Windows五档容量67393.97ms未达原60秒目标记录保留，另一轮38658.10ms；Mac五档9.43秒仅为合成会话容量。安装链 `40115097429`首次resolve取消且无日志；仅恢复取消job后新resolve成功，encrypted `120937948810`在运行，四组实际客户端步骤尚未确认开始。下一步收齐该同一运行结果，按实际失败修复；详见状态顶部。长测不读不改不重启，模型调用0，整体未完成。

**8067628终态失败优先：** Verify `40113538815`六项成功、unit3/coverage失败，正式Windows `40113538709` source-gates失败，安装链 `40113568952` encrypted job `120930181450`停在候选完整verify，实际安装四组未执行。共同CRLF夹具问题已复现并修正，仅测试改动、生产锁守卫不变；coverage另有真实默认worker撤销/清空重开60000ms超时，现加固定阶段诊断，期限/断言/默认存储保持，根因仍未确定。下一步读取新候选真实Windows最后start/end阶段后修实际阻塞，不能把诊断或本机局部通过当成修复。长测不访问、不改、不重启，模型调用0。

**受控CLI管道修复批优先：** 608da0f路径夹具修正已推送并启动原门禁及安装链 `40113227807`；随后确认PowerShell EOF CopyToAsync完成调用会额外输出VoidTaskResult，现仅抑制这个无返回值结果，原异常和期限/Job清理不变。同一生产AST helper在Mac及Windows实际PowerShell验证14项管道断言通过，本机owned transport11/11通过；四组安装CLI仍无通过结果。详情见实施状态顶部，旧412失败保留，长测不动，模型请求0。

**412c800门禁失败优先：** Verify `40112658934` unit-tests (2) job `120927442702`因控制器测试把Windows路径分隔符写成正斜线而失败；已用真实Windows、固定原源码与PowerShell AST复现并验证修正后的完整路径精确转义检查。生产及工具实现未改，旧失败保留。新候选需重新完整verify/audit/build后执行安装矩阵；`40112676779`详细jobs观察超时不代表运行终止，不重启旧运行，不授予四组CLI资格。详情见实施状态顶部。

**安装矩阵接入批优先：** `a204c4c`完整Verify `40105361343`、正式Windows `40105361357`已终态success；新增实际NSIS/受控Codex和Claude四组矩阵总入口已接通并待原完整门禁后的托管实际执行，尚未取得实际安装客户端结果。新观察器真实发行清单解析阻塞已修，严格邮箱签名/原管理及入口认证、原网络和Job门禁不变。最新进度和Mac格式检查失败记录见实施状态顶部，不能把局部工具回归当成客户端资格。原生容量混合超时、真实24小时/到期重开、安装版持久重启/优雅退出、真实provider及自用启用仍需各自证据；冻结长测本阶段不访问、不改变、不重启，额度未核验前模型请求0。

**最新e490a58批次优先：** 完整Verify `40098018857` 八项和正式Windows `40098018924` 四项均success。最新9401ca6加密NSIS生命周期 `40096977916`（job `120881245475`）已success，安装/升级/回滚/重装/卸载及原625登记迁移拒写均通过；安装manifest `df511afd…`，原clientQualified/gracefulDrainQualified/restartRetention仍false、forced_cleanup不变。e490a58未改生产源码，五秒稳定性证据仍为原42样本，历史失败保留。

**582实际八步已通过：** 原4eb1ea48…的582包，与干净e490a58跨机准备并核验的当前Windows运行包b73b4354…在独立新OS-temp目录真实完成seed/read、拒绝隐式迁移、preview/enroll首次read、resave/read、旧582拒写新格式保字节、当前最终read；退出0，schema1→3、实际blob和revision精确+1、原expiry及全部内部精确回执均一致。该包不是NSIS安装产物；nsis/worker/24h/client资格明确false，详情及完整身份见实施状态顶部。下一步接入最新安装身份下Codex/Claude默认与增强实际隔离客户端，不能运行旧脚本中的日常认证/工作区Core注入。当前用户要求不动长测，继续工作期间不要读取、修改、重启或抢占冻结长测环境；下面旧记录中的日档状态检查建议本阶段不执行。额度未核验，真实模型请求0。

**9401ca6最终门禁及下一批：** Verify `40095495560` 八项与正式Windows `40095495598` 四项均success，N08/N09原各六场景安全probe四项均true；完整产品/日档/安装资格仍不据此授予。独立三冷runner各50/50，结合完整coverage和正式source-gates，本候选五runner共42次持久恢复1024–2369ms、零五秒失败。最新加密NSIS生命周期 `40096977916`已实际启动，job `120881245475`尚在候选验证阶段，未有安装/升级回滚最终结论。历史失败继续保留。

**582实包已找回：** Windows原`hpm-isolated-release-Wr2O5s/dist/staging/runtime`的manifest与旧4eb1ea48…精确一致，全部582源文件及Node/native/lock散列一致。已在全新合成目录以原包Node/native、已提交安全driver完成真实DPAPI seed和独立进程read，原文/身份/预算/key/原expiry内部回执相等，未开用户旧DB。新可复现入口`node scripts/qualify-context-recovery-legacy-layout.cjs <582包绝对目录> <当前包绝对目录> <当前manifest SHA256>`只创建新OS-temp数据根，复用原驱动执行八步，按schema1→3、resave实际blob及revision精确+1、旧版拒写保字节及当前重开验证；不接受用户DB路径。13项工具回归和扩大57项通过，不代表实际八步迁移已通过，后者待独立当前实包环境。运行中冻结日档未访问或改变，勿为此抢占其目录、任务或验收资源；模型额度仍未核验、调用为零。

**2c39a56收齐结果：** Verify `40092807977` 的coverage/unit(2)及正式Windows `40092807751` source-gates均因同一个Codex摘要恢复夹具失败，正式后续场景未执行。本机已复现：session时钟1001而storage固定10000，触发正确的未来观测拒绝；当前修正为共享夹具时钟，生产时间/认证/持久门禁不变。四文件81项回归通过。独立timing `40092807887` 30/30通过，加coverage及正式source-gates已执行的同类请求，共18次真实Windows持久恢复1227–2744ms、无五秒超时；不抵消完整CI失败。下一候选须收齐完整Verify、正式Windows和三个独立冷runner样本后再进入迁移/安装资格。历史失败及正在运行的冻结日档保持原状态，额度未核验、模型调用为零。

**2026-10-24 新进展优先见实施状态顶部：** 续接候选已推送为1dd06ea，不能替换运行中冻结树的身份。另已在Mac补充实际SQLite COMMIT锁等待内部强杀，以及五种持久发布状态在COMMIT内/提交后ACK前的强杀与正控，修正引用存储取消清理缺陷；尚不覆盖磁盘同步瞬间或Windows原生资格。快照后续优化保留所有重新解密认证，仅在保留完整聚合准入时避免完整checkpoint重建；不能证明大小安全时回到原decode。当前五秒排查已定位串行FULL提交尾延迟，并补生产复合READ减少一次持久提交；原独立预扣、认证、锚点、时间水位和ACK门禁仍保留，须先取得此候选真实Windows反馈，不能凭Mac对照宣称五秒已修复。 Windows 最小开库及真实多根多页短测已通过，旧原生失败未在新隔离环境复现，不能倒推旧根因。真实 day-small 已在独立冻结 Windows 工作树及一次性任务启动，尚未取得24小时及到期后结果；勿另起重复日档或按下面旧暂停描述重启它。先读取现有冻结树 `.hpm-acceptance/task.json` 和安全进度，确认对应 PID 的实际身份及任务终态，不能只凭旧 PID 判断。候选入口 `scripts/qualify-context-recovery-native-day.js` 固定真实画像与时钟，并包含24h之后实际根到期及双重开库拒读；回归假时钟不替代该运行。be7bacee现有CI两条均终态失败：coverage idle注入锁竞争和正式Claude long-persistent五秒请求失败均保留，父提交通过不覆盖它们。

新机器已补充可入库重现的开库入口（后续变更，详见实施状态顶部）：在 **Windows** 完成锁文件安装及原生准备后运行 `node scripts/diagnose-context-recovery-open.js`。它不依赖未导出的 STORAGE_STARTUP_PHASES，也不调用真实模型。先打印实际加载身份及源码/助手散列，再以默认 worker 和原期限对独立的新临时目录开库、空库 inspect、关闭及同目录重开；只输出固定阶段与耗时。非 Windows 或助手缺失返回退出码 2 且 attempted=false；运行失败退出 1，短测完成退出 0，但不授予容量或 24 小时资格。专用 `hpm-open-diagnostic-*` 临时目录及其独立 OS 锚点保留本地供排查，不入库；入口不会访问旧数据库或日常配置。此入口不取代后续固定容量负载和真实时间长测。

1. 原生短测首次开库尝试失败，尚未到第一个advance。storeOpens=1，qualified=false，未发现预期持久文件。独立目录原生ACL探针成功，只证明该次ACL调用正常。原生长测、连续24小时验收均未开始。
2. 最后的开库诊断脚本在展开STORAGE_STARTUP_PHASES时出现不可迭代错误，尚未调用原生存储。先比较实际加载模块的导出、冻结副本和源码身份，再采集有限开库阶段。不要把诊断脚本错误当成产品原生失败，也不要增加原5000/30000ms期限来寻求通过。
3. 原生短测通过后，才组合`exercisePersistentCapacityProfile`、`createCapacityRealtimeClock`和默认`openContextRecoveryStorage`执行冻结画像；必须使用真实worker、DPAPI、OS锚点和同目录重开，保留源码/Node身份与安全阶段回执。日档还需真实24小时及到期后重开验证，单元测试的合成24小时不能替代。
4. 收口既有剩余项：持久HTTP五秒延迟不稳定、COMMIT及持久发布内部中断、历史582/旧布局迁移与回滚、原生完整容量、最终安装版Codex/Claude默认/增强/认证/传输/成本验收、受控自用启用。

## 范围与安全约束

用户已明确仅自用：代码签名证书和公开安装器发行不再是本轮前提；现有公开release.yml签名要求保持。默认保留客户端原生压缩，代理精确恢复可选；启用持久化后开库失败不得静默回退内存。原文目标留存24小时，已有记录保留原到期时间；私有恢复后独立公开生成，优先隐藏恢复过程。

保持固定负载、正确性断言、既有期限、ACK精确版本相等及SQLite FULL/DELETE持久语义；不跳过测试、提高baseline、吞掉异常或自动重试模型来制造通过。已经发生的失败必须继续记录。推送本检查点不等于新提交已通过托管CI，也不等于生产已启用。

真实模型额度最近记录为累计上限177、已用169，余量Codex 1次、Claude 7次，分属既有授权，不可合并。此为交接快照，恢复前须核对原本机额度台账或用户后续授权；若新机器无法核实，不自行发起真实模型请求。本次暂停与提交未发起模型请求。

凭据、真实日志、原文、数据库、数据密钥和本机DPAPI/锚点材料都不入库。新电脑自行通过受支持的本地凭据配置接入；不要把旧机器受保护材料当作可直接跨机使用的配置。原机器日常目录的大量其他未提交修改、工作树中的原有Cargo.toml修改和私有证据保留原地，不属于本次Git交接内容。

用户恢复后可给新会话这条指令：

> 读取docs/context-recovery-handoff.md和实施状态顶部，从当前分支继续既定自用交付。先解决原生开库预检，再开始真实24小时验收；保留已记录失败和现有门禁，核对额度前不要调用真实模型，不扩大范围。
