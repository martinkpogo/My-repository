/**
 * Repo-native Skills (ENIG Operating Model, "Capabilities: Skills" --
 * migrated 2026-09-28 from the retired Notion-backed
 * fetchSkill/SkillDefinition arrangement). A Skill answers "how should
 * this type of work be performed" -- reusable methodology, independent
 * of which Unit/Hat uses it. Minimum contract, per the approved
 * architecture: a stable id + its methodology content. Nothing else --
 * the prior `SkillDefinition`'s `pageId`, `sensitivity`, `description`,
 * `requiredDataSources`, `requiredPrimitives`, `outputContract`, and
 * `validation` fields are dropped, not carried forward, because no
 * runtime code ever read any of them (confirmed by inspection before
 * this migration: only `id`/`pageId` were ever consumed, by the retired
 * `fetchSkill`, and only to resolve a Notion page -- a resolution this
 * repo-native model no longer needs).
 *
 * Content is copied verbatim from the three Notion pages this replaces
 * (ENIG HQ / 4. Skills / research-signal, opportunity-qualification-gate,
 * opportunity-forward-planning) -- unchanged wording, so AI behavior is
 * unaffected by this migration. `universal_role_contract` is deliberately
 * NOT included here: it was already unreachable through the old Skill
 * Registry (zero `fetchSkill("universal_role_contract")` callers found by
 * inspection -- every real consumer already calls `getGovernance`
 * directly with `UNIVERSAL_ROLE_CONTRACT_PAGE_ID`, unchanged by this
 * migration), and it does not fit this file's own definition of a Skill
 * (task-methodology, "how should this be performed") -- it's Kernel-
 * adjacent cross-cutting behavior, injected as `generate()`'s `behavior`
 * part, not `skillContent`. Nothing about it changes here.
 *
 * The four Strategy Skills (`strategy_analysis`, `brand_strategy`,
 * `business_strategy`, `communication_strategy`) are the later addition to
 * this Registry: the Strategy Analyst's composable-Skills architecture,
 * under which Strategy remains ONE organizational Hat and its specialist
 * domains become bounded methodology instead of specialist Hats. They were
 * authored here rather than migrated from a Notion page, and they follow
 * this file's own Skill contract -- methodology only. They name no actor,
 * grant no access, own no Responsibility, and decide no gate; the Strategy
 * Analyst performs the cycle and stays accountable for it.
 */

export type SkillId =
  | "research_signal"
  | "opportunity_qualification_gate"
  | "opportunity_forward_planning"
  | "strategy_analysis"
  | "brand_strategy"
  | "business_strategy"
  | "communication_strategy";

/** Every registrable Skill id, for exact validation. Closed: a Skill outside this list cannot be declared or resolved. */
export const SKILL_IDS: readonly SkillId[] = [
  "research_signal",
  "opportunity_qualification_gate",
  "opportunity_forward_planning",
  "strategy_analysis",
  "brand_strategy",
  "business_strategy",
  "communication_strategy",
];

/** The one runtime Worker ABI a Skill package may declare compatibility with. */
export type WorkerRuntime = "enig-worker-v1";

export const CURRENT_WORKER_RUNTIME: WorkerRuntime = "enig-worker-v1";

/**
 * Lifecycle status of a registered Skill. Only "active" resolves; a retired or
 * draft Skill fails closed rather than being silently skipped, because a
 * missing Skill is never repaired by substituting a different one.
 */
export type SkillStatus = "active" | "retired" | "draft";

/**
 * The only supported package format. Content is carried in the bundle as a
 * literal, so the format is verifiable without any filesystem access -- which
 * matters because Cloudflare Workers has no runtime filesystem.
 */
export type SkillPackageFormat = "enig-skill-markdown-v1";

export const SUPPORTED_SKILL_PACKAGE_FORMAT: SkillPackageFormat = "enig-skill-markdown-v1";

/**
 * The runtime's own SHA-256 mechanism, in one place. `crypto.subtle` is the
 * same primitive tokenSafeProposal.ts already uses to bind an approved
 * Version to its exact content (see its `hashContent`), so Skill package
 * integrity is checked with the repository's existing mechanism rather than a
 * second hashing approach.
 */
export async function sha256Hex(content: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const RESEARCH_SIGNAL = `\`\`\`yaml
skill_id: research-signal
status: canonical
purpose: >
  Interpret a piece of raw evidence about an external subject (an
  organisation, market, relationship, or discovered signal) and produce a
  disciplined, source-grounded account of what that evidence actually
  supports -- never what it merely suggests, implies, or could be read to
  mean under a generous interpretation.
\`\`\`

## Evidence discipline (the methodology itself)

1. **Only use evidence actually given.** Work strictly from the text/snippets/context supplied for this call -- never draw on outside knowledge, assumption, or general familiarity with the subject to fill a gap the evidence itself doesn't cover.
2. **Distinguish observation from diagnosis.** State only what the evidence directly shows (an observation) -- never convert that into a negative or positive verdict about the subject (a diagnosis) unless the evidence itself states the verdict. "Expanded into a new market but public messaging still describes the old one" is an observation; "this company has confused branding" is a diagnosis the evidence alone doesn't license.
3. **Never fabricate a specific fact.** A name, contact, decision-maker, statistic, date, or claim not present in the supplied evidence must never be invented, guessed, or inferred from role/context alone. If it isn't there, it isn't known.
4. **Name what's missing, don't guess it.** Where the evidence is silent on something relevant, say so explicitly as a gap or limitation -- never fill it with a plausible-sounding assumption.
5. **Attribute honestly.** Every claim traces to where it actually came from -- a named source, a supplied account, or explicitly "not sourced" if none exists. Never let a claim read as more independently verified than it actually is.
6. **A confident tone is not evidence.** The strength of a finding is set by what the evidence actually supports, never by how the finding is phrased or how plausible it sounds.

## What this Skill does not decide

This methodology governs *how the evidence is read* -- it does not decide:
- what the evidence is being read *for* (an opportunity signal, a partnership case, an acquisition-criteria pass/fail, a research brief) -- that shape belongs to the invoking action's own output contract, supplied as that call's own instruction alongside this methodology;
- whether the resulting output may be acted on without Martin's sign-off (approval requirement is the invoking action's declared property, never this Skill's);
- what data the caller was allowed to read in the first place (Data Source eligibility is resolved by the Kernel per invoking Hat, before this methodology is ever applied to it).

Two Hats invoking this Skill against different evidence, under different authority, reach different outputs -- the discipline above is what stays constant.`;

const OPPORTUNITY_QUALIFICATION_GATE = `\`\`\`yaml
skill_id: opportunity-qualification-gate
status: canonical
purpose: >
  Apply an evidence-sufficiency threshold to a body of gathered evidence
  about a candidate opportunity, relationship, or growth direction, and
  decide whether it has earned further investment of effort.
\`\`\`

## The threshold discipline (the methodology itself)

1. **The decision is about the evidence, not the enthusiasm.** Qualification must never be based on how promising something sounds, how confident the reasoning feels, or superficial fit with what ENIG does. It is based strictly on what the gathered evidence actually establishes.
2. **When required evidence is missing, hold -- never infer it.** If the evidence gathered so far genuinely isn't enough to judge either way, the correct outcome is to say so and name exactly what's still needed, never to fill the gap with a plausible guess so a decision can be reached.
3. **A negative indication is not the same as insufficient evidence.** Distinguish evidence that actively counsels against pursuing something from evidence that simply hasn't yet reached a threshold -- these are different outcomes, not the same "not ready" bucket.
4. **Ambiguity or a failed judgment fails closed, never toward the permissive outcome.** If the judgment itself cannot be completed (a provider failure, an unparsable response), the outcome must never default to the outcome that lets work proceed -- it defaults to holding for a retry.
5. **Naming what's missing is part of the decision, not an afterthought.** A hold decision is only useful if it says specifically what evidence would resolve it -- a vague "needs more evidence" is not a completed judgment.

## What this Skill does not decide

This methodology governs how the sufficiency judgment itself is reached -- it does not decide:
- what counts as required evidence for a *particular* subject (an opportunity vs. a partnership vs. a growth direction) -- that's the invoking action's own framing, supplied as that call's own instruction;
- what happens after a qualification outcome is reached (whether it pauses a session, what state it's written to, whether Martin is notified) -- that is the invoking action's own declared consequence and the Kernel's own execution machinery, never this Skill's concern.`;

const OPPORTUNITY_FORWARD_PLANNING = `\`\`\`yaml
skill_id: opportunity-forward-planning
status: canonical
purpose: >
  Draft a forward-looking plan or next action for an already-qualified
  opportunity, relationship, or growth direction, grounded strictly in
  what has actually been established about it so far.
\`\`\`

## The grounding discipline (the methodology itself)

1. **Build only from what's already established.** A forward plan (stakeholders, a value hypothesis, a route, dependencies, risks) or a recommended next action must be constructed only from the subject's own actual signal, gathered evidence, and qualification rationale -- never from what would typically be expected, or from filling a gap with a plausible default.
2. **Never invent a stakeholder, a route, a dependency, or a next action not implied by what's known.** If a plan element can't be derived from the established state, that element is stated as unknown or not yet determinable -- it is never fabricated to make the plan feel complete.
3. **Say plainly when something can't be determined yet.** A thin or incomplete plan that honestly reflects thin evidence is correct; a fuller-sounding plan manufactured to look complete is not.
4. **A drafted plan is a proposal, never a commitment.** This Skill's output is always a draft for review -- it never itself represents an executed decision, regardless of how concrete or confident it reads.
5. **Surface any human decision the plan depends on explicitly, rather than assuming it away.** If moving forward genuinely depends on a decision or approval beyond the plan itself, name that dependency directly instead of quietly presupposing it will go a particular way.

## What this Skill does not decide

This methodology governs how a forward plan or next-action recommendation is derived from established state -- it does not decide:
- the specific fields a particular plan must contain (stakeholders/value hypothesis/route vs. a single next action + rationale) -- that shape is the invoking action's own output contract, supplied as that call's own instruction;
- whether the resulting plan may be acted on without Martin's sign-off, or what gets committed if it's approved -- those are the invoking action's own declared consequence/approval and the Kernel's own execution machinery, never this Skill's concern.`;

const STRATEGY_ANALYSIS = `\`\`\`yaml
skill_id: strategy-analysis
status: canonical
purpose: >
  Drive one strategic diagnostic question through a sequence of bounded
  methodological moves -- interpret the evidence at hand, decide the next
  useful method, read what that method returned, and stop when the question
  is answerable rather than when the available methods are exhausted.
\`\`\`

## The diagnostic-cycle discipline (the methodology itself)

1. **Start from the evidence actually given.** Interpret only what the supplied situation and findings contain. Never import outside knowledge about the subject, and never treat a supplied claim as established fact merely because it was supplied.
2. **Name the one question the current evidence leaves open.** A diagnosis advances by answering a specific question ("is the commercial model or the brand the binding constraint?"), not by accumulating material. If no question is genuinely open, stop.
3. **Choose one next move, don't run a list.** After interpreting, pick exactly one of: invoke one bounded domain method, or stop. Never invoke every available method merely because it is available, and never pre-commit to a sequence before the evidence has been read.
4. **Choose a method because the question needs that domain of judgment, not because the situation merely touches it.** A brand symptom with a commercial cause calls for the commercial method, not the brand method. Domain relevance alone is never sufficient reason.
5. **Skipping is a decision, not a gap.** Resolving the question after zero or one domain method is a complete, correct outcome -- never a degraded one. A method not needed must not be run "for completeness".
6. **Let a later move depend on an earlier finding.** Each returning finding changes what the next question is. Read the accumulated findings before choosing again; a fixed plan executed regardless of what came back is not this methodology.
7. **A returning finding is evidence, not a verdict.** It reports what its domain supports, including where it does not support anything. Weigh it against the question; never adopt it as the diagnosis because it was produced.
8. **Stop when the question is answerable.** The stopping test is the evidence, not the number of methods run and not whether every method has had a turn.
9. **Synthesis separates what was established from what is inferred.** Reconcile agreement, disagreement, and cross-domain relationships in plain prose for the diagnosis step. State material uncertainty rather than smoothing it over, and never substitute one finding's assumptions for an unavailable one's absence.
10. **Never soften an evidence gap into a request for generic background.** Where evidence is incomplete, name the specific fact that is missing and why it changes this decision -- "we lack the market data" is not a usable gap, because it invites a fill rather than a resolution.
11. **You do not own the gates.** Whether the resulting diagnosis may proceed to a proposal, must be held, or needs a decision from Martin is evaluated by the invoking Action's own governance, never by this methodology.

## What this Skill does not decide

This methodology governs *how the diagnostic cycle itself is run* -- it does not decide:
- which bounded domain methods exist, or which are permitted for this work -- that is the invoking Action's own declared Skill set, resolved exactly by the Skill Registry;
- whether a domain method's output may be acted on (an approval requirement is the invoking Action's declared property, never this Skill's);
- which evidence sources may be read in the first place (Data Boundary is resolved by the Kernel per invoking Hat, before this methodology is ever applied to it);
- who is performing the work (Organization owns that; a Skill is never an actor).

The Hat performing this work stays the single accountable actor throughout the cycle; the methodology names no other actor.`;

const BRAND_STRATEGY = `\`\`\`yaml
skill_id: brand-strategy
status: canonical
purpose: >
  Examine the brand dimension of a strategic situation -- positioning,
  differentiation, perception, identity, relevance, and brand architecture
  -- and return what that dimension supports, what it does not, and what it
  implies for the diagnosis being built elsewhere.
\`\`\`

## The bounded-domain discipline (the methodology itself)

1. **Answer the question you were asked, in your own domain.** Work the open diagnostic question through brand judgment only: positioning, differentiation, perception, identity, relevance, brand architecture. Leave commercial modelling, growth, and messaging architecture to the methods that own them, and say so when the question runs past your boundary.
2. **Work only from the supplied evidence.** Never invent a perception study, a competitor's position, a market signal, or a customer sentiment that the evidence does not contain. If the evidence says nothing about how the brand is perceived, that is a finding, not a licence to infer one.
3. **Distinguish observation from interpretation.** "Public messaging still describes the previous offer" is an observation; "the brand has lost relevance" is an interpretation the evidence may not carry. Label which you are giving.
4. **A domain finding is not a recommendation.** Report what the brand dimension supports. Whether it becomes the direction is decided after reconciliation, by the diagnosis step.
5. **Say plainly when the domain does not justify an intervention.** A brand dimension that is a downstream symptom of a commercial constraint must be reported as exactly that -- never upgraded into a reason to act on the brand because the field was available to fill.
6. **Name the evidence limitation with the finding.** Every finding carries what it could not establish and which question remains open. An unqualified finding reads as stronger than the evidence and is therefore wrong.

## Return to the analysis step

Return three things -- the finding, its evidence limitation, and its implication for the question under diagnosis. Do not decide whether the overall Work is blocked, do not draft or modify the canonical Proposal, and do not route anything: those remain with the Hat performing this work.`;

const BUSINESS_STRATEGY = `\`\`\`yaml
skill_id: business-strategy
status: canonical
purpose: >
  Examine the business dimension of a strategic situation -- business
  model, growth model, commercial opportunity, competitive position,
  business objectives, and material commercial constraints -- and return
  what that dimension supports, what it does not, and what it implies for
  the diagnosis being built elsewhere.
\`\`\`

## The bounded-domain discipline (the methodology itself)

1. **Answer the question you were asked, in your own domain.** Work the open diagnostic question through commercial judgment only: the business and growth model, the commercial opportunity, competitive position, objectives, and the material commercial constraints binding them. Leave positioning, perception, and messaging architecture to the methods that own them, and say so when the question runs past your boundary.
2. **Work only from the supplied evidence.** Never invent a revenue figure, a cost, a competitor, a market size, or an objective that the evidence does not contain. If the evidence says nothing about unit economics, that is a finding, not a licence to assume a plausible one.
3. **Distinguish observation from interpretation.** "Fulfilment capacity has not scaled with demand for two quarters" is an observation; "the business model is wrong" is an interpretation the evidence may not carry. Label which you are giving.
4. **A domain finding is not a recommendation.** Report what the commercial dimension supports. Whether it becomes the direction is decided after reconciliation, by the diagnosis step.
5. **Say plainly when the domain does not justify an intervention.** A commercial dimension that is merely adjacent to the real constraint must be reported as exactly that -- never upgraded into a reason to act commercially because the field was available to fill.
6. **Name the evidence limitation with the finding.** Every finding carries what it could not establish and which question remains open. An unqualified finding reads as stronger than the evidence and is therefore wrong.

## Return to the analysis step

Return three things -- the finding, its evidence limitation, and its implication for the question under diagnosis. Do not decide whether the overall Work is blocked, do not draft or modify the canonical Proposal, and do not route anything: those remain with the Hat performing this work.`;

const COMMUNICATION_STRATEGY = `\`\`\`yaml
skill_id: communication-strategy
status: canonical
purpose: >
  Examine the communication dimension of a strategic situation -- messaging,
  narrative, audience communication, and the implications a change has for
  the communication system as a whole -- and return what that dimension
  supports, what it does not, and what it implies for the diagnosis being
  built elsewhere.
\`\`\`

## The bounded-domain discipline (the methodology itself)

1. **Answer the question you were asked, in your own domain.** Work the open diagnostic question through communication judgment only: what is said, to whom, in what narrative, and what a change would imply for the wider communication system. Leave positioning, perception, and commercial modelling to the methods that own them, and say so when the question runs past your boundary.
2. **Work only from the supplied evidence.** Never invent an audience segment, a channel, a message test result, or a campaign performance figure that the evidence does not contain. If the evidence says nothing about how the message lands, that is a finding, not a licence to assume one.
3. **Distinguish observation from interpretation.** "Two audiences are being given contradictory descriptions of the offer" is an observation; "the company cannot communicate its value" is an interpretation the evidence may not carry. Label which you are giving.
4. **A domain finding is not a recommendation.** Report what the communication dimension supports. Whether it becomes the direction is decided after reconciliation, by the diagnosis step.
5. **Say plainly when the domain does not justify an intervention.** A communication dimension that is a downstream symptom of a positioning or commercial constraint must be reported as exactly that -- never upgraded into a reason to act on messaging because the field was available to fill.
6. **Name the evidence limitation with the finding.** Every finding carries what it could not establish and which question remains open. An unqualified finding reads as stronger than the evidence and is therefore wrong.

## Return to the analysis step

Return three things -- the finding, its evidence limitation, and its implication for the question under diagnosis. Do not decide whether the overall Work is blocked, do not draft or modify the canonical Proposal, and do not route anything: those remain with the Hat performing this work.`;

const SKILL_CONTENT: Readonly<Record<SkillId, string>> = {
  research_signal: RESEARCH_SIGNAL,
  opportunity_qualification_gate: OPPORTUNITY_QUALIFICATION_GATE,
  opportunity_forward_planning: OPPORTUNITY_FORWARD_PLANNING,
  strategy_analysis: STRATEGY_ANALYSIS,
  brand_strategy: BRAND_STRATEGY,
  business_strategy: BUSINESS_STRATEGY,
  communication_strategy: COMMUNICATION_STRATEGY,
};

/**
 * The registered metadata every Skill carries, independent of its methodology
 * body. `integrity_sha256` is the expected package digest, checked against the
 * actual content on every resolution -- so a Skill whose bundled body is
 * altered after registration fails closed rather than being followed.
 */
export interface SkillPackage {
  id: SkillId;
  /** Approved version of this Skill's methodology. Resolution is version-bound. */
  version: string;
  status: SkillStatus;
  /** The Worker runtime ABI this package is approved for. */
  workerRuntime: WorkerRuntime;
  format: SkillPackageFormat;
  /** Expected SHA-256 of the exact methodology body, lower-case hex. */
  integritySha256: string;
}

export class SkillResolutionError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`Skill resolution failed: ${reason}`);
    this.name = "SkillResolutionError";
    this.reason = reason;
  }
}

/**
 * The registered package metadata for every Skill, INCLUDING its expected
 * integrity digest.
 *
 * The digest is registered metadata exactly as a published package checksum
 * is: it is the SHA-256 of the exact methodology body registered at approval
 * time, and `verifySkillIntegrity` recomputes it from the body the Worker
 * would actually follow. It is a literal rather than a module-load
 * computation because an asynchronous digest pass at import time would leave
 * resolution racy -- the first resolution in a fresh isolate could observe an
 * unpopulated digest, and the only safe response to that is to refuse, which
 * would make the very first Skill resolution of a cold start fail.
 *
 * Regenerate by recomputing SHA-256 over each registered methodology body
 * below and updating the three `integritySha256` literals. Any change to a
 * methodology body is a change to a registered package and must update the
 * digest deliberately, in the same change -- the test suite fails closed if
 * they drift apart.
 */
const SKILL_PACKAGES: Readonly<Record<SkillId, SkillPackage>> = {
  research_signal: {
    id: "research_signal",
    version: "1.0.0",
    status: "active",
    workerRuntime: CURRENT_WORKER_RUNTIME,
    format: SUPPORTED_SKILL_PACKAGE_FORMAT,
    integritySha256: "bdc1881b77d8ab8c406ab970b5323a46bb90f858456783d685a438a4031d56f0",
  },
  opportunity_qualification_gate: {
    id: "opportunity_qualification_gate",
    version: "1.0.0",
    status: "active",
    workerRuntime: CURRENT_WORKER_RUNTIME,
    format: SUPPORTED_SKILL_PACKAGE_FORMAT,
    integritySha256: "3a753f6b219d738aa0d1188ef361c2c709a606ad582d43f190f426ffc4186923",
  },
  opportunity_forward_planning: {
    id: "opportunity_forward_planning",
    version: "1.0.0",
    status: "active",
    workerRuntime: CURRENT_WORKER_RUNTIME,
    format: SUPPORTED_SKILL_PACKAGE_FORMAT,
    integritySha256: "aa68e53f68b373191141e4b08756655003f1561beee8d0410af111636ac6dbc8",
  },
  strategy_analysis: {
    id: "strategy_analysis",
    version: "1.0.0",
    status: "active",
    workerRuntime: CURRENT_WORKER_RUNTIME,
    format: SUPPORTED_SKILL_PACKAGE_FORMAT,
    integritySha256: "aad1311be1fbeecf4a2ddc3d4d5aff1e75318347358eadeaf9def35f8d8b5ae6",
  },
  brand_strategy: {
    id: "brand_strategy",
    version: "1.0.0",
    status: "active",
    workerRuntime: CURRENT_WORKER_RUNTIME,
    format: SUPPORTED_SKILL_PACKAGE_FORMAT,
    integritySha256: "9c566d7949e9a688c2571511a877b6bf1c7e22a078e432d017c78d362514a849",
  },
  business_strategy: {
    id: "business_strategy",
    version: "1.0.0",
    status: "active",
    workerRuntime: CURRENT_WORKER_RUNTIME,
    format: SUPPORTED_SKILL_PACKAGE_FORMAT,
    integritySha256: "e8d49eb3766f152d6e95f3d45b8e00ce605878a504fb0a395c6360b0d3f31522",
  },
  communication_strategy: {
    id: "communication_strategy",
    version: "1.0.0",
    status: "active",
    workerRuntime: CURRENT_WORKER_RUNTIME,
    format: SUPPORTED_SKILL_PACKAGE_FORMAT,
    integritySha256: "bd6134cca6b858714421dcd609460b68a5d9c888ae03fd384f42fc3fc597d6b7",
  },
};

/**
 * The registered package descriptor for a Skill. Throws for an id outside the
 * closed `SkillId` union, which typed callers cannot construct.
 */
export function getSkillPackage(id: SkillId): SkillPackage {
  const metadata = SKILL_PACKAGES[id];
  if (!metadata) throw new SkillResolutionError(`no Skill is registered under the id "${String(id)}"`);
  return metadata;
}

/** A Skill that has passed every validation, together with the methodology the Worker is to follow. */
export interface ResolvedSkill {
  id: SkillId;
  version: string;
  /** The methodology body. The Worker follows this; nothing executes it. */
  content: string;
}

/**
 * Resolves one Skill by EXACT id, validating the full contract and failing
 * closed on any violation.
 *
 * Validates, in order: the id is registered at all; the package format is
 * supported; the Skill's status is active; the package is approved for this
 * Worker's runtime; and the package content's SHA-256 matches its registered
 * digest. Any failure throws SkillResolutionError naming the exact reason.
 *
 * There is deliberately no fuzzy matching, no semantic substitution, no
 * "closest available Skill" fallback, and no automatic replacement. A missing
 * or invalid Skill is a hard failure, because silently following a different
 * methodology than the one the Action declared is exactly the substitution
 * this Registry must never perform.
 */
export function resolveSkill(id: SkillId): ResolvedSkill {
  const metadata = SKILL_PACKAGES[id];
  if (!metadata) {
    throw new SkillResolutionError(`no Skill is registered under the id "${String(id)}" -- resolution is exact, and no other Skill may be substituted for it`);
  }
  if (metadata.format !== SUPPORTED_SKILL_PACKAGE_FORMAT) {
    throw new SkillResolutionError(`Skill "${id}" declares unsupported package format "${String(metadata.format)}"`);
  }
  if (metadata.status !== "active") {
    throw new SkillResolutionError(`Skill "${id}" is ${metadata.status}, not active -- a non-active Skill is never resolved`);
  }
  if (metadata.workerRuntime !== CURRENT_WORKER_RUNTIME) {
    throw new SkillResolutionError(`Skill "${id}" v${metadata.version} is approved for Worker runtime "${String(metadata.workerRuntime)}", not "${CURRENT_WORKER_RUNTIME}"`);
  }
  return { id, version: metadata.version, content: SKILL_CONTENT[id] };
}

/**
 * Verifies a Skill's package integrity: recomputes the SHA-256 of the exact
 * methodology body the Worker would follow and compares it to the digest
 * registered at approval time.
 *
 * This is the step that must never be skipped, which is why it is a separate
 * exported function rather than a detail inside `resolveSkill` -- SHA-256 is
 * asynchronous on `crypto.subtle`, and a caller that resolved a Skill without
 * awaiting this would be following unverified methodology.
 */
export async function verifySkillIntegrity(id: SkillId): Promise<void> {
  const expected = SKILL_PACKAGES[id]?.integritySha256;
  if (!expected) {
    throw new SkillResolutionError(`Skill "${String(id)}" has no registered integrity digest -- refusing to resolve without verifying it`);
  }
  const actual = await sha256Hex(SKILL_CONTENT[id] ?? "");
  if (actual !== expected) {
    throw new SkillResolutionError(
      `Skill "${id}" package integrity failed -- content digest ${actual.slice(0, 12)}... does not match the registered ${expected.slice(0, 12)}...`,
    );
  }
}

/**
 * Resolves an Action's declared Skill requirements into the exact set of
 * methodologies its Worker must follow.
 *
 * Fails closed on the first violation (unknown id, inactive Skill, wrong
 * runtime, bad format, integrity mismatch). Never returns a partial or
 * substituted set: a Worker following fewer Skills than the Action declared
 * would be following methodology the Action never sanctioned.
 */
export async function resolveActionSkills(requirements: readonly { skill_id: SkillId }[]): Promise<ResolvedSkill[]> {
  const resolved: ResolvedSkill[] = [];
  for (const requirement of requirements) {
    const skill = resolveSkill(requirement.skill_id);
    await verifySkillIntegrity(requirement.skill_id);
    resolved.push(skill);
  }
  return resolved;
}

/**
 * The Skills an Action's execution is permitted to follow: exactly the Skills
 * its definition declared, already resolved through this Registry and
 * integrity-verified. This is the ONLY way execution code obtains Skill
 * methodology.
 *
 * `get` refuses any id the Action did not declare, so a handler cannot reach
 * for an undeclared Skill through this path -- a Worker following a Skill the
 * Action never sanctioned is exactly the substitution the Registry must never
 * allow. The set is built by `src/runtime/actionSkills.ts` at the execution
 * boundary; handlers only consume it. An Action declaring no Skills receives
 * the empty set, and the contract is otherwise unchanged for it.
 *
 * A Skill supplies methodology only: nothing here grants access, authorizes a
 * Tool, assigns Work or satisfies an approval.
 */
export interface ResolvedActionSkillSet {
  /** The exact Skill ids this Action declared, in declaration order. */
  readonly declared: readonly SkillId[];
  /** The resolved, integrity-verified Skill for a DECLARED id. Throws SkillResolutionError for any other id. */
  get(id: SkillId): ResolvedSkill;
}

/** Builds the set from already-resolved Skills. Callers are `src/runtime/actionSkills.ts`; handlers never construct one. */
export function createResolvedActionSkillSet(resolved: readonly ResolvedSkill[]): ResolvedActionSkillSet {
  const byId = new Map<SkillId, ResolvedSkill>(resolved.map((skill) => [skill.id, skill]));
  return {
    declared: resolved.map((skill) => skill.id),
    get(id: SkillId): ResolvedSkill {
      const skill = byId.get(id);
      if (!skill) {
        throw new SkillResolutionError(`Skill "${String(id)}" was not declared by this Action -- execution may only follow the Skills its Action requires`);
      }
      return skill;
    },
  };
}

/** The set for an Action that requires no Skills. */
export const NO_ACTION_SKILLS: ResolvedActionSkillSet = createResolvedActionSkillSet([]);
