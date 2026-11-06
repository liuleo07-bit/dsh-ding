# dsh-ding 测试

只读的自动化测试：在 `node:vm` 沙箱里执行浏览器半 `../dsh-ding/client.js`，
用假 window / localStorage / AudioContext / 定时器 / ctx 验证「叮声逻辑」，
另外校验 manifest 契约（package.json / cordis.patch.yml / locale / icon.svg / index.js）。

## 运行

```bash
# 仓库根目录
node --test tests/*.test.mjs
```

> 在受限沙箱里如果 `node:test` 默认的「每个文件一个子进程」被拒绝（spawn EPERM），
> 可关闭按文件隔离、同进程运行：
>
> ```bash
> cd tests
> node --test --test-isolation=none
> ```
>
> Node 24 不支持 `--test <目录>` 参数（`ERR_UNSUPPORTED_DIR_IMPORT`），用上面的
> 「进入 tests 目录 + 无参数」或 `tests/*.test.mjs` glob 形式。

## 文件

| 文件 | 内容 |
| --- | --- |
| `harness.mjs` | vm 沙箱 + 假浏览器/音频/定时器/ctx/React 垫片 + 断言辅助（不是测试文件，不会被 `node --test` 匹配） |
| `client-ding.test.mjs` | 客户端行为测试：基线静音、需要操作/完成音型、去重、延迟、开关、音量（含默认 100 / v1→v2 迁移 / 试听下限）、音色、会话切换、设置面板、注销清理、无 AudioContext 降级 |
| `manifest.test.mjs` | manifest / 打包契约测试：package.json、cordis.patch.yml、locale、icon.svg、index.js |

当前共 28 条测试，全部通过。

## 音型判定

- `noteCount`：把 oscillator `start(at)` 按「连续相同起始时间」分组后的组数（= 音符数）。
- `oscillatorCount`：`createOscillator()` 次数（= partial 层数）：chime 每音符 3 层，ping 每音符 1 层。
- 期望：chime needsInput = 2 音符 / 6 oscillator（峰值 0.5）；chime turnDone = 1 / 3（峰值 0.42）；
  ping needsInput = 2 / 2；ping turnDone = 1 / 1（峰值 0.5 / 0.45）。
