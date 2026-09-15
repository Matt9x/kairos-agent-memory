const claimTransitions = {
  candidate: ['confirmed', 'needs_review', 'trashed', 'purged'],
  confirmed: ['needs_review', 'superseded', 'archived', 'trashed', 'purged'],
  needs_review: ['confirmed', 'superseded', 'archived', 'trashed', 'purged'],
  superseded: ['archived', 'trashed', 'purged'],
  archived: ['trashed', 'purged'],
  trashed: ['purged'],
  purged: [],
};

function transition(transitions, current, next, label) {
  if (!transitions[current]?.includes(next)) throw new Error(`Illegal ${label} transition: ${current} -> ${next}`);
  return next;
}
export const transitionClaim = (current, next) => transition(claimTransitions, current, next, 'claim');
export const isClaimRetrievable = (claim, now = new Date().toISOString()) => claim.status === 'confirmed' && !claim.invalidatedAt && (!claim.validFrom || claim.validFrom <= now) && (!claim.validUntil || claim.validUntil > now);
export function assertIsoUtcTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error('Timestamp must be canonical ISO UTC');
  return value;
}
