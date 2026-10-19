# assets

战场静帧。规则在 [`docs/art/DIRECTION.md`](../docs/art/DIRECTION.md)（对齐设计文档 §14.4–§14.6）。

运行时按键找文件：`assets/{key}.png`。加载成功就画这张图，锚点是单位图的**底边中点**、地块图的**中心**。找不到或加载失败就画 P0 剪影，不改玩法。

| 目录 | 文件 |
|---|---|
| `towers/` | `{id}_lv1.png` `{id}_lv2.png` `{id}_lv3.png`（192×192） |
| `mobs/` | `{id}_idle.png`（普通 128² / 精英 160² / Boss 256²） |
| `heroes/` | `{id}_idle.png`（128×128，不画队伍色） |
| `tiles/` | `tile_a.png` `tile_b.png` `path.png` `swamp.png` `lava.png`（64×32） |

重画这批静帧：`node tools/paint-stills.mjs`。
