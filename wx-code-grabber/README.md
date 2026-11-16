# 微信桌面农场 Code 抓取器 (macOS)

抓取微信「经典农场」小程序 WebSocket 握手里的 `code`，同时支持**一遍式新活动数据包抓取**。

> QQ 桌面版的小程序（`QQEXMiniProgram`）走的是同一个网关 `gate-obt.nqf.qq.com`，
> 本目录的工具同样适用。`./grab-now.sh` 默认走 protocol 模式；**默认不自动唤起农场，
> 请自己打开 QQ 农场**（加 `--trigger` 可恢复用 QQ 认的 `tencent://` 协议自动拉起，
> 实测 `mqqapi://...` 与 `open -b` 都拉不起来）。

## 一键抓 code（日常用这个）

在对话里说一声「抓」就跑它，也可以自己敲：

```bash
cd wx-code-grabber
./grab-now.sh                 # 默认 protocol 模式；注入好后**自己打开 QQ 农场**，等它出 code
./grab-now.sh --timeout 120   # 多等一会儿
./grab-now.sh --json          # 只输出一行 JSON（给程序用）
./grab-now.sh --reopen        # 自动关掉并重新唤起农场（默认不唤起，自己手动打开）
./grab-now.sh --submit        # 抓到后自动提交到 submit.config.json 配置的接口
./grab-now.sh --push          # 同 --submit（旧名，保留兼容）
./grab-now.sh --mode mitm     # 换代理抓包模式（见下）
./grab-now.sh --show          # 只看上次 mitm 模式的结果
```

### 抓到后自动提交（`--submit`）

在 `submit.config.json`（**本地凭据，已在 `.gitignore` 里，绝不进 git**）填目标接口：

```json
{
  "mode": "accounts",
  "url": "https://nc.winxxx.ggff.net/api/accounts",
  "accountId": "2",
  "startIfDown": true,
  "username": "admin",
  "password": "<登录密码>",
  "proxy": "",
  "proxyAutoFallback": true
}
```

`--submit` 会 POST 上去，并打印 HTTP 状态与响应体。两种 `mode`：

- **`accounts`（默认、推荐）**：`POST https://<域名>/api/accounts`，body
  `{"id":"<accountId>","code":"..."}`。后端 `addOrUpdateAccount` 把 code **写进账号存储**，
  账号在跑时还会 `restartAccount` 用新 code 重登农场。**这是真正"让 code 生效"的端点。**
- **`qr-check`**：`POST <url>`，body `{"code"}`，带 `x-account-id`/`x-admin-token` 头。

#### token 会自动续（服务重启也不会断）

服务端的 admin token 是**纯内存**的（`admin.js` 里一个 `Set`，登录时 `issueToken()` 签名，
**服务一重启就全清空**）。所以：

- **别把静态 token 写进配置**——每次重启都会 401。
- 配好 `username`/`password` 后，脚本的流程是：
  用 `.admin-token.json` 里缓存的 token → 若返回 **401** 就自动 `POST /api/login`
  换一个新 token → 缓存下来 → **重试提交一次**。全程无需人工干预。
- `.admin-token.json` 同样在 `.gitignore` 里。

> ⚠️ **`/api/qr/check` 是只读的，不要用它提交抓来的 code。**
> 它的实现（`core/src/controllers/admin.js:2923`）是 `MiniProgramLoginSession.queryStatus(code)`
> —— 轮询**扫码登录状态**，只返回 `Wait`/`OK`/`Used`/`Error`，**不落库、不改账号、不重启**，
> `x-account-id` 在这个接口里根本没被用到（它在免鉴权白名单里）。
> 提交后会得到 `{"ok":true,"data":{"status":"Wait"}}` 看着像成功，其实**什么都没发生**。
> 它是给 `/api/qr/create` 那个"扫码登录"流程配套的轮询接口：状态变 `OK` 时才在响应里返回
> `authCode`，由**前端**再调 `/api/accounts` 落库。我们已经有 code 了，直接走 `/api/accounts`。

环境变量可临时覆盖：`WX_SUBMIT_MODE` / `WX_SUBMIT_URL` / `WX_SUBMIT_ACCOUNT_ID` /
`WX_SUBMIT_USERNAME` / `WX_SUBMIT_PASSWORD` / `WX_SUBMIT_TOKEN` / `WX_SUBMIT_CONFIG` /
`WX_SUBMIT_TOKEN_CACHE` / `WX_SUBMIT_START_IF_DOWN`（`0` 关）/ `WX_SUBMIT_PROXY` /
`WX_SUBMIT_PROXY_AUTO`（`0` 关自动回退）/ `WX_SUBMIT_PROXY_FALLBACK`。

#### 直连不通？自动走本地代理

目标站 `nc.winxxx.ggff.net` **直连偶发超时**（`请求超时` / `HTTP 000` / `fetch failed`，
实测同刻 `baidu` 直连正常，故属目标站路由问题，不是本机网络）。

脚本现在的行为：先直连 → 若是**网络层失败**（超时/连不上，非业务报错）就**自动**改走
本机常见代理端口 `http://127.0.0.1:7897`（Clash 混合端口）重跑一次，**无需任何配置**。
日志会打印 `直连失败（请求超时）→ 回退到本地代理 ...`，结果行显示
`提交结果  : HTTP 200（直连失败，经代理 http://127.0.0.1:7897）`。

- 想固定走代理：`"proxy": "http://127.0.0.1:7897"`（或 `--proxy http://127.0.0.1:7897`）
- 想关掉自动回退：`"proxyAutoFallback": false`（或 `--no-proxy-fallback` / `WX_SUBMIT_PROXY_AUTO=0`）
- 换了代理端口：`WX_SUBMIT_PROXY_FALLBACK=http://127.0.0.1:<port>`

> 只改脚本自身的请求出口，**不会动系统/全局代理设置**。

#### 账号没在跑？会自动启动

`/api/accounts` 只在 `wasRunning` 时才 `restartAccount`——**账号本来是停的，提交 code 只会改存储、不会启动它**。
所以脚本在落库成功后会再查一次 `/api/status`：

- `connection.connected === true` → 什么都不做
- 否则 → `POST /api/accounts/<id>/start` 把它启起来

`startIfDown: true`（默认开）控制这个行为，单次可用 `--no-start` 关掉。

```bash
./grab-now.sh --timeout 90 --submit
# [grab-code] token 已失效 → 已用账号密码自动重登换取新 token，重试成功
# [grab-code] 提交返回 HTTP 200: {"ok":true,"data":{"accounts":[... "id":"2","code":"..." ...]}}
# [grab-code] 账号原本没在跑 → 已自动启动（POST /api/accounts/2/start）
# 账号状态  : 原本没在跑 → 已自动启动
```

验证是否真的生效（code 应等于刚抓到的值）：
```bash
TK=$(python3 -c "import json;print(json.load(open('.admin-token.json'))['token'])")
# 1) 账号里的 code
curl -s 'https://<域名>/api/accounts' -H "x-admin-token: $TK" | grep -o '"id":"2"[^}]*'
# 2) 账号真的连上了（connected 应为 true，昵称/等级正常，wsError 为 null）
curl -s 'https://<域名>/api/status' -H "x-admin-token: $TK" -H 'x-account-id: 2'
# 3) 日志（GET /api/logs?accountId=2&limit=40）应有
#    账号 X 进程退出 → 正在启动账号 → 登录成功: <昵称> (Lv..) → 正常跑农场自动化
```
> ⚠️ 只看 `/api/accounts` 的 code 变了还不够——**要确认账号 `connected: true`**。
> 账号若本来就是停的，提交 code 不会让它跑起来（脚本会自动 `start`，见上）。
> 另外 `/api/logs` 是**内存日志**，服务一重启就清空；账号没在跑时该账号日志也会是空数组。

### 默认：protocol 协议注入法（推荐，零权限 + 零代理）

复用机器人自带的 `core/src/services/protocol-code-capture.js`，由 `grab-code.js` 驱动：

1. 清掉旧的 `_code.txt`
2. 往农场缓存 `miniapp/temps/miniapp_src/1112386029_3_*/game.js` 注入一段 `qq.login()` 嗅探
   （把 code 写进小程序用户目录的 `_code.txt`，并同时写系统剪贴板）
3. **等你自己打开「QQ农场」小程序**（不关已在跑的实例、不自动拉起；
   加 `--trigger` 可恢复"先关掉再用 `tencent://` 唤起"的旧行为）
4. 只认「本次新写入的 `_code.txt`」（按 mtime 过滤，**不读剪贴板**，避免读到残留值）
5. `finally` 还原 `game.js`（`.bak`）

> ⚠️ **农场更新版本时，注入会"白打"**：客户端启动瞬间会下载新版本到**新的缓存目录**
> （`miniapp_src/1112386029_3_<新hash>`）并改用它，我们注入的旧目录被丢弃 → 一直等不到 code
> （表现为超时，`_code.txt` 的 mtime 还是上次的）。
> 判别：`miniapp_src` 里出现了一个当天新建的 `1112386029_3_*` 目录，且它的 `game.js` 大小和旧的
> 不一样、没有 `.bak`。
> 对策（脚本已内置）：等待期间每 3s 数一次缓存目录数，变多了就**重新注入新目录**（最多 3 轮），
> 默认模式下会提示你手动退出并重进农场；`--trigger` 模式则自动关掉再唤起。
> 所以更新当天第一次可能多花十几秒，之后就正常了。

**为什么必须让 QQ 去开**：QQ 小程序宿主 `QQEXMiniProgram`（真身在
`~/Library/Group Containers/FN2V63AD2J.com.tencent/qqex/mac-shell/<版本>/`）
是 Electron 应用，**必须由 QQ 父进程通过 IPC 拉起**；独立启动会打印
`Mac: no IPC connection after timeout, exiting silently (direct launch)` 然后自退。
实测有效的只有 `tencent://` 协议（`mqqapi://...`、`open -b com.tencent.qqexminiprogram`
都拉不起来农场）。

注意：

- 嗅探脚本会**把 code 写进系统剪贴板**（项目原有行为），会覆盖你当前的剪贴板
- **QQ 会复用未过期的 login code**：短时间内重复抓可能拿到同一个 code，属正常，隔一会再抓就会变
- 退出码：`0` 抓到 / `2` 超时 / `3` 找不到缓存或 `game.js`

### 备用：mitm 代理抓包法（`--mode mitm`）

不想动小程序缓存时用。流程：备份系统代理快照 → 起 mitmdump（默认 `WX_BLOCK=1`
**拦截握手**，code 在到达服务器前被拦下 → 未被消费）→ 代理指向 `127.0.0.1:38127` →
拿 code → 还原代理 + 关 mitmdump（`--keep-proxy` 可跳过还原）。

**默认不自动唤起农场，请自己打开 QQ 农场**（要旧行为加 `--trigger`）。

附加参数：`--trigger`（自动唤起农场）、`--no-block`（不拦截）、`--push`
（抓到后 POST 到机器人，需 `WX_SERVER_URL`/`WX_ACCOUNT_ID`/`WX_ADMIN_TOKEN`；
注意脚本一放手客户端重连就会消费这个 code，所以喂机器人必须在拦截期间完成）。

会话产物在 `/tmp/wx_grab/<时间戳>/`：`code.log`、`events.log`（含**脱敏**握手 URL，
`code` 替换为 `<code>`，可看出平台：实测 `...&platform=qq`，即 QQ 侧农场）、
`mitmdump.log`、`proxy-backup/`。环境变量：`WX_NET_SERVICE`（默认 `Wi-Fi`）、
`WX_PROXY_PORT`（默认 `38127`）、`WX_GRAB_TIMEOUT`（默认 `90`）、`WX_TRIGGER_CMD`、`WX_BLOCK`。

### 想更自动（可选）

- **常驻定时刷新**：走下面的 `run.sh` + `WX_REFRESH_SEC`（系统代理长期指向本机，每 N 秒自动掐线刷新 code）
- **零手势触发**：需要给运行环境授予「辅助功能」权限，再用 `focus-refresh.sh` 的 hide/show 机制。
  实测本机该权限**未授予**（osascript 调 System Events 直接 AppleEvent 超时 `-1712`）。
  不过默认的 protocol 模式本来就不需要它。


## 抓新活动数据包（推荐，一遍抓完）

用 `capture-activity.sh`，一条命令完成：

1. 备份并设置系统代理，启动 mitmdump；
2. 等待新的农场 WS 连接；
3. 从首条 `ws_open` 开始定时抓取；
4. 停止后自动恢复代理；
5. 解密原始帧并生成接口清单。

```bash
cd wx-code-grabber
./capture-activity.sh 中秋活动
./capture-activity.sh 中秋活动 --duration 240
./capture-activity.sh 中秋活动 --trigger
```

默认行为：

- **不自动唤起农场**，请自己打开 QQ 农场；脚本在等新 WS 连接（`--trigger` 可恢复自动重开）。
- 微信版无法可靠自动重开。等待超时前请**手动退出并重新进入「经典农场」**。
- 检测到 `ws_open` 后默认再抓 **180 秒**。操作完成后不用一直守着，时间到会自动停止；想提前结束仍可按 `Ctrl-C`，已抓内容会正常进入解密流程。
- 默认同时开启实时解码。正式产物以停止后的完整解密为准，实时滚动内容只用于确认抓到帧。

操作时把新活动的**每个页面和动作都点一遍**（列表、领取、兑换、任务等）。addon 会从每帧未加密的 meta 中解析接口名，自动打两类标记：

- **首次出现**的每个接口 → `⚡ 首次 gamepb.xxx...`（新活动接口一露头就有标记）
- **每次命中关键动作**的请求（默认 `Operate,GetGroup,Share,Claim,Buy,Report,Use`）→ `⚡ gamepb.activitypb.ActivityService.Operate`，你点"领礼包/送爱心"那一刻终端实时打印对应标记
- 想改关键动作清单：`WX_AUTOMARK_KEYS='Operate,Share' ./capture-activity.sh 活动名`（空串=关闭动作标记）
- 仍可手动 `./mark.sh 描述` 补充纯语义标记（如"点击了领取按钮"）

停止后会在 `captures/` 一次生成三个文件：

- `<时间>_<活动名>.jsonl`：原始帧和 WS 事件，永久保留，后处理失败也不会丢；
- `<时间>_<活动名>.decoded.jsonl`：解密后的完整结构化记录（含 `key`、meta、字段）；
- `<时间>_<活动名>.summary.txt`：完整解码输出和控制台接口清单。

已有抓包也可以离线解密，不需要重新启动代理或发起网络请求：

```bash
cd wx-code-grabber
./capture-activity.sh --decode captures/20261018-095056_3级以上抓包.jsonl
./capture-activity.sh --decode-latest
./capture-activity.sh --decode-latest --captures-dir /path/to/captures
```

`--decode-latest` 会按修改时间选择最新的原始 `.jsonl`，并自动排除已经生成的
`.decoded.jsonl`。也可以直接在 `core` 目录调用解码器：

```bash
cd core
node scripts/ws-capture-decode.js --capture ../wx-code-grabber/captures/xxx.jsonl
node scripts/ws-capture-decode.js --latest ../wx-code-grabber/captures
```

两种入口都会根据原文件名生成同名的 `.decoded.jsonl` 和 `.summary.txt`。
原始抓包始终保留，不会被删除或覆盖；解密结果先写临时文件，成功后才原子替换目标文件。
空包、无游戏帧、解密失败或汇总写入失败时会返回非零退出码，并打印原始包路径和可直接重试的完整命令。

接口清单包含：

- 时间线标记（⚡自动 + ■手动）
- 全部 `service.method` 统计（出现次数）
- **★ 项目未实现的新接口**——自动比对 `core/src` 已实现接口（支持常量调用识别），抓包里出现但项目没有的就是新活动接口，优先逆向这些
- 解码时相邻帧间隔超 2s 自动插"空闲"分隔线（`--gap-secs 0` 关闭），不用标记也能看出操作边界

活动抓包默认同时记录所有 HTTP/HTTPS 请求，产物为
`<时间>_<活动名>.http.jsonl` 和 `.http.summary.txt`。微信宿主、游戏圈页面或
普通 Web API 的领取请求不会再因为只监听 `nqf.qq.com` 而漏掉；URL、请求头、
请求体和响应体中的 `code/token/cookie/authorization/ticket/session` 等敏感值
会替换为 `<redacted>`。只想抓农场 WS 时可加 `--no-http-all`。

看某个新接口的详细字段（在 `core` 目录执行，filter 词会自动给出）：

```bash
node scripts/ws-capture-decode.js --in ../wx-code-grabber/captures/xxx.jsonl --filter GetRewardList
# 解码结果落盘
node scripts/ws-capture-decode.js --in ../wx-code-grabber/captures/xxx.jsonl \
  --out data/ws-decoded.jsonl --summary --overwrite
```

`capture-activity.sh` 常用参数：

- `--duration <秒>`：首条 `ws_open` 后抓多久，默认 180；`0` 表示只用 `Ctrl-C` 手动停止
- `--wait <秒>`：等待新 WS 连接多久，默认 60
- `--trigger` / `--no-trigger`：开启/关闭 macOS QQ 自动重开（**默认关**，自己手动打开农场）
- `--live` / `--no-live`：开启/关闭实时解码
- `--summary` / `--no-summary`：开启/关闭结束后自动解密和汇总
- `--decode <文件>`：只解密指定原始抓包，不启动代理
- `--decode-latest`：只解密 `captures/` 中最新的原始抓包
- `--captures-dir <目录>`：指定抓包目录，配合 `--decode-latest` 使用

对应环境变量：

- `WX_LIVE_DECODE=1`（默认）抓包同时实时解码滚动显示，`0` 关闭
- `WX_AUTO_DECODE=1`（默认）停止后自动解密并运行 `--summary`，`0` 关闭
- `WX_CAPTURE_SECONDS`、`WX_CONNECT_TIMEOUT`、`WX_AUTO_TRIGGER`：分别对应时长、等待时间、自动触发（默认 `0`，不自动唤起）
- `WX_CAPTURE_DIR` 抓包文件目录，默认 `wx-code-grabber/captures`

注意：抓活动期间脚本自动把 `WX_REFRESH_SEC` 置 0（不掐线）、`WX_BLOCK` 置 0（不拦截），避免中途断连丢帧。

退出码：`0` 抓到并处理成功；`2` 未连上/进程异常/未抓到游戏帧；`3` 代理或解密失败；`130` 在开始抓帧前手动取消。

## 抓取登录 code（原用途）

### 当前方案：mitmproxy 抓包（推荐）

用无头 `mitmdump` 做本机代理，解密微信到 `gate-obt.nqf.qq.com` 的流量，
提取 WS 握手 URL 里的 `?code=...`，写日志并可选 POST 到服务器。

> 之前的 frida 方案 (`grab.py`) 因 Apple Silicon + SIP 无法注入 (即使 sudo)，已弃用。

### 依赖

```bash
brew install mitmproxy   # 已安装 mitmproxy 12.x -> /opt/homebrew/bin/mitmdump
```

### 首次配置（只需一次）：信任证书

```bash
./setup-cert.sh          # 会要求输入管理员密码, 把 mitmproxy CA 设为系统信任
```

### 运行

```bash
./run.sh                 # 默认 Wi-Fi, 端口 38127; 自动设/复原系统代理
```

提交给机器人（抓到 code 后 POST 到 `/api/accounts` 更新账号 code 并自动重启）：
```bash
WX_BLOCK=1 \
WX_SERVER_URL=https://nc.winxxx.ggff.net/api/accounts \
WX_ACCOUNT_ID=1 \
WX_ADMIN_TOKEN=<你的 admin token> \
./run.sh
```
addon 会把捕获的 code 以 `{"id":"1","code":"..."}` POST 过去（带 `x-admin-token`
/ `x-account-id` 头）。机器人 `addOrUpdateAccount` 把 code 写进账号，若账号
正在运行则 `restartAccount` 用新 code 重登农场。终端会打印上报的 HTTP 状态
与响应体（`ok:true` 即成功）。

> **两个提交端点别搞混**：
> - `/api/accounts`（`mode=accounts`，**提交抓到的 code 用这个**）：body `{"id":"<账号>","code":"..."}`
>   → 落库 + 在跑时 `restartAccount` 重登。**只有它能改账号里的 code。**
> - `/api/qr/check`（`mode=qr-check`，**只读，别用来提交**）：`queryStatus(code)` 轮询扫码状态
>   （`Wait/OK/Used/Error`），不落库、不改账号。它是 `/api/qr/create` 扫码登录流程的配套轮询接口，
>   状态 `OK` 时才在响应里返回 `authCode`，由前端再调 `/api/accounts` 落库。

其它环境变量：
- `WX_NET_SERVICE`  网络服务名，默认 `Wi-Fi`（有线用 `Ethernet`）
- `WX_PROXY_PORT`   代理端口，默认 `38127`
- `WX_SERVER_URL`   机器人提交端点，建议 `https://<域名>/api/accounts`
- `WX_ACCOUNT_ID`   目标账号 id（作为 `body.id` 与 `x-account-id` 头）
- `WX_ADMIN_TOKEN`  管理 token（`x-admin-token` 头，`/api/accounts` 必须）
- `WX_POST_UNUSED_ONLY`  默认 `1`，只上报被拦截的未消费 code；`0` 则全部上报
- `WX_POST_COOLDOWN_SEC` 上报节流秒数，默认 `30`；拦截时小程序疯狂重连会连续吐 code，冷却窗口内只提交 1 次
- `WX_REFRESH_SEC`  定时强制重连周期秒数，默认 `300`（5 分钟）；`0` 关闭
- `WX_BLOCK`        是否拦截握手使 code 不被消费，默认 `0`（关）；提交给机器人时建议开
- `WX_RUN_DURATION` 让 `run.sh` 启动后自动停止的秒数，默认 `0`（手动停止）
- `WX_PROXY_SNAPSHOT_DIR` 原代理配置备份目录；退出时会恢复 HTTP/HTTPS、PAC 和 bypass 例外
- `WX_KEEP_PROXY=1` 仅供调试，退出时不恢复系统代理

### 自动每 5 分钟刷新 code（核心机制）

新 code **只在小程序发起新 WS 握手时产生**。小程序连上农场后会保持**同一条长连接**，
不再握手，所以平时不会有新 code（只有手动重开农场才有）。

本 addon 记录农场 WS 的建立时间，每隔 `WX_REFRESH_SEC` 秒（默认 300）把这条连接
**主动 kill 掉**；小程序检测到断线会**自动重连**，重连时 `wx.login` 生成新 code，
被我们捕获。**全程无需手动重开农场。**

前提：小程序在断线后确实会自动重连（游戏类小程序基本都会）。请先测试确认：
保持农场页面打开，等约 5 分钟，看 `/tmp/wx_mitm_code.log` 是否自动多出一条新 code。

### 关于拦截 `WX_BLOCK`（与定时重连互斥）

`code` 单次使用：客户端那条握手一旦真正到达服务器就被消费。若要让**机器人**拿到未被
消费的 code，可开 `WX_BLOCK=1`，在转发前返回 403 拦下握手。但这样小程序无法建立长连接，
**定时重连机制随之失效**（没有连接可 kill）。因此两者互斥，按需二选一。

启动后：**在微信里退出并重新进入「经典农场」**（已连接的旧连接不会重新握手，
必须新建连接才带新 `code`）。抓到后：
- 终端打印 `[wxcode] 捕获 code=...`
- 追加写入 `/tmp/wx_mitm_code.log`（每行一条 JSON）
- 若设了 `WX_SERVER_URL`，POST `{"code","host","source","ts"}`

按 `Ctrl-C` 退出，会自动恢复系统代理。

### 文件

- `grab-now.sh`    一键抓 code 入口（默认 protocol 协议注入；`--mode mitm` 走代理抓包）
- `grab-code.js`   protocol 模式实现（注入 qq.login() 嗅探 + tencent:// 唤起农场 + 读 _code.txt）
- `capture-activity.sh` 一遍式新活动抓包（推荐入口）
- `mark.sh` 抓包时间线打标记（配合 capture-activity.sh）
- `mitm_addon.py`  mitmproxy addon：匹配 `nqf.qq.com`、提取 code、去重、写日志/上报、WS 帧抓取、时间线事件
- `run.sh`         设系统代理 + 启动 mitmdump + 退出时恢复（被 capture-activity.sh 复用）
- `setup-cert.sh`  一次性信任 mitmproxy CA
- `captures/`      抓包会话输出目录

### 注意

- 若微信对 `gate-obt` 做证书固定 (pinning) 会解密失败；已用 Proxyman 手动验证过可解密，本方案同理可行。
- `code` 单次使用；每次需要新 code 都要触发一次新的 WS 握手（重新进入农场）。

## 旧方案（已弃用）：frida `grab.py`

`grab.py` 用 frida 注入 WeChatAppEx，hook `SSL_write` + 内存扫描。
在本机 (M4 + macOS 26 + SIP 开启) 下 `task_for_pid` 被系统拦截，无法注入，保留仅作参考。
