# 协议观察：自动发现游戏更新

> 目标：游戏更新活动时**不用再手动 mitmproxy 抓包**。机器人自己边跑边记，
> 更新一上线就能告诉你"多了哪些接口、哪些字段、哪个玩法的数据体没定义"。

## 为什么能做到

以前必须手动抓包，是因为假设"只有代理才能看到协议"。实际上有两点被忽略了：

1. **机器人跑着就在收发同一批帧**（同一条 `gate-obt.nqf.qq.com` 连接）；
2. **它手里的请求体是加密前的明文**。`network.encodeMsg()` 是"先拿明文 body，
   再 `cryptoWasm.encryptBuffer()`"。mitmproxy 抓 `C->S` 只能拿到密文，
   反而是机器人这边看得更全。

所以观察器挂在 `network.js` 的两个位置即可，不需要代理、证书、辅助功能权限：

| 位置 | 拿到什么 |
|---|---|
| `encodeMsg()` 加密之前 | 请求明文（C→S） |
| `handleMessage()` 解出 `GateMessage` 之后 | 响应 / 推送明文（S→C） |

## 它记录什么

不记录具体数值（那会是巨大的流量），而是记录**字段结构指纹**：

```
1:0 / 1.1:2 / 1.2.126:2 / ...     ← 字段号 + wire type，递归到 6 层
```

指纹跨账号、跨时间可比。**指纹出现新路径 = 服务端协议结构变了**，也就是有新东西。

除此之外，对 `ActivityService.List` 额外做结构化提取：

- 活动组 / 子活动的 id、名称、type、status、起止时间；
- 每个子活动用的是 `ActivityData` 的哪个字段号；
- 该字段号在 `.proto` 里**有没有定义**。

最后一点很关键。现有 proto 里没写的字段，protobufjs 解码时会**静默丢掉**，
所以不能只靠反射判断。观察器另走一遍裸 wire（`utils/wire.js`），
以实际字节为准 —— 2026-11-18 的「故友重逢」用的 `ActivityData#109` 就是这么被发现的
（当时 proto 里根本没有 109，只靠反射完全看不到）。

## 怎么用

### 什么都不用做

观察器默认开启，账号跑起来就开始采集。产出在：

```
core/data/protocol/catalog-<账号>.json   # 每账号一份（worker 之间不会互相覆盖）
core/data/protocol/baseline.json         # 基线（共享）
```

### 命令行看结论

```bash
pnpm proto:report                 # 汇总：活动结构 / 新接口 / 新字段
pnpm proto:report --activity 牧歌  # 按活动名或 ID 搜
pnpm proto:report --key ActivityService.List        # 某接口的字段树
pnpm proto:report --key FacilitiesNotify --strings  # 只抽可读字符串（规则文案在这）
pnpm proto:report --json          # 给别的脚本用
```

### 面板

侧边栏「协议观察」页（`web/src/views/ProtocolObserver.vue`），内容和命令行一致。

### 关键操作：「以此为准」

处理完一次更新后点一次（或 `pnpm proto:freeze`）。它把当前状态冻结成基线，
之前的差异全部归零 —— 之后只报真正的新变化。

**不冻结会怎样**：所有接口永远显示"新"，看几次就麻木了。

## 工作流建议

游戏更新当天的顺序：

```bash
pnpm proto:report                 # 1. 先看有没有变化
pnpm proto:report --activity XXX  # 2. 新玩法看字段号，对照 proto 补定义
pnpm proto:report --key <新接口>   # 3. 看具体字段结构，写解析
# ... 补完 .proto / 服务层代码、跑测试 ...
pnpm proto:freeze                 # 4. 确认正常后冻结基线
```

## 和抓包工具的关系

`wx-code-grabber/` 那套仍然有用，但分工变了：

| 场景 | 用什么 |
|---|---|
| 日常发现"更新了什么" | 协议观察器（自动、零操作） |
| 首次登录 / code 失效 | `grab-now.sh`（本来就要这条链路） |
| 需要**特定操作顺序**的完整会话 | `capture-activity.sh`（脚本能逐帧标注你点了什么） |

换句话说：抓包从"每次都做"降级成"排查特定交互顺序时才做"。

## 开关与开销

| 项 | 说明 |
|---|---|
| `FARM_PROTOCOL_OBSERVER=0` | 完全关闭观察器 |
| `FARM_PROTO_LOG=1` | 每出现一个新接口，在控制台打一行 `[proto] + xxx` |
| 内存 | 每接口上限 600 条字段路径 / 4 条样本 |
| 落盘 | 每 5 秒或有变化时原子写一次；样本单条最多 8 KB |
| 失败隔离 | 观察器内部吞异常，任何采集失败都不影响收发 |

## 已知边界

- **看不到客户端本地逻辑**。它只反映"服务端发了什么"，不是反编译客户端。
  客户端 RPC 名在 `game.js` 里是加密的（`_Аce_7716`），这套机制不依赖它。
- **推送也在采集**（很多玩法状态只走推送不请求），但推送没有"该方法"的概念，
  统一记成 `[Notify] <type>`。
- **基线是结构快照，不判语义**。它告诉你"这里多了个字段"，不告诉你"这个字段是次数还是时间"，
  后者仍然要看抓包/实测 —— 见 `.workbuddy/skills/qq-farm-proto-reverse`。
