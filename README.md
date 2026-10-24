# Gost-UI

基于 [gost v3](https://gost.run) 的可视化面板：转发/代理服务的增删改查、运行状态、流量统计。

React + [Arco Design](https://arco.design) 前端，Node 后端，**gost 与面板打包在同一个容器**，一个容器管到底。

## 界面

- **概览**：服务数、入站/出站总量与速率、流量趋势图（30 分钟 ~ 12 小时）、服务只读概览
- **转发管理**：新建 / 编辑 / 删除，支持端口转发与代理服务

## 支持的服务形态

| 形态 | gost 结构 | 表单 |
|---|---|---|
| 端口转发 TCP/UDP | `handler=tcp/udp` + `forwarder.nodes` | 目标 `host:port` |
| 代理服务 | `handler=socks5/http` + 可选 `auth` | 代理用户名密码 |
| 上游转发链 | `chain.hops[].nodes[].connector` | `socks5://user:pass@host:port`，逗号分隔多级 |

## 部署

```bash
cp .env.example .env      # 改掉密码
docker compose up -d
```

默认端口：

- `18000` → 面板（容器内 8080）
- `18100-18199` → 转发端口池
- gost API `18080` 与 metrics `9000` 只监听容器内 `127.0.0.1`，不对外

镜像来自 GitHub Actions 构建：`ghcr.io/chouhx/gost-ui:latest`。

## 本地开发

```bash
# 后端（默认连本机 gost API）
cd server && npm install 2>/dev/null; node app.js

# 前端（Vite dev，/api 代理到 127.0.0.1:8090）
cd web && npm install && npm run dev
```

环境变量：

| 变量 | 说明 | 默认 |
|---|---|---|
| `PANEL_PORT` | 面板监听端口 | 8080 |
| `PANEL_USER` / `PANEL_PASS` | 面板 Basic Auth | admin / admin |
| `GOST_API` | gost REST API 地址 | http://127.0.0.1:18080 |
| `GOST_API_USER` / `GOST_API_PASS` | gost API 认证 | - |
| `GOST_METRICS` | metrics 地址 | http://127.0.0.1:9000/metrics |
| `GOST_MANAGED` | 是否由面板拉起并守护 gost 进程 | 0 |
| `PORT_RANGE_START` / `PORT_RANGE_END` | 转发端口池 | 18100 / 18199 |
| `DATA_DIR` | 服务元数据目录 | /data |

## 实现要点

- **流量统计**：每 3s 拉 `/metrics`，对 `gost_service_transfer_input/output_bytes_total` 做差分，按分钟落桶保留 24h；counter 变小视为 gost 重启，按当前值计增量；速率用 EWMA(α=0.4) 平滑。
- **配置自愈**：gost v3 不会把 API 变更回写配置文件，API 建的服务只在内存里，gost 重启即丢。面板把服务记在 `/data/services.json`，每 15s 与 gost 实际列表对账，缺失即重建。
- **单容器**：`GOST_MANAGED=1` 时面板用 child_process 拉起 gost 并守护（退出后指数退避重启），SIGTERM 时一并关闭。
- **配置来源**：`gost/gost.yml` 是 gost 启动基线；面板创建的服务在重启后由对账机制恢复。

## 安全提示

- 面板使用 HTTP Basic Auth，公网部署建议加一层 HTTPS 反代。
- Docker 发布的端口不受宿主机 iptables/ufw/1Panel 防火墙约束（DNAT 后走 FORWARD 链），需要限制访问请绑 `127.0.0.1` 走反代。
