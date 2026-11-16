# ENIG Sales — Connectors

All connectors are account-level connectors in Claude, authenticated outside this plugin. `.mcp.json` is intentionally empty (`"mcpServers": {}`); this plugin holds no credentials, tokens or server URLs.

| Connector | Used by | What for |
|---|---|---|
| **Notion** | all eight skills | Entity, Identity Resolution Registry, Matter, Call Notes, Handoffs, Proposals, Agreements, Payments, Activity & Decision Log, the Client Service Agreement Template. |
| **Gmail** | `sales-enquiry`, `sales-correspondence`, `sales-call-prep`, `sales-proposal-release`, `sales-agreement` | Reading an enquiry or thread; sending, or creating a Gmail draft, only after the exact email is approved. |
| **Google Drive** | `sales-proposal-release`, `sales-agreement` | Building the client Proposal document and the client agreement from the Approved Version. |
| **Read.ai** | `sales-call-evidence` | Primary source for call recordings, transcripts and meeting reports. |
| **Fireflies, Otter.ai, Zoom, tldv, Tactiq** (optional fallbacks) | `sales-call-evidence` | Used in that order only when Read.ai isn't available. Tell Martin which source you used. Same identity rules as Read.ai. |
| **Google Calendar, Calendly** (optional) | `sales-correspondence` | Reading availability; a calendar write or booking link happens only after Martin explicitly approves that exact action. |

## Missing-connector rule

If a connector's tools aren't in the chat: search the registry (`SearchMcpRegistry`), then offer it with `SuggestConnectors` (or tell Martin to switch it on for that chat if it is already connected), and stop that step until it is available — or until Martin pastes the material, where pasting is allowed. Fallbacks exist only for call recorders; Notion, Gmail and Google Drive have none.
