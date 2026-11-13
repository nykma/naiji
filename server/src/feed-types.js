/**
 * 喂奶类型定义（服务端共用：db / state / server / CSV）
 * 规范顺序：formula → breast_milk → breast_direct
 */

export const FEED_TYPES = ['formula', 'breast_milk', 'breast_direct'];

export const FEED_TYPE_LABELS = {
  formula: '奶粉',
  breast_milk: '母乳（瓶喂）',
  breast_direct: '亲喂',
};

export function isValidFeedType(value) {
  return typeof value === 'string' && FEED_TYPES.includes(value);
}

/** 按规范顺序排列并去重（保持只有合法值） */
export function sortFeedTypes(types) {
  const set = new Set(Array.isArray(types) ? types.filter(isValidFeedType) : []);
  return FEED_TYPES.filter((type) => set.has(type));
}

/** 含瓶喂（奶粉 / 母乳）标签时必须有奶量 */
export function requiresAmount(types) {
  return types.includes('formula') || types.includes('breast_milk');
}

/** ["formula","breast_direct"] → "奶粉 + 亲喂" */
export function feedTypesLabel(types) {
  return sortFeedTypes(types)
    .map((type) => FEED_TYPE_LABELS[type])
    .join(' + ');
}

export const DIAPER_KINDS = ['pee', 'poop', 'mixed'];

export const DIAPER_KIND_LABELS = {
  pee: '小便',
  poop: '大便',
  mixed: '大小便',
};
