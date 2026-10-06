export interface Principal { tenantId: string; agentId: string }

export const DEFAULT_PRINCIPAL: Principal = Object.freeze({ tenantId: "default", agentId: "default" });

export function validatePrincipal(value: unknown): Principal {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid principal");
  const { tenantId, agentId } = value as Record<string, unknown>;
  if (typeof tenantId !== "string" || typeof agentId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(tenantId) || !/^[A-Za-z0-9_-]{1,64}$/.test(agentId)) throw new Error("Invalid principal");
  return Object.freeze({ tenantId, agentId });
}
