import type { Env } from "../types";
import { isWebSearchConfigured } from "../units/research/webSearch";

/**
 * The Connector Registry (ENIG Operating Model design doc, "Platform
 * layer" -- Stage 1 of the confirmed build order). Generalizes
 * `ai/policy.ts`'s `AiProvider` shape (`isEligible`, a shared pool no
 * Unit owns) beyond AI calls, to external services a pipeline may need.
 *
 * Unlike AI providers, external services are not interchangeable behind
 * one uniform call shape (a Notion query and a Telegram send are nothing
 * alike) -- this registry is deliberately *not* a forced common
 * `execute()` interface across all of them, which would be the wrong
 * abstraction. Its real job is eligibility/discoverability: a pipeline
 * (or a future connector addition) checks `isConnectorEligible` before
 * relying on a capability, and the underlying primitive (read_record,
 * write_record, fetch_skill, search, request_approval) calls the actual
 * existing, already-battle-tested function directly (queryDataSource,
 * createHandoff/updateHandoff, getGovernance, searchWeb, sendHatMessage)
 * rather than through a new indirection layer that would only duplicate
 * logic those functions already get right.
 */
export type ConnectorId = "notion" | "telegram" | "web_search" | "google_workspace";

export interface ConnectorDefinition {
  id: ConnectorId;
  description: string;
  isEligible(env: Env): boolean;
}

export const CONNECTOR_REGISTRY: Readonly<Record<ConnectorId, ConnectorDefinition>> = {
  notion: {
    id: "notion",
    description: "ENIG's Notion workspace -- Business Objects, Handoffs, governance pages. Backs read_record/write_record/fetch_skill.",
    isEligible: (env) => Boolean(env.NOTION_TOKEN),
  },
  telegram: {
    id: "telegram",
    description: "The ENIG HQ Supergroup and DMs -- backs request_approval and every Hat-originated message.",
    isEligible: (env) => Boolean(env.TELEGRAM_BOT_TOKEN),
  },
  web_search: {
    id: "web_search",
    description: "Tavily web search -- backs the search primitive. Optional: unset TAVILY_API_KEY means search is unavailable, not misconfigured.",
    isEligible: (env) => isWebSearchConfigured(env),
  },
  google_workspace: {
    id: "google_workspace",
    description:
      "Google Docs/Sheets -- not yet wired to any primitive (see the stale Google Workspace OAuth foundation PR). Registered here as a placeholder so a future connector addition has a declared home instead of another hand-rolled integration.",
    isEligible: (env) => Boolean(env.GOOGLE_OAUTH_CLIENT_ID),
  },
};

export function getConnector(id: ConnectorId): ConnectorDefinition {
  const connector = CONNECTOR_REGISTRY[id];
  if (!connector) {
    throw new Error(`getConnector: "${id}" is not a registered connector.`);
  }
  return connector;
}

export function isConnectorEligible(env: Env, id: ConnectorId): boolean {
  return getConnector(id).isEligible(env);
}
