import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test, { after } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  emptyToday,
  feedEvent,
  makeState,
  makeTempDir,
  removeTempDir,
  replyJson,
  startStubServer,
} from './helpers.mjs';

const execFileAsync = promisify(execFile);

const BIN_DIR = fileURLToPath(new URL('../bin/', import.meta.url));
const LAUNCHER = path.join(BIN_DIR, 'naiji');
const ENTRY = path.join(BIN_DIR, 'naiji.mjs');
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

// 所有子进程用临时配置目录，避免读写开发者真实 ~/.config
const CONFIG_DIR = makeTempDir('naiji-bin-test-');
after(() => removeTempDir(CONFIG_DIR));

function spawnEnv(overrides = {}) {
  const env = { ...process.env, XDG_CONFIG_HOME: CONFIG_DIR };
  delete env.NAIJI_SERVER;
  delete env.NO_COLOR;
  delete env.TERM;
  // 启动器脚本用 `exec node ...`，测试机 node 可能不在 PATH，这里显式补上
  const nodeDir = path.dirname(process.execPath);
  env.PATH = `${nodeDir}:${process.env.PATH ?? ''}`;
  return { ...env, ...overrides };
}

async function runCli(args, { env = spawnEnv(), cwd } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [ENTRY, ...args], {
      env,
      cwd,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    };
  }
}

test('bin/naiji 是 /bin/sh 启动器且有可执行位', () => {
  const content = readFileSync(LAUNCHER, 'utf8');
  assert.ok(content.startsWith('#!/bin/sh\n'), '应以 #!/bin/sh 开头');
  assert.match(content, /exec node "\$\(dirname "\$0"\)\/naiji\.mjs" "\$@"/);
  assert.ok((statSync(LAUNCHER).mode & 0o111) !== 0, 'naiji 应可执行');
});

test('bin/naiji.mjs 是 ESM 入口且有可执行位', () => {
  const content = readFileSync(ENTRY, 'utf8');
  assert.ok(content.startsWith('#!/usr/bin/env node\n'), '应以 #!/usr/bin/env node 开头');
  assert.match(content, /src\/cli\.mjs/);
  assert.ok((statSync(ENTRY).mode & 0o111) !== 0, 'naiji.mjs 应可执行');
});

test('sh 启动器可执行（--version）', async () => {
  const { stdout } = await execFileAsync('sh', [LAUNCHER, '--version'], { env: spawnEnv() });
  assert.match(stdout, /^naiji \d+\.\d+\.\d+\n$/);
});

test('通过 PATH 调用 naiji 启动器（模拟 npm link / nix devShell）', async () => {
  const { stdout } = await execFileAsync('sh', ['-c', 'PATH="$PWD/cli/bin:$PATH" naiji --version'], {
    cwd: REPO_ROOT,
    env: spawnEnv(),
  });
  assert.match(stdout, /^naiji \d+\.\d+\.\d+\n$/);
});

test('退出码：成功 0 / 用法错误 2（真实子进程）', async () => {
  const version = await runCli(['--version']);
  assert.equal(version.code, 0);

  const help = await runCli(['--help']);
  assert.equal(help.code, 0);

  const unknown = await runCli(['bogus']);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /未知命令/);

  const badAmount = await runCli(['f', 'abc']);
  assert.equal(badAmount.code, 2);
  assert.match(badAmount.stderr, /奶量/);
});

test('非 TTY 子进程输出无 ANSI 颜色（NO_COLOR 同样降级）', async (t) => {
  const stub = await startStubServer((record, res) => {
    if (record.pathname === '/api/state') {
      return replyJson(
        res,
        200,
        makeState({
          now: Date.now(),
          lastFeeding: feedEvent({ happenedAt: Date.now() - 60_000 }),
          today: emptyToday(),
        }),
      );
    }
    replyJson(res, 404, { error: 'not_found', message: '接口不存在' });
  });
  t.after(() => stub.close());

  const normal = await runCli(['status', '--server', stub.baseUrl]);
  assert.equal(normal.code, 0);
  assert.ok(!normal.stdout.includes('\u001b['), '非 TTY 不应有 ANSI');

  const noColor = await runCli(['status', '--server', stub.baseUrl], {
    env: spawnEnv({ NO_COLOR: '1' }),
  });
  assert.equal(noColor.code, 0);
  assert.ok(!noColor.stdout.includes('\u001b['));
});

test('网络错误：真实子进程退出码 1 + stderr 排查建议', async () => {
  const stub = await startStubServer((record, res) => replyJson(res, 200, {}));
  const { baseUrl } = stub;
  await stub.close();

  const result = await runCli(['status', '--server', baseUrl]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /无法连接服务器/);
  assert.match(result.stderr, /服务是否已启动/);
});

test('根 package.json 的 bin / scripts 与 cli 文件一致', () => {
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.bin?.naiji, 'cli/bin/naiji');
  assert.equal(pkg.scripts?.cli, 'node cli/bin/naiji.mjs');
  assert.ok(statSync(path.join(REPO_ROOT, pkg.bin.naiji)).isFile());
  assert.ok(statSync(path.join(REPO_ROOT, 'cli/bin/naiji.mjs')).isFile());
});
