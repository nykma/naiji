/**
 * 奶记 CLI · 版本号（读取包内 package.json；读取失败时回退到内置版本）
 */

import { readFileSync } from 'node:fs';

const FALLBACK_VERSION = '2.0.0';

export function getVersion() {
  try {
    const pkgText = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
    const pkg = JSON.parse(pkgText);
    if (typeof pkg.version === 'string' && pkg.version.trim() !== '') return pkg.version.trim();
  } catch {
    // 忽略：CLI 可能被单独拷贝出去运行
  }
  return FALLBACK_VERSION;
}
