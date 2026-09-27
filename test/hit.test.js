'use strict';

/**
 * analyzer.js 焦点命中遮挡审计（buildHitSamples / auditHitOcclusion）
 * 纯函数单元测试（Node 环境，无 DOM）。
 * 重点：
 *  - 可见矩形内中心 + 内缩四角 5 采样点的坐标构造与小矩形去重；
 *  - 按被遮挡采样点数区分 未见遮挡（clear）/ 部分遮挡（partial）/
 *    全部遮挡（occluded），遮挡者按次数聚合计数；
 *  - 零可见面积、裁剪审计无法判定、closed 根命中、归属无法确认（null/异常）
 *    四类「无法判定」，不臆测归属；
 *  - 结论仅针对采样点：采样点结果逐点保留在输出中。
 * 运行：npm test
 */

const assert = require('assert');
const { buildHitSamples, auditHitOcclusion } = require('../public/analyzer.js');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (err) {
    console.error('  ✗ ' + name);
    console.error(err);
    process.exitCode = 1;
  }
}

console.log('buildHitSamples · 中心 + 内缩四角采样');
test('正常矩形：5 个采样点，类型与坐标正确（内缩 25%）', () => {
  const pts = buildHitSamples({ left: 100, top: 200, width: 80, height: 40 });
  assert.strictEqual(pts.length, 5);
  assert.deepStrictEqual(pts.map(p => p.type),
    ['center', 'top-left', 'top-right', 'bottom-left', 'bottom-right']);
  assert.deepStrictEqual(pts[0], { type: 'center', x: 140, y: 220 });
  assert.deepStrictEqual(pts[1], { type: 'top-left', x: 120, y: 210 });
  assert.deepStrictEqual(pts[2], { type: 'top-right', x: 160, y: 210 });
  assert.deepStrictEqual(pts[3], { type: 'bottom-left', x: 120, y: 230 });
  assert.deepStrictEqual(pts[4], { type: 'bottom-right', x: 160, y: 230 });
});

test('自定义内缩比例生效（合法范围 0~0.5）', () => {
  const pts = buildHitSamples({ left: 0, top: 0, width: 100, height: 100 }, 0.1);
  assert.strictEqual(pts[1].x, 10);
  assert.strictEqual(pts[1].y, 10);
  assert.strictEqual(pts[2].x, 90);
});

test('非法 / 越界内缩比例回退默认 0.25', () => {
  const a = buildHitSamples({ left: 0, top: 0, width: 100, height: 100 }, 0);
  const b = buildHitSamples({ left: 0, top: 0, width: 100, height: 100 }, 0.5);
  const c = buildHitSamples({ left: 0, top: 0, width: 100, height: 100 }, undefined);
  assert.strictEqual(a[1].x, 25);
  assert.strictEqual(b[1].x, 25);
  assert.strictEqual(c[1].x, 25);
});

test('宽为 0：左 / 右角 x 重合 → 去重为 3 个点（中心 + 上下两个角）', () => {
  const pts = buildHitSamples({ left: 50, top: 100, width: 0, height: 40 });
  assert.strictEqual(pts.length, 3);
  // top-right 与 top-left 重合、bottom-right 与 bottom-left 重合，先出现者保留
  assert.deepStrictEqual(pts.map(p => p.type), ['center', 'top-left', 'bottom-left']);
  assert.ok(pts.every(p => p.x === 50));
});

test('高为 0：上 / 下角 y 重合 → 去重为 3 个点（中心 + 左右两个角）', () => {
  const pts = buildHitSamples({ left: 0, top: 0, width: 40, height: 0 });
  assert.strictEqual(pts.length, 3);
  // bottom-left 与 top-left 重合、bottom-right 与 top-right 重合，先出现者保留
  assert.deepStrictEqual(pts.map(p => p.type), ['center', 'top-left', 'top-right']);
});

test('零尺寸矩形：全部重合 → 仅 1 个中心点', () => {
  const pts = buildHitSamples({ left: 10, top: 20, width: 0, height: 0 });
  assert.strictEqual(pts.length, 1);
  assert.strictEqual(pts[0].type, 'center');
  assert.deepStrictEqual(pts[0], { type: 'center', x: 10, y: 20 });
});

/* ---------------- auditHitOcclusion ---------------- */

function region(left, top, width, height) {
  return { left, top, width, height };
}
function sample(type, result, occluder, reason) {
  const coord = { center: [14, 22], 'top-left': [12, 21], 'top-right': [16, 21],
    'bottom-left': [12, 23], 'bottom-right': [16, 23] }[type];
  return { type, x: coord[0], y: coord[1], result, occluder: occluder || null, reason: reason || null };
}
function visSamples(pattern) {
  // pattern：长度 5 的结果数组，按 center/四角 顺序
  var types = ['center', 'top-left', 'top-right', 'bottom-left', 'bottom-right'];
  return types.map(function (t, i) {
    var res = pattern[i];
    if (res === 'v') return sample(t, 'visible');
    if (res === 'o') return sample(t, 'occluded', { label: 'div.cover', selector: 'L:html > body > div.cover' });
    return sample(t, res.result, res.occluder, res.reason);
  });
}
function hitNode(step, over) {
  return Object.assign({
    step: step,
    selector: '#n' + step,
    label: 'node' + step,
    clipStatus: 'full',
    clipReason: null,
    clipMessage: null,
    visible: region(10, 20, 8, 4),
    samples: visSamples(['v', 'v', 'v', 'v', 'v'])
  }, over || {});
}

console.log('auditHitOcclusion · 未见 / 部分 / 全部遮挡');
test('全部采样点可见 → clear，无遮挡者', () => {
  const r = auditHitOcclusion([hitNode(1)]);
  assert.strictEqual(r.items.length, 1);
  const it = r.items[0];
  assert.strictEqual(it.status, 'clear');
  assert.strictEqual(it.visibleCount, 5);
  assert.strictEqual(it.occludedCount, 0);
  assert.deepStrictEqual(it.occluders, []);
  assert.strictEqual(r.stats.clear, 1);
});

test('部分采样点被同一元素遮挡 → partial，遮挡者计数正确', () => {
  const r = auditHitOcclusion([hitNode(1, {
    samples: visSamples(['o', 'v', 'o', 'v', 'o'])
  })]);
  const it = r.items[0];
  assert.strictEqual(it.status, 'partial');
  assert.strictEqual(it.visibleCount, 2);
  assert.strictEqual(it.occludedCount, 3);
  assert.strictEqual(it.occluders.length, 1);
  assert.strictEqual(it.occluders[0].label, 'div.cover');
  assert.strictEqual(it.occluders[0].count, 3);
  assert.strictEqual(r.stats.partial, 1);
});

test('全部采样点被遮挡 → occluded', () => {
  const r = auditHitOcclusion([hitNode(1, {
    samples: visSamples(['o', 'o', 'o', 'o', 'o'])
  })]);
  const it = r.items[0];
  assert.strictEqual(it.status, 'occluded');
  assert.strictEqual(it.visibleCount, 0);
  assert.strictEqual(it.occludedCount, 5);
  assert.strictEqual(r.stats.occluded, 1);
});

test('多个遮挡者分别计数并按次数降序排列', () => {
  const samples = visSamples(['v', 'v', 'v', 'v', 'v']);
  samples[1] = sample('top-left', 'occluded', { label: 'div.a', selector: '#a' });
  samples[2] = sample('top-right', 'occluded', { label: 'div.b', selector: '#b' });
  samples[3] = sample('bottom-left', 'occluded', { label: 'div.a', selector: '#a' });
  const r = auditHitOcclusion([hitNode(1, { samples: samples })]);
  const it = r.items[0];
  assert.strictEqual(it.status, 'partial');
  assert.deepStrictEqual(it.occluders.map(o => o.label), ['div.a', 'div.b']);
  assert.strictEqual(it.occluders[0].count, 2);
  assert.strictEqual(it.occluders[1].count, 1);
});

test('逐采样点坐标与结果保留（结论仅针对采样点）', () => {
  const r = auditHitOcclusion([hitNode(1, {
    samples: visSamples(['v', 'o', 'v', 'v', 'v'])
  })]);
  const s = r.items[0].samples;
  assert.strictEqual(s.length, 5);
  assert.strictEqual(s[0].result, 'visible');
  assert.strictEqual(s[1].result, 'occluded');
  assert.strictEqual(s[1].occluder.label, 'div.cover');
  assert.strictEqual(typeof s[0].x, 'number');
});

console.log('auditHitOcclusion · 无法判定');
test('裁剪审计无法判定 → clip-undetermined（沿用裁剪原因，不做采样）', () => {
  const r = auditHitOcclusion([hitNode(1, {
    clipStatus: 'undetermined',
    clipReason: 'positioned',
    clipMessage: '祖先 position:absolute',
    samples: []
  })]);
  assert.strictEqual(r.items.length, 0);
  assert.strictEqual(r.undetermined.length, 1);
  const u = r.undetermined[0];
  assert.strictEqual(u.reason, 'clip-undetermined');
  assert.strictEqual(u.clipReason, 'positioned');
  assert.ok(u.message.indexOf('裁剪审计无法判定') >= 0);
  assert.strictEqual(r.stats.undetermined, 1);
});

test('clipped 节点（可见面积为零）→ zero-visible-area', () => {
  const r = auditHitOcclusion([hitNode(1, {
    clipStatus: 'clipped',
    visible: { left: 0, top: 0, width: 0, height: 0 },
    samples: []
  })]);
  assert.strictEqual(r.undetermined[0].reason, 'zero-visible-area');
});

test('非 clipped 但可见矩形宽 / 高为 0 → zero-visible-area', () => {
  const r = auditHitOcclusion([hitNode(1, {
    clipStatus: 'partial',
    visible: { left: 10, top: 10, width: 0, height: 40 },
    samples: []
  })]);
  assert.strictEqual(r.undetermined[0].reason, 'zero-visible-area');
});

test('有采样点命中 closed ShadowRoot 宿主 → closed-root（保留全部采样点）', () => {
  const r = auditHitOcclusion([hitNode(1, {
    samples: visSamples(['v', 'v', { result: 'unknown', reason: 'closed-root' }, 'v', 'v'])
  })]);
  assert.strictEqual(r.items.length, 0);
  const u = r.undetermined[0];
  assert.strictEqual(u.reason, 'closed-root');
  assert.ok(u.message.indexOf('closed ShadowRoot') >= 0);
  assert.strictEqual(u.samples.length, 5);
  assert.ok(u.samples.some(s => s.reason === 'closed-root'));
});

test('有采样点命中 null / 异常 → unattributable-hit', () => {
  const r = auditHitOcclusion([hitNode(1, {
    samples: visSamples([{ result: 'unknown', reason: 'unattributable-hit' },
      'v', 'v', 'v', 'v'])
  })]);
  assert.strictEqual(r.undetermined[0].reason, 'unattributable-hit');
});

test('同时存在遮挡与归属不明 → 仍判无法判定（不猜测），不计入遮挡统计', () => {
  const r = auditHitOcclusion([hitNode(1, {
    samples: visSamples(['o', 'o', { result: 'unknown', reason: 'unattributable-hit' },
      'v', 'v'])
  })]);
  assert.strictEqual(r.items.length, 0);
  assert.strictEqual(r.undetermined.length, 1);
  assert.strictEqual(r.stats.occluded, 0);
  assert.strictEqual(r.stats.partial, 0);
});

test('同时有 closed 根与 null 命中 → 原因取 closed-root', () => {
  const r = auditHitOcclusion([hitNode(1, {
    samples: visSamples([{ result: 'unknown', reason: 'closed-root' },
      { result: 'unknown', reason: 'unattributable-hit' }, 'v', 'v', 'v'])
  })]);
  assert.strictEqual(r.undetermined[0].reason, 'closed-root');
});

test('采样点数组为空（防御）→ unattributable-hit', () => {
  const r = auditHitOcclusion([hitNode(1, { samples: [] })]);
  assert.strictEqual(r.undetermined[0].reason, 'unattributable-hit');
});

console.log('auditHitOcclusion · 统计与输出形状');
test('stats 汇总正确', () => {
  const r = auditHitOcclusion([
    hitNode(1),                                                       // clear
    hitNode(2, { samples: visSamples(['o', 'v', 'v', 'v', 'v']) }),   // partial
    hitNode(3, { samples: visSamples(['o', 'o', 'o', 'o', 'o']) }),   // occluded
    hitNode(4, { clipStatus: 'undetermined', clipReason: 'transformed',
      visible: { left: 0, top: 0, width: 0, height: 0 }, samples: [] }) // undetermined
  ]);
  assert.strictEqual(r.stats.nodes, 4);
  assert.strictEqual(r.stats.judged, 3);
  assert.strictEqual(r.stats.clear, 1);
  assert.strictEqual(r.stats.partial, 1);
  assert.strictEqual(r.stats.occluded, 1);
  assert.strictEqual(r.stats.undetermined, 1);
  assert.strictEqual(r.items.length + r.undetermined.length, 4);
  assert.strictEqual(r.inset, 0.25);
});

test('条目包含联动高亮与导出所需字段', () => {
  const r = auditHitOcclusion([hitNode(1, {
    samples: visSamples(['o', 'v', 'v', 'v', 'v'])
  })]);
  const it = r.items[0];
  assert.ok(it.selector && it.label && typeof it.status === 'string');
  assert.strictEqual(typeof it.visibleCount, 'number');
  assert.strictEqual(typeof it.occludedCount, 'number');
  assert.ok(Array.isArray(it.occluders));
  assert.ok(Array.isArray(it.samples));
  assert.ok(it.visible && typeof it.visible.width === 'number');
});

test('空输入 / null 安全', () => {
  const empty = auditHitOcclusion([]);
  assert.strictEqual(empty.stats.nodes, 0);
  assert.deepStrictEqual(empty.items, []);
  assert.deepStrictEqual(empty.undetermined, []);
  assert.strictEqual(auditHitOcclusion(null).stats.nodes, 0);
  assert.strictEqual(auditHitOcclusion(undefined, null).stats.nodes, 0);
});

console.log('\n' + passed + ' 个断言组通过' + (process.exitCode ? '（存在失败）' : ''));
