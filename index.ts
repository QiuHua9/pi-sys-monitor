import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";
import { createNetworkMonitor } from "./net";
import { createMemoryMonitor } from "./mem";
import { loadConfig, saveConfig, formatBytes } from "./util";

// ============================================================
// sys-monitor — combined network + memory plugin for pi
// ============================================================
// Footer composition: net first, memory second
//   ↓1.2MB/s ↑300KB/s | RAM 14G/16G (87%)
//
// Single entry: /sys-monitor <subcommand> [args]
//   /sys-monitor                  → show current status
//   /sys-monitor help             → full usage
//   /sys-monitor status           → same as no args
//
//   /sys-monitor net [N]          → net top N (default 10)
//   /sys-monitor net top [N]      → same
//   /sys-monitor net on|off|toggle
//   /sys-monitor net stat [on|off|reset]  → persistent totals widget
//
//   /sys-monitor mem [N]          → mem top N (default 20, macOS only)
//   /sys-monitor mem top [N]      → same
//   /sys-monitor mem on|off|toggle
//   /sys-monitor mem warn [on|off]  → toggle/set color warning
//
//   /sys-monitor all on|off|toggle
// ============================================================

const IS_MACOS = process.platform === "darwin";
const STATUS_KEY = "sys-monitor";
const NET_WIDGET = "sys-monitor-net-top";
const MEM_WIDGET = "sys-monitor-mem-top";
const STATUS_WIDGET = "sys-monitor-status";
const NET_STAT_WIDGET = "sys-monitor-net-stat";

const NET_TOP_DEFAULT = 10;
const MEM_TOP_DEFAULT = 20;
const TOP_MAX = 100;

export default function (pi: ExtensionAPI) {
  let ctx: ExtensionContext | null = null;
  let config = loadConfig();

  let netText = "";
  let memText = "";
  let netStatOn = false; // widget mode: persistent totals display

  function render() {
    const parts: string[] = [];
    if (config.network.enabled && netText) parts.push(netText);
    if (IS_MACOS && config.memory.enabled && memText) parts.push(memText);
    ctx?.ui.setStatus(STATUS_KEY, parts.join(" | "));

    // Update net stat widget if enabled (mode B: persistent widget)
    if (netStatOn) {
      const t = net.getTotals();
      const lines = [
        "Network totals since session start",
        `Σ↓ ${formatBytes(t.down)}    Σ↑ ${formatBytes(t.up)}`,
      ];
      ctx?.ui.setWidget(NET_STAT_WIDGET, lines);
    }
  }

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
          if (!config.memory.warning) return plain;
          const t = ctx?.ui?.theme;
          if (!t) return plain;
          if (pct > 90) return t.fg("error", plain);
          if (pct > 70) return t.fg("warning", plain);
          return plain;
        },
      })
    : null;

  async function applyNetworkConfig() {
    if (config.network.enabled) await net.start();
    else net.stop();
  }
  async function applyMemoryConfig() {
    if (!IS_MACOS || !mem) return;
    if (config.memory.enabled) await mem.start();
    else mem.stop();
  }

  // ── helpers ──
  function parseLimit(s: string | undefined, fallback: number): number {
    const n = parseInt((s || "").trim(), 10);
    if (!isFinite(n) || n <= 0) return fallback;
    return Math.min(n, TOP_MAX);
  }

  function showStatusWidget(cmdCtx: ExtensionContext) {
    const lines: string[] = [
      "sys-monitor status",
      "─".repeat(50),
      `network.enabled  = ${config.network.enabled}`,
      `network.display  = ${netText || "(no data yet)"}`,
    ];
    if (IS_MACOS) {
      lines.push(
        `memory.enabled   = ${config.memory.enabled}`,
        `memory.warning   = ${config.memory.warning}`,
        `memory.display   = ${memText || "(no data yet)"}`,
      );
    } else {
      lines.push("memory           = (macOS only, not available)");
    }
    lines.push(
      "─".repeat(50),
      `Config file: ~/.pi/agent/sys-monitor.json`,
      `Type /sys-monitor help for usage.`,
    );
    cmdCtx.ui.setWidget(STATUS_WIDGET, lines);
    setTimeout(() => {
      try {
        cmdCtx.ui.setWidget(STATUS_WIDGET, undefined as any);
      } catch {
        /* ignore */
      }
    }, 15_000);
  }

  function showHelpWidget(cmdCtx: ExtensionContext) {
    const lines: string[] = [
      "sys-monitor usage: /sys-monitor <subcommand> [args]",
      "─".repeat(66),
      "  /sys-monitor                       Show current status",
      "  /sys-monitor help                  This help",
      "",
      "  Network:",
      "    /sys-monitor net [N]             Top N processes by network (default 10)",
      "    /sys-monitor net top [N]         Same as above",
      "    /sys-monitor net on|off|toggle   Enable / disable / toggle footer display",
      "    /sys-monitor net stat            Toggle persistent totals widget",
      "    /sys-monitor net stat on|off     Show / hide totals widget",
      "    /sys-monitor net stat reset      Reset totals to 0",
      "",
      "  Memory (macOS only):",
      "    /sys-monitor mem [N]             Top N processes by RSS (default 20)",
      "    /sys-monitor mem top [N]         Same as above",
      "    /sys-monitor mem on|off|toggle   Enable / disable / toggle footer display",
      "    /sys-monitor mem warn            Toggle color warning",
      "    /sys-monitor mem warn on|off     Explicitly set color warning",
      "",
      "  Both:",
      "    /sys-monitor all on|off|toggle   Apply to network + memory",
      "─".repeat(66),
      "N is capped at 100. Status subcommands persist to ~/.pi/agent/sys-monitor.json.",
    ];
    cmdCtx.ui.setWidget(STATUS_WIDGET, lines);
    setTimeout(() => {
      try {
        cmdCtx.ui.setWidget(STATUS_WIDGET, undefined as any);
      } catch {
        /* ignore */
      }
    }, 30_000);
  }

  // ── autocomplete ──
  // Static subcommand tree. We return candidates based on the current prefix
  // so users get suggestions after typing "/sys-monitor ".
  const SUBCOMMANDS: { value: string; label: string; description: string }[] = [
    { value: "help", label: "help", description: "Show full usage" },
    { value: "status", label: "status", description: "Show current status" },
    { value: "net", label: "net ...", description: "Network: top [N] | on | off | toggle | stat" },
    { value: "mem", label: "mem ...", description: "Memory: top [N] | on | off | toggle | warn" },
    { value: "all", label: "all ...", description: "Both: on | off | toggle" },
  ];

  const NET_SUB: AutocompleteItem[] = [
    { value: "top", label: "top [N]", description: "Show top N processes (default 10)" },
    { value: "on", label: "on", description: "Enable footer display" },
    { value: "off", label: "off", description: "Disable footer display" },
    { value: "toggle", label: "toggle", description: "Toggle footer display" },
  ];

  const MEM_SUB: AutocompleteItem[] = [
    { value: "top", label: "top [N]", description: "Show top N processes (default 20)" },
    { value: "on", label: "on", description: "Enable footer display" },
    { value: "off", label: "off", description: "Disable footer display" },
    { value: "toggle", label: "toggle", description: "Toggle footer display" },
    { value: "warn", label: "warn [on|off]", description: "Toggle color warning" },
  ];

  const ALL_SUB: AutocompleteItem[] = [
    { value: "on", label: "on", description: "Enable both" },
    { value: "off", label: "off", description: "Disable both" },
    { value: "toggle", label: "toggle", description: "Toggle both" },
  ];

  function getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
    const p = prefix.trim();
    // No subcommand yet → list top-level
    if (p === "") return SUBCOMMANDS;

    const parts = p.split(/\s+/);
    const head = parts[0];
    const rest = parts.slice(1).join(" ");

    // "net ..." / "mem ..." / "all ..."
    if (head === "net") {
      if (rest === "") return NET_SUB;
      // If first remaining token is a digit → top-N suggestion; otherwise filter NET_SUB
      if (/^\d/.test(rest)) return null;
      return NET_SUB.filter((i) => i.value.startsWith(rest));
    }
    if (head === "mem") {
      if (rest === "") return MEM_SUB;
      if (rest.startsWith("warn")) {
        return [
          { value: "warn", label: "warn", description: "Toggle color warning" },
          { value: "warn on", label: "warn on", description: "Enable color warning" },
          { value: "warn off", label: "warn off", description: "Disable color warning" },
        ].filter((i) => i.value.startsWith(rest));
      }
      if (/^\d/.test(rest)) return null;
      return MEM_SUB.filter((i) => i.value.startsWith(rest));
    }
    if (head === "all") {
      if (rest === "") return ALL_SUB;
      return ALL_SUB.filter((i) => i.value.startsWith(rest));
    }
    // Top-level filter
    return SUBCOMMANDS.filter((i) => i.value.startsWith(head));
  }

  // ── main command ──
  pi.registerCommand("sys-monitor", {
    description:
      "System monitor (network + memory). /sys-monitor help for usage.",
    getArgumentCompletions,
    handler: async (args, cmdCtx) => {
      const tokens = (args || "").trim().split(/\s+/).filter(Boolean);
      const sub = tokens[0] || "";

      // No args or "status" → show status
      if (sub === "" || sub === "status") {
        showStatusWidget(cmdCtx);
        return;
      }

      if (sub === "help") {
        showHelpWidget(cmdCtx);
        return;
      }

      if (sub === "net") {
        await handleNet(tokens.slice(1), cmdCtx);
        return;
      }

      if (sub === "mem") {
        await handleMem(tokens.slice(1), cmdCtx);
        return;
      }

      if (sub === "all") {
        await handleAll(tokens.slice(1), cmdCtx);
        return;
      }

      cmdCtx.ui.notify(
        `Unknown subcommand: "${sub}". Try /sys-monitor help`,
        "warning",
      );
    },
  });

  // ── net handler ──
  // Accepted forms:
  //   net              → top default
  //   net N            → top N
  //   net top          → top default
  //   net top N        → top N
  //   net on|off|toggle
  async function handleNet(rest: string[], cmdCtx: ExtensionContext) {
    const head = rest[0] || "";

    // net on/off/toggle
    if (head === "on" || head === "off" || head === "toggle") {
      const next = head === "toggle" ? !config.network.enabled : head === "on";
      config.network.enabled = next;
      saveConfig(config);
      await applyNetworkConfig();
      render();
      cmdCtx.ui.notify(`Network ${next ? "on" : "off"}`, "info");
      return;
    }

    // net top [N] OR net [N]
    let limit = NET_TOP_DEFAULT;
    if (head === "top") {
      limit = parseLimit(rest[1], NET_TOP_DEFAULT);
    } else if (head === "" || /^\d+$/.test(head)) {
      limit = parseLimit(head, NET_TOP_DEFAULT);
    } else {
      cmdCtx.ui.notify(
        `Unknown net subcommand: "${head}". Try /sys-monitor help`,
        "warning",
      );
      return;
    }
    await net.showTop(cmdCtx, NET_WIDGET, limit);
  }

  // ── mem handler ──
  async function handleMem(rest: string[], cmdCtx: ExtensionContext) {
    if (!IS_MACOS || !mem) {
      cmdCtx.ui.notify("Memory monitor is macOS only.", "warning");
      return;
    }
    const head = rest[0] || "";

    // mem on/off/toggle
    if (head === "on" || head === "off" || head === "toggle") {
      const next = head === "toggle" ? !config.memory.enabled : head === "on";
      config.memory.enabled = next;
      saveConfig(config);
      await applyMemoryConfig();
      render();
      cmdCtx.ui.notify(`Memory ${next ? "on" : "off"}`, "info");
      return;
    }

    // mem warn [on|off]
    if (head === "warn") {
      const sub2 = rest[1] || "";
      let next: boolean;
      if (sub2 === "on") next = true;
      else if (sub2 === "off") next = false;
      else next = !config.memory.warning; // toggle
      config.memory.warning = next;
      saveConfig(config);
      // Force refresh so color updates immediately
      await mem.stop();
      await applyMemoryConfig();
      cmdCtx.ui.notify(`Memory warning ${next ? "on" : "off"}`, "info");
      return;
    }

    // mem top [N] OR mem [N]
    let limit = MEM_TOP_DEFAULT;
    if (head === "top") {
      limit = parseLimit(rest[1], MEM_TOP_DEFAULT);
    } else if (head === "" || /^\d+$/.test(head)) {
      limit = parseLimit(head, MEM_TOP_DEFAULT);
    } else {
      cmdCtx.ui.notify(
        `Unknown mem subcommand: "${head}". Try /sys-monitor help`,
        "warning",
      );
      return;
    }
    await mem.showTop(cmdCtx, MEM_WIDGET, limit);
  }

  // ── all handler ──
  async function handleAll(rest: string[], cmdCtx: ExtensionContext) {
    const op = rest[0] || "";
    if (op !== "on" && op !== "off" && op !== "toggle") {
      cmdCtx.ui.notify(
        `Usage: /sys-monitor all on|off|toggle`,
        "warning",
      );
      return;
    }
    const anyOn = config.network.enabled || (IS_MACOS && config.memory.enabled);
    const next = op === "toggle" ? !anyOn : op === "on";
    config.network.enabled = next;
    if (IS_MACOS) config.memory.enabled = next;
    saveConfig(config);
    await Promise.all([applyNetworkConfig(), applyMemoryConfig()]);
    render();
    cmdCtx.ui.notify(`System monitor ${next ? "on" : "off"}`, "info");
  }

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
      ctx?.ui.setWidget(NET_STAT_WIDGET, undefined as any);
    } catch {
      /* ignore */
    }
    ctx = null;
  });
}
