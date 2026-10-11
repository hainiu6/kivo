# Kivo · 在线客服系统

自托管的中文客服工作台。把一段 JavaScript 添加到网站，右下角就会出现客服图标；访客和管理员可以实时聊天。

![客服工作台](docs/workbench.jpg)

![网页客服组件](docs/widget.jpg)

## 已实现

- **网页客服组件**：右下角图标、可展开聊天窗口、自定义品牌色与欢迎语；iframe 隔离网站样式，支持移动端。
- **客服后台**：会话列表、未读数量、搜索、网站筛选、快捷回复、结束 / 重新打开会话。
- **访客信息**：在线状态、IP、估算地区、当前页面地址、首次访问时间。支持 SPA 页面地址更新。
- **实时与持久化**：Socket.IO 实时双向消息、断线重连、历史记录；浏览器本地存储访客凭证以恢复会话。每次加载最近 100 条消息，后台可加载更早记录。
- **多网站接入**：生成独立嵌入代码、允许来源校验、编辑网站配置、内置测试页面。
- **管理员登录**：bcrypt 密码哈希、HttpOnly 会话 Cookie、请求来源校验、登录 / 消息频率限制；修改密码后撤销所有登录。
- **Debian 一键安装 / 升级**：Docker Compose + Caddy；可自动签发 HTTPS 证书。升级前在线备份 SQLite 和配置，启动失败时尝试回退代码。

## Debian 一键部署

支持 **Debian 12 / 13，amd64 或 arm64**。推荐至少 1 GB 内存、2 GB 可用磁盘空间；需要能访问 GitHub、npm、Docker 镜像和 Docker 官方 Debian 软件源。

在服务器终端执行（需要 root 或 sudo）：

```bash
curl -fsSL https://raw.githubusercontent.com/panhui/Kivo/main/scripts/install.sh -o /tmp/kivo-install.sh && sudo bash /tmp/kivo-install.sh
```

安装脚本自动安装 Docker 和 Compose、克隆代码到 `/opt/kivo`、生成随机管理员密码，然后启动服务。成功后会显示后台地址、账号和密码；默认地址为 `http://服务器IP:8080`。请开放服务器的 TCP 8080 端口，登录后在「账号设置」里修改密码。

默认账号为 `admin`，密码保存于服务器 `/opt/kivo/.env`。没有固定默认密码。如果服务器在 NAT 后，安装脚本检测到的地址可能是内网地址，可在安装时指定真正的访问地址：

```bash
sudo env KIVO_PUBLIC_URL=http://203.0.113.10:8080 bash /tmp/kivo-install.sh
```

将示例 IP 换为你的服务器公网 IP。`PUBLIC_URL` 必须与浏览器中访问客服后台的协议、主机、端口一致，否则登录来源检查会拒绝请求。已有安装目录时，安装脚本会退出，不会覆盖数据。

### 使用域名自动启用 HTTPS（推荐）

先将域名的 A / AAAA 记录指向服务器，并开放 TCP 80、443 端口，然后运行：

```bash
curl -fsSL https://raw.githubusercontent.com/panhui/Kivo/main/scripts/install.sh -o /tmp/kivo-install.sh && sudo env KIVO_DOMAIN=chat.example.com bash /tmp/kivo-install.sh
```

将 `chat.example.com` 换成你的域名。Caddy 会自动申请和续期证书。HTTPS 网站应使用 HTTPS 客服地址，避免浏览器阻止混合内容。证书签发需要域名解析正确、80 / 443 能从公网访问。

如果已通过 IP 部署，编辑 `/opt/kivo/.env`：

```dotenv
PUBLIC_URL=https://chat.example.com
CADDY_SITE=chat.example.com
HTTP_PORT=80
HTTPS_PORT=443
```

然后执行升级命令重新创建服务。不要删除其他已有配置。

## 一键升级

```bash
sudo bash /opt/kivo/scripts/upgrade.sh
```

升级流程：检查部署目录 → 在线备份数据库和 `.env` → 获取 `main` 分支最新代码 → 构建镜像 → 重启并等待健康检查。数据一直保存在 `/opt/kivo/data`；`.env` 和聊天记录不会被 Git 更新覆盖。重启期间聊天会短暂断开，组件会自动重连。存在本地代码修改或非线性分支时会退出，避免覆盖你的修改。

失败时会尝试用升级前代码重建旧版本；数据库不会自动回滚，以避免覆盖升级期间的新消息。如果未来版本包含不兼容的数据迁移，需按下方步骤从备份恢复数据库。

## 接入你的网站

1. 登录后台，打开 **网站接入 → 添加网站**。
2. 填写名称、允许来源、图标颜色和欢迎语。例如允许来源为 `https://www.example.com`；如使用裸域、其他子域或不同端口，请分别添加。
3. 保存后点击 **复制嵌入代码**，放在网站 HTML 的 `</body>` 前。每个网站使用自己的 `data-site`。

```html
<script
  src="https://chat.example.com/widget.js"
  data-site="后台生成的网站 ID"
  async
></script>
```

4. 打开网站，点击右下角图标发送消息；客服后台 **会话收件箱** 会实时出现会话。也可以使用后台的 **打开测试页面** 先测试。

如果网站有 CSP，请在现有策略中允许客服域名的 `script-src`、`frame-src` 和 `connect-src`；组件加载器使用内联样式，需要允许相应的 `style-src`。Socket.IO 在客服 iframe 内连接同一个客服域名。嵌入代码不包含管理员凭证。

### IP、地区与网址

- 默认 Compose 只暴露 Caddy，应用的 3000 端口不对公网开放。Caddy 提供访客地址，应用在此配置下只信任一层代理。
- 地区使用 `geoip-lite` 的本地 GeoLite 数据，**是估算结果**，可能显示国家 / 地区代码或英文城市。内网通常显示「未知 / 内网」，VPN 和代理可能使结果偏离实际位置。按 GeoLite 数据要求保留安装包中的授权和来源说明。
- 当前网址由嵌入脚本读取并上报，每隔 2 秒检测 SPA 地址变化；多标签页会显示最近一次上报的地址。
- 如再增加 CDN / 反向代理，应明确配置 Caddy 的 `trusted_proxies` 与真实客户端 IP 头，不要把应用端口直接开放并盲目信任 `X-Forwarded-For`。
- 组件会存储随机访客凭证，并收集 IP 和当前页面地址；请在你网站的隐私说明中说明这些用途。不要在页面 URL 中放置密码或其他秘密。

## 备份与恢复

在线备份（不中断聊天）：

```bash
sudo bash /opt/kivo/scripts/backup.sh
```

备份写入 `/opt/kivo/backups/时间戳/`，包括一致的 SQLite 快照（含 WAL 中已提交的数据）、`.env` 和代码版本号。备份目录和配置限制为仅拥有者可访问。建议将备份复制到另一台机器；脚本不会自动清理旧备份。

恢复会覆盖当前数据库。先选择正确的备份，并保存当前数据。以下在 root shell 中操作，将时间戳换为实际目录名：

```bash
sudo -i
cd /opt/kivo
bash scripts/backup.sh
docker compose stop app
cp backups/20261011T020000Z-1234/kivo.sqlite data/kivo.sqlite
rm -f data/kivo.sqlite-wal data/kivo.sqlite-shm
chown 1000:1000 data/kivo.sqlite
chmod 600 data/kivo.sqlite
docker compose up -d --wait
```

仅在需要时恢复备份的 `.env`。如果数据库对应旧版本，先依据备份里的 `revision` 检出匹配代码再重建服务；重新执行升级前回到 `main` 分支。

## 常用维护命令

```bash
cd /opt/kivo
sudo docker compose ps
sudo docker compose logs -f --tail=100
sudo docker compose restart
sudo docker compose down           # 停止服务，保留聊天数据与证书
```

不记录消息内容或访客凭证到应用日志。勿将 `.env`、`data/`、`backups/` 提交到 Git；项目已忽略这些文件。

## 本地开发

需要 Node.js 24+；应用使用 Node 内置 `node:sqlite`（Node 24 中仍标为实验性 API），无需单独部署数据库。

```bash
npm ci
cp .env.example .env
```

编辑 `.env`，设置：

```dotenv
PUBLIC_URL=http://localhost:3000
ADMIN_USERNAME=admin
ADMIN_PASSWORD=你自己的至少12字符密码
TRUST_PROXY=0
```

```bash
npm run dev
```

访问 `http://localhost:3000`。管理员只在数据库首次创建时初始化；已有数据时修改环境变量密码不会改变登录密码，请使用后台修改密码。

检查与测试：

```bash
npm run check
npm test
npm audit --omit=dev
bash -n scripts/install.sh scripts/upgrade.sh scripts/backup.sh
```

集成测试使用真实 HTTP / Socket.IO 连接，验证登录、来源限制、访客会话恢复、双向消息、重复消息去重、访客之间隔离、已读状态、结束 / 重开、网址更新、重启持久化、密码撤销和在线备份。GitHub Actions 还构建并启动 Docker Compose，检查 HTTP 健康状态及容器内数据库备份。

当前版本是单实例、单管理员的文本客服系统；不包含文件上传、客服分配或多管理员管理。SQLite 和内存在线状态适用于单机部署，请勿直接横向扩容多个应用容器。

## 技术栈与文档

Node.js 24 / Express / Socket.IO / SQLite / Caddy / Docker Compose。前端为原生 HTML、CSS、JavaScript，无需单独构建。

- [Docker 官方 Debian 安装文档](https://docs.docker.com/engine/install/debian/)
- [Socket.IO 服务端文档](https://socket.io/docs/v4/server-options/)
- [Node.js SQLite API](https://nodejs.org/api/sqlite.html)
- [Caddy 反向代理与真实 IP 配置](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)
