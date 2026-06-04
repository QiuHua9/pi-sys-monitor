import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { exec } from "node:child_process";
import { basename } from "node:path";
import { buildTopLines, autoClearWidget, formatSpeed } from "./util";

// ============================================================
// Network Monitor (macOS + Windows)
// ============================================================

const IS_WINDOWS = process.platform === "win32";
const IS_MACOS = process.platform === "darwin";

interface InterfaceCounter {
  name: string;
  bytesIn: number;
  bytesOut: number;
}

// ── macOS: netstat -ib ──
function getMacCounters(): Promise<InterfaceCounter[]> {
  return new Promise((resolve) => {
    exec(
      "netstat -ib 2>/dev/null",
      { encoding: "utf8", timeout: 3000 },
      (err, raw) => {
        if (err || !raw) { resolve([]); return; }
        const counters = new Map<string, { bytesIn: number; bytesOut: number }>();
        for (const line of raw.split("\n")) {
          if (!line.includes("<Link#")) continue;
          const parts = line.trim().split(/\s+/);
          if (parts.length < 10 || parts[0] === "lo0") continue;
          const numFields = parts.slice(-7);
          const bytesIn = parseInt(numFields[2], 10);
          const bytesOut = parseInt(numFields[5], 10);
          if (isNaN(bytesIn) || isNaN(bytesOut)) continue;
          counters.set(parts[0], { bytesIn, bytesOut });
        }
        resolve(
          Array.from(counters.entries()).map(([name, c]) => ({ name, ...c })),
        );
      },
    );
  });
}

// ── Windows: netstat -e (locale-independent) ──
function parseNetstatE(raw: string): InterfaceCounter[] {
  for (const line of raw.split("\n")) {
    const m = line.match(/(\d{3,})\s+(\d{3,})/);
    if (m) {
      return [
        { name: "total", bytesIn: parseInt(m[1], 10), bytesOut: parseInt(m[2], 10) },
      ];
    }
  }
  return [];
}

function getWinCounters(): Promise<InterfaceCounter[]> {
  return new Promise((resolve) => {
    exec("netstat -e", { encoding: "utf8", timeout: 3000 }, (err, raw) => {
      if (err || !raw) { resolve([]); return; }
      resolve(parseNetstatE(raw));
    });
  });
}

const getInterfaceCounters: () => Promise<InterfaceCounter[]> = IS_WINDOWS
  ? getWinCounters
  : getMacCounters;

// ── macOS: nettop parsing ──

interface ProcessNetSample {
  pid: number;
  name: string;
  bytesIn: number;
  bytesOut: number;
}

function parseNettopOutput(raw: string): ProcessNetSample[] {
  const lines = raw.trim().split("\n");
  const results: ProcessNetSample[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = line.split(",");
    if (cols.length < 6) continue;
    const procFull = cols[1];
    if (!procFull || !procFull.includes(".")) continue;
    const lastDot = procFull.lastIndexOf(".");
    const name = procFull.slice(0, lastDot);
    const pid = parseInt(procFull.slice(lastDot + 1), 10);
    if (isNaN(pid)) continue;
    const bytesIn = parseInt(cols[4], 10) || 0;
    const bytesOut = parseInt(cols[5], 10) || 0;
    results.push({ pid, name, bytesIn, bytesOut });
  }
  return results;
}

function nettopSnapshot(): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(
      "nettop -x -P -n -m tcp -L 1 2>/dev/null",
      { encoding: "utf8", timeout: 8000 },
      (err, stdout) => {
        if (stdout && stdout.includes("time,")) resolve(stdout);
        else if (err && stdout) resolve(stdout);
        else reject(err || new Error("nettop returned no data"));
      },
    );
  });
}

function toProcMap(
  samples: ProcessNetSample[],
): Map<string, { bytesIn: number; bytesOut: number }> {
  const map = new Map();
  for (const s of samples)
    map.set(`${s.pid}:${s.name}`, { bytesIn: s.bytesIn, bytesOut: s.bytesOut });
  return map;
}

function computeDeltas(
  prev: Map<string, { bytesIn: number; bytesOut: number }>,
  curr: ProcessNetSample[],
  elapsedSec: number,
): { name: string; pid: number; downBps: number; upBps: number }[] {
  const out: { name: string; pid: number; downBps: number; upBps: number }[] = [];
  for (const s of curr) {
    const p = prev.get(`${s.pid}:${s.name}`);
    if (!p) continue;
    const dIn = s.bytesIn - p.bytesIn;
    const dOut = s.bytesOut - p.bytesOut;
    if (dIn <= 0 && dOut <= 0) continue;
    out.push({
      name: s.name,
      pid: s.pid,
      downBps: dIn / elapsedSec,
      upBps: dOut / elapsedSec,
    });
  }
  return out;
}

// ── Windows: per-process connection counts ──

interface WinProcEntry {
  name: string;
  pid: number;
  conns: number;
}

function winProcSnapshot(): Promise<WinProcEntry[]> {
  return new Promise((resolve) => {
    exec(
      `powershell -NoProfile -Command "Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue | Group-Object OwningProcess | Sort-Object -Descending Count | Select-Object -First 10 | ForEach-Object { $p = Get-Process -Id $_.Name -ErrorAction SilentlyContinue; Write-Output \\"$($p.ProcessName)|$($_.Name)|$($_.Count)\\" }"`,
      { encoding: "utf8", timeout: 10000 },
      (_err, raw) => {
        if (!raw) { resolve([]); return; }
        const results: WinProcEntry[] = [];
        for (const line of raw.split("\n")) {
          const m = line.trim().match(/^(.+)\|(\d+)\|(\d+)$/);
          if (!m) continue;
          const pid = parseInt(m[2], 10);
          const conns = parseInt(m[3], 10);
          if (isNaN(pid) || isNaN(conns)) continue;
          results.push({ name: m[1], pid, conns });
        }
        resolve(results);
      },
    );
  });
}

// ============================================================
// Factory
// ============================================================

export interface NetworkMonitor {
  start(): Promise<void>;
  stop(): void;
  showTop(ctx: ExtensionContext, widgetKey: string): Promise<void>;
}

export function createNetworkMonitor(opts: {
  onUpdate: (text: string) => void;
  intervalMs?: number;
}): NetworkMonitor {
  const intervalMs = opts.intervalMs ?? 2000;
  let interval: ReturnType<typeof setInterval> | null = null;
  let prevCounters = new Map<string, { bytesIn: number; bytesOut: number }>();
  let prevTimestamp = 0;
  let ticking = false;

  async function pollOnce() {
    if (ticking) return;
    ticking = true;
    try {
      const now = Date.now();
      const curr = await getInterfaceCounters();
      if (curr.length === 0) return;

      const elapsed = (now - prevTimestamp) / 1000;
      let totalDown = 0;
      let totalUp = 0;
      for (const c of curr) {
        const p = prevCounters.get(c.name);
        if (p) {
          const dIn = c.bytesIn - p.bytesIn;
          const dOut = c.bytesOut - p.bytesOut;
          if (dIn > 0) totalDown += dIn;
          if (dOut > 0) totalUp += dOut;
        }
        prevCounters.set(c.name, { bytesIn: c.bytesIn, bytesOut: c.bytesOut });
      }
      prevTimestamp = now;

      const downStr = formatSpeed(totalDown / Math.max(elapsed, 0.5));
      const upStr = formatSpeed(totalUp / Math.max(elapsed, 0.5));
      opts.onUpdate(`↓${downStr} ↑${upStr}`);
    } finally {
      ticking = false;
    }
  }

  return {
    async start() {
      if (interval) return;
      const init = await getInterfaceCounters();
      prevTimestamp = Date.now();
      prevCounters = new Map(
        init.map((c) => [c.name, { bytesIn: c.bytesIn, bytesOut: c.bytesOut }]),
      );
      pollOnce();
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
      if (IS_MACOS) {
        try {
          ctx.ui.notify("Sampling network traffic (4s) …", "info");
          const raw1 = await nettopSnapshot();
          const map1 = toProcMap(parseNettopOutput(raw1));
          await new Promise((r) => setTimeout(r, 2000));
          const raw2 = await nettopSnapshot();
          const deltas = computeDeltas(map1, parseNettopOutput(raw2), 2);

          if (deltas.length === 0) {
            ctx.ui.notify("No active TCP connections in this 2s window.", "warning");
            return;
          }
          deltas.sort((a, b) => b.downBps + b.upBps - (a.downBps + a.upBps));
          const top = deltas.slice(0, 10);

          const lines = buildTopLines(
            "Top processes by network throughput (↓ + ↑ combined):",
            top.map((p) => ({
              name: p.name,
              pid: p.pid,
              val1: formatSpeed(p.downBps),
              val2: formatSpeed(p.upBps),
            })),
            "↓ DOWN",
            "↑ UP",
          );
          ctx.ui.setWidget(widgetKey, lines);
          autoClearWidget(ctx, widgetKey);
        } catch (e: any) {
          ctx.ui.notify(`net-top: ${e.message || "unknown"}`, "error");
        }
      } else if (IS_WINDOWS) {
        try {
          ctx.ui.notify("Querying TCP connections …", "info");
          const entries = await winProcSnapshot();
          if (entries.length === 0) {
            ctx.ui.notify("No established TCP connections found.", "warning");
            return;
          }
          const top = entries.slice(0, 10);
          const lines = buildTopLines(
            "Top processes by TCP connections (Windows: no per-process throughput):",
            top.map((e) => ({
              name: e.name,
              pid: e.pid,
              val1: String(e.conns),
              val2: "",
            })),
            "CONNS",
            "",
          );
          ctx.ui.setWidget(widgetKey, lines);
          autoClearWidget(ctx, widgetKey);
        } catch (e: any) {
          ctx.ui.notify(`net-top: ${e.message || "unknown"}`, "error");
        }
      }
    },
  };
}
