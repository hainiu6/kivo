# 地区数据来源

`dbip-country-lite.mmdb.gz` 是 DB-IP.com 的 IP to Country Lite 月度数据库，覆盖 IPv4 / IPv6。

- 数据来源及下载：[DB-IP Lite](https://db-ip.com/db/lite.php)
- 许可：[Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/)
- 日期、原始下载地址、压缩文件 SHA-256：见 `manifest.json`。数据库保持原始压缩文件，未修改。
- 页面显示地区的地方提供 DB-IP 来源链接；旧库城市信息仅在国家一致时保留，geoip-lite 包内的 MaxMind 数据及授权说明保留。

维护者可执行 `npm run geoip:update -- YYYY-MM` 更新本地数据库与清单，运行测试后随新版本发布。应用查询全部在本地完成，不向外部服务上传访客 IP。
