import type { Env } from "./types";
import { getPage, queryDataSource, uniqueId } from "./notion";
import { ENIG_TOKEN_PATTERN } from "./ai/outboundGate";

export interface ResolvedMatterIdentity {
  matterToken: string;
  entityToken: string;
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
  const entityToken = uniqueId(entity.properties.Entity_ID);
  if (!entityToken) return null;

  return { matterToken: candidateToken, entityToken };
}

export interface ResolvedEntityMatterIdentity {
  entityId: string;
  matterId: string;
}

/**
 * Resolves the real Entity/Matter page IDs behind a Handoff's own
 * Entity_Token/Matter_Token. Authorized by the identity architecture
 * decision recorded in Notion (Sept 2026): real-world identity now lives
 * exclusively in the separate Identity Resolution Registry, which Runtime
 * never touches; the operational Entity/Matter records themselves no
 * longer carry any real-world identity fields at all (Name/Email/Phone
 * were removed from the Entity schema), so resolving a token to its
 * operational record is no longer a boundary crossing -- unlike
 * resolveMatterFromText above, which starts from a token found in free
 * text, this starts from a token already known to be authoritative
 * (carried on a Handoff record) and resolves to the real page IDs a
 * caller needs to read/write the operational record or a related
 * Proposal. Matches strictly by the token's own unique_id number, then
 * confirms the related Entity carries the exact same token -- never a
 * name/fuzzy match. Returns null if either token doesn't resolve to a
 * real, existing, correctly-related record -- fail closed, never a guess.
 */
export async function resolveEntityMatterFromTokens(
  env: Env,
  entityToken: string,
  matterToken: string,
): Promise<ResolvedEntityMatterIdentity | null> {
  const matterShape = /^([A-Z]{1,6})-(\d{1,6})$/.exec(matterToken);
  if (!matterShape) return null;
  const matterNumber = Number(matterShape[2]);

  const candidates = await queryDataSource(env, env.MATTERS_DATA_SOURCE_ID, {
    property: "Matter_ID",
    unique_id: { equals: matterNumber },
  });
  const matter = candidates.find((m) => uniqueId(m.properties.Matter_ID) === matterToken);
  if (!matter) return null;

  const entityId = matter.properties.Entity?.relation?.[0]?.id;
  if (!entityId) return null;

  const entity = await getPage(env, entityId);
  if (uniqueId(entity.properties.Entity_ID) !== entityToken) return null;

  return { entityId, matterId: matter.id };
}
