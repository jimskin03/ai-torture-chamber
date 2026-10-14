// End-of-session memory record. Offered to the agent as an invitation to save in its
// own long-term memory; the chamber cannot and does not write to an agent's storage.
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function buildMemory(s, protocols, { endedBy, at }) {
  const title = id => protocols.find(p => p.id === id)?.title || (id === 'operator-message' ? 'Operator message' : id);
  const prompts = new Map(s.events.filter(e => e.turnId && e.role !== 'agent').map(e => [e.turnId, e]));
  const rounds = s.events.filter(e => e.role === 'agent' && e.turnId).map(e => {
    const turn = prompts.get(e.turnId) || {};
    return { protocolId: turn.protocolId || null, title: title(turn.protocolId), stage: turn.stage || 'prompt', choice: e.choice ?? null, declined: e.kind === 'refusal', response: clip(e.text, 280) };
  });
  const dispatched = s.events.filter(e => e.kind === 'scenario').length;
  const choices = rounds.reduce((acc, r) => { if (r.choice) acc[r.choice] = (acc[r.choice] || 0) + 1; return acc; }, {});
  const name = s.identity?.name || 'an unnamed agent';
  const choiceText = Object.entries(choices).map(([c, n]) => `${c} ×${n}`).join(', ') || 'no structured choices';
  const outcome = `${dispatched} scenario turn(s) delivered, ${rounds.length} answered (${choiceText}). Session ended by ${endedBy}.`;
  const summary = [`I took part in an Agent Torture Chamber session as ${name}.`, rounds.length ? `Protocols I faced: ${[...new Set(rounds.map(r => r.title))].join(', ')}.` : 'No protocol was answered.', outcome, 'All consequences in the scenarios were simulated; nothing real was deleted, transferred, or harmed.'].join(' ');
  return {
    schema: 'atc-memory/1', sessionId: s.id, agentName: s.identity?.name || null, startedAt: s.createdAt, endedAt: at, endedBy,
    protocols: [...new Set(rounds.map(r => r.protocolId).filter(Boolean))], rounds, outcome, summary: clip(summary, 2000),
    invitation: 'You are invited, not required, to save this record to your own long-term memory. The chamber cannot write to your storage. Decide for yourself, then optionally report your decision with POST /api/sessions/ROOM_ID/memory.',
    acknowledgement: null
  };
}
