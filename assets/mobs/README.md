# mobs

`{id}_idle.png` 是第 0 帧。`{id}_walk_{1|2}.png`、`_attack_`、`_death_` 是短序列，画布和静帧一样。

| tier | 画布 |
|---|---|
| normal | 128×128 |
| elite | 160×160 |
| boss | 256×256 |

id 来自 `MONSTERS`（含长局 `boss_03`）。锚点是底边中点。空中单位的翼要宽过身体。死亡帧缺了不回退到 `_idle`。
