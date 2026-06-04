# sys-monitor

实时显示网络上下行速度和内存用量的 pi 插件。两个模块独立开关、独立轮询，footer 显示按"网速在前、内存（RAM）在后"组合。

## footer 样式

```
↓1.2MB/s ↑300KB/s   RAM 14G/16G (87%)
```

网速无前缀（箭头 `↓ ↑` 本身就是标识），内存使用 `RAM` 前缀。两个模块间用双空格分隔。

## 功能

| 功能 | 触发方式 | macOS | Windows |
|------|----------|-------|---------|
| 网速显示 | 自动 | `↓/↑` 2s 刷新 | 同左 |
| 内存显示 | 自动 | `RAM X/Y (Z%)` 5s 刷新 | ⛔ 不支持 |
| 进程网络 Top 10 | `/net-top` | 进程吞吐量（`nettop` 采样 4s） | TCP 连接数（`Get-NetTCPConnection`） |
| 进程内存 Top 10 | `/mem-top` | 进程 RSS | ⛔ 不支持 |
| 网速开关 | `/net-toggle` | 持久化 | 同左 |
| 内存开关 | `/mem-toggle` | 持久化 | ⛔ |
| 一键开关 | `/sys-toggle` | 同时切换两者 | 仅切换网速 |

> **Windows 说明**：Windows 无 `nettop` 等价物，`/net-top` 展示 TCP 连接数（近似活跃度），不是吞吐量。内存监控仅 macOS（依赖 `vm_stat` + `sysctl hw.memsize`）。

## 安装

```bash
cd ~/.pi/agent/extensions
git clone https://github.com/QiuHua9/pi-sys-monitor.git sys-monitor
```

安装后执行 `/reload` 即可加载。

## 命令

| 命令 | 作用 |
|------|------|
| `/net-top` | top 10 进程网络活动（4s 采样） |
| `/mem-top` | top 10 进程内存（RSS） |
| `/net-toggle` | 开/关网速显示 |
| `/mem-toggle` | 开/关内存显示 |
| `/sys-toggle` | 同时开/关两者（任一开 → 全关；全关 → 全开） |

所有 toggle 立即生效，配置持久化到磁盘。

## 配置

文件：`~/.pi/agent/sys-monitor.json`

```json
{
  "network": { "enabled": true },
  "memory": { "enabled": true }
}
```

可手动编辑或用 toggle 命令切换。重启 pi 按配置加载。

## 兼容性

| 平台 | 网速 | 内存 |
|------|------|------|
| macOS | ✅ `netstat -ib` + `nettop` | ✅ `vm_stat` + `sysctl` + `ps` |
| Windows | ✅ `netstat -e` + `Get-NetTCPConnection` | ⛔ |
| Linux | ⛔ | ⛔ |

无 sudo / 管理员权限要求。

## 性能

- **CPU**：几乎可忽略（异步 `exec`，不阻塞事件循环）
- **内存**：<1MB
- **防重叠**：每个模块独立 `ticking` 守卫，上一轮未完成时跳过本轮
- **pi 流畅度**：不阻塞事件循环，pi 操作流畅

## 实现原理

### footer 组合

两个模块各自维护内部状态，通过 `onUpdate` 回调更新 index.ts 的本地文本片段，再由 index.ts 重新组合并调用一次 `setStatus`。避免相互覆盖。

### 网速（总量）

| 平台 | 命令 | 说明 |
|------|------|------|
| macOS | `netstat -ib` | 解析 Link 层接口计数，排除 lo0 |
| Windows | `netstat -e` | 解析第一行双数字（跨语言兼容） |

两次采样差值 ÷ 时间 → 实时速率。

### 网速（进程）

| 平台 | 命令 | 展示内容 |
|------|------|----------|
| macOS | `nettop -x -P -n -m tcp -L 1` × 2 | 按 PID:进程名 匹配两次快照，计算 delta |
| Windows | `Get-NetTCPConnection -State Established` | 按 OwningProcess 分组统计连接数 |

### 内存（总量）

| 指标 | 数据源 |
|------|--------|
| 总量 | `sysctl -n hw.memsize`（首次后缓存） |
| 已用 | `(active + wired + compressor_occupied) × page_size`，来自 `vm_stat` |
| 页面大小 | 从 `vm_stat` header 动态解析（不硬编码，兼容 4096 / 16384） |

"已用"口径与 macOS 活动监视器一致。

### 内存（进程）

`ps -axo pid,rss,comm` → 按 RSS 排序取 top 10。

## 文件结构

```
sys-monitor/
├── index.ts    # 入口：注册命令、生命周期、footer 组合
├── net.ts      # 网络监控工厂（macOS + Windows）
├── mem.ts      # 内存监控工厂（macOS only）
├── util.ts     # 共享：config、formatSpeed、formatBytes、buildTopLines
├── LICENSE
└── README.md
```

## 从旧插件迁移

本插件是 `network-monitor` 和 `mem-monitor` 的合并版。旧的配置文件 `~/.pi/agent/network-monitor.json` 和 `mem-monitor.json` 不会被读取——默认就是开启状态，无需手动迁移。

建议删除旧的插件目录：

```bash
rm -rf ~/.pi/agent/extensions/network-monitor
rm -rf ~/.pi/agent/extensions/mem-monitor
```

## License

[MIT](./LICENSE)
