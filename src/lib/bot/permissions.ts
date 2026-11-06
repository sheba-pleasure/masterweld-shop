export type StaffRole = "admin" | "director" | "seller";
export interface StaffMember {
  telegram_id: number;
  name: string;
  role: StaffRole;
  elevated: boolean;
  active: boolean;
}

export type Permission =
  | "edit_products"
  | "upload_photos"
  | "edit_stock"
  | "manage_orders"
  | "manage_b2b_leads"
  | "view_costs"
  | "edit_prices"
  | "delete_items"
  | "manage_assortment"
  | "manage_categories"
  | "publish_products"
  | "import_prices"
  | "manage_staff"
  | "view_audit"
  | "toggle_full_access";

const ADMIN: Permission[] = [
  "manage_b2b_leads",
  "edit_products",
  "upload_photos",
  "edit_stock",
  "manage_orders",
  "view_costs",
  "edit_prices",
  "delete_items",
  "manage_assortment",
  "manage_categories",
  "publish_products",
  "import_prices",
  "manage_staff",
  "view_audit",
];
const DIRECTOR: Permission[] = [
  "manage_b2b_leads",
  "manage_orders",
  "view_costs",
  "edit_prices",
  "edit_stock",
  "toggle_full_access",
];
const SELLER: Permission[] = [
  "edit_products",
  "upload_photos",
  "edit_stock",
  "manage_orders",
  "view_costs",
];

/** Типы действий с фото: все требуют upload_photos; права продавца не расширяются. */
export const PENDING_PERMISSION_PHOTO_KINDS = {
  photo_main: "upload_photos",
  photo_reorder: "upload_photos",
  photo_delete: "upload_photos",
} as const satisfies Record<string, Permission>;

export function permissionsFor(m: StaffMember | null | undefined): Set<Permission> {
  if (!m || !m.active) return new Set();
  if (m.role === "admin") return new Set(ADMIN);
  if (m.role === "director")
    return new Set(m.elevated ? [...ADMIN, "toggle_full_access"] : DIRECTOR);
  return new Set(m.role === "seller" ? SELLER : []);
}

export function can(m: StaffMember | null | undefined, p: Permission): boolean {
  return permissionsFor(m).has(p);
}
