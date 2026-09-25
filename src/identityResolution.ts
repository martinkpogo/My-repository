import type { Env } from "./types";
import { getPage, plainText, queryDataSource, uniqueId } from "./notion";
import { ENIG_TOKEN_PATTERN } from "./ai/outboundGate";

export interface ResolvedMatterIdentity {
  matterToken: string;
  entityToken: string;
}

export interface ResolvedEntityMatterIdentity {
  entityId: string;
  entityName: string;
  matterId: string;
  matterName: string;
}

/**
 * Deterministically resolves an existing Matter from an ENIG token
 * (e.g. "MAT-20") found in free text -- never AI-guessed, per the Handoff
 * identity-write boundary's discipline that identity resolution stays
 * deterministic. Shared by every Unit's own direct_request origination
 * path (see strategyAnalyst.ts's handleDirectRequest,
 * valueBasedPricingAssessor.ts's handleDirectRequest) so a second Unit
 * calls this directly rather than reimplementing token resolution.
 * Returns null if no token is found, or the token doesn't resolve to a
 * real, existing Matter with a related Entity -- both are fail-closed,
 * never a guess at which Matter was meant.
 */
export async function resolveMatterFromText(env: Env, text: string): Promise<ResolvedMatterIdentity | null> {
  const tokenMatches = text.match(ENIG_TOKEN_PATTERN);
  const candidateToken = tokenMatches?.[0];
  if (!candidateToken) return null;

  const tokenShape = /^([A-Z]{1,6})-(\d{1,6})$/.exec(candidateToken);
  if (!tokenShape) return null;
  const number = Number(tokenShape[2]);

  const candidates = await queryDataSource(env, env.MATTERS_DATA_SOURCE_ID, {
    property: "Matter_ID",
    unique_id: { equals: number },
  });
  const matter = candidates.find((m) => uniqueId(m.properties.Matter_ID) === candidateToken);
  if (!matter) return null;

  const entityId = matter.properties.Entity?.relation?.[0]?.id;
  if (!entityId) return null;
  const entity = await getPage(env, entityId);
  const entityToken = uniqueId(entity.properties["Entity ID"]);
  if (!entityToken) return null;

  return { matterToken: candidateToken, entityToken };
}

/**
 * The reverse of resolveIdentityTokens (salesExecutive.ts): given an
 * Entity_Token/Matter_Token pair already on record (e.g. read from a
 * Handoff's own fields, which per the identity-write boundary only ever
 * carry tokens, never real identity), deterministically resolves the real
 * Entity/Matter id and name -- authority Sales already has (it originally
 * minted these same tokens from real identity), just re-derived for a
 * WorkState that doesn't already have it in memory (e.g. a fresh pickup
 * with no continuing session -- see handleQuoteReceived). Same fail-closed
 * discipline as resolveMatterFromText: returns null rather than guessing
 * if either token doesn't resolve to a real, existing record.
 */
export async function resolveEntityMatterFromTokens(
  env: Env,
  entityToken: string,
  matterToken: string,
): Promise<ResolvedEntityMatterIdentity | null> {
  const entityShape = /^([A-Z]{1,6})-(\d{1,6})$/.exec(entityToken);
  const matterShape = /^([A-Z]{1,6})-(\d{1,6})$/.exec(matterToken);
  if (!entityShape || !matterShape) return null;

  const entityCandidates = await queryDataSource(env, env.ENTITY_DATA_SOURCE_ID, {
    property: "Entity ID",
    unique_id: { equals: Number(entityShape[2]) },
  });
  const entity = entityCandidates.find((e) => uniqueId(e.properties["Entity ID"]) === entityToken);
  if (!entity) return null;

  const matterCandidates = await queryDataSource(env, env.MATTERS_DATA_SOURCE_ID, {
    property: "Matter_ID",
    unique_id: { equals: Number(matterShape[2]) },
  });
  const matter = matterCandidates.find((m) => uniqueId(m.properties.Matter_ID) === matterToken);
  if (!matter) return null;

  return {
    entityId: entity.id,
    entityName: plainText(entity.properties.Name),
    matterId: matter.id,
    matterName: plainText(matter.properties.Matter),
  };
}
