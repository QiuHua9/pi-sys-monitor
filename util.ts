import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ============================================================
// Shared utilities for sys-monitor
// ============================================================

export const CONFIG_PATH = join(homedir(), ".pi", "agent", "sys-monitor.json");

export interface Config {
  network: { enabled: boolean };
  memory: { enabled: boolean; warning: boolean };
}

export const DEFAULT_CONFIG: Config = {
  network: { enabled: true },
  memory: { enabled: true, warning: true },
};

export function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) return structuredClone(DEFAULT_CONFIG);
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    return {
      network: { enabled: raw?.network?.enabled ?? DEFAULT_CONFIG.network.enabled },
      memory: {
        enabled: raw?.memory?.enabled ?? DEFAULT_CONFIG.memory.enabled,
        warning: raw?.memory?.warning ?? DEFAULT_CONFIG.memory.warning,
      },
    };
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

export function saveConfig(c: Config): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2), "utf8");
}

// ── formatting ──

export function formatSpeed(bytesPerSec: number): string {
  const abs = Math.abs(bytesPerSec);
  if (abs >= 1_000_000) return `${(bytesPerSec / 1_000_000).toFixed(1)}MB/s`;
  if (abs >= 1_000) return `${(bytesPerSec / 1_000).toFixed(0)}KB/s`;
  return `${Math.round(bytesPerSec)}B/s`;
}

export function formatBytes(bytes: number): string {
  const abs = Math.abs(bytes);
  const G = 1024 ** 3;
  const M = 1024 ** 2;
  const K = 1024;
  if (abs >= G) return `${(bytes / G).toFixed(1)}G`;
  if (abs >= M) return `${(bytes / M).toFixed(0)}M`;
  if (abs >= K) return `${(bytes / K).toFixed(0)}K`;
  return `${bytes}B`;
}

// ── widget rendering ──

export interface TopRow {
  name: string;
  pid: number;
  val1: string;
  val2: string;
}

export function buildTopLines(
  title: string,
  rows: TopRow[],
  header1: string,
  header2: string,
): string[] {
  const hasCol2 = header2.length > 0;
  const width = hasCol2 ? 66 : 50;
  const sep = "─".repeat(width);
  const lines: string[] = [title, sep];

  if (hasCol2) {
    lines.push(
      `PROCESS${" ".repeat(16)}PID${" ".repeat(5)}${header1}${" ".repeat(Math.max(1, 6 - header1.length))}${header2}`,
    );
  } else {
    lines.push(`PROCESS${" ".repeat(16)}PID${" ".repeat(8)}${header1}`);
  }
  lines.push(sep);

  for (const r of rows) {
    const n = r.name.length > 22 ? r.name.slice(0, 19) + "…" : r.name;
    const pid = String(r.pid);
    if (hasCol2) {
      lines.push(`${n.padEnd(24)}${pid.padEnd(9)}${r.val1.padEnd(13)}${r.val2}`);
    } else {
      lines.push(`${n.padEnd(24)}${pid.padEnd(12)}${r.val1}`);
    }
  }
  lines.push(sep);
  return lines;
}

export function autoClearWidget(
  ctx: ExtensionContext,
  widgetKey: string,
  ms = 30_000,
): void {
  setTimeout(() => {
    try {
      ctx.ui.setWidget(widgetKey, undefined as any);
    } catch {
      /* ignore */
    }
  }, ms);
}
