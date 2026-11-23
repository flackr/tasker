export interface CategorySortableTask {
  summary: string;
  categories: string[];
}

function normalizeCategory(name: string): string {
  return name.trim().toLowerCase();
}

function getCategoryRank(categories: string[], normalizedOrder: string[]): number {
  var bestRank = normalizedOrder.length;
  for (var i = 0; i < categories.length; i++) {
    var normalized = normalizeCategory(categories[i]);
    for (var j = 0; j < normalizedOrder.length; j++) {
      if (normalizedOrder[j] === normalized && j < bestRank) {
        bestRank = j;
        break;
      }
    }
  }
  return bestRank;
}

/**
 * Sorts tasks by configured category order (ES5 / Fitbit Versa 2 safe).
 * Tasks matching earlier categories come first; uncategorized or unrecognized
 * items are placed at the end in case-insensitive summary order.
 */
export function sortTasksByCategory<T extends CategorySortableTask>(
  tasks: readonly T[],
  categoryOrder: readonly string[],
): T[] {
  var normalizedOrder: string[] = [];
  for (var i = 0; i < categoryOrder.length; i++) {
    normalizedOrder.push(normalizeCategory(categoryOrder[i]));
  }

  var copy: T[] = tasks.slice();
  copy.sort(function (a, b) {
    var rankA = getCategoryRank(a.categories, normalizedOrder);
    var rankB = getCategoryRank(b.categories, normalizedOrder);
    if (rankA !== rankB) {
      return rankA - rankB;
    }
    var summaryA = a.summary.toLowerCase();
    var summaryB = b.summary.toLowerCase();
    if (summaryA < summaryB) return -1;
    if (summaryA > summaryB) return 1;
    return 0;
  });
  return copy;
}
