import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { exec } from "node:child_process";
import { basename } from "node:path";
import { buildTopLines, autoClearWidget, formatBytes } from "./util";

// ============================================================
// Memory Monitor (macOS only)
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

interface ProcEntry {
  pid: number;
  rss: number;
  name: string;
}

function getTopProcesses(limit: number): Promise<ProcEntry[]> {
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

// ============================================================
// Factory
// ============================================================

export interface MemoryMonitor {
  start(): Promise<void>;
  stop(): void;
  showTop(ctx: ExtensionContext, widgetKey: string): Promise<void>;
}

export function createMemoryMonitor(opts: {
  onUpdate: (text: string) => void;
  intervalMs?: number;
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
      opts.onUpdate(`RAM ${formatBytes(used)}/${formatBytes(total)} (${pct.toFixed(0)}%)`);
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
    async showTop(ctx, widgetKey) {
      try {
        ctx.ui.notify("Querying processes ...", "info");
        const top = await getTopProcesses(10);
        if (top.length === 0) {
          ctx.ui.notify("Failed to enumerate processes.", "warning");
          return;
        }
        const lines = buildTopLines(
          "Top 10 processes by memory (RSS):",
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
