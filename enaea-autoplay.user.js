// ==UserScript==
// @name         学习公社课程连续播放（指定班级）
// @namespace    local.enaea.player.helper
// @version      1.3.0
// @downloadURL  none
// @updateURL    none
// @description  连续播放普通视频，跟踪酷雷曼和 720云 VR 课程进度，按平台进度切课，支持普通视频断点续播。
// @match        https://study.enaea.edu.cn/circleIndexRedirect.do*
// @match        https://study.enaea.edu.cn/viewerforccvideo.do*
// @match        https://study.enaea.edu.cn/viewerforicourse.do*
// @match        https://www.720yun.com/vr/*
// @match        https://720yun.com/vr/*
// @match        https://www.kuleiman.com/*/index.html*
// @match        https://kuleiman.com/*/index.html*
// @run-at       document-start
// @sandbox      raw
// @grant        none
// ==/UserScript==

/*
使用：
1. 在电脑 Chrome / Edge / Firefox 安装 Tampermonkey，创建新脚本，粘贴本文件全文并保存。
2. 登录学习公社，打开下面的课程总页，在右下角点击“开始”。
3. 默认静音、1 倍速。面板的“静音播放”也适用于支持的 VR 课件，不暂停讲解或场景切换。
4. “暂停”会保存续播位置并停止操作。关闭标签页后重新打开，点击“开始”优先恢复上次课程和分集。
5. 页面不匹配时点击“下载诊断”。诊断仅下载到本机，可用于调整选择器。

1.1 已核对登录后的课程总页、分集目录和 XGPlayer 播放器结构。
未完整在线等候 20 分钟弹窗；续学、退出恢复和原有流程另做回归检查。
续播位置只保存在当前浏览器本地；不向网站伪造进度，不跳过尚未观看的内容。
1.2.2 支持酷雷曼和 720云 VR 导览。首次启用未配置自动播放的 720云 课件时，助手授权并重载一次导览。
讲解由课件播放，若浏览器要求交互，点一下导览画面。助手从课程总页读取本课进度。
其他跨域播放器、验证码、测验、登录过期等需要手动处理。
完成依据是页面报告的 100%，不是视频播放到末尾；没有进度元素时不会判断为完成。
脚本只操作页面及播放器，不额外发送学习记录请求，不收集账号密码。

适配依据（仅 DOM 名称和页面结构；逻辑重新编写）：
https://github.com/sqhome-jin/enaeaHelperPlus/blob/main/enaeaHelperPlus.js
https://greasyfork.org/en/scripts/587714/code
*/

(async function () {
  'use strict';

  const CONFIG = Object.freeze({
    version: '1.3.0',
    origin: 'https://study.enaea.edu.cn',
    circleId: '395435',
    syllabusId: '2321900',
    catalog: 'https://study.enaea.edu.cn/circleIndexRedirect.do?action=toNewMyClass&type=course&circleId=395435&syllabusId=2321900&isRequired=true&studentProgress=0',
    tickMs: 1500,
    settleMs: 4000,
    completionMs: 8000,
    loadTimeoutMs: 45000,
    navigationTimeoutMs: 25000,
    finalProgressTimeoutMs: 120000,
    vrPollMs: 90000,
    leaseMs: 12000,
  });
  const VR_AUDIO_CHANNEL = 'enaea-vr-audio-v1';
  const yunOrigins = ['https://www.720yun.com', 'https://720yun.com'];
  function vrTypeForOrigin(origin) {
    if (yunOrigins.includes(origin)) return '720yun-vr';
    if (origin === 'https://www.kuleiman.com' || origin === 'https://kuleiman.com') return 'kuleiman-vr';
    return null;
  }
  function vrTypeForURL(url) {
    if (url.username || url.password) return null;
    const type = vrTypeForOrigin(url.origin);
    if (type === '720yun-vr' && /^\/vr\/[a-zA-Z0-9]+$/.test(url.pathname)) return type;
    if (type === 'kuleiman-vr' && /^\/\d+\/index\.html$/.test(url.pathname)) return type;
    return null;
  }

  function installVrAudioBridge() {
    const ancestorOrigin = location.ancestorOrigins?.[0];
    if (ancestorOrigin && ancestorOrigin !== CONFIG.origin) return;
    let fromStudy = ancestorOrigin === CONFIG.origin;
    if (!ancestorOrigin && document.referrer) {
      try { fromStudy = new URL(document.referrer).origin === CONFIG.origin; } catch { /* 等待父页握手。 */ }
    }
    // 尽早识别课件在内存中创建的播放器，尚未收到设置时音量保持原样。
    let setMuted = fromStudy ? trackVrAudio() : null;
    function reply(payload) {
      window.parent.postMessage({ channel: VR_AUDIO_CHANNEL, ...payload }, CONFIG.origin);
    }
    window.addEventListener('message', event => {
      const msg = event.data;
      if (event.source !== window.parent || event.origin !== CONFIG.origin || msg?.channel !== VR_AUDIO_CHANNEL) return;
      if (msg.type === 'probe') {
        setMuted ||= trackVrAudio();
        reply({ type: 'ready' });
      } else if (msg.type === 'set-muted' && typeof msg.muted === 'boolean') {
        setMuted ||= trackVrAudio();
        setMuted(msg.muted);
        reply({ type: 'muted-state', muted: msg.muted });
      }
    });
    reply({ type: 'ready' });
  }

  function trackVrAudio() {
    let muted = false;
    const mediaRefs = new Set(), outputRefs = new Set();
    const seenMedia = new WeakSet(), savedMuted = new WeakMap();
    const mediaProto = window.HTMLMediaElement?.prototype;
    const muteProperty = mediaProto && Object.getOwnPropertyDescriptor(mediaProto, 'muted');
    function rememberMedia(el) {
      if (!mediaProto?.isPrototypeOf(el)) return;
      if (!seenMedia.has(el)) {
        seenMedia.add(el);
        mediaRefs.add(new WeakRef(el));
      }
      if (muted && muteProperty) {
        if (!savedMuted.has(el)) savedMuted.set(el, el.muted);
        if (!el.muted) muteProperty.set.call(el, true);
      }
    }
    if (mediaProto && muteProperty) {
      // 有些导览用未插入页面的 Audio 实例播放，原生自动播放不会调用脚本可见的 play()。
      if (window.Audio) window.Audio = new Proxy(window.Audio, {
        construct(target, args, newTarget) {
          const el = Reflect.construct(target, args, newTarget);
          rememberMedia(el);
          return el;
        },
        apply(target, receiver, args) {
          const el = Reflect.apply(target, receiver, args);
          rememberMedia(el);
          return el;
        },
      });
      const play = mediaProto.play;
      mediaProto.play = function (...args) {
        rememberMedia(this);
        return play.apply(this, args);
      };
      // 记住课件在助手静音期间自行设置的静音状态，取消时恢复。
      if (muteProperty.configurable) Object.defineProperty(mediaProto, 'muted', {
        ...muteProperty,
        set(value) {
          if (muted) {
            rememberMedia(this);
            savedMuted.set(this, Boolean(value));
          }
          muteProperty.set.call(this, muted || value);
        },
      });
      const autoplay = Object.getOwnPropertyDescriptor(mediaProto, 'autoplay');
      if (autoplay?.configurable) Object.defineProperty(mediaProto, 'autoplay', {
        ...autoplay,
        set(value) { rememberMedia(this); autoplay.set.call(this, value); },
      });
      for (const event of ['loadstart', 'play', 'volumechange']) {
        document.addEventListener(event, e => {
          const el = e.target;
          if (!mediaProto.isPrototypeOf(el)) return;
          if (event === 'volumechange' && muted && !el.muted) savedMuted.set(el, false);
          rememberMedia(el);
        }, true);
      }
    }

    // 只在实时音频连到扬声器的最后一级加独立增益。保留课件的音量、播放时钟和原有连接方式。
    const nodeProto = window.AudioNode?.prototype;
    if (nodeProto) {
      const connect = nodeProto.connect, disconnect = nodeProto.disconnect;
      const outputs = new WeakMap();
      nodeProto.connect = function (destination, ...ports) {
        const ctx = this.context;
        if (!ctx || destination !== ctx.destination || 'startRendering' in ctx) return connect.apply(this, arguments);
        let output = outputs.get(ctx);
        if (!output) {
          output = ctx.createGain();
          output.gain.value = muted ? 0 : 1;
          connect.call(output, destination);
          outputs.set(ctx, output);
          outputRefs.add(new WeakRef(output));
        }
        connect.call(this, output, ...ports);
        return destination;
      };
      nodeProto.disconnect = function (destination, ...ports) {
        const output = outputs.get(this.context);
        if (output && destination === this.context.destination) return disconnect.call(this, output, ...ports);
        return disconnect.apply(this, arguments);
      };
    }

    function eachLive(refs, visit) {
      for (const ref of refs) {
        const item = ref.deref();
        if (item) visit(item);
        else refs.delete(ref);
      }
    }
    return value => {
      if (value === muted) return;
      muted = value;
      for (const el of document.querySelectorAll('audio, video')) rememberMedia(el);
      eachLive(mediaRefs, el => {
        if (muted) rememberMedia(el);
        else if (savedMuted.has(el)) {
          muteProperty.set.call(el, savedMuted.get(el));
          savedMuted.delete(el);
        }
      });
      eachLive(outputRefs, output => { output.gain.value = muted ? 0 : 1; });
    };
  }

  const S = Object.freeze({
    courseLink: '.golearn, .saveStuCourse, [data-vurl*="viewerfor"], a[href*="viewerforccvideo.do"], a[href*="viewerforicourse.do"]',
    courseProgress: '.progressvalue',
    chapterProgress: '.cvtb-MCK-CsCt-studyProgress',
    chapterRow: '.cvtb-MCK-course-content, .cvtb-MCK-CsCt-item, [data-courseware], [data-chapter], li',
    chapterClick: '.cvtb-MCK-CsCt-info, .cvtb-MCK-CsCt-title, a',
    dialogs: '#rest_tip, .dialog, .dialog-box, .dialog-content, .dialog-button-container, .td-content, .el-dialog, .el-message-box, .ant-modal, [role="dialog"], dialog[open], .layui-layer, .ui-dialog, .modal',
    controls: 'button, a, [role="button"], input[type="button"], input[type="submit"], .el-button, .dialog-button, .dialog-button-container > div[onclick], .dialog-button-container > span[onclick]',
    next: '.paginate_button.next, .pagination .next, a[rel="next"]',
    first: '.paginate_button.first, .pagination .first',
    loading: '.dataTables_processing, [aria-busy="true"]',
  });

  function percent(value) {
    const m = String(value ?? '').replace(/％/g, '%').match(/(?:^|[^\d.])(-?\d+(?:\.\d+)?)\s*%/);
    if (!m) return null;
    const n = Number(m[1]);
    return n >= 0 && n <= 100 ? n : null;
  }
  function continueLabel(value) {
    const label = String(value ?? '').replace(/\s+/g, '').replace(/^[▶►›»>]+|[▶►›»>]+$/g, '');
    return /^(继续学习|继续播放|继续|continuelearning|resumelearning|continue)(?:[（(]0+(?:秒|s)?[）)])?$/i.test(label);
  }
  function courseURL(raw) {
    try {
      const u = new URL(raw, CONFIG.origin + '/');
      if (u.origin !== CONFIG.origin || !/^\/viewerfor(?:ccvideo|icourse)\.do$/.test(u.pathname)) return null;
      if (!/^\d+$/.test(u.searchParams.get('courseId') || '')) return null;
      const circle = u.searchParams.get('circleId');
      if (circle && circle !== CONFIG.circleId) return null;
      if (!circle) u.searchParams.set('circleId', CONFIG.circleId);
      return u.href;
    } catch { return null; }
  }
  function catalogDecision(rows, hasNext, unknownLinks) {
    if (!rows.length || unknownLinks) return { kind: 'unknown' };
    const row = rows.find(r => r.progress !== 100);
    if (row) return row.progress === null ? { kind: 'unknown' } : { kind: 'course', row };
    return { kind: hasNext ? 'next' : 'done' };
  }
  function playerDecision(rows, current) {
    if (!rows.length || rows.some(r => r.progress === null)) return { kind: 'unknown' };
    if (rows.every(r => r.progress === 100)) return { kind: 'done' };
    if (!current || current.progress === 100) return { kind: 'chapter', row: rows.find(r => r.progress !== 100) };
    return { kind: 'play', row: current };
  }

  // Node 离线测试只载入上述纯决策函数，不访问浏览器。
  if (typeof module === 'object' && module.exports && typeof window === 'undefined') {
    module.exports = { CONFIG, percent, continueLabel, courseURL, catalogDecision, playerDecision };
    return;
  }
  const here = new URL(location.href);
  if (window.top !== window.self) {
    if (window.parent === window.top && vrTypeForURL(here)) installVrAudioBridge();
    return;
  }
  if (here.origin !== CONFIG.origin) return;
  const isCatalog = here.pathname === '/circleIndexRedirect.do' && here.searchParams.get('type') === 'course';
  const isPlayer = /^\/viewerfor(?:ccvideo|icourse)\.do$/.test(here.pathname);
  if ((!isCatalog && !isPlayer) || here.searchParams.get('circleId') !== CONFIG.circleId) return;
  if (isCatalog && here.searchParams.get('syllabusId') !== CONFIG.syllabusId) return;
  if (document.getElementById('enaea-local-helper')) return;

  const PREFIX = 'enaea-local-helper:395435:2321900:';
  const OWNER = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : String(Date.now()) + Math.random();
  const state = {
    enabled: false, muted: true, storageOK: true, owns: false, claimedAt: 0,
    status: '就绪：点击开始，优先恢复上次课程与分集', startedAt: Date.now(),
    stableKey: '', stableAt: Date.now(), pending: null, finishingAt: 0,
    endedAt: 0, selected: null, playErrors: 0, busy: false, logs: [],
    resumeChecked: false, restore: null, tracking: false, savedAt: 0,
    vr: null,
  };
  let ui;
  const lastClicks = new WeakMap();
  const lastPlay = new WeakMap();
  const yunAutoplayReloads = new WeakMap();

  function readSession(key, fallback) {
    try { const x = sessionStorage.getItem(PREFIX + key); return x === null ? fallback : JSON.parse(x); }
    catch { state.storageOK = false; return fallback; }
  }
  function saveSession(key, value) {
    try { sessionStorage.setItem(PREFIX + key, JSON.stringify(value)); }
    catch { state.storageOK = false; }
  }
  state.enabled = readSession('enabled', false) === true;
  function readMutePreference() {
    const previous = readSession('muted', null);
    try {
      const saved = localStorage.getItem(PREFIX + 'muted');
      if (saved === 'true' || saved === 'false') return saved === 'true';
      if (typeof previous === 'boolean') localStorage.setItem(PREFIX + 'muted', String(previous));
    } catch { /* 保留本标签页已有的偏好。 */ }
    return previous !== false;
  }
  state.muted = readMutePreference();

  // 与标签页开关分开保存，关闭标签页或浏览器后仍能找到上次分集。
  function readCheckpoint() {
    let raw;
    try { raw = localStorage.getItem(PREFIX + 'resume-v1'); }
    catch { state.storageOK = false; return null; }
    try {
      const saved = JSON.parse(raw || 'null');
      const url = saved && courseURL(saved.url);
      if (!url || saved.version !== 1 || new URL(url).searchParams.get('courseId') !== saved.courseId ||
          typeof saved.chapterId !== 'string' || !saved.chapterId ||
          !Number.isFinite(saved.time) || saved.time < 0) return null;
      return { ...saved, url };
    } catch { return null; }
  }
  function clearCheckpoint(courseId) {
    try {
      const saved = readCheckpoint();
      if (saved && (!courseId || saved.courseId === courseId)) localStorage.removeItem(PREFIX + 'resume-v1');
    } catch { state.storageOK = false; }
  }
  function currentChapter(rows) {
    return rows.find(r => r.current) || (rows.length === 1 ? rows[0] : null) ||
      (state.selected && rows.find(r => r.key === state.selected.key && r.row === state.selected.row));
  }
  function rememberPosition(force = false) {
    if (!isPlayer || !state.tracking || !state.owns || state.pending || state.restore || (!force && !state.enabled)) return;
    if (!force && Date.now() - state.savedAt < 3000) return;
    const current = currentChapter(chapterRows());
    const video = media()[0];
    if (!current || current.progress === null || current.progress === 100 || !video || video.error ||
        video.readyState === 0 || !Number.isFinite(video.duration) || video.duration <= 0 ||
        !Number.isFinite(video.currentTime)) return;
    try {
      localStorage.setItem(PREFIX + 'resume-v1', JSON.stringify({
        version: 1, url: courseURL(location.href), courseId: here.searchParams.get('courseId'),
        chapterId: current.chapterId, time: Math.max(0, Math.min(video.currentTime, video.duration)),
        duration: video.duration, at: Date.now(),
      }));
      state.savedAt = Date.now();
    } catch { state.storageOK = false; }
  }

  function log(code) {
    state.logs.push({ at: new Date().toISOString(), code });
    state.logs = state.logs.slice(-40);
    console.info('[学习公社连续播放]', code);
  }
  function status(message) {
    state.status = message;
    if (ui) {
      ui.message.textContent = message;
      ui.start.textContent = state.enabled ? '运行中' : '开始';
      ui.start.disabled = state.enabled;
      ui.pause.disabled = !state.enabled;
      const vr = !!findVrTour();
      ui.pause.textContent = vr ? '暂停跟踪' : '暂停';
    }
  }
  function stop(message) {
    rememberPosition(true);
    state.enabled = false;
    saveSession('enabled', false);
    release();
    status(message);
    log('stopped');
  }
  function release() {
    clearVr();
    try {
      const lease = JSON.parse(localStorage.getItem(PREFIX + 'lease') || 'null');
      if (lease?.owner === OWNER) localStorage.removeItem(PREFIX + 'lease');
    } catch { /* 下次 heartbeat 会报告存储错误。 */ }
    state.owns = false;
  }
  function claim() {
    try {
      const now = Date.now();
      const lease = JSON.parse(localStorage.getItem(PREFIX + 'lease') || 'null');
      if (lease && lease.owner !== OWNER && lease.until > now) {
        clearVr();
        state.owns = false;
        status('另一个学习标签页正在运行；请保留一个运行页面');
        return false;
      }
      localStorage.setItem(PREFIX + 'lease', JSON.stringify({ owner: OWNER, until: now + CONFIG.leaseMs }));
      if (!state.owns) { state.owns = true; state.claimedAt = now; return false; }
      return now - state.claimedAt >= CONFIG.tickMs;
    } catch {
      state.storageOK = false;
      stop('浏览器存储不可用，无法保存状态；请检查站点存储权限');
      return false;
    }
  }

  function visible(el) {
    if (!el?.isConnected || el.hidden || el.closest('[hidden], [aria-hidden="true"]')) return false;
    const w = el.ownerDocument.defaultView;
    const css = w.getComputedStyle(el);
    return css.display !== 'none' && css.visibility !== 'hidden' && css.visibility !== 'collapse' && el.getClientRects().length > 0;
  }
  function enabled(el) {
    return visible(el) && !el.disabled && !el.closest('.disabled, .paginate_button_disabled, [disabled], [aria-disabled="true"]') && el.ownerDocument.defaultView.getComputedStyle(el).pointerEvents !== 'none';
  }
  function text(el) { return String(el?.innerText || el?.textContent || el?.value || '').replace(/\s+/g, ' ').trim(); }
  function vrPlayerType(el) {
    const src = el.getAttribute('src');
    if (!src) return null;
    try { return vrTypeForURL(new URL(src, here)); } catch { return null; }
  }
  function findVrTour() {
    if (here.pathname !== '/viewerforicourse.do') return null;
    for (const frame of document.querySelectorAll('.courseView iframe')) {
      if (!visible(frame)) continue;
      const playerType = vrPlayerType(frame);
      if (playerType) return { frame, playerType };
    }
    return null;
  }
  function docs() {
    const result = [], seen = new Set();
    function visit(d, depth) {
      if (!d || seen.has(d) || depth > 5) return;
      seen.add(d); result.push(d);
      for (const f of d.querySelectorAll('iframe, frame')) {
        try { if (visible(f) && !vrPlayerType(f)) visit(f.contentDocument, depth + 1); } catch { /* 跨域 iframe 不访问。 */ }
      }
    }
    visit(document, 0);
    return result;
  }
  function all(selector, documents = docs()) {
    return documents.flatMap(d => Array.from(d.querySelectorAll(selector)));
  }
  function media() { return all('video').filter(visible); }

  // 声音开关在跟踪暂停时也可使用。跨域课件加载后先确认实际来源，再发送静音偏好。
  let vrAudio = null;
  if (isPlayer) window.addEventListener('message', receiveVrAudio);
  function renderAudioHint() {
    if (!ui?.audioHint) return;
    ui.audioHint.hidden = !vrAudio || vrAudio.confirmed === state.muted || Date.now() - vrAudio.since < 8000;
  }
  function resetVrAudioConnection() {
    if (!vrAudio) return;
    vrAudio.origin = null;
    vrAudio.confirmed = null;
    vrAudio.lastSent = 0;
    vrAudio.since = Date.now();
    syncVrAudio();
  }
  function selectVrAudioFrame(tour) {
    const frame = tour?.frame;
    if (vrAudio?.frame === frame) return;
    if (vrAudio) vrAudio.frame.removeEventListener('load', resetVrAudioConnection);
    vrAudio = frame ? { frame, origin: null, confirmed: null, lastSent: 0, since: Date.now() } : null;
    if (frame) frame.addEventListener('load', resetVrAudioConnection);
    renderAudioHint();
  }
  function syncVrAudio(tour = findVrTour(), force = false) {
    selectVrAudioFrame(tour);
    if (!vrAudio) return;
    renderAudioHint();
    if (!force && (vrAudio.confirmed === state.muted || Date.now() - vrAudio.lastSent < 3000)) return;
    vrAudio.lastSent = Date.now();
    const target = vrAudio.frame.contentWindow;
    if (vrAudio.origin) {
      target?.postMessage({ channel: VR_AUDIO_CHANNEL, type: 'set-muted', muted: state.muted }, vrAudio.origin);
    } else {
      // 此帧的 www 地址可能跳转到裸域。探测消息不含任何偏好或课程数据。
      target?.postMessage({ channel: VR_AUDIO_CHANNEL, type: 'probe' }, '*');
    }
  }
  function receiveVrAudio(event) {
    const msg = event.data;
    if (msg?.channel !== VR_AUDIO_CHANNEL || (msg.type !== 'ready' && msg.type !== 'muted-state')) return;
    const tour = findVrTour();
    if (!tour || !event.source || event.source !== tour.frame.contentWindow || vrTypeForOrigin(event.origin) !== tour.playerType) return;
    selectVrAudioFrame(tour);
    if (msg.type === 'ready') {
      vrAudio.origin = event.origin;
      vrAudio.confirmed = null;
      vrAudio.since = Date.now();
      syncVrAudio(tour, true);
    } else if (vrAudio.origin === event.origin && msg.muted === state.muted) {
      vrAudio.confirmed = msg.muted;
      renderAudioHint();
    }
  }
  function applyMutePreference() {
    ui.muted.checked = state.muted;
    if (!isPlayer) return;
    const tour = findVrTour();
    if (vrAudio) { vrAudio.confirmed = null; vrAudio.since = Date.now(); }
    syncVrAudio(tour, true);
    if (!tour) for (const video of media()) video.muted = state.muted;
  }
  function initAudioControls() {
    ui.muted.addEventListener('change', () => {
      state.muted = ui.muted.checked;
      saveSession('muted', state.muted);
      try { localStorage.setItem(PREFIX + 'muted', String(state.muted)); } catch { /* 当前标签页仍可使用。 */ }
      applyMutePreference();
    });
    window.addEventListener('storage', event => {
      if (event.key === PREFIX + 'muted' && (event.newValue === 'true' || event.newValue === 'false')) {
        state.muted = event.newValue === 'true';
        applyMutePreference();
      }
    });
    applyMutePreference();
  }
  function click(el, code) {
    if (!enabled(el)) return false;
    const now = Date.now();
    if (now - (lastClicks.get(el) || 0) < 5000) return false;
    lastClicks.set(el, now);
    el.click();
    log(code);
    return true;
  }
  function ancestorWithOne(el, selector) {
    for (let p = el.parentElement; p && p !== el.ownerDocument.body; p = p.parentElement) {
      const n = p.querySelectorAll(selector).length;
      if (n === 1) return p;
      if (n > 1) break;
    }
    return null;
  }
  function courseRows() {
    const rows = [], seen = new Set();
    let unknown = 0;
    for (const link of all(S.courseLink).filter(visible)) {
      const url = courseURL(link.getAttribute('data-vurl') || link.getAttribute('href'));
      if (!url) { unknown++; continue; }
      const id = new URL(url).searchParams.get('courseId');
      if (seen.has(id)) continue;
      seen.add(id);
      let row = null;
      for (let p = link.parentElement; p && p !== link.ownerDocument.body; p = p.parentElement) {
        const ps = p.querySelectorAll(S.courseProgress);
        if (ps.length === 1) { row = p; break; }
        if (ps.length > 1) break;
      }
      rows.push({ key: id, url, progress: row ? percent(text(row.querySelector(S.courseProgress))) : null });
    }
    return { rows, unknown };
  }
  function chapterRows() {
    return all(S.chapterProgress).map((p, i) => {
      const row = p.closest(S.chapterRow) || ancestorWithOne(p, S.chapterProgress);
      const control = row?.querySelector(S.chapterClick);
      const current = !!row && (row.matches('.current, .active, [aria-current="true"]') || !!row.querySelector('.current, [aria-current="true"]'));
      const chapterId = row?.getAttribute('data-id') || row?.id || 'index:' + i;
      return { key: String(i), chapterId, progress: percent(text(p)), row, control, current };
    });
  }

  function dialogs() {
    const roots = new Set();
    for (const el of all(S.dialogs).filter(visible)) {
      const outer = el.closest('[role="dialog"], dialog, .el-dialog, .el-message-box, .ant-modal, .ui-dialog, .layui-layer, .modal, #rest_tip, .dialog, .dialog-box');
      roots.add(outer || el.parentElement || el);
    }
    // 某些页面将按钮直接置于 body，仍只匹配明确的续学文字。
    for (const el of all(S.controls).filter(visible)) {
      if (continueLabel(text(el))) roots.add(el.closest('[role="dialog"], .el-dialog, .el-message-box, .ant-modal, .dialog, .dialog-box, .layui-layer, .ui-dialog, .modal, #rest_tip') || el.parentElement);
    }
    return [...roots].filter(Boolean);
  }
  function handleDialogs() {
    const roots = dialogs();
    for (const root of roots) {
      const fields = root.querySelectorAll('input[type="radio"], input[type="checkbox"], textarea, input[type="text"], input[type="password"]');
      if ([...fields].some(visible) || /验证码|人脸识别|随堂测验|请作答|单选题|多选题/.test(text(root))) {
        status('等待手动处理验证或测验，处理后会继续运行');
        return true;
      }
    }
    for (const root of roots) {
      const candidates = [...(root.matches(S.controls) ? [root] : []), ...root.querySelectorAll(S.controls + ', #ccH5jumpInto')].filter(el => (continueLabel(text(el)) || el.id === 'ccH5jumpInto') && enabled(el));
      if (candidates.length) {
        if (click(candidates[0], 'continue-learning')) {
          state.startedAt = Date.now(); state.playErrors = 0;
          status('已点击继续学习，等待播放器恢复');
        }
        return true;
      }
    }
    if (roots.length) { status('等待弹窗处理或休息倒计时结束'); return true; }
    const jump = all('#ccH5jumpInto').find(enabled);
    if (jump) { click(jump, 'resume-position'); status('正在恢复上次播放位置'); return true; }
    return false;
  }

  function stable(key) {
    if (key !== state.stableKey) { state.stableKey = key; state.stableAt = Date.now(); }
    return Date.now() - state.stableAt >= CONFIG.settleMs;
  }
  function navigate(url, code) {
    rememberPosition(true);
    state.pending = { kind: 'navigation', at: Date.now() };
    log(code);
    release();
    location.assign(url);
  }
  function resetSweep() { saveSession('sweepStarted', false); }
  function pageSignature(rows) {
    const page = all('.paginate_active, .paginate_button.current, .pagination .active, [aria-current="page"]').filter(visible).map(text).join('|');
    return JSON.stringify([page, rows.map(r => [r.key, r.progress])]);
  }

  function catalogTick() {
    if (all(S.loading).some(visible)) { status('等待课程列表加载'); return; }
    const { rows, unknown } = courseRows();
    const signature = pageSignature(rows);
    if (state.pending?.kind === 'page') {
      if (signature === state.pending.signature) {
        if (Date.now() - state.pending.at > CONFIG.navigationTimeoutMs) stop('翻页后列表未更新；请下载诊断并检查分页');
        return;
      }
      state.pending = null;
      state.startedAt = Date.now();
      state.stableKey = '';
    }
    if (!stable(signature)) { status('等待课程列表稳定'); return; }
    if (!readSession('sweepStarted', false)) {
      saveSession('sweepStarted', true);
      let first = all(S.first).find(enabled);
      if (!first) first = all('.paginate_button, .pagination a').find(el => text(el) === '1' && enabled(el) && !el.matches('.current') && !el.closest('.active'));
      if (first && click(first, 'catalog-first-page')) {
        state.pending = { kind: 'page', signature, at: Date.now() };
        status('从第一页开始检查课程');
        return;
      }
    }
    const next = all(S.next).find(enabled);
    const decision = catalogDecision(rows, !!next, unknown);
    if (decision.kind === 'unknown') {
      if (Date.now() - state.startedAt > CONFIG.loadTimeoutMs) stop('无法完整匹配课程与进度；请下载诊断');
      else status('等待可识别的课程及进度');
    } else if (decision.kind === 'course') {
      const returned = readSession('justReturned', null);
      if (returned?.id === decision.row.key) {
        if (Date.now() - returned.at <= CONFIG.finalProgressTimeoutMs) status('分集已完成，等待总页同步进度；暂不重复进入');
        else stop('分集为 100%，但总页仍未同步；请手动刷新核对后重新开始');
        return;
      }
      status('进入未完成课程：' + decision.row.key + '（' + decision.row.progress + '%）');
      navigate(decision.row.url, 'open-course');
    } else if (decision.kind === 'next') {
      if (click(next, 'catalog-next-page')) {
        state.pending = { kind: 'page', signature, at: Date.now() };
        status('本页已完成，正在翻到下一页');
      }
    } else {
      stop('当前课程列表各页均显示 100%，已停止');
    }
  }

  async function playVideos() {
    const videos = media();
    if (!videos.length) {
      status('未找到可访问的视频；若为跨域播放器，请下载诊断');
      if (Date.now() - state.startedAt > CONFIG.loadTimeoutMs) stop('未识别播放器，需要根据诊断调整');
      return;
    }
    let ended = false;
    for (const video of videos) {
      if (!state.enabled) return;
      if (video.error) { stop('播放器报告加载错误，请检查网络后重新开始'); return; }
      video.muted = state.muted;
      if (video.playbackRate !== 1) video.playbackRate = 1;
      if (video.ended) { ended = true; continue; }
      if (video.paused && Date.now() - (lastPlay.get(video) || 0) >= 5000) {
        lastPlay.set(video, Date.now());
        let timer;
        try {
          await Promise.race([
            Promise.resolve(video.play()),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('play timeout')), 9000); }),
          ]);
          if (!state.enabled) return;
          state.playErrors = 0;
        }
        catch (e) {
          if (!state.enabled) return;
          state.playErrors++;
          if (e.name === 'NotAllowedError') {
            status('浏览器阻止自动播放：请手动点一次视频播放，再保持此页运行');
            return;
          }
          if (state.playErrors >= 5) { stop('播放器连续启动失败，请手动播放后重新开始'); return; }
          status('等待播放器准备完成');
          return;
        } finally { clearTimeout(timer); }
      }
    }
    if (ended) {
      state.endedAt ||= Date.now();
      status('视频已播完，等待网站将进度更新到 100%');
      if (Date.now() - state.endedAt > CONFIG.finalProgressTimeoutMs) stop('播完后进度仍未到 100%；请检查学时记录，避免反复切换');
    } else {
      state.endedAt = 0;
      status('正在常速播放；自动处理继续学习提示');
    }
  }

  function readVrCatalog(frame, scan, courseId) {
    const loading = { kind: 'loading' };
    const unknown = { kind: 'unknown' };
    try {
      const doc = frame.contentDocument;
      if (!doc || doc.URL === 'about:blank' || doc.readyState === 'loading') return loading;
      const url = new URL(doc.URL);
      const catalog = new URL(CONFIG.catalog);
      if (url.origin !== catalog.origin || url.pathname !== catalog.pathname ||
          ['action', 'type', 'circleId', 'syllabusId'].some(k => url.searchParams.get(k) !== catalog.searchParams.get(k))) return unknown;
      if (Array.from(doc.querySelectorAll(S.loading)).some(visible)) return loading;
      const table = doc.querySelector('#J_myOptionRecords');
      if (!table) return loading;

      const rowKeys = [], matches = [];
      let firstLink = null;
      for (const row of table.querySelectorAll('tr')) {
        const links = Array.from(row.querySelectorAll('.golearn[data-vurl]')).filter(link => link.closest('tr') === row);
        if (!links.length) continue;
        firstLink ||= links[0];
        const urls = links.map(link => courseURL(link.getAttribute('data-vurl')));
        rowKeys.push(urls);
        const isTarget = raw => {
          if (!raw) return false;
          const entry = new URL(raw);
          return entry.pathname === '/viewerforicourse.do' && entry.searchParams.get('courseId') === String(courseId);
        };
        if (!urls.some(isTarget)) continue;
        if (!urls.every(isTarget)) return unknown;
        const cells = Array.from(row.querySelectorAll('.progressvalue')).filter(cell => cell.closest('tr') === row);
        const label = cells.length === 1 ? text(cells[0]) : '';
        const value = /^\d+(?:\.\d+)?\s*[%％]$/.test(label) ? percent(label) : null;
        if (value === null) return unknown;
        matches.push(value);
      }
      if (matches.length) return matches.every(p => p === matches[0]) ? { kind: 'progress', progress: matches[0] } : unknown;

      const allTab = Array.from(doc.querySelectorAll('.customcur-tabs-wrapper .customcur-tab'))
        .find(tab => text(tab.querySelector('.customcur-tab-text')) === '所有课程');
      if (!allTab) return loading;
      const allSelected = allTab.classList.contains('customcur-tab-select');
      const signature = JSON.stringify(rowKeys);
      if (scan.pending) {
        // DataTables can update the selected tab or page number before replacing its rows.
        if (scan.pending.tab && !allSelected) return loading;
        if (scan.pending.firstLink === firstLink && scan.pending.signature === signature) return loading;
        scan.pending = null;
      }
      if (!allSelected) {
        scan.pending = { tab: true, firstLink, signature };
        allTab.click();
        return loading;
      }
      if (!firstLink) return loading;
      const next = doc.querySelector('#J_myOptionRecords_paginate .paginate_button.next');
      if (!next || next.closest('.disabled, .paginate_button_disabled, [disabled], [aria-disabled="true"]')) return unknown;
      scan.pages ||= new Set();
      if (scan.pages.has(signature)) return unknown;
      scan.pages.add(signature);
      scan.pending = { tab: false, firstLink, signature };
      next.click();
      return loading;
    } catch { return unknown; }
  }

  function createVrProbe() {
    // 放在面板的 Shadow DOM 中，普通播放器和弹窗扫描不会遍历这个目录。
    const probe = document.createElement('iframe');
    probe.title = '课程总页进度核对';
    probe.setAttribute('aria-hidden', 'true');
    probe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    probe.tabIndex = -1;
    probe.style.cssText = 'position:fixed;left:-1100px;top:0;width:1024px;height:640px;border:0;pointer-events:none';
    probe.src = CONFIG.catalog;
    ui.root.appendChild(probe);
    return probe;
  }
  function clearVr() {
    state.vr?.probe?.remove();
    state.vr = null;
  }
  function yunAutoplayPolicy(frame) {
    const configured = yunAutoplayReloads.get(frame);
    if (configured) return configured;
    return /(?:^|;)\s*autoplay(?=[\s;=]|$)/i.test(frame.getAttribute('allow') || '') ? 'site-configured' : 'not-configured';
  }
  function prepareYunAutoplay(frame) {
    const policy = yunAutoplayPolicy(frame);
    if (!state.enabled || !state.owns || policy !== 'not-configured') return policy;
    const allow = frame.getAttribute('allow') || '';
    const src = frame.getAttribute('src');
    const separator = !allow.trim() ? '' : /;\s*$/.test(allow) ? ' ' : '; ';
    // 导航后新授权才对课件生效。同一课件 iframe 至多重载一次，原样使用平台的签名地址。
    try {
      frame.setAttribute('allow', allow + separator + 'autoplay ' + yunOrigins.join(' '));
      frame.setAttribute('src', src);
      yunAutoplayReloads.set(frame, 'delegated-on-reload');
      log('vr-autoplay-delegated');
    } catch {
      yunAutoplayReloads.set(frame, 'reload-failed');
      log('vr-autoplay-reload-failed');
    }
    return yunAutoplayReloads.get(frame);
  }
  function vrTick({ frame, playerType }) {
    if (state.vr?.frame !== frame) {
      clearVr();
      state.vr = { frame, probe: null, scan: null, nextCheck: 0, checkedAt: 0, progress: null, finishedAt: 0, unavailable: false };
      log('vr-tour-detected');
    }
    const vr = state.vr;
    const now = Date.now();
    const courseId = here.searchParams.get('courseId');
    if (vr.progress === 100) {
      status('VR 课程总页进度已达 100%，即将返回课程列表');
      if (now - vr.finishedAt >= CONFIG.completionMs) {
        clearCheckpoint(courseId);
        saveSession('justReturned', { id: courseId, at: now });
        resetSweep();
        navigate(CONFIG.catalog, 'vr-complete-return');
      }
      return;
    }
    if (!vr.probe && now >= vr.nextCheck) {
      vr.scan = {};
      vr.probe = createVrProbe();
      vr.checkedAt = now;
    }
    if (vr.probe) {
      const result = readVrCatalog(vr.probe, vr.scan, courseId);
      if (result.kind !== 'loading' || now - vr.checkedAt >= CONFIG.loadTimeoutMs) {
        vr.probe.remove();
        vr.probe = null;
        vr.scan = null;
        vr.nextCheck = now + CONFIG.vrPollMs;
        vr.unavailable = result.kind !== 'progress';
        if (!vr.unavailable) vr.progress = result.progress;
        if (vr.progress === 100) {
          vr.finishedAt = now;
          log('vr-catalog-confirmed');
          status('VR 课程总页进度已达 100%，即将返回课程列表');
          return;
        }
      }
    }
    const yun = playerType === '720yun-vr';
    const label = yun ? '720 云 VR：' : '酷雷曼 VR：';
    let hint = '。若讲解未开始，请在课件内播放';
    if (yun) hint = prepareYunAutoplay(frame) === 'delegated-on-reload' ? '。已请求自动播放' : '。若讲解未开始，点一下导览画面';
    if (vr.unavailable) status(label + '暂未读到本课的总页进度，稍后自动重查' + hint);
    else if (vr.progress !== null) status(label + '平台进度 ' + vr.progress + '%' + hint);
    else status(label + '正在核对本课的总页进度' + hint);
  }

  async function playerTick() {
    const tour = findVrTour();
    if (tour) { vrTick(tour); return; }
    if (state.vr) {
      clearVr();
      state.startedAt = Date.now();
    }
    const rows = chapterRows();
    const current = currentChapter(rows);
    const signature = JSON.stringify(rows.map(r => [r.key, r.progress, r.current]));
    if (!state.resumeChecked && rows.length && rows.every(r => r.progress !== null)) {
      const saved = readCheckpoint();
      state.resumeChecked = true;
      const target = saved?.courseId === here.searchParams.get('courseId') && rows.find(r => r.chapterId === saved.chapterId);
      if (target && target.progress !== 100) {
        state.restore = { chapterId: target.chapterId, time: Math.max(0, saved.time - 2) };
        log('restore-saved-chapter');
      } else {
        if (saved?.courseId === here.searchParams.get('courseId')) clearCheckpoint(saved.courseId);
        state.tracking = true;
      }
    }
    if (state.pending?.kind === 'chapter') {
      const target = rows.find(r => r.key === state.pending.key);
      const changedMedia = media().some(v => v.currentSrc && v.currentSrc !== state.pending.source);
      if ((target?.current && (changedMedia || !state.pending.source)) || (!rows.some(r => r.current) && changedMedia && Date.now() - state.pending.at >= CONFIG.completionMs)) {
        state.selected = target || null;
        state.pending = null;
        state.endedAt = 0;
        state.tracking = !state.restore;
        return;
      }
      if (Date.now() - state.pending.at > CONFIG.navigationTimeoutMs) {
        stop('点击分集后未确认切换成功；请手动选集并下载诊断');
        return;
      }
      status('等待分集播放器切换');
      return;
    }
    if (state.restore) {
      const target = rows.find(r => r.chapterId === state.restore.chapterId);
      if (!target || target.progress === 100) {
        state.restore = null; state.tracking = true;
      } else if (current?.chapterId !== target.chapterId) {
        if (!stable(signature)) { status('等待目录稳定后恢复上次分集'); return; }
        const source = media()[0]?.currentSrc || '';
        if (!target.control || !click(target.control, 'restore-chapter')) {
          stop('已保存上次分集，但无法点击目录；请手动选集后重新开始'); return;
        }
        state.pending = { kind: 'chapter', key: target.key, source, at: Date.now() };
        state.selected = null; state.tracking = false; state.startedAt = Date.now();
        status('正在恢复上次分集'); return;
      } else {
        const video = media()[0];
        if (!video || video.readyState < 1 || !Number.isFinite(video.duration) || video.duration <= 0) {
          await playVideos();
          if (state.enabled) status('正在加载上次分集，已保留续播位置');
          return;
        }
        const targetTime = Math.min(state.restore.time, Math.max(0, video.duration - 1));
        try {
          if (video.currentTime + 1 < targetTime) video.currentTime = targetTime;
        } catch {
          stop('已恢复分集，但无法恢复播放位置；请手动定位后继续'); return;
        }
        state.restore = null; state.tracking = true;
        log('restore-saved-position');
      }
    }
    const decision = playerDecision(rows, current);
    if (decision.kind === 'unknown') {
      state.finishingAt = 0;
      status('等待分集目录和进度加载');
      if (Date.now() - state.startedAt > CONFIG.loadTimeoutMs) stop('分集目录或进度无法识别；请下载诊断');
      return;
    }
    if (decision.kind === 'done') {
      state.finishingAt ||= Date.now();
      status('本课程各分集均为 100%，等待最后的记录保存');
      if (Date.now() - state.finishingAt >= CONFIG.completionMs) {
        clearCheckpoint(here.searchParams.get('courseId'));
        saveSession('justReturned', { id: here.searchParams.get('courseId'), at: Date.now() });
        resetSweep();
        navigate(CONFIG.catalog, 'course-complete-return');
      }
      return;
    }
    state.finishingAt = 0;
    if (decision.kind === 'chapter') {
      if (!stable(signature)) { status('等待分集目录稳定'); return; }
      const target = decision.row;
      const source = media()[0]?.currentSrc || '';
      if (!target.control || !click(target.control, 'select-chapter')) {
        stop('找到未完成分集，但无法点击其目录；请下载诊断');
        return;
      }
      state.pending = { kind: 'chapter', key: target.key, source, at: Date.now() };
      state.tracking = false;
      state.selected = null;
      state.endedAt = 0;
      state.startedAt = Date.now();
      status('正在切换到未完成分集');
      return;
    }
    await playVideos();
  }

  async function tick() {
    if (isPlayer) {
      const tour = findVrTour();
      syncVrAudio(tour);
      if (!tour && !state.enabled) for (const video of media()) {
        if (video.muted !== state.muted) video.muted = state.muted;
      }
    }
    if (state.busy || !state.enabled) return;
    state.busy = true;
    try {
      if (!claim()) return;
      if (isPlayer) rememberPosition();
      if (state.pending?.kind === 'navigation') {
        if (Date.now() - state.pending.at > CONFIG.navigationTimeoutMs) stop('页面跳转未完成，请检查站点提示后重新开始');
        return;
      }
      if (isPlayer && handleDialogs()) return;
      if (isCatalog) catalogTick();
      else { await playerTick(); rememberPosition(); }
    } catch (e) {
      console.error('[学习公社连续播放]', e);
      stop('脚本遇到页面适配错误；请下载诊断');
    } finally { state.busy = false; }
  }

  function diagnostic() {
    const documents = docs();
    const courses = courseRows();
    const tour = findVrTour();
    const payload = {
      version: CONFIG.version, time: new Date().toISOString(),
      page: { path: location.pathname, courseId: here.searchParams.get('courseId'), circleId: CONFIG.circleId, syllabusId: CONFIG.syllabusId },
      status: state.status, running: state.enabled, storageOK: state.storageOK,
      playerType: tour?.playerType ?? (isPlayer ? 'standard-or-unknown' : 'catalog'),
      muted: state.muted,
      vrAudioStatus: !tour ? null : (vrAudio?.frame !== tour.frame || vrAudio.confirmed !== state.muted) ? 'pending' :
        state.muted ? 'muted' : 'released',
      vrAutoplayPolicy: tour?.playerType === '720yun-vr' ? yunAutoplayPolicy(tour.frame) : null,
      vrCatalogProgress: state.vr?.progress ?? null,
      sameOriginDocuments: documents.length,
      iframeCount: all('iframe, frame', documents).length,
      courses: courses.rows.map(r => ({ id: r.key, progress: r.progress })),
      unmatchedCourseLinks: courses.unknown,
      chapters: chapterRows().map(r => ({ index: r.key, progress: r.progress, current: r.current, clickable: !!r.control })),
      videos: media().map(v => ({ paused: v.paused, ended: v.ended, readyState: v.readyState, time: v.currentTime, duration: Number.isFinite(v.duration) ? v.duration : null, error: v.error?.code || null })),
      buttons: all(S.controls).filter(visible).map(text).filter(t => /继续|下一页|continue|resume/i.test(t)).slice(0, 20),
      logs: state.logs,
      checkpoint: (() => { const saved = readCheckpoint(); return saved && { courseId: saved.courseId, chapterId: saved.chapterId, time: saved.time }; })(),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'enaea-diagnostic.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function start() {
    state.enabled = true; state.pending = null; state.startedAt = Date.now();
    state.finishingAt = 0; state.endedAt = 0; state.stableKey = ''; state.playErrors = 0;
    state.resumeChecked = false; state.restore = null; state.tracking = false;
    saveSession('enabled', true); resetSweep();
    saveSession('justReturned', null);
    const saved = isCatalog ? readCheckpoint() : null;
    if (!state.storageOK) { stop('浏览器存储不可用，请先允许此站点保存数据'); return; }
    status('正在启动'); log('started');
    if (saved) navigate(saved.url, 'resume-saved-course');
    else void tick();
  }

  function mount() {
    const host = document.createElement('div');
    host.id = 'enaea-local-helper';
    host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483646;max-width:calc(100vw - 32px)';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      :host{all:initial} *{box-sizing:border-box} section{width:300px;max-width:calc(100vw - 32px);padding:16px;background:#f8fafc;color:#172033;border:1px solid #cad5e2;border-radius:12px;box-shadow:0 6px 24px #0003;font:14px/1.6 system-ui,sans-serif}
      strong{display:block;font-size:15px} p{margin:8px 0;overflow-wrap:anywhere;min-height:44px} button{font:inherit;cursor:pointer;border:1px solid #bcccdc;border-radius:6px;padding:4px 9px;background:white;color:#172033} button:disabled{opacity:.5;cursor:default} .actions{display:flex;gap:6px;flex-wrap:wrap} label{display:block;margin-top:10px} small{display:block;color:#586778;margin-top:6px}
      [hidden]{display:none}
      </style><section><strong>学习公社 · 连续播放 ${CONFIG.version}</strong><p id="status" role="status"></p><div class="actions"><button id="start">开始</button><button id="pause">暂停</button><button id="diag">下载诊断</button></div><label><input id="muted" type="checkbox"> 静音播放</label><small id="audio-hint" role="status" hidden>VR 声音控制尚未连接，请检查脚本管理器是否允许脚本在课件网站运行。</small><small>班级 395435 · 课程进度以平台为准</small></section>`;
    document.documentElement.appendChild(host);
    ui = { root, message: root.getElementById('status'), start: root.getElementById('start'), pause: root.getElementById('pause'), muted: root.getElementById('muted'), audioHint: root.getElementById('audio-hint') };
    initAudioControls();
    ui.start.addEventListener('click', start);
    ui.pause.addEventListener('click', () => {
      const owned = state.owns;
      stop(findVrTour() ? '已暂停进度跟踪，VR 导览由课件控制' : '已暂停，点击开始可继续');
      if (owned && isPlayer) for (const video of media()) video.pause();
    });
    root.getElementById('diag').addEventListener('click', diagnostic);
    status(state.enabled ? '正在恢复本标签页的连续播放' :
      findVrTour() ? '已识别 VR 导览。可在课件内播放，点击本面板的“开始”跟踪进度' : state.status);
    if (!state.storageOK) stop('浏览器存储不可用，请先允许此站点保存数据');
  }

  if (document.readyState === 'loading') {
    await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, { once: true }));
  }
  mount();
  window.addEventListener('pagehide', () => { rememberPosition(true); release(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') rememberPosition(true); });
  setInterval(() => void tick(), CONFIG.tickMs);
  void tick();
})();
