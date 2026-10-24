# Gost-UI

基于 [gost v3](https://gost.run) 的可视化面板：转发/代理服务的增删改查、运行状态、流量统计。

React + [Arco Design](https://arco.design) 前端，Node 后端，**gost 与面板打包在同一个容器**，一个容器管到底。

## 界面

- **登录**：独立登录页，账号密码走服务端会话（HttpOnly Cookie，24h）
- **概览**：服务数、入站/出站总量与速率统计，下方为紧凑式服务卡片（每张卡片带「复制」与「延迟」按钮）
- **转发管理**：表格形式的新建 / 编辑 / 删除，支持端口转发与代理服务，行内可测延迟；窄屏横向滚动，名称与操作列固定
- **设置**：节点地址（导出用 host）、修改密码、当前会话与退出登录

界面已适配移动端：统计卡 2×2、服务卡片单列、表格横向滚动（不挤压换行）、抽屉占满视口宽度。

## 快捷操作

- **一键复制**：代理服务复制 `socks5://user:pass@host:port`，端口转发复制 `host:port`，host 取自「设置 → 节点地址」
- **延迟测试**：服务端发起到目标节点（转发取 `forwarder.nodes[0]`，代理取 `chain` 首个节点）的 TCP 握手，取 3 次采样最优值

## 支持的服务形态

| 形态 | gost 结构 | 表单 |
|---|---|---|
| 端口转发 TCP/UDP | `handler=tcp/udp` + `forwarder.nodes` | 目标 `host:port` |
| 代理服务 | `handler=socks5/http` + 可选 `auth` | 代理用户名密码，**留空自动生成** |
| 上游转发链 | `chain.hops[].nodes[].connector` | `socks5://user:pass@host:port`，逗号分隔多级 |

代理类服务（socks5 / http / socks4 / relay）创建时若没填账号密码，服务端会自动生成一套（用户名 `u` + 6 位、密码 16 位，已剔除易混淆字符），创建成功后在提示里直接给出，避免开出无认证的代理。编辑时把账号密码都清空会重新生成；只留空密码则保持原密码。

## 部署

```bash
cp .env.example .env      # 改掉密码
docker compose up -d
```

默认端口：

- `127.0.0.1:18000` → 面板（容器内 8080），**只绑宿主回环，不直接对外**
- `18100-18199` → 转发端口池，对外
- gost API `18080` 与 metrics `9000` 只监听容器内 `127.0.0.1`，不对外

镜像来自 GitHub Actions 构建：`ghcr.io/chouhx/gost-ui:latest`。

## 反向代理

面板本身不监听公网，交给反代提供 https。以 1Panel OpenResty 为例，反代目标填 `http://127.0.0.1:18000` 即可（OpenResty 容器是 host 网络，能直连宿主回环）。

Nginx 最小配置：

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name hk.example.com;

    ssl_certificate     /path/fullchain.pem;
    ssl_certificate_key /path/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:18000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade           $http_upgrade;
        proxy_set_header Connection        $http_connection;
    }
}
```

两点注意：

- `X-Forwarded-Proto` 必须传，面板靠它判断对外是 https，从而给会话 Cookie 加 `Secure`。
- 走 https 后 `navigator.clipboard` 才可用；面板对 http 场景已做 `execCommand` 兜底，两种都能复制。

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
| `PANEL_USER` / `PANEL_PASS` | 面板初始账号密码（登录后可在设置页改，改动落 `/data/config.json`） | admin / admin |
| `PUBLIC_HOST` | 导出链接使用的节点地址（设置页可覆盖） | 空 |
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

- 面板登录后使用 HttpOnly 会话 Cookie，公网部署建议再加一层 HTTPS 反代。
- Docker 发布的端口不受宿主机 iptables/ufw/1Panel 防火墙约束（DNAT 后走 FORWARD 链），需要限制访问请绑 `127.0.0.1` 走反代。
