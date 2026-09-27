'use strict';

/**
 * 焦点命中遮挡审计集成验证（依赖可选的 jsdom，仅本地/CI 可用时运行）：
 * 在真实 ShadowRoot API 下验证 analyzer.js 的组合命中测试接线——
 *  - document.elementFromPoint 后沿 open ShadowRoot.elementFromPoint 逐层
 *    retarget：命中 shadow 内部按钮算可见；
 *  - 全部采样点被遮挡 → occluded；部分（四角命中遮挡层、中心仍命中目标）
 *    → partial；无遮挡 → clear；
 *  - 命中带 closed 标记的宿主 → closed-root 无法判定；
 *  - 裁剪审计 transform 无法判定 → clip-undetermined 传递为命中无法判定。
 * jsdom 无布局：getBoundingClientRect / elementFromPoint 以坐标桩代替，
 * ShadowRoot.elementFromPoint 语义由本桩按同坐标解析模拟。
 * 运行：npm install --no-save jsdom && node test/hit-integration.js
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const html = `<!DOCTYPE html><html><body>
  <button id="b1">无遮挡</button>
  <button id="b2">整片覆盖</button>
  <div id="cover1" class="cover"></div>
  <button id="b3">半幅覆盖</button>
  <div id="cover2" class="cover"></div>
  <x-open id="host"></x-open>
  <button id="b5">被 closed 宿主覆盖</button>
  <div id="secret" data-focus-lab-closed-shadow></div>
  <div id="tf" style="transform: translateX(1px);"><button id="b6">transform 祖先</button></div>
</body></html>`;

const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
const { document } = window;

// 分析器内 parent.postMessage（sandbox iframe 形态）：让 parent 指向自身窗口
try { Object.defineProperty(window, 'parent', { value: window, configurable: true }); } catch (e) {}

// postMessage 采集（analyzer 经 setTimeout(0) 发消息，必须在 eval 前注册）
let routePayload = null;
window.addEventListener('message', (ev) => {
  if (ev.data && ev.data.type === 'route') routePayload = ev.data.payload;
  if (ev.data && ev.data.type === 'error') console.error('analyzer error:', ev.data.message);
});

// ---- open shadow root：内部按钮（命中测试需 retarget 进入 shadow 根）----
const host = document.getElementById('host');
const sr = host.attachShadow({ mode: 'open' });
sr.innerHTML = '<button id="b4">shadow 内部按钮（下半被遮挡）</button>';

const analyzerSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'analyzer.js'), 'utf8');
window.eval(analyzerSrc);

// ---- 几何与命中桩（jsdom 无布局；视口默认 1024×768，所有节点均在视口内）----
function stubRect(el, left, top, width, height) {
  el.getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height });
  return { left, top, width, height };
}
function contains(r, x, y) {
  return x >= r.left && x < r.left + r.width && y >= r.top && y < r.top + r.height;
}

// Tab 顺序节点（坐标依次纵向排开，避免滚动裁剪；祖先无 overflow）
const b1r = stubRect(document.getElementById('b1'), 10, 10, 180, 40);
const b2r = stubRect(document.getElementById('b2'), 10, 70, 180, 40);
const c1r = stubRect(document.getElementById('cover1'), 10, 60, 180, 60); // 整片覆盖 b2（含四角与中心）
const b3r = stubRect(document.getElementById('b3'), 10, 150, 180, 40);
const c2r = stubRect(document.getElementById('cover2'), 100, 60, 120, 210); // 右半：覆盖 b3 右 3 点、b4 下 2 点
const b4r = stubRect(sr.getElementById('b4'), 10, 230, 180, 40);
const b5r = stubRect(document.getElementById('b5'), 10, 310, 180, 40);
const secretR = stubRect(document.getElementById('secret'), 10, 300, 180, 60); // 仅覆盖 b5（closed 标记宿主）
const b6r = stubRect(document.getElementById('b6'), 10, 390, 180, 40);

// 文档层命中：遮挡层 / closed 宿主优先，open shadow 宿主在其内部按钮区域
// 命中时返回宿主（analyzer 再经 host.shadowRoot.elementFromPoint 下钻）
const docLayers = [
  { el: document.getElementById('secret'), r: secretR },
  { el: document.getElementById('cover1'), r: c1r },
  { el: document.getElementById('cover2'), r: c2r },
  { el: host, r: b4r },
  { el: document.getElementById('b1'), r: b1r },
  { el: document.getElementById('b2'), r: b2r },
  { el: document.getElementById('b3'), r: b3r },
  { el: document.getElementById('b5'), r: b5r },
  { el: document.getElementById('b6'), r: b6r }
];
function hitDoc(x, y) {
  for (const layer of docLayers) {
    if (contains(layer.r, x, y)) return layer.el;
  }
  return null;
}
// jsdom 未实现 elementFromPoint（属性原本不存在）：defineProperty 可能静默
// 不生效，因此定义后校验，失败则回退为直接赋值
function defineHit(target, fn) {
  try {
    Object.defineProperty(target, 'elementFromPoint', { value: fn, configurable: true, writable: true });
  } catch (e) { /* 回退赋值 */ }
  if (target.elementFromPoint !== fn) target.elementFromPoint = fn;
}
defineHit(document, hitDoc);
// shadow 根 retarget：shadow 按钮自身区域返回按钮，其余回退文档命中
defineHit(sr, (x, y) => (contains(b4r, x, y) ? sr.getElementById('b4') : hitDoc(x, y)));

setTimeout(() => {
  let failures = 0;
  function check(name, cond, extra) {
    if (cond) { console.log('  ✓ ' + name); }
    else { failures++; console.error('  ✗ ' + name + (extra ? ' → ' + extra : '')); }
  }

  if (!routePayload) {
    console.error('未收到 route 消息');
    process.exit(1);
  }
  const audit = routePayload.hitAudit;
  check('route 负载包含 hitAudit', !!audit);
  if (!audit) process.exit(1);

  const item = step => (audit.items || []).find(it => it.step === step);
  const und = step => (audit.undetermined || []).find(u => u.step === step);

  console.log('采样点配置');
  check('inset=0.25，视口来自裁剪审计（1024×768）',
    audit.inset === 0.25 && audit.viewport && audit.viewport.width === 1024 &&
    audit.viewport.height === 768, JSON.stringify(audit.viewport));

  console.log('open ShadowRoot retarget 与遮挡判定');
  const i1 = item(1);
  check('b1 未见遮挡（clear，5/5 可见）',
    i1 && i1.status === 'clear' && i1.visibleCount === 5 && i1.occludedCount === 0,
    i1 && i1.status);

  // b2：cover1 与 cover2 都覆盖其区域（文档层 cover1 优先）→ 全部命中 cover1
  const i2 = item(2);
  check('b2 全部遮挡（occluded，0/5 可见），遮挡者为 div#cover1',
    i2 && i2.status === 'occluded' && i2.visibleCount === 0 && i2.occludedCount === 5 &&
    i2.occluders.length === 1 && i2.occluders[0].label === 'div#cover1',
    i2 && JSON.stringify({ s: i2.status, o: i2.occluders }));

  // b3：左半可见、右半（右角 + 中心 x=100 落在 cover2 左缘 100，包含取 >=）
  // 中心 (100,170) 命中 cover2；左角 (55,160)/(55,180) 命中按钮；
  // 右角 (145,160)/(145,180) 命中 cover2 → 2 可见 / 3 遮挡
  const i3 = item(3);
  check('b3 部分遮挡（partial），遮挡者为 div#cover2（3/5）',
    i3 && i3.status === 'partial' && i3.visibleCount === 2 && i3.occludedCount === 3 &&
    i3.occluders.some(o => o.label === 'div#cover2' && o.count === 3),
    i3 && JSON.stringify({ s: i3.status, v: i3.visibleCount, o: i3.occludedCount, oc: i3.occluders }));

  // b4 shadow 内部按钮：左角 (55,240)/(55,260) retarget 进入 open 根命中按钮
  // 本身；中心 (100,250) 与右角落在 cover2 → 2 可见 / 3 遮挡
  const i4 = item(4);
  check('b4（open shadow 内部）部分遮挡：左角 retarget 后可见，中心 / 右角记录遮挡者',
    i4 && i4.status === 'partial' && i4.visibleCount === 2 && i4.occludedCount === 3,
    i4 && JSON.stringify({ s: i4.status, v: i4.visibleCount, o: i4.occludedCount,
      samples: i4.samples.map(s => s.result) }));
  check('b4 采样点逐点保留（类型 / 坐标 / 结果）',
    i4 && i4.samples.length === 5 && i4.samples.every(s => typeof s.x === 'number' && s.result) &&
    i4.samples[0].type === 'center');

  console.log('无法判定');
  const u5 = und(5);
  check('b5 采样点命中 closed 标记宿主 → closed-root 无法判定',
    u5 && u5.reason === 'closed-root' && u5.samples.length === 5 &&
    u5.samples.some(s => s.reason === 'closed-root'),
    u5 && (u5.reason + ' / samples=' + u5.samples.length));

  const u6 = und(6);
  check('b6 裁剪审计 transform 无法判定 → clip-undetermined（沿用原因码）',
    u6 && u6.reason === 'clip-undetermined' && u6.clipReason === 'transformed',
    u6 && (u6.reason + '/' + u6.clipReason));

  console.log('统计');
  const st = audit.stats || {};
  check('stats：6 节点 = 1 clear + 2 partial + 1 occluded + 2 无法判定',
    st.nodes === 6 && st.clear === 1 && st.partial === 2 && st.occluded === 1 &&
    st.undetermined === 2 && st.judged === 4, JSON.stringify(st));
  check('无法判定 / 判定条目均带分段选择器（可联动高亮 / 导出）',
    audit.items.every(it => /^L:| >> S:/.test(it.selector)) &&
    audit.undetermined.every(u => typeof u.selector === 'string'));

  console.log(failures ? '\n集成验证存在失败' : '\n集成验证全部通过');
  process.exit(failures ? 1 : 0);
}, 400);
