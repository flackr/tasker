export interface AisleSortableTask {
  summary: string;
  categories: string[];
}

function normalizeAisle(name: string): string {
  return name.trim().toLowerCase();
}

function getAisleRank(categories: string[], normalizedOrder: string[]): number {
  var bestRank = normalizedOrder.length;
  for (var i = 0; i < categories.length; i++) {
    var normalized = normalizeAisle(categories[i]);
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
 * Sorts tasks by store aisle walk order (ES5 / Fitbit Versa 2 safe).
 * Tasks matching earlier aisles come first; uncategorized or unrecognized
 * items are placed at the end in case-insensitive summary order.
 */
export function sortTasksByAisle<T extends AisleSortableTask>(
  tasks: readonly T[],
  aisleOrder: readonly string[],
): T[] {
  var normalizedOrder: string[] = [];
  for (var i = 0; i < aisleOrder.length; i++) {
    normalizedOrder.push(normalizeAisle(aisleOrder[i]));
  }

  var copy: T[] = tasks.slice();
  copy.sort(function (a, b) {
    var rankA = getAisleRank(a.categories, normalizedOrder);
    var rankB = getAisleRank(b.categories, normalizedOrder);
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
