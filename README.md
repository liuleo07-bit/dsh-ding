# dsh-ding

[![tests](https://github.com/liuleo07-bit/dsh-ding/actions/workflows/tests.yml/badge.svg)](https://github.com/liuleo07-bit/dsh-ding/actions/workflows/tests.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> 给 [DeepSeek Harness](https://github.com/deepseek-ai) 桌面版（Web GUI）用的「叮」提示音插件：
> **需要你操作**、或**当前回合结束**时播放提示音，免得你一直盯着屏幕。

一个纯客户端插件，约 20 KB，零依赖、不联网、不落盘音频——声音用 Web Audio 实时合成。

## 行为

| 时机 | 触发场景 | 默认音型 |
| --- | --- | --- |
| **需要你操作** | 助手向你提问（`ask_user_question`）、请求审批（权限确认）、请你确认执行计划 | 叮——咚（两声，峰值 0.5） |
| **阶段任务完成** | 当前对话的这一轮助手工作结束 | 单声长叮（峰值 0.42） |

- 只提醒**你正在查看的那个对话**：后台会话、子代理不会乱响。
- 同一件事不会连响两次（例如「提问后本轮也结束」只响提示音一次）。
- 声音可调：开关 / 音量 / 音色（叮咚、单音）——设置 → 提示音。

## 安装

### 1. 拿到代码

```bash
git clone https://github.com/liuleo07-bit/dsh-ding.git
cd dsh-ding
```

### 2. 装进 DeepSeek Harness

插件是本地目录形式（`dsh-ding/` 子目录），两种装法任选：

**A. 插件管理器（推荐）**

1. 打开 DeepSeek Harness → 左侧栏 **插件（Plugins）**
2. **添加插件** → **安装第三方插件**
3. 填 `<仓库目录>/dsh-ding` 的绝对路径，点安装
4. 列表里出现「提示音 / Ding」即成功

**B. 命令行**

```bash
# 默认安装路径下 DSH 自带的 CLI；PATH 里有 dsh 就直接用 dsh
dsh plugin --profile desktop add "<仓库目录>/dsh-ding"
```

Windows 用户也可以直接双击仓库里的 `安装提示音插件.cmd`（会自动查找 DSH 安装位置；
自定义安装路径时先 `set DSH_CLI=<...>/dsh.cmd`）。

装完如果界面里没立刻出现「提示音」，**完全退出并重开 DeepSeek Harness** 即可；
正常情况几秒内会热更新。

## 使用

**设置 → 提示音**（设置弹窗左侧导航最后一项）：

- 需要我操作时 —— 开关
- 阶段任务完成时 —— 开关
- 音量 —— 0~100（默认 100；旧版 v1 偏好会自动迁移并提到 100）
- 音色 —— 「叮咚（柔和）」/「单音（清脆）」
- 试听按钮 —— 不用等真实事件；音量低于 60 时试听也按 60 播

## 卸载

- 插件管理器里关掉开关（立即静音）或卸载；或
- `卸载提示音插件.cmd` / `dsh plugin --profile desktop remove dsh-ding`
- 手动兜底：从 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 移除 `dsh-ding`

## 目录

```
.
├─ dsh-ding/                 # 插件包（安装目标）
│  ├─ package.json           # dsh.bundle.patch + dsh.client 声明
│  ├─ cordis.patch.yml       # 把插件行插入组合（id/name = dsh-ding）
│  ├─ index.js               # 宿主半：空 apply()，零依赖
│  ├─ client.js              # 浏览器半：状态监听 + 合成音 + 设置面板
│  ├─ locale/{zh,en}.json    # 插件管理器里的名称/说明
│  └─ icon.svg               # 图标
├─ tests/                    # Node 测试（28 条）
├─ 安装提示音插件.cmd
└─ 卸载提示音插件.cmd
```

## 测试

```bash
node --test tests/*.test.mjs
```

测试用 `node:vm` 沙箱 + 假 `window` / `localStorage` / `AudioContext` / `ctx`，
覆盖：触发时机、去重、320ms 延迟、开关、音量、v1→v2 迁移、音色、会话切换、
设置面板、注销清理，以及 manifest 打包契约。

## 技术说明

- 事件源：客户端 `uiSession.sessionStatus`（`Map<sessionId, {running, pendingInteraction}>`）
  与 `uiSession.current`（当前主视图会话 id）。`pendingInteraction` 由提问、审批、
  计划确认三种卡片共同投射，所以一处监听覆盖全部「需要我操作」。
- 回合完成判定：`running` 由 `true → false` 且该会话没有待处理交互；延迟 320ms 发声，
  给同一时刻到达的 pending 让路，避免双响。
- 音频：`AudioContext` 振荡器 + 指数包络；基频 + 高八度泛音 + 低八度垫音，
  每音符峰值 ≤0.8，不破音。
- 偏好：`localStorage['dsh-ding.preferences.v2']`；v1 键存在时会迁移并强制音量 100。
- 为什么不用宿主 `Config`/`configForms`：插件以本地目录（`link:`）方式安装后，
  宿主半零 import 才能避开符号链接下的依赖解析问题，所以设置面板用 `localStorage`。
- 客户端 bundle 必须是**经典脚本**（不能有 JSX/TS/import/export），
  `window.__ModuleLoader__.load({id, factory})` 里的 `id` 必须等于包名 `dsh-ding`。

## 兼容性

在 DeepSeek Harness 0.2.1-rc.5（Windows 桌面版）验证通过。契约依赖
`dsh-client-ui-session` 的 `uiSession` 服务与 `dsh-client-ui-settings` 的
`settings.section` 插槽；宿主版本差异过大时可能失效。

## License

[MIT](LICENSE)
