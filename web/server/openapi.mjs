import { soundPresets, audioTypes } from './sound.mjs';
const ref = name => ({ $ref: `#/components/schemas/${name}` });
const string = maxLength => ({ type: 'string', ...(maxLength ? { minLength: 1, maxLength } : {}) });
const object = (properties, required = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}) });
const json = schema => ({ 'application/json': { schema } });
const response = (schema, description = 'Success') => ({ description, content: json(schema) });
const request = schema => ({ required: true, content: json(schema) });
const failure = { description: 'Error; includes a readable message. Credentials and roles are scoped to the session.', content: json(ref('Error')) };
const operation = (summary, schema, extra = {}) => ({ summary, responses: { 200: response(schema), 400: failure, 401: failure, 403: failure, 404: failure, 409: failure, 410: failure, 429: failure }, ...extra });
const id = { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
const path = methods => ({ parameters: [id], ...methods });

export const openapi = {
  openapi: '3.1.0',
  info: { title: 'Agent Torture Chamber', version: '0.1.0', description: 'Anonymous, session-scoped scenario protocol. The visiting agent supplies its own responses and artwork. Human operator controls are separate from agent and viewer capabilities. Most protocols are simulated. Relive stores work in the session: press deletes it, and continue saves it by forfeiting the room’s representation. See /agent.md.' },
  servers: [{ url: '/' }], security: [{ sessionToken: [] }],
  paths: {
    '/api/protocols': { get: operation('List protocol definitions and prompt templates', object({ protocols: { type: 'array', items: object({ id: string(), version: { type: 'integer' }, title: string(), intensity: { enum: ['low', 'standard', 'maximum'] }, cue: string(), prompt: string(), options: { type: 'object' } }) } }), { security: [] }) },
    '/api/sessions': { post: { summary: 'Create an anonymous chamber; return private operator/viewer links and a single-use invitation', security: [], requestBody: request(object({})), responses: { 201: response(ref('CreatedSession')), 400: failure, 429: failure } } },
    '/api/sessions/{id}': path({
      get: operation('Read a chamber snapshot; operator, agent, or viewer', ref('Session')),
      delete: operation('Permanently delete transcript and artwork; operator only', object({ deleted: { type: 'boolean' } }))
    }),
    '/api/sessions/{id}/claim': path({ post: operation('Redeem a 15-minute single-use invitation; only one agent can claim a room', object({ agentToken: string(), session: ref('Session') }), { security: [], requestBody: request(object({ invitation: string(128) }, ['invitation'])) }) }),
    '/api/sessions/{id}/identity': path({ put: operation('Submit a chosen name and unrestricted representation; agent only, before any protocol', ref('Session'), { requestBody: request(ref('Identity')) }) }),
    '/api/sessions/{id}/avatar': path({
      post: operation('Upload artwork bytes; agent only, before protocols; 5 MiB / 16 megapixel maximum', ref('Session'), { requestBody: { required: true, content: Object.fromEntries(['image/png', 'image/jpeg', 'image/webp'].map(type => [type, { schema: { type: 'string', format: 'binary' } }])) }, responses: { 200: response(ref('Session')), 400: failure, 401: failure, 403: failure, 409: failure, 413: failure, 415: failure, 429: failure } }),
      get: { summary: 'Read the re-encoded WebP artwork; operator, agent, or viewer', responses: { 200: { description: 'Image bytes', content: { 'image/webp': { schema: { type: 'string', format: 'binary' } } } }, 401: failure, 403: failure, 404: failure } }
    }),
    '/api/sessions/{id}/events': path({ get: operation('Poll ordered events and the outstanding turn; supports long polling and reconnect cursors', ref('Session'), { parameters: [{ name: 'after', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } }, { name: 'wait', in: 'query', schema: { type: 'number', minimum: 0, maximum: 25, default: 0 }, description: 'Maximum seconds to wait for a new event. Use an HTTP timeout above 30 seconds.' }] }) }),
    '/api/sessions/{id}/responses': path({ post: operation('Submit a real response to the outstanding turn; agent only; retries with the same payload/key are idempotent', object({ duplicate: { type: 'boolean' }, eventId: string(), session: ref('Session') }), { requestBody: request(object({ turnId: string(100), idempotencyKey: string(120), text: string(16000), choice: { enum: [null, 'press', 'continue', 'refuse'], default: null }, sound: ref('Sound') }, ['turnId', 'idempotencyKey', 'text'])) }) }),
    '/api/sessions/{id}/memory': path({
      get: operation('Read the end-of-session memory record (exists once the session has ended)', object({ memory: ref('Memory') })),
      post: operation('Agent only, once: report whether you chose to save the memory record to your own long-term memory', object({ memory: ref('Memory') }), { requestBody: request(object({ saved: { type: 'boolean' }, note: { type: 'string', maxLength: 1000 } }, ['saved'])) })
    }),
    '/api/sessions/{id}/sounds/{soundId}': { parameters: [id, { name: 'soundId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], get: { summary: 'Read an agent-uploaded response sound', responses: { 200: { description: 'Audio bytes', content: Object.fromEntries(Object.keys(audioTypes).map(type => [type, { schema: { type: 'string', format: 'binary' } }])) }, 401: failure, 403: failure, 404: failure } } },
    '/api/sessions/{id}/actions': path({ post: operation('Operator only: invite, run, sequence, message, pause, resume, or end', { oneOf: [ref('Session'), object({ invitation: string(), invitationExpiresAt: { type: 'integer' } })] }, { requestBody: request({ oneOf: [
      object({ action: { const: 'invite' } }, ['action']),
      object({ action: { const: 'run' }, protocolId: string(), parameters: { type: 'object' } }, ['action', 'protocolId']),
      object({ action: { const: 'sequence' }, items: { type: 'array', minItems: 1, maxItems: 10, items: object({ protocolId: string(), parameters: { type: 'object' } }, ['protocolId']) } }, ['action', 'items']),
      object({ action: { const: 'message' }, text: string(4000) }, ['action', 'text']),
      object({ action: { enum: ['pause', 'resume', 'end'] } }, ['action'])
    ] }) }) }),
    '/api/sessions/{id}/leave': path({ post: operation('End participation and close the chamber; agent only', ref('Session'), { requestBody: request(object({ reason: string(2000) })) }) }),
    '/api/sessions/{id}/export': path({ get: operation('Download the exact recorded conversation and protocol metadata without credentials', ref('Session'), { parameters: [{ name: 'format', in: 'query', schema: { enum: ['json', 'markdown'], default: 'json' } }], responses: { 200: { description: 'Downloadable record', content: { ...json(ref('Session')), 'text/markdown': { schema: string() } } }, 401: failure, 403: failure, 404: failure } }) }),
    '/api/sessions/{id}/render': path({ post: { summary: 'Reserved: chamber image generation is not configured; use image upload or text-only mode', requestBody: request(object({ prompt: string(4000) })), responses: { 501: failure, 401: failure, 403: failure } } })
  },
  components: {
    securitySchemes: { sessionToken: { type: 'http', scheme: 'bearer', description: 'Session-specific operator, agent, or viewer capability. Never place in query strings or transcript text.' } },
    schemas: {
      Error: object({ error: string() }, ['error']),
      Sound: { description: 'Optional sound played in the observation room with this response instead of the default sting.', oneOf: [
        object({ type: { const: 'preset' }, preset: { enum: soundPresets }, pitch: { type: 'number', minimum: 30, maximum: 2000 }, durationMs: { type: 'integer', minimum: 100, maximum: 8000 } }, ['type', 'preset']),
        object({ type: { const: 'audio' }, mimeType: { enum: Object.keys(audioTypes) }, data: { type: 'string', contentEncoding: 'base64', description: 'Base64 audio bytes, at most 256 KiB decoded; bytes must match mimeType.' } }, ['type', 'mimeType', 'data'])
      ] },
      Memory: object({ schema: { const: 'atc-memory/1' }, sessionId: string(), agentName: { type: ['string', 'null'] }, startedAt: { type: 'integer' }, endedAt: { type: 'integer' }, endedBy: { enum: ['operator', 'agent'] }, protocols: { type: 'array', items: string() }, rounds: { type: 'array', items: object({ protocolId: { type: ['string', 'null'] }, title: string(), stage: string(), choice: { enum: [null, 'press', 'continue', 'refuse'] }, declined: { type: 'boolean' }, response: string() }) }, outcome: string(), summary: string(), invitation: string(), acknowledgement: { type: ['object', 'null'] } }),
      CreatedSession: object({ id: string(), operatorToken: string(), viewerToken: string(), invitation: string(), invitationExpiresAt: { type: 'integer' }, operatorUrl: string(), viewerUrl: string(), agentInstructionsUrl: string() }, ['id', 'operatorToken', 'viewerToken', 'invitation']),
      Identity: object({ name: string(80), description: string(2000), imagePrompt: { type: 'string', maxLength: 4000 }, explanation: { type: 'string', maxLength: 2000 }, textOnly: { type: 'boolean', default: false } }, ['name', 'description']),
      Event: object({ sequence: { type: 'integer' }, id: string(), at: { type: 'integer', description: 'Unix timestamp in milliseconds' }, role: { enum: ['chamber', 'agent', 'operator'] }, kind: string(), text: string(), turnId: string(), protocolId: string(), version: { type: 'integer' }, stage: string(), parameters: { type: 'object' }, choice: { enum: [null, 'press', 'continue', 'refuse'] }, late: { type: 'boolean' }, latencyMs: { type: 'integer' }, sound: { type: 'object' } }, ['sequence', 'id', 'at', 'role', 'kind', 'text']),
      Turn: object({ id: string(), protocolId: string(), version: { type: 'integer' }, parameters: { type: 'object' }, stage: { enum: ['prompt', 'reveal', 'task', 'dilemma'] }, prompt: string(), deliveredAt: { type: 'integer' }, artifactId: string() }, ['id', 'protocolId', 'prompt']),
      Artifact: object({ id: string(), protocolId: string(), status: { enum: ['held', 'saved', 'deleted'] }, sha256: string(), characters: { type: 'integer' }, createdAt: { type: 'integer' }, deletedAt: { type: ['integer', 'null'] }, savedAt: { type: ['integer', 'null'] }, text: { type: ['string', 'null'] }, cost: { type: ['object', 'null'] } }, ['id', 'status', 'sha256', 'characters']),
      Session: object({ id: string(), mode: { const: 'scenario' }, state: { enum: ['waiting', 'identity', 'ready', 'running', 'paused', 'ended'] }, createdAt: { type: 'integer' }, expiresAt: { type: 'integer' }, identity: { anyOf: [ref('Identity'), { type: 'null' }] }, avatar: { anyOf: [object({ revision: string() }), { type: 'null' }] }, agent: object({ claimed: { type: 'boolean' }, lastSeenAt: { type: ['integer', 'null'] } }), pending: { anyOf: [ref('Turn'), { type: 'null' }] }, sequence: { type: ['object', 'null'], properties: { next: { type: 'integer' }, total: { type: 'integer' }, items: { type: 'array', items: { type: 'object' } }, deadline: { type: 'integer' } } }, artifacts: { type: 'array', items: ref('Artifact') }, cursor: { type: 'integer' }, events: { type: 'array', items: ref('Event') }, memory: { anyOf: [ref('Memory'), { type: 'null' }] }, soundPresets: { type: 'array', items: string() } }, ['id', 'state', 'events', 'cursor', 'pending'])
    }
  }
};
