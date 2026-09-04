// guardian 类测试（private-directory-authority / *-local-cas）在 Windows 上按
// 路径冷启动 powershell.exe 守护进程。满负载下单次冷启动实测 13-20s，而
// powershell 进程启动的磁盘成本（可执行镜像 + .NET 程序集）在首次之后会命中
// OS 文件缓存。这里在 worker fork 之前完成一次完整启动，把首次成本移出测试
// 计时。best-effort：失败不阻断测试运行；超时预算的主防线是各测试文件的
// vi.setConfig（见 private-directory-authority.test.ts 等）。
import { spawn } from "node:child_process";

export default async function warmupPowershell(): Promise<void> {
  if (process.platform !== "win32") return;
  await new Promise<void>((resolve) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "[void][System.Environment]::OSVersion; exit 0"],
      { windowsHide: true, stdio: "ignore", timeout: 60_000 },
    );
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
}
