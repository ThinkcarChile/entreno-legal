export interface RolePermissions {
  isAdmin: boolean;
  canManageMembers: boolean;
  canEditPlan: boolean;
  canManageShopping: boolean;
  canCook: boolean;
}

export type RoleCode = "ADMIN" | "MEMBER" | "PLANNER" | "SHOPPER" | "COOK";

export interface HouseholdRole extends RolePermissions {
  code: RoleCode;
  name: string;
}

export interface MemberSummary {
  id: string;
  displayName: string;
  hasAccount: boolean;
  isActive: boolean;
  roleCodes: RoleCode[];
}
