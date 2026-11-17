/**
 * 奶记 · 按天聚合（纯函数）
 * state.today 与 /api/stats 共用同一套口径，避免两处逻辑漂移。
 */

/** 某一天的初始统计（date 为 YYYY-MM-DD） */
export function createDayTotals(date) {
  return {
    date,
    feedCount: 0,
    totalMl: 0,
    formulaCount: 0,
    breastMilkCount: 0,
    breastDirectCount: 0,
    mixedFeedCount: 0,
    diaperCount: 0,
    peeCount: 0,
    poopCount: 0,
    mixedCount: 0,
    bathCount: 0,
  };
}

/** 把一个事件累加进当天统计（就地修改并返回 totals） */
export function addEventToDayTotals(totals, event) {
  if (!totals || !event) return totals;

  if (event.kind === 'feed') {
    totals.feedCount += 1;
    if (event.amountMl !== null && event.amountMl !== undefined) totals.totalMl += event.amountMl;
    const types = event.feedTypes ?? [];
    if (types.includes('formula')) totals.formulaCount += 1;
    if (types.includes('breast_milk')) totals.breastMilkCount += 1;
    if (types.includes('breast_direct')) totals.breastDirectCount += 1;
    if (types.length > 1) totals.mixedFeedCount += 1;
  } else if (event.kind === 'diaper') {
    totals.diaperCount += 1;
    if (event.diaperKind === 'mixed') {
      totals.mixedCount += 1;
      totals.peeCount += 1;
      totals.poopCount += 1;
    } else if (event.diaperKind === 'pee') {
      totals.peeCount += 1;
    } else if (event.diaperKind === 'poop') {
      totals.poopCount += 1;
    }
  } else if (event.kind === 'bath') {
    totals.bathCount += 1;
  }

  return totals;
}
