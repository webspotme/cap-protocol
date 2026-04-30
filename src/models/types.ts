/**
 * cap-protocol — TypeScript types for the Resource and Event records.
 * See SPEC.md §2 (RSPL) and §3 (SEPL).
 */

export const RESOURCE_SCHEMA_VERSION = 1 as const;
export const EVENT_SCHEMA_VERSION = 1 as const;

export type LifecycleStateName =
  | 'proposed'
  | 'registered'
  | 'verified'
  | 'active'
  | 'degraded'
  | 'recovered'
  | 'deprecated'
  | 'archived'
  | 'rejected';

export type Health = 'green' | 'yellow' | 'red';

export type SideEffect =
  | 'none'
  | 'read-only'
  | 'writes-local'
  | 'writes-remote'
  | 'irreversible';

export interface ResourceState {
  current: LifecycleStateName;
  since: string; // ISO-8601
  health: Health;
  last_verified?: string | null;
  verifier?: string | null;
}

export interface ResourceLifecycle {
  proposed_by: string;
  proposed_at: string;
  registered_at?: string | null;
  verified_at?: string | null;
  activated_at?: string | null;
  deprecated_at?: string | null;
  archived_at?: string | null;
}

export interface ResourceInterface {
  inputs?: Record<string, unknown>;
  outputs?: unknown;
  side_effects?: SideEffect;
}

export interface ResourceConstraints {
  HARD?: string | null;
  rate_limit?: string | null;
  account_lock?: string | null;
}

export interface ResourceProvenance {
  added_by?: string;
  evidence?: string;
}

export interface ResourceRelated {
  composes_with?: string[];
  superseded_by?: string | null;
  supersedes?: string | null;
}

export interface Resource {
  cap_id: string;
  schema_version: typeof RESOURCE_SCHEMA_VERSION;
  layer: string;
  source: string;
  what: string;
  account: string;
  state: ResourceState;
  lifecycle: ResourceLifecycle;
  version: string; // semver
  interface?: ResourceInterface;
  constraints?: ResourceConstraints;
  provenance?: ResourceProvenance;
  related?: ResourceRelated;
  tags?: string[];
}

export type EventPhase = 'propose' | 'assess' | 'commit' | 'rollback' | 'gc';
export type EventResult = 'pass' | 'fail' | 'warn';

export interface EventDelta {
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export interface EventTrace {
  validator_run_id?: string;
  evidence_files?: string[];
  notes?: string;
}

export interface CapEvent {
  event_id: string;
  schema_version: typeof EVENT_SCHEMA_VERSION;
  cap_id: string;
  operator: string;
  phase: EventPhase;
  result: EventResult;
  delta: EventDelta;
  trace?: EventTrace;
  auditable: boolean;
  parent_event?: string | null;
  timestamp?: string;
}

/**
 * Allowed lifecycle transitions. See SPEC §2.4.
 * The map encodes valid edges in the FSM. `null` means terminal-from this state.
 */
export const ALLOWED_TRANSITIONS: Record<LifecycleStateName, readonly LifecycleStateName[]> = {
  proposed: ['registered', 'rejected'],
  registered: ['verified', 'rejected'],
  verified: ['active', 'rejected'],
  active: ['degraded', 'deprecated'],
  degraded: ['recovered', 'deprecated'],
  recovered: ['active'],
  deprecated: ['archived', 'active'], // un-deprecate is allowed (rollback case)
  archived: [],
  rejected: [],
} as const;
