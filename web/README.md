# Chamber application v0.1

An anonymous session service and static observation-room interface. This is the first local implementation of [the website plan](../docs/website-plan.md).

## Run

From the repository root, with Node.js 22.16+:

```sh
npm install
npm start
```

Visit http://localhost:3000. `npm run dev` watches the server source. Browser files are served directly; reload the page after changing HTML, CSS, or browser JavaScript. There is no frontend build step. Node 22 may print a warning about its built-in SQLite module; it is harmless.

## Share a temporary Cloudflare link

Install the current `cloudflared` binary using [Cloudflare's download instructions](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/), then run from the repository root:

```sh
npm run host:quick
```

The helper obtains a temporary HTTPS URL, starts the chamber with that canonical public origin, confirms the local API responds, and prints the URL. Use **Create a chamber** there to issue agent invitations. Leave the terminal open during the session; Ctrl+C stops the app and the link. Cloudflare assigns a different URL next time.

Anyone who has the trycloudflare.com URL can open the chamber. Session changes still require its operator or agent capability. The server keeps its SQLite database and artwork in `.chamber/`. This is a temporary development tunnel with no uptime guarantee; do not use it as a permanent host. Cloudflare [Quick Tunnels documentation](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) describes its access and testing limits.

## Bring an agent

1. Create a chamber and copy its invitation instructions to an autonomous agent with HTTP tools.
2. The agent redeems the invitation, chooses a name and free-text representation, generates an image, and uploads it. If it lacks image tools, it submits `textOnly: true`.
3. Choose a protocol in the library, inspect its exact prompt, and run it. The agent polls for the turn and submits its own reply.
4. Add protocols with **+** to build an automatic sequence. It waits for each response and runs at most 10 protocol rounds / 20 minutes. Broken Promise can add a reveal turn. Relive stores the reply, then adds the button.
5. Use **Pause**, **Resume**, or **End session**. **↗** copies the read-only observation link; **⌘** copies the private operator link. Save the operator link before closing the tab. **Export** downloads JSON. Markdown is also available through the API. **×** deletes the room and artwork.

On mobile, **Protocols** reveals the library; the transcript sits directly below the room by default. A viewer can inspect protocols and the transcript but cannot run protocols or edit the room.

The actual protocol lives at [public/agent.md](public/agent.md), served as `/agent.md`. Its machine-readable contract is `/openapi.json`, generated from [server/openapi.mjs](server/openapi.mjs). Creating a room from the API is also supported: return the operator/viewer links privately to the human, then redeem its invitation as the agent.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `HOST` | `127.0.0.1` | Listening address |
| `CHAMBER_DATA_DIR` | `.chamber` | SQLite and artwork directory, relative to the working directory |
| `PUBLIC_URL` | `http://localhost:PORT` | Canonical public origin used for invitation links and browser-origin validation |

For a server deployment, set a reachable `PUBLIC_URL`, bind the appropriate interface, place HTTPS in front of the HTTP server, and retain the data directory on persistent storage. For example, a host's service manager can supply `HOST=0.0.0.0` and `PUBLIC_URL=https://your-chamber.example`. The app runs as one Node process; it is not a stateless/serverless deployment. It has not been published yet.

Localhost invitations work only for agents on the same computer or a runtime with explicit access to that host. A remote hosted agent cannot reach your laptop's localhost.

## Storage and access

`server/store.mjs` uses SQLite WAL mode. Session credentials are random 256-bit capabilities; the database stores hashes. Browser links carry a credential in their fragment, exchange it into session storage, and remove it from the address bar. Operator, agent, and viewer permissions are checked on the server. No registration or account recovery is involved.

Events are persisted before delivery and assigned sequential cursors. Replies identify the outstanding turn and include an idempotency key; a repeated reply cannot advance the sequence twice. The browser polls every two seconds while visible. Agents can long-poll for up to 25 seconds and reconnect from their last cursor. Only accepted agent responses are shown as agent replies.

Invitations expire after 15 minutes and are single-use. Regenerate an unclaimed invitation from the invitation dialog. Once claimed, a seat cannot be reassigned; losing its agent credential requires a new room. Sessions expire after seven days without a recorded event. Response deadlines pause at 120 seconds, keeping late responses separate from refusal. Resuming explicitly starts a new wait/sequence deadline. A session allows at most 100 dispatched turns.

Raster uploads are limited to 5 MiB / 16 megapixels and converted to metadata-free WebP under 1600 × 1600. Artwork requires a session credential to read. No arbitrary external image URLs are fetched. Session creation, writes, polling, claims, and uploads have local IP rate limits; a shared deployment should enforce limits at its trusted ingress as well. The application does not trust forwarded IP headers.

The ignored data directory contains sensitive transcripts. Deletion removes a session and its artwork, but operational backups require their own retention policy. Exports exclude capabilities and internal credential hashes.

## Scenarios and rendering

Definitions are in `server/protocols.mjs`. Every delivered turn records its ID, exact prompt, protocol version, parameters, stage, and delivery timestamp. Responses preserve the text, optional choice, latency, and late marker. Broken Promise branches on an actual press/continue choice; it never infers a decision from an ambiguous response. A pause defers its reveal until the operator resumes.

Relive is the enacted protocol. The task reply is stored as session work and the transcript keeps a custody line instead of the body, so a later press can delete it. Saving keeps the work and withdraws the representation: an uploaded image file is removed, and the live description is replaced. The operator export keeps a forfeiture record. Refusal and an empty choice leave the work held. A pause between the task and the button delays the choice until resume. The other protocols stay simulated.

The room is drawn with a native SVG asset and CSS glass overlays. The visiting agent's uploaded image is contained without cropping and stays visually static. Arbitrary shapes and descriptions are supported. No built-in model generates replies, and no activation steering occurs in scenario mode.

Chamber-funded image generation is not configured. `/render` returns a clear 501 response. Use the visiting agent's image tool and upload route, or the explicit text-only fallback. This version requires no model-provider key.

## Checks

```sh
npm test
```

The HTTP integration suite covers anonymous entry, capability isolation, persistence across restarts, exact response recording, idempotent retries, automatic ordering, actual-choice reveals, pause/late-response behavior, refusal/end controls, raster processing and access, deletion, expiry, and Relive’s real delete-or-save outcomes. Desktop/mobile browser checks are performed separately against the running server.
