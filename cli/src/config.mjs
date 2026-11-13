/**
 * 奶记 CLI · 配置与服务器地址解析
 *
 * 优先级（高 → 低）：--server > NAIJI_SERVER > $XDG_CONFIG_HOME/naiji/config.json > 默认。
 * 默认配置文件路径 `~/.config/naiji/config.json`（尊重 XDG_CONFIG_HOME）。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { UsageError } from './errors.mjs';

export const DEFAULT_SERVER = 'http://127.0.0.1:3000';

export const SERVER_SOURCE_LABELS = {
  flag: '命令行参数 --server',
  env: '环境变量 NAIJI_SERVER',
  config: '配置文件',
  default: '默认值（内置）',
};

/**
 * 配置文件路径：$XDG_CONFIG_HOME/naiji/config.json，否则 ~/.config/naiji/config.json。
 * @param {NodeJS.ProcessEnv} [env]
 */
export function configPath(env = process.env) {
  const xdg = typeof env.XDG_CONFIG_HOME === 'string' ? env.XDG_CONFIG_HOME.trim() : '';
  if (xdg && path.isAbsolute(xdg)) return path.join(xdg, 'naiji', 'config.json');
  return path.join(os.homedir(), '.config', 'naiji', 'config.json');
}

/**
 * 读取配置文件。
 * @returns {Promise<{ path: string, exists: boolean, data: Record<string, unknown>, error: string|null }>}
 */
export async function readConfigFile(env = process.env) {
  const filePath = configPath(env);
  let text;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { path: filePath, exists: false, data: {}, error: null };
    }
    return { path: filePath, exists: false, data: {}, error: `无法读取（${error?.code ?? error}）` };
  }
  try {
    const data = JSON.parse(text);
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      return { path: filePath, exists: true, data: {}, error: '配置文件必须是 JSON 对象' };
    }
    return { path: filePath, exists: true, data, error: null };
  } catch {
    return { path: filePath, exists: true, data: {}, error: '配置文件不是合法 JSON' };
  }
}

/** 写入配置文件（自动创建目录），返回写入的路径 */
export async function writeConfigFile(env, data) {
  const filePath = configPath(env);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return filePath;
}

/**
 * 规范化 / 校验服务器地址：允许省略协议（自动补 http://），去掉末尾斜杠。
 * 非法时抛 UsageError。
 * @param {string} raw
 * @param {{ label?: string }} [options]
 */
export function normalizeServerUrl(raw, { label = '服务器地址' } = {}) {
  const input = typeof raw === 'string' ? raw.trim() : '';
  if (input === '') throw new UsageError(`${label}不能为空`);
  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(input) ? input : `http://${input}`;
  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new UsageError(`${label}不是合法的 URL：${raw}`, '示例：http://192.168.1.23:3000');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UsageError(`${label}必须以 http:// 或 https:// 开头`, '示例：http://192.168.1.23:3000');
  }
  if (!url.hostname) throw new UsageError(`${label}缺少主机名：${raw}`);
  if (url.search || url.hash) {
    throw new UsageError(`${label}不能带查询参数或 # 片段：${raw}`);
  }
  const pathname = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${pathname}`;
}

/**
 * 纯函数：按优先级选出服务器地址。
 * @param {{ flagServer?: string|null, envServer?: string|null, fileServer?: string|null }} sources
 */
export function resolveServer({ flagServer = null, envServer = null, fileServer = null } = {}) {
  if (flagServer) return { server: flagServer, source: 'flag' };
  if (envServer) return { server: envServer, source: 'env' };
  if (fileServer) return { server: fileServer, source: 'config' };
  return { server: DEFAULT_SERVER, source: 'default' };
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * 读取配置文件并解析出最终生效的服务器地址。
 * - --server / NAIJI_SERVER 非法 → UsageError（退出码 2）
 * - 配置文件损坏 / 其中 server 非法 → 通过 warn 提示并忽略
 *
 * @param {{ flagServer?: string, env?: NodeJS.ProcessEnv, warn?: (message: string) => void }} options
 */
export async function resolveServerConfig({ flagServer, env = process.env, warn = () => {} } = {}) {
  const loaded = await readConfigFile(env);
  if (loaded.error) {
    warn(`配置文件有误，已忽略：${loaded.error}（${loaded.path}）`);
  }

  let fileServer = null;
  const rawFileServer = loaded.data ? loaded.data.server : undefined;
  if (nonEmpty(rawFileServer)) {
    try {
      fileServer = normalizeServerUrl(rawFileServer, { label: '配置文件中的 server' });
    } catch (error) {
      warn(`${error.message}，已忽略（${loaded.path}）`);
    }
  }

  const flag = nonEmpty(flagServer)
    ? normalizeServerUrl(flagServer, { label: '--server 参数' })
    : null;

  let envServer = null;
  const rawEnvServer = env.NAIJI_SERVER;
  if (nonEmpty(rawEnvServer)) {
    try {
      envServer = normalizeServerUrl(rawEnvServer, { label: 'NAIJI_SERVER' });
    } catch {
      throw new UsageError(
        `环境变量 NAIJI_SERVER 不是合法地址：${rawEnvServer}`,
        '示例：export NAIJI_SERVER=http://192.168.1.23:3000',
      );
    }
  }

  const resolved = resolveServer({ flagServer: flag, envServer, fileServer });
  return {
    ...resolved,
    configPath: loaded.path,
    configExists: loaded.exists,
    configData: loaded.data,
    configError: loaded.error,
    configServer: fileServer,
  };
}

/**
 * naiji config set server <url>：写入配置文件（保留其它未知键）。
 * @returns {Promise<{ server: string, path: string }>}
 */
export async function setConfigServer({ env = process.env, url } = {}) {
  const server = normalizeServerUrl(url, { label: '服务器地址' });
  const loaded = await readConfigFile(env);
  const base = loaded.data && typeof loaded.data === 'object' ? loaded.data : {};
  const data = { ...base, server };
  const filePath = await writeConfigFile(env, data);
  return { server, path: filePath };
}
