# sys-monitor

实时显示网络上下行速度和内存用量的 pi 插件。

## footer 样式

```
↓1.2MB/s ↑300KB/s | RAM 14G/16G (87%)
```

## 功能

| 功能 | macOS | Windows |
|------|-------|---------|
| 网速显示(2s 刷新) | ✅ | ✅ |
| 内存显示(5s 刷新) | ✅ | ✅ |
| 内存预警颜色(>90% 红 / >70% 黄) | ✅ 可开关 | ✅ 可开关 |
| 进程网络 Top N(默认 10) | ✅ 吞吐量 | ✅ TCP 连接数 |
| 进程内存 Top N(默认 20) | ✅ RSS | ✅ Working Set |

> **Windows 说明**:Windows 无 `nettop` 等价物,网络 top 展示 TCP 连接数(近似活跃度),不是吞吐量。内存进程 top 使用 Working Set(WS)指标,与 macOS 的 RSS 口径略有差异。

## 安装

```bash
cd ~/.pi/agent/extensions
git clone https://github.com/QiuHua9/pi-sys-monitor.git sys-monitor
```

安装后执行 `/reload` 即可加载。

## 命令

所有操作通过单一入口 `/sys-monitor`。

```
/sys-monitor                       显示当前状态(同 status)
/sys-monitor help                  完整帮助
/sys-monitor status                显示当前状态

# 网络
/sys-monitor net                   网络进程 top（默认 10）
/sys-monitor net 20                网络 top 20
/sys-monitor net top 20            同上（显式 top）
/sys-monitor net on                启用网速显示
/sys-monitor net off               关闭网速显示
/sys-monitor net toggle            切换网速显示
/sys-monitor net stat              显示累计上传下载 widget（10 秒后自动消失）
/sys-monitor net stat reset        累计清零

# 内存(macOS + Windows)
/sys-monitor mem                   内存进程 top(默认 20)
/sys-monitor mem 50                内存 top 50
/sys-monitor mem top 50            同上
/sys-monitor mem on                启用内存显示
/sys-monitor mem off               关闭内存显示
/sys-monitor mem toggle            切换内存显示
/sys-monitor mem warn              切换颜色预警
/sys-monitor mem warn on           显式启用颜色预警
/sys-monitor mem warn off          显式关闭颜色预警

# 全部
/sys-monitor all on                全开
/sys-monitor all off               全关
/sys-monitor all toggle            全切换(任一开 → 全关;全关 → 全开)
```

**自动补全**:输入 `/sys-monitor ` 后会提示所有子命令;继续输入会按前缀过滤。

**N 上限**:进程 top 的 N 上限 100,超过自动截断,防止 widget 过长。

## 配置

文件:`~/.pi/agent/sys-monitor.json`

```json
{
  "network": { "enabled": true },
  "memory": { "enabled": true, "warning": true }
}
```

### 参数列表

| 路径 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `network.enabled` | boolean | `true` | 是否在 footer 显示网速(`↓/↑`) |
| `memory.enabled` | boolean | `true` | 是否在 footer 显示内存(`RAM X/Y (Z%)`) |
| `memory.warning` | boolean | `true` | 是否启用内存预警颜色。阈值固定:>90% 红 / >70% 黄,使用 pi theme 的 `error` / `warning` token,跟随主题变化 |

### 配置修改方式

- **命令**(推荐):`/sys-monitor net on|off|toggle`、`/sys-monitor mem on|off|toggle`、`/sys-monitor mem warn [on|off]`、`/sys-monitor all on|off|toggle`,立即生效 + 持久化
- **手动编辑**:直接改 `~/.pi/agent/sys-monitor.json`,执行 `/reload` 生效

JSON 解析失败时回退到默认配置,不影响插件加载。

## 兼容性

| 平台 | 网速 | 内存 |
|------|------|------|
| macOS | ✅ `netstat -ib` + `nettop` | ✅ `vm_stat` + `sysctl` + `ps` |
| Windows | ✅ `netstat -e` + `Get-NetTCPConnection` | ✅ `Get-CimInstance` + `Get-Process` |
| Linux | ⛔ | ⛔ |

无 sudo / 管理员权限要求。

## 性能

- **CPU**:几乎可忽略(异步 `exec`,不阻塞事件循环)
- **内存**:<1MB
- **防重叠**:每个模块独立 `ticking` 守卫,上一轮未完成时跳过本轮

## 实现原理

### footer 组合

两个模块各自维护内部状态,通过 `onUpdate` 回调更新 index.ts 的本地文本片段,再由 index.ts 重新组合并调用一次 `setStatus`。避免相互覆盖。

### 网速(总量)

| 平台 | 命令 | 说明 |
|------|------|------|
| macOS | `netstat -ib` | 解析 Link 层接口计数,排除 lo0 |
| Windows | `netstat -e` | 解析第一行双数字(跨语言兼容) |

两次采样差值 ÷ 时间 → 实时速率。

### 网速(进程)

| 平台 | 命令 | 展示内容 |
|------|------|----------|
| macOS | `nettop -x -P -n -m tcp -L 1` × 2 | 按 PID:进程名 匹配两次快照,计算 delta |
| Windows | `Get-NetTCPConnection -State Established` | 按 OwningProcess 分组统计连接数 |

### 内存(总量)

**macOS**

| 指标 | 数据源 |
|------|--------|
| 总量 | `sysctl -n hw.memsize`(首次后缓存) |
| 已用 | `(active + wired + compressor_occupied) × page_size`,来自 `vm_stat` |
| 页面大小 | 从 `vm_stat` header 动态解析(不硬编码,兼容 4096 / 16384) |

"已用"口径与 macOS 活动监视器一致。

**Windows**

| 指标 | 数据源 |
|------|--------|
| 总量 | `Get-CimInstance Win32_ComputerSystem` → `TotalPhysicalMemory`(首次后缓存) |
| 已用 | `TotalVisibleMemorySize - FreePhysicalMemory`,来自 `Win32_OperatingSystem` |

### 内存(进程)

| 平台 | 命令 | 指标 |
|------|------|------|
| macOS | `ps -axo pid,rss,comm` | RSS |
| Windows | `Get-Process \| Sort-Object WS -Descending` | Working Set |

## 文件结构

```
sys-monitor/
├── index.ts    # 入口:单命令 dispatcher、生命周期、footer 组合
├── net.ts      # 网络监控实现(macOS + Windows)
├── mem.ts      # 内存监控实现(macOS + Windows)
├── util.ts     # 共享:config、formatSpeed、formatBytes、buildTopLines
├── LICENSE
└── README.md
```

## License

[MIT](./LICENSE)
