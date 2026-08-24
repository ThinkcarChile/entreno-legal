import type { HouseholdRole, RolePermissions } from "./types";

// Roles semilla creados por app.create_household (supabase/migrations/0001_family.sql).
// Mantener en sincronía con la migración.
export const DEFAULT_ROLES: HouseholdRole[] = [
  {
    code: "ADMIN",
    name: "Administrador familiar",
    isAdmin: true,
    canManageMembers: true,
    canEditPlan: true,
    canManageShopping: true,
    canCook: true,
  },
  {
    code: "MEMBER",
    name: "Integrante",
    isAdmin: false,
    canManageMembers: false,
    canEditPlan: false,
    canManageShopping: false,
    canCook: false,
  },
  {
    code: "PLANNER",
    name: "Planificador",
    isAdmin: false,
    canManageMembers: false,
    canEditPlan: true,
    canManageShopping: false,
    canCook: false,
  },
  {
    code: "SHOPPER",
    name: "Comprador",
    isAdmin: false,
    canManageMembers: false,
    canEditPlan: false,
    canManageShopping: true,
    canCook: false,
  },
  {
    code: "COOK",
    name: "Cocinero",
    isAdmin: false,
    canManageMembers: false,
    canEditPlan: false,
    canManageShopping: false,
    canCook: true,
  },
];

const NO_PERMISSIONS: RolePermissions = {
  isAdmin: false,
  canManageMembers: false,
  canEditPlan: false,
  canManageShopping: false,
  canCook: false,
};

/** Una persona puede tener varios roles: sus permisos son la unión. */
export function resolvePermissions(roles: readonly RolePermissions[]): RolePermissions {
  return roles.reduce<RolePermissions>(
    (acc, role) => ({
      isAdmin: acc.isAdmin || role.isAdmin,
      canManageMembers: acc.canManageMembers || role.canManageMembers,
      canEditPlan: acc.canEditPlan || role.canEditPlan,
      canManageShopping: acc.canManageShopping || role.canManageShopping,
      canCook: acc.canCook || role.canCook,
    }),
    { ...NO_PERMISSIONS },
  );
}
