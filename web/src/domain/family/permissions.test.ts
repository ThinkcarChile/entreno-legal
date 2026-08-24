import { describe, expect, it } from "vitest";
import { DEFAULT_ROLES, resolvePermissions } from "./permissions";

const role = (code: string) => {
  const found = DEFAULT_ROLES.find((r) => r.code === code);
  if (!found) throw new Error(`missing role ${code}`);
  return found;
};

describe("resolvePermissions", () => {
  it("sin roles no otorga ningún permiso", () => {
    const p = resolvePermissions([]);
    expect(p).toEqual({
      isAdmin: false,
      canManageMembers: false,
      canEditPlan: false,
      canManageShopping: false,
      canCook: false,
    });
  });

  it("varios roles se combinan por unión (planificador + cocinero)", () => {
    const p = resolvePermissions([role("PLANNER"), role("COOK")]);
    expect(p.canEditPlan).toBe(true);
    expect(p.canCook).toBe(true);
    expect(p.canManageShopping).toBe(false);
    expect(p.isAdmin).toBe(false);
  });

  it("admin otorga todos los permisos", () => {
    const p = resolvePermissions([role("ADMIN")]);
    expect(Object.values(p).every(Boolean)).toBe(true);
  });

  it("MEMBER no gestiona hogar", () => {
    const p = resolvePermissions([role("MEMBER")]);
    expect(p.canManageMembers).toBe(false);
  });
});
