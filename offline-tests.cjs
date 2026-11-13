'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const scriptPath = path.join(__dirname, 'enaea-autoplay.user.js');
const source = fs.readFileSync(scriptPath, 'utf8');
const api = require(scriptPath);

test('百分比只承认有效百分数，空白和未知进度保持未知', () => {
  for (const [input, expected] of [['100%', 100], ['学习进度 99.9 %', 99.9], ['０', null], ['100％', 100], ['0%', 0], ['', null], ['--', null], ['101%', null], ['-1%', null], ['已完成', null]]) {
    assert.equal(api.percent(input), expected, input);
  }
});
test('续学按钮精确匹配，不点击倒计时和其他动作', () => {
  for (const label of ['继续学习', ' 继续 学习 ', '继续播放', 'Continue Learning']) assert.equal(api.continueLabel(label), true);
  for (const label of ['继续学习(10秒)', '确认提交', '提交试卷', '休息后继续学习', '']) assert.equal(api.continueLabel(label), false);
});
test('课程链接限定到目标站点和班级，保留附加参数', () => {
  const u = new URL(api.courseURL('/viewerforccvideo.do?courseId=311988&extra=keep'));
  assert.equal(u.searchParams.get('circleId'), '395435');
  assert.equal(u.searchParams.get('extra'), 'keep');
  for (const value of ['javascript:alert(1)', 'https://example.com/viewerforccvideo.do?courseId=1', '/viewerforccvideo.do?courseId=1&circleId=2', '/exam.do?courseId=1', '/viewerforccvideo.do?courseId=NaN']) assert.equal(api.courseURL(value), null);
});
test('空列表不能视为完成', () => {
  assert.equal(api.catalogDecision([], false, 0).kind, 'unknown');
  assert.equal(api.playerDecision([], null).kind, 'unknown');
});
test('课程列表跳过100%，进入第一门未完成课程', () => {
  const rows = [{ key: 'a', progress: 100 }, { key: 'b', progress: 99.9 }];
  assert.equal(api.catalogDecision(rows, false, 0).row.key, 'b');
});
test('有未知进度或未匹配课程时不盲目切换', () => {
  assert.equal(api.catalogDecision([{ progress: null }], true, 0).kind, 'unknown');
  assert.equal(api.catalogDecision([{ progress: 100 }], true, 1).kind, 'unknown');
  assert.equal(api.playerDecision([{ progress: null }], null).kind, 'unknown');
});
test('完整课程页有下一页则翻页，最后一页才结束', () => {
  assert.equal(api.catalogDecision([{ progress: 100 }], true, 0).kind, 'next');
  assert.equal(api.catalogDecision([{ progress: 100 }], false, 0).kind, 'done');
});
test('播放中的99.9%继续播放，100%才换集', () => {
  const a = { key: 'a', progress: 99.9 }, b = { key: 'b', progress: 0 };
  assert.equal(api.playerDecision([a, b], a).kind, 'play');
  a.progress = 100;
  assert.equal(api.playerDecision([a, b], a).row.key, 'b');
  b.progress = 100;
  assert.equal(api.playerDecision([a, b], a).kind, 'done');
});

// DOM 适配模拟：执行实际脚本函数，仅替换启动入口，以便驱动时钟和页面状态。
// 这些测试不验证真实网站的 CSS 结构，也不模拟服务器确认。
function store() {
  const m = new Map();
  return { getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
}
let owner = 0;
function runtime({ player = false, courseId = '311988', local = store(), session = store(), globals = {} } = {}) {
  let now = 1000000;
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const mapping = new Map();
  const document = {
    body: {}, defaultView: { getComputedStyle: () => ({ display: 'block', visibility: 'visible', pointerEvents: 'auto' }) },
    getElementById: () => null, querySelectorAll: s => mapping.get(s) || [],
    querySelector(s) { return this.querySelectorAll(s)[0] || null; },
  };
  const navigations = [];
  const viewer = player === 'icourse' ? '/viewerforicourse.do' : '/viewerforccvideo.do';
  const location = {
    href: player ? api.CONFIG.origin + viewer + '?courseId=' + courseId + '&circleId=395435' : api.CONFIG.catalog,
    pathname: player ? viewer : '/circleIndexRedirect.do', assign: u => navigations.push(u),
  };
  document.location = new URL(location.href);
  location.origin = document.location.origin;
  document.URL = location.href;
  document.readyState = 'complete';
  const window = new EventTarget(); window.top = window; window.self = window;
  const context = vm.createContext({ document, window, location, crypto: { randomUUID: () => String(++owner) }, Date: Clock, URL,
    console: { info() {}, error() {} }, sessionStorage: session, localStorage: local, setTimeout, clearTimeout, ...globals });
  const mountDeclaration = '  function mount() {';
  assert.ok(source.includes(mountDeclaration));
  const instrumented = source.replace(mountDeclaration, `
    globalThis.testAPI = { S, state, claim, release, tick, handleDialogs, catalogTick, playerTick, stop,
      saveSession, readSession, start, readCheckpoint, rememberPosition, readVrCatalog, diagnostic, mount,
      setUi: value => { ui = value; } };
    return;
  ` + mountDeclaration);
  vm.runInContext(instrumented, context, { filename: scriptPath });
  const a = context.testAPI;
  a.state.enabled = true;
  return { ...a, doc: document, window, mapping, navigations, local, session, advance: n => { now += n; } };
}
function el(r, label = '') {
  const mapping = new Map();
  return { isConnected: true, hidden: false, disabled: false, innerText: label, ownerDocument: r.doc, parentElement: r.doc.body,
    getClientRects: () => [{}], closest: () => null, matches: () => false,
    querySelectorAll: s => mapping.get(s) || [], querySelector(s) { return this.querySelectorAll(s)[0] || null; },
    getAttribute: () => null, clickCount: 0, click() { this.clickCount++; }, mapping };
}
function rest(r, { quiz = false, disabled = false, label = '继续学习', visible = true } = {}) {
  const root = el(r, quiz ? '单选题 继续学习' : label);
  const button = el(r, label); button.disabled = disabled;
  button.parentElement = root; button.matches = s => s.includes('button');
  root.closest = s => s.includes('.dialog') ? root : null;
  button.closest = s => s.includes('.dialog') ? root : null;
  root.mapping.set(r.S.controls, [button]);
  root.mapping.set(r.S.controls + ', #ccH5jumpInto', [button]);
  if (quiz) root.querySelector = s => s.includes('input[type="radio"]') ? {} : null;
  if (!visible) { root.getClientRects = () => []; button.getClientRects = () => []; }
  r.mapping.set(r.S.dialogs, [root]); r.mapping.set(r.S.controls, [button]);
  return { root, button };
}
function course(r, progress, id = '311988') {
  const row = el(r), p = el(r, progress), link = el(r, '学习');
  row.mapping.set(r.S.courseProgress, [p]); link.parentElement = row;
  link.getAttribute = k => k === 'data-vurl' ? '/viewerforccvideo.do?courseId=' + id + '&circleId=395435' : null;
  const current = r.mapping.get(r.S.courseLink) || [];
  r.mapping.set(r.S.courseLink, [...current, link]);
  return { row, p, link };
}
function chapter(r, progress, current = true, id = 'chapter-' + (r.mapping.get(r.S.chapterProgress) || []).length) {
  const p = el(r, progress), row = el(r), control = el(r, '分集');
  p.closest = s => s === r.S.chapterRow ? row : null;
  row.isCurrent = current;
  row.matches = s => s.includes('.current') && row.isCurrent;
  row.getAttribute = name => name === 'data-id' ? id : null;
  row.mapping.set(r.S.chapterClick, [control]);
  r.mapping.set(r.S.chapterProgress, [...(r.mapping.get(r.S.chapterProgress) || []), p]);
  return { p, row, control };
}
function video(r, { ended = false, paused = true } = {}) {
  const v = el(r);
  Object.assign(v, { ended, paused, playbackRate: 1, muted: false, error: null, currentSrc: 'video-a', currentTime: ended ? 60 : 0,
    readyState: 4, duration: 600, playCount: 0, async play() { this.playCount++; this.paused = false; } });
  r.mapping.set('video', [v]); return v;
}

test('续学点击真实按钮而非包裹按钮的div，并且限频', () => {
  const r = runtime(), { root, button } = rest(r);
  assert.equal(r.handleDialogs(), true);
  assert.equal(root.clickCount, 0); assert.equal(button.clickCount, 1);
  r.handleDialogs(); assert.equal(button.clickCount, 1);
  r.advance(6000); r.handleDialogs(); assert.equal(button.clickCount, 2);
});
test('休息倒计时未结束和禁用按钮都不会被点击', () => {
  for (const options of [{ disabled: true }, { label: '继续学习(10秒)' }]) {
    const r = runtime(), { button } = rest(r, options);
    assert.equal(r.handleDialogs(), true); assert.equal(button.clickCount, 0);
  }
});
test('隐藏休息框不妨碍视频播放', () => {
  const r = runtime(); const { button } = rest(r, { visible: false });
  assert.equal(r.handleDialogs(), false); assert.equal(button.clickCount, 0);
});
test('带题目的续学弹窗等待人工，不能点击提交或续学', () => {
  const r = runtime(), { button } = rest(r, { quiz: true });
  assert.equal(r.handleDialogs(), true); assert.equal(button.clickCount, 0);
  assert.match(r.state.status, /手动处理/);
});
test('课程总页的“继续学习”课程入口不会被当作休息弹窗点击', async () => {
  const r = runtime(); const { button } = rest(r); course(r, '20%');
  await r.tick(); r.advance(1500); await r.tick(); r.advance(5000); await r.tick();
  assert.equal(button.clickCount, 0); assert.equal(r.navigations.length, 1);
});
test('列表跳转使用同一行的进度与课程链接', () => {
  const r = runtime(); course(r, '100%', '11'); course(r, '25%', '22');
  r.catalogTick(); assert.equal(r.navigations.length, 0);
  r.advance(5000); r.catalogTick();
  assert.equal(new URL(r.navigations[0]).searchParams.get('courseId'), '22');
});
test('列表只有当前页100%且有下一页时，实际触发翻页', () => {
  const r = runtime(); course(r, '100%');
  const next = el(r, '下一页'); r.mapping.set(r.S.next, [next]);
  r.catalogTick(); r.advance(5000); r.catalogTick();
  assert.equal(next.clickCount, 1); assert.equal(r.state.enabled, true);
  r.advance(26000); r.catalogTick();
  assert.equal(r.state.enabled, false); assert.match(r.state.status, /列表未更新/);
});
test('列表为空超时后报适配问题，不宣告学习完成', () => {
  const r = runtime(); r.catalogTick(); r.advance(46000); r.catalogTick();
  assert.equal(r.state.enabled, false); assert.match(r.state.status, /匹配/);
});
test('分集全部100%至少等待8秒，随后返回指定总页', async () => {
  const r = runtime({ player: true }); chapter(r, '100%');
  await r.playerTick(); assert.equal(r.navigations.length, 0);
  r.advance(7999); await r.playerTick(); assert.equal(r.navigations.length, 0);
  r.advance(1); await r.playerTick(); assert.equal(r.navigations[0], api.CONFIG.catalog);
});
test('未完成分集按常速启动，可配置静音', async () => {
  const r = runtime({ player: true }); chapter(r, '35%'); const v = video(r);
  v.playbackRate = 4; await r.playerTick();
  assert.equal(v.playCount, 1); assert.equal(v.playbackRate, 1); assert.equal(v.muted, true);
});
test('视频已结束而进度不足100%时等待，超过2分钟后停止', async () => {
  const r = runtime({ player: true }); chapter(r, '99.9%'); const v = video(r, { ended: true });
  await r.playerTick(); assert.equal(r.navigations.length, 0); assert.equal(v.playCount, 0);
  r.advance(120001); await r.playerTick();
  assert.equal(r.state.enabled, false); assert.match(r.state.status, /进度仍未到/);
});
test('选择下一分集无效时停止，避免不断点击', async () => {
  const r = runtime({ player: true }); chapter(r, '100%', true); const b = chapter(r, '0%', false); video(r);
  await r.playerTick(); r.advance(5000); await r.playerTick(); assert.equal(b.control.clickCount, 1);
  r.advance(26000); await r.playerTick(); assert.equal(r.state.enabled, false);
  assert.match(r.state.status, /未确认切换/); assert.equal(b.control.clickCount, 1);
});
test('分集已完成但总页未同步时等待，不无限重新进入', () => {
  const r = runtime(); course(r, '99%');
  r.saveSession('justReturned', { id: '311988', at: 1000000 });
  r.catalogTick(); r.advance(5000); r.catalogTick();
  assert.equal(r.navigations.length, 0); assert.match(r.state.status, /同步/);
  r.advance(120001); r.catalogTick(); assert.equal(r.state.enabled, false);
});
test('多个标签页通过共享租约避免同时操作', () => {
  const local = store(), a = runtime({ local }), b = runtime({ local });
  assert.equal(a.claim(), false); assert.equal(b.claim(), false);
  a.advance(1500); assert.equal(a.claim(), true); assert.equal(b.claim(), false);
  a.release(); assert.equal(b.claim(), false); b.advance(1500); assert.equal(b.claim(), true);
});
test('存储不可用时停止，并保留具体错误状态', () => {
  const r = runtime({ local: { getItem() { throw new Error('denied'); } } });
  assert.equal(r.claim(), false); assert.equal(r.state.enabled, false); assert.match(r.state.status, /存储不可用/);
});

const checkpointKey = 'enaea-local-helper:395435:2321900:resume-v1';
const challengeFields = 'input[type="radio"], input[type="checkbox"], textarea, input[type="text"], input[type="password"]';

test('普通续学框中的隐藏输入框不会阻止点击继续学习', () => {
  const r = runtime({ player: true }), { root, button } = rest(r);
  const hiddenField = el(r); hiddenField.getClientRects = () => [];
  root.mapping.set(challengeFields, [hiddenField]);
  assert.equal(r.handleDialogs(), true);
  assert.equal(button.clickCount, 1);
});

test('弹窗中可见的验证输入框仍然要求手动处理', () => {
  const r = runtime({ player: true }), { root, button } = rest(r);
  root.mapping.set(challengeFields, [el(r)]);
  assert.equal(r.handleDialogs(), true);
  assert.equal(button.clickCount, 0);
  assert.match(r.state.status, /手动处理/);
});

test('补充续学按钮外观，但倒计时和其他动作仍不会被点击', () => {
  for (const label of ['继续', 'Continue', '继续学习（0秒）', '▶ 继续学习']) {
    const r = runtime({ player: true }), { button } = rest(r, { label });
    assert.equal(r.handleDialogs(), true, label);
    assert.equal(button.clickCount, 1, label);
  }
  for (const label of ['继续学习（5秒）', '继续学习(10s)', '提交并继续学习']) assert.equal(api.continueLabel(label), false);
});

test('续学后原有播放逻辑会恢复暂停的视频', async () => {
  const r = runtime({ player: true }), { button } = rest(r);
  chapter(r, '23%'); const v = video(r);
  await r.tick(); r.advance(1500); await r.tick();
  assert.equal(button.clickCount, 1);
  assert.equal(v.playCount, 0);
  r.mapping.set(r.S.dialogs, []); r.mapping.set(r.S.controls, []);
  r.advance(1500); await r.tick();
  assert.equal(v.playCount, 1); assert.equal(v.paused, false);
});

function savedLastChapter() {
  const local = store(), r = runtime({ player: true, local });
  chapter(r, '35%', true, '97216');
  const v = video(r); v.currentTime = 137;
  r.state.owns = true; r.state.tracking = true;
  r.rememberPosition(true);
  return { local, original: JSON.parse(local.getItem(checkpointKey)), runtime: r, v };
}

test('记录使用实际分集ID和播放时间，关闭标签页后仍可读取', () => {
  const { local } = savedLastChapter();
  const next = runtime({ player: true, local });
  assert.equal(next.readCheckpoint().chapterId, '97216');
  assert.equal(next.readCheckpoint().time, 137);
  assert.equal(next.readCheckpoint().courseId, '311988');
  assert.notEqual(next.session, next.local);
});

test('从总页重新开始优先进入上次课程，不重新挑选第一门课', () => {
  const { local } = savedLastChapter(), r = runtime({ local });
  r.start();
  assert.equal(r.navigations.length, 1);
  assert.equal(new URL(r.navigations[0]).searchParams.get('courseId'), '311988');
  assert.notEqual(r.navigations[0], api.CONFIG.catalog);
});

test('在单课页面点击开始不再强制返回总页', () => {
  const r = runtime({ player: true });
  r.start();
  assert.equal(r.navigations.length, 0);
});

test('完整退出重进恢复第二分集和时间，网页默认第一分集不会覆盖记录', async () => {
  const { local, original } = savedLastChapter();
  const r = runtime({ player: true, local });
  const first = chapter(r, '0%', true, '97215');
  const second = chapter(r, '35%', false, '97216');
  const v = video(r); v.currentTime = 0;
  await r.playerTick(); r.advance(5000); await r.playerTick();
  assert.equal(first.control.clickCount, 0);
  assert.equal(second.control.clickCount, 1);
  r.state.owns = true; r.rememberPosition(true);
  assert.deepEqual(JSON.parse(local.getItem(checkpointKey)), original);
  first.row.isCurrent = false; second.row.isCurrent = true; v.currentSrc = 'video-b';
  await r.playerTick(); await r.playerTick();
  assert.equal(v.currentTime, 135);
  assert.equal(v.paused, false);
  r.rememberPosition(true);
  assert.equal(r.readCheckpoint().chapterId, '97216');
  assert.equal(r.readCheckpoint().time, 135);
});

test('上次分集尚未加载时保留记录，加载完成后再恢复时间', async () => {
  const { local, original } = savedLastChapter();
  const r = runtime({ player: true, local });
  chapter(r, '35%', true, '97216');
  const v = video(r, { paused: false }); v.readyState = 0; v.duration = NaN;
  await r.playerTick(); r.state.owns = true; r.rememberPosition(true);
  assert.deepEqual(JSON.parse(local.getItem(checkpointKey)), original);
  v.readyState = 4; v.duration = 600;
  await r.playerTick(); assert.equal(v.currentTime, 135);
});

test('暂停时强制保存最后位置，不受三秒写入间隔限制', () => {
  const { runtime: r, v } = savedLastChapter();
  v.currentTime = 140;
  r.stop('已暂停');
  assert.equal(r.readCheckpoint().time, 140);
  assert.equal(r.state.enabled, false);
});

test('已完成课程清除续播记录，不会再次恢复旧分集', async () => {
  const { local } = savedLastChapter(), r = runtime({ player: true, local });
  chapter(r, '100%', true, '97216');
  await r.playerTick(); r.advance(8000); await r.playerTick();
  assert.equal(local.getItem(checkpointKey), null);
  assert.equal(r.navigations[0], api.CONFIG.catalog);
});

test('损坏或指向其他站点的续播记录不会阻止正常启动', () => {
  for (const raw of ['{broken', JSON.stringify({ version:1, url:'https://example.com/viewerforccvideo.do?courseId=1', courseId:'1', chapterId:'2', time:5 })]) {
    const local = store(); local.setItem(checkpointKey, raw);
    const r = runtime({ local });
    assert.equal(r.readCheckpoint(), null); assert.equal(r.state.storageOK, true);
  }
});

function courseViewFrame(r, src, { child = null, hidden = false, inCourseView = true, allow } = {}) {
  const frame = Object.assign(new EventTarget(), el(r));
  const attrs = new Map([['src', src]]);
  if (allow !== undefined) attrs.set('allow', allow);
  frame.reloads = [];
  frame.getAttribute = name => attrs.get(name) ?? null;
  frame.setAttribute = (name, value) => {
    attrs.set(name, String(value));
    if (name === 'src') frame.reloads.push({ src: String(value), allow: frame.getAttribute('allow') });
  };
  for (const name of ['src', 'allow']) {
    Object.defineProperty(frame, name, {
      get: () => frame.getAttribute(name) ?? '', set: value => frame.setAttribute(name, value),
    });
  }
  frame.contentDocument = child;
  frame.messages = [];
  frame.contentWindow = { postMessage(data, origin) { frame.messages.push({ data: structuredClone(data), origin }); } };
  frame.hidden = hidden;
  r.mapping.set('iframe, frame', [frame]);
  if (inCourseView) r.mapping.set('.courseView iframe', [frame]);
  return frame;
}

test('普通 iCourse 仍可播放同源 iframe 中的分集视频', async () => {
  const r = runtime({ player: 'icourse' });
  const embedded = runtime();
  courseViewFrame(r, api.CONFIG.origin + '/player.html', { child: embedded.doc });
  const v = video(embedded);
  chapter(embedded, '39%');
  await r.tick();
  r.advance(1500); await r.tick();
  assert.equal(v.playCount, 1);
  assert.equal(v.paused, false);
  assert.equal(r.navigations.length, 0);
});

const tourURL = 'https://www.kuleiman.com/12345/index.html';
const yunTourURL = 'https://www.720yun.com/vr/590jt0wn5w5';
const yunLesson = { courseId: '308542', src: yunTourURL + '?courseId=308542&md5=test-signature&userId=test-student' };
test('页面、容器、可见性及地址均符合才识别为 VR', async () => {
  const cases = [
    { player: true, src: tourURL },
    { src: tourURL, hidden: true },
    { src: tourURL, inCourseView: false },
    { src: 'http://www.kuleiman.com/12345/index.html' },
    { src: 'https://www.kuleiman.com.example.org/12345/index.html' },
    { src: 'https://www.kuleiman.com@other.example/12345/index.html' },
    { src: 'https://www.kuleiman.com/embed/12345/index.html' },
    { src: 'https://www.kuleiman.com/12345/video.mp4' },
    { player: true, src: yunTourURL },
    { src: yunTourURL, hidden: true },
    { src: yunTourURL, inCourseView: false },
    { src: 'http://www.720yun.com/vr/sample' },
    { src: 'https://www.720yun.com.example.org/vr/sample' },
    { src: 'https://name@720yun.com/vr/sample' },
    { src: 'https://720yun.com:8080/vr/sample' },
    { src: 'https://720yun.com/vr/' },
    { src: 'https://720yun.com/vr/sample/video.mp4' },
    { src: 'https://720yun.com/12345/index.html' },
  ];
  for (const { player = 'icourse', src, ...options } of cases) {
    const r = runtime({ player });
    const frame = courseViewFrame(r, src, options);
    await r.tick();
    r.advance(46000); await r.tick();
    assert.equal(r.state.enabled, false, src);
    assert.match(r.state.status, /分集目录/, src);
    assert.equal(r.navigations.length, 0, src);
    assert.equal(frame.getAttribute('allow'), null, src);
    assert.deepEqual(frame.reloads, [], src);
  }
});

function vrCatalog(id, progress) {
  const catalog = runtime();
  const table = el(catalog);
  const tab = el(catalog);
  tab.mapping.set('.customcur-tab-text', [el(catalog, '所有课程')]);
  tab.classList = { contains: name => name === 'customcur-tab-select' };
  catalog.mapping.set('.customcur-tabs-wrapper .customcur-tab', [tab]);
  catalog.mapping.set('#J_myOptionRecords', [table]);
  function addRow(id, progress, route = '/viewerforicourse.do') {
    const row = el(catalog), p = el(catalog, progress), link = el(catalog, '学习');
    link.getAttribute = name => name === 'data-vurl' ? route + '?courseId=' + id + '&circleId=395435' : null;
    link.closest = p.closest = selector => selector === 'tr' ? row : null;
    row.mapping.set('.golearn[data-vurl]', [link]);
    row.mapping.set('.progressvalue', [p]);
    table.mapping.set('tr', [...(table.mapping.get('tr') || []), row]);
    return { row, p, link };
  }
  const row = addRow(id, progress);
  return { catalog, table, tab, addRow, row };
}

test('VR 目录须在同源、同班级和同大纲的指定页面；只读取本课所在行', () => {
  const { catalog, row, addRow } = vrCatalog('311988', '99.9%');
  addRow('22', '100%');
  addRow('311988', '100%', '/viewerforccvideo.do');
  const frame = { contentDocument: catalog.doc };
  const read = () => catalog.readVrCatalog(frame, {}, '311988');
  assert.equal(read().kind, 'progress');
  assert.equal(read().progress, 99.9);
  for (const wrongURL of [
    api.CONFIG.catalog.replace('395435', '395436'), api.CONFIG.catalog.replace('2321900', '2321901'),
    api.CONFIG.catalog.replace('study.enaea.edu.cn', 'example.org'),
    api.CONFIG.catalog.replace('/circleIndexRedirect.do', '/login.do'),
  ]) {
    catalog.doc.URL = wrongURL;
    assert.equal(read().kind, 'unknown', wrongURL);
  }
  catalog.doc.URL = api.CONFIG.catalog;
  for (const badLabel of ['--', '理论部分 100% 实训部分 50%', '120%']) {
    row.p.innerText = badLabel;
    assert.equal(read().kind, 'unknown');
  }
  row.p.innerText = '100%';
  addRow('311988', '35%');
  assert.equal(read().kind, 'unknown');
});

test('VR 目录在所有课程内翻页查找本课，等待列表变更时不会连点', () => {
  const { catalog, table, tab, addRow } = vrCatalog('22', '100%');
  const scan = {};
  let allSelected = false;
  tab.classList.contains = () => allSelected;
  const next = el(catalog);
  catalog.mapping.set('#J_myOptionRecords_paginate .paginate_button.next', [next]);
  const read = () => catalog.readVrCatalog({ contentDocument: catalog.doc }, scan, '311988');
  assert.equal(read().kind, 'loading');
  assert.equal(tab.clickCount, 1);
  allSelected = true;
  assert.equal(read().kind, 'loading');
  assert.equal(tab.clickCount, 1); assert.equal(next.clickCount, 0);
  table.mapping.set('tr', []);
  addRow('23', '100%');
  assert.equal(read().kind, 'loading');
  assert.equal(next.clickCount, 1);
  assert.equal(read().kind, 'loading');
  assert.equal(next.clickCount, 1);
  table.mapping.set('tr', []);
  addRow('311988', '78%');
  assert.equal(read().progress, 78);
});

function vrLesson({ courseId = '311988', progress = '99.9%', id = courseId, src = tourURL + '?test=sensitive-query', allow, local, globals } = {}) {
  const r = runtime({ player: 'icourse', courseId, local, globals });
  const tour = courseViewFrame(r, src, { allow });
  let tourReads = 0;
  Object.defineProperty(tour, 'contentDocument', { get() { tourReads++; return null; } });
  const { catalog, row } = vrCatalog(id, progress);
  const probes = new Set();
  r.doc.createElement = tag => {
    assert.equal(tag, 'iframe');
    const frame = el(r);
    frame.style = {};
    frame.setAttribute = (key, value) => { frame[key] = value; };
    frame.contentDocument = catalog.doc;
    frame.contentWindow = { location: catalog.doc.location };
    frame.remove = () => { frame.isConnected = false; probes.delete(frame); };
    return frame;
  };
  r.setUi({ root: { appendChild(frame) { probes.add(frame); } }, message: {}, start: {}, pause: {}, muted: {} });
  async function runFor(ms) {
    for (let elapsed = 0; elapsed < ms; elapsed += api.CONFIG.tickMs) {
      r.advance(api.CONFIG.tickMs);
      await r.tick();
      if (r.navigations.length || !r.state.enabled) break;
    }
  }
  return { r, catalog, row, tour, probes, runFor, tourReads: () => tourReads };
}

test('VR 页显示 99.9% 时持续打开，暂停时移除核对目录', async () => {
  const { r, catalog, tour, probes, runFor, tourReads } = vrLesson();
  await runFor(90000);
  assert.equal(r.state.enabled, true, r.state.status);
  assert.equal(r.navigations.length, 0);
  assert.equal(r.state.vr.progress, 99.9);
  assert.match(r.state.status, /99\.9%/);
  assert.equal(tourReads(), 0);
  assert.equal(tour.getAttribute('allow'), null);
  assert.deepEqual(tour.reloads, []);
  catalog.doc.readyState = 'loading';
  await runFor(4500);
  assert.equal(probes.size, 1);
  r.stop('已暂停');
  assert.equal(probes.size, 0);
  assert.equal(r.state.vr, null);
  await runFor(90000);
  assert.equal(r.navigations.length, 0);
});

test('VR 页不能因缺少本课程进度或其他课程完成而返回总页', async () => {
  for (const sample of [{ progress: '--' }, { progress: '100%', id: '22' }]) {
    const { r, runFor } = vrLesson(sample);
    await runFor(90000);
    assert.equal(r.state.enabled, true, r.state.status);
    assert.equal(r.navigations.length, 0);
    assert.equal(r.readSession('justReturned', null), null);
  }
});

for (const lesson of [{ courseId: '311988', type: 'kuleiman-vr' }, { ...yunLesson, type: '720yun-vr' }]) {
  test(lesson.type + ' 跟踪到本课 100% 才返回指定总页并清理目录', async () => {
    const { r, row, probes, runFor, tourReads } = vrLesson(lesson);
    await runFor(60000);
    assert.equal(r.state.enabled, true, r.state.status);
    assert.equal(r.state.vr?.progress, 99.9);
    assert.equal(r.navigations.length, 0);
    row.p.innerText = '100%';
    for (let elapsed = 0; elapsed <= api.CONFIG.vrPollMs && r.state.vr?.progress !== 100; elapsed += api.CONFIG.tickMs) {
      await runFor(api.CONFIG.tickMs);
    }
    assert.equal(r.state.vr?.progress, 100);
    r.advance(api.CONFIG.completionMs - 1); await r.tick();
    assert.equal(r.navigations.length, 0);
    r.advance(1); await r.tick();
    assert.deepEqual(r.navigations, [api.CONFIG.catalog], r.state.status);
    assert.equal(r.readSession('justReturned', null)?.id, lesson.courseId);
    assert.equal(probes.size, 0);
    assert.equal(tourReads(), 0);
  });

  test(lesson.type + ' 诊断包含类型与目录进度，去掉导览地址和查询参数', async () => {
    let report;
    class ReportURL extends URL {
      static createObjectURL(blob) { report = blob; return 'blob:test'; }
    }
    const { r, runFor, tourReads } = vrLesson({
      ...lesson, allow: 'fullscreen https://private-permission.example', globals: { Blob, URL: ReportURL, setTimeout() {} },
    });
    await runFor(6000);
    const download = el(r);
    r.doc.createElement = tag => { assert.equal(tag, 'a'); return download; };
    r.diagnostic();
    assert.equal(download.clickCount, 1);
    const contents = await report.text();
    const data = JSON.parse(contents);
    assert.equal(data.playerType, lesson.type);
    assert.equal(data.vrAutoplayPolicy, lesson.type === '720yun-vr' ? 'delegated-on-reload' : null);
    assert.equal(data.page.courseId, lesson.courseId);
    assert.equal(data.vrCatalogProgress, 99.9);
    assert.doesNotMatch(contents, /sensitive-query|kuleiman\.com|720yun\.com|590jt0wn5w5|test-signature|test-student|private-permission/);
    assert.equal(tourReads(), 0);
  });
}

test('720云裸域导览可识别并跟踪课程进度', async () => {
  const src = yunLesson.src.replace('www.720yun.com', '720yun.com');
  const { r, tour, runFor } = vrLesson({ ...yunLesson, src });
  await runFor(6000);
  assert.equal(r.state.vr?.progress, 99.9, r.state.status);
  assert.deepEqual(tour.reloads.map(reload => reload.src), [src]);
});

test('720 云在获得租约后补授权并用原签名地址重载一次，等待目录或重新开始都不重复刷新', async () => {
  const local = store();
  const other = runtime({ local });
  const original = "fullscreen; microphone 'none'";
  const src = yunLesson.src + '&extra=a%2Fb+c#scene=2';
  const { r, catalog, tour, runFor } = vrLesson({ ...yunLesson, src, allow: original, local });
  catalog.doc.readyState = 'loading';
  r.stop('已暂停');
  await r.tick();
  other.claim();
  r.start();
  await runFor(3000);
  assert.equal(tour.allow, original);
  assert.deepEqual(tour.reloads, []);
  other.release();
  await runFor(6000);
  assert.equal(r.state.vr?.progress, null);
  const directives = tour.allow.split(';').map(d => d.trim()).filter(Boolean);
  assert.deepEqual(directives.filter(d => !/^autoplay\b/.test(d)), ['fullscreen', "microphone 'none'"]);
  const autoplay = directives.filter(d => /^autoplay\b/.test(d));
  assert.equal(autoplay.length, 1);
  assert.deepEqual(autoplay[0].split(/\s+/).slice(1).sort(), ['https://720yun.com', 'https://www.720yun.com']);
  const firstReload = { src, allow: tour.allow };
  assert.deepEqual(tour.reloads, [firstReload]);
  r.stop('已暂停');
  r.start();
  catalog.doc.readyState = 'complete';
  await runFor(api.CONFIG.vrPollMs + 6000);
  assert.equal(r.state.vr?.progress, 99.9);
  assert.deepEqual(tour.reloads, [firstReload]);
});

test('720 云保留课件已有的 autoplay 策略，已完成课件直接返回', async () => {
  for (const allow of ["fullscreen; autoplay 'none'; microphone 'none'", "autoplay 'src'"]) {
    const { r, tour, runFor } = vrLesson({ ...yunLesson, allow });
    await runFor(6000);
    assert.equal(r.state.vr?.progress, 99.9);
    assert.equal(tour.allow, allow);
    assert.deepEqual(tour.reloads, []);
  }
  const { r, tour, runFor } = vrLesson({ ...yunLesson, progress: '100%' });
  await runFor(api.CONFIG.completionMs + 6000);
  assert.deepEqual(r.navigations, [api.CONFIG.catalog]);
  assert.equal(tour.getAttribute('allow'), null);
  assert.deepEqual(tour.reloads, []);
});

test('平台更换 720 云课件 iframe 后，新播放器可启动且不会刷新旧播放器', async () => {
  const { r, tour, runFor } = vrLesson(yunLesson);
  await runFor(6000);
  const newSrc = yunLesson.src + '&scene=next';
  const replacement = courseViewFrame(r, newSrc);
  await runFor(6000);
  assert.deepEqual(replacement.reloads.map(reload => reload.src), [newSrc]);
  assert.deepEqual(tour.reloads.map(reload => reload.src), [yunLesson.src]);
});

// 挂载脚本实际创建的面板，用原有事件监听器操作复选框。
function mountAudioPanel(r) {
  const controls = new Map();
  const root = {
    appendChild() {},
    getElementById(id) {
      if (!this.innerHTML.includes('id="' + id + '"')) return null;
      if (!controls.has(id)) controls.set(id, Object.assign(new EventTarget(), { disabled: false }));
      return controls.get(id);
    },
  };
  r.doc.createElement = tag => {
    assert.equal(tag, 'div');
    return { style: {}, attachShadow: () => root };
  };
  r.doc.documentElement = { appendChild() {} };
  r.mount();
  const input = root.getElementById('muted');
  assert.equal((root.innerHTML.match(/<input\b[^>]*type="checkbox"/g) || []).length, 1);
  const label = root.innerHTML.match(/<label\b[^>]*>([\s\S]*?)<\/label>/)?.[1];
  assert.equal(label?.replace(/<[^>]*>/g, '').trim(), '静音播放');
  return { input, change(muted) { input.checked = muted; input.dispatchEvent(new Event('change')); } };
}

test('普通视频与 VR 共用可操作的静音开关，其他标签页和刷新后沿用选择', async () => {
  const local = store();
  const standard = runtime({ player: true, local });
  const panel = mountAudioPanel(standard);
  const media = video(standard);
  chapter(standard, '42%');
  const vr = runtime({ player: 'icourse', local });
  courseViewFrame(vr, yunLesson.src);
  vr.state.enabled = false;
  const vrPanel = mountAudioPanel(vr);
  assert.equal(panel.input.checked, true);
  assert.equal(vrPanel.input.checked, true);
  assert.equal(vrPanel.input.disabled, false);
  await standard.playerTick();
  assert.equal(media.muted, true);

  const writes = [];
  const save = local.setItem;
  local.setItem = (key, value) => {
    const oldValue = local.getItem(key);
    save(key, value);
    writes.push({ key, oldValue, newValue: local.getItem(key), storageArea: local });
  };
  vrPanel.change(false);
  for (const change of [...writes]) standard.window.dispatchEvent(Object.assign(new Event('storage'), change));
  assert.equal(panel.input.checked, false);
  await standard.playerTick();
  assert.equal(media.muted, false);

  const refreshed = runtime({ player: 'icourse', local, session: vr.session });
  const newTab = runtime({ player: true, local });
  assert.equal(mountAudioPanel(refreshed).input.checked, false);
  assert.equal(mountAudioPanel(newTab).input.checked, false);
});

test('VR 静音仅接收当前导览窗口、可信来源与当前开关值匹配的回执', async () => {
  const channel = 'enaea-vr-audio-v1';
  const origin = new URL(yunLesson.src).origin;
  let report;
  class ReportURL extends URL {
    static createObjectURL(blob) { report = blob; return 'blob:test'; }
  }
  const r = runtime({ player: 'icourse', globals: { Blob, URL: ReportURL, setTimeout() {} } });
  r.state.enabled = false;
  const tour = courseViewFrame(r, yunLesson.src);
  const panel = mountAudioPanel(r);
  r.doc.createElement = tag => { assert.equal(tag, 'a'); return el(r); };
  async function audioStatus() {
    r.diagnostic();
    return JSON.parse(await report.text()).vrAudioStatus;
  }
  function receive(data, source = tour.contentWindow, from = origin) {
    r.window.dispatchEvent(Object.assign(new Event('message'), { data: { channel, ...data }, source, origin: from }));
  }
  await r.tick();
  assert.equal(await audioStatus(), 'pending');
  const probe = tour.messages.find(msg => msg.data.type === 'probe');
  assert.deepEqual(probe?.data, { channel, type: 'probe' });
  receive({ type: 'ready' }, tour.contentWindow, 'https://www.kuleiman.com');
  assert.ok(tour.messages.every(msg => msg.data.type !== 'set-muted'));
  receive({ type: 'ready' });
  assert.ok(tour.messages.some(msg => msg.data.type === 'set-muted' && msg.data.muted === true && msg.origin === origin));
  assert.ok(tour.messages.filter(msg => msg.data.type === 'set-muted').every(msg => msg.origin === origin));
  receive({ type: 'muted-state', muted: true }, {});
  receive({ type: 'muted-state', muted: true }, tour.contentWindow, 'https://www.720yun.com.example.org');
  receive({ type: 'muted-state', muted: true, channel: 'unrelated' });
  assert.equal(await audioStatus(), 'pending');
  receive({ type: 'muted-state', muted: true });
  assert.equal(await audioStatus(), 'muted');
  panel.change(false);
  assert.equal(await audioStatus(), 'pending');
  assert.ok(tour.messages.some(msg => msg.data.type === 'set-muted' && msg.data.muted === false && msg.origin === origin));
  receive({ type: 'muted-state', muted: true });
  assert.equal(await audioStatus(), 'pending');
  receive({ type: 'muted-state', muted: false });
  assert.equal(await audioStatus(), 'released');
  tour.dispatchEvent(new Event('load'));
  receive({ type: 'muted-state', muted: false });
  assert.equal(await audioStatus(), 'pending');
  const redirectedOrigin = 'https://720yun.com';
  receive({ type: 'ready' }, tour.contentWindow, redirectedOrigin);
  assert.equal(tour.messages.at(-1).origin, redirectedOrigin);
  receive({ type: 'muted-state', muted: false }, tour.contentWindow, redirectedOrigin);
  assert.equal(await audioStatus(), 'released');
});

test('从旧版升级时保留既有普通视频静音选择，后续使用最新共享设置', () => {
  const key = 'enaea-local-helper:395435:2321900:muted';
  const local = store(), oldSession = store();
  oldSession.setItem(key, 'false');
  const upgraded = runtime({ player: true, local, session: oldSession });
  assert.equal(mountAudioPanel(upgraded).input.checked, false);
  const other = runtime({ player: 'icourse', local });
  const panel = mountAudioPanel(other);
  assert.equal(panel.input.checked, false);
  panel.change(true);
  const reopened = runtime({ player: true, local, session: oldSession });
  assert.equal(mountAudioPanel(reopened).input.checked, true);
});

test('真实 VR 子帧入口仅接受公社父窗口指令，静音并还原 DOM 外的媒体', async () => {
  class Media {
    #muted = false;
    get muted() { return this.#muted; }
    set muted(value) { this.#muted = Boolean(value); }
    play() { this.played = true; }
  }
  const replies = [];
  const parent = { postMessage(data, origin) { replies.push({ data: structuredClone(data), origin }); } };
  const window = Object.assign(new EventTarget(), { HTMLMediaElement: Media, Audio: class extends Media {}, top: parent, parent });
  window.self = window;
  const document = Object.assign(new EventTarget(), { querySelectorAll: () => [] });
  const location = { href: yunLesson.src, ancestorOrigins: [api.CONFIG.origin] };
  await vm.runInNewContext(source, { window, document, location, URL });
  const channel = 'enaea-vr-audio-v1';
  function setMuted(muted, origin = api.CONFIG.origin, source = parent) {
    const data = { channel, type: 'set-muted', muted };
    window.dispatchEvent(Object.assign(new Event('message'), { data, origin, source }));
  }
  const narration = new window.Audio();
  const alreadySilent = new window.Audio();
  alreadySilent.muted = true;
  setMuted(true, 'https://example.org');
  setMuted(true, api.CONFIG.origin, {});
  assert.equal(narration.muted, false);
  assert.deepEqual(replies, [{ data: { channel, type: 'ready' }, origin: api.CONFIG.origin }]);

  setMuted(true);
  const detachedVideo = new Media();
  detachedVideo.play();
  assert.equal(narration.muted, true);
  assert.equal(detachedVideo.played, true);
  assert.equal(detachedVideo.muted, true);
  setMuted(false);
  assert.equal(narration.muted, false);
  assert.equal(detachedVideo.muted, false);
  assert.equal(alreadySilent.muted, true);
  assert.deepEqual(replies.at(-1), { data: { channel, type: 'muted-state', muted: false }, origin: api.CONFIG.origin });
});
