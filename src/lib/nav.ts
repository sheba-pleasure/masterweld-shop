// Чистая логика навигации по каталогу: дерево категорий не глубже двух
// уровней, раскрытие подразделов и вычисление уровня. Покрыто тестами.

export interface CategoryLike {
  id: string;
  slug: string;
  name: string;
  parent_id: string | null;
  sort_order: number;
}

export interface CategoryTreeItem<T> {
  category: T;
  children: T[];
}

/** Максимальная глубина навигации: категория + её подразделы. */
export const MAX_NAV_DEPTH = 2;

/** Строит дерево «родитель → подразделы» (ровно 2 уровня). */
export function buildCategoryTree<T extends CategoryLike>(cats: T[]): CategoryTreeItem<T>[] {
  const bySort = (a: T, b: T) => a.sort_order - b.sort_order;
  return cats
    .filter((c) => !c.parent_id)
    .sort(bySort)
    .map((category) => ({
      category,
      children: cats.filter((c) => c.parent_id === category.id).sort(bySort),
    }));
}

/** Уровень категории в дереве: 1 — верхний, 2 — подраздел. Циклы не зацикливают. */
export function navDepth<T extends CategoryLike>(cat: T, byId: Map<string, T>): number {
  let depth = 1;
  let current: T | undefined = cat;
  const seen = new Set<string>([cat.id]);
  while (current?.parent_id) {
    const parent = byId.get(current.parent_id);
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    depth += 1;
    current = parent;
  }
  return depth;
}

/** Раскрытие подраздела: повторный клик по тому же пункту закрывает его. */
export function toggleExpanded(current: string | null, id: string): string | null {
  return current === id ? null : id;
}
