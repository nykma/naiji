import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_SERVER,
  configPath,
  normalizeServerUrl,
  readConfigFile,
  resolveServer,
  resolveServerConfig,
  setConfigServer,
  writeConfigFile,
} from '../src/config.mjs';
import { UsageError } from '../src/errors.mjs';
import { makeTempDir, makeTestEnv, removeTempDir } from './helpers.mjs';

test('configPath：尊重 XDG_CONFIG_HOME，否则回退 ~/.config', () => {
  assert.equal(
    configPath({ XDG_CONFIG_HOME: '/tmp/xdg' }),
    path.join('/tmp/xdg', 'naiji', 'config.json'),
  );
  const homeFallback = configPath({ XDG_CONFIG_HOME: '' });
  assert.ok(homeFallback.endsWith(path.join('.config', 'naiji', 'config.json')));
  assert.ok(!homeFallback.startsWith('/tmp/xdg'));
  // 相对路径的 XDG_CONFIG_HOME 不合规范，回退
  const relative = configPath({ XDG_CONFIG_HOME: 'relative/dir' });
  assert.ok(relative.endsWith(path.join('.config', 'naiji', 'config.json')));
});

test('normalizeServerUrl：补协议 / 去尾斜杠 / 校验', () => {
  assert.equal(normalizeServerUrl('http://127.0.0.1:3000/'), 'http://127.0.0.1:3000');
  assert.equal(normalizeServerUrl('http://127.0.0.1:3000///'), 'http://127.0.0.1:3000');
  assert.equal(normalizeServerUrl(' 192.168.1.5:3000 '), 'http://192.168.1.5:3000');
  assert.equal(normalizeServerUrl('https://example.com/base/'), 'https://example.com/base');
  assert.equal(normalizeServerUrl('http://localhost:3000'), 'http://localhost:3000');
});

test('normalizeServerUrl：非法地址抛 UsageError', () => {
  for (const bad of ['', '   ', 'ftp://example.com', 'http://', 'http://x?y=1', 'http://x/#a']) {
    assert.throws(() => normalizeServerUrl(bad), UsageError, `应拒绝：${JSON.stringify(bad)}`);
  }
});

test('resolveServer：flag > env > file > default', () => {
  const all = resolveServer({
    flagServer: 'http://flag:1',
    envServer: 'http://env:2',
    fileServer: 'http://file:3',
  });
  assert.deepEqual(all, { server: 'http://flag:1', source: 'flag' });

  assert.deepEqual(resolveServer({ envServer: 'http://env:2', fileServer: 'http://file:3' }), {
    server: 'http://env:2',
    source: 'env',
  });
  assert.deepEqual(resolveServer({ fileServer: 'http://file:3' }), {
    server: 'http://file:3',
    source: 'config',
  });
  assert.deepEqual(resolveServer({}), { server: DEFAULT_SERVER, source: 'default' });
});

test('readConfigFile：不存在 → exists=false；写入后可读回', async () => {
  const dir = makeTempDir();
  try {
    const env = makeTestEnv({ XDG_CONFIG_HOME: dir });
    const missing = await readConfigFile(env);
    assert.equal(missing.exists, false);
    assert.deepEqual(missing.data, {});
    assert.equal(missing.error, null);

    const written = await writeConfigFile(env, { server: 'http://192.168.1.9:3000' });
    assert.equal(written, path.join(dir, 'naiji', 'config.json'));
    const loaded = await readConfigFile(env);
    assert.equal(loaded.exists, true);
    assert.deepEqual(loaded.data, { server: 'http://192.168.1.9:3000' });
  } finally {
    removeTempDir(dir);
  }
});

test('readConfigFile：坏 JSON 返回 error 不抛异常', async () => {
  const dir = makeTempDir();
  try {
    const env = makeTestEnv({ XDG_CONFIG_HOME: dir });
    const filePath = path.join(dir, 'naiji', 'config.json');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, '{ not json', 'utf8');
    const loaded = await readConfigFile(env);
    assert.equal(loaded.exists, true);
    assert.match(loaded.error, /JSON/);
  } finally {
    removeTempDir(dir);
  }
});

test('resolveServerConfig：配置文件生效', async () => {
  const dir = makeTempDir();
  try {
    const env = makeTestEnv({ XDG_CONFIG_HOME: dir });
    await writeConfigFile(env, { server: 'http://192.168.1.9:3000/' });
    const resolved = await resolveServerConfig({ env });
    assert.equal(resolved.server, 'http://192.168.1.9:3000');
    assert.equal(resolved.source, 'config');
    assert.equal(resolved.configExists, true);
    assert.equal(resolved.configServer, 'http://192.168.1.9:3000');
  } finally {
    removeTempDir(dir);
  }
});

test('resolveServerConfig：环境变量 / --server 覆盖配置文件', async () => {
  const dir = makeTempDir();
  try {
    const env = makeTestEnv({
      XDG_CONFIG_HOME: dir,
      NAIJI_SERVER: 'http://env-server:1111',
    });
    await writeConfigFile(env, { server: 'http://file-server:2222' });

    const fromEnv = await resolveServerConfig({ env });
    assert.equal(fromEnv.server, 'http://env-server:1111');
    assert.equal(fromEnv.source, 'env');

    const fromFlag = await resolveServerConfig({ env, flagServer: 'http://flag-server:3333' });
    assert.equal(fromFlag.server, 'http://flag-server:3333');
    assert.equal(fromFlag.source, 'flag');
  } finally {
    removeTempDir(dir);
  }
});

test('resolveServerConfig：无任何来源 → 默认地址', async () => {
  const dir = makeTempDir();
  try {
    const env = makeTestEnv({ XDG_CONFIG_HOME: dir });
    const resolved = await resolveServerConfig({ env });
    assert.equal(resolved.server, DEFAULT_SERVER);
    assert.equal(resolved.source, 'default');
    assert.equal(resolved.configExists, false);
  } finally {
    removeTempDir(dir);
  }
});

test('resolveServerConfig：NAIJI_SERVER 非法 → UsageError', async () => {
  const dir = makeTempDir();
  try {
    const env = makeTestEnv({ XDG_CONFIG_HOME: dir, NAIJI_SERVER: 'ftp://nope' });
    await assert.rejects(() => resolveServerConfig({ env }), UsageError);
  } finally {
    removeTempDir(dir);
  }
});

test('resolveServerConfig：配置文件损坏 → warn 并回退', async () => {
  const dir = makeTempDir();
  try {
    const env = makeTestEnv({ XDG_CONFIG_HOME: dir });
    const filePath = path.join(dir, 'naiji', 'config.json');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, '{ broken', 'utf8');
    const warnings = [];
    const resolved = await resolveServerConfig({ env, warn: (message) => warnings.push(message) });
    assert.equal(resolved.source, 'default');
    assert.equal(resolved.server, DEFAULT_SERVER);
    assert.equal(warnings.length, 1);
  } finally {
    removeTempDir(dir);
  }
});

test('setConfigServer：规范化后写入并保留其它键', async () => {
  const dir = makeTempDir();
  try {
    const env = makeTestEnv({ XDG_CONFIG_HOME: dir });
    await writeConfigFile(env, { other: 'keep-me' });
    const result = await setConfigServer({ env, url: '192.168.1.7:3000/' });
    assert.equal(result.server, 'http://192.168.1.7:3000');
    const raw = JSON.parse(readFileSync(path.join(dir, 'naiji', 'config.json'), 'utf8'));
    assert.deepEqual(raw, { other: 'keep-me', server: 'http://192.168.1.7:3000' });
  } finally {
    removeTempDir(dir);
  }
});

test('setConfigServer：非法 URL 抛 UsageError 且不写文件', async () => {
  const dir = makeTempDir();
  try {
    const env = makeTestEnv({ XDG_CONFIG_HOME: dir });
    await assert.rejects(() => setConfigServer({ env, url: 'ftp://nope' }), UsageError);
    const loaded = await readConfigFile(env);
    assert.equal(loaded.exists, false);
  } finally {
    removeTempDir(dir);
  }
});
