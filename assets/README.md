# assets

战场静帧和短序列。规则在 [`docs/art/DIRECTION.md`](../docs/art/DIRECTION.md)，北极星在 [`docs/art/NORTH_STAR.md`](../docs/art/NORTH_STAR.md)。

运行时按键找文件：`assets/{key}.png`。锚点是单位图的**底边中点**、地块图的**中心**。找不到或加载失败就画 P0 剪影。死亡帧缺失不回退到站立静帧。

| 目录 | 静帧 | 短序列 |
|---|---|---|
| `towers/` | `{id}_lv1.png` `_lv2` `_lv3`（192×192） | `{id}_lv{n}_attack_{1\|2}` `_death_{1\|2}`。塔不走路 |
| `mobs/` | `{id}_idle.png`（普通 128² / 精英 160² / Boss 256²） | `{id}_walk_{1\|2}` `_attack_` `_death_`（键里没有 `_idle`） |
| `heroes/` | `{id}_idle.png`（128×128，不画队伍色，不画英雄光） | 与怪相同的三段 |
| `tiles/` | `tile_a.png` `tile_b.png` `path.png` `swamp.png` `lava.png`（64×32） | 无 |

小文件、单独 PNG，不打大图集。重画：`node tools/paint-stills.mjs`。
