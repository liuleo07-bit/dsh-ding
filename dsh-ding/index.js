/**
 * dsh-ding —— 宿主半。
 *
 * 这个插件不需要宿主侧能力：提示音、事件监听和设置面板全部在浏览器半部
 * （`client.js`）完成，偏好保存在浏览器 localStorage。本模块只作为加载器
 * 组合树里的插件行存在，让 web 客户端模块名录（`dsh-client-modules`）
 * 能扫描到本包的 `dsh.client` 声明并挂载 `client.js`。
 *
 * 保持零 import：本地目录安装时包目录是符号链接，宿主侧第三方依赖
 * 可能解析不到；这里不依赖任何外部模块。
 */

/** 插件显示名（无 locale 时的兜底）。 */
export const name = 'dsh-ding';

/** 宿主半部无行为。 */
export function apply() {}
