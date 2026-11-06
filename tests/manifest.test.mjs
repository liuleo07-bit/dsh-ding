/**
 * dsh-ding manifest / 打包契约测试（只读文件，不做修改）。
 *
 * 校验：package.json 可解析及其 dsh 字段、cordis.patch.yml 的 insert[0]、
 * locale 文案、icon.svg，以及宿主半 index.js 可被 ESM 加载。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PLUGIN_ROOT } from './harness.mjs';

function fullPath(relativePath) {
  return path.join(PLUGIN_ROOT, relativePath);
}

function readText(relativePath) {
  return fs.readFileSync(fullPath(relativePath), 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

function assertFileExists(relativePath) {
  const target = fullPath(relativePath);
  assert.ok(fs.existsSync(target), `文件不存在：${target}`);
  assert.ok(fs.statSync(target).isFile(), `不是普通文件：${target}`);
  return target;
}

// ---------------------------------------------------------------------------
// package.json
// ---------------------------------------------------------------------------
test('package.json 可解析，dsh.bundle.patch 指向存在的文件', () => {
  const pkg = readJson('package.json');

  assert.equal(pkg.name, 'dsh-ding');
  assert.ok(pkg.dsh !== undefined && pkg.dsh !== null, 'package.json 缺少 dsh 字段');

  // dsh.bundle.patch -> 存在的文件
  assert.equal(typeof pkg.dsh.bundle, 'object');
  assert.equal(typeof pkg.dsh.bundle.patch, 'string');
  assertFileExists(pkg.dsh.bundle.patch);

  // dsh.client.platform === 'web'
  assert.equal(typeof pkg.dsh.client, 'object');
  assert.equal(pkg.dsh.client.platform, 'web');

  // exports['./client'] -> 存在的文件
  assert.equal(pkg.exports['./client'], './client.js');
  assertFileExists(pkg.exports['./client']);
});

test('package.json 声明的所有导出目标都存在（通配导出跳过）', () => {
  const pkg = readJson('package.json');
  const checked = [];
  for (const [key, target] of Object.entries(pkg.exports || {})) {
    assert.equal(typeof target, 'string', `exports["${key}"] 应为字符串`);
    if (target.includes('*')) continue; // ./locale/*.json
    assertFileExists(target);
    checked.push(target);
  }
  assert.ok(checked.includes('./index.js'));
  assert.ok(checked.includes('./client.js'));
});

// ---------------------------------------------------------------------------
// cordis.patch.yml
// ---------------------------------------------------------------------------
test('cordis.patch.yml 的 insert[0].id / name 均为 dsh-ding', () => {
  const yml = readText('cordis.patch.yml');
  const lines = yml.split(/\r?\n/);

  const contentLines = lines.filter((line) => line.trim() !== '' && !line.trim().startsWith('#'));
  assert.ok(contentLines.length >= 3, 'cordis.patch.yml 内容不完整');
  assert.equal(contentLines[0].trim(), '- insert:', '首个配置项应为 insert');

  const idLine = lines.find((line) => /^\s*-\s*id:\s*\S/.test(line));
  const nameLine = lines.find((line) => /^\s*name:\s*\S/.test(line));
  assert.ok(idLine !== undefined, '缺少 insert[0].id');
  assert.ok(nameLine !== undefined, '缺少 insert[0].name');
  assert.equal(idLine.replace(/^\s*-\s*id:\s*/, '').trim(), 'dsh-ding');
  assert.equal(nameLine.replace(/^\s*name:\s*/, '').trim(), 'dsh-ding');
});

// ---------------------------------------------------------------------------
// locale
// ---------------------------------------------------------------------------
test('locale/zh.json 与 locale/en.json 均提供非空 meta.title / meta.description', () => {
  for (const locale of ['zh', 'en']) {
    const data = readJson(`locale/${locale}.json`);
    assert.ok(data.meta !== undefined && data.meta !== null, `${locale}.json 缺少 meta`);
    assert.equal(typeof data.meta.title, 'string', `${locale}.json meta.title 应为字符串`);
    assert.ok(data.meta.title.trim().length > 0, `${locale}.json meta.title 不应为空`);
    assert.equal(typeof data.meta.description, 'string', `${locale}.json meta.description 应为字符串`);
    assert.ok(data.meta.description.trim().length > 0, `${locale}.json meta.description 不应为空`);
  }
});

// ---------------------------------------------------------------------------
// icon
// ---------------------------------------------------------------------------
test('icon.svg 是 SVG 图标文件', () => {
  const svg = readText('icon.svg');
  assert.match(svg, /<svg[\s>]/, 'icon.svg 应包含 <svg 标签');
  assert.match(svg, /xmlns=("|')http:\/\/www\.w3\.org\/2000\/svg\1/, 'icon.svg 应声明 SVG 命名空间');
});

// ---------------------------------------------------------------------------
// 宿主半 index.js
// ---------------------------------------------------------------------------
test('宿主半 index.js 可作为 ESM 加载，导出 apply() 且为空实现', async () => {
  const moduleUrl = pathToFileURL(fullPath('index.js')).href;
  const hostModule = await import(moduleUrl);

  assert.equal(typeof hostModule.apply, 'function');
  assert.equal(hostModule.name, 'dsh-ding');
  assert.equal(hostModule.apply(), undefined);
});
