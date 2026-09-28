import type { Env, Unit } from "../types";

/**
 * The Data Source Registry (ENIG Operating Model design doc, "Platform
 * layer" -- Stage 1 of the confirmed build order). Declares, once, which
 * Units may read/write each of Runtime's data sources -- resolving the
 * doc's own open question about dataLookup.ts's cross-Unit sources
 * (Handoffs/Activity Log are inherently cross-Unit) without a pseudo-Unit:
 * a data source's eligibility is just a fact declared here, checked by
 * read_record/write_record (see primitives.ts), not owned by any Unit's
 * import structure.
 *
 * Handoff's Entity_Token/Matter_Token-only identity boundary is a rule
 * declared on the *resource* (see its own description below), enforced in
 * `handoffWriter.ts`'s createHandoff/updateHandoff -- write_record must
 * route Handoffs writes through those functions, never a plain field
 * update, exactly as it already does before this registry existed.
 *
 * Grants below reflect what the codebase's own existing behavior already
 * does (Strategy advances Matter status at Handoff pickup, Finance/Sales
 * advance it at Proposal approval, only Sales resolves Lead->Prospect on
 * Entity) -- this registry documents and enforces facts already true in
 * production, not new policy invented here.
 */
export type DataSourceId = "matters" | "entities" | "handoffs" | "proposals" | "leads" | "activity";

type DataSourceEnvKey =
  | "MATTERS_DATA_SOURCE_ID"
  | "ENTITY_DATA_SOURCE_ID"
  | "HANDOFFS_DATA_SOURCE_ID"
  | "PROPOSALS_DATA_SOURCE_ID"
  | "LEADS_DATA_SOURCE_ID"
  | "ACTIVITY_LOG_DATA_SOURCE_ID";

export interface DataSourceDefinition {
  id: DataSourceId;
  /** Which env var holds this source's live Notion data source id. */
  envKey: DataSourceEnvKey;
  /** Units allowed to read this source through read_record. "all" means every Unit. */
  readableBy: readonly Unit[] | "all";
  /** Units allowed to write this source through write_record. Undefined means no write path is exposed through this registry (the source is read-only from a Hat's own pipeline; it may still be written by its own dedicated existing mechanism, e.g. Leads via leadDiscovery.ts, Activity Log via log.ts's logActivity). */
  writableBy?: readonly Unit[] | "all";
  description: string;
}

export const DATA_SOURCE_REGISTRY: Readonly<Record<DataSourceId, DataSourceDefinition>> = {
  matters: {
    id: "matters",
    envKey: "MATTERS_DATA_SOURCE_ID",
    readableBy: ["Sales", "Strategy", "Finance"],
    writableBy: ["Sales", "Strategy", "Finance"],
    description: "Pseudonymous Matter operational records -- no real identity fields at all (Sept 2026 identity architecture decision).",
  },
  entities: {
    id: "entities",
    envKey: "ENTITY_DATA_SOURCE_ID",
    readableBy: ["Sales", "Strategy", "Finance"],
    writableBy: ["Sales"],
    description: "Pseudonymous Entity operational records -- no real identity fields at all. Only Sales resolves the Lead->Prospect->Client lifecycle.",
  },
  handoffs: {
    id: "handoffs",
    envKey: "HANDOFFS_DATA_SOURCE_ID",
    readableBy: "all",
    writableBy: "all",
    description:
      "Cross-Unit Handoff records -- identity-safe by construction (Entity_Token/Matter_Token only). Every write MUST go through handoffWriter.ts's createHandoff/updateHandoff, never a plain field update -- write_record enforces this, not the caller.",
  },
  proposals: {
    id: "proposals",
    envKey: "PROPOSALS_DATA_SOURCE_ID",
    readableBy: ["Sales", "Finance"],
    writableBy: ["Sales"],
    description: "Token-safe commercial proposals (tokenSafeProposal.ts).",
  },
  leads: {
    id: "leads",
    envKey: "LEADS_DATA_SOURCE_ID",
    readableBy: ["Sales"],
    description:
      "Pre-qualification acquisition records -- carries real Contact/Organisation fields, but publicly-sourced business information, not confidential client identity (same exemption lead.discovery_signal_evaluation's existing policy already draws). No write path exposed here -- Leads are created by leadDiscovery.ts's own mechanism.",
  },
  activity: {
    id: "activity",
    envKey: "ACTIVITY_LOG_DATA_SOURCE_ID",
    readableBy: "all",
    description: "The Activity & Decision Log -- Runtime's own operational record. No write path exposed here -- entries are created by log.ts's logActivity.",
  },
};

export function getDataSource(id: DataSourceId): DataSourceDefinition {
  const def = DATA_SOURCE_REGISTRY[id];
  if (!def) {
    throw new Error(`getDataSource: "${id}" is not a registered data source.`);
  }
  return def;
}

export function canRead(id: DataSourceId, unit: Unit): boolean {
  const def = getDataSource(id);
  return def.readableBy === "all" || def.readableBy.includes(unit);
}

export function canWrite(id: DataSourceId, unit: Unit): boolean {
  const def = getDataSource(id);
  if (!def.writableBy) return false;
  return def.writableBy === "all" || def.writableBy.includes(unit);
}

/** Resolves a data source's configured live Notion data source id from env, failing closed (never undefined silently passed downstream) if it isn't configured. */
export function resolveDataSourceEnvId(env: Env, id: DataSourceId): string {
  const def = getDataSource(id);
  const value = env[def.envKey];
  if (!value) {
    throw new Error(`resolveDataSourceEnvId: ${def.envKey} is not configured.`);
  }
  return value;
}
