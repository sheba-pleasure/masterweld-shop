import { describe, expect, it } from "vitest";

import {
  MAX_NAV_DEPTH,
  buildCategoryTree,
  navDepth,
  toggleExpanded,
  type CategoryLike,
} from "@/lib/nav";

const c = (
  id: string,
  name: string,
  parent_id: string | null,
  sort_order: number,
): CategoryLike => ({
  id,
  slug: id,
  name,
  parent_id,
  sort_order,
});

const cats: CategoryLike[] = [
  c("g1", "Сварка", null, 2),
  c("t1", "Горелки", "g1", 1),
  c("t2", "Маски", "g1", 2),
  c("a1", "Аппараты", null, 1),
  c("a2", "Электроды", "a1", 1),
  c("x1", "Сирота", "missing", 1), // родителя нет — в дерево не попадает
];

describe("buildCategoryTree", () => {
  it("строит два уровня: верхние категории по порядку и их подразделы", () => {
    const tree = buildCategoryTree(cats);
    expect(tree.map((t) => t.category.id)).toEqual(["a1", "g1"]);
    expect(tree[0]?.children.map((s) => s.id)).toEqual(["a2"]);
    expect(tree[1]?.children.map((s) => s.id)).toEqual(["t1", "t2"]);
  });

  it("не включает категорию с несуществующим родителем", () => {
    const tree = buildCategoryTree(cats);
    const ids = tree.flatMap((t) => [t.category.id, ...t.children.map((s) => s.id)]);
    expect(ids).not.toContain("x1");
  });

  it("глубина дерева не превышает двух уровней", () => {
    const tree = buildCategoryTree(cats);
    const byId = new Map(cats.map((x) => [x.id, x]));
    const depths = tree.flatMap((t) => [t.category, ...t.children]).map((x) => navDepth(x, byId));
    expect(Math.max(...depths)).toBe(MAX_NAV_DEPTH);
  });
});

describe("navDepth", () => {
  it("верхний уровень — 1, подраздел — 2", () => {
    const byId = new Map(cats.map((x) => [x.id, x]));
    expect(navDepth(cats[0]!, byId)).toBe(1);
    expect(navDepth(cats[1]!, byId)).toBe(2);
  });
});

describe("toggleExpanded", () => {
  it("раскрывает новый подраздел и закрывает текущий при повторном клике", () => {
    expect(toggleExpanded(null, "g1")).toBe("g1");
    expect(toggleExpanded("g1", "g1")).toBeNull();
    expect(toggleExpanded("g1", "a1")).toBe("a1");
  });
});
