# 客户端原生优先与可选精确恢复：方案及迭代计划

## 2026-10-23：独立 Verify 通过，保留完整门禁并解耦业务诊断

`41fb9a9c` 独立 Verify 八个 job 全部通过；disposable 完整源码门禁仍因 Claude 持久请求 5002ms 失败，N08／N09 跳过。并发资源实验仍在执行；另准备独立业务边界诊断，复用原受控执行器并明确不授予资格，正式 source-gates 依赖保持。详见[实施状态](context-recovery-implementation-status.md)，完整 I0–I5/H1、N01–N11 及最终交付范围不变。

## 2026-10-23：编码修复待业务复验，新增独立资源实验

`1e5b0f10` 两路托管均因 Chat 持久请求的原 5 秒期限失败，N08／N09 跳过，不能宣布编码修复已解除托管业务阻塞。当前 536 份暂存源码核验通过。独立实验准备以完整客户端覆盖率原命令对比文件并发 1／4，并用反向顺序控制顺序影响；正式门禁、负载、阈值、期限和完整 I0–I5/H1、N01–N11 保持，实验不授予发布或持久资格。详见[实施状态](context-recovery-implementation-status.md)。

## 2026-10-23：源码门禁与容量单次通过，业务资格仍未通过

`9c915d26` 的 disposable 完整源码门禁通过，正式五档合成容量全部通过且单次用时约 46.7 秒；独立 Verify 仍因 Claude 发布确认的原 5 秒期限失败，N08／N09 均在受限子进程退出阶段失败。共享 Job 授权的 stdin BOM 缺陷已用安全子进程先失败后修复，相关 16 项回归通过；候选尚待托管确认，不能宣称已解决全部失败。当前暂存 536 份源码与关键摘要一致。详见[实施状态](context-recovery-implementation-status.md)，完整 I0–I5/H1、N01–N11、安装迁移、全天及生产范围不变。

## 2026-10-22：当前原生合成四格通过，持久门禁仍阻塞

`2717104b` 标准运行时暂存的 536 份源码及关键文件摘要一致，暂存内 Node／模块纯回归 70/70；两端默认／增强四格原生合成任务各三次压缩全部通过，增强精确读回、默认零恢复、工作区代理回落 0、真实模型请求 0。两路完整托管仍失败：持久请求原 5 秒期限、idle reopen 原 30 秒及独立长历史子进程原 20 秒均有失败，N08／N09 跳过。直接 SQLite 的独立长历史本机覆盖率单项通过不能替代托管资格。详见[实施状态](context-recovery-implementation-status.md)，原 I0–I5/H1、N01–N11、安装迁移、全天及生产目标保持。

## 2026-10-22：独立 Verify 通过，完整源码链稳定性仍未通过

`2b04bf2e` 的独立 Verify 八个 job 全部 success，包含三层覆盖率；但同一源码 disposable 的完整 source-gates 中三协议持久请求仍触发原 5 秒期限，N08／N09 跳过。两路结论分别保留，不能宣布完整源码或稳定性资格。干净交付工作树及锁文件依赖已准备，暂缓重建失败资格源码的安装包，先推送已回归的解析器候选复验。详见[实施状态](context-recovery-implementation-status.md)，I0–I5/H1、N01–N11 与原验收范围保持。

## 2026-10-22：解析器重复准入候选，原托管继续跟踪

`2b04bf2e` 独立 Verify 七个 job success，覆盖率与 disposable 完整源码门禁仍待终态。解析器新候选保留每次未知输入的完整规范化、逐次摘要重算及语义校验，仅避免对本次已规范化的摘要投影重复准入；新回归先失败后通过，扩大纯回归 241/241，旧无 publications 信封补充定向通过。第二轮解析微基准墙钟中位数仅约下降 6.4%、CPU 基本持平且出现明显长尾，不能宣称稳定性能或请求期限达标。候选尚未推送，证据和完整 I0–I5/H1、N01–N11 范围见[实施状态](context-recovery-implementation-status.md)。

## 2026-10-22：创建器避免重复指纹准入，待完整托管

检查点创建器对已由本次调用完整规范化的载荷直接使用内部同算法指纹，外部未知输入、最终信封及 parser 摘要校验保持。新回归先失败后通过，六文件显式排除真实 worker 的纯回归 240/240；600 KB 内存 SQLite 正反交替快照墙钟／CPU 中位数分别约下降 5.4%／8.2%，不代表原请求期限已修复。新候选与前一笔 Proxy 安全修复拟一并进入完整托管，证据及完整 I0–I5/H1、N01–N11 范围见[实施状态](context-recovery-implementation-status.md)。

## 2026-10-22：候选完整托管失败，发布确认期限继续阻塞

`bdc7bbe1` 的独立 Verify 七个 job success，但 Claude 覆盖率在正文完成后等待最终发布确认至 5001ms 失败；disposable 完整源码门禁的三协议覆盖率也失败，业务跳过。纯内存快照剖析继续定位规范化／指纹成本，不替代磁盘或完整请求资格。引用版本识别新增 Proxy trap 回归，先失败后修复，两文件显式排除原生 worker 后 69 pass／4 skip，尚未推送；最初四项被本机 guard 阻断的失败保留。详见[实施状态](context-recovery-implementation-status.md)。原期限、独立锚点及 exact CAS ACK、I0–I5/H1、N01–N11 全部目标保持。

## 2026-10-22：持久期限仍失败，减少内部 hydration 重复解析

`ef1ee580` 的完整源码门禁与独立覆盖率分别在 Responses／chat 第 0 轮约 5009／5011ms 失败，业务跳过，原期限保持。内部 hydration 候选复用创建器的已规范化信封与同一个完整语义校验函数，外部 parser 的未知输入和摘要校验保持；四文件显式排除真实 worker 的合成回归 170/170。600 KB 原文的内存 SQLite 快照正反交替对照墙钟中位数约下降 23%，不等于实际磁盘或请求性能已修复。Job 阶段诊断与公开调用回归一并保留，完整托管复验待进行。证据及原 I0–I5/H1、N01–N11 边界见[实施状态](context-recovery-implementation-status.md)，安装机制已获资格不扩展为私有迁移、全天或生产完成。

## 2026-10-22：当前源码安装／升级／回滚／卸载通过

`ff05b521` 的隔离 Windows 安装 mechanics `39905400077` 已 success，两版源码 NSIS 构建、实际安装／升级／回滚／卸载与合成文件保留均通过。此资格绑定该源码和固定源码基线，不覆盖私有旧安装包、真实用户及加密数据迁移、签名、全天或生产。`ef1ee580` 的恢复验收和独立 Verify 继续运行，Job 公开 API 的扩大合成回归 38/38；完整 I0–I5/H1、N01–N11 原目标保留。证据与限制见[实施状态](context-recovery-implementation-status.md)。

## 2026-10-22：安装进入实际执行，Job 公开调用边界补强

`ff05b521` 的隔离安装 mechanics 已完成两版源码构建并进入安装／升级／回滚／卸载，终态待确认；便携 ZIP 已解包核对 536 份源码、关键二进制及实际构建应用，发行目录与摘要清单通过。原 Job 安全夹具改为公开 API 调用，并补固定枚举诊断，七文件 38/38；未执行本机产品或持久存储，新诊断增量尚未推送。`ef1ee580` 的恢复及独立 Verify 原句柄继续运行。证据边界见[实施状态](context-recovery-implementation-status.md)，原 I0–I5/H1、N01–N11、真实私有迁移、全天与生产目标不缩减。

## 2026-10-22：Job 调用进入内部后发现共享模块导出缺失

闭包修复后的 N08／N09 进入原 owned-job 内部，但在 bounded_child 阶段失败。新回归确认原有界 Job 函数未导出，候选仅增加其显式模块导出，原期限与隔离实现保持；六文件 35/35，真实托管复验待完成。`ff05b521` 的便携包构建退出 0，NSIS／ZIP 摘要清单通过，实际安装 mechanics 仍在独立 runner 构建基线。完整证据见[实施状态](context-recovery-implementation-status.md)，全部 I0–I5/H1、N01–N11、私有迁移、全天及生产目标保持未完成。

## 2026-10-22：当前 NSIS 与包内合成验证完成，业务和安装两路并行

闭包修复 `ff05b521` 的完整 source-gates 已通过，N08／N09 启动；当前源码的隔离 Windows 安装 mechanics 另路构建基线，不上传产物。标准 GUI／NSIS 本机构建退出 0，解包后 536 份源码与关键二进制摘要一致，发行目录检查通过；实际包内 Node／代理模块的两文件合成回归 70/70，无工作区代理模块回落，显式排除且阻断真实持久 worker。完整独立 Verify、业务生命周期、便携包、安装迁移及全天资格仍待结果；详见[实施状态](context-recovery-implementation-status.md)。I0–I5/H1、N01–N11 原目标保留，日常配置与生产未改。

## 2026-10-22：生命周期入口闭包修复候选，完整业务资格待验

`af56e4be` 的源码门禁已通过，但 N08／N09 的场景执行均失败，不能授予生命周期资格。两条纯模拟回归复现真实 execution 入口的 PowerShell 闭包无法解析局部加载 Job 函数，显式捕获已校验函数后均通过；候选不改变安全约束或期限，仍待托管完整复验。终态与边界见[实施状态](context-recovery-implementation-status.md)。原 I0–I5/H1、N01–N11、安装迁移、全天及生产目标继续未完成。

## 2026-10-22：当前源码双路门禁通过，业务生命周期验收开始

`af56e4be` 的独立 Verify 全部通过，包括代理、客户端和前端覆盖率；disposable 的完整 source-gates 也已通过，N08／N09 正在各自 runner 构建隔离载荷，业务结果待确认。IPv6 等价地址规则已真实回读确认；较早一轮的请求超时和存储收尾 EBUSY 仍保留，不以一次全绿宣布稳定。LIST 最大预扣 ACK 边界补充回归 70/70，提前执行 LIST 的隔离变异被拒绝，未改变产品扣款规则。证据与限制见[实施状态](context-recovery-implementation-status.md)。I0–I5/H1、N01–N11、当前包、私有迁移、全天容量及生产资格仍未完成。

## 2026-10-22：暖态发布前读取合并候选，原资格仍待完成

已将现有暖态原子准入扩展到发布准备，三协议 observed／prepared 回归确认少一笔独立读取，新原文仍只发送一次，原发布各阶段 ACK 保留。故障及挂起关闭边界回归通过，尚无候选托管性能或生命周期资格。诊断版本的独立 Verify 因原生 ACL 子进程 10 秒超时失败；另一路 disposable 仍按原句柄跟踪。两文件本机误触原生测试、显式排除与私有入口 guard 的完整边界见[实施状态](context-recovery-implementation-status.md)。I0–I5/H1、N01–N11 及当前包、私有迁移、全天能力和生产范围保持未完成。

## 2026-10-22：当前源码门禁通过，独立覆盖率仍失败

`d1aaf83e` 的 disposable source-gates 已通过，但 N08／N09 在网络隔离初始化阶段失败，尚未进入业务场景；已补固定子阶段诊断和全 mocked 回归，网络根因待托管定位。独立 Verify 的四个 unit 分片、集成、Rust、代码质量通过，但 coverage 因 chat 长持久请求在 5070ms 触发原 5 秒期限而失败。三协议 unit 均确认实际执行合并准入，不能据此关闭覆盖率性能问题或授予完整生命周期资格。两路运行及逐阶段私有证据见[实施状态](context-recovery-implementation-status.md)。I0–I5/H1、N01–N11、当前安装包、私有迁移、全天能力与生产原范围保持未完成。

## 2026-10-22：新候选已进入真实托管，完整资格尚未取得

`c7a7d1aa` 的独立 Verify 已通过源码质量、Rust、集成及三个 unit 分片，另一个分片因材料文件系统夹具的原 25 秒 PowerShell 期限失败；已补固定阶段诊断并本地 5/5，尚不宣称根因修复。普通 unit 的三协议 WBIPC 与 NSIS 模拟安装模块通过，273 条严格筛选的 worker 阶段记录已私有封存；尚不能从普通运行推导覆盖率性能。覆盖率及 disposable source-gates 仍在运行，完整 N09、全天容量、私有迁移与生产资格仍未取得，I0–I5/H1、N01–N11 原范围保持。详见[实施状态](context-recovery-implementation-status.md)。

## 2026-10-22：托管失败诊断候选已补，根因与运行资格仍待真实验证

WBIPC long-persistent 新增测试专用的事务／快照／锚点分段计时，原 5 秒请求期限、负载、断言与原 worker 协议保持。安装测试的临时复制可执行文件清理增加同一物理身份下的有限等待；持续占用仍失败，不把历史 EBUSY 认定为残留进程或 AV。三文件合成／复制 Node 回归 20/20，随后诊断文件 4/4 分开记录；尚无新真实 hosted 运行结果，不能授予性能、完整 N09、全天容量、私有迁移或生产资格。I0–I5/H1、N01–N11 原范围不缩减，详见[实施状态](context-recovery-implementation-status.md)。

## 2026-10-22：四场景保存／撤销确认消费已接线，真实托管验证待完成

N09 lifecycle client 已私下验证当前 PID bootstrap 并连接签名 mailbox；业务适配器接入 arm → 实际恢复请求 → 原生产者最终 ACK，以及原 revokeAsync 最终 ACK。确认后不再读快照／管理接口，先强杀再回收未完成 HTTP。托管入口保留 committed／clear，并增加独立 save／revoke 场景；原命令与外层期限不变。扩大合成回归 366/366，后续错误脱敏回归 18/18 分开记录，不替代真实 Windows 验收。完整 N09、全天容量、私有迁移及生产启用仍未完成，I0–I5/H1、N01–N11 原范围不缩减。详见[实施状态](context-recovery-implementation-status.md)。

## 2026-10-22：真实宿主启动接线的合成回归通过

N09 专用控制器已接入首次启动／同目录重启的签名 bootstrap，Job 分配后才写当前 PID 计划并放行；启动门核验全闭包后才安装实际 ACK／lifecycle exports 的观察器。扩大回归 351/351，另补边界按受影响文件复验，尚未获得新 hosted 资格。业务适配器的签名确认消费、确认后立即强杀、真实撤权与重开验收仍待完成。原 I0–I5/H1、N01–N11、性能／全天容量、私有迁移和生产启用范围不缩减，详见[实施状态](context-recovery-implementation-status.md)。

## 2026-10-22：安装 mechanics 托管通过，真实宿主确认通道仍在接线

`0a6934b1` 的托管 Windows 安装／升级／回滚／卸载与合成文件保留已通过（run `39883291573`），范围限 runner 源码重建安装器。新增 N09 签名私有文件通道与 lifecycle hook 的扩大回归 332/332，通过且零失败／取消／跳过；gate／controller／实际安装模块来源校验与 daemon adapter 仍未接通，不能授予完整 N09。该源码独立 Verify 与 disposable source-gates 均失败，分别存在 Responses 请求期限、Claude 发布确认期限及临时复制可执行文件清理 EBUSY，运行矩阵未获得资格。I0–I5/H1、N01–N11、私有旧安装包迁移、全天容量及生产启用原范围保留，详见[实施状态](context-recovery-implementation-status.md)。

## 2026-10-22：托管失败终态与安装验收修复

`1a745a7f` 的完整 Verify 和 N08/N09 source gates 均已失败终止，后者运行矩阵跳过，未取得新资格。安装验收已拆为旧无锚点库拒绝且字节保留、新锚点库连续性两条检查；合成九文件 63/63。客户端覆盖率新增与 unit 相同的物理临时目录准备，保留生产路径校验、并发、阈值与期限；实际 preload 子进程及 wrapper 等三文件 21/21，真实 hosted 复验待完成。I0–I5/H1、N01–N11、私有旧安装包迁移、全天容量及生产启用原范围保留，详见[实施状态](context-recovery-implementation-status.md)。

## 2026-10-22：正常事务拒绝后的 owner 生命周期修复

修复独立锚点接线造成的回归：stale CAS 和容量拒绝完成回滚后保留 owner，成功事务后的锚点落盘失败仍关闭且不返回回执。新增两条回归在旧代码上均失败，修复后相关四文件 80/80，Lint、格式与 CI 治理通过。当前专项使用合成保护器，不写本机注册表；旧提交托管 maintenance、四根十六 MiB 与 idle worker 失败仍待新提交完整复验。I0–I5/H1、N01–N11 原范围不缩减，安装迁移、全天容量与生产启用尚未完成。详见[实施状态](context-recovery-implementation-status.md)。

## 2026-10-22：容量功能验收与性能目标分开记录

用户已选择调整整套容量测试的执行预算，性能单独跟踪。统一 CI 中原五档、两 worker、原始负载、精确原文读取、重开、最终结果观察及安全断言保持，命令子进程执行资源预算改为 180000ms。原 60000ms 保留为独立性能目标，不再以该目标提前终止功能验收。CLI 用单调时钟测量 worker 启动、运行与退出的耗时，新增 `timing` 字段分别记录实际 `elapsedMs`、执行预算是否满足和性能目标是否满足。CLI 的 `scope: capacity-workers` 不包含进程启动、顶层加载及最终输出；统一 CI 父进程另记录 `scope: capacity-command` 的整个子进程耗时，后者才与原 60000ms 命令期限口径对应。不能用内部 worker 计时宣称原命令性能达标。

`qualified` 及退出码保持原功能容量语义：0 表示五档功能通过，1 表示容量拒绝，2 表示执行或报告错误；任何 `qualified: true` 均不表示性能、24 小时持久化、真实客户端或安装验收通过。直接运行 CLI 不主动终止超预算进程，但完整返回时仍明确报告 `executionBudgetMet: false`；统一 CI 调用方以 180000ms 硬截止拒绝超预算执行。历史 60000ms 超时日志与失败结论保留，不能因新预算撤销；新规则仍待候选投影与完整门禁验证，性能问题仍未解决。

## 2026-10-22：完整门禁终态与恢复候选整理

最近完整 `npm run verify` 已退出 1：四分片 672 个文件中 669 通过，剩余失败为容量、Gemini 启动和 Tianxi SDK handler；后续阶段未执行。健康探测的 Tianxi SDK 提前加载已修复并补回归，三个定向文件通过，Gemini 原 15 秒启动期限下的普通及独立覆盖率复验通过。Tianxi 全文件独立覆盖率诊断 106/106 通过，原 HTTP 5 秒不变；两者仍不替代修改后的完整四分片门禁。容量维持原五档、两 worker、负载和 60 秒，尚未通过。

远程临时 Windows 的基线安装、升级、回滚和卸载已真实通过，但仅覆盖原九文件验收提交，不覆盖当前恢复产品。当前恢复实现已按明确输入组装到独立工作树，排除图片服务修改并核对原生、插件及子进程入口；正在按锁文件重新初始化依赖。I5/H1、最终候选完整测试与重建、真实安装及加密迁移、成本资源和生产启用仍未完成。完整证据与边界见[实施状态](context-recovery-implementation-status.md)。

## 2026-10-22：启动认证与远程验收进入执行

已复现并修复同一启动事务的重复认证：5 条状态由 8 次变为各一次，仍完整认证后做容量准入、最后删除过期数据；新增 4/4、原 storage/service/blobs 118/118 通过。原四根/32 MiB 带覆盖率单项通过，第二次 open 8932ms ready。独立结果不关闭完整套件失败，历史 open 栈与推断边界见[实施状态](context-recovery-implementation-status.md)。

9 文件独立验收分支已推送，[真实 Windows 生命周期任务](https://github.com/cbhandsun/https-proxy/actions/runs/39761611237)已进入 baseline build，原 Verify 同步触发。该分支只验证已提交 HEAD 产品的安装机制，不包含主工作区未提交恢复增强；默认分支、签名门禁和日常安装未改。当前主工作区另以 1610 路径冻结并启动字面 verify，终态待记；当前已构建产物尚不包含新启动修复。I5/H1 与整体交付保持未完成。

## 2026-10-22：当前安装产物与替代验收环境

Tauri 资源遗漏 gateway scripts/锁文件已修复，修改前失败、修改后 7/7 回归通过。标准当前 GUI/NSIS 构建终态退出 0，实际 NSIS 解包的完整闭包和 625 份源码摘要通过；打包 EXE 除 Tauri 的精确 bundle marker 补丁外全部字节一致。当前便携目录也已实际组装、发行目录检查通过，未生成新 ZIP，未执行候选 GUI 或安装器。

没有本地隔离 Windows 环境时，使用独立 GitHub 托管 Windows 手动工作流完成安装→升级→回滚→卸载，保留签名发布门禁；详见[安装生命周期验收](windows-installer-lifecycle.md)。脚本本地安全/模拟验证与远程真实验收分开记录，当前远程尚未运行，真实用户迁移、加密恢复和 24 小时容量不在合成安装测试范围内。需先形成可审查源提交并满足手动工作流的分支可用条件。

原五档、两 worker 的非 profiler 容量单项仍触发原 60s ETIMEDOUT。I5/H1、完整门禁、安装迁移、成本资源和生产启用保持未完成；当前构建与证据边界见[实施状态](context-recovery-implementation-status.md)。

## 2026-10-22：并行阻塞收敛

存储 worker 请求重复归一化已去重，保留原安全和错误收尾契约；新增专项 4/4、完整 storage/service 65/65、原四根/32 MiB 覆盖率单项 1/1 通过。容量 CPU 采样原五档功能通过，但 92.66s 未满足原 60s 期限；无收益规范化候选已撤回，保留两项契约回归。便携包已统一复制 staging 完整闭包，补齐 gateway scripts/锁文件并校验全部源码与二进制指纹，最新专项 37/37 通过；标准 staging 刷新及 625 份源码三方摘要、真实闭包隔离复制均通过，尚非当前 GUI/完整便携 EXE 或 NSIS 安装资格。以上均为专项证据，不能关闭历史完整 verify 的 7 个失败文件。I5/H1、当前包完整验收、安装升级迁移回滚、费用资源和生产启用继续未完成；最新源码与证据范围见[实施状态](context-recovery-implementation-status.md)。

## 2026-10-22：测试失败收尾修复

树终止器失败时，原测试现在通过独立的专用夹具清理通道关闭其两个自建进程，避免整轮验证被遗留管道挂住。原 5s 期限、终止器实现和失败断言保留，兜底清理退出码 73 不能满足正常终止断言。新增失败、重复清理、生命周期与非法启动回归进入原统一单元入口；最终普通测试 10/10 通过，中间终止器失败日志保留且能够终态退出。此修复只改善验证可靠性，完整 verify、容量、安装与生产资格不因此关闭。详见实施状态顶部。

## 2026-10-22：当前工作区与历史冻结的边界

存储诊断结束后的补充封存发现 `scripts/run-frontend-tests.js` 改变，当前入口加入 `image-services` 测试。本轮未编辑该文件，保留修改。原 1507 路径中仅此路径漂移的核对不包含新增文件发现，不能称为当前工作区整体重新冻结。已有结果仍绑定各自运行时的冻结；下一次完整资格需重新建立当前源码边界，不能直接沿用旧冻结的结论。

## 2026-10-22：独立存储计时结果及证据边界

原四根/32 MiB 用例在覆盖率和 worker 回调计时下独立通过，测试约 134.3s、整命令约 188.2s；保存回调约 5.1–8.7s，加载约 3.4–4.5s。未改日志模式、期限、校验或负载。保存/加载回调合计约 43.8s，测试其他成本仍待细分，两个 close 没有 end 指标，不能推导关闭耗时。此次未复现完整套件超时，不足以关闭存储问题，完整 verify 仍为 663/670、退出 1。详见实施状态顶部及 `reader-single-parse-storage-timing-v1-outcome.json`；I5/H1、安装与生产资格保持未完成。

## 2026-10-22：当前完整门禁终态与下一诊断

当前单次解析冻结的完整 verify 已终态退出 1：663/670 个测试文件通过，7 个失败；格式、4043 文件语法、Lint 零错误、CI/发行治理及原生辅助程序测试通过。容量仍触发原 60s 期限，四根/32 MiB 加密 worker 测试出现存储超时，另有插件、路由、夹具和天玺路径失败。覆盖率百分比不替代通过，后续 verify 阶段未执行。自建夹具终止失败留下的两个进程经身份核对后手动清理，原失败保留，介入回执与终态结果一并封存。详见实施状态顶部及 `reader-single-parse-verify-terminal-v1.json`。

后续先做原四根/32 MiB 用例的操作级诊断，再依据耗时修改产品或修复测试收尾根因；不放宽期限、缩小容量画像或更换发现范围。I5/H1 均保持未完成，安装生命周期、费用资源和生产启用要求保持。

## 2026-10-22：读取单次解析与当前包复验

已消除读取引用的两次输入归一化，保留原准入限制交集、完整语义校验和变更版本 Proxy 防护；三个边界/安全回归进入既有统一 CI 文件并通过。最终覆盖率局部基准墙钟/CPU 中位数约下降 6.6%/7.9%，不构成完整容量或请求延迟资格。

当前 `reader-single-parse-source-freeze-v2.json` 下，625 份发布源码一致，包内 Node 的两个完整测试文件 87/87 通过；Codex/Claude 默认与增强四组原生合成任务各三次压缩通过，默认零恢复，增强精确读回与独立公开生成无私有工具泄漏。配置隔离、入口认证/路由注入及合成上游的限制保留，尚未完成 NSIS/便携包安装或生产资格。

完整 `test:client:coverage` 为 1351/1363 通过、6 失败、6 取消，退出 1；原期限、负载、worker、阈值与发现范围未变。当前统一 verify 单独记录，不能沿用旧冻结的 668/670。本轮新增真实请求 0，累计 169/177，剩 Codex 专项 1 次、Claude 专项 7 次；生产及日常配置未变。后续先定位当前失败，再完成当前源码统一门禁、安装生命周期、成本资源及授权空闲窗口的生产启用，整体未完成。

## 2026-10-21：完整子树编码对照与实际发行目标

函数子树编码候选的原五档、两 worker、覆盖率正反顺序四样本已完成。正向候选墙钟/CPU 均退化，反向候选较快，尚未排除环境与顺序影响；全部超过原 60000ms。458 项有限差分通过，候选仍不合入，产品与既有门禁状态保持。详见实施状态顶部及 `function-subtree-capacity-v1-receipt.json`；诊断 180000ms 包络不替代原期限。

安装交付使用当前实际配置：Tauri 目标为 NSIS 与 app，另有便携包脚本；没有配置 MSI 目标。安装、升级、迁移与回滚矩阵按 NSIS/portable 继续验收，历史 MSI 泛称不作为产物证据。未新增真实请求或修改日常配置、生产进程。

## 2026-10-21：最新增量与交付边界

设置页已明确新策略默认客户端原生压缩、精确恢复增强可选、内部恢复后独立公开生成增加调用和等待、留存偏好不独立授予读取权限，并为两个输入关联说明。静态回归已进入既有统一 CI 文件，前端测试 28/28、前端覆盖率入口 8/8、架构与构建通过；尚无实际安装 UI、键盘或屏幕阅读器验收。仅修改 HTML 与两个前端测试，代理行为和日常配置未变。

批量描述符与两个 fast-null 诊断候选无收益，全部拒绝合入。完整门禁仍以此前 668/670 的失败终态为准，容量 60000ms、WBIPC 5000ms 阻塞未解决；不能用局部通过替代。累计真实请求保持 169/177，Codex 专项剩 1 次、Claude 专项剩 7 次，不混用。生产 PID 64716 及启动时间复核不变。完整证据与其限制见实施状态文档顶部及 `recovery-settings-v1-receipt.json`；后文按时间保留的旧额度和运行中状态不是当前结论。

## 2026-10-21：保留历史请求的 Unicode 扫描优化，存储延迟仍阻塞交付

CPU 采样发现 JSON 字节核算中的 Unicode 分类扫描热点。当前仅优化 context-recovery-history-request.js：保留 ASCII 路径，宽字符文本使用码元范围扫描与既有无损 UTF-8 校验；C0 控制字符、引号、反斜杠和孤立代理仍交给原生 JSON 编码。C1 字符及配对代理无需生成整段 JSON 副本。未改变节点、深度、逐项/总字节、冻结、预算、TTL 或授权边界。状态编码器候选在带转义 ASCII 对照中表现退化，已撤回，context-recovery-state-data.js 与本轮备份 SHA256 相同；不把候选收益套用到保留实现。

新增 C1 无副本回归在修改前失败；全 UTF-16、补充平面及旧运行时回退检查进入既有统一 CI 文件。候选 v1 期间定向 30/30，包括四根 32MiB 加密重开 101915.8671ms；这是此前候选的定向证据，不能替代当前完整门禁。当前保留版本的前后 normalizer 对照见 json-scan-normalizer-benchmark-v2-result.json：Unicode 样本有 CPU 收益，ASCII 墙钟仍有波动，不作整条请求时延保证。

当前源码完整 test:client:coverage 已退出 1：1335 项，1329 通过、3 失败、3 取消、0 跳过，主体 319355.0382ms。失败为 Chat/Responses Core 持久化请求原 5000ms 截止时间、原五档两 worker 容量资格 60000ms；取消为加密 staging 重开 30000ms、授权恢复重开 30000ms、四根 32MiB 重开 180000ms。覆盖率语句/行 99.06%、分支 95.22%、函数 99.29%；history-request 语句/函数 100%、分支 98.16%，state-data 与 UTF-8 helper 语句/分支/函数 100%。32 文件源码冻结复核无差异。定向 Lint、语法、格式、CI 及发布治理通过，完整门禁仍未通过。

进一步的隔离 worker 计时确认一次操作 3561ms、线程 CPU 62ms、已记录文件检查约 22ms；下一次捕获 scan-reference 的 SQLite COMMIT 2911ms、线程 CPU 0ms。后一次 DELETE 诊断虽然通过，也不能撤销历史超时。仅在诊断进程比较 TRUNCATE，保留 synchronous=FULL 与 secure_delete=ON，仍在重开第二轮 5015ms 超时，因此未修改产品日志模式；运行源码仍使用 DELETE。现有证据说明存储线程内部阻塞是延迟来源之一，未证明所有超时有同一根因，也未排除系统调度或其他文件系统等待。

证据均位于 .hpm-acceptance/context-plugin-vault-20261021-01/：json-scan-regression-before.log、json-scan-regression-after.log、json-scan-normalizer-benchmark-v1-result.json、json-scan-normalizer-benchmark-v2-result.json、json-scan-client-full.log、json-scan-source-freeze.json、storage-operation-worker-timing.jsonl、storage-operation-worker-sqlite-timing-v2.jsonl、storage-operation-worker-sqlite-TRUNCATE-timing-v3.jsonl 及对应 Core 日志。诊断只记录固定操作名、计数、耗时及 CPU，无请求参数、原文或凭据；辅助脚本未进入生产路径。真实请求仍 137/144，本轮新增 0；未安装插件、改日常配置或重启生产。容量、持久化期限、完整客户端/插件与全仓门禁仍待完成，整体 active。


## 2026-10-21：实际 Core 大原文窗口回归与加密重开未通过

实际 Core 的 WBIPC 测试新增 long-json、long-sse、long-failed：约 600KB 原始工具结果超过现有 384KiB/96Ki token 窗口，私有阶段使用可信留存引用，公开阶段使用中性占位及独立验证的 READ 证据；失败后仍能重新读取原始内容。该版本 Core 文件 30/30 通过，证据为 `.hpm-acceptance/context-plugin-vault-20261021-01/wbipc-core-window-regression.log`。使用 FakeWbipcSocket，不代表真实 WBIPC 端点。

随后新增 long-persistent，使用真实 Windows 加密存储 worker，关闭后物理重开，检查原文不出现在 SQLite 文件、来源与绝对到期时间不变、预算继续扣减及公开发布确认。当前测试仍未通过：完整文件 28/30，Responses 重开后第二轮和 Claude 第一轮超过原 5000ms；Chat 本轮通过。后续诊断还观察到普通内存模式超时，不能据此把根因归结为加密存储。最新单独 Responses 诊断在持久化第一轮完成私有读取及发布阶段，但仍超时；READ 和存储操作计时仅用于定位，未证明故障根因或修复。

新增测试保留在既有统一 CI 入口 `test/client-context-target.test.js`，原负载、5000ms 请求截止时间、预算及门禁均未放宽。阶段诊断仅记录固定测试模式、操作名、计数和耗时，不记录原文或凭据。证据：同目录 `wbipc-core-persistent-regression-v3.log`、`wbipc-core-persistent-timing-v1.log`、`wbipc-core-persistent-timing-v2.log`、`wbipc-core-persistent-timing-v3.log`。定向 ESLint 通过；新增测试后的完整覆盖率门禁尚未重跑，前次完整门禁失败保持有效。

最终当前源码复跑为 27/30，三个协议的 long-persistent 第一轮均超过原 5000ms（总耗时 125244.0704ms），0 取消、0 跳过；日志为同目录 `wbipc-core-persistent-final.log`。其中 Responses 的 settle-reader 单次 3276ms，Claude 的 load-reference 单次 1801ms，Chat 的 save-reference-state 单次 1236ms；这些是耗时观测，不能单独证明因果。此前 Chat 通过保留为历史结果，不能作为当前通过。

真实请求新增 0，累计 137/144；此前 Claude v25 的全真实验收仍仅覆盖 owner HTTP 入口，不扩大到当前 Core、已安装插件或生产。容量、加密重开期限、真实 WBIPC、插件迁移及全仓门禁仍阻塞整体交付。未修改日常配置、安装插件、重启或激活生产；整体保持 active。


## 2026-10-21：WBIPC 双预算实现最终验证，完整门禁保持失败

冻结 31 文件运行 npm run test:client:coverage，终态 exit 1：1333 项，1328 通过、2 失败、3 取消、0 跳过，344657.0418ms。覆盖率行/语句 99.06%、分支 95.20%、函数 99.29%；三个 WBIPC 模块均行/语句/函数 100%，新窗口模块分支 97.61%。定向 97/97、Lint/格式、CI 与发布清单通过；新增测试已处于原统一客户端入口。失败为 direct-upload fixture 启动期限及原五档两 worker 容量 60000ms 超时；三项取消为 staging 清理重开 30000ms、当前授权/读取预算重开 30000ms、四根 32MiB 私有历史重开 180000ms。上次四根提前失败与本轮明确超时均保留，尚未定位共同根因；覆盖率达标不改变失败结论。全部 31 文件 SHA256 在门禁结束后复核一致。

当前源码的 Codex 原生经实际 Core 合成复验通过。Claude 同期 v4 在原 20 秒启动期限内未发出请求并失败；在完整测试进程结束后，v5 单独复验以相同期限通过三次原生压缩、精确 READ/公开证据/最终答案、无私有事件泄漏及进程终结，失败记录保留，不能据此声称并发启动问题已修复。本轮真实调用新增 0，累计仍 137/144。

WBIPC 双预算本地代码已实现：保留完整宿主原文，仅投影已证明留存的历史结果，继续使用现有最终发布事务；2.4MB 多轮会话、私有/公开隔离、非法 UTF-8、引用篡改、独立预算、撤权与发布前取消后的原文重读均有回归。仍需补实际 Core 的大窗口发布/加密重开组合及真实 WBIPC 端点验收，不以 FakeWbipcSocket 证据代替真实传输。容量/启动/重开稳定性、完整插件/Hooks 与迁移/真实旧读取器、24h 到期实测、全仓门禁及最终空闲生产启用继续待完成；生产与日常配置未更改，整体 active。

证据：.hpm-acceptance/context-plugin-vault-20261021-01/wbipc-window-outcome.json、wbipc-window-runtime-source-freeze.json、wbipc-window-final-module-coverage.json、wbipc-window-client-full.log、claude-native-recovery-core-synthetic-wbipc-v5-result.json 与上节列出的回归/失败日志。

## 2026-10-21：WBIPC 长历史增加原文证明和双预算传输投影（完整门禁运行中）

新增 context-recovery-wbipc-window：保留宿主完整规范历史，仅在 format3 的 WBIPC 传输副本超限时，按当前会话 captured/visible 集合中的 callId、SHA256、精确 UTF-8 字节数和绝对到期证明，替换已留存的历史工具结果。私有阶段使用来源引用；独立公开阶段使用无私有目录标识的固定占位说明，并继续附带成功 READ 的已验证证据。用户消息、工具调用、工具定义和私有 READ 回执不截断；没有确切留存证明、非法 UTF-8 或替换后仍超任一预算时拒绝，不连接 IPC、不执行外部工具。引用查询不消耗或重置读取预算，不创建新保存事务；继续复用已有最终响应 prepare/sending/finished 与撤回边界。

WBIPC 入口与协议转换采用 owner 的 historyFormat，format3 允许原 32MiB 历史边界，单项和单次结果批次仍为原 2MiB；传输仍受原 384KiB 和 96Ki Token 两项上限控制，未提高任何上限。旧 format2、凭据/endpoint 绑定、工具历史配对和认证撤销规则保留。新模块进入发布清单，新增回归位于原统一 test:client 测试文件。

四文件定向 97/97 通过（21481.1165ms），包含已有实际 Core 集成、新 2.4MB 多轮会话的投影、精确 READ 和发布前取消后再次读原文。新窗口模块定向覆盖率语句/函数 100%、分支 93.75%（新增 UTF-8/非法边界回归之前的采集）；最终标准 test:client:coverage 正在运行。当前源码的 Codex 原生经过实际 Core 合成复验通过；Claude 同期在原 20 秒 native_deadline 内未发出模型请求，待完整门禁终态后单独复验，失败记录保留。不冒充真实 WBIPC 端点或已安装插件验收。

证据：.hpm-acceptance/context-plugin-vault-20261021-01/wbipc-window-runtime-source-freeze.json（31 文件）、wbipc-window-core-regression.log、wbipc-window-owner-regression-final.log、wbipc-window-coverage.log、wbipc-window-lint-frozen.log、wbipc-window-format-frozen.log、wbipc-window-ci.log、wbipc-window-release.log、wbipc-window-client-full.log、codex-native-core-synthetic-wbipc-v2-result.json、claude-native-recovery-core-synthetic-wbipc-v4-result.json。本轮真实请求新增 0，累计 137/144；生产 PID 未重启，日常配置未改，整体 active。

## 2026-10-21：两端原生客户端经过实际 Core 的合成验收通过

新增端到端证据：原生 Claude 与 Codex 客户端经 createCoreRequestHandler 进入默认恢复路径，使用测试注入的认证、临时路由和本地合成上游。两端均完成三次原生压缩，原始外部工具只执行一次，私有 READ 后逐字节证据进入独立公开生成，最终答案精确，私有工具事件未泄漏，客户端进程结束。Claude 消耗 18 次本地合成响应，Codex 13 次，真实模型新增 0。此证据覆盖原生客户端到实际 Core 的默认恢复调用链；不覆盖完整 openai-proxy composition、安装插件/Hooks、真实上游或生产部署。历史两端真实验收仍保持其原 owner HTTP 入口和源码范围。

证据：.hpm-acceptance/context-plugin-vault-20261021-01/claude-native-recovery-core-synthetic-v3-result.json 和 codex-native-core-synthetic-v1-result.json。复核原 25 文件 diagnostic-source-freeze 的源码 SHA256 均一致，未通过变更恢复逻辑取得本轮通过。夹具早期路径/缺失依赖失败日志保留，最终两端均 exit 0。容量 60000ms 稳定性及完整客户端失败门禁仍未解决；插件安装/迁移与真实旧读取器、WBIPC 长历史双预算、24h 到期实测、全仓门禁和最终生产启用仍待完成。真实预算仍 137/144，生产与日常配置未更改，整体 active。

## 2026-10-21：撤回纯文本指纹候选，容量门禁保持未通过

纯文本消息的 canonical SHA256 快路径通过 40 项等价性回归和定向 Lint，但原五档、两 worker、c8 覆盖率下的完整耗时对照为基线 58989.9289ms、候选 99477.4894ms，候选不具备可保留的稳定收益。候选在原 60000ms 资格用例中仍超时，已恢复源码和本轮候选测试；原 25 文件 diagnostic-source-freeze 的 SHA256 全部一致，恢复后绑定回归 39/39。诊断脚本的 qualified 字段只表示五档数据完整，未包含原资格命令的 60 秒期限，因此不得解释为标准门禁通过。历史完整客户端失败结果保持有效。

证据位于 .hpm-acceptance/context-plugin-vault-20261021-01/：scalar-canonical-outcome.json、capacity-scalar-canonical-baseline-result.json、capacity-scalar-canonical-candidate-result.json、scalar-canonical-restored-regression.log。后续实际 Core 与两端原生客户端的合成链路已通过，见上节；未安装插件，未更改生产或日常配置，本轮真实请求新增 0，累计 137/144，整体 active。
## 2026-10-21：原文 UTF-8 校验去除重复整段复制，完整门禁仍未通过

新增共享 isWellFormedEvidenceText：在原生 String.prototype.isWellFormed 可用时直接校验 UTF-16 是否能无损往返 UTF-8；旧运行时保留原 Buffer 往返校验。原文形状门禁和摘要校验均使用它，避免为相同校验分配整段 Buffer/字符串副本。原输出字节上限、JSON 转义预算、SHA256、逐回执校验、读取偏移、缓存上限、所有期限与负载不变。

账本回归 31/31：逐一比较全部 65536 个 UTF-16 单元，分块覆盖全部补充平面码点，同时验证原生与强制旧运行时回退等价；原生路径形状检查不分配原文 Buffer，摘要检查只创建所需的摘要/读取边界 Buffer，缓存命中仍拒绝错误摘要与非法 UTF-8 偏移。加密存储/根状态/收养三文件 72/72，包括四个根、32 MiB 私有历史的真实加密重开，整组 92395.2424ms。定向 Lint、CI 与发布清单通过，新模块已声明。

当前源码的标准 npm run test:client:coverage（含原生工具和网关标准重建）终态为 1325 项、1323 通过、2 失败、0 取消/跳过，144479.1159ms，exit 1。全门禁覆盖率语句/行 99.06%、分支 95.18%、函数 99.29%；本次 UTF-8 helper 与两个关联模块均达到语句/函数/分支 100%。失败为原 60000ms 容量资格超时，以及四根 32MiB fixture 在 38482ms 内恢复轮次提前失败（并非触及 180000ms 期限），具体错误码尚待诊断。已补只含 index/suffix/安全 code 的断言信息，原轮次、负载、并发与期限均未变；三文件诊断已 92/92 通过（95927.5439ms），其中原五档、两 worker 容量资格 51745.5068ms，通过原 60000ms 期限。该结果不替代全并发门禁，也未证明此前失败根因已消除。带安全断言的第二轮完整标准客户端门禁终态为 1325 项、1324 通过、1 失败、0 取消/跳过，218607.3158ms，exit 1；仅原 60000ms 容量资格超时。覆盖率语句/行 99.06%、分支 95.19%、函数 99.29%。四根 32MiB 此轮通过，但首轮提前失败未定位到根因，不能据重跑通过声称已修复。日志 evidence-native-unicode-client-diagnostic-full.log，第一轮失败记录保留。额外隔离诊断：在 c8 下只运行原容量资格用例也于原 60000ms 超时（测试总计 60557.5647ms），不能只归因于文件并发；未关闭覆盖率采集，也未放宽任何门禁。日志 capacity-coverage-isolation.log。完整失败保持失败，独立 103 项通过不替代门禁。日志 evidence-native-unicode-client-full.log。当前源码的 Codex synthetic-unicode-v42 与 Claude synthetic-unicode-v27 原生零模型回归均通过三次压缩、精确最终答案、无私有事件泄漏和进程终结；scope 仍是原生客户端加恢复 owner HTTP 入口，不是完整安装插件或生产路径。新源码尚未做真实模型重验，历史 Codex/Claude 真实通过保留原证据范围。生产与日常配置不变，本轮真实请求新增 0，累计仍 137/144。容量 60000ms、全仓门禁、完整插件/Hooks 接入、WBIPC 长历史、迁移/真实旧读取器、24h 到期和最终生产启用仍待完成。整体 active。

证据目录 .hpm-acceptance/context-plugin-vault-20261021-01/：evidence-native-unicode-regression.log、evidence-native-unicode-root-regression.log、evidence-native-unicode-lint.log、evidence-native-unicode-ci.log、evidence-native-unicode-release.log、evidence-native-unicode-runtime-source-freeze.json、evidence-native-unicode-outcome.json。

## 2026-10-21：阶段计时完成，第二项缓存候选撤回

原五档/两 worker 的最大负载阶段计时（含嵌套，不能相加）：入站历史规范化 19781ms、frontier.calculate 30653ms、完整根导出 8849ms、重开恢复 16715ms。仅保留固定阶段名、次数与耗时，不记录原文或请求参数。

第二项候选用请求内 UTF-16LE 摘要加速大文本缓存比较，保留持久化规范链、每次入站校验与缓存上限；独立 60000ms 门禁仍超时。紧邻的完整原负载对照为旧实现 92529.2461ms、候选 90796.9834ms，两者功能断言全过，差距约 1.87%，不足以证明稳定收益，已撤回新模块、接线、运行清单及实验测试。23 文件与前轮冻结清单再次逐一匹配，未保留新的缓存格式。下一步优先查完整状态导出/重开中的重复处理，不放松任何校验。

证据：.hpm-acceptance/context-plugin-vault-20261021-01/capacity-stage-timing-thread-*.json、capacity-stage-timing-result.json、capacity-item-fingerprint-*-diagnostic-result.json、capacity-stage-and-rejected-fingerprint-outcome.json。本轮新增真实模型请求 0，预算仍 137/144，生产和日常配置不变。整体 active。

## 2026-10-21：容量热点采样与文本复用实验撤回，性能门禁仍失败

对原五档、两 worker 容量负载完成 CPU 采样：五档功能断言全部满足，带分析器总耗时约 134.7 秒；该结果不能替代原 60000ms 门禁。热点集中在历史克隆、规范编码、指纹 SHA 与 GC。请求内文本复用实验的定向比较虽较快，完整负载对照为原实现 120416.86ms、实验 126789.8618ms，两者功能断言均通过而性能门禁均失败，因此撤回源码与实验专用测试，原源码 SHA256 和上一轮 21 文件冻结清单全部复核一致。

实验阶段绑定/私有容量/会话回归 90/90、定向 Lint 和 CI 清单通过，仅是被撤回候选的证据，不冒充最终性能验收。本轮无新增真实模型请求，累计仍 137/144；未修改任何期限、负载、worker 上限、日常配置或生产。证据：.hpm-acceptance/context-plugin-vault-20261021-01/capacity-profile-and-rejected-intern-outcome.json、capacity-intern-*-diagnostic-result.json、CPU.20261021.080819.*.cpuprofile。整体 active。


## 2026-10-21：默认隔离入口与 Claude 完整真实复验通过，整体未完成

Core 集成补充：30/30 全部通过，含 JSON/SSE、多协议转换、三次规范压缩、WBIPC 与撤权。发现 Gemini 对含先前工具历史的相邻用户消息合并会破坏公开证据边界；修复恢复路径保持原消息边界，补回归。Gemini 转换与直接 Chat 测试通过；默认入口 Codex 原生合成 v41 三次压缩通过，零真实调用。标准完整客户端首次复跑为 1322 项、1299 通过、21 失败、2 取消（306757ms）；该次混有尚未更新的旧三轮 Core 测试。Core 修复后最终完整门禁为 1323 项、1315 通过、3 失败、5 取消、0 跳过，315001.7422ms，exit 1。失败为容量资格、独立 ACL 校验和旧 DPAPI 互操作；取消涉及加密 worker 重开、加载、撤权、4 根 32MiB 历史及网关启动。覆盖率行/语句 99.06%、分支 95.18%、函数 99.28%，不因覆盖率达标改判通过。当前源码封存为 default-isolated-security-final-source-freeze.json，旧封存保留为历史。

HTTP 与 WebSocket 默认恢复入口已改为内部恢复后独立公开生成。普通 HTTP 响应只有在实际传输完成后才获得公开来源标记；普通 WebSocket 响应先准备，完成发布确认后才允许续接。旧未知来源响应、未完成公开发布均不具备公开祖先权限。无法证明公开祖先时，清理成功后返回安全的 previous_response_not_found，客户端可自行携完整公开上下文重发；代理不会自动重试。

WebSocket 增量投影加入工具目录一致性条件，避免公开阶段继承私有响应 ID。回归覆盖原生形态工具、长历史、连续三轮外部结果、分片、断线重连、客户端完整窗口重发、撤权、发布失败与加密 SQLite 关闭重开。私有阶段若返回未广告的外部工具调用，拒绝并隐藏；所有外部调用均来自独立公开阶段。相关五文件 210/210，协议转换等八文件 107/107；定向 Lint/格式通过。入口/WS 三模块覆盖率语句/行 95.89%、分支 91.08%、函数 96.15%。这些是合成上游和本地传输证据。

Claude v25 使用真实原生客户端、新建隔离任务、真实模型贯穿 seed、三次压缩、两次中间续接和最终恢复；默认 HTTP 入口直接接管，无 isolated 选项包装。17 次真实请求、3 次原生压缩、原始 MCP 工具仅执行 1 次，精确私有读回、公开证据投影及最终答案全部通过，未检测到私有工具事件泄漏，客户端进程已终结。它验证恢复 owner HTTP 入口，仍不是完整 Core/插件安装或生产验收。Codex v38 的全真实通过属于先前源码，不能冒充当前源码重验。

新授权仅用于 Claude 完整复验及诊断，累计预算 137/144，剩余 7 次；没有自动重试或修改日常配置。生产未重启、未启用本次改动、未安装插件。标准完整客户端门禁仍未通过，容量/worker/ACL/DPAPI/启动问题保持待解决。容量资格单独诊断仍在原 60000ms 超时（测试总计 61202.6754ms）；未改期限、负载或两 worker 上限。依赖升级后 Windows 密钥组单独诊断 24/24 通过，原生/旧 DPAPI 双向兼容通过；不能以单组通过替代原并发门禁或认定根因已修复。WBIPC 长历史、完整 Core/插件/Hooks 多端接入、迁移与真实旧读取器、24 小时到期及最终生产启用仍未交付，整体保持 active。

安全依赖分两批升级：@modelcontextprotocol/sdk ^1.32.1、Vite ^6.4.5。按标准流程重建网关完整性产物；升级后网关/发布回归 32/32、前端构建通过，npm audit 各严重度均为 0。完整客户端门禁发生在依赖升级前，未冒充升级后全量结果。升级后 Claude 默认入口原生合成 v26 三次压缩通过，零真实请求；精确答案、无私有事件泄漏及进程终结均通过。

证据位于 .hpm-acceptance/context-plugin-vault-20261021-01/：default-isolated-source-freeze.json、default-isolated-entry-verified.log、default-isolated-protocols.log、default-isolated-coverage.log、default-isolated-lint-final.log、default-isolated-format-final.log、claude-native-recovery-isolated-complete-v25-result.json、real-model-budget.json。

## 2026-10-21：独立公开响应来源与持久化续接边界

已补宿主来源证明：Responses 的 previous_response_id 只有在当前 principal/target/policy 绑定到唯一父快照，父响应确由独立公开生成产生且完成发布后，才可进入公开请求。私有响应 ID、旧单缓冲流程的未知来源 ID、未完成发布与歧义祖先继续拒绝。私有读取仍沿原私有状态机进行；公开请求仅延续宿主证明过的公开响应 ID，绝不取私有阶段的 response ID，因此不需要另存完整用户历史。

持久化采用显式 publicGenerationFormat=1 和每个快照的 publicResponse 布尔值；标记保存在原加密状态中，旧无标记状态默认不具备公开祖先权限。封存器/元数据层严格校验标记类型、协议与快照关联；既有快照的来源属性在引用状态更新中不可提升或降级。旧读取器的精确字段契约会拒绝新增格式，但真实旧版二进制仍待验收。没有增加原文容量、读预算、快照上限或延长绝对到期时间。

测试已证明：完成发布后跨状态重开可续接；刚发生的私有 READ、草稿、私有响应 ID 均不进入公开请求；来源标记篡改、缺失、未知格式、未完成发布与旧状态均按边界拒绝；实际 Windows 加密 worker 关闭/重开后仍可使用公开祖先，原到期时间相同。扩展回归 153/153、持久化/绑定组 144/144、最新定向 46/46；隔离模块覆盖率行/语句 98.15%、分支 94.54%、函数 100%。定向 Lint/格式、CI 与发布清单检查通过。两端新原生合成模型验收均完成三次压缩、精确恢复、单根与无私有工具泄漏，零真实请求；不是完整 Core/插件或真实模型验收。

性能字符扫描实验未保留：替代实现未呈现稳定收益，原五档/两 worker 容量实测 60121.7393ms，超过原 60000ms 并超时。恢复了历史计量源码的原始 SHA256，保留新增穷举回归，覆盖全部 UTF-16 单元和补充平面码点与 JSON 精确字节等价。不宣称容量或性能合格。

目前来源证明仅由 isolated 宿主选项使用，默认 HTTP/WS 尚未切换；仍需验证实际发布时序、缓存失效、完整传输/插件与兼容迁移。上一轮 Codex v38 全真实通过属于上一轮源码，不冒充本轮新字段的真实复验。真实请求预算仍 120/120，本轮新增 0；追加授权待用户回复，不能继续真实调用。完整客户端与全仓门禁尚未在这批最终源码上重跑；上一轮失败记录仍有效，整体 active，生产与日常配置不变。

证据：public-lineage-final-source-freeze.json（补充祖先注释后重封存）、public-lineage-source-freeze.json、public-lineage-outcome.json、public-lineage-*-final.log、public-lineage-coverage.log、两端 synthetic-v24/v40-result.json、history-character-*-benchmark-result.json 与 capacity-character-set-deadline-result.json，位于 .hpm-acceptance/context-plugin-vault-20261021-01/。

## 2026-10-21：私有恢复与独立公开生成（未完成整体交付）

最终冻结源码复核 SHA256 一致；最新扩展回归 274/274、定向 42/42，两端新合成原生三次压缩均通过；新模块覆盖率行/语句 98.07%、分支 93.82%、函数 100%。标准完整客户端最终终态：1314 项，1302 通过、3 失败、9 取消、0 跳过，373312.0762ms，exit 1。整体交付未完成。

全仓语法检查通过（3871 个 JavaScript 文件）；全仓 Lint 失败（7697 errors、669 warnings），本轮修改文件定向 Lint/格式及 CI/发布清单检查通过。最终完整客户端覆盖率行/语句 99.01%、分支 95.13%、函数 99.13%；失败门禁不因覆盖率达标改判。全仓 verify/build/security 全链路未完成。

用户已选择严格隔离：先内部完成恢复，再以独立公开请求生成最终输出。新增独立协调器与证据投影模块；公开侧仅收到原始可见请求、原外部工具和经宿主成功 READ 校验的证据页。目录回执、私有工具定义/调用 ID、错误、中间草稿和 thinking 不跨该边界。校验包括来源 ID、完整摘要、分页范围/总字节、UTF-8 和分块 SHA256；保留 8 轮、64 次读取、512 KiB 上限，私有最多 7 轮，为公开生成预留一轮。无可读证据时直接公开生成，避免无效私有发现。

目前仅新增宿主选项 publicGeneration=isolated，原生探针显式启用。默认 HTTP/WS 尚未切换，带 provider previous_response_id 且缺少完整公开祖先时明确拒绝，尚需设计可验证的公开历史重建；不能称为默认无感集成或完整 Core/Hook 验收。

新隔离 Codex v38 全程真实模型验收通过（13 次请求）：真实原文捕获一次、三次原生压缩、后续私有请求读回精确原文、独立公开请求含精确授权证据、最终值精确匹配、单根、无私有工具事件泄漏。Claude v16/v18 全流程真实验收失败；v19 的安全结构诊断定位到公开摘要含两个 summary 开标签、一个闭标签，严格封存器正确拒绝 context_recovery_summary_invalid。没有放松封存规则；仅对已识别的原生摘要公开请求增加唯一 summary 块的系统格式要求，并关闭该请求的 thinking。v20 修复后单次真实公开摘要与原生压缩通过（种子/私有阶段合成），v21 最终真实公开生成答案严格匹配（种子/三次压缩/私有阶段合成）；二者不能合并冒充 Claude 全流程真实通过。

累计真实模型预算已获批至 120 次，现 120/120；无自动上游重试、无日常配置改动、无生产重启/激活。完整标准客户端中间门禁为 1312 项、1297 通过、14 失败、1 取消、0 跳过，306295.54ms；覆盖率行/语句 99.06%、分支 95.17%、函数 99.28%。运行期间有源码后续修正，故该轮仅诊断，不是最终冻结源码门禁。失败包括加密 worker/ACL/DPAPI 启动与重开、冷导入期限及容量资格，均保留失败记录，没有提高期限或跳过测试。

容量原负载诊断 85118ms 仍超过原 60000ms；热点包括历史 clone/编码、规范化、SHA、GC，尚不能认定性能合格。24h 原样本绝对到期仍为 2026-10-22T00:55:55.109Z，尚未实际到期验收，不重播种或延长。整体 active；仍需 Claude 修复后全真实复验、默认 HTTP/WS 与完整 Core/插件/Hook、WBIPC format3 长历史事务与传输、旧插件迁移/真实旧读取器和回滚、全仓门禁、到期观察及最终空闲激活。

本轮证据目录：.hpm-acceptance/context-plugin-vault-20261021-01/。保留所有失败与成功报告；真实预算 real-model-budget.json，Codex codex-http-recovery-isolated-complete-v38-result.json，Claude claude-native-summary-stage-v19-result.json、claude-native-isolated-summary-format-v20-result.json、claude-native-isolated-final-format-v21-result.json。最终本地回归和源码摘要见 isolated-generation-outcome.json、isolated-generation-source-freeze.json。

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


## 最新局部改进：历史数组构造与安全回归通过，容量资格仍超时（2026-10-21 UTC；整体未交付）

本轮仅将 normalizeRecoveryHistoryRequest 外层历史数组从逐项 Object.defineProperty 改为 Array.from 的原生 own-data-slot 构造。计数载体为 null prototype，不读取继承迭代器；原数组槽位仍逐项取 descriptor，全部输入、单项和总字节、节点、深度、原型及不可变校验保留。没有跨请求原文缓存。新增继承迭代器、空历史、晚项 getter、失败后修复重试与旧结果不可变回归；已有数字 setter 安全回归继续通过。测试文件已在统一客户端 CI 入口。

局部交替基准 16 轮、每轮 8 次标准 480 轮/1440 条历史归一化，中位数 45.60→37.58ms，约 17.6% 改善；只证明本机该函数成本下降。批量 descriptor 候选 48.93→69.94ms、嵌套数组候选 79.09→83.88ms 均更慢，未应用。各基准负载及主机状态不同，不横向比较绝对值。

绑定测试 35/35，扩展 binding/sessions/root-state/loading 覆盖率测试 162/162、无失败或取消，耗时 200247.2772ms；修改模块语句/行 100%、函数 100%、分支 97.97%。实际四根满额 32MiB 私有历史加密重开在专项中通过（145893.6084ms），不能替代完整并发验收。相关格式、Lint、CI 入口、发布清单检查通过。

之后运行原 context-recovery-capacity-workload.test.js：9/10，通过不了资格子命令原 60000ms 期限（ETIMEDOUT），总 65719.9231ms。保留五档负载、两 worker、原超时和全部断言。未为这次局部改进重跑已知失败的完整客户端门禁；上一源码快照的 1226/1231 及五项未通过仍保留在下一节，不能当成本次源码完整验收。下一步仍需降低容量整体成本并解决启动和存储全量并发稳定性。

证据：.hpm-acceptance/context-history-descriptor-batch-20261021-01/，包含 comparison-final.json、covered.log、capacity.log、outcome.json、原始源码备份与未采用候选。生产未启用、未修改安装配置、未发真实模型请求；WBIPC 双预算、多端实际客户端、安装迁移回滚和真实 24h 到期验收仍未完成。三份历史文档尾部逐字节保留。


## 最新完整门禁：1226/1231，启动依赖拆分未解决全量并发超时（2026-10-21 UTC；整体未交付）

本轮将 Responses 目标判定和上下文溢出响应拆成轻量模块；转换与规划依赖在已验证的请求分支加载。核心路由、鉴权和配置仍在就绪前加载，旧导出兼容。新增冷加载依赖拒绝、首个匹配请求验证、缺失模块传播与溢出边界回归，并将两模块纳入统一客户端覆盖率入口和发布清单。实际 core 冷加载项目模块 133→108；单次耗时受主机负载影响，没有证明启动延迟改善。

最终定向覆盖率测试 60/60 通过，语句/行 90.64%、分支 89.44%、函数 91.83%。之后按原命令运行完整 test:client:coverage，退出 1：1231 项、1226 通过、3 失败、2 取消，耗时 320369.0051ms。完整覆盖率语句/行 99.04%、分支 95%、函数 99.17%，原阈值通过；完整测试门禁仍失败。未改变并发、两 worker、五档容量负载、15 秒启动、60 秒容量或原存储期限。

同五项未通过：Chat/Responses/Claude JSON/SSE 实际隔离代理启动、direct-upload 隔离代理启动、容量资格命令、孤立 staging 清理和多次加密存储重开、四根满额 32MiB 私有历史加密物理重开。首条启动诊断 core 约 6.56 秒，但 15 秒内整个模块图仍未完成；不能将单个 import 或单次定向通过当成完整解决。存储重开三次打开累计约 29.86 秒，随后超过 30 秒；密钥解保护单次约 0.43–0.60 秒，不能仅归因为 DPAPI。

证据目录：.hpm-acceptance/context-startup-provider-boundaries-20261020-01/，包括 covered-final.log、client-coverage-current.log、modules-before.json、modules-final.json、outcome-current.json；早期失败实验保留。下一步须定位全量并发下启动模块图、容量 CPU 和存储生命周期成本，并保持全部安全校验。WBIPC 双预算、真实客户端多次压缩、安装迁移回滚、真实 24h 到期及生产启用仍待完成；真实模型请求、安装配置修改和生产重启均未执行。三份方案原尾部逐字节保留。


## 最新完整门禁：1225/1230，启动和容量及存储重开超时待修复（2026-10-20；整体未交付）

包含新原文校验模块的原 test:client:coverage 完整运行退出 1：1230 项、1225 通过、3 失败、2 取消，302559.7993ms。覆盖率语句 99.04%、分支 95%、函数 99.17%、行 99.04%，原阈值通过，但完整测试门禁没有通过。

原两条 15 秒代理启动和 60 秒容量命令仍超时；另有 actual encrypted worker startup removes orphan staging and retains committed evidence across reopening 触发原 30000ms 期限。其诊断显示第一次打开约 4.9 秒，第二次打开从约 8.3 秒到 21.3 秒，清理和关闭到约 29.1 秒，第三次打开尚未完成便到期。不能把这个整体失败归因为单个 DPAPI 调用，也不能用此前专项通过替代本次完整并发失败。没有调整测试并发、工作量、worker 数、期限或阈值。

满额四根 32MiB 私有历史物理重开在本次完整并发中也触发原期限，属于取消项；此前 184/184 扩展专项通过保留，但不能证明全量并发稳定性。完整失败和取消名称共 5 项，精确列表保存在收据中。最新结果较上一源码快照额外暴露两项并发超时，尚未解决。

证据：.hpm-acceptance/context-payload-verification-20261020-01/client-coverage-current.log、full-gate-outcome.json；184/184 专项和局部基准保留在该目录。账本解析的局部性能收益没有解决完整门禁。启动、容量和多次存储重开稳定性仍需修复，WBIPC 双预算、真实多端、最终安装迁移回滚、真实 24h 到期和生产验收也未完成。未发真实模型请求、未修改已安装客户端、未重启生产；凭据选择仍待用户答复。三份方案原尾部逐字节保留。


## 最新增量：账本单次解析复用原文校验，原容量期限仍未通过（2026-10-20；整体未交付）

新增独立 context-evidence-payload-verifier，仅在一次账本解析内缓存相同不可变字符串的 UTF-8 Buffer 和 SHA-256，最多 128 项/4MiB；不跨请求、不跨解析保存。每条 source 仍独立验证原文长度、摘要、读取位置，所有者、时间、来源身份、配额和累计读取状态继续由账本解析器逐项验证。UTF-8 全文先精确往返检查，前缀位置通过 UTF-8 continuation byte 判定边界，避免为完整前缀再分配和解码一份文本。空原文、控制字符、中英文/组合字符/emoji、孤立代理、非法和极端入参、摘要/字节/读取边界篡改、128 项/4MiB 饱和及跨解析隔离均有回归；新测试在原统一客户端门禁文件内。发布运行时清单已登记新模块，首次发布检查的缺失告警已修正，没有绕过门禁。

新增集成回归在旧解析器下失败（相同内容逐条重算 4 次摘要，预期两个不同内容各一次），最终专项账本 29/29；扩展账本、sessions、root-state、storage-blobs 和 protocol 共 184/184、0 取消，修改的两个模块语句/行 186/186、分支 111/111、函数 9/9，均 100%，原覆盖率门槛通过。四根满额 32MiB 私有历史加密 worker 重开在该扩展运行通过，约 170 秒；此前 139 秒属于不同运行，不能称本次改善该路径。Lint、格式、CI 和最终发布治理通过。

480 来源/15MiB 原文、10 种重复内容、8 轮交替、每轮 4 次解析的局部基准中位 249.5ms -> 57ms，约 77% 局部解析改善；不是整体恢复或生产提速。原容量整文件依然 9/10，原 60000ms 子进程 ETIMEDOUT，五种工作量、两 worker、并发和覆盖率要求未调整。最近完整客户端仍为上一源码快照 1227 项/1224 通过/3 失败，本次新增三个测试后的完整客户端尚待运行。

本轮另两项实验未进入最终代码：大消息单次哈希约 307ms 对现有前缀复用 95.5ms，明显更慢；共享准入编码约 184ms 对 187.5ms，收益不足以支持新增接口。后者涉及四个运行时文件及绑定测试，已对先前备份/收据逐字节核验恢复。没有保留这些实验的产品接口或测试。

证据：.hpm-acceptance/context-payload-verification-20261020-01/ 的 before.log、ledger.log、covered.log、comparison.json、capacity.log、*-final.log、outcome.json；另外两实验结果在 context-large-fingerprint-20261020-01/experiment.json 和 context-admission-encoding-share-20261020-01/comparison.json。仍需启动与容量修复、WBIPC 双预算、真实多端、打包安装迁移回滚、真实 24h 到期和生产验收。真实模型凭据选择仍待答复；未发真实模型请求、未改已安装客户端、未重启生产。历史方案原尾部逐字节保留。


## 最新完整门禁：1224/1227，三项原超时仍待修复（2026-10-20；整体未交付）

在历史文本计数和小消息一次哈希改动后，原 test:client:coverage 完整运行测试结果为 1227 项、1224 通过、3 失败、0 取消，耗时 274348.84ms。覆盖率语句 99.04%、行 99.04%、分支 94.99%、函数 99.17%，原阈值通过，整体测试门禁仍失败。失败仍为两条 15 秒代理启动和原 60 秒容量子进程，没有修改工作量、并发、worker 数、超时或覆盖率门槛。本次其余物理存储和四任务路径通过，不能替代真实客户端或生产验收。

当前源代码的独立 CPU 诊断保留原五种容量画像与两个 worker，五种均完成，最大画像完成 1920 轮、400 次精确恢复和最终结果观察；总耗时约 83.2 秒，最大 worker 约 82.7 秒。这是超过门槛的诊断结果，不能称为容量资格通过。主要自耗时仍是历史克隆约 8.4 秒、hash.update 约 8.1 秒、canonical 字符串编码约 7.4 秒，以及大小计算和转义扫描；包容耗时不可直接相加，也不能据前后宿主负载差异作总体提速承诺。

证据：.hpm-acceptance/context-small-fingerprint-20261020-01/client-coverage-current.log、full-gate-outcome.json、profile-summary.json、profile-outcome.json。仍需修复启动与容量性能，并完成 WBIPC 双预算、真实多端恢复、打包安装迁移回滚、真实 24 小时到期和生产验收。真实模型凭据选择尚待答复；未发真实模型请求、未更改日常配置、未重启生产。历史原尾部逐字节保留。


## 最新增量：小消息指纹减少哈希对象分配，容量期限仍未通过（2026-10-20；整体未交付）

单次准入内的小 canonical 消息改用 Node 原生 crypto.hash 一次计算 SHA-256；旧运行时保留 createHash 回退，大消息继续使用既有前缀状态复制。canonical 字节、字段排序、摘要算法、128 项及 4MiB 缓存限制、认证作用域、绝对到期和持久格式不变。新增回归验证原生分支和旧运行时回退摘要一致，覆盖空对象、Unicode、孤立代理、NUL、嵌套工具、数字键序和大消息；已有缓存边界回归保留并纳入统一客户端门禁。

最终绑定、history-map、sessions、protocol 共 118/118，通过原覆盖率门槛；修改模块语句/行 181/181、分支 83/83、函数 11/11，均为 100%。作用域 Lint、格式、CI 和发布治理检查通过。实际候选在预热后 8 轮交替、每轮 12 次准入、1441 条消息的局部测量中位数 109ms -> 93.5ms，约 14%；同候选未预热测量约 2%，初始诊断约 20%，说明宿主负载和 JIT 差异明显，不能当作整体性能承诺。

原容量整文件仍 9/10，失败为原 60 秒资格子进程 ETIMEDOUT；五种工作量、两个 worker、测试并发与覆盖率阈值保持原值。最近完整客户端门禁是此前快照 1225 项中 1222 通过、3 失败，早于本次及上次文本计数优化，不能视为当前版本完整通过。完整仓库格式门禁此前仍有 404 文件告警，本轮没有批量改写或增加忽略。

证据：.hpm-acceptance/context-small-fingerprint-20261020-01/ 的 before.log、covered.log、comparison-final.json、comparison-warm.json、capacity.log、final-*.log、outcome.json。新容量 CPU 画像是诊断，不替代原 60 秒门禁。真实客户端凭据选择仍待用户答复；没有真实模型请求、日常配置变更或生产重启。整体仍需容量和并发启动修复、WBIPC 双预算、真实多端恢复、安装迁移回滚、真实 24h 到期和生产验收。三份历史方案尾部逐字节保留。


## 最新增量：历史文本计数减少分配，容量期限仍未通过（2026-10-20；整体未交付）

历史请求规范化在每次准入内缓存未命中文字的 UTF-8 大小；普通无转义文本直接加 JSON 双引号的两字节，不再为计数生成一份同样大的 JSON 字符串。Unicode 控制字符、引号、反斜杠和全部代理字符仍走原生 JSON.stringify，保持配对/孤立代理的既有结果；descriptor、节点、深度、单项/总字节、冻结和版本准入不变。Lint 不允许显式控制字符正则，最终采用既有模块使用的 Unicode 分类正则，没有关闭规则。新增回归在计数缓存饱和后阻止长普通文本序列化，同时检查实际 JSON 字节、克隆和冻结；原 Unicode/转义/孤立代理及 2MiB 精确边界回归保留。

最终绑定、history-map、sessions、protocol 共 117/117，通过原 85/80/90/85 覆盖率门槛，修改模块语句/行 100%（221/221）、分支 98.01%（148/151）、函数 100%（9/9）。Lint、格式、CI 和发布治理通过。最终 1441 条消息/15836541 编码字节，每轮 12 次规范化、8 轮交替，中位数 128ms -> 117.5ms，约 8% 本地局部收益，不能外推生产或完整容量速度。另一项指纹编码实验未体现收益，生产文件已逐字节恢复原版本。

最终原资格命令专项仍在原 60000ms 子进程期限 ETIMEDOUT；它仍执行原五种工作量和两个 worker，没有缩小四任务或绕过最终 drain。早先本轮容量整文件两次均 9/10；最终专项针对同一个失败测试，不能称为完整容量通过。最近完整 client 仍是上一快照 1225 项/1222 通过/3 失败/0 取消，本次没有重复完整 client，新增回归后的全量仍待验证。上一轮全仓 format:check 已退出 1，404 文件告警主要是 .codex-tmp/tmp 历史诊断和生成证据；没有批量改写、忽略或提高 baseline。

证据：.hpm-acceptance/context-string-sizing-20261020-01/ 下 before.log、covered-final.log、comparison-final.json、capacity-current.log、final-*.log、outcome.json。整体仍需处理两条 15 秒启动和原容量超时、WBIPC 双预算/实际客户端、包安装迁移回滚、真实 24h 到期及生产验收。未更改日常客户端、未发真实模型请求、未重启生产；三份历史方案原尾部逐字节保留。


## 最新完整门禁：1222/1225、三项超时、无取消（2026-10-20；整体未交付）

在存储请求不可变复用改动后，原 test:client:coverage 完整执行退出 1：1225 项、1222 通过、3 失败、0 取消，272140.9422ms。语句/行覆盖率 99.04%（23439/23665）、分支 94.98%（11280/11875）、函数 99.17%（1201/1211），原阈值通过，测试门禁未通过。两条原 15 秒代理启动和原 60 秒容量 qualification 命令仍超时；不修改并发、工作量、两个容量 worker 或期限。此前完整运行中另七个失败/取消事件本次未复现，不能据此承诺永久消除；特别是 DPAPI 与物理 worker 仍需稳定运行证据。

本次启动诊断在 15 秒截止仍未完成模块加载：core imports 合计约 7.5/8.3 秒，并且到期时分别仍加载 profile_auth/rate_limits。该数据指导排查启动模块图，不证明已修复。容量命令为 spawnSync 原 60000ms ETIMEDOUT。四根完整私有历史物理测试在本次统一并发中通过，无取消；先前独立 139 秒结果保留。完整仓库 format:check 另行执行，已有非本任务 .codex-tmp 历史诊断与生成覆盖率文件格式告警；不批量改写用户证据或提高 baseline。

证据：.hpm-acceptance/context-storage-request-reuse-20261020-01/client-coverage-current.log、full-gate-outcome.json、repository-format.log。整体目标仍需解决三项完整门禁失败、完成实际多端/WBIPC、安装迁移回滚、真实 24h 到期和生产验收。未发真实模型请求、未更改日常客户端配置、未重启生产。


## 最新核验：存储请求不可变复用、物理恢复剖析及客户端声明配置（2026-10-20；整体未交付）

存储 worker owner 与 SQLite engine 对同一已解析请求重复规范化。storageRequest 现在只复用模块私有 WeakSet 登记的深冻结解析结果；原输入不会冻结，跨 JSON/structuredClone/worker 边界重新校验，外部冻结对象或伪造字段不能获得复用资格。没有修改协议、权限、scope/revision/expiry 检查或配额。新增回归覆盖冻结嵌套结构、原输入隔离、复制后重验、getter/toJSON 不执行、非法字段/版本/大小拒绝、revision conflict、到期及关闭行为。存储、blob、service、opening、root-reader、lifecycle 共 195/195 通过；修改模块语句/行 98.91%、分支 96.44%、函数 100%，原覆盖率门槛通过；最终 Lint、格式、CI 和发布治理通过。

8MiB 请求连续解析两次的 8 轮交替局部基准，中位数 2002ms -> 986.5ms，约 51% 局部改善，不能外推整体请求速度。四根实际 session 历史、2048 快照、4096 私有调用、32MiB 私有历史的加密 save/close/reopen/load/restore 独立测试 1/1，139050.7264ms；此结果未体现整体提速，也未覆盖每根原文 16MiB 同时用满。新 CPU 剖析显示存储 worker 的 reference state 校验、清理、容量统计路径仍重复处理大记录，下一步应针对事务内重复工作验证优化；不得省掉认证或语义验证。

只读安装和声明配置盘点：Codex CLI 0.160.1 选择 custom provider，origin 为 http://localhost:3085；Claude Code 2.1.292 的 settings 与当前环境 origin 均为 https://api.deepseek.com，当前声明路径绕过代理。只读取 origin 和字段存在性，没有输出凭据、完整 base path 或用户内容，没有修改配置或发真实模型请求。因此无插件 Claude 兼容尚未交付，需隔离配置实际验收。最近完整 client 门禁仍为 1221 项、1211 通过、8 失败、2 取消，且早于本次修改；不能用本次专项绿色替代完整并发失败。

证据：.hpm-acceptance/context-storage-request-reuse-20261020-01/ 下 before.log、covered.log、comparison.json、full-physical-profile.log、profile-summary.json、client-config-inventory.json、final-*.log、outcome.json。保留原 24 小时观察数据和绝对到期时间；未重启生产。完整门禁、多端/WBIPC、安装迁移回滚及生产验收仍待完成，三份方案原尾部逐字节保留。


## 最新核验：历史克隆分配优化、完整门禁重跑及超时清理（2026-10-20；整体未交付）

历史请求 normalizer 将每个递归节点临时创建的 spend 闭包改为操作级函数，稠密数组按已验证长度直接索引，避免生成临时名字数组及回调。自有 descriptor、继承 setter 防护、冻结、单项/总字节、节点、深度及版本限制均保留，没有新增缓存或原文留存。绑定文件 32/32 通过。1441 条消息、15836541 编码字节、每轮 12 次规范化、8 轮交替基准，中位数 119.5ms -> 111ms，约 7% 本地局部改善，不能外推整体或生产速度。

原完整 test:client:coverage 本轮退出 1：1221 项，1211 通过、8 失败、2 取消，328919.0238ms；覆盖率语句/行 99.01%、分支 94.99%、函数 99.09%，覆盖率阈值通过但测试未通过。修改 normalizer 的语句 216/216、函数 9/9、分支 149/152。失败包括原两条 15 秒代理启动、原 60 秒容量命令，以及 v7 强制退出、idle corruption、旧 DPAPI 互通、staged 清理重开、混合期限重开、物理强制退出和新增四根满额物理测试。两条取消为原 30 秒 staged 重开及新增 180 秒四根测试；不能继续用上一轮 3 项失败描述当前全量结果。

新增存储/DPAPI/强制退出失败六条分组复核 6/6、15942.5316ms，并不证明完整并发失败已修复。日志明确记录一次 legacy_unprotect PowerShell 后端原 10 秒 ETIMEDOUT。新增满额测试完整并发下 180 秒超时，独立成功不能替代该失败。未降低统一并发、两个容量 worker、工作量、原期限或覆盖率阈值。

为避免测试超时后的原异步函数继续构造后续根，在满额夹具循环和物理测试的 await 边界使用 runner 原取消信号；取消后进入原 finally 关闭 worker、session 并删除经校验的自有目录。新增已取消夹具回归验证在建 session/读取时钟前停止，与单根 512 快照/8MiB 实际恢复测试共 2/2；补信号后的四根物理测试独立 1/1，成功路径仍需四根、2048 个快照/4096 调用/32MiB 及相同内容/期限。此清理修正没有修复完整门禁的性能超时。Lint、Prettier、CI 与发布治理最终通过。

24 小时真实观察第 6 次仍 awaiting-real-deadline，保留原绝对截止 2026-10-22T00:55:55.109Z。完整门禁、实际多端/WBIPC、安装迁移回滚与生产验收仍未完成；未重启生产、未改已安装客户端、未发真实模型请求。本轮只对修改后的取消边界及满额成功路径做专项验证，未再次重复完整 client 命令，最近全量结论仍为上述失败。

证据：.hpm-acceptance/context-history-clone-20261020-01/ 下 benchmark.log、comparison.json、binding-regression.log、client-coverage-current.log、current-client-summary.json、failed-storage-group-recheck.log、cancellation-and-full-session.log、full-physical-cancellation-safe.log、final-*.log、outcome.json。三份历史方案文档原尾部逐字节保留。


## 最新核验：容量性能重采样与快照索引缺失查询优化（2026-10-20；整体未交付）

原 60 秒容量门禁本轮基线仍为 9/10，耗时 72099.5716ms。另一次不作为门禁通过证据的 CPU 采样完成全部五画像，最大 worker 85395ms、主进程 85816ms，五画像均 qualified，四任务画像完成 1920 轮、400 次精确恢复、20 次重开与最终原文 drain；它只证明合成会话逻辑能完成，不能替代原 60 秒性能资格、物理存储、真实客户端或生产验收。

新采样主要耗时仍为 begin 45944ms、历史规范化 19964ms、绑定指纹/前沿 22113ms、根恢复 15175ms（包含关系有重叠，不可直接相加）。索引 has 自身约 1199ms，因此不是主瓶颈。为减少已有线性父链上的缺失键遍历，给每个私有快照索引加入固定 256 字节位图，仅记录短字符串键的非加密混合位；不保存原文或键值，不参与授权、序列化、版本或到期判断。位图阴性才直接拒绝，任何可能命中仍通过原 Map 精确遍历。每个子分支独立复制位图，父快照和 sibling 不可互相加入键；非字符串和超过 256 字符的键保留原 Map 路径。位图饱和/碰撞仅影响性能，不改变成员关系。

新增回归先在原实现得到缺失查询探测门禁失败，修复后 sessions 45/45。扩大到 sessions、root-owner、private-capacity 共 93/93，修改模块语句/分支/函数/行均 100%，原 85/80/90/85 阈值通过。覆盖父子/sibling 隔离、空键、超长键、对象不强制转换、NaN、负零、symbol、4096 个字符串饱和、重复拒绝、完整迭代与恢复。测试留在既有统一入口列出的 sessions 文件。Lint、Prettier、CI 与发布治理通过。

8 轮交替局部基准每轮 24 条 480 深度链，中位耗时 baseline 793.5ms、candidate 627.5ms，约改善 21%；仅为本地合成索引基准，不代表整体恢复或生产速度。原容量门禁修改后仍 9/10、64788.8854ms，60 秒子进程超时，未解决整体性能失败；不能以两次超时总时长推算总体提速。五画像、两 worker、工作量、原超时和覆盖率阈值均未改动。本轮未再次执行完整 client coverage，最近全量 3 项失败仍未关闭。其余多端/WBIPC/打包安装回滚/真实 24 小时到期/生产验收仍待完成；未重启生产、未改已安装客户端、未发真实模型请求。

证据：.hpm-acceptance/context-capacity-current-20261020-01/ 下 CPU profiles、profile-summary.json、profile-run.log、snapshot-filter-before.log、snapshot-filter-covered.log、snapshot-filter-benchmark.json、capacity-filter-after.log、snapshot-filter-outcome.json；基线原门禁为 .hpm-acceptance/context-request-encoding-reuse-20261020-01/capacity-current-baseline.log。三份历史文档原尾部逐字节保留。


## 最新核验：真实会话四任务满额私有历史的加密重开（2026-10-20；整体未交付）

新增两个测试进入已有 root-state 文件及统一 client coverage 入口。通过真实 sessions.begin、recovery.accept、complete 生成数据，未直接注入伪造历史：每根 512 个快照、512 条私有映射、1024 次私有调用、511 个实际原文来源。首快照混合公开 lookup 与私有 LIST，后续 511 个 sibling 分支捕获各自原文并执行两个参数不同的 LIST；原防重复调用检查保持不变。先以两个真实快照测量固定开销，再填充每条精确 16384 字节，断言每根私有历史合计 8MiB。

四根实际通过 Windows 密钥保护的加密 worker 保存 reference-state，关闭所有原 sessions 和 worker，重新打开存储，逐根 load 并比较检查点摘要、全部私有历史摘要、全部原文来源及原绝对到期。随后四根批量恢复 sessions，再导出全部根并完整比对历史，单独验证 observedAt 单调递增，所有到期时间严格保持不变。总计 2048 个快照、4096 次私有调用、32MiB 私有历史。此处验证的是私有历史满额，未声称每根 16MiB 原文配额同时满额。

首次物理测试已通过加密保存/重开/读取，但错误地要求恢复后 observedAt 不变而失败；测试现按既有观察时钟语义单独检查该字段，其他历史字段完整深比较，未修改运行时代码或放宽容量/期限。最终 root-state 全文件 55/55，通过耗时 186316.783ms；四根物理测试 131748.1165ms。单根满额独立测试通过，Lint、Prettier、CI 治理及发布治理通过。保留全部夹具调试失败记录。

本轮没有再次执行完整客户端门禁，最近完整结果仍为 1214 项中 1211 通过、3 失败，两条代理启动和原 60 秒容量命令尚未修复。原五画像、两 worker、60 秒容量期限和既有覆盖率阈值均未修改。24 小时真实观察第 5 次仍 awaiting-real-deadline，原截止 2026-10-22T00:55:55.109Z；未重置或续期。后续仍需性能/重开稳定性、WBIPC 预算内恢复、全仓门禁、打包安装迁移回滚、真实多端和生产验收。未重启生产、未改安装客户端、未发真实模型请求。

证据：.hpm-acceptance/context-request-encoding-reuse-20261020-01/full-session-capacity-sixth.log、full-physical-capacity-first.log、full-session-root-suite.log、full-session-physical-outcome.json。三份历史方案文档原尾部逐字节保留。


## 最新核验：四根满容量历史的批量恢复修复（2026-10-20；整体未交付）

新增实际 history-map 满容量用例，四个 v3 根各 512 条 sibling 记录、每条两次私有调用，共 2048 条记录/4096 次调用/精确计费 33554432 字节（32MiB）；各根 8MiB、1024 次调用。每个根先通过真实 prepare/commit 和 export 生成，导出 512 个 tip，再批量恢复并逐 tip 重建，以 SHA-256 比对全部 4096 个实际结果。此用例补充此前四根各四个条目的调用上限测试，没有替换旧测试或缩小容量目标。

修复前，四根分别合法并可导出，合并 restoreContextHistoryRoots 却失败 invalid_context_history_state。证据为每根 19465 节点，批次 77885 节点、编码 33418437 字节（低于原 48MiB 总上限）；旧入口先整体规范化，错误地让四个新根共享一个 65536 节点预算。新增断言同时确认通用 normalizer 仍拒绝该批次，未扩大通用限制。

现在批量入口仅用 descriptor 校验外层数组/包装及小 scope，每根交给原版本化 parser 独立检查字节、节点、深度及语义；计入逗号/包装/scope 的 48MiB 总编码上限保持不变，最终仍执行全局数量/字节/四根配额。v1/v2 子集继续通过原整体 normalizer 保持共享节点/深度限制，只有已定义的 v3 采用独立根预算。成功前不构造 live map。新增 malformed/sparse/accessor/隐藏字段/第五根/重复条目/末根失败等拒绝回归，验证不执行 getter、非法批次不调用 owner 时钟且既有源 map 仍可读；另验证两个分别合法的大 legacy 根仍因共享节点超限拒绝，v1/v2/v3 混合恢复保留原版本与各自绝对到期。

修复前满容量负控 0/1，修复后 1/1；history-map 全文件 25/25。扩大到 history-map、root-state、root-owner、private-capacity 四文件后 126/126，语句/行 92.73%、分支 90.33%、函数 91.66%，原 85/80/90/85 专项阈值通过；Lint、Prettier、CI 与发布治理均通过。新增测试位于原 unit 自动发现与原 client coverage 显式列出的 history-map 文件中。

本轮没有再次执行完整客户端门禁，最近完整结果仍为 1214 项中 1211 通过、3 失败（两条代理启动与原 60 秒容量命令），不能用此次专项替代全量。满容量用例是实际私有映射的内存导出/恢复，不证明同规模加密 SQLite/真实客户端/生产资格；此前七 MiB 物理 worker 恢复也不能外推到本次 32MiB 满额目标。后续仍需满额物理根验收、启动/容量性能与重开稳定性、WBIPC 预算内恢复、全仓门禁、最终打包安装迁移回滚、真实多端/24 小时到期及生产验收。未重启生产、未改已安装客户端、未发真实模型请求。

证据：.hpm-acceptance/context-request-encoding-reuse-20261020-01/ 下 full-private-roots-before.log、full-private-roots-after.log、full-private-roots-expanded.log、full-private-covered.log、full-private-coverage/、full-private-roots-outcome.json。本次保留全部历史文档尾部，并记录新文件哈希。


## 最新核验：JSON 克隆局部优化及数组 setter 边界修复（2026-10-20；整体未交付）

通用 JSON 规范化中的空原型对象改用直接自有数据赋值，保留所有 descriptor 校验、深度/节点/字节限制、最终 JSON 转义后计量；数组仍使用 Object.defineProperty，避免继承的数字 setter。新增回归验证 __proto__/constructor/prototype、继承 setter 不执行、精确数据描述符与克隆隔离。8000 条合成记录、每轮 12 次规范化、8 轮交替顺序对照，中位数 934ms -> 819.5ms，约 12% 局部改善；这是 normalizer 微基准，不能外推整体恢复或生产速度。原五画像、两 worker、60000ms 容量子进程仍超时，回归 9/10、65571.8341ms。

沿此边界发现并修复两个实际缺陷：normalizeRecoveryStateData 与 normalizeRecoveryHistoryRequest 对数组直接赋值（后者还使用 history.push）会执行 Array.prototype 上继承的数字 setter，导致已验证值遗漏。两处独立回归在修复前均出现 setter 调用计数 1 != 0；现在所有复制出的数组元素显式创建自有数据描述符，空原型对象保持直接赋值。请求回归覆盖外层 history 与嵌套 content 数组，检查完整 JSON 相等和冻结；状态回归检查末项、null prototype、数据描述符及源对象隔离。无接口、版本、容量或到期语义变更。

初次四文件 87/87，但整个 envelope 模块语句覆盖 83.84% 未达 85% 门禁；补入已有 lifecycle/evidence 用例后 102/102、门禁通过。加入两处数组修复后最终七文件 135/135，三个修改模块语句/行 99.73%、分支 95.94%、函数 100%，原 85/80/90/85 阈值通过。新增测试均位于既有 unit 自动发现文件中，binding/root-state 也在 client 入口。Lint、Prettier、CI 和发布治理通过。保留首次覆盖率拒绝及修复前安全回归失败日志。

最终原 test:client:coverage 退出 1：1214 项中 1211 通过、3 失败、0 取消，188503.9393ms；语句/行 99.04%、分支 94.96%、函数 99.17%。剩余失败是两条 isolated proxy 原 15000ms 启动期限与容量 qualification 原 60000ms 期限。存储重开本次通过，但此前全量存在超时，未确认根因，不能据此报告稳定性已修复。没有降低任何工作负载、并发、超时或覆盖率阈值。

证据：.hpm-acceptance/context-request-encoding-reuse-20261020-01/ 下 normalizer-alternating.json、normalizer-comparison.cjs、normalizer-covered.log（首次覆盖率失败）、normalizer-covered-final.log、normalizer-security-covered.log、normalizer-capacity-original.log、state-array-setter-{before,after}.log、history-array-setter-{before,after}.log、client-coverage-normalizer-security.log、normalizer-security-outcome.json。整体仍未交付：启动/容量性能及重开稳定性、满容量私有存储和混合失败路径、WBIPC 预算内原生恢复、全仓门禁、打包安装迁移回滚、真实多端与 24 小时到期观察、生产验收未完成。未重启生产、未改已安装客户端、未发真实模型请求。


## 最新核验：全量剩余超时与三协议私有调用边界（2026-10-20；整体未交付）

原 test:client:coverage 重跑退出 1：1205 项中 1202 通过、2 失败、1 取消，193398.5769ms；语句/行 99.04%、分支 94.94%、函数 99.17%，覆盖率达标但测试门禁未通过。失败仍包括 isolated proxy 15000ms 启动期限、容量 qualification 原 60000ms 子进程期限，以及真实加密 worker 三次重开测试的 30000ms 期限。最后一个测试第三次 ready 在 29957ms 才到达，尚未完成最终读取；不能报告恢复验收通过。未降低原工作负载、两 worker、并发、期限或阈值。

修正三个测试中的旧版本假设：v10 是合法版本，非法版本改为 v11，新增 v9/v10 正常与超限解析覆盖。四文件定向测试 104/104。测试诊断增加受控 CPU user/system 累计毫秒，与墙钟耗时并列；固定标签、整数、限长，拒绝 getter/非法/倒退采样且不影响原操作。全量内存首请求从 first_start 1241ms 到 storage_load_start 3303ms，CPU 增量约 594ms；这只表明耗时差异，不足以确认超时根因。

随后新增七个进入既有统一 unit/client 门禁的 history-map 回归，最终该文件 22/22：Chat/Responses/Claude 分别在旧私有版本 64 次和新版 1024 次调用后拒绝第 65/1025 次、祖先重复 ID 和版本切换；拒绝不改变存量计费；JSON 导出恢复逐条比对全部私有结果；到期前可读、绝对到期时引用与字节均清零。另一个实际 history-map 用例同时保留四个根、每根 1024 次调用，拒绝第五根且不丢已有结果，跨 scope 不可重建，并逐根导出恢复精确比对。它验证 8 个实际条目中的 4096 次调用，不等同于四根各 512 条/8MiB 的满容量物理存储验收。

新增测试首轮因 Claude 公开字符串 content 的结果提取写法失败 2 项，改用 Array.isArray 后通过；保留失败日志。Lint、Prettier、CI 和发布治理均通过。最终 22/22 边界文件是在上述全量运行之后修改，尚未再次纳入完整并发重跑，不能把两个结果合并成新的全量通过。

真实 Windows 密钥链加密留存第 4 次独立检查通过，仍 awaiting-real-deadline；原绝对到期 2026-10-22T00:55:55.109Z 未改，无后台任务。未重启生产、未改已安装客户端、未发真实模型请求。容量性能、启动/重开超时根因、四根完整条目/字节边界及混合/失败清理集成、WBIPC 预算内原生恢复、全仓门禁、最终打包安装迁移回滚、真实多端与生产验收仍未完成。

证据：.hpm-acceptance/context-request-encoding-reuse-20261020-01/ 下 client-coverage-cpu-current.log、full-failure-fixes-focused.log、private-call-boundaries.log（首轮失败）、private-call-boundaries-final.log、private-four-roots-final.log、boundary-followup-outcome.json；留存使用原 receipt.json，未重置计时。


## 最新核验：容量实验撤回与 v10 独立进程验收修正（2026-10-20；整体未交付）

原始容量测试仍为 9/10，qualification 子进程在原 60000ms 上限超时；不带采样的完整五画像诊断随后也触及 180000ms 观察上限，未取得完整报告，不能据此宣称内容或性能通过。诊断超时没有替代或修改原门禁。

尝试在单请求内复用规范化阶段的字符串 JSON 编码，跨请求仍重验全历史。1441 项历史、480 个 32KiB 工具输出、每轮八次完整 admission 的三轮局部对照，中位数由 1016ms 变为 1660ms，未证明收益。候选已撤回，history-request、public-window、binding-frontiers、binding 四个运行时文件与实验前备份逐字节一致；不保留该优化，不外推整体速度。

修正了 v10 验收夹具遗漏：publication 容量新增 v10 正向断言并用 v11 检查未知版本；Codex 摘要 schema 断言更新为 v10，仍检查未知版本拒绝；独立 owner 辅助程序接受已支持的 v10，并保留 7/8/9。修正前绑定/摘要回归 39/41，两个子进程因辅助程序不接受 v10 失败；修正后 41/41，通过 Windows 加密存储的两独立 owner 精确读取，以及强制终止 owner、重开读取、提交撤销后再强制终止再重开的完整序列。publication 专项另为 1/1。Lint、格式、CI 与发布治理通过，测试位于既有统一 CI 入口。

证据：.hpm-acceptance/context-request-encoding-reuse-20261020-01/ 下 capacity-before.log、baseline.json、admission-baseline.json、admission-candidate.json、after-restore-regression.log（失败记录）、after-helper-regression.log、outcome.json 和文档保尾收据。整体仍需容量性能与全量并发门禁、WBIPC 预算内恢复、全仓验证、最终安装/迁移/回滚、真实客户端、真实 24 小时观察结束及空闲窗口生产启用。已有留存观察不得重新 seed 或续期；未重启生产、未修改已安装客户端、未发真实模型请求。


## 最新进展：v10 私有历史及加密冷恢复（2026-10-20；整体未交付）

v10 新根支持按根隔离的 8MiB/512 条/1024 私有调用历史，四根合计 32MiB；旧根不借用新配额，原绝对期限不变。引用摘要与加密清单按版本补齐容量路径，实际 Windows 加密 worker 关闭重开后精确恢复 7MiB 私有历史和原文。引用扩大回归 193/193；落盘扩大回归修正旧未知版本断言后 151/151，专项覆盖和 Lint/格式/治理通过。真实 24 小时留存观察已启动，固定到期 2026-10-22T00:55:55.109Z，仍待真实到期检查。原全量并发/60 秒容量性能、WBIPC、最终安装迁移回滚、真实客户端与生产启用仍未完成。详见[实施状态](./context-recovery-implementation-status.md)。


## 最新进展：写入配额复制成本（2026-10-20；整体未交付）

原文写入的配额检查已改为直接遍历 live/pending 记录，保留原计费、隔离、事务与期限。2048 条混合记录三轮对照仅证明局部中位数 662ms -> 602ms；扩大回归 43/43、专项覆盖/Lint/格式/治理通过。文本计数候选经原工作负载对照未证实收益并已撤回。原 60 秒容量门禁仍 9/10，未调整工作负载、worker、期限或阈值。详见[实施状态](./context-recovery-implementation-status.md)。


## 最新进展：容量性能定位（2026-10-20；未交付）

原五画像 CPU 采样均完成内容校验，但最大 worker 约 110 秒（带采样诊断值）；原始 60 秒容量门禁仍失败。无转义文本字节计数优化未达门禁并已撤回，保留精确 JSON 字节边界回归；绑定文件 31/31、专项覆盖及 Lint/格式/治理通过。未改变原工作负载、期限、并发或覆盖率阈值，性能和全量失败仍待解决。详见[实施状态](./context-recovery-implementation-status.md)。


## 最新进展：加密长历史冷恢复（2026-10-20；整体未交付）

已验证独立进程 SQLite 加密冷恢复、WebSocket 响应 ID 续接与完整大历史重发；修复完整窗口私有结果重建误用 2MiB 历史总量限制，私有结果自身额度不变。四文件专项 203/203，修改模块语句/行/函数 100%、分支 97.29%，Lint/格式/CI/发布治理通过。此前原始全量 client coverage 仍退出 1（1167 通过、12 失败、8 取消），未降低工作负载、并发、超时或覆盖率阈值。真实多端安装、生产验收及 24 小时观察尚未完成，详见[实施状态](./context-recovery-implementation-status.md)。


最新进展（2026-10-20）：修复 WebSocket 长历史接收、调度、warmup admission 和共用异步 owner 加载的隐藏 2MiB 上限。真实本地压缩/分片 WS 已完成约 2.7MiB 历史与私有精确读取链路；大请求发送仍由真实绑定授权，普通小队列、响应及旧格式维持原边界。专项 185/185、覆盖率及 Lint/格式/CI/发布治理通过。完整门禁、WBIPC、私有配额、长历史冷恢复、最终客户端安装与真实留存仍未交付，见[实施状态](./context-recovery-implementation-status.md)。


最新进展（2026-10-20）：九条 HTTP 转换路径均已补齐受信长历史资格与请求发送；请求侧保真摘要同步使用版本化历史额度，元数据/工具/响应及旧格式保留原边界。最终专项 121/121、本地真实 HTTP 九路径逐条原文与长度校验，以及 Lint/格式/CI/发布治理通过；修改模块语句/行 99.22%、分支 90.22%、函数 100%。本地合成上游不代表真实模型或客户端验收。完整并发门禁仍未通过，WebSocket/WBIPC、私有配额、最终安装和真实留存未交付，详见[实施状态](./context-recovery-implementation-status.md)。


最新进展（2026-10-20）：Responses / Claude 转 Chat 已补齐受信格式 3 的长历史额度，单条消息/元数据、响应及旧格式仍保留原边界；专项 112/112 与修改模块覆盖率、Lint/格式/CI/发布治理通过。容量调度仍为两个 worker 和完整五档，单独回归 10/10；原完整客户端覆盖率检查却有 5 项失败、4 项取消，仍需解决超时。完整检查发生在本次转换修复前，修复后全量尚未通过。实际客户端、24 小时观察与生产激活未完成，见[实施状态](./context-recovery-implementation-status.md)。


最新性能增量（2026-10-20）：检查点重建只在单次调用内有界复用成功的来源策略校验，保留逐条摘要/期限/所有者/预算/关联验证；缓存固定工具、ID 编码长度与原文，失败不缓存，最多 128 项/4
MiB。最终专项 284/284 与格式/Lint/治理/发布清单/网关准备和新模块独立覆盖通过，源码摘要稳定。原五档容量内容 5/5，未采样 69594
ms；原 60 秒性能门槛仍未通过。完整门禁、其他协议长历史、最终包、多端及真实留存仍未交付，证据和边界见[实施状态](./context-recovery-implementation-status.md)。

最新版本 9 进展（2026-10-20）：16 MiB/根原文、112
MiB 显式检查点预算已贯通加密持久化与 Worker，实际 Windows 加密 Worker 完成四任务合计 64
MiB 原文保存、关闭重开及精确读取，第五任务拒绝后旧四任务保留。原生 Chat/Responses/Claude 的 HTTP、私有续轮及后续映射重建已贯通绑定格式 3 的 32
MiB 聚合请求；单消息、元数据和响应仍各限 2
MiB，旧任务不自动升级或续期。存储相关 351/351、原生 HTTP 相关 469/469 及各自格式/Lint/治理/发布清单/网关准备通过，HTTP 冻结 1467 个源码文件哈希稳定。这些是专项证据；转换协议、WBIPC/WebSocket 和独立私有留存的大历史资格、87571
ms 容量性能与原 60 秒门禁、启动稳定性、完整门禁、最终包、迁移/回滚、多端实机及 24 小时真实观察仍未完成。整轮缓冲仍为默认，未重启生产、修改已安装客户端或请求真实模型。完整边界和失败记录见[实施状态](./context-recovery-implementation-status.md)。

最新 H1 原文校验（2026-10-20）：完整账本和持久引用的原文列表改为逐条校验并累计 UTF-8/JSON 转义字节，避免这两处构造整批原文 JSON；12
MiB 总界限、每根 4
MiB 配额与原到期时间保持。冻结相关 293/293、完整客户端 1139/1139，新增模块全覆盖；容量仍 4/5，第五组的 129/128 原文缺口未关闭。下一步仍须版本化原文及物理存储容量，并贯通上层检查点和 HTTP/私有生成的字节链路，不能将本轮校验改造视为扩容完成。证据见[实施状态](./context-recovery-implementation-status.md)。

最新 H1 内部长历史（2026-10-20）：新绑定格式 3 的内部请求允许 32
MiB，单条历史/策略等元数据仍限 2
MiB；旧格式任务不自动升级。逐条校验、不可变复用和有界的单次请求编码缓存减少重复处理。第五组从第 65 轮拒绝推进到第 130 轮原文缺口，完成 516 轮/104 次精确恢复，但目标仍 4×480，整体仍 4/5。第二冻结相关 433/433、完整客户端 1134/1134；第一冻结两项超时证据保留。HTTP/私有生成的独立 2
MiB 边界、每根 4
MiB 原文及分块存储仍待贯通；验证范围见[实施状态](./context-recovery-implementation-status.md)。

最新 H1 持久发布容量（2026-10-20）：修复真实持久化服务遗漏版本 8 数量容量的问题，新根每任务 512 条、合计 2048 条，旧根仍共用原来的 256 条。并发写入提前预留额度，失败结果不确定时保留占用。实际会话 512 快照经一次异步持久发布写入加密内存 SQLite 并读回精确原文；相关 308/308、完整客户端 1128/1128。字节容量画像仍 4/5，完整资格未完成；验证范围及证据见[实施状态](./context-recovery-implementation-status.md)。

最新 H1 字节链路修复（2026-10-20）：完整检查点摘要改用显式 12
MiB 存储边界，默认请求指纹仍限制 2 MiB，旧摘要保持兼容。约 5.6
MiB 检查点经加密保存、重开及引用转换后精确读回，期限不续期。冻结相关 361/361、完整客户端 1124/1124；五画像仍为 4/5，通过数不代表整体资格。下一步贯通版本化长历史、原文字节预算和分块存储；证据及剩余边界见[实施状态](./context-recovery-implementation-status.md)。

当前 H1 数量容量（2026-10-20）：新根版本 8 的调用/来源/快照容量已贯通会话、根导出、加密存储和重开，旧根保留原数量限制、预算和期限。五个冻结画像中的四个小载荷画像按原目标通过；第五个大载荷仍受长历史和字节链路限制，整体资格未完成。512 来源和共享私有历史 tips 的持久边界、冻结门禁及剩余验收见[实施状态](./context-recovery-implementation-status.md)。

当前 H1 结算增量（2026-10-20）：持久读者新增版本 2 稀疏进度结算，每次最多更新一个来源，未变化来源保持原进度，旧版本 1 仍要求完整清单；预算预扣、失败保守扣款及原期限不变。相关回归
**348/348**、完整客户端覆盖
**1113/1113**，冻结源码一致。此项解决扩大来源数量前的结算消息增长，数量/字节配额和冻结容量画像不变，全天容量仍未达标；最新证据见[实施状态](./context-recovery-implementation-status.md)。

当前 H1 进展（2026-10-20）：分层读取预算已接入，新任务保留单轮限制及持久累计消耗，旧任务不升级额度；全天画像仍未整体达标。会话、导出和恢复路径已接入不可变共享索引，扩大数量上限前先消除祖先集合的平方级复制。当前冻结结果、启动风险和发布边界见[实施状态](./context-recovery-implementation-status.md)；本次索引改造不改变配额、存储格式或原到期时间。

最新候选默认增量（2026-10-20）：内置默认与首启示例均为版本 2/原生优先，恢复与捕获关闭；旧文件缺版本继续为 1，默认对象返回独立副本。诊断观察真实共享选项，区分策略已载入与完整路径/客户端尚未验收，隔离进程验证启动及显式迁移后的热加载。冻结相关
**320/320**、完整客户端覆盖 **1092/1092**、前端 **28/28**
与覆盖/构建/治理通过，证据
`.hpm-acceptance/context-native-defaults-20261020-01/receipt.json`。I1/I2 仍部分完成，未发布或应用生产；详见[实施状态](./context-recovery-implementation-status.md)。

最新 I1 迁移增量（2026-10-20）：显式预览/应用、配置修订号和共享保存队列、管理界面旧聊天影响提示、桌面桥均已接通；保留开关、偏好、页面草稿与数据有效期，不将保存回执当成运行生效。最终后端
**32/32** 与覆盖/治理通过；前端 **28/28**、前端覆盖/构建、编译 Rust 桥接 **2/2**
通过并校验相关源码哈希未变。证据
`.hpm-acceptance/context-policy-migration-20261020-02/receipt.json`
及其引用的第一冻结。新默认、统一有效状态、完整 I2、最终新包和生产仍未交付，见[实施状态](./context-recovery-implementation-status.md)。

最新 I2
WorkBuddy 增量（2026-10-20）：版本 2 原生普通请求不再自动折叠、建历史分支、归档、私有读取或因载荷拒绝触发压缩重试；显式压缩生成无恢复证据的可信摘要容器，保留工具身份检查。实际隔离代理的三入口大历史负控发现并修复启动路由漏传策略。最终冻结
**297/297**、四模块覆盖与格式/Lint/治理/网关重建通过，证据
`.hpm-acceptance/context-native-workbuddy-20261020-02/receipt.json`；首轮失败保留。旧容器如依赖证据回执，切到原生模式明确 409；迁移 apply、有效状态、新默认、完整 I2 及真实宿主仍未交付；详见[实施状态](./context-recovery-implementation-status.md)。

此前 I2 通用预算增量（2026-10-20）：启动与热加载共用策略合成，版本 2 禁止通用预算器直接裁剪，测量完整历史并明确拒绝超限；保留供应方原生管理旁路。冻结
**79/79**、三个模块覆盖及格式/Lint/治理/网关重建通过，证据
`.hpm-acceptance/context-native-budget-20261020-01/receipt.json`。WorkBuddy 各规划入口、重试和新默认仍待实施，I2 只部分完成；详见[实施状态](./context-recovery-implementation-status.md)。

此前 I1 增量（2026-10-20）：版本元数据名确定为
`appSettings.contextPolicyVersion`，缺字段/1 为旧语义，2 为新策略选择；严格解析、管理完整保存防版本丢失/降级、诊断及前端迁移文案已接通。冻结
**21/21**、策略/诊断/展示覆盖与完整前端
**27/27**、前端覆盖/构建、源码治理通过。默认配置尚未补 2，显式迁移应用操作与请求规划仍待接通，版本选择不等于实际执行；I1 部分完成，I2 未完成。本次未重复完整客户端，证据见[实施状态](./context-recovery-implementation-status.md)顶部。

最新存储开销增量（2026-10-20）：消除 ACL 重复目标观察和清理普通记录的重复认证解密，安全边界及原期限保留。冻结扩大
**140/140**；同一源码实际完整客户端
**1081/1081**、零失败/取消/跳过，源/覆盖门禁通过，历史失败保留，单次通过不证明启动稳定性。本段取代下文历史阶段对最新客户端结果的描述。I1 配置迁移、I2 请求规划及整体资格仍未完成，详见[实施状态](./context-recovery-implementation-status.md)顶部。

当前关闭保留增量（2026-10-20）：默认冷启动保存偏好修复之后，设置关闭及模式切换已改用非删除暂停，原文、到期及预算保留，旧权限不能复活；重新开启由当前请求重新授权，显式清除仍真正删除。第二次冻结扩大
**602/602** 及源/覆盖门禁通过；实际完整客户端
**1079/1080**、一项原 30 秒启动期限取消，整体资格失败，首次冻结失败保留。I1 配置迁移、I2 请求规划及整体资格仍未完成，详见[实施状态](./context-recovery-implementation-status.md)顶部。

当前中断续写增量（2026-10-20）：引用冷接纳已保留未发布来源的隔离描述和逻辑配额，使恢复后持久读者/发布可以继续写入，保持严格来源身份检查及原期限/计数；没有赋予隔离来源可见权限。新增四种中断、再次恢复及真实加密 worker 回归，冻结扩大
**544/544**
和范围覆盖/格式/Lint/构建/语法/治理通过。新默认策略仍未实施，完整客户端没有重跑，整体目标未完成；证据与后续缺口见[实施状态](./context-recovery-implementation-status.md)顶部。

当前发行网关增量（2026-10-20）：发行入口、固定清单、治理和隔离构建接通。专项
**50/50**、覆盖与源码门禁通过，实际隔离发行的运行源、输入、生产依赖及 Node/原生助手身份核验通过；发行自带 Node 在禁止工作区/外部 npm 导入的守卫下完成真实 stdio 原文读回和 EOF 回收。安装/升级回滚、真实宿主接纳、完整客户端启动期限、新默认策略及其它目标仍待完成，证据见[实施状态](./context-recovery-implementation-status.md)顶部。

当前工作区网关构建增量（2026-10-20）：源码默认入口已使用校验后的预构建 runtime，统一测试生命周期自动准备，新增构建/产物边界与源码 API 行为验证。专项
**34/34**、覆盖及格式/Lint/语法/构建/治理通过；最近完整客户端仍
**1051/1058**，启动期限问题与发行安装/升级回滚资格均未解决，不能视为多端交付完成。详见[实施状态](./context-recovery-implementation-status.md)顶部及
`context-recovery-gateway-build-20261020-06/receipt.json`。

日期：2026-10-20（America/Los_Angeles）。状态：新默认策略尚未实施或发布；恢复基础的实施范围见下文与实施状态。

持久 ACK 自动卸载进度：显式引用读者和发布事务已在有效保存回执、owner 租约与 capability 核验后释放已确认来源载荷，后续继续异步精确读回；未知/晚到/失败回执不能触发释放，旧 ACK 不释放新增来源，卸载失败停止根后续 I/O，原期限/预算/计数不变。新增受信独立元数据出口，冷同步完整导出仍拒绝。冻结扩大 534/534、28 模块覆盖/格式/Lint/治理通过，完整客户端 1054/1055（双 stdio 宿主第二次关闭超过原 30 秒，1 取消），总门禁未过；证据
`.hpm-acceptance/context-recovery-ack-eviction-20261020-02/receipt.json`，旧失败保留。尚无整个进程内存/延迟收益测量；启动成本、投影后的持久续写、全天容量、新默认策略、私有流式、多端普通配置、迁移回滚、新包及生产仍未交付。

冷接纳进度：显式引用扫描及独立元数据投影/选择/adoption 已接入源码，普通 format
3 重开会话不物化来源载荷，原策略/授权/预算/绝对期限仍单独检查，选定页再认证；实际加密 worker 重开和省略生成工具的原生压缩续接通过。冻结范围 465/465，27 模块覆盖、格式/Lint/治理通过；原完整客户端 1044/1046，双 stdio 宿主和第三次实际加密 worker 重开分别超过原 30 秒，2 取消，总门禁未过。证据
`.hpm-acceptance/context-recovery-cold-loading-20261020-02/receipt.json`。未改期限、并发、覆盖或客户端命令。ACK 后自动卸载、新默认策略、全天容量、多端普通配置、私有流式、迁移回滚、新包及生产仍未交付；具体资格以[实施状态](./context-recovery-implementation-status.md)顶部为准。

冷恢复基础补充：独立冷账本/根元数据 importer 和整批校验后卸载已通过冻结范围 455/455、完整客户端 1036/1036 及覆盖/治理（`.hpm-acceptance/context-recovery-cold-ledger-20261020-01/receipt.json`）。尚未接入持久 ACK 和 startup/投影/选择/adoption，默认原文仍驻留，新默认策略及完整冷恢复未交付。此前网关初始化超时仍保留为未解决的波动问题。

持久会话接入补充：默认读者/发布源路径在能力显式可用时已改用引用加载/保存及当前 owner 校验，只导出缺失来源。冻结范围 450/450 与覆盖/治理通过，完整客户端 1030/1031（网关初始化超过原 15 秒期限取消一项），总门禁未过；独立网关 7/7 不代替并发资格。证据
`.hpm-acceptance/context-recovery-reference-host-20261020-01/receipt.json`。原文驻留、startup/adoption 全量加载和全天容量等仍待处理，本计划的新默认策略未交付。

引用结算补充：format
3 的存储结算不再完整物化或退回旧格式，冻结范围 445/445、完整客户端 1026/1026 与覆盖/治理全通过（`.hpm-acceptance/context-recovery-reference-settlement-20261020-01/receipt.json`）。默认 host/owner 仍未切换，新默认行为和完整冷恢复尚未交付。

恢复存储基础增量：独立引用持久状态与显式 load-reference 已通过冻结范围 443/443、完整客户端 1024/1024 及原覆盖/治理门禁（`.hpm-acceptance/context-recovery-reference-state-20261020-01/receipt.json`）。默认 host/owner 与结算尚未贯通，无载荷卸载、全天容量、新包或生产资格，本计划的新默认行为仍未交付。详见[实施状态](./context-recovery-implementation-status.md)。

目标：默认最大化保留客户端原有压缩和续接能力，代理只承担必要兼容；用户明确开启后，再启用代理精确上下文恢复。参考 Magpie 的职责划分和成本控制，不建设 Magpie 格式兼容层，不复制其全部降级行为。

本轮仅编写文档，没有修改运行代码、配置、客户端、恢复数据或生产服务，没有调用真实模型。文中“必须”“应”“验收”均为后续实施要求；已有证据单独说明，不代表本方案已交付。

## 1. 推荐决策与范围

### 1.1 一套基础路径，按需增加恢复能力

- 默认原生优先：客户端决定压缩时机并采用摘要，代理提供必要的协议、模型能力和传输适配。
- 可选精确恢复：代理捕获允许留存的原文，维护分支与证据关联，模型需要时内部只读恢复。
- 可选加密留存：精确恢复开启后，可将允许保存的数据加密留存，用于重启后重新授权的读取。

复用现有兼容层和恢复核心，不维护两套引擎。开关不控制入口认证、输入校验、工具安全、原生 opaque 状态隔离、日志脱敏或传输保护。

| 使用场景                     | 默认原生优先的收益                     | 开启精确恢复的收益与代价                                   |
| ---------------------------- | -------------------------------------- | ---------------------------------------------------------- |
| 普通聊天、短任务             | 较少恢复状态和额外处理，沿用客户端习惯 | 收益可能有限，仍承担捕获与状态成本                         |
| 多轮编码、客户端已有良好摘要 | 减少代理改写历史，降低宿主适配复杂度   | 需要旧细节时有帮助，不保证每项任务都更省 token             |
| 长任务、多次压缩、核对旧数据 | 依赖摘要和原始文件，细节可能缺失       | 已捕获且有效的证据可精确读回；增加资源、请求、token 和等待 |
| 隐私或留存敏感任务           | 默认不为精确恢复额外保存原文           | 明确开启捕获，持久化另选，说明期限与覆盖边界               |

客户端自己的摘要也可能调用模型。默认原生优先不承诺压缩零费用或所有任务总费用更低，成本结论须由第 7 节对照验证。

### 1.2 首版不包含

- Magpie 的 `magpie1:`、配置、插件互通，以及新的账号绑定策略。
- 跨客户端、跨设备自动继续同一聊天，按文本相似度、账号或连接猜测同一分支。
- 强制 HTTP、全局关闭 WS，或自动修改用户模型、认证及客户端文件。
- 默认捕获原文但声称恢复关闭，或增强失败后静默降级并重放生成请求。
- 尚未选定的“恢复后固定增加一次独立公开生成请求”及实时流式方案。

## 2. 当前实现与证据基线

以下是本次文档编写时的静态快照，不是生产运行状态。实施前重新核对工作区和最新回执，不复用已变化源码的资格。

| 当前事实                                                                                               | 对方案的影响                                                            |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `contextRecoveryEnabled`、`contextRecoveryPersistenceEnabled`、`contextEvidenceEnabled` 默认均为 false | 复用已有设置；布尔默认关闭不证明全部主动规划和历史改写已经关闭          |
| 默认恢复 runtime 已有关闭状态延迟创建所有者的处理                                                      | 复用并验证所有入口，以及“持久化偏好 true、恢复 false”的组合             |
| WorkBuddy/Responses 转换有压缩桥、工作集规划、历史归档和预算重试                                       | 必须区分必要兼容与增强接管，不能统一当成主开关已覆盖                    |
| `contextWindowPolicy` 为 `overflow-drop-oldest`，供应方 context management 有 auto 配置                | 当前行为不完全等于目标默认；先核验生效路径和老配置依赖                  |
| 已有原文索引、内部读取、分支绑定、摘要回执、发布和存储事务                                             | 保留核心，不重建第二套恢复或存储系统                                    |
| 最新固定容量工具阶段完整客户端 956/956，范围门禁通过                                                   | 仅为对应冻结源码和工具回归证据，不是新默认策略或全部多端资格            |
| `npm run qualify:context-capacity` 五个画像均未通过，实际退出 1                                        | 工程测试通过与容量通过分别管理；不能把最长 24 小时 TTL 写成全天任务能力 |

容量历史负控出现来源数、累计调用、快照和读预算缺口；新候选四任务在第 65 轮 begin 的拒绝尚未细分，不能直接归因到某个单独配额。当前容量工具使用累计 Chat 历史、合成时钟和 JSON 重建，不包含原生压缩、真实传输、SQLite 或安装版客户端验收。

已有隔离安装版 Codex/Claude、包内执行、正常重开和部分提交后强杀证据，仍受各自版本和范围限制。最新 coverage/工具源码不能自动沿用旧包资格。真实模型、普通配置、IDE/Desktop/远端、完整并发/steering、迁移及完整回滚继续逐项验收。

主要定位：

- 配置及入口：[config.js](../lib/proxy/config.js)、[validator.js](../lib/proxy/validator.js)、[core-request-handler.js](../lib/proxy/core-request-handler.js)、[websocket-proxy.js](../lib/proxy/websocket-proxy.js)。
- 必要兼容与主动规划：[responses-to-chat-handler.js](../lib/proxy/handlers/responses-to-chat-handler.js)、[workbuddy-compaction-bridge.js](../lib/proxy/workbuddy-compaction-bridge.js)、[workbuddy-context-preparation.js](../lib/proxy/workbuddy-context-preparation.js)。
- 恢复核心：[context-recovery-runtime.js](../lib/proxy/context-recovery-runtime.js)、[context-recovery-protocol.js](../lib/proxy/context-recovery-protocol.js)、[context-recovery-coordinator.js](../lib/proxy/context-recovery-coordinator.js)。
- 前端：[configuration.js](../tauri-ui/src/app/models/configuration.js)、[app-settings-form.js](../tauri-ui/src/app/domains/app-settings-form.js)、[index.html](../tauri-ui/index.html)。
- 现状与证据：[实施状态](./context-recovery-implementation-status.md)、[容量工具回执](../.hpm-acceptance/context-recovery-capacity-workload-20261020-01/receipt.json)、[容量结果](../.hpm-acceptance/context-recovery-capacity-workload-20261020-01/qualification.json)。本地证据目录不保证随仓库分发。

## 3. 必要兼容与增强接管的边界

| 行为                                | 默认原生优先                           | 精确恢复开启                     | 约束                                         |
| ----------------------------------- | -------------------------------------- | -------------------------------- | -------------------------------------------- |
| 认证、校验、脱敏、原生状态目标隔离  | 保留                                   | 保留                             | 不受主开关控制                               |
| 窗口、输出预留、模型能力适配        | 保留已验证适配                         | 同左                             | 不伪报能力，不擅自改客户端文件               |
| 原生压缩端点、opaque 项             | 按受支持契约处理                       | 同左并观察关联                   | 不解码未知密文，不丢旧块造成功，不随意换目标 |
| 客户端主动摘要/trigger              | 兼容转发，必要转换时生成摘要           | 同左并维护恢复关联               | 不等于代理可在普通轮次主动摘要               |
| Responses/Chat/Messages/Gemini 转换 | 保留受支持子集                         | 同左                             | 保证工具配对，未知/签名形态不冒充支持        |
| 普通轮次主动摘要、归档、语义删改    | 默认不执行                             | 只在已授权、已验证路径按预算执行 | 不把字节变小当成语义等价                     |
| 机械规范化                          | 仅在契约允许且可证明语义等价时执行     | 同左                             | 不包括删工具结果、改指令或合并权限不同消息   |
| 超出实际输入/载荷预算               | 明确返回需要压缩或容量不足，保留原窗口 | 可尝试合格规划，失败仍保留原窗口 | 不假定客户端会自动响应错误并压缩             |
| 恢复原文捕获、索引、回执、私有历史  | 不执行                                 | 按分支、预算和期限执行           | 主开关实际控制这组能力                       |
| 内部 LIST/READ 及后续推理           | 不执行                                 | 有需要时执行                     | 不重放外部工具，费用完整计数                 |
| 恢复原文持久化                      | 不单独因保存偏好启动新捕获             | 持久化偏好独立选择               | 历史到期维护及显式清除另行管理               |
| 独立 evidence/MCP、审计、诊断       | 保持已有独立设置                       | 同左                             | 关闭精确恢复不代表其他记录服务全部关闭       |

WorkBuddy/WBIPC 的真实载荷限制不随模式消失。客户端窗口大于实际能力时，应核验能力配置能否让宿主及时压缩；不能表达或宿主不能处理时明确该组合限制，不隐藏开启主动摘要提高“兼容率”。

显式压缩需要的暂态缓冲或本地可信压缩容器可保留，但必须与自动恢复 ledger、权限和存储区分。其资源、到期、重启能力及费用独立描述，不能把主动归档改名为“适配”绕过开关。

## 4. 配置、有效状态与 UI

### 4.1 复用两项设置

首版不增加第三个用户模式开关，也不增加全局/路由/聊天三级覆盖。

| contextRecoveryEnabled | contextRecoveryPersistenceEnabled | 目标有效行为                                                         |
| ---------------------- | --------------------------------- | -------------------------------------------------------------------- |
| false                  | false                             | 原生优先，不为自动恢复创建 session、ledger、reader 或 storage worker |
| false                  | true                              | 原生优先，只记住保存偏好，不启动新的恢复捕获或授予读权               |
| true                   | false                             | 受支持、已授权且 ready 后启用内存恢复，重启后不假装原文仍在          |
| true                   | true                              | 加密存储 ready 后启用持久恢复；失败明确不可用，不偷偷退到内存        |

第二行的默认冷启动与保存偏好已完成专项验证。设置关闭与模式切换现已拆分停止准入和显式删除，冻结专项通过，完整客户端仍有一项启动期限取消；底层 session
configure(false) 仍保留显式删除契约。不能据此声称所有入口或生产历史保留目标均已验收。历史数据清理和管理面显式清除是独立的有界职责，可以维护原到期，但不能借此重新激活恢复权限或无限运行历史 worker。

`contextEvidenceEnabled`
保持独立，不被主开关改写。非法配置经 parse/coerce/validate 后明确拒绝，前后端规范一致；不能把字符串
`"false"` 当成 true、吞错误默认开启，或由旧版本保存时删掉不认识的新格式字段。

### 4.2 分开显示请求值与实际能力

状态应区分：用户请求值、当前有效能力、初始化/切换状态、当前请求或分支的覆盖范围。使用有限枚举及数字，不含原文、headers、密钥、工具参数和完整 locator。

原因至少覆盖未开启、路径不支持、等待存储、正在关闭、权限变化、留存不完整或待返回、预算不足、到期。字段名和错误码在 I1 冻结，优先复用已有状态。

沿用 branch coverage 的 `observed_calls_on_branch`
语义。`complete_for_observed_calls`
不能显示成“整个聊天完整”，开启设置也不等于当前客户端组合已经验收。

### 4.3 建议文案

- 主项：**启用精确上下文恢复**。为受支持路径保留经过代理的工具证据，压缩后按需读回；可能增加请求、token、延迟和资源使用。只覆盖实际捕获且仍有效的证据。
- 从项：**加密保存恢复数据**。保存在代理实际运行主机，用于重启后重新授权的读取；原到期不延长，受容量和路径资格限制。主项关闭时禁用编辑、保留偏好。
- 关闭：**优先使用客户端压缩与续接**。必要适配继续工作，超限且无法处理时明确失败。
- 清除独立展示，说明关闭不等于删除，删除不清除客户端聊天或审计。

产品说明不暴露内部模块及协议实现细节，只解释实际能力、费用、留存、限制和选择。

## 5. 切换、历史状态及迁移

### 5.1 开启和关闭

开启先校验配置、创建对应所有者、等待存储和 ready，再按当前授权准入。从开启后的请求捕获允许证据，不从旧摘要猜测原文、不自动扫描客户端磁盘历史。当前完整窗口中的工具结果也须满足既有归属及完成契约，不能把任意文本当成已执行结果。

关闭必须先停止新准入及在途读取权限，再等待有界清理确认。已接管的私有轮次取消或撤回未完成发布，不能半途将私有中间结果发给客户端；下一次普通请求使用默认路径，不重放外部工具。

关闭不删除尚未到期数据。清除走既有撤销/清理事务；再开启重新核验主体、目标、工具策略及分支，不能仅凭开关恢复权限。原 TTL、累计调用和读预算不重置。

### 5.2 内存/持久化切换

设置关闭和模式切换使用 suspend、shutdown、ready 和提交确认边界，显式清除继续使用 revoke。首版不承诺内存历史自动迁到磁盘或反向搬运；需要迁移时另做版本化事务。初始化失败不隐式改为内存，不换目录继续写，不向外泄露原异常。

### 5.3 升级和旧聊天

当前源已实现的版本契约：字段 `appSettings.contextPolicyVersion`
只接受数值 1/2，缺字段解释为 1；新版本普通保存不得把已有 2 降为 1 或删除字段，未知版本不被覆盖。版本 2 已接入部分请求规划，但
`plannerApplication:unverified` 继续明示完整资格未完成。`runtimeApplication`
只报告进程配置与真实共享规划选项的观察结果，不代替完整请求路径或安装客户端资格。显式迁移先只读预览，再携带精确修订号应用；保留已保存的恢复与留存偏好，说明依赖旧证据的聊天连续性限制。候选源码的新默认已设为 2，旧文件仍保留 1；尚未发布或切换生产，没有新增第三个用户模式开关。

- 新配置默认原生优先，两个开关 false；尊重老配置显式开启的选择，不强行关闭或重新授权。
- 老配置缺字段，以及 false 但依赖既有自动裁剪/WorkBuddy 主动摘要的用户，不能被推断为已经选择新语义。I1 冻结配置版本及迁移规则。
- 优先复用已有配置版本机制；若无法区分，增加最小序列化迁移标记，名称在 I1 冻结。它不是新用户开关。旧配置先保留旧语义，明确应用新策略后迁移；管理面如实显示尚未迁移。
- 不自动改 `contextWindowPolicy`、供应方 context
  management、模型、认证或客户端文件。机械迁移与行为变更分开评审。
- 旧聊天携带 HPM 容器时继续严格校验。能独立处理的兼容容器保留；关闭增强不授予其证据读权。不支持/到期状态明确返回，不能当明文或直接丢掉。
- 若旧容器必须依赖增强才能解释，该组合迁移前必须标注不能连续切换；不能自动重新开启增强。旧聊天连续性是基础发布门禁。
- 存储格式及回滚保留版本保护。旧包不得写不认识的新格式，不删除字段伪装降级；保留原到期与撤销状态。

## 6. 模块职责与失败原则

### 6.1 统一策略决策

引入或复用纯策略模块，接收已校验配置、受信能力和配置版本，输出不可变决策，具体文件名在 I1 冻结。主入口只组合依赖，不能由 HTTP、WS、转换 handler 和 UI 各自解释
`enabled`。

决策区分必要兼容、客户端主动压缩、代理主动规划、原文捕获、内部读取、持久化偏好及实际状态。策略模块无网络和存储副作用；协议适配不授予恢复权限；lifecycle 管理 ready/撤权/资源；现有 branch/ledger/history 核心管理可见性、预算及发布。

默认冷路径不实例化自动恢复 session/ledger/reader/SQLite
worker，不因精确恢复增加模型请求或摘要回执。必要适配自己的缓冲及容器独立计数；独立开启的审计/evidence 服务可继续，但须可区分。不能以“开关关闭”掩盖其资源或留存。

### 6.2 失败不冒充成功

- 压缩项或摘要必须完整、合法且成功发布后才可作为新窗口，空、截断、取消或非法混合输出不算成功。
- 提示识别只是分类，不是授权。仍需已观察历史、唯一祖先及完整策略校验。
- 默认超限保持协议正确、固定脱敏的失败，不丢历史、不吞异常、不改成功状态。
- 增强捕获不足报告观察范围内覆盖缺口，不无声驱逐有效原文。普通生成是否继续沿用既有契约；要求读取缺失证据时明确不可用，不猜测或重放。
- 已接管的私有流程失败不自动切默认路径重发同一生成。未接管普通请求与已接管事务分别处理。
- 在既有精确输入退避之外，补可信会话/目标/摘要模型级连续失败冷却，覆盖历史变化、并发共享、成功复位、鉴权变化和单次恢复探测。
- 保留 WS，不复制 Magpie 的强制 HTTP 回退。cache
  miss、完整窗口补发及错误按 lane/状态/宿主能力验证，未支持形态保留在矩阵中。

## 7. 成本、质量与容量验收

### 7.1 对照设计

固定客户端版本、配置、目标模型、认证、传输、输入和答案，对照原生优先与增强。先用脚本上游验证调用和状态差异，再在对应授权范围做有界真实模型验收；实际尝试数与逻辑请求数分开记录。交替多样本，区分冷启动、首次转换、稳定请求和恢复发生时的成本。

| 指标       | 默认路径硬门禁或报告                                       | 增强比较                                                      |
| ---------- | ---------------------------------------------------------- | ------------------------------------------------------------- |
| 恢复副作用 | 自动恢复额外模型请求、捕获和私有调用均为 0；客户端摘要单列 | 内部读取、继续推理、失败、重试及取消全部计数                  |
| token/费用 | 正常生成、客户端摘要、缓存及必要适配分别计量               | 加上重读、失败摘要和重新探索；估算与真实费用区分              |
| 延迟       | 冷启动/首字节/总耗时，样本数及 p50/p95                     | 恢复首次读回及完成耗时；缓冲不冒称实时流式                    |
| 资源       | 模块图、RSS、worker/句柄、恢复库新增写入                   | 内存峰值、实际磁盘量、清理和重开成本                          |
| 正确性     | 压缩后任务可继续、约束保留、外部工具不重复                 | 固定旧 sourceId 首/中/末精确读取，修订/撤销保留且最终答案正确 |
| 覆盖与失败 | 不假称精确恢复，超限可诊断                                 | 缺失/待返回、到期、撤权和满额明确，重启不退款                 |

性能预算在 I0 基线后、修改前冻结。零增强副作用是确定性门禁；延迟或吞吐收益由实测决定，不承诺“零开销”或未经测量的降幅。

### 7.2 容量作为独立阻塞

容量设计沿用[完整方案的容量章节](./context-recovery-multi-client-plan.md)，不建立第二份存储设计：原文 blob 与 root 分离、引用原子提交、累计调用/快照、分层读预算、迁移/撤销/回收和资源上限同步处理。

使用正式 `npm run qualify:context-capacity`
的五个版本化画像，保留四任务各 8 小时/480 次调用、32
KiB 原文、100 次恢复的工程候选。它不是已达能力或已获用户认可的容量承诺；I0 复核实际日常需求和主机预算。画像变更须有明确版本和理由，不缩小负载凑绿。

容量命令退出 0 才表示其合成画像达标；1 表示不达标，2 表示执行错误。即使合成通过，仍补真实压缩、传输、SQLite、宿主及资源验证，不能互相替代。保留最后结果排空、逐页验证、首/中/末来源和重开后对照，不重启清账或延长 TTL。

## 8. 迭代计划

不承诺未经测量的日历工期，以可复查代码和退出证据排期。S/M/L 表示单一边界、多入口、跨状态/存储或实际宿主验证的相对规模。计划不等于实施授权扩大到生产激活。

| 迭代                  | 状态/规模                     | 交付物                                                                               | 依赖与退出条件                                                                            |
| --------------------- | ----------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| I0 基线及盘点         | 已有隔离基线，组合待封存 / M   | 各入口主动摘要/裁剪/捕获调用清单，配置版本与旧容器依赖，性能预算、首发矩阵及容量画像 | 已有调用链、画像及隔离基线；真实安装版组合与最终基线仍待封存                              |
| I1 策略与迁移契约     | 候选已实现，迁移资格待验 / M   | 纯策略模块，两布尔组合、配置迁移、有效状态和原因码                                   | I0；正常/空/非法/极端/安全/失败均回归，前后端一致，旧设置不静默改写                       |
| I2 默认请求路径       | 候选已实现，完整组合待验 / L   | 按策略阻止普通轮次主动接管，保留显式压缩与必要适配，WorkBuddy 超限反馈               | I1；首发入口 0 自动恢复请求/捕获/私有调用/新存储；压缩/超限负控先失败后通过，WS 不降级    |
| I3 增强切换及旧状态   | 候选已实现，重开及迁移待验 / L | 统一准入/撤权、存储偏好联动、在途切换、旧聊天处理                                    | I1；与 I2 合并前验证 HTTP/WS 取消、初始化失败、开关并发、关闭重开及旧权限不复活           |
| I4 UI、诊断与费用控制 | 候选已实现，完整资格待验 / M   | 主/从开关、实际状态、coverage/超限提示、安全数字指标、会话级失败冷却                 | I2/I3 契约稳定；状态真实、键盘和标签可用，变化输入失败风暴有上游计数证据                  |
| I5 完整资格及交付     | 进行中，完整门禁未通过 / L     | 全量门禁、隔离包/包内验证、两种行为的安装版矩阵、成本对照与回滚                      | I2–I4；同一冻结源码按第 9 节验收，基础和增强资格分别封存                                  |
| H1 增强容量闭环       | 功能预算通过，性能及完整资格待验 / L | 按既有方案完成 blob/引用、调用快照、读预算和容量画像                               | 设计可独立推进，与 I3/I5 在格式和发布汇合；容量、崩溃、撤销、迁移和资源通过前不称全天可用 |

2026-10-22 补充：按用户批准的 180000ms 功能执行预算，冻结 v13 的原容量文件在完整 verify 的 unit 阶段通过 10/10，零失败或跳过；容量命令用时 75500.6162ms，文件总用时 83509.7459ms。原 60000ms 性能目标未达，继续单独跟踪，不因功能预算通过而关闭。证据为 `candidate-full-verify-v13.log` 中的 `capacity-command` 及紧随其后的原测试汇总。该次完整 verify 因另一测试文件失败终态退出 1，后续客户端等阶段未执行；因此此处不授予完整容量、最终安装版或全天活跃任务资格。下述早期容量失败记录作为历史保留。

本表于 2026-10-21 按候选实现与交付资格分别更新，退出条件保持原要求。最新运行结果以[实施状态](./context-recovery-implementation-status.md)和其绑定回执为准：Claude 已通过此前源码快照的实际 Core handler 隔离完整真实任务；Codex 已通过当前 1507 文件冻结源码的实际 Core 隔离完整真实任务，14 次真实请求完成三次压缩、精确读回和独立公开生成。两者的入口认证和路由均由 fixture 注入，Codex 该真实任务的官方认证在出口桥接完成。当前源码另已通过两端默认/增强四组原生合成预演，各三次压缩；默认恢复准入、root、snapshot 均为 0。Codex 两组预演在 Core 内实际只读解析当前官方凭据，真实认证头在发往合成上游前替换；尚未证明该凭据路径与真实模型在同一任务中的完整组合。四组矩阵回执为 `native-current-matrix-v1-outcome.json`。这些结果均不等于日常安装版、自动 Hook、跨设备或生产资格。24h 单样本到期拒读不等于全天活跃任务容量。

此前冻结版本的完整客户端为 1358 项中 1357 通过、容量原 60000ms 失败；此前字面 verify 退出 1，完整 unit 670 文件中 669 通过，仅容量文件失败。当前缓存分层修复后，原容量文件无覆盖率独立运行 10/10 通过；当前完整 verify 会话 14146 已终态退出 1，四分片全部结束，670 文件中 668 通过，WBIPC 请求超时和容量原 60000ms 超时两文件失败。当前代理覆盖率达到阈值，独立安全覆盖率通过，但不扩展为完整门禁通过。WBIPC 原失败用例随后独立带覆盖率通过；原容量文件独立带覆盖率仍超时，说明尚需覆盖率环境的性能余量。发布 staging 曾刷新并核对相关源码摘要，当前候选仍需最终源码、包内运行和完整交付证据绑定。

顺序：I0 → I1 → I2 → I3 → I4 →
I5。H1 不阻止基础路径取得独立资格，但阻止“增强已支持全天任务”和完整恢复目标关闭。资源不足时缩小实际发布的客户端组合并说明，不删用例或把未验收格子标通过。

当前补充交付证据：Codex 同一脚本与原文、同一客户端输入的默认/增强四轮交替合成对照共八任务通过，调用数固定 6/13；仅证明脚本上游的调用与本地处理开销，不证明真实费用或质量。当前 staging 已按缓存分层修复刷新，625 份发布源码与当前字节一致，使用包内 Node 执行 root-state/history-map/binding 三文件 136/136 通过。详见实施状态中的 `codex-controlled-cost-v2-receipt.json` 与 `current-freeze-staging-v1-receipt.json`；不能替代完整 verify、MSI/portable 安装、两端真实费用、默认冷实例化及生产资格。

随后当前包内 Node/Core 的 Codex、Claude 默认/增强四组原生合成任务全部通过，各三次压缩，工作区代理模块回落加载为 0；回执 `packaged-native-matrix-v1-outcome.json`。临时配置、注入认证/路由和合成上游的边界保持，I5 不因包内矩阵通过而关闭。指纹融合性能投影在正反完整负载中均退步，未进入产品；H1 原 60s 门禁继续未过。

每轮保留范围、行为前后差异、负控/回归、门禁命令结果、冻结源码摘要和限制；相关修改分批交付，不提交无关脏文件。打包轮次额外绑定实际包内 Node、依赖和运行源摘要；真实请求记录尝试数，不落用户原文或凭据。不能累加不同源码的历史通过数冒充同一候选通过。

## 9. 验收矩阵及发布

### 9.1 必测场景

| 编号 | 场景                                | 关键断言                                                   |
| ---- | ----------------------------------- | ---------------------------------------------------------- |
| N01  | 新装、缺字段、老配置                | 新默认明确，旧配置版本可识别，不把 false 当成已迁移        |
| N02  | 四组合、非法配置、初始化失败        | 无读权旁路，关闭时持久化偏好不启动新捕获，不隐式改存储模式 |
| N03  | Codex 原生端点、trigger、本地摘要   | 完整响应后采用，不误判普通请求，必要适配及 opaque 保真     |
| N04  | Claude 摘要和缓存标记               | 身份投影窄化；默认无恢复回执，增强关联不跨分支             |
| N05  | Chat/Messages/Responses/Gemini 转换 | 子集明确，工具配对；签名/opaque/媒体不假称通用支持         |
| N06  | WorkBuddy 实际载荷                  | 默认不偷偷主动压缩；客户端处理或明确失败，增强规划独立验证 |
| N07  | HTTP JSON/SSE、WS 重连/cache miss   | 协议/lane 错误保真；取消不泄漏私有结果，不强制 HTTP        |
| N08  | 在途关闭、反复切换、目标/权限变更   | 新准入立即停，事务撤回，不重放工具、不重置期限或预算       |
| N09  | 旧容器、重开、强杀、撤销/清除       | 不丢状态假成功，不从备份或开关复活读权，拒写/回滚成立      |
| N10  | 满额、过期、缺失、失败风暴          | coverage 诚实，不无声驱逐，调用有界且日志安全              |
| N11  | 连续压缩及最终任务                  | 关键要求和撤销关系保留，固定旧原文读回，最终任务正确       |

首发优先 Windows 单代理 Codex CLI 与 Claude
Code。IDE/Desktop、WSL/SSH/容器/云主机、跨设备各自单验收。每格记录客户端版本、实际执行主机、认证、入口/传输、上游类型、压缩形态、持久化方式和证据来源。

### 9.2 工程门禁

代码修改补回归并进入统一 unit 和相关 client/frontend 入口。生产非平凡逻辑独立可测，不新增显式 any，不把业务堆在入口；直接使用的依赖直接声明，优先复用现有模块。

按风险执行格式、语法、Lint、类型（如适用）、专项/扩大/完整客户端、前端及原生检查；交付候选运行字面
`npm run verify`
和声明的安全/发布门禁。脚本以当时 package.json 与 CI 为准，没有配置的类型检查不记通过，临时探针不代替统一 CI。

不降阈值、不改历史语料摘要凑绿、不延长原期限、不跳测试或吞异常。包内执行、安装版脚本上游、真实模型、生产是不同资格。实际模型和共享服务变更遵守对应范围，不因写入本计划自动执行。

### 9.3 发布与回滚

先冻结候选、隔离包和包内验证，再建立实际安装版及有界真实模型资格，最后受控应用生产。本次文档交付不包含生产应用。

原生优先可独立取得基础发布资格，但必须证明旧配置/容器连续性不被破坏，并标明增强仍关闭、实验或受限。增强开放需有自己的组合、容量、存储格式及回滚资格；基础上线不代表完整恢复目标完成。

回滚先停新增强准入并清理在途事务，保留尚未到期存储。旧包不写未知格式，旧配置恢复不自动重开撤权 scope。无法安全读新格式时关闭恢复并保留数据，走独立验证的迁移或清除，不删字段或旧压缩块伪造兼容。

## 10. 文档维护及参考

- 本文负责默认策略、开关语义和迭代；[多端完整方案](./context-recovery-multi-client-plan.md)负责恢复核心和容量设计。
- 旧完整方案的“自动恢复”目标只对增强开启且准入的路径适用，历史回执不重写。
- 每轮实际完成后先在[实施状态](./context-recovery-implementation-status.md)记录源码/验证范围，再更新迭代状态；计划不是实现或发布证据。

Magpie 参考快照为
[`588f87a126834c2ed1c6348a35c6f031924c1855`](https://github.com/yetone/magpie/tree/588f87a126834c2ed1c6348a35c6f031924c1855)：[能力配置](https://github.com/yetone/magpie/blob/588f87a126834c2ed1c6348a35c6f031924c1855/internal/agent/agents.go)、[摘要识别](https://github.com/yetone/magpie/blob/588f87a126834c2ed1c6348a35c6f031924c1855/internal/gateway/compacting.go)、[失败冷却](https://github.com/yetone/magpie/blob/588f87a126834c2ed1c6348a35c6f031924c1855/internal/gateway/codex_compact_guard.go)、[成本回放](https://github.com/yetone/magpie/blob/588f87a126834c2ed1c6348a35c6f031924c1855/internal/tune/tune.go)。借鉴其职责和观测方式，不把版本特定行为视为所有客户端契约。
