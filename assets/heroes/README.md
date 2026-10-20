# heroes

`{id}_idle.png`，画布 **128×128**。走路、攻击、死亡是 `{id}_walk_{1|2}.png`、`_attack_`、`_death_`。

id：`hero_warrior`、`hero_mage`、`hero_ranger`、`hero_paladin`。

窄身体加一把武器。不要画队伍色，队伍色由底座环表示。不要在 PNG 里画英雄光（`#ffd68a`），那一圈由渲染器只描在英雄上。死亡帧缺了用灰色剪影，不回退到站立静帧。
