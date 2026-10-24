# 上下文恢复换机交接

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
