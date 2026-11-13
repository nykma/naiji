#!/usr/bin/env node
/**
 * 奶记 CLI 入口（ESM）：调用 src/cli.mjs 的 main，并把返回值设为退出码。
 * 真正的命令实现在 src/；该文件保持薄，方便 `npm link` / nix devShell 直接使用。
 */

import { main } from '../src/cli.mjs';

// 管道被下游提前关闭（如 `naiji export | head`）时安静退出，避免 EPIPE 噪音
process.stdout.on('error', (error) => {
  if (error && error.code === 'EPIPE') process.exit(0);
});

try {
  const exitCode = await main(process.argv.slice(2));
  process.exitCode = exitCode;
} catch (error) {
  console.error('❌ naiji 内部错误：', error);
  process.exitCode = 1;
}
