import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createNetworkMonitor } from "./net";
import { createMemoryMonitor } from "./mem";
import { loadConfig, saveConfig, DEFAULT_CONFIG } from "./util";

// ============================================================
// sys-monitor — combined network + memory plugin for pi
// ============================================================
// Footer composition: net first, memory second
//   ↓1.2MB/s ↑300KB/s   RAM 14G/16G (87%)
//
// Commands:
//   /net-toggle  — toggle network display (persistent)
//   /mem-toggle  — toggle memory display  (macOS only, persistent)
//   /sys-toggle  — toggle both
//   /net-top     — top processes by network activity
//   /mem-top     — top processes by memory (macOS only)
// ============================================================

const IS_MACOS = process.platform === "darwin";
const STATUS_KEY = "sys-monitor";
const NET_WIDGET = "sys-monitor-net-top";
const MEM_WIDGET = "sys-monitor-mem-top";

export default function (pi: ExtensionAPI) {
  let ctx: ExtensionContext | null = null;
  let config = loadConfig();

  // Per-module latest text snippets
  let netText = "";
  let memText = "";

  function render() {
    const parts: string[] = [];
    if (config.network.enabled && netText) parts.push(netText);
    if (IS_MACOS && config.memory.enabled && memText) parts.push(memText);
    const text = parts.join("  ");
    ctx?.ui.setStatus(STATUS_KEY, text);
  }

  // ── monitors (callbacks update local text, then re-render) ──
  const net = createNetworkMonitor({
    onUpdate: (text) => {
      netText = text;
      render();
    },
  });

  const mem = IS_MACOS
    ? createMemoryMonitor({
        onUpdate: (text) => {
          memText = text;
          render();
        },
        colorize: (plain, pct) => {
          if (!config.memory.warning || !ctx) return plain;
          if (pct > 90) return ctx.theme.fg("error", plain);
          if (pct > 70) return ctx.theme.fg("warning", plain);
          return plain;
        },
      })
    : null;

  // ── apply config: start/stop modules based on flags ──
  async function applyNetworkConfig() {
    if (config.network.enabled) await net.start();
    else net.stop();
  }
  async function applyMemoryConfig() {
    if (!IS_MACOS || !mem) return;
    if (config.memory.enabled) await mem.start();
    else mem.stop();
  }

  // ── commands ──
  pi.registerCommand("net-toggle", {
    description: "Toggle network speed display in footer",
    handler: async (_args, cmdCtx) => {
      config.network.enabled = !config.network.enabled;
      saveConfig(config);
      await applyNetworkConfig();
      render();
      cmdCtx.ui.notify(
        `Network monitor ${config.network.enabled ? "enabled" : "disabled"}`,
        "info",
      );
    },
  });

  pi.registerCommand("mem-toggle", {
    description: "Toggle memory usage display in footer (macOS only)",
    handler: async (_args, cmdCtx) => {
      if (!IS_MACOS) {
        cmdCtx.ui.notify("Memory monitor is macOS only.", "warning");
        return;
      }
      config.memory.enabled = !config.memory.enabled;
      saveConfig(config);
      await applyMemoryConfig();
      render();
      cmdCtx.ui.notify(
        `Memory monitor ${config.memory.enabled ? "enabled" : "disabled"}`,
        "info",
      );
    },
  });

  pi.registerCommand("mem-warn", {
    description: "Toggle memory usage color warning in footer (macOS only)",
    handler: async (_args, cmdCtx) => {
      if (!IS_MACOS) {
        cmdCtx.ui.notify("Memory monitor is macOS only.", "warning");
        return;
      }
      config.memory.warning = !config.memory.warning;
      saveConfig(config);
      // Force a refresh so colors update immediately
      await mem?.stop();
      await applyMemoryConfig();
      cmdCtx.ui.notify(
        `Memory warning color ${config.memory.warning ? "enabled" : "disabled"}`,
        "info",
      );
    },
  });

  pi.registerCommand("sys-toggle", {
    description: "Toggle both network and memory display",
    handler: async (_args, cmdCtx) => {
      // If either is on → turn both off. If both off → turn both on.
      const anyOn = config.network.enabled || (IS_MACOS && config.memory.enabled);
      config.network.enabled = !anyOn;
      if (IS_MACOS) config.memory.enabled = !anyOn;
      saveConfig(config);
      await applyNetworkConfig();
      await applyMemoryConfig();
      render();
      cmdCtx.ui.notify(
        `System monitor ${!anyOn ? "enabled" : "disabled"}`,
        "info",
      );
    },
  });

  pi.registerCommand("net-top", {
    description: IS_MACOS
      ? "Show top 10 processes by network throughput (4s sample)"
      : "Show top 10 processes by TCP connection count",
    handler: async (_args, cmdCtx) => {
      await net.showTop(cmdCtx, NET_WIDGET);
    },
  });

  pi.registerCommand("mem-top", {
    description: "Show top 10 processes by memory (RSS, macOS only)",
    handler: async (_args, cmdCtx) => {
      if (!IS_MACOS || !mem) {
        cmdCtx.ui.notify("Memory monitor is macOS only.", "warning");
        return;
      }
      await mem.showTop(cmdCtx, MEM_WIDGET);
    },
  });

  // ── lifecycle ──
  pi.on("session_start", async (_event, sessionCtx) => {
    ctx = sessionCtx;
    config = loadConfig();
    await Promise.all([applyNetworkConfig(), applyMemoryConfig()]);
  });

  pi.on("session_shutdown", () => {
    net.stop();
    mem?.stop();
    try {
      ctx?.ui.setStatus(STATUS_KEY, "");
    } catch {
      /* ignore */
    }
    ctx = null;
  });
}
