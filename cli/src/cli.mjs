/**
 * 奶记 CLI · 主流程
 *
 * main(argv) 返回退出码（0 成功 / 1 API 或网络错误 / 2 用法错误），
 * 由 bin/naiji.mjs 写入 process.exitCode。io / env / now / confirm 均可注入，便于测试。
 */

import readline from 'node:readline';

import { parseArgs } from './args.mjs';
import { NaijiClient } from './client.mjs';
import { runCommand } from './commands.mjs';
import { resolveServerConfig } from './config.mjs';
import { ApiError, UsageError } from './errors.mjs';
import { commandHelp, globalHelp } from './help.mjs';
import { createStyler, shouldUseColor } from './render.mjs';
import { getVersion } from './version.mjs';

function defaultIO() {
  return {
    stdout: (chunk) => process.stdout.write(chunk),
    stderr: (chunk) => process.stderr.write(chunk),
    stdoutIsTTY: Boolean(process.stdout.isTTY),
    stderrIsTTY: Boolean(process.stderr.isTTY),
    stdinIsTTY: Boolean(process.stdin.isTTY),
  };
}

function defaultConfirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^(y|yes|是|确认)$/i.test(String(answer).trim()));
    });
  });
}

/** 解析失败时也尽量按 --json 输出机器可读错误 */
function looseJsonRequested(argv) {
  return argv.some((arg) => arg === '--json' || String(arg).startsWith('--json='));
}

function reportError(error, { io, env, json, noColor }) {
  const styler = createStyler({
    enabled: shouldUseColor({ isTTY: io.stderrIsTTY, noColor, env }),
  });

  if (error instanceof UsageError) {
    if (json) {
      io.stderr(`${JSON.stringify({ ok: false, error: 'usage_error', message: error.message })}\n`);
    } else {
      io.stderr(`${styler.red('❌')} ${error.message}\n`);
      if (error.hint) io.stderr(`${styler.dim(`   提示：${error.hint}`)}\n`);
    }
    return 2;
  }

  if (error instanceof ApiError) {
    if (json) {
      const payload = { ok: false, error: error.code || 'api_error', message: error.message };
      if (error.status) payload.status = error.status;
      io.stderr(`${JSON.stringify(payload)}\n`);
    } else {
      io.stderr(`${styler.red('❌')} ${error.message}\n`);
      if (error.network) {
        io.stderr(`${styler.dim('   请确认后端服务是否已启动（npm start 或 node server/src/server.js）')}\n`);
        io.stderr(`${styler.dim('   检查 --server 参数或 NAIJI_SERVER 环境变量；naiji config show 可查看当前地址')}\n`);
      }
    }
    return 1;
  }

  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  io.stderr(`${styler.red('❌')} 内部错误：${detail}\n`);
  return 1;
}

/**
 * CLI 主入口。
 * @param {string[]} argv 不含 node 路径与脚本路径的参数
 * @param {{
 *   io?: ReturnType<typeof defaultIO>,
 *   env?: NodeJS.ProcessEnv,
 *   now?: () => number,
 *   cwd?: string,
 *   confirm?: (question: string) => Promise<boolean>,
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 * }} [overrides]
 * @returns {Promise<number>} 退出码
 */
export async function main(argv = process.argv.slice(2), overrides = {}) {
  const io = overrides.io ?? defaultIO();
  const env = overrides.env ?? process.env;
  const now = overrides.now ?? (() => Date.now());
  const cwd = overrides.cwd ?? process.cwd();
  const jsonRequested = looseJsonRequested(argv);

  let parsed = null;
  try {
    parsed = parseArgs(argv);
    const styler = createStyler({
      enabled: shouldUseColor({
        isTTY: io.stdoutIsTTY,
        noColor: parsed.options.noColor,
        env,
      }),
    });

    if (parsed.options.version) {
      io.stdout(`naiji ${getVersion()}\n`);
      return 0;
    }

    if (parsed.options.help) {
      const text = parsed.commandToken
        ? (commandHelp(parsed.command, styler) ?? globalHelp(styler))
        : globalHelp(styler);
      io.stdout(text);
      return 0;
    }

    if (parsed.command === 'help') {
      const target = parsed.positionals[0];
      if (parsed.positionals.length > 1) {
        throw new UsageError('help 只接受一个命令名', '例如：naiji help feed');
      }
      if (!target) {
        io.stdout(globalHelp(styler));
        return 0;
      }
      const text = commandHelp(target, styler);
      if (!text) {
        throw new UsageError(`没有该命令的帮助：${target}`, '运行 naiji help 查看全部命令');
      }
      io.stdout(text);
      return 0;
    }

    const resolved = await resolveServerConfig({
      flagServer: parsed.options.server,
      env,
      warn: (message) => io.stderr(`⚠️  ${message}\n`),
    });

    const client = new NaijiClient({
      server: resolved.server,
      fetchImpl: overrides.fetchImpl,
      timeoutMs: overrides.timeoutMs ?? 10_000,
    });

    const ctx = {
      io,
      styler,
      env,
      now,
      cwd,
      json: parsed.options.json,
      options: parsed.options,
      interactive: Boolean(io.stdinIsTTY && io.stdoutIsTTY),
      confirm: overrides.confirm ?? defaultConfirm,
      client,
      server: resolved.server,
      serverSource: resolved.source,
      configPath: resolved.configPath,
      configExists: resolved.configExists,
      configServer: resolved.configServer,
      configError: resolved.configError,
    };

    await runCommand(parsed, ctx);
    return 0;
  } catch (error) {
    return reportError(error, {
      io,
      env,
      json: parsed ? parsed.options.json : jsonRequested,
      noColor: parsed ? parsed.options.noColor : false,
    });
  }
}
