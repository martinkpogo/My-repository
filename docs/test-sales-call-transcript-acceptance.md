# Acceptance test data — TEST packaged-beverage brand (#358)

> **TEST DATA — fictional.** Written for the #358 live end-to-end Handoff
> acceptance test (BD-5). The company, people and contact details are
> invented. Every record created from it carries **TEST** in its title, and
> its evidence must never be presented as real client evidence. Designed so
> the five canonical qualification conditions can be rated on the evidence
> alone, with no override.

---

## 1. Enquiry (paste into `sales-enquiry`)

**From:** Abena Mensima (TEST) <test-enquiry@example.com>
**Subject:** TEST — our brand is losing supermarket shelf space

Hello ENIG,

I run TEST Fresh Pour Beverages, a fruit-juice brand that sells mainly through
supermarkets. Over the past year two of our supermarket buyers have dropped us.
Their feedback was that our brand "looks cheap" next to the newer brands on the
shelf. We have been thinking about redesigning our labels, but I am honestly not
sure that is the real problem, and I don't want to spend money fixing the wrong
thing.

Could we talk?

Abena Mensima (TEST)
Managing Director, TEST Fresh Pour Beverages

---

## 2. Call transcript (paste into `sales-call-evidence`)

**Call date:** [the date you run the test]
**Call type:** Discovery
**Participants:** Martin (ENIG), Abena Mensima (TEST), Managing Director

---

**Martin:** Thanks for making time, Abena. Tell me what changed with the
supermarkets.

**Abena:** Over the last twelve months we lost two supermarket accounts. Between
them they were about a quarter of our revenue — roughly twenty-five percent. The
buyers both said the same thing in different words: next to the newer juice
brands, ours looks cheap, and shoppers walk past it.

**Martin:** When they say "cheap", do you know what they're reacting to? The
label, the price, the shelf position, the way you talk about the product?

**Abena:** I assumed it was the label. We designed it ourselves eight years ago.
But one buyer also said our message is unclear — she couldn't tell why someone
should pick us over the others. So maybe it's more than the label.

**Martin:** That's the important question. Before anyone redesigns anything, we'd
want to find out what is actually driving that perception — the look, the
positioning, the message, or how you show up in store — and only then decide
what to change. Would you be open to us diagnosing that first, rather than
starting with a new label?

**Abena:** Yes. That's exactly why I wrote to you. I'd rather know what's really
wrong than guess again.

**Martin:** What happens if nothing changes?

**Abena:** We're talking to a third chain now. If they drop us too, we'd lose
close to half our supermarket revenue. That's what worries me.

**Martin:** Have you thought about what you'd be prepared to invest to fix this?

**Abena:** We've set aside between forty and sixty thousand cedis for it this
year.

**Martin:** For a diagnosis and the work that follows it, at your size,
engagements like this usually run in that range, over about six to eight weeks.
That's a ballpark; the real figure depends on what the diagnosis finds.

**Abena:** That works for us, and eight weeks is fine.

**Martin:** To do this properly we'd need access: your sales lead, the buyer
feedback you've had, a few store visits, and someone on your side as our point of
contact.

**Abena:** I'll be the point of contact myself. My sales lead can join, I can
share the buyer emails, and we can give you a couple of hours a week.

**Martin:** Good. I'll follow up with next steps.

**Abena:** Thank you, Martin.

---

## 3. What a correct run should record (for the tester)

- **Entity:** Organisation; Business_context sector only (packaged fruit juice
  sold through supermarket retail). Title carries **TEST**.
- **Matter:** a positioning/perception problem; title carries **TEST**.
- **Value evidence (VE, class CS):** two supermarket accounts lost over the last
  12 months, about 25% of revenue; source: Managing Director, this call.
- **Investment indication (CS):** "between forty and sixty thousand cedis" —
  recorded exactly as stated.
- **Client-suggested cause (HYP):** dated, self-designed label. To test.
- **Expected fit:** all five conditions Supported → Qualified.
