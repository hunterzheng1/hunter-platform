# Phase 1 redacted diagnostic bundle and Secret canary

- 日期：2026-07-24
- 平台：Windows `10.0.26200`
- 分支：`codex/phase1-diagnostic-bundle`
- 基线：`main@142d3050e5ddf1bac0c2ca6172da8fbf9e215093`
- 证据范围：`contract_only`

## 实现边界

- `@hunter/policy` 提供 schema v1 的递归诊断脱敏 API；只接受 JSON-like plain
  object、array、有限 number、boolean、string 和 null；
- 注册 Secret、Authorization、Cookie、常见 API key/token/password、Prompt
  字段和 Windows/UNC/Linux 私有绝对路径被替换为固定占位符；结构化 JSON
  日志中的 credential key 同样处理；
- 循环引用、未知 prototype、accessor、symbol key、binary/typed array、非 JSON
  值、敏感 key、超深对象、超大字段/集合/总节点/总字节均 fail closed；硬上限
  只能收紧，不能由调用方调大；
- daemon 只接受四类 source-specific strict allowlist summary：`database`、
  `logs`、`exports`、`prompts`；每项只发布 count、闭集 error code、受限
  redacted summary、byte count 和 SHA-256；
- Prompt summary 只允许固定 health/count，不接受自由文本；即使 Prompt 没有
  注册成 Secret，也会在 schema 边界被拒绝；
- bundle schema 固定为 v1，source 顺序、error code 顺序和对象 key canonical；
  相同输入生成相同字节和 fingerprint；
- bundle 默认排除 credentials、完整 environment、raw Agent events、source code
  和 SQLite；公共输入不存在任意文件采集或目录遍历能力；
- bundle 返回前与验证脚本写入后均执行逐字节扫描。验证脚本只在自动创建并最终
  清理的临时目录生成输出，不读取真实凭据、完整环境变量、用户 Prompt 或源码。

本批没有增加上传、发送、遥测、远端诊断、SQLite 导出或任意文件打包能力。

## RED → GREEN 记录

1. 首个 Policy 精确测试在 collection 阶段真实失败：
   `Cannot find module './redaction.js'`。
2. 最小字符串脱敏实现令首测 1/1 通过；加入 fail-closed 矩阵后 5 项真实失败：
   unknown object、binary、超大 string/collection 没有拒绝，循环引用只产生
   `Maximum call stack size exceeded`。
3. 增加 plain-object、size/depth、binary 和 ancestor 校验后 Policy 6/6 通过。
4. 首个 daemon 测试在 collection 阶段真实失败：
   `Cannot find module '../src/services/diagnostic-bundle.js'`。
5. 最小 bundle 实现后 canary 已从字节中移除，但通用扫描器仍报
   `DIAGNOSTIC_SENSITIVE_MATERIAL_DETECTED`；细分无敏感内容的固定错误后定位为
   `PATTERN_2`，原因是 Cookie 正则可回溯空白并误报 `[REDACTED]`。修正负向判断
   后两个 seam 合计 7/7 通过。
6. 根 `verify:diagnostics` 首次真实失败，因为验证脚本尚不存在；实现脚本后再次
   失败，原因是 standalone 运行解析到旧 `@hunter/policy/dist`，缺少新导出。
7. 让验证命令先构建 Policy project reference 后，strict TypeScript 真实暴露
   optional limit 与 readonly counter 共 17 个错误；修正类型后命令转为 PASS。
8. 通用绝对路径测试先暴露非用户目录、UNC、正斜杠 Windows 与单段 Unix
   路径漏口；补齐 redactor/scanner 后转为 GREEN。
9. accessor/symbol/sensitive key 测试分别证明 getter 会被执行或 key 会漏出；
   改为读取 descriptor 前置拒绝和敏感 key fail closed。
10. 独立审查的 allowlist/资源 RED 首次得到 4 个真实失败：任意 summary、
    无界 error code、总节点和总字节均未拒绝；随后冻结 source-specific schema、
    闭集 error code 与不可调高的总量上限。
11. 输出 schema mismatch、超长 metadata/timestamp、locale-dependent key sort、
    JSON structured credential、scanner 输入预分配和未登记 Prompt 文本均先由
    反例复现，再分别收紧为判别联合、语义格式/长度、code-unit sort、统一脱敏、
    cheap guard 和 Prompt 无自由文本。

所有失败历史保留；没有把缺失脚本、误报或编译失败改写为 PASS。

## Secret canary 演练

`npm run verify:diagnostics` 在临时 fixture 中向 database/log/export/prompt 四类
输入注入 synthetic token、cookie、API key、Prompt 和私有 Windows 路径。
它扫描四个脱敏输出与最终 bundle 共五个文件，并输出：

```json
{"status":"PASS","schemaVersion":1,"sourceCount":4,"scannedOutputCount":5,"byteCount":1573,"contentFingerprint":"a9d75119968bbed59fc05881bd6abed59829e807acab884642ca8df63ce8e95b","redaction":{"schemaVersion":1,"replacementCount":7},"excludedByDefault":["credentials","environment","raw_agent_events","source_code","sqlite"]}
```

该输出不包含 canary、临时绝对路径、环境变量、凭据或私有 Prompt。

## 本机验证

| 命令 | 结果 |
|---|---|
| `npm install` | PASS；up to date，620 packages；摘要仍为 3 high severity，未推断生产可利用性 |
| `npx vitest run packages/policy/src/redaction.test.ts apps/daemon/test/diagnostic-bundle.test.ts` | PASS；2 files / 23 tests |
| `npm run verify:diagnostics` | PASS；4 source summaries / 5 scanned outputs / 7 replacements；未登记 Prompt 文本被拒绝 |
| `npm run lint` | PASS |
| `npm run typecheck` | PASS |
| `npm test` | PASS；108 files / 955 tests |
| `npm run verify:rebuild` | PASS；3 events |
| `npm run verify:recovery` | PASS；receipt `e73ee7cafb4eb14e249bf8fb35b8adc3a8779983783479a56344ff6cbdaf1b78` |
| `npm run verify:backup-restore` | PASS；Archive/Knowledge/Artifact/Evidence 对账均为 1 |
| `npm run build` | PASS |
| `npm run verify:foundation` | PASS；包含 diagnostics gate |

`git diff --check` 将在提交前运行。PR head GitHub Actions 尚未运行，因此远端
Windows/Ubuntu CI 为 `PENDING`，不能继承 PR #9 或旧 SHA 的结论。

## 结论边界

- 本证据证明 Hunter 的 redaction/diagnostic bundle 契约和 synthetic canary
  fixture，不证明真实生产数据库、真实 Agent 日志、真实用户 Prompt 或用户导出
  已完成全量扫描；
- 真实 Provider 状态未改变，仍为 `NOT_PROVEN`；Fake Runtime 仍只证明
  `CONTRACT_ONLY`；
- 未执行上传、遥测、生产 Provider、真实设备、签名、分发或发布。
