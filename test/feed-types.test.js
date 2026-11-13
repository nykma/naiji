/**
 * 服务端喂奶类型纯函数测试（server/src/feed-types.js）。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FEED_TYPES,
  FEED_TYPE_LABELS,
  DIAPER_KINDS,
  DIAPER_KIND_LABELS,
  isValidFeedType,
  sortFeedTypes,
  requiresAmount,
  feedTypesLabel,
} from '../server/src/feed-types.js';

describe('feed-types · 常量', () => {
  test('规范顺序为 formula → breast_milk → breast_direct', () => {
    assert.deepEqual(FEED_TYPES, ['formula', 'breast_milk', 'breast_direct']);
    assert.deepEqual(DIAPER_KINDS, ['pee', 'poop', 'mixed']);
  });

  test('中文标签符合契约', () => {
    assert.equal(FEED_TYPE_LABELS.formula, '奶粉');
    assert.equal(FEED_TYPE_LABELS.breast_milk, '母乳（瓶喂）');
    assert.equal(FEED_TYPE_LABELS.breast_direct, '亲喂');
    assert.equal(DIAPER_KIND_LABELS.pee, '小便');
    assert.equal(DIAPER_KIND_LABELS.poop, '大便');
    assert.equal(DIAPER_KIND_LABELS.mixed, '大小便');
  });
});

describe('feed-types · isValidFeedType', () => {
  test('三个合法值', () => {
    for (const type of ['formula', 'breast_milk', 'breast_direct']) {
      assert.equal(isValidFeedType(type), true, `${type} 应合法`);
    }
  });

  test('非法值与类型', () => {
    for (const value of [
      undefined,
      null,
      '',
      'FORMULA',
      'milk',
      'breast',
      ' formula',
      'formula ',
      0,
      1,
      true,
      {},
      [],
      ['formula'],
    ]) {
      assert.equal(isValidFeedType(value), false, `${JSON.stringify(value)} 应不合法`);
    }
  });
});

describe('feed-types · sortFeedTypes', () => {
  test('按规范顺序排列，与输入顺序无关', () => {
    assert.deepEqual(sortFeedTypes(['breast_direct', 'breast_milk', 'formula']), [
      'formula',
      'breast_milk',
      'breast_direct',
    ]);
    assert.deepEqual(sortFeedTypes(['breast_milk', 'formula']), ['formula', 'breast_milk']);
    assert.deepEqual(sortFeedTypes(['breast_direct']), ['breast_direct']);
  });

  test('去重', () => {
    assert.deepEqual(sortFeedTypes(['formula', 'formula']), ['formula']);
    assert.deepEqual(sortFeedTypes(['breast_direct', 'formula', 'breast_direct']), ['formula', 'breast_direct']);
  });

  test('过滤非法值，仅保留合法值', () => {
    assert.deepEqual(sortFeedTypes(['formula', 'bogus', 'breast_direct']), ['formula', 'breast_direct']);
    assert.deepEqual(sortFeedTypes(['bogus', null, 42, 'nope']), []);
  });

  test('空数组 / 非数组', () => {
    assert.deepEqual(sortFeedTypes([]), []);
    assert.deepEqual(sortFeedTypes(undefined), []);
    assert.deepEqual(sortFeedTypes(null), []);
    assert.deepEqual(sortFeedTypes('formula'), []);
    assert.deepEqual(sortFeedTypes({ 0: 'formula', length: 1 }), []);
  });

  test('不修改入参', () => {
    const input = ['breast_direct', 'formula', 'formula'];
    const snapshot = [...input];
    sortFeedTypes(input);
    assert.deepEqual(input, snapshot);
  });
});

describe('feed-types · requiresAmount', () => {
  test('含 formula 或 breast_milk 时必须有奶量', () => {
    assert.equal(requiresAmount(['formula']), true);
    assert.equal(requiresAmount(['breast_milk']), true);
    assert.equal(requiresAmount(['formula', 'breast_direct']), true);
    assert.equal(requiresAmount(['breast_milk', 'breast_direct']), true);
    assert.equal(requiresAmount(['formula', 'breast_milk', 'breast_direct']), true);
  });

  test('仅亲喂 / 空数组不需要奶量', () => {
    assert.equal(requiresAmount(['breast_direct']), false);
    assert.equal(requiresAmount([]), false);
  });
});

describe('feed-types · feedTypesLabel', () => {
  test('单标签', () => {
    assert.equal(feedTypesLabel(['formula']), '奶粉');
    assert.equal(feedTypesLabel(['breast_milk']), '母乳（瓶喂）');
    assert.equal(feedTypesLabel(['breast_direct']), '亲喂');
  });

  test('双标签用 " + " 连接（即使入参顺序乱）', () => {
    assert.equal(feedTypesLabel(['formula', 'breast_milk']), '奶粉 + 母乳（瓶喂）');
    assert.equal(feedTypesLabel(['breast_milk', 'formula']), '奶粉 + 母乳（瓶喂）');
    assert.equal(feedTypesLabel(['breast_direct', 'formula']), '奶粉 + 亲喂');
    assert.equal(feedTypesLabel(['breast_direct', 'breast_milk']), '母乳（瓶喂） + 亲喂');
  });

  test('三标签', () => {
    assert.equal(
      feedTypesLabel(['breast_direct', 'formula', 'breast_milk']),
      '奶粉 + 母乳（瓶喂） + 亲喂',
    );
  });

  test('空数组 / 全非法 → 空字符串；非法值被过滤', () => {
    assert.equal(feedTypesLabel([]), '');
    assert.equal(feedTypesLabel(['bogus']), '');
    assert.equal(feedTypesLabel(['bogus', 'breast_direct']), '亲喂');
  });
});
