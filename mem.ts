import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { exec } from "node:child_process";
import { basename } from "node:path";
import { buildTopLines, autoClearWidget, formatBytes } from "./util";

// ============================================================
// Memory Monitor — cross-platform (macOS + Windows)
// ============================================================

interface ProcEntry {
  pid: number;
  rss: number;
  name: string;
}

export interface MemoryMonitor {
  start(): Promise<void>;
  stop(): void;
  showTop(ctx: ExtensionContext, widgetKey: string, limit: number): Promise<void>;
}

/**
 * Platform-dispatching factory. macOS delegates to vm_stat + sysctl + ps;
 * Windows delegates to PowerShell + Get-CimInstance + Get-Process.
 */
export function createMemoryMonitor(opts: {
  onUpdate: (text: string) => void;
  intervalMs?: number;
  /** Optional colorization hook; receives percent 0-100, returns ANSI-styled text. */
  colorize?: (displayText: string, percent: number) => string;
}): MemoryMonitor {
  return process.platform === "win32"
    ? createWinMemoryMonitor(opts)
    : createMacMemoryMonitor(opts);
}

// ============================================================
// macOS implementation (unchanged)
// ============================================================

interface VmStats {
  pageSize: number;
  active: number;
  wired: number;
  compressorOccupied: number;
}

let cachedTotal = 0;

function getTotalMemory(): Promise<number> {
  if (cachedTotal > 0) return Promise.resolve(cachedTotal);
  return new Promise((resolve) => {
    exec("sysctl -n hw.memsize", { encoding: "utf8", timeout: 2000 }, (err, stdout) => {
      const v = err || !stdout ? 0 : parseInt(stdout.trim(), 10);
      if (v > 0) cachedTotal = v;
      resolve(v);
    });
  });
}

function getVmStats(): Promise<VmStats | null> {
  return new Promise((resolve) => {
    exec("vm_stat", { encoding: "utf8", timeout: 3000 }, (err, raw) => {
      if (err || !raw) { resolve(null); return; }
      const psMatch = raw.match(/page size of (\d+) bytes/);
      const pageSize = psMatch ? parseInt(psMatch[1], 10) : 16384;
      const grab = (key: string): number => {
        const m = raw.match(new RegExp(`${key}:\\s+(\\d+)`));
        return m ? parseInt(m[1], 10) : 0;
      };
      resolve({
        pageSize,
        active: grab("Pages active"),
        wired: grab("Pages wired down"),
        compressorOccupied: grab("Pages occupied by compressor"),
      });
    });
  });
}

function getMacTopProcesses(limit: number): Promise<ProcEntry[]> {
  return new Promise((resolve) => {
    exec(
      "ps -axo pid,rss,comm",
      { encoding: "utf8", timeout: 5000 },
      (err, raw) => {
        if (err || !raw) { resolve([]); return; }
        const lines = raw.trim().split("\n").slice(1);
        const procs: ProcEntry[] = [];
        for (const line of lines) {
          const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
          if (!m) continue;
          const pid = parseInt(m[1], 10);
          const rssKB = parseInt(m[2], 10);
          if (isNaN(pid) || isNaN(rssKB) || rssKB <= 0) continue;
          procs.push({ pid, rss: rssKB * 1024, name: basename(m[3].trim()) });
        }
        procs.sort((a, b) => b.rss - a.rss);
        resolve(procs.slice(0, limit));
      },
    );
  });
}

function createMacMemoryMonitor(opts: {
  onUpdate: (text: string) => void;
  intervalMs?: number;
  colorize?: (displayText: string, percent: number) => string;
}): MemoryMonitor {
  const intervalMs = opts.intervalMs ?? 5000;
  let interval: ReturnType<typeof setInterval> | null = null;
  let ticking = false;

  async function pollOnce() {
    if (ticking) return;
    ticking = true;
    try {
      const total = await getTotalMemory();
      const stats = await getVmStats();
      if (!total || !stats) return;

      const used =
        (stats.active + stats.wired + stats.compressorOccupied) *
        stats.pageSize;
      const pct = (used / total) * 100;
      const plain = `RAM ${formatBytes(used)}/${formatBytes(total)} (${pct.toFixed(0)}%)`;
      opts.onUpdate(opts.colorize ? opts.colorize(plain, pct) : plain);
    } finally {
      ticking = false;
    }
  }

  return {
    async start() {
      if (interval) return;
      await pollOnce();
      interval = setInterval(pollOnce, intervalMs);
    },
    stop() {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      opts.onUpdate("");
    },
    async showTop(ctx, widgetKey, limit) {
      try {
        ctx.ui.notify("Querying processes ...", "info");
        const top = await getMacTopProcesses(limit);
        if (top.length === 0) {
          ctx.ui.notify("Failed to enumerate processes.", "warning");
          return;
        }
        const lines = buildTopLines(
          `Top ${top.length} processes by memory (RSS):`,
          top.map((p) => ({
            name: p.name,
            pid: p.pid,
            val1: formatBytes(p.rss),
            val2: "",
          })),
          "RSS",
          "",
        );
        ctx.ui.setWidget(widgetKey, lines);
        autoClearWidget(ctx, widgetKey);
      } catch (e: any) {
        ctx.ui.notify(`mem-top: ${e.message || "unknown"}`, "error");
      }
    },
  };
}

// ============================================================
// Windows implementation
// ============================================================
//
// All shell calls go through `powershell -NoProfile -Command ...`:
//   - total RAM:   (Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory
//                  Returns bytes.
//   - used / free: Win32_OperatingSystem TotalVisibleMemorySize - FreePhysicalMemory
//                  Returns KB -> multiply by 1024 to get bytes.
//   - top procs:   Get-Process | Sort WS -Desc | Select -First N | ConvertTo-Json -Compress
//                  WS (Working Set) is in bytes.
//
// PowerShell cold-start is ~300-600ms; we keep polling at 5s by default to
// match macOS, and use 8s timeout for the Get-Process call (heavier than the
// CIM calls).

let cachedWinTotal = 0;

function getWinTotalMemory(): Promise<number> {
  if (cachedWinTotal > 0) return Promise.resolve(cachedWinTotal);
  return new Promise((resolve) => {
    exec(
      'powershell -NoProfile -Command "(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory"',
      { encoding: "utf8", timeout: 5000 },
      (err, stdout) => {
        const v = err || !stdout ? 0 : parseInt(stdout.trim(), 10);
        if (v > 0) cachedWinTotal = v;
        resolve(v);
      },
    );
  });
}

interface WinMemUsage {
  total: number; // bytes
  used: number;  // bytes
}

function getWinMemUsage(): Promise<WinMemUsage | null> {
  return new Promise((resolve) => {
    exec(
      'powershell -NoProfile -Command "$o = Get-CimInstance Win32_OperatingSystem; Write-Output (($o.TotalVisibleMemorySize - $o.FreePhysicalMemory) * 1024); Write-Output ($o.TotalVisibleMemorySize * 1024)"',
      { encoding: "utf8", timeout: 5000 },
      (err, stdout) => {
        if (err || !stdout) { resolve(null); return; }
        const lines = stdout.trim().split(/\r?\n/).map((s) => parseInt(s.trim(), 10));
        if (lines.length < 2 || !isFinite(lines[0]) || !isFinite(lines[1]) || lines[1] <= 0) {
          resolve(null);
          return;
        }
        resolve({ used: lines[0], total: lines[1] });
      },
    );
  });
}

function getWinTopProcesses(limit: number): Promise<ProcEntry[]> {
  return new Promise((resolve) => {
    exec(
      `powershell -NoProfile -Command "Get-Process | Sort-Object WS -Descending | Select-Object -First ${limit} Id,WS,ProcessName | ConvertTo-Json -Compress"`,
      { encoding: "utf8", timeout: 8000 },
      (err, raw) => {
        if (err || !raw || !raw.trim()) { resolve([]); return; }
        try {
          const data = JSON.parse(raw.trim());
          const arr = Array.isArray(data) ? data : [data];
          resolve(
            arr
              .filter((p: any) => p && typeof p.Id === "number" && typeof p.WS === "number")
              .map((p: any) => ({
                pid: p.Id,
                rss: p.WS,
                name: String(p.ProcessName || "unknown"),
              })),
          );
        } catch {
          resolve([]);
        }
      },
    );
  });
}

function createWinMemoryMonitor(opts: {
  onUpdate: (text: string) => void;
  intervalMs?: number;
  colorize?: (displayText: string, percent: number) => string;
}): MemoryMonitor {
  const intervalMs = opts.intervalMs ?? 5000;
  let interval: ReturnType<typeof setInterval> | null = null;
  let ticking = false;

  async function pollOnce() {
    if (ticking) return;
    ticking = true;
    try {
      const usage = await getWinMemUsage();
      if (!usage || !usage.total) return;

      const pct = (usage.used / usage.total) * 100;
      const plain = `RAM ${formatBytes(usage.used)}/${formatBytes(usage.total)} (${pct.toFixed(0)}%)`;
      opts.onUpdate(opts.colorize ? opts.colorize(plain, pct) : plain);
    } finally {
      ticking = false;
    }
  }

  return {
    async start() {
      if (interval) return;
      // Prime the total-RAM cache so render() can rely on it; non-fatal if it fails.
      await getWinTotalMemory();
      await pollOnce();
      interval = setInterval(pollOnce, intervalMs);
    },
    stop() {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      opts.onUpdate("");
    },
    async showTop(ctx, widgetKey, limit) {
      try {
        ctx.ui.notify("Querying processes ...", "info");
        const top = await getWinTopProcesses(limit);
        if (top.length === 0) {
          ctx.ui.notify("Failed to enumerate processes.", "warning");
          return;
        }
        const lines = buildTopLines(
          `Top ${top.length} processes by memory (WS):`,
          top.map((p) => ({
            name: p.name,
            pid: p.pid,
            val1: formatBytes(p.rss),
            val2: "",
          })),
          "WS",
          "",
        );
        ctx.ui.setWidget(widgetKey, lines);
        autoClearWidget(ctx, widgetKey);
      } catch (e: any) {
        ctx.ui.notify(`mem-top: ${e.message || "unknown"}`, "error");
      }
    },
  };
}
