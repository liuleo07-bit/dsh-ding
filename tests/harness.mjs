/**
 * dsh-ding 客户端半（client.js）测试桩。
 *
 * 用 node:vm 在沙箱里执行 `window.__ModuleLoader__.load({id, factory})` 形式的
 * 浏览器插件脚本，并提供：
 *   - 内存 localStorage；
 *   - 假 AudioContext（记录 oscillator / gain 的创建与 start）；
 *   - 手动假定时器（本文件推进，不依赖真实等待）；
 *   - window.addEventListener / removeEventListener 记录；
 *   - 最小 React 垫片（createElement + useSyncExternalStore）；
 *   - 假 ctx（effect / slots.inject / slots.register / uiSession 可推送 store）。
 *
 * 只读取被测文件，不修改任何插件文件。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 被测插件目录（ding-plugin/dsh-ding）。 */
export const PLUGIN_ROOT = path.resolve(HERE, '..', 'dsh-ding');
/** 被测客户端文件。 */
export const CLIENT_FILE = path.join(PLUGIN_ROOT, 'client.js');
/** 与 client.js 中 STORAGE_KEY 保持一致。 */
export const STORAGE_KEY = 'dsh-ding.preferences.v2';
/** 旧版键：client.js 迁移时会读取它（v1 的音量会提到 100）。 */
export const LEGACY_STORAGE_KEY = 'dsh-ding.preferences.v1';
/** 与 client.js 中 DONE_DELAY_MS 保持一致。 */
export const DONE_DELAY_MS = 320;

/** 生成预置 localStorage 的数据（值为 JSON 字符串）。 */
export function preferencesStorage(partial) {
  return { [STORAGE_KEY]: JSON.stringify(partial) };
}

/** 预置旧版（v1）偏好，用于验证迁移。 */
export function legacyPreferencesStorage(partial) {
  return { [LEGACY_STORAGE_KEY]: JSON.stringify(partial) };
}

// ---------------------------------------------------------------------------
// 最小 React 垫片
// ---------------------------------------------------------------------------
function createReactShim() {
  function createElement(type, props, ...children) {
    const element = { type, props: Object.assign({}, props || {}) };
    if (children.length === 1) element.props.children = children[0];
    else if (children.length > 1) element.props.children = children;
    return element;
  }
  return {
    createElement,
    // 测试里不需要真正的订阅：直接读当前快照即可。
    useSyncExternalStore(subscribe, getSnapshot) {
      return getSnapshot();
    },
  };
}

export function createReactForTests() {
  return createReactShim();
}

// ---------------------------------------------------------------------------
// 假 AudioContext
// ---------------------------------------------------------------------------
function createAudioStub(initialState) {
  const recordings = {
    contextsCreated: 0,
    resumes: 0,
    oscillators: [],
    gains: [],
    freqCalls: [], // 每次 oscillator.frequency.setValueAtTime(freq, at)
    starts: [], // 每个 oscillator 的 start(at) 时间
    stops: [],
    gainCalls: [], // { kind: 'set' | 'ramp', value, at }
  };

  function FakeAudioContext() {
    recordings.contextsCreated += 1;
    const context = {
      state: initialState,
      currentTime: 0,
      destination: { name: 'destination' },
      resume() {
        recordings.resumes += 1;
        context.state = 'running';
        return Promise.resolve();
      },
      createOscillator() {
        const oscillator = {
          type: 'sine',
          frequency: {
            calls: [],
            setValueAtTime(frequency, at) {
              this.calls.push({ frequency, at });
              recordings.freqCalls.push({ frequency, at });
            },
          },
          connect(node) {
            return node;
          },
          start(at) {
            recordings.starts.push(at);
          },
          stop(at) {
            recordings.stops.push(at);
          },
        };
        recordings.oscillators.push(oscillator);
        return oscillator;
      },
      createGain() {
        const gainParam = {
          calls: [],
          setValueAtTime(value, at) {
            this.calls.push({ kind: 'set', value, at });
            recordings.gainCalls.push({ kind: 'set', value, at });
          },
          exponentialRampToValueAtTime(value, at) {
            this.calls.push({ kind: 'ramp', value, at });
            recordings.gainCalls.push({ kind: 'ramp', value, at });
          },
        };
        const gainNode = {
          gain: gainParam,
          connect(node) {
            return node;
          },
        };
        recordings.gains.push(gainNode);
        return gainNode;
      },
    };
    // 构造函数返回对象，`new Ctor()` 得到的就是这个假 Context。
    return context;
  }

  return { FakeAudioContext, recordings };
}

// ---------------------------------------------------------------------------
// 音频录制汇总（核心断言辅助）
// ---------------------------------------------------------------------------

/**
 * 把一个音符内的所有 partial oscillator 归并成“音符”。
 *
 * client.js 的 scheduleBellNote() 会给一个音符的多个 partial 使用同一个
 * startAt；因此把 starts 中“连续相同起始时间”的 oscillator 归为一组，
 * 组数就是音符数，组内 oscillator 数就是该音色的层数（chime=3，ping=1）。
 * 这样既不会因为 partial 数量不同而误判“音符数量”，也能区分两种音色。
 */
export function noteGroups(recordings) {
  const groups = [];
  for (const startAt of recordings.starts) {
    const last = groups[groups.length - 1];
    if (last !== undefined && Math.abs(last.at - startAt) < 1e-6) {
      last.oscillators += 1;
    } else {
      groups.push({ at: startAt, oscillators: 1 });
    }
  }
  return groups;
}

/** 汇总一次（或多次）播放的音频记录。 */
export function summarizeAudio(recordings) {
  const groups = noteGroups(recordings);
  const ramps = recordings.gainCalls
    .filter((call) => call.kind === 'ramp')
    .map((call) => call.value);
  return {
    notes: groups,
    noteCount: groups.length,
    oscillatorCount: recordings.oscillators.length,
    layerCount: recordings.freqCalls.length,
    frequencies: recordings.freqCalls.map((call) => call.frequency),
    peakGain: ramps.length > 0 ? Math.max(...ramps) : 0,
    contextsCreated: recordings.contextsCreated,
    resumes: recordings.resumes,
  };
}

/** 人类可读的摘要，用于断言失败信息。 */
export function describeSummary(summary) {
  const notes = summary.notes
    .map((note) => `t=${note.at}s×${note.oscillators}`)
    .join(', ');
  return `音符=${summary.noteCount} [${notes}]，oscillator=${summary.oscillatorCount}，AudioContext 创建=${summary.contextsCreated}`;
}

/** 断言完全没有发声。 */
export function expectSilent(summary) {
  assert.equal(summary.noteCount, 0, `期望静音，实际音符数不为 0：${describeSummary(summary)}`);
  assert.equal(summary.oscillatorCount, 0, `期望静音，实际创建了 oscillator：${describeSummary(summary)}`);
  assert.equal(summary.layerCount, 0, `期望静音，实际调用了 frequency.setValueAtTime：${describeSummary(summary)}`);
}

/**
 * 断言音型：
 *   - noteCount：音符数量（按 oscillator 起始时间分组）；
 *   - oscillatorCount：oscillator / partial 层数（chime 每音符 3 层，ping 每音符 1 层）。
 */
export function expectPattern(summary, expected) {
  assert.equal(
    summary.noteCount,
    expected.noteCount,
    `音符数量不符（期望 ${expected.noteCount}）：${describeSummary(summary)}`,
  );
  assert.equal(
    summary.oscillatorCount,
    expected.oscillatorCount,
    `oscillator 数量不符（期望 ${expected.oscillatorCount}）：${describeSummary(summary)}`,
  );
  assert.equal(
    summary.layerCount,
    summary.oscillatorCount,
    `每个 oscillator 应恰好设置一次频率（层数=${summary.layerCount}）：${describeSummary(summary)}`,
  );
}

/** 判断汇总里是否存在某个基频（容差内）。 */
export function hasFrequency(summary, expected, tolerance = 0.01) {
  return summary.frequencies.some((frequency) => Math.abs(frequency - expected) <= tolerance);
}

// ---------------------------------------------------------------------------
// 遍历 shim React 元素树
// ---------------------------------------------------------------------------
export function walkElements(node, visit = () => {}) {
  if (node === null || node === undefined || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walkElements(child, visit);
    return;
  }
  visit(node);
  if (node.props !== undefined && node.props !== null) {
    walkElements(node.props.children, visit);
  }
}

export function findAll(node, predicate) {
  const matched = [];
  walkElements(node, (element) => {
    if (predicate(element)) matched.push(element);
  });
  return matched;
}

export function flattenText(node) {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map((child) => flattenText(child)).join('');
  if (typeof node === 'object' && node.props !== undefined) return flattenText(node.props.children);
  return '';
}

// ---------------------------------------------------------------------------
// 假 ctx（slots / uiSession / effect）
// ---------------------------------------------------------------------------
function createStore(initialValue) {
  let value = initialValue;
  const subscribers = new Set();
  return {
    getSnapshot() {
      return value;
    },
    subscribe(listener) {
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    },
    set(nextValue) {
      value = nextValue;
      for (const listener of [...subscribers]) listener();
    },
    subscriberCount() {
      return subscribers.size;
    },
  };
}

function toSessionStatusMap(input) {
  if (input instanceof Map) return new Map(input);
  const map = new Map();
  for (const [sessionId, status] of Object.entries(input || {})) {
    map.set(sessionId, status);
  }
  return map;
}

function toBinding(current) {
  if (current === null || current === undefined) return null;
  if (typeof current === 'string') return { key: current };
  return current;
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------
/**
 * 创建一套宿主环境并执行 client.js（load 注册 + factory 物化）。
 *
 * @param {object} [options]
 * @param {object} [options.storage] 预置 localStorage，键 -> 字符串值。
 * @param {object|Map} [options.statuses] sessionStatus 初始快照。
 * @param {object|string|null} [options.current] uiSession.current 初始快照。
 * @param {'running'|'suspended'} [options.audioState] 假 AudioContext 初始状态。
 */
export function createHarness(options = {}) {
  // ---- localStorage ------------------------------------------------------
  const storage = new Map();
  const storageLog = { get: [], set: [] };
  for (const [key, value] of Object.entries(options.storage || {})) {
    storage.set(key, String(value));
  }
  const localStorage = {
    getItem(key) {
      storageLog.get.push(key);
      return storage.has(key) ? storage.get(key) : null;
    },
    setItem(key, value) {
      const text = String(value);
      storageLog.set.push({ key, value: text });
      storage.set(key, text);
    },
    removeItem(key) {
      storage.delete(key);
    },
    clear() {
      storage.clear();
    },
    key(index) {
      return [...storage.keys()][index] ?? null;
    },
    get length() {
      return storage.size;
    },
  };

  // ---- window / 监听器 ---------------------------------------------------
  const audio = createAudioStub(options.audioState || 'running');
  const listeners = new Map(); // `${type}|${Boolean(capture)}` -> Set<handler>
  const listenerLog = { added: [], removed: [] };

  function listenerKey(type, capture) {
    return `${type}|${Boolean(capture)}`;
  }

  const windowStub = {
    localStorage,
    AudioContext: audio.FakeAudioContext,
    addEventListener(type, handler, capture) {
      const key = listenerKey(type, capture);
      if (!listeners.has(key)) listeners.set(key, new Set());
      listeners.get(key).add(handler);
      listenerLog.added.push({ type, capture: Boolean(capture) });
    },
    removeEventListener(type, handler, capture) {
      const key = listenerKey(type, capture);
      const bucket = listeners.get(key);
      const existed = bucket !== undefined && bucket.delete(handler);
      if (bucket !== undefined && bucket.size === 0) listeners.delete(key);
      listenerLog.removed.push({ type, capture: Boolean(capture), existed });
    },
  };

  function listenerCount() {
    let count = 0;
    for (const bucket of listeners.values()) count += bucket.size;
    return count;
  }

  function dispatchWindowEvent(type, event = { type }) {
    for (const [key, bucket] of listeners) {
      if (key.slice(0, key.lastIndexOf('|')) !== type) continue;
      for (const handler of [...bucket]) handler(event);
    }
  }

  // ---- 手动假定时器 ------------------------------------------------------
  let timerNow = 0;
  let timerSeq = 0;
  const timers = new Map();

  function setTimeoutStub(callback, delay) {
    const id = ++timerSeq;
    const at = timerNow + (Number(delay) || 0);
    timers.set(id, { id, at, callback });
    return id;
  }

  function clearTimeoutStub(id) {
    timers.delete(id);
  }

  /** 推进假时钟并执行到期的定时器回调。 */
  function advance(ms) {
    const target = timerNow + (Number(ms) || 0);
    for (;;) {
      let next = null;
      for (const timer of timers.values()) {
        if (timer.at > target) continue;
        if (
          next === null ||
          timer.at < next.at ||
          (timer.at === next.at && timer.id < next.id)
        ) {
          next = timer;
        }
      }
      if (next === null) break;
      timers.delete(next.id);
      timerNow = next.at;
      next.callback();
    }
    timerNow = target;
    return timerNow;
  }

  function pendingTimerCount() {
    return timers.size;
  }

  // ---- 模块加载 / factory 物化 -------------------------------------------
  const loadCalls = [];
  windowStub.__ModuleLoader__ = {
    load(registration) {
      loadCalls.push(registration);
    },
  };

  const sandbox = {
    window: windowStub,
    localStorage,
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    setTimeout: setTimeoutStub,
    clearTimeout: clearTimeoutStub,
  };
  vm.createContext(sandbox);

  const source = fs.readFileSync(CLIENT_FILE, 'utf8');
  vm.runInContext(source, sandbox, { filename: CLIENT_FILE });

  assert.equal(loadCalls.length, 1, 'client.js 应恰好调用一次 window.__ModuleLoader__.load');
  const registration = loadCalls[0];

  const requireCalls = [];
  const reactShim = createReactShim();
  function requireShim(specifier) {
    requireCalls.push(specifier);
    if (specifier === 'react') return reactShim;
    throw new Error(`测试垫片未提供模块：${specifier}`);
  }

  const exportsObject = registration.factory(requireShim);

  // ---- 可推送的 uiSession store ------------------------------------------
  const currentStore = createStore(toBinding(options.current === undefined ? { key: 'session-1' } : options.current));
  const statusStore = createStore(toSessionStatusMap(options.statuses));

  function pushCurrent(nextCurrent) {
    currentStore.set(toBinding(nextCurrent));
  }

  function pushStatuses(nextStatuses) {
    statusStore.set(toSessionStatusMap(nextStatuses));
  }

  // ---- 假 ctx ------------------------------------------------------------
  const effects = [];
  const injects = [];
  const registers = [];
  let ctx = null;

  function install() {
    assert.equal(ctx, null, 'install() 只能调用一次');
    ctx = {
      effect(run, label) {
        const cleanup = run();
        effects.push({ label, cleanup });
        return cleanup;
      },
      slots: {
        inject(slotName, callback) {
          injects.push({ name: slotName, callback });
          return () => {};
        },
        register(registerOptions, component) {
          const record = { options: registerOptions, component, active: true };
          registers.push(record);
          return () => {
            record.active = false;
          };
        },
      },
      uiSession: {
        current: currentStore,
        sessionStatus: statusStore,
      },
      dispose() {
        while (effects.length > 0) {
          const effect = effects.pop();
          if (typeof effect.cleanup === 'function') effect.cleanup();
        }
      },
    };
    exportsObject.apply(ctx);
    return ctx;
  }

  const recordings = audio.recordings;

  return {
    // 模块层
    loadCalls,
    registration,
    requireCalls,
    exportsObject,
    sandbox,
    // 存储
    storage,
    storageLog,
    localStorage,
    // 音频
    recordings,
    audioSummary() {
      return summarizeAudio(recordings);
    },
    resetAudio() {
      recordings.oscillators.length = 0;
      recordings.gains.length = 0;
      recordings.freqCalls.length = 0;
      recordings.starts.length = 0;
      recordings.stops.length = 0;
      recordings.gainCalls.length = 0;
    },
    // 定时器
    advance,
    pendingTimerCount,
    // window
    listenerCount,
    listenerLog,
    dispatchWindowEvent,
    // ctx
    install,
    get ctx() {
      return ctx;
    },
    effects,
    injects,
    registers,
    stores: { current: currentStore, status: statusStore },
    pushCurrent,
    pushStatuses,
  };
}
