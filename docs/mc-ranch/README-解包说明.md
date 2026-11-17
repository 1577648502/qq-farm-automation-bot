# 牧场官方开发文档（从小程序缓存反推）

## 来源

QQ 小程序「经典农场」(`appId=1112386029`) 的本地缓存包：

```
~/Library/Containers/com.tencent.qqexminiprogram/Data/Library/Application Support/QQEX/miniapp/
├── temps/miniapp_pkgs/1112386029_3_<hash>_mcboot.tqapkg   # 牧场分包(含文档)
├── temps/miniapp_src/1112386029_3_<hash>/                 # 官方解包后的源码树
└── fs/<uin>/1112386029/usr/gamecaches/                    # 远程 bundle 缓存(CDN)
```

远程资源 CDN：`https://cdn-resource.nqf.qq.com/release/remote/`

## .tqapkg 格式（已逆向）

```
[4B 未知头] [文件表] [文件内容区]
文件表每项: u32 pathLen(含 \0) | path | \0 | u32 offset | u32 size
offset 是相对「文件内容区」的偏移
```

解包脚本见 `scripts/unpack-tqapkg.js`。

## 文档清单

| 文档 | 内容 |
|---|---|
| 牧场（MC_Pasture）模块——开发帮助文档 | 架构分层、场景登录时序、GM、目录结构 |
| 栏舍动物交互界面功能文档 | **最全 RPC 表**、操作注册、业务规则 |
| 牧场任务系统功能文档 | TaskInfo{scene_id:2}、BatchClaimTaskReward |
| 牧场牧草机（MCGrassMachine）功能文档 | AddFeed、容量、缺草判定 |
| 牧场商店（MCShop）功能文档 | ShopProfiles、幼崽/饲料 tab、购买 |
| 牧场仓库（MCWarehouse）功能文档 | GetBagTab/GetBag 带 global_scene_id=2 |
| 建筑升级·地块解锁·加速道具 | UpgradeBuilding/CompleteBuildingUpgrade/UnlockRegion |
| 建筑编辑与收纳 | PlaceFacility/MoveFacility/收回 |
| 牧场建筑气泡 & 动物气泡 | 状态 → 图标/文本映射 |

## 与当前实现的差距（待办）

官方 RPC 里我们**尚未实现**的：

- `PlaceAnimal` 幼崽入栏
- `CollectProduce` 收取副产品（与 HarvestRanch 不同）
- `HarvestAnimal` 单只收获出栏
- `DonateAnimal` 出售动物
- `CleanRanch` 清理单个 hazard
- `PutHazard` 放蚊子（使坏）
- `BatchUse` 装填罐头桶
- `UnlockRegion` / `CompleteRegionUnlock` / `SpeedUpRegionUnlock` 地块解锁
- `UpgradeBuilding` / `CompleteBuildingUpgrade` / `SpeedUpBuildingUpgrade` 建筑升级

建筑升级错误码（官方）：10441121 升级中 / 10441122 未竣工 / 10441125 加速道具过多 / 10441117 已满级
