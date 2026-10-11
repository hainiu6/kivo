# Kivo · 在线客服系统

自托管的中文客服工作台。添加一段 JavaScript，网站右下角就会出现客服图标，访客和客服可以实时聊天。

![客服工作台](docs/workbench.jpg)
![网页客服组件](docs/widget.jpg)

## 功能

- 网页浮动客服组件：自定义颜色、欢迎语，iframe 隔离样式，适配手机。
- 客服后台：会话列表、未读数量、搜索、网站筛选、快捷回复、结束 / 重新打开会话。
- 访客信息：在线状态、IP、估算地区、当前访问地址、首次访问时间；支持 SPA 地址更新。
- Socket.IO 实时消息、断线重连、历史记录、访客凭证恢复会话；支持加载更早消息。
- 多网站接入：生成独立嵌入代码、允许来源校验、网站配置与测试页面。
- 管理员密码哈希、HttpOnly Cookie、请求来源校验、登录及消息频率限制、修改密码撤销登录。
- Docker 镜像一键安装、升级前在线备份、健康检查及失败回退。

## Docker 一键安装（默认 8088）

支持 **Debian 10 / 11 / 12 / 13、amd64 / arm64**，Linux 内核 **4.18+**（Debian 10 默认 4.19）。建议 1 GB 内存、3 GB 可用空间，需要访问 GitHub；首次安装独立运行时还需访问 Docker 官方下载站。

在 root 终端执行：

```bash
curl -fsSL https://raw.githubusercontent.com/panhui/Kivo/main/scripts/install.sh -o /tmp/kivo-install.sh && bash /tmp/kivo-install.sh
```

普通账号请使用 `sudo bash /tmp/kivo-install.sh`。安装包已包含镜像，服务器**无需 Git、npm、Node.js、MariaDB 或 Docker Compose**。安装器不调用 apt / dpkg；截图中的 MariaDB 软件包错误不会阻挡此安装。

- 已有 Docker：先检查本机 socket 与服务端版本，要求 Docker 20.10.10+。服务未启动时尝试启动；运行中的服务不会被重启，也不重装 Docker。连接检查通过后才下载镜像。
- 没有 Docker：下载并校验官方静态 Docker 29.8.2，放在 `/opt/kivo/runtime/`，使用独立 `kivo-docker.service`、socket 和存储目录。不会向 `/usr/bin` 安装 Docker，也不改 `/etc/docker`。
- 默认只发布 **8088 → 容器 3000**，不占用 80 / 443。8088 被占用时自动尝试 8089–8107；显式指定端口被占用则退出。
- 数据在 `/opt/kivo/data`，配置在 `/opt/kivo/.env`；初始账号 `admin`，随机密码在安装完成时显示并保存在 `.env`。登录后可修改密码。

安装成功后访问显示的后台地址，并在服务器防火墙 / 云安全组放行实际端口。安装器不配置云安全组或额外放行规则；Docker 会创建容器所需的网络规则。已有同名容器会退出，不会覆盖它。

安装器识别本机 Docker context / `DOCKER_HOST` 的 Unix socket，并兼容 `/run/docker.sock` 与 `/var/run/docker.sock`。执行已选定的本机连接时会排除继承的 context、TLS 和 API 版本覆盖。自定义本机 socket 可通过 `KIVO_DOCKER_SOCKET=unix:///自定义路径/docker.sock` 指定；远程 Docker 不支持宿主机数据挂载，会明确拒绝。

如果连接检查失败，安装器会显示**当前主机名、客户端路径、连接 socket 和原始错误**，不会反复下载镜像后才报错。请在安装失败的同一台服务器执行 `systemctl status docker --no-pager -l`、`journalctl -u docker -n 30 --no-pager` 排查。连接检查使用服务端版本查询，不把 `docker info` 的其他错误误报为「服务未启动」。

若服务器在 NAT 后，指定正确公网地址（替换示例 IP）：

```bash
KIVO_PUBLIC_URL=http://203.0.113.10:8088 KIVO_PORT=8088 bash /tmp/kivo-install.sh
```

`PUBLIC_URL` 必须与浏览器访问后台的协议、主机及端口一致，否则登录来源校验会拒绝请求。可用 `KIVO_INSTALL_DIR=/opt/kivo-other KIVO_CONTAINER=kivo-other KIVO_PORT=8090` 部署另一个实例。目录须为不含空格的绝对路径，容器名称须以 `kivo` 开头。

安装依赖服务器已有 `curl`、`tar`、`gzip`、`awk`、`sha256sum`、`od`、`flock`、`tr`、`hostname` 等基础工具；独立运行时还需 systemd、iptables、ps、mount 和 cgroups。缺失时会明确报错，不会使用 apt 修复系统。独立 Docker 会创建自己的网桥和容器网络规则，仍需要宿主机允许容器运行。

Debian 10 是兼容目标，已不在当前 Docker 官方 apt 安装支持列表中。采用静态运行时避开软件源依赖；静态 Docker 不会自动更新，后续运行时安全更新需单独维护。发布测试覆盖两个架构的 Debian 10 用户空间；CI 使用较新宿主机内核，未在真实 Debian 10 / 4.19 服务器上验证。依据：[Docker 静态二进制安装](https://docs.docker.com/engine/install/binaries/)、[Docker Debian 安装要求](https://docs.docker.com/engine/install/debian/)、[Node 24 平台要求](https://github.com/nodejs/node/blob/v24.11.1/BUILDING.md)。

## HTTPS 与已有网站共存

HTTPS 网站应使用 HTTPS 客服地址，避免浏览器阻止混合内容。沿用服务器已有 Nginx / Caddy 的 HTTPS 域名与证书，将客服域名反向代理到 `127.0.0.1:8088`。

编辑 `/opt/kivo/.env`，保留其他项：

```dotenv
PUBLIC_URL=https://chat.example.com
HTTP_PORT=8088
BIND_HOST=127.0.0.1
TRUST_PROXY=1
```

然后执行升级命令重新创建容器。以下是已有 Nginx HTTPS `server` 中的 `location` 配置（若实际端口改变，请同步修改）：

```nginx
location / {
    proxy_pass http://127.0.0.1:8088;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_read_timeout 300s;
}
```

`TRUST_PROXY=1` 仅用于这一层可信代理；应用同时绑定回环地址。存在 CDN / 多层代理时，应按你的代理链配置可信来源和真实 IP。直接 IP 访问使用 `TRUST_PROXY=0`。

## 一键升级

```bash
bash /opt/kivo/scripts/upgrade.sh
```

下载最新 GitHub Release → SHA256 校验 → 导入镜像 → 在线备份 → 替换 Kivo 容器 → 等待健康检查。下载和导入期间旧服务保持运行；重启期间聊天短暂断开，组件会重连。升级保留配置、账号和聊天记录，不改其他容器。

新容器启动失败会恢复旧容器。数据库不会自动回滚，以免覆盖新消息；未来不兼容的数据迁移需按对应发行说明恢复备份。镜像与备份不会自动删除，便于回退。

指定已发布版本：

```bash
KIVO_VERSION=v1.1.0 bash /opt/kivo/scripts/upgrade.sh
```

## 网站接入

1. 登录后台，打开 **网站接入 → 添加网站**。
2. 填写网站名称、允许来源、图标颜色和欢迎语。允许来源例如 `https://www.example.com`，裸域、其他子域和不同端口须分别填写。
3. 保存，复制生成的嵌入代码，放在 HTML 的 `</body>` 前：

```html
<script src="https://chat.example.com/widget.js" data-site="后台生成的网站 ID" async></script>
```

4. 打开网站，点击右下角图标发送消息；后台会话列表实时出现对话。也可先使用后台「打开测试页面」。

有 CSP 的网站请允许客服域名的 `script-src`、`frame-src` 和 `connect-src`，加载器内联样式也需相应的 `style-src` 许可。嵌入代码不包含管理员凭证。

访客地区由本地 GeoLite 数据估算，内网通常显示「未知 / 内网」，VPN / 代理会影响结果。当前 URL 每 2 秒检测 SPA 变化，多标签页显示最近上报的地址。组件存储随机访客凭证并收集 IP、URL；在网站隐私说明中说明用途，页面 URL 不应含密码等秘密。保留 geoip-lite 包内授权和来源说明。

## 备份与维护

以 root 执行（普通账号加 sudo）：

```bash
bash /opt/kivo/scripts/backup.sh
bash /opt/kivo/scripts/docker.sh ps
bash /opt/kivo/scripts/docker.sh logs -f --tail 100 kivo
bash /opt/kivo/scripts/docker.sh restart kivo
bash /opt/kivo/scripts/docker.sh stop kivo
bash /opt/kivo/scripts/docker.sh start kivo
```

`docker.sh` 自动选择安装时的运行时，适用于系统 Docker 和独立 Docker。自定义容器名时将 `kivo` 替换为实际名称。服务和数据互相独立；停止容器保留聊天记录。

在线备份在 `/opt/kivo/backups/时间戳/`，包括一致的 SQLite 快照（含已提交 WAL 数据）、`.env`、`deployment.env` 与 `runtime.env`。配置和备份权限为仅拥有者可访问。建议复制备份到其他机器。

恢复会覆盖数据库，先备份当前数据，再选择正确的备份（替换示例时间戳）：

```bash
cd /opt/kivo
bash scripts/backup.sh
bash scripts/docker.sh stop kivo
cp backups/20261011T020000Z-1234/kivo.sqlite data/kivo.sqlite
rm -f data/kivo.sqlite-wal data/kivo.sqlite-shm
chown 1000:1000 data/kivo.sqlite
chmod 600 data/kivo.sqlite
bash scripts/docker.sh start kivo
```

恢复旧版本数据库时，依据备份 `deployment.env` 的 `KIVO_VERSION` 选择对应镜像版本；只有需要时才恢复 `.env`。不要公开 `.env`、数据或备份。

### 旧版 Compose 安装

已有 Git / Compose 部署可继续使用原目录的 `scripts/upgrade.sh` 和 `scripts/backup.sh`，脚本会识别并使用保留的 Compose 流程。它仍需要 Git / Compose 与本地构建，不能享受免 apt 的新安装流程；不会自动迁移或覆盖旧数据库。

旧安装失败且 `/opt/kivo` 已有 `.git` 与 `.env` 时，新镜像版会拒绝覆盖。可用 `KIVO_INSTALL_DIR=/opt/kivo-docker KIVO_CONTAINER=kivo-docker` 安装到新目录。需要迁移已有聊天记录时，先在线备份旧库，在新容器停止期间复制数据库并保留原账号配置。

仓库的 `compose.yaml` 保留供本地开发 / 原部署使用，默认 HTTP 8088、HTTPS 8443。镜像版安装不启动 Caddy；已有域名使用上面的反向代理方案。

## 开发与发布

需要 Node.js 24+，使用内置 `node:sqlite`，无需外部数据库：

```bash
npm ci
cp .env.example .env
```

编辑 `.env` 为 `PUBLIC_URL=http://localhost:3000`、`TRUST_PROXY=0`，设置至少 12 字符的 `ADMIN_PASSWORD`，然后 `npm run dev`。只在数据库首次创建时初始化管理员，已有账号请通过后台修改密码。

```bash
npm run check
npm test
npm audit --omit=dev
for file in scripts/*.sh test/*.sh; do bash -n "$file"; done
```

应用集成测试覆盖真实 HTTP / Socket.IO 登录、来源校验、双向消息、访客隔离、历史持久化、在线备份和 HTTP 消息 ID。CI 保留 Compose 测试；Docker release 工作流在原生 amd64 / arm64 runner 构建，使用 Debian 10 测试容器验证默认 8088、占用自动换端口、容器保护、备份、升级、数据保留、失败回退与校验失败。测试夹具中 apt 仅用于预装测试工具，正式部署脚本不会调用 apt / dpkg。

独立运行时测试在特权 Debian 10 容器中启动真实 dockerd，验证独立 socket、存储、网桥及应用健康状态；测试适配器执行生成的 systemd 单元启动命令，完整 systemd 启动流程与 4.19 内核仍需在目标服务器验证。运行时配置依据 [dockerd 官方参数文档](https://docs.docker.com/reference/cli/dockerd/)。

在 GitHub Actions 手动运行 **Docker release** 并指定新版本号，或推送 `v*` 标签，即可发布双架构安装包、SHA256SUMS、version.txt。服务器安装器下载 Release 附件，不需要镜像仓库账号。安装包包含镜像与安装 / 升级脚本，升级跟随已测试发行版本。

目前为单实例、单管理员的文本客服系统，不包含上传附件、客服分配或多管理员管理。SQLite 与内存在线状态适用于单机部署，请勿直接横向扩容多个实例。

技术栈：Node.js 24 / Express / Socket.IO / SQLite / Docker，原生 HTML、CSS、JavaScript 前端。
