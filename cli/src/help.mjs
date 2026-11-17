/**
 * 奶记 CLI · 帮助文本
 *
 * 输出按显示宽度（中文按 2 列）对齐，兼顾 80 列终端。
 */

import { DEFAULT_SERVER } from './config.mjs';

const COMMAND_SUMMARIES = [
  ['status, s', '查看状态（不带参数时的默认命令）'],
  ['feed, f <ml>', '记录喂奶（多标签；仅亲喂可省略奶量）'],
  ['pee, p', '记录小便'],
  ['poop, o', '记录大便'],
  ['diaper, d <kind>', '记录大小便（pee | poop | mixed）'],
  ['bath, b', '记录洗澡（可加备注）'],
  ['log, l [-n 10]', '最近记录（按天分组）'],
  ['today', '今天的时间线 + 今日汇总'],
  ['undo, u', '撤销最近一条记录'],
  ['rm <id>', '删除指定 id 的记录'],
  ['export [--out <path>]', '导出 CSV（默认输出到 stdout）'],
  ['config [show|set server <url>]', '查看 / 修改配置'],
  ['help [command]', '查看帮助'],
];

const OPTION_SUMMARIES = [
  ['-t, --type <list>', '喂奶类型：可重复或逗号分隔'],
  ['', 'formula/f(奶粉)、breast_milk/b(母乳)'],
  ['', 'breast_direct/d(亲喂)'],
  ['--direct', '追加“亲喂”标签；不带奶量时 = 仅亲喂'],
  ['--note <text>', '备注（≤ 200 字）'],
  ['--ago <分钟>', '补记 N 分钟前的记录'],
  ['--at <时间>', '补记时间：HH:MM（今天）或 "YYYY-MM-DD HH:MM"'],
  ['-n, --limit <n>', 'log 的条数（1–200，默认 10）'],
  ['--out <path>', 'export 输出文件路径（- 表示 stdout）'],
  ['-y, --yes', 'undo / rm 跳过确认'],
  ['--server <url>', '后端 API 地址（优先级最高）'],
  ['--json', '输出 JSON（脚本友好）'],
  ['--no-color', '关闭颜色（另可用 NO_COLOR=1）'],
  ['-h, --help', '帮助'],
  ['-V, --version', '版本'],
];

const EXAMPLES = [
  ['naiji', '查看状态'],
  ['naiji f 120', '奶粉 120 ml'],
  ['naiji f 90 -t breast_milk', '母乳（瓶喂）90 ml'],
  ['naiji f 60 -t formula -t breast_direct', '奶粉 + 亲喂，总奶量 60 ml'],
  ['naiji f 60 -t formula,breast_milk', '奶粉 + 母乳，总奶量 60 ml'],
  ['naiji f --direct', '仅亲喂一次（无奶量）'],
  ['naiji f 90 -t 奶粉 --ago 30', '补记 30 分钟前的奶粉 90 ml'],
  ['naiji f 120 --at "20:30"', '补记今天 20:30'],
  ['naiji p --note 换得挺多', '记录小便 + 备注'],
  ['naiji d poop', '记录大便'],
  ['naiji bath', '记录洗澡'],
  ['naiji b --ago 30 --note 洗香香', '补记 30 分钟前的洗澡'],
  ['naiji log -n 20', '最近 20 条'],
  ['naiji undo --yes', '撤销最近一条（不确认）'],
  ['naiji export --out milk.csv', '导出 CSV 到文件'],
  ['naiji config set server http://192.168.1.23:3000', '指向家里那台后端'],
  ['naiji --json status', 'JSON 输出，配合 jq 使用'],
];

const COMMAND_HELP = {
  status: {
    usage: 'naiji status',
    lines: [
      '查看状态卡：距离上次喂奶、上次详情、距上次换尿布/洗澡、今日汇总。',
      '「距上次换尿布/洗澡」取 lastDiaper 与 lastBath 中较晚者（洗澡同样重置计时）。',
      '不带任何参数运行 `naiji` 等价于 `naiji status`。',
    ],
    examples: [
      ['naiji', '与 naiji status 相同'],
      ['naiji --json status', '输出原始 state JSON'],
    ],
  },
  feed: {
    usage: 'naiji feed [<ml>] [-t <类型>]... [--direct]\n             [--note <text>] [--ago <分钟> | --at <时间>]',
    lines: [
      '记录一次喂奶。类型可多选（1–3 个），默认 formula（奶粉）；',
      '带瓶喂标签（formula / breast_milk）时必须提供总奶量（1–2000 ml）。',
      '--direct 追加“亲喂”标签；单独使用时表示仅亲喂、无需奶量。',
      '命令别名：naiji f',
    ],
    examples: [
      ['naiji f 120', '奶粉 120 ml'],
      ['naiji f 60 -t formula -t breast_direct', '亲喂 + 补充 60 ml 奶粉'],
      ['naiji f 90 -t 母乳 --ago 30', '30 分钟前的母乳（瓶喂）90 ml'],
      ['naiji f 120 --at "08:30"', '补记今天 08:30'],
      ['naiji f --direct --note 夜里', '仅亲喂'],
    ],
  },
  pee: {
    usage: 'naiji pee [--note <text>] [--ago <分钟> | --at <时间>]',
    lines: ['记录一次小便。别名：naiji p'],
    examples: [
      ['naiji p', '记录小便'],
      ['naiji p --ago 10', '补记 10 分钟前'],
    ],
  },
  poop: {
    usage: 'naiji poop [--note <text>] [--ago <分钟> | --at <时间>]',
    lines: ['记录一次大便。别名：naiji o'],
    examples: [
      ['naiji o', '记录大便'],
      ['naiji o --note 有点稀', '记录大便 + 备注'],
    ],
  },
  diaper: {
    usage: 'naiji diaper <pee|poop|mixed>\n               [--note <text>] [--ago <分钟> | --at <时间>]',
    lines: [
      '记录大小便；mixed 表示一次记录同时包含小便和大便。',
      '通常直接用 naiji pee / naiji poop 更省事；别名：naiji d',
    ],
    examples: [
      ['naiji d mixed', '记录大小便'],
      ['naiji d 大便', '中文别名同样可用'],
    ],
  },
  bath: {
    usage: 'naiji bath [--note <text>] [--ago <分钟> | --at <时间>]',
    lines: [
      '记录一次洗澡；--note / --ago / --at / --json 与其它记录命令一致。',
      '洗澡也会重置「距上次换尿布/洗澡」计时，并计入今日汇总。',
      '别名：naiji b',
    ],
    examples: [
      ['naiji bath', '记录现在洗澡'],
      ['naiji b --note 洗香香', '记录洗澡 + 备注'],
      ['naiji b --ago 30', '补记 30 分钟前'],
      ['naiji bath --json', '输出服务端返回的 event JSON'],
    ],
  },
  log: {
    usage: 'naiji log [-n <条数>]',
    lines: [
      '查看最近记录，按天分组、一行一条，包含时间、图标、内容与记录 id。',
      '别名：naiji l；-n 范围 1–200，默认 10。',
    ],
    examples: [
      ['naiji log', '最近 10 条'],
      ['naiji l -n 20', '最近 20 条'],
    ],
  },
  today: {
    usage: 'naiji today',
    lines: ['查看今日全部记录 + 今日汇总。'],
    examples: [['naiji today', '今天的时间线']],
  },
  undo: {
    usage: 'naiji undo [--yes]',
    lines: [
      '删除最近一条记录（喂奶 / 大小便 / 洗澡均可）并打印被删内容。',
      'TTY 下会询问 y/N 确认；--yes 跳过；非 TTY（脚本调用）自动执行。',
      '别名：naiji u',
    ],
    examples: [
      ['naiji undo', '确认后撤销最近一条'],
      ['naiji undo --yes', '直接撤销'],
    ],
  },
  rm: {
    usage: 'naiji rm <id> [--yes]',
    lines: [
      '删除指定 id 的记录。id 可从 naiji log / naiji today 的行尾 #id 查看。',
      'TTY 下会询问 y/N 确认；--yes 跳过；非 TTY 自动执行。',
    ],
    examples: [['naiji rm 12', '删除 id=12 的记录']],
  },
  export: {
    usage: 'naiji export [--out <path>]',
    lines: [
      '导出全部记录为 CSV（UTF-8 BOM，Excel 可直接打开）。',
      '不带 --out 时输出到 stdout（可重定向：naiji export > baby.csv）。',
    ],
    examples: [
      ['naiji export --out milk.csv', '写入文件'],
      ['naiji export', '输出到终端'],
    ],
  },
  config: {
    usage: 'naiji config [show | set server <url>]',
    lines: [
      '查看当前生效的服务器地址与来源，或修改配置文件。',
      '配置文件：$XDG_CONFIG_HOME/naiji/config.json（默认 ~/.config/naiji/config.json）',
      '优先级：--server > NAIJI_SERVER > 配置文件 > 默认 http://127.0.0.1:3000。',
      '别名：naiji c',
    ],
    examples: [
      ['naiji config show', '查看当前地址与来源'],
      ['naiji config set server http://192.168.1.23:3000', '写入配置'],
    ],
  },
  help: {
    usage: 'naiji help [command]',
    lines: ['查看全局帮助或某个命令的详细用法。'],
    examples: [
      ['naiji help', '全局帮助'],
      ['naiji help feed', 'feed 命令帮助'],
    ],
  },
};

const WIDE_CHAR_RE =
  /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6\u3000-\u303e]/u;

/** 终端显示宽度：中日韩全角字符按 2 列计 */
export function displayWidth(text) {
  let width = 0;
  for (const char of String(text)) width += WIDE_CHAR_RE.test(char) ? 2 : 1;
  return width;
}

function padDisplay(text, width) {
  const pad = Math.max(0, width - displayWidth(text));
  return `${text}${' '.repeat(pad)}`;
}

function tableRow(left, right, leftWidth, indent = 2) {
  const gap = Math.max(2, leftWidth - displayWidth(left));
  return `${' '.repeat(indent)}${left}${' '.repeat(gap)}${right}`;
}

function heading(styler, text) {
  return styler.bold(text);
}

/** 全局帮助文本 */
export function globalHelp(styler) {
  const lines = [];
  lines.push(`🍼 ${styler.bold('naiji')} · 奶记 CLI（婴儿喂养记录）`);
  lines.push('');
  lines.push(heading(styler, '用法:'));
  lines.push('  naiji [命令] [参数] [选项]');
  lines.push('');
  lines.push(heading(styler, '命令:'));
  for (const [name, summary] of COMMAND_SUMMARIES) {
    lines.push(tableRow(name, summary, 32));
  }
  lines.push('');
  lines.push(heading(styler, '选项:'));
  for (const [name, summary] of OPTION_SUMMARIES) {
    if (name === '') lines.push(`  ${' '.repeat(24)}${summary}`);
    else lines.push(tableRow(name, summary, 24));
  }
  lines.push('');
  lines.push(heading(styler, '服务器地址优先级:'));
  lines.push(`  --server > NAIJI_SERVER > 配置文件 > ${DEFAULT_SERVER}`);
  lines.push('  配置文件: $XDG_CONFIG_HOME/naiji/config.json');
  lines.push('            （默认 ~/.config/naiji/config.json）');
  lines.push('');
  lines.push(heading(styler, '退出码:'));
  lines.push('  0 成功 · 1 API / 网络错误 · 2 用法错误');
  lines.push('');
  lines.push(heading(styler, '示例:'));
  for (const [cmd, summary] of EXAMPLES) {
    lines.push(tableRow(cmd, `# ${summary}`, 42));
  }
  lines.push('');
  lines.push(styler.dim('  更多帮助：naiji help <command>；机器可读：--json'));
  return `${lines.join('\n')}\n`;
}

/** 单个命令帮助；未知命令返回 null */
export function commandHelp(command, styler) {
  const name = String(command ?? '').toLowerCase();
  const entry = COMMAND_HELP[name];
  if (!entry) return null;
  const lines = [];
  lines.push(`🍼 ${styler.bold(`naiji ${name}`)}`);
  lines.push('');
  lines.push(heading(styler, '用法:'));
  lines.push(`  ${entry.usage}`);
  lines.push('');
  lines.push(...entry.lines);
  if (entry.examples.length > 0) {
    lines.push('');
    lines.push(heading(styler, '示例:'));
    for (const [cmd, summary] of entry.examples) {
      lines.push(tableRow(cmd, `# ${summary}`, 44));
    }
  }
  lines.push('');
  lines.push(styler.dim('  全局选项：--server / --json / --no-color / -h / -V（见 naiji help）'));
  return `${lines.join('\n')}\n`;
}

export const KNOWN_COMMANDS = Object.keys(COMMAND_HELP);
