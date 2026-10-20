# towers

`{id}_lv{1|2|3}.png`，画布 **192×192**。攻击和倒塌是 `{id}_lv{n}_attack_{1|2}.png`、`_death_{1|2}.png`。塔不走路。

id 来自 `src/data.js` 的 `TOWERS`：`tw_arrow`、`tw_cannon`、`tw_frost`、`tw_static`。

锚点是底边中点。Lv2 / Lv3 必须比上一级多一块构件。缺某一级就画剪影，不借用其他等级。死亡帧缺了不回退到该级静帧。

工事箭塔不复用静帧，画成比 TD 塔更矮的门楼剪影。
