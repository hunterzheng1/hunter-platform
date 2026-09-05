// 全局临时目录兜底：测试大量使用 mkdtemp(join(tmpdir(), "hunter-*")) 且不清理，
// 曾泄漏 >100GB 到系统 Temp。这里为每次 vitest 运行创建专属临时根目录，并通过
// TMPDIR/TMP/TEMP 让 os.tmpdir()（含 fork worker 与测试内 spawn 的子进程）指向它，
// 运行结束后整树删除，测试本身无需再各自注册清理。
//
// 事务恢复存储是同一问题的漏网之鱼：resolveRecoveryRoot() 默认落到
// %LOCALAPPDATA%/HunterHarness/recovery（与 Hunter-Harness 共用同一路径），
// 每个写事务都会往那里留一份 durable 副本且从不回收。Hunter-Harness 侧实测 18 天
// 堆出 187 万文件 / 37.7GB，并让每次 CLI 启动多花十几秒遍历索引。
// HUNTER_HARNESS_RECOVERY_ROOT 一并指进临时根，随 teardown 消失。
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveRecoveryRoot } from "../../packages/core/src/transaction/recovery-store.js";

const ROOT_PREFIX = "hunter-vitest-";
const STALE_MS = 24 * 60 * 60 * 1000;
const OWNER_MARKER = "owner.json";

let tempRoot: string | undefined;
let realRecoveryBaseline: { path: string; count: number } | undefined;

/** 真实恢复存储的索引条目数；用于在 teardown 时发现泄漏。 */
async function countRecoveryIndexEntries(root: string): Promise<number> {
  try {
    return (await readdir(join(root, "recoveries", ".index"))).length;
  } catch {
    return 0;
  }
}

/** Windows 上句柄释放可能滞后（guardian/子进程退出竞态），分几波耐心重试。 */
async function rmWithPatience(path: string): Promise<void> {
  const waves = [0, 2_000, 5_000];
  let lastError: unknown;
  for (const delay of waves) {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Windows 下存但无权限也返回 EPERM；只有 ESRCH 才确定不存在。
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 读根目录的 ownership 标记；强杀等异常退出可能没写成，返回 null 走年龄规则。 */
async function readOwnerMarker(root: string): Promise<{ pid: number } | null> {
  try {
    const parsed = JSON.parse(await readFile(join(root, OWNER_MARKER), "utf8")) as { pid?: unknown };
    return typeof parsed.pid === "number" ? { pid: parsed.pid } : null;
  } catch {
    return null;
  }
}

/**
 * 进程被强杀时 teardown 不执行，这里清扫上次运行残留的陈旧根目录。
 * 满负载下 teardown 可能因 guardian 句柄释放慢而 EBUSY 留下整树（曾一次
 * 累积 33 个）：带 owner 标记且创建进程已退出的根目录立即清扫，不再等
 * 24h；标记缺失或 PID 仍存活（可能是并行运行中的 vitest）按年龄规则兜底。
 */
async function sweepStaleRoots(base: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(base);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of entries) {
    if (!name.startsWith(ROOT_PREFIX)) continue;
    const candidate = join(base, name);
    try {
      const info = await stat(candidate);
      if (!info.isDirectory()) continue;
      const owner = await readOwnerMarker(candidate);
      const abandoned = owner !== null && !isPidAlive(owner.pid);
      if (!abandoned && now - info.mtimeMs < STALE_MS) continue;
      await rmWithPatience(candidate);
    } catch {
      // 可能被并行运行的 vitest 占用，留给下次清扫
    }
  }
}

export async function setup(): Promise<void> {
  // 必须在覆盖 HUNTER_HARNESS_RECOVERY_ROOT 之前取真实路径，否则量到的是临时根。
  const realRecoveryRoot = resolveRecoveryRoot(process.env);
  realRecoveryBaseline = {
    path: realRecoveryRoot,
    count: await countRecoveryIndexEntries(realRecoveryRoot)
  };
  await sweepStaleRoots(tmpdir());
  tempRoot = await mkdtemp(join(tmpdir(), ROOT_PREFIX));
  // ownership 标记：teardown EBUSY 失败时，下一次运行凭"PID 已死"立即清扫。
  await writeFile(join(tempRoot, OWNER_MARKER), JSON.stringify({
    pid: process.pid,
    created_at: new Date().toISOString()
  }), "utf8");
  process.env["TMPDIR"] = tempRoot;
  process.env["TMP"] = tempRoot;
  process.env["TEMP"] = tempRoot;
  process.env["HUNTER_HARNESS_RECOVERY_ROOT"] = join(tempRoot, "recovery");
}

export async function teardown(): Promise<void> {
  // 泄漏守卫：重定向只作用于 process.env，注入了精简 env 的用例仍会让
  // resolveRecoveryRoot 回退到真实目录。靠人记得不可靠，这里让它自己喊出来。
  if (realRecoveryBaseline !== undefined) {
    const after = await countRecoveryIndexEntries(realRecoveryBaseline.path);
    const leaked = after - realRecoveryBaseline.count;
    if (leaked > 0) {
      console.warn(
        `[global-temp] 本次测试向真实恢复存储写入了 ${leaked} 个条目：` +
        `${realRecoveryBaseline.path}\n` +
        "  常见原因：某个用例注入了精简 env 却没带 HUNTER_HARNESS_RECOVERY_ROOT。"
      );
    }
  }
  if (tempRoot === undefined) return;
  try {
    // Windows 上文件可能被杀毒/索引/guardian 退出竞态短暂占用，分波重试提高
    // 删除成功率；仍失败则留下 owner 标记，下一次运行 sweepStaleRoots 立即清扫。
    await rmWithPatience(tempRoot);
  } catch (error) {
    console.warn(`[global-temp] 未能删除临时根目录 ${tempRoot}:`, error);
  }
}
