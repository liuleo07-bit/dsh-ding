/**
 * dsh-ding 客户端半（client.js）行为测试。
 *
 * 覆盖：模块契约、基线静音、需要操作/完成音型、去重、延迟、开关、音量、
 * 音色、会话切换、设置面板注册与组件、注销清理。
 *
 * 运行（本机沙箱禁止 node:test 默认的“每文件一个子进程”，故需关闭隔离）：
 *   cd ding-plugin\tests
 *   & $node --test --test-isolation=none
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createHarness,
  preferencesStorage,
  legacyPreferencesStorage,
  expectPattern,
  expectSilent,
  describeSummary,
  flattenText,
  findAll,
  hasFrequency,
  DONE_DELAY_MS,
  STORAGE_KEY,
} from './harness.mjs';

const SESSION = 'session-1';
const RUNNING = { [SESSION]: { running: true } };

function fresh(options = {}) {
  const harness = createHarness({
    statuses: RUNNING,
    ...options,
  });
  harness.install();
  return harness;
}

function pending(key = 'q1', kind = 'question') {
  return { key, sessionId: SESSION, kind };
}

// ---------------------------------------------------------------------------
// 1. 模块契约
// ---------------------------------------------------------------------------
test('client.js：__ModuleLoader__.load 只调用一次，factory 读取 localStorage 并返回 {inject, apply}', () => {
  const harness = createHarness({ storage: preferencesStorage({ needsInput: false, volume: 33 }) });

  assert.equal(harness.loadCalls.length, 1, 'load 应只被调用一次');
  assert.equal(harness.registration.id, 'dsh-ding');
  assert.equal(typeof harness.registration.factory, 'function');

  assert.deepEqual(harness.requireCalls, ['react'], 'factory 只应 require("react")');
  // 注意：inject 数组来自 vm 沙箱（跨 realm），先展开成宿主数组再比较原型。
  assert.deepEqual([...harness.exportsObject.inject], ['slots', 'uiSession']);
  assert.equal(typeof harness.exportsObject.apply, 'function');

  assert.ok(
    harness.storageLog.get.includes(STORAGE_KEY),
    'factory 执行时应读取 localStorage 偏好（否则无法预置开关）',
  );
});

// ---------------------------------------------------------------------------
// 2. 基线静音
// ---------------------------------------------------------------------------
test('首次订阅（基线）不发声；初始快照已带 pending 也不发声', () => {
  const plain = createHarness({ statuses: RUNNING });
  plain.install();
  expectSilent(plain.audioSummary());
  assert.equal(plain.pendingTimerCount(), 0);

  const withPending = createHarness({
    statuses: { [SESSION]: { running: true, pendingInteraction: pending('q0') } },
  });
  withPending.install();
  expectSilent(withPending.audioSummary(), '基线快照里的既有 pending 不应补响');
  assert.equal(withPending.audioSummary().contextsCreated, 0);
});

// ---------------------------------------------------------------------------
// 3. 需要操作音型（chime）
// ---------------------------------------------------------------------------
test('pendingInteraction 出现 → chime「需要操作」音型：2 个音符 / 6 个 oscillator', () => {
  const harness = fresh();
  harness.pushStatuses({ [SESSION]: { running: true, pendingInteraction: pending('q1') } });

  const summary = harness.audioSummary();
  expectPattern(summary, { noteCount: 2, oscillatorCount: 6 });

  assert.deepEqual(
    summary.notes.map((note) => note.oscillators),
    [3, 3],
    'chime 每个音符应有 3 个 partial oscillator',
  );
  assert.ok(summary.notes[1].at > summary.notes[0].at, 'chime 两个音符应有先后（叮—咚）');
  assert.ok(hasFrequency(summary, 987.77), '应包含 B5 基频 987.77');
  assert.ok(hasFrequency(summary, 783.99), '应包含 G5 基频 783.99');
  assert.equal(harness.pendingTimerCount(), 0);
});

// ---------------------------------------------------------------------------
// 4. 去重
// ---------------------------------------------------------------------------
test('同一个 pending 的连续快照不重复发声；换了 pending key 才再次发声', () => {
  const harness = fresh();
  const first = pending('q1');
  harness.pushStatuses({ [SESSION]: { running: true, pendingInteraction: first } });
  expectPattern(harness.audioSummary(), { noteCount: 2, oscillatorCount: 6 });

  // 相同 key（新对象）重复快照
  harness.resetAudio();
  harness.pushStatuses({ [SESSION]: { running: true, pendingInteraction: { ...first } } });
  expectSilent(harness.audioSummary(), '同一个 pending 的重复快照不应发声');

  // 同一对象重复快照
  harness.pushStatuses({ [SESSION]: { running: true, pendingInteraction: first } });
  expectSilent(harness.audioSummary(), '同一个 pending 的重复快照不应发声');

  // 新的 pending 才再次发声
  harness.pushStatuses({ [SESSION]: { running: true, pendingInteraction: pending('q2', 'approval') } });
  expectPattern(harness.audioSummary(), { noteCount: 2, oscillatorCount: 6 });
});

// ---------------------------------------------------------------------------
// 5. 完成音型（延迟 DONE_DELAY_MS）
// ---------------------------------------------------------------------------
test('running true→false 且无 pending → 延迟 DONE_DELAY_MS 后播放 chime「完成」音型（1 音符 / 3 oscillator）', () => {
  const harness = fresh();
  harness.pushStatuses({ [SESSION]: { running: false } });

  expectSilent(harness.audioSummary(), '延迟未到前不应发声');
  assert.equal(harness.pendingTimerCount(), 1, '应安排一个完成提醒定时器');

  harness.advance(DONE_DELAY_MS - 1);
  expectSilent(harness.audioSummary(), `DONE_DELAY_MS-1 (${DONE_DELAY_MS - 1}ms) 时不应发声`);

  harness.advance(1);
  expectPattern(harness.audioSummary(), { noteCount: 1, oscillatorCount: 3 });
  assert.equal(harness.pendingTimerCount(), 0);
});

// ---------------------------------------------------------------------------
// 6. pending 优先于完成音
// ---------------------------------------------------------------------------
test('pending 出现后立刻回合结束：只响 1 次「需要操作」，不响「完成」', () => {
  const harness = fresh();
  harness.pushStatuses({ [SESSION]: { running: true, pendingInteraction: pending('q1') } });
  expectPattern(harness.audioSummary(), { noteCount: 2, oscillatorCount: 6 });

  harness.pushStatuses({ [SESSION]: { running: false, pendingInteraction: null } });
  assert.equal(harness.pendingTimerCount(), 0, '交互刚处理完不应再安排完成音');

  harness.advance(1000);
  expectPattern(harness.audioSummary(), { noteCount: 2, oscillatorCount: 6 }, '累计应只有一次需要操作音');
});

test('pending 先被处理、随后回合结束 → 只响「完成」', () => {
  const harness = fresh();
  harness.pushStatuses({ [SESSION]: { running: true, pendingInteraction: pending('q1') } });
  harness.resetAudio();

  harness.pushStatuses({ [SESSION]: { running: true, pendingInteraction: null } });
  expectSilent(harness.audioSummary(), '交互被处理本身不应发声');

  harness.pushStatuses({ [SESSION]: { running: false } });
  harness.advance(DONE_DELAY_MS);
  expectPattern(harness.audioSummary(), { noteCount: 1, oscillatorCount: 3 });
});

test('完成延迟期间出现新 pending：取消完成音，只响一次需要操作', () => {
  const harness = fresh();
  harness.pushStatuses({ [SESSION]: { running: false } });
  harness.advance(100);

  harness.pushStatuses({ [SESSION]: { running: false, pendingInteraction: pending('q1') } });
  expectPattern(harness.audioSummary(), { noteCount: 2, oscillatorCount: 6 });

  harness.resetAudio();
  harness.advance(DONE_DELAY_MS);
  expectSilent(harness.audioSummary(), '被 pending 取消后不应再响完成音');
});

// ---------------------------------------------------------------------------
// 7. 开关
// ---------------------------------------------------------------------------
test('关闭 needsInput 开关（预置 localStorage）后 pending 不发声', () => {
  const harness = fresh({ storage: preferencesStorage({ needsInput: false }) });
  harness.pushStatuses({ [SESSION]: { running: true, pendingInteraction: pending('q1') } });

  expectSilent(harness.audioSummary(), 'needsInput=false 时不应发声');
  assert.equal(harness.audioSummary().contextsCreated, 0, '静音时不应创建 AudioContext');
});

test('关闭 turnDone 开关（预置 localStorage）后回合结束不发声', () => {
  const harness = fresh({ storage: preferencesStorage({ turnDone: false }) });
  harness.pushStatuses({ [SESSION]: { running: false } });
  harness.advance(DONE_DELAY_MS + 50);

  expectSilent(harness.audioSummary(), 'turnDone=false 时不应发声');
  assert.equal(harness.audioSummary().contextsCreated, 0);
});

// ---------------------------------------------------------------------------
// 8. 音量与音色
// ---------------------------------------------------------------------------
test('volume=0 时无声且不创建 AudioContext', () => {
  const harness = fresh({ storage: preferencesStorage({ volume: 0 }) });
  harness.pushStatuses({ [SESSION]: { running: true, pendingInteraction: pending('q1') } });

  expectSilent(harness.audioSummary());
  assert.equal(harness.audioSummary().contextsCreated, 0);
});

test('volume=100 时音型仍正确，且峰值增益为 0.5（调响后的新峰值）', () => {
  const harness = fresh({ storage: preferencesStorage({ volume: 100 }) });
  harness.pushStatuses({ [SESSION]: { running: true, pendingInteraction: pending('q1') } });

  const summary = harness.audioSummary();
  expectPattern(summary, { noteCount: 2, oscillatorCount: 6 });
  assert.ok(
    Math.abs(summary.peakGain - 0.5) < 1e-9,
    `volume=100 时 chime 峰值应为 0.5，实际 ${summary.peakGain}`,
  );
});

test('默认音量为 100：无存储时 pending 峰值即为 0.5（明显可听）', () => {
  const harness = fresh();
  harness.pushStatuses({ [SESSION]: { running: true, pendingInteraction: pending('q1') } });

  const summary = harness.audioSummary();
  expectPattern(summary, { noteCount: 2, oscillatorCount: 6 });
  assert.ok(
    Math.abs(summary.peakGain - 0.5) < 1e-9,
    `默认音量应为 100（峰值 0.5），实际 ${summary.peakGain}`,
  );
  // 完成音（单音符）峰值 0.42，也明显高于旧版
  harness.resetAudio();
  harness.pushStatuses({ [SESSION]: { running: true, pendingInteraction: null } });
  harness.pushStatuses({ [SESSION]: { running: false } });
  harness.advance(DONE_DELAY_MS);
  const done = harness.audioSummary();
  expectPattern(done, { noteCount: 1, oscillatorCount: 3 });
  assert.ok(
    Math.abs(done.peakGain - 0.42) < 1e-9,
    `默认完成音峰值应为 0.42，实际 ${done.peakGain}`,
  );
});

test('v1 → v2 迁移：保留开关/音色，并把旧音量 33 提到 100', () => {
  const harness = fresh({
    storage: legacyPreferencesStorage({ needsInput: true, turnDone: true, volume: 33, sound: 'ping' }),
  });
  harness.pushStatuses({ [SESSION]: { running: true, pendingInteraction: pending('q1') } });

  const summary = harness.audioSummary();
  // 迁移后 volume=100；sound=ping 为单层音色（2 音符 / 2 oscillator）
  expectPattern(summary, { noteCount: 2, oscillatorCount: 2 });
  assert.ok(
    Math.abs(summary.peakGain - 0.5) < 1e-9,
    `迁移后音量应提到 100（ping 峰值 0.5），实际 ${summary.peakGain}`,
  );
});

test('试听音量下限：volume=10 时试听仍按 60 播放（能听清）', () => {
  const harness = fresh({ storage: preferencesStorage({ volume: 10 }) });
  harness.injects[0].callback();
  const component = harness.registers[0].component;
  const tree = component();
  const buttons = findAll(tree, (node) => node.type === 'button');
  buttons[0].props.onClick();

  const summary = harness.audioSummary();
  expectPattern(summary, { noteCount: 2, oscillatorCount: 6 });
  assert.ok(
    Math.abs(summary.peakGain - 0.5 * 0.6) < 1e-9,
    `试听下限 60% 时峰值应为 0.3，实际 ${summary.peakGain}`,
  );
});

test('音色 ping：needsInput 为 2 音符 / 2 oscillator；turnDone 为 1 音符 / 1 oscillator', () => {
  const harness = fresh({ storage: preferencesStorage({ sound: 'ping' }) });
  harness.pushStatuses({ [SESSION]: { running: true, pendingInteraction: pending('q1') } });
  expectPattern(harness.audioSummary(), { noteCount: 2, oscillatorCount: 2 });

  harness.resetAudio();
  harness.pushStatuses({ [SESSION]: { running: true, pendingInteraction: null } });
  harness.pushStatuses({ [SESSION]: { running: false } });
  harness.advance(DONE_DELAY_MS);
  expectPattern(harness.audioSummary(), { noteCount: 1, oscillatorCount: 1 });
});

test('默认 chime 与 ping 的层数可区分（6 vs 2）', () => {
  const chime = fresh();
  chime.pushStatuses({ [SESSION]: { running: true, pendingInteraction: pending('q1') } });

  const ping = fresh({ storage: preferencesStorage({ sound: 'ping' }) });
  ping.pushStatuses({ [SESSION]: { running: true, pendingInteraction: pending('q1') } });

  assert.equal(chime.audioSummary().oscillatorCount, 6);
  assert.equal(ping.audioSummary().oscillatorCount, 2);
  assert.notEqual(chime.audioSummary().oscillatorCount, ping.audioSummary().oscillatorCount);
});

// ---------------------------------------------------------------------------
// 9. 会话切换
// ---------------------------------------------------------------------------
test('切换当前会话 id 不误响（含切回原会话）', () => {
  const harness = fresh({
    statuses: { [SESSION]: { running: true }, 'session-2': { running: false } },
  });

  harness.pushCurrent({ key: 'session-2' });
  expectSilent(harness.audioSummary(), '切换会话不应发声');
  assert.equal(harness.pendingTimerCount(), 0);

  harness.pushStatuses({ [SESSION]: { running: true }, 'session-2': { running: false } });
  harness.advance(1000);
  expectSilent(harness.audioSummary(), '新会话的既有 running=false 不应被当作刚结束');

  harness.pushCurrent({ key: SESSION });
  harness.advance(1000);
  expectSilent(harness.audioSummary(), '切回原会话也不应误响');
});

test('非当前会话的 running true→false 不发声（只提醒当前会话）', () => {
  const harness = fresh({
    statuses: { [SESSION]: { running: true }, 'session-2': { running: true } },
  });

  harness.pushStatuses({ [SESSION]: { running: true }, 'session-2': { running: false } });
  harness.advance(DONE_DELAY_MS + 50);

  expectSilent(harness.audioSummary(), '非当前会话结束不应发声');
  assert.equal(harness.pendingTimerCount(), 0);
});

// ---------------------------------------------------------------------------
// 10. 设置面板契约 + 组件
// ---------------------------------------------------------------------------
test('apply 期间注册 settings.section（name/id/order/label() === "提示音"），组件可渲染并可改开关', () => {
  const harness = fresh();

  assert.equal(harness.injects.length, 1, '应通过 slots.inject 注册一个设置分区');
  assert.equal(harness.injects[0].name, 'settings.section');
  assert.equal(harness.registers.length, 0, 'apply 返回时不应直接 register（应由 inject 回调触发）');

  harness.injects[0].callback();
  assert.equal(harness.registers.length, 1);
  const { options, component } = harness.registers[0];
  assert.equal(options.name, 'settings.section');
  assert.equal(options.id, 'dsh-ding');
  assert.equal(options.order, 60);
  assert.equal(typeof options.label, 'function');
  assert.equal(options.label(), '提示音');

  assert.equal(typeof component, 'function');
  const tree = component();
  assert.ok(tree !== null && typeof tree === 'object', '组件应返回元素树');
  assert.equal(tree.type, 'div');
  assert.match(flattenText(tree), /叮/, '组件文案应出现「叮」');

  const checkboxes = findAll(tree, (node) => node.type === 'input' && node.props.type === 'checkbox');
  const ranges = findAll(tree, (node) => node.type === 'input' && node.props.type === 'range');
  const selects = findAll(tree, (node) => node.type === 'select');
  const buttons = findAll(tree, (node) => node.type === 'button');
  assert.equal(checkboxes.length, 2, '需要操作 / 完成 两个开关');
  assert.equal(ranges.length, 1, '一个音量滑杆');
  assert.equal(selects.length, 1, '一个音色下拉');
  assert.equal(buttons.length, 2, '需要操作 / 完成 两个试听按钮');

  // 试听按钮：preview 忽略开关
  buttons[0].props.onClick();
  expectPattern(harness.audioSummary(), { noteCount: 2, oscillatorCount: 6 }, '试听按钮应播放需要操作音型');
  harness.resetAudio();

  // 组件字段修改：关闭 needsInput → 持久化 + 后续 pending 不发声
  checkboxes[0].props.onChange({ target: { checked: false } });
  const stored = JSON.parse(harness.localStorage.getItem(STORAGE_KEY));
  assert.equal(stored.needsInput, false, '组件开关应写回 localStorage');
  harness.pushStatuses({ [SESSION]: { running: true, pendingInteraction: pending('q1') } });
  expectSilent(harness.audioSummary(), '组件里关掉 needsInput 后不应发声');
});

// ---------------------------------------------------------------------------
// 11. 注销清理
// ---------------------------------------------------------------------------
test('ctx 注销后：窗口监听器移除、完成定时器取消、再推送状态不发声', () => {
  const harness = createHarness({ statuses: RUNNING, audioState: 'suspended' });
  const ctx = harness.install();

  assert.equal(harness.listenerCount(), 2, '应注册 pointerdown / keydown 两个解锁监听');
  assert.equal(harness.audioSummary().contextsCreated, 0, '未发生手势前不应创建 AudioContext');

  harness.dispatchWindowEvent('pointerdown');
  assert.equal(harness.audioSummary().contextsCreated, 1);
  assert.equal(harness.audioSummary().resumes, 1, '首次手势应恢复 suspended 的 AudioContext');

  // 安排完成音后再注销
  harness.pushStatuses({ [SESSION]: { running: false } });
  assert.equal(harness.pendingTimerCount(), 1);
  assert.equal(harness.stores.status.subscriberCount(), 1);
  assert.equal(harness.stores.current.subscriberCount(), 1);

  ctx.dispose();

  assert.equal(harness.listenerCount(), 0, '注销后窗口监听器应被移除');
  assert.equal(harness.stores.status.subscriberCount(), 0, '注销后应退订 sessionStatus');
  assert.equal(harness.stores.current.subscriberCount(), 0, '注销后应退订 current');
  assert.equal(harness.pendingTimerCount(), 0, '注销后应取消完成定时器');
  assert.ok(
    harness.listenerLog.removed.some((entry) => entry.type === 'pointerdown' && entry.existed === true),
    'pointerdown 监听应被真正移除',
  );
  assert.ok(
    harness.listenerLog.removed.some((entry) => entry.type === 'keydown' && entry.existed === true),
    'keydown 监听应被真正移除',
  );

  harness.resetAudio();
  harness.advance(DONE_DELAY_MS + 100);
  expectSilent(harness.audioSummary(), '注销后完成音不应再响');

  harness.pushStatuses({ [SESSION]: { running: true, pendingInteraction: pending('q9') } });
  expectSilent(harness.audioSummary(), '注销后再推送 pending 不应发声');

  // 手势解锁计数单独清零：注销前的首次手势已经 resume 过一次。
  harness.recordings.resumes = 0;
  harness.dispatchWindowEvent('pointerdown');
  assert.equal(harness.audioSummary().resumes, 0, '注销后不应再响应手势解锁');
});

// ---------------------------------------------------------------------------
// 12. 音频上下文缺失时的降级
// ---------------------------------------------------------------------------
test('宿主无 AudioContext 时静默降级、不抛异常', () => {
  const harness = createHarness({ statuses: RUNNING });
  // 在 factory 已执行后去掉构造器：playKind 的 ensureAudioContext 应返回 null。
  harness.sandbox.window.AudioContext = undefined;
  harness.install();

  assert.doesNotThrow(() => {
    harness.pushStatuses({ [SESSION]: { running: true, pendingInteraction: pending('q1') } });
    harness.advance(DONE_DELAY_MS + 100);
  });
  expectSilent(harness.audioSummary());
  assert.equal(harness.audioSummary().contextsCreated, 0);
});
