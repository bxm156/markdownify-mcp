/**
 * Job ownership. A principal is a (tenant, agent) pair of IDs of 1 to 64 characters from [A-Za-z0-9_-]. The restricted
 * alphabet keeps IDs safe to write into audit records and makes the newline in quotaKey an unambiguous separator.
 */

/** The owner of a job: a job is visible only to the exact (tenantId, agentId) that created it. */
export interface Principal { tenantId: string; agentId: string }

/** The owner used in single-key (MD_API_KEY) mode. */
export const DEFAULT_PRINCIPAL: Principal = Object.freeze({ tenantId: "default", agentId: "default" });

/** A frozen copy of a valid principal (other properties dropped); otherwise throws "Invalid principal". */
export function validatePrincipal(value: unknown): Principal {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid principal");
  const { tenantId, agentId } = value as Record<string, unknown>;
  if (typeof tenantId !== "string" || typeof agentId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(tenantId) || !/^[A-Za-z0-9_-]{1,64}$/.test(agentId)) throw new Error("Invalid principal");
  return Object.freeze({ tenantId, agentId });
}

/** Operator-configured agent-scope caps for one principal; absent fields keep the configured defaults. */
export type QuotaOverride = { maxJobs?: number; maxStorageBytes?: number; maxConcurrency?: number };
/** Map key for per-principal quota overrides. */
export const quotaKey = (principal: Principal) => `${principal.tenantId}\n${principal.agentId}`;
