/**
 * 会话总览面板的宿主半侧：纯 UI 插件，宿主侧没有任何行为。
 *
 * 空的 apply 只为让这个插件出现在 profile 的 Loader 组合里；浏览器半侧通过
 * package.json 的 `dsh.client` 声明发现，由宿主把 exports["./client"] 作为
 * bundle 提供给 Web GUI。
 */

/** 宿主插件体 —— 无宿主侧行为。 */
export function apply() {}
