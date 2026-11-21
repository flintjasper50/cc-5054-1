'use strict';

/*
 * 无头 DOM 测试：用最小垫片让 lab.js 在 Node 中加载，
 * 触发运行、切场景、切记账模式、拖动带宽、重复反馈、暂停/恢复等全部交互。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

function installDom() {
  const elements = new Map();
  const makeEl = (id) => ({
    id,
    value: id === 'scenario' ? 'twin' : id === 'bwKbps' ? '200' : 'reserved',
    checked: false, innerHTML: '', textContent: '',
    width: 920, height: 200,
    getContext: () => new Proxy({}, { get: () => () => {} }),
    onclick: null, onchange: null,
    addEventListener() {}, appendChild() {}, options: [],
  });
  const ids = [
    'scenario', 'run', 'frameSel', 'story', 'timeline', 'controlView',
    'ledgerView', 'decodeView', 'storyText', 'legend', 'bwKbps', 'applyBw',
    'dupFb', 'pauseBacklog', 'pauseDrain', 'resume', 'reorder', 'cbOrder',
  ];
  for (const id of ids) elements.set(id, makeEl(id));
  let modeValue = 'reserved';
  globalThis.document = {
    getElementById: (id) => elements.get(id) ?? makeEl(id),
    querySelector: () => ({ get value() { return modeValue; } }),
    querySelectorAll: () => [],
  };
  globalThis.alert = (m) => { throw new Error(`意外 alert: ${m}`); };
  return { elements, setMode: (m) => { modeValue = m; } };
}

async function loadLab() {
  const file = path.resolve(process.cwd(), 'lab.js');
  let src = readFileSync(file, 'utf8');
  // data URL 下相对导入无法解析，改写成绝对 file URL
  src = src.replace(/from '\.\/core\/([^']+)'/g, (_, name) =>
    `from '${pathToFileURL(path.resolve(process.cwd(), 'core', name)).href}'`);
  const dataUrl = 'data:text/javascript;base64,' + Buffer.from(src).toString('base64');
  return import(dataUrl);
}

// 全文件共享一个 DOM 与一次模块加载：lab.js 在加载时即绑定 onclick
const dom = installDom();
const el = dom.elements;
await loadLab();

test('无头 DOM: lab.js 加载即运行默认场景且各视图有内容', () => {
  assert.ok(el.get('controlView').innerHTML.includes('下一帧'));
  assert.ok(el.get('ledgerView').innerHTML.includes('模式'));
  assert.ok(el.get('decodeView').innerHTML.includes('连续解码'));
  assert.ok(el.get('frameSel').innerHTML.length > 0);
});

test('无头 DOM: 六个场景 × 两种记账模式都能运行并刷新视图', () => {
  const scenarios = ['twin', 'reorder', 'modes', 'replay', 'debt', 'resume'];
  for (const sc of scenarios) {
    for (const modeVal of ['reserved', 'feedback']) {
      el.get('scenario').value = sc;
      dom.setMode(modeVal);
      el.get('run').onclick();
      assert.ok(el.get('ledgerView').innerHTML.includes(modeVal === 'reserved' ? '预留' : '逐笔'),
        `${sc}/${modeVal} 账本视图应反映模式`);
      assert.ok(el.get('controlView').innerHTML.includes('未结算包'));
    }
  }
});

test('无头 DOM: 拖动带宽、重复反馈、两种暂停与恢复不报错', () => {
  el.get('scenario').value = 'resume';
  el.get('run').onclick();

  el.get('applyBw').onclick();
  assert.ok(el.get('ledgerView').innerHTML.includes('发送端'));

  el.get('dupFb').onclick();
  assert.ok(el.get('ledgerView').innerHTML.includes('重复反馈被吞'));

  el.get('pauseBacklog').onclick();
  assert.ok(el.get('controlView').innerHTML.includes('backlog'));
  el.get('resume').onclick();
  assert.ok(el.get('decodeView').innerHTML.includes('连续解码'));

  el.get('pauseDrain').onclick();
  assert.ok(el.get('controlView').innerHTML.includes('drained'));
  el.get('resume').onclick();

  el.get('scenario').value = 'reorder';
  el.get('reorder').checked = true;
  el.get('run').onclick();
  el.get('cbOrder').value = 'feedback-first';
  el.get('run').onclick();
  assert.ok(el.get('decodeView').innerHTML.length > 0);
});

test('无头 DOM: 未暂停时点恢复会被 alert 拦截且不崩溃', () => {
  globalThis.alert = () => {};
  assert.doesNotThrow(() => el.get('resume').onclick());
});
