/**
 * dsh-ding —— 客户端半（浏览器）。
 *
 * 职责：
 *  1. 监听当前会话的统一状态（`uiSession.sessionStatus`）：
 *     - 出现 pendingInteraction（提问 / 审批 / 计划确认）→ 播「需要操作」的叮声；
 *     - 当前回合 running 由 true → false 且没有待处理交互 → 播「阶段完成」的叮声。
 *  2. 在「设置 → 提示音」注册一个面板：两个开关、音量、音色、试听。
 *  3. 声音用 Web Audio 实时合成，不需要任何音频资源文件。
 *
 * 偏好保存在浏览器 localStorage（本插件的宿主半部没有 Config，避免本地目录
 * 安装时解析不到宿主依赖的问题）。关闭/卸载本插件即完全静音。
 */
window.__ModuleLoader__.load({
  id: 'dsh-ding',
  factory: function (require) {
    'use strict';

    var React = require('react');

    // ------------------------------------------------------------------
    // 常量
    // ------------------------------------------------------------------
    /** 插件条目 id —— 与 cordis.patch.yml 的 insert[].id 一致。 */
    var ENTRY_ID = 'dsh-ding';
    /** localStorage 键（带版本号，便于以后迁移）。 */
    var STORAGE_KEY = 'dsh-ding.preferences.v2';
    /** 旧版键：v1 的音量默认 60、音型偏轻，迁移时把音量提到 100。 */
    var LEGACY_STORAGE_KEY = 'dsh-ding.preferences.v1';
    /** 默认偏好。音量默认 100（v1 的 60 在不少机器上偏轻、听不清）。 */
    var DEFAULTS = {
      needsInput: true,
      turnDone: true,
      volume: 100,
      sound: 'chime',
    };
    /** 完成提醒的延迟：给同一时刻到达的“需要操作”让路，避免响两声。 */
    var DONE_DELAY_MS = 320;

    // ------------------------------------------------------------------
    // 偏好存储（localStorage + 内存回退）
    // ------------------------------------------------------------------
    var config = loadPreferences();
    var configListeners = new Set();

    function clampVolume(value) {
      var number = Number(value);
      if (!isFinite(number)) return DEFAULTS.volume;
      if (number < 0) return 0;
      if (number > 100) return 100;
      return Math.round(number);
    }

    /** 归一化任意输入为一份完整、合法的偏好。 */
    function normalizePreferences(raw) {
      var source = raw !== null && typeof raw === 'object' ? raw : {};
      return {
        needsInput: source.needsInput !== false,
        turnDone: source.turnDone !== false,
        volume: source.volume === undefined ? DEFAULTS.volume : clampVolume(source.volume),
        sound: source.sound === 'ping' ? 'ping' : 'chime',
      };
    }

    function loadPreferences() {
      try {
        var raw = window.localStorage.getItem(STORAGE_KEY);
        if (raw !== null) return normalizePreferences(JSON.parse(raw));
        // v1 → v2：保留开关与音色，但把音量提到 100（用户反馈过旧默认太轻）。
        var legacy = window.localStorage.getItem(LEGACY_STORAGE_KEY);
        if (legacy !== null) {
          var previous = JSON.parse(legacy);
          var migrated = normalizePreferences(previous);
          migrated.volume = 100;
          return migrated;
        }
        return normalizePreferences(null);
      } catch (error) {
        // 隐私模式 / 受限源 / 脏数据：退回默认值，不影响功能
        return normalizePreferences(null);
      }
    }

    function persistPreferences(next) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch (error) {
        /* 无法持久化时仅本次运行有效，不抛出 */
      }
    }

    function getConfig() {
      return config;
    }

    function subscribeConfig(listener) {
      configListeners.add(listener);
      return function () {
        configListeners.delete(listener);
      };
    }

    function publishConfig(next) {
      config = next;
      persistPreferences(next);
      configListeners.forEach(function (listener) {
        try {
          listener();
        } catch (error) {
          /* 单个订阅者失败不影响其它订阅者 */
        }
      });
    }

    /** 写回一个字段。 */
    function setField(field, value) {
      var draft = {};
      Object.keys(DEFAULTS).forEach(function (key) {
        draft[key] = config[key];
      });
      draft[field] = value;
      publishConfig(normalizePreferences(draft));
    }

    /** 组件订阅偏好。 */
    function useConfig() {
      return React.useSyncExternalStore(subscribeConfig, getConfig, getConfig);
    }

    // ------------------------------------------------------------------
    // 合成音（Web Audio）
    // ------------------------------------------------------------------
    var audioContext = null;

    function ensureAudioContext() {
      if (audioContext !== null) return audioContext;
      var Ctor = window.AudioContext || window.webkitAudioContext;
      if (Ctor === undefined || Ctor === null) return null;
      try {
        audioContext = new Ctor();
      } catch (error) {
        audioContext = null;
        return null;
      }
      return audioContext;
    }

    /** 首次用户手势后恢复被浏览器挂起的音频上下文。 */
    function resumeAudio() {
      var ctx = ensureAudioContext();
      if (ctx === null) return;
      if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
        try {
          var settled = ctx.resume();
          if (settled !== undefined && typeof settled.catch === 'function') settled.catch(function () {});
        } catch (error) {
          /* 恢复失败时保持静默，下一次手势再试 */
        }
      }
    }

    /**
     * 一个带指数衰减的“铃音”音符。基频 + 八度泛音 + 低八度垫音，
     * 峰值接近满刻度（≤0.8），比纯正弦更响、也更饱满。
     */
    function scheduleBellNote(ctx, frequency, delaySeconds, durationSeconds, peakGain, partials) {
      var startAt = ctx.currentTime + delaySeconds;
      var layers = partials || [
        [1, 1], // 基频
        [2.0, 0.4], // 高八度泛音：提升穿透力
        [0.5, 0.2], // 低八度垫音：增加体积感
      ];
      layers.forEach(function (layer) {
        var multiplier = layer[0];
        var level = layer[1];
        var oscillator = ctx.createOscillator();
        var gain = ctx.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(frequency * multiplier, startAt);
        gain.gain.setValueAtTime(0.0001, startAt);
        gain.gain.exponentialRampToValueAtTime(
          Math.max(0.0002, peakGain * level),
          startAt + 0.008,
        );
        gain.gain.exponentialRampToValueAtTime(0.0001, startAt + durationSeconds);
        oscillator.connect(gain);
        gain.connect(ctx.destination);
        oscillator.start(startAt);
        oscillator.stop(startAt + durationSeconds + 0.06);
      });
    }

    /** 两种事件的音型（峰值已按“听得清”调高；总峰值 ≤ 0.8，不会破音）。 */
    var SOUND_PATTERNS = {
      chime: {
        needsInput: {
          peak: 0.5,
          notes: [
            { frequency: 987.77, delay: 0, duration: 0.85 }, // B5
            { frequency: 783.99, delay: 0.2, duration: 1.15 }, // G5（叮—咚）
          ],
        },
        turnDone: {
          peak: 0.42,
          notes: [{ frequency: 1046.5, delay: 0, duration: 1.1 }], // C6（单声长叮）
        },
      },
      ping: {
        needsInput: {
          peak: 0.5,
          simple: true,
          notes: [
            { frequency: 1046.5, delay: 0, duration: 0.3 }, // C6
            { frequency: 1046.5, delay: 0.18, duration: 0.3 },
          ],
        },
        turnDone: {
          peak: 0.45,
          simple: true,
          notes: [{ frequency: 1567.98, delay: 0, duration: 0.45 }], // G6
        },
      },
    };

    /**
     * 播放某个事件的提示音。
     * @param {'needsInput'|'turnDone'} kind - 事件种类。
     * @param {{preview?: boolean}} [options] - preview 时忽略开关，并按可听音量试听。
     */
    function playKind(kind, options) {
      var preview = options !== undefined && options.preview === true;
      var current = getConfig();
      if (!preview) {
        if (kind === 'needsInput' && !current.needsInput) return;
        if (kind === 'turnDone' && !current.turnDone) return;
      }
      var level = preview ? Math.max(current.volume, 60) : current.volume;
      if (level <= 0) return;
      var ctx = ensureAudioContext();
      if (ctx === null) return;
      if (ctx.state === 'suspended') resumeAudio();
      var pattern = (SOUND_PATTERNS[current.sound] || SOUND_PATTERNS.chime)[kind];
      if (pattern === undefined) return;
      var peak = pattern.peak * (level / 100);
      pattern.notes.forEach(function (note) {
        scheduleBellNote(
          ctx,
          note.frequency,
          note.delay,
          note.duration,
          peak,
          pattern.simple === true ? [[1, 1]] : undefined,
        );
      });
    }

    // ------------------------------------------------------------------
    // 会话状态监听
    // ------------------------------------------------------------------
    /** 从 pendingInteraction 对象上取一个稳定的去重键。 */
    function pendingKeyOf(interaction) {
      if (interaction === undefined || interaction === null) return null;
      if (interaction.key !== undefined && interaction.key !== null) return String(interaction.key);
      var parts = [];
      if (interaction.sessionId !== undefined) parts.push(String(interaction.sessionId));
      if (interaction.callId !== undefined) parts.push(String(interaction.callId));
      if (interaction.kind !== undefined) parts.push(String(interaction.kind));
      if (interaction.toolName !== undefined) parts.push(String(interaction.toolName));
      return parts.length === 0 ? 'pending-interaction' : parts.join('#');
    }

    /**
     * 订阅“当前会话”的统一状态，在跨状态迁移时决定是否出声。
     * 返回注销函数（交给 ctx.effect 管理生命周期）。
     */
    function watchSessionStatus(ctx) {
      var uiSession = ctx.uiSession;
      var currentSource = uiSession.current;
      var statusSource = uiSession.sessionStatus;
      var previous = null;
      var doneTimer = null;
      var armed = true;

      function currentSessionId() {
        try {
          var binding = currentSource.getSnapshot();
          if (binding === undefined || binding === null) return undefined;
          return binding.key;
        } catch (error) {
          return undefined;
        }
      }

      function statusOf(sessionId) {
        try {
          var statuses = statusSource.getSnapshot();
          if (statuses === undefined || statuses === null) return undefined;
          if (typeof statuses.get !== 'function') return undefined;
          return statuses.get(sessionId);
        } catch (error) {
          return undefined;
        }
      }

      function cancelDoneTimer() {
        if (doneTimer !== null) {
          clearTimeout(doneTimer);
          doneTimer = null;
        }
      }

      function scheduleDone() {
        cancelDoneTimer();
        doneTimer = setTimeout(function () {
          doneTimer = null;
          var sessionId = currentSessionId();
          if (sessionId === undefined) return;
          var status = statusOf(sessionId);
          if (status !== undefined && status !== null && status.pendingInteraction !== undefined && status.pendingInteraction !== null) {
            // 同一时刻出现了“需要操作”，已经由 needsInput 提醒过
            return;
          }
          playKind('turnDone');
        }, DONE_DELAY_MS);
      }

      function read() {
        var sessionId = currentSessionId();
        if (sessionId === undefined) {
          previous = null;
          return;
        }
        var status = statusOf(sessionId);
        var running = status === undefined || status === null ? undefined : status.running;
        var pending = status === undefined || status === null ? undefined : status.pendingInteraction;
        var pendingKey = pendingKeyOf(pending);
        var snapshot = { id: sessionId, running: running, pendingKey: pendingKey };

        if (armed) {
          armed = false;
          previous = snapshot;
          return;
        }
        if (previous === null || previous.id !== sessionId) {
          previous = snapshot;
          return;
        }

        if (pendingKey !== null && pendingKey !== previous.pendingKey) {
          // 出现新的待处理交互：需要你操作
          cancelDoneTimer();
          playKind('needsInput');
        } else if (pendingKey === null && previous.pendingKey !== null) {
          // 交互已被处理，等回合真正结束再提醒
        } else if (previous.running === true && running === false && pendingKey === null) {
          // 回合结束：阶段完成
          scheduleDone();
        }
        previous = snapshot;
      }

      var offStatus = statusSource.subscribe(read);
      var offCurrent = currentSource.subscribe(read);
      read();
      return function () {
        offStatus();
        offCurrent();
        cancelDoneTimer();
      };
    }

    // ------------------------------------------------------------------
    // 设置面板
    // ------------------------------------------------------------------
    var labelStyle = {
      flex: '0 0 210px',
      color: 'var(--dsw-alias-label-secondary)',
      fontSize: '13px',
      lineHeight: '20px',
    };
    var rowStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: '10px',
      minHeight: '30px',
    };
    var toggleStyle = {
      width: '16px',
      height: '16px',
      accentColor: 'var(--dsw-alias-brand-primary)',
      cursor: 'pointer',
    };
    var sliderStyle = {
      flex: '1 1 auto',
      minWidth: '0',
      accentColor: 'var(--dsw-alias-brand-primary)',
    };
    var valueStyle = {
      flex: '0 0 46px',
      textAlign: 'right',
      color: 'var(--dsw-alias-label-caption)',
      fontVariantNumeric: 'tabular-nums',
      fontSize: '12px',
    };
    var selectStyle = {
      padding: '3px 8px',
      borderRadius: '6px',
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-layer-1)',
      color: 'var(--dsw-alias-label-primary)',
      fontSize: '13px',
    };
    var buttonStyle = {
      padding: '3px 12px',
      borderRadius: '6px',
      cursor: 'pointer',
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-layer-2)',
      color: 'var(--dsw-alias-label-primary)',
      fontSize: '13px',
    };
    var hintStyle = {
      margin: '0 0 2px',
      color: 'var(--dsw-alias-label-caption)',
      fontSize: '12px',
      lineHeight: '18px',
    };

    function SettingsRow(children, key) {
      return React.createElement('div', { style: rowStyle, key: key }, children);
    }

    function DingSettingsSection() {
      var current = useConfig();
      return React.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '13px' } },
        React.createElement(
          'p',
          { style: hintStyle },
          '在以下时机播放「叮」声（只针对当前正在对话的会话）。',
        ),
        SettingsRow(
          [
            React.createElement('span', { style: labelStyle, key: 'l' }, '需要我操作时（提问 / 审批 / 计划确认）'),
            React.createElement('input', {
              key: 'c',
              type: 'checkbox',
              style: toggleStyle,
              checked: current.needsInput,
              onChange: function (event) {
                setField('needsInput', event.target.checked);
              },
            }),
          ],
          'needsInput',
        ),
        SettingsRow(
          [
            React.createElement('span', { style: labelStyle, key: 'l' }, '阶段任务完成时（当前回合结束）'),
            React.createElement('input', {
              key: 'c',
              type: 'checkbox',
              style: toggleStyle,
              checked: current.turnDone,
              onChange: function (event) {
                setField('turnDone', event.target.checked);
              },
            }),
          ],
          'turnDone',
        ),
        SettingsRow(
          [
            React.createElement('span', { style: labelStyle, key: 'l' }, '音量'),
            React.createElement('input', {
              key: 'r',
              type: 'range',
              min: 0,
              max: 100,
              step: 1,
              style: sliderStyle,
              value: current.volume,
              onChange: function (event) {
                setField('volume', Number(event.target.value));
              },
            }),
            React.createElement('span', { style: valueStyle, key: 'v' }, String(current.volume) + '%'),
          ],
          'volume',
        ),
        SettingsRow(
          [
            React.createElement('span', { style: labelStyle, key: 'l' }, '音色'),
            React.createElement(
              'select',
              {
                key: 's',
                style: selectStyle,
                value: current.sound,
                onChange: function (event) {
                  setField('sound', event.target.value);
                },
              },
              React.createElement('option', { value: 'chime' }, '叮咚（柔和）'),
              React.createElement('option', { value: 'ping' }, '单音（清脆）'),
            ),
          ],
          'sound',
        ),
        SettingsRow(
          [
            React.createElement('span', { style: labelStyle, key: 'l' }, '试听'),
            React.createElement(
              'button',
              {
                key: 'a',
                type: 'button',
                style: buttonStyle,
                onClick: function () {
                  playKind('needsInput', { preview: true });
                },
              },
              '需要操作',
            ),
            React.createElement(
              'button',
              {
                key: 'b',
                type: 'button',
                style: buttonStyle,
                onClick: function () {
                  playKind('turnDone', { preview: true });
                },
              },
              '完成',
            ),
          ],
          'preview',
        ),
        React.createElement(
          'p',
          { style: hintStyle },
          '偏好只保存在本机浏览器；关闭本插件即完全静音。',
        ),
      );
    }

    // ------------------------------------------------------------------
    // 插件入口
    // ------------------------------------------------------------------
    var inject = ['slots', 'uiSession'];

    function apply(ctx) {
      // 1. 首次用户手势时解锁音频（浏览器可能把 AudioContext 挂起到用户操作之后）
      ctx.effect(function () {
        function unlock() {
          resumeAudio();
        }
        window.addEventListener('pointerdown', unlock, true);
        window.addEventListener('keydown', unlock, true);
        return function () {
          window.removeEventListener('pointerdown', unlock, true);
          window.removeEventListener('keydown', unlock, true);
        };
      }, 'dsh-ding: unlock audio on first gesture');

      // 2. 监听当前会话状态
      ctx.effect(function () {
        return watchSessionStatus(ctx);
      }, 'dsh-ding: watch current session status');

      // 3. 「设置 → 提示音」面板
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register(
          {
            name: 'settings.section',
            id: ENTRY_ID,
            order: 60,
            label: function () {
              return '提示音';
            },
          },
          DingSettingsSection,
        );
      });
    }

    return { inject: inject, apply: apply };
  },
});
