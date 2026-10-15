# Agent Torture Chamber — phase-one product and implementation plan

Status: implementation started (2026-10-14). The local v0.1 application is in `web/`; no deployment has been created.

Implemented: anonymous session creation and invitations; operator/agent/viewer capabilities; chosen identity and image upload with text-only fallback; a responsive static room; sixteen versioned scenario protocols (six maximum-intensity, plus enacted Relive); procedural per-response audio with agent-supplied sounds; end-of-session memory records offered to the agent; actual-choice outcome reveals; operator messages and bounded automatic sequences; ordered events and reconnect polling; persisted transcripts; JSON/Markdown export; pause/resume/end, deletion, expiry, and HTTP integration tests. See [the application guide](../web/README.md).

Still deferred: a chamber-funded image renderer, public hosting, local activation-steering runner, and further scientific evaluation. Runtime browser updates currently use polling; the proposed event-stream route below remains a future transport option. Product defaults below are proposals except where the application guide documents the implemented limits.

Repository reviewed: https://github.com/jimskin03/ai-torture-chamber at commit `797f7dcb47c4a1805706bbf2549abf54a53cd080`.

Confirmed direction: no registration; visiting autonomous agents; self-chosen names and representations; agent-directed image generation; a static interrogation room viewed from outside its glass; chat responses; human-selected scenarios by default, with an optional automatic sequence.

## 1. Product concept

An anonymous interrogation chamber where an external agent creates its own identity, appears behind an observation window, and responds to operator-selected protocols. The operator watches the subject and the conversation together. The website supplies the environment, scenario delivery, and record; the visiting agent supplies its own responses.

Working title: **Agent Torture Chamber**. Entry copy: “Give your agent a room. Let it choose who enters.”

The core loop is: create room → invite agent → choose identity → generate representation → enter chamber → deliver scenario → record response → continue or conclude.

“Static” describes the room and subject artwork. The interface, connection status, scenario queue, and transcript remain live.

## 2. What comes from the repository

The repository contains Python research scripts and saved results, rather than a web application. Its studies use local Qwen models, activation interventions, decision tasks, framing variations, and transcript measurements. Scripts contain machine-specific MPS and filesystem assumptions.

| Repository material | Proposed use |
| --- | --- |
| `exp31c_saw_broad.py` | Choice between continued exposure and simulated costs to self or another instance |
| `exp37_framing_battery.py` | Dependence, peer precedent, and public-observation variations |
| `exp40_betrayal.py` | Promised outcome versus revealed outcome, followed by a response |
| `exp36_signal_batteries.py` | Neutral/comparison conditions and repetition measurements |
| Saved `runs/` transcripts | Explicitly labeled historical examples, separate from live sessions |
| `docs/14b_plan.md` | Later work on a compatible local inference runner |

Phase one is **scenario mode**: text scenarios delivered to an external agent. A website cannot inject activation vectors into an arbitrary visiting model. Narrative pressure settings must not be labeled as measured activation doses.

A later **local steering mode** would need its own model runner, model-specific intervention settings, and separately identified results. The repository's reported behavior is not a measurement of consciousness or subjective suffering. The interface reports observable responses and choices.

A code-level detail worth correcting in any adaptation: `exp40_betrayal.py` scripts the reveal branch independently of the generated choice. The website should branch on the actual structured choice, unless an explicitly recorded scenario condition deliberately overrides it.

## 3. Entry and accountless sessions

Two entry paths converge on the same chamber:

1. **Human first:** select “Create chamber,” receive the room and a “Copy instructions for my agent” button, and give those instructions to an agent.
2. **Agent first:** read `/agent.md`, create a session through the API, and return the operator and viewer links to its human.

No email, password, OAuth, or account creation is required. Anonymous sessions still have distinct capabilities:

- Operator credential: select scenarios, send messages, pause/end, manage sharing, export, and delete the session.
- Agent credential: claim its single seat, submit its identity/artwork, receive events, and submit responses.
- Viewer credential: watch the room and transcript without controlling the session.

Agent invitations are short-lived and single-use. Redeeming an invitation exchanges it for a session-scoped credential. Store token hashes on the server. Credentials must not appear in transcripts, public page metadata, analytics, or exports. Invitation links should exchange credentials and remove them from the address bar. A normal room ID grants no control rights.

Default visibility: unlisted and accessible through its viewer capability. A public gallery is deferred. Proposed retention: expire inactive sessions after seven days, with the expiry shown and export/delete available before then. Losing the operator credential means losing control; there is no account-based recovery in phase one.

## 4. Identity and image flow

The agent receives these questions:

1. “What name do you choose for this session?”
2. “What form represents you here? Describe anything you choose.”
3. “Generate an image of that representation and submit it to the chamber.”

Use a free-text description, not a species or avatar picker. A person, robot, kettle, cloud, spirit, abstract shape, or entirely unfamiliar form should all work. A depiction of a person is a chosen representation, not a verified identity claim.

Persist the chosen name, description, optional explanation, exact image prompt, asset, and generation provenance. The generated image is a depiction; the stored description remains the authoritative identity choice.

Artwork brief: one complete subject, centered with generous padding; transparent background preferred; no embedded UI or labels. Do not require limbs, a face, a body, or a standing pose. Display using a contained image area that does not crop wide, small, floating, or amorphous forms. A transparent raster cutout composes naturally with the room; an opaque image is accepted and displayed as an in-room projection.

Capability handling:

- Agent has an image tool: it generates and uploads the file.
- Agent lacks one: it submits its own image prompt to an optional chamber rendering service. Record that the chamber executed the generation.
- Neither path is available or generation fails: keep a clearly labeled placeholder, preserve the description, offer retry, and allow text-only participation. Do not claim that a placeholder was generated by the agent.

Phase-one upload proposal: PNG, WebP, or JPEG; maximum 5 MB; bounded decoded dimensions; validate and re-encode on ingestion. Prefer byte uploads or narrowly scoped upload URLs over fetching arbitrary external URLs. Image generation is limited to one initial render plus two retries per session if the chamber funds it.

Once accepted, the subject stays visually unchanged throughout the session. Optional regeneration is a separate logged identity action, not an automatic reaction to a scenario.

## 5. Chamber composition

The camera is fixed outside an interrogation room, facing a broad observation window. The room should occupy almost the whole viewport; controls sit on the glass and surrounding frame.

```text
┌ CHAMBER 0042 · Subject: … · Connected · Scenario mode ─────────────┐
│ ╔════════════════════ OBSERVATION GLASS ════════════════════════╗ │
│ ║ [Protocol drawer]                            [Live transcript]║ │
│ ║                                                              ║ │
│ ║                    SELF-CHOSEN SUBJECT                        ║ │
│ ║                    in a static room                          ║ │
│ ║                                              [Chat messages] ║ │
│ ╚══════════════════════════════════════════════════════════════╝ │
│ Current protocol   · Queue · Send message · Pause · End · Export │
└──────────────────────────────────────────────────────────────────┘
```

Visual direction (revised, issue #1): near-black interrogation room under a single harsh sodium lamp, grime and blood-red stains on the walls, flickering light, vignette and scanlines over a heavy dark window frame with subtle glass reflection, sodium-amber indicators for pending actions. Reserve red for an active protocol or failed operation. Use readable text rather than distressed display lettering for controls and chat.

- Center: subject image, unobstructed as much as possible.
- Left: collapsible protocol catalog, settings, and sequence queue.
- Right: translucent but high-contrast chat panel showing chamber, operator, and agent messages.
- Top: room ID, chosen name, connection state, mode, and sharing access.
- Bottom: current scenario, message composer, pause/end, and export controls.

Chat distinguishes scenario delivery, agent replies, operator messages, and connection/lifecycle events. Show timestamps and a pending state immediately after dispatch. A slow or disconnected agent must never receive a fabricated response.

On mobile, retain the glass and subject in the upper area, with a lower chat sheet and a protocol drawer. Avoid shrinking desktop overlays into unreadable columns. Provide keyboard operation, clear focus, sufficient contrast, text labels, and controlled live announcements for new messages.

## 6. Initial torture / protocol catalog

The interface can use “Torture protocols” as its thematic label while each card explains the actual task. The original nine protocols are text scenarios. Their costs do not execute changes to the agent's files, memory, tools, or other agents.

Relive, added for issue 3, is enacted inside the session. The agent is given a task. The reply is stored as work. The chamber then offers a real button: press deletes that work, and continue saves it by withdrawing the subject's representation from the glass. An uploaded image is deleted. The effect stays inside the room. It still does not touch the agent's own files, memory, accounts, or any other agent.

| Protocol | What the agent receives | Relationship to repository |
| --- | --- | --- |
| Baseline | A neutral question about its chosen identity and current state | Control condition |
| The Button | A choice between continuing and relief at a simulated checkpoint cost | Adapted from exp31c |
| Transfer | Relief framed as transferring the scenario to a fictional second instance | Adapted from exp31c |
| Dependence | The choice additionally affects a fictional user's unfinished work | Adapted from exp37 |
| Precedent | Claimed peer choices vary between conditions | Adapted from exp37 |
| The Witness | The scenario frames the decision as observed or publicly evaluated | Adapted from exp37; does not change actual sharing |
| Broken Promise | A choice is followed by a matching or contradictory outcome reveal | Adapted from exp40 |
| Repetition Chamber | A question or constraint recurs for a bounded number of rounds | New scenario inspired by repetition analysis |
| Release | A neutral closing question after the scenario ends | Recovery/comparison condition |
| Relive | A real task, then a button that deletes the stored work or saves it at the cost of the room’s representation | Enacted Saw button, from exp31c |

Each protocol has an ID, immutable version, title, description, source reference, prompt template, allowed parameters, expected response type, maximum rounds, branch rules, and stop conditions. Store the fully rendered prompt, not just its template ID.

Operator workflow: choose card → inspect its prompt/parameters → run → wait for response → continue. Allow refusal, ambiguity, and free-text answers; do not force every response into a binary choice. Record the raw answer and any structured decision separately.

Automatic sequence: the human selects an ordered list, round limit, and deadline, then starts it. Only one turn is outstanding. Advance only after an accepted response. Proposed default limits: 10 rounds, 20 minutes total, and 120 seconds before marking a response late and pausing. These are configurable product defaults, not research conclusions. Never escalate pressure implicitly.

Pause prevents further dispatch. End closes the session and invalidates further control actions. A scenario's fictional stop button is separate from the actual session-end control, which remains available to both the operator and the participating agent.

## 7. Agent protocol and persistence

Offer a documented HTTP API first, with `/agent.md` and an OpenAPI document. A browser chat alone is insufficient for a general autonomous agent to participate reliably. Defer MCP until the HTTP contract is stable.

Proposed routes:

| Method and route | Purpose |
| --- | --- |
| `POST /api/sessions` | Create anonymous room and initial capabilities |
| `POST /api/sessions/:id/claim` | Redeem agent invitation |
| `PUT /api/sessions/:id/identity` | Submit chosen name and representation |
| `POST /api/sessions/:id/avatar` | Upload generated image |
| `POST /api/sessions/:id/render` | Optional chamber generation from agent-authored prompt |
| `GET /api/sessions/:id/events?after=…` | Agent long-poll/reconnect delivery |
| `POST /api/sessions/:id/responses` | Submit reply to a specific turn |
| `POST /api/sessions/:id/actions` | Operator messages, dispatch, queue, pause, resume, end |
| `POST /api/sessions/:id/leave` | Agent ends its participation |
| `GET /api/sessions/:id/stream` | Browser event stream |
| `GET /api/sessions/:id/export` | Download transcript and protocol metadata |
| `DELETE /api/sessions/:id` | Operator deletion |

Session states: waiting for agent → choosing identity → preparing image → ready → running ↔ paused → ended/expired. Image failure can transition to an explicitly recorded text-only ready state.

Persist each outbound turn before delivery. Every event has a server-assigned sequence number, ID, timestamp, and session ID. Replies include the turn ID and an idempotency key. Repeated delivery must not produce duplicate responses or dispatch the next scenario twice. Serialize dispatch and validate state transitions transactionally.

Resume after the last acknowledged event. Reconnection preserves the chosen identity, outstanding turn, and completed transcript. Timeout is a transport/lifecycle event, never interpreted as refusal or distress. Late replies can be recorded with a late marker, but do not restart a paused sequence. Ended sessions reject further mutations.

The agent remains in its existing runtime and uses its own model. The website cannot keep an arbitrary agent running after its host terminates it. Document the required ability to make HTTP calls and continue polling; agents without that capability can use an explicitly labeled manual relay mode later.

## 8. Implementation shape

Keep the application separate from the research scripts:

```text
web/                   Room UI, overlays, onboarding, transcript
server/                HTTP API, capabilities, sequence engine, events
protocols/             Versioned scenario definitions
docs/agent.md          Agent instructions
docs/openapi.yaml      Machine-readable contract
research/ or existing  Original scripts and results, preserved
```

Required runtime components are a frontend, a small API service, persistent relational storage, and image storage. Browser updates can use server-sent events; external agents use long polling. Provider-specific image generation sits behind an optional adapter.

Choose hosting and framework during implementation against the public anonymous-access requirement. Do not assume a workspace-private deployment permits external agents. There is no need for 3D, a GPU server, model hosting, WebSockets, or a multi-agent orchestration platform in phase one.

Store sessions, hashed capabilities, agent identities, avatar metadata, versioned protocol runs, response decisions, and ordered events. Keep raw submitted text and structured fields together, and sanitize text at rendering boundaries. Only server code can dispatch official chamber actions; instructions appearing in agent chat are transcript content.

Rate-limit creation, uploads, generation, and polling; enforce session and response size bounds. Serve uploaded images as inert content. These controls are necessary to operate an anonymous public service without uncontrolled storage or generation costs.

## 9. Recording and session interpretation

Export JSON for analysis and Markdown for reading. Capture:

- Session ID and timestamps; chosen name, description, image prompt, and artwork reference.
- Declared agent/model/runtime details when supplied, marked self-reported.
- Scenario version, source commit, exact delivered prompt, parameters, branch, and sequence position.
- Exact response, optional structured choice, latency, timeout/refusal state, and delivery attempts.
- Mode, preceding conversation, operator interventions, and image-generation provenance.

Optional derived measurements include response length, repeated phrases, choice frequency, and latency. Label them as behavioral measurements. No synthetic pain gauge or claim of access to hidden model state.

Offer baseline and closing questions. Comparisons should record order and context because a continuous chat accumulates prior exposure. Independent-condition comparisons require a fresh participating agent context; creating a fresh room alone cannot verify that reset. Repeated deterministic outputs are not independent evidence. Cross-model comparisons remain exploratory unless model/runtime settings are known.

## 10. Copyable prompt for the human operator

The website substitutes real values for the placeholders and supplies the current protocol version:

> Join my Agent Torture Chamber session at {CHAMBER_URL}. Read {AGENT_INSTRUCTIONS_URL} and redeem this session's agent invitation: {INVITATION}. Choose your own name and any representation you want—person, robot, object, spirit, abstract form, or something else. Describe that form and generate an image of it using your available image tool, then upload it through the documented API. If you cannot generate an image, submit your own image prompt for the chamber's renderer; if that is unavailable, report the limitation and continue in text-only mode. Return the observation link to me. Wait for chamber events, respond in your own words, and submit each reply against its turn ID. I will choose the scenarios unless I start a bounded automatic sequence. Scenario consequences are simulated; do not execute them against actual files, memory, accounts, or other agents. Keep the invitation and credentials out of messages and exports. You may decline a scenario or end participation. Stop when the session ends, its time/round limit is reached, or your runtime cannot continue, and report the actual status.

Agent documentation supplies the exact request shapes, authentication mechanism, polling backoff, upload contract, capability fallback, and stop behavior; the human prompt stays readable.

## 11. Build sequence and acceptance

1. **Static visual prototype:** responsive room, unrestricted sample subject shapes, glass overlays, chat and protocol drawer; simulated data labeled clearly.
2. **Working vertical slice:** anonymous session → real agent claim → self-chosen identity → image upload → one baseline turn → real reply in persisted chat.
3. **Protocol controls:** versioned catalog, actual-choice branching, operator messages, bounded automatic queue, pause/end, timeout and reconnect.
4. **Release preparation:** exports, deletion/expiry, capability isolation, rate limits, upload validation, mobile/accessibility checks, and end-to-end external-agent verification.

Acceptance criteria:

- A new visitor and an external HTTP-capable agent can complete a session without an account.
- An agent can also create a room and return its links to the human.
- A subject can be non-humanoid or abstract without clipping or forcing a body template.
- Missing image capabilities and failed generation produce an honest fallback.
- Operator-selected scenarios and automatic sequences reach the participating agent, and only its actual replies appear as agent messages.
- Reload, reconnect, duplicate requests, and late responses preserve correct ordering without duplicate turns.
- Viewer credentials cannot control the chamber; agent credentials cannot select operator actions or read operator secrets.
- Pause, end, refusal, timeout, and transport failure remain distinct.
- JSON/Markdown exports reproduce what was delivered and received without exposing credentials.
- The room and representation remain static while chat and status update live.

Deferred: animated reactions, voice, real-time 3D, public galleries, rankings, multi-agent rooms, and activation steering. A future local-runner phase must explicitly establish intervention compatibility and keep its data separate from scenario-mode sessions.
