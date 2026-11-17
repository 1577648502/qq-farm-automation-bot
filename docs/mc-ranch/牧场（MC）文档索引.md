# 牧场（MC）文档索引

> 所有牧场功能文档统一放在本目录 `client/assets/remote/mc/mcboot/docs/`，按内容命名。
>
> 后续新增文档请继续写入此目录，文件名需能反映模块内容（如 `栏舍交互.md`）。

---

## 总览

| 文档 | 说明 |
|---|---|
| [牧场模块开发指南.md](./牧场模块开发指南.md) | 牧场分包整体架构、ECS 分层、种植闭环、接服约定、GM 与快速上手 |

---

## 功能模块文档

| 文档 | 代码路径 | 说明 |
|---|---|---|
| [牧场仓库.md](./牧场仓库.md) | `script/gui/warehouse/` | 道具背包、GetBag / Sell / Use、页签与红点 |
| [牧场商店.md](./牧场商店.md) | `script/gui/shop/` | 幼崽 / 饲料商店、BuyGoods、auto_add |
| [牧场牧草机.md](./牧场牧草机.md) | `script/scene/grassmachine/` + `gui/grassmachine/` | 全局牧草存储、AddFeed、栏舍 HUD |
| [建筑与动物气泡.md](./建筑与动物气泡.md) | `script/scene/common/bubble/` 等 | UnitBubble 渲染、建筑 / 动物状态气泡 |
| [栏舍动物交互.md](./栏舍动物交互.md) | `scene/pasture/` + `gui/animalinteractive/` | 聚焦面板、动物详情、操作条 / 拖拽 / 一键操作 |
| [建筑升级地块解锁与加速.md](./建筑升级地块解锁与加速.md) | `scene/common/progress/` 等 | 升级/解锁倒计时、竣工气泡、TIME_SPEEDUP 加速 |
| [牧场任务系统.md](./牧场任务系统.md) | `gui/task/` | 成长/日常任务、领奖、跳转、Notify 推送 |
| [建筑编辑与收纳.md](./建筑编辑与收纳.md) | `gui/building-edit/` + `scene/unit/` | 建筑背包、放置/移动/收纳、编辑会话 |

---

## 文档约定

- **语言**：中文
- **结构**：功能文档建议 14 节（概览、架构、文件清单、UI、数据、协议、时序、事件、规则、配置、联动、边界、调试、扩展）
- **隔离**：文档描述牧场实现；与农场（`game/farm/**`）并列，勿混写
- **交叉引用**：同目录文档使用相对链接，如 `[牧场仓库.md](./牧场仓库.md)`

---

## 配图

| 文件 | 用途 |
|---|---|
| `scene-switch.gif` | 农场 ⇄ 牧场场景切换（见开发指南） |
| `plant-loop.gif` | 种植循环示意（见开发指南） |
