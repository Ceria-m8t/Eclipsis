// 记忆库（二改）。第一期：搬家 + 防错地基。第二期：双线写入 + 沉淀信箱。
export { ensureMemorySchema, liveMemories, currentFacts, RESIDENT_CAP, type Layer, type Grade, type MemoryRow } from './schema.ts'
export { classify, guessSubject, dupGroups, overlap, synthCard, PEOPLE_SEEDS } from './classify.ts'
export { readObCards, emptyDirs, parseCard, OB_BUCKETS } from './ob-cards.ts'
export { migrateOb, formatReport, planMigration, type MigrateReport } from './migrate-ob.ts'
export {
  writeMemory, findSimilar, findSimilarTitle, normalizeSubject, listInbox, decideCandidate, inboxCount,
  labelOf, labelWithPeople, AMEND_AT, UNSURE_AT,
  type MemoryDraft, type WriteOutcome, type Candidate,
} from './write.ts'
export { memoBox, MEMO_TOOLS, recentEvidence } from './box.ts'
export {
  findDigestWindow, runDigest, DigestScheduler, buildMaterial, cleanForDigest, parseDigestReply,
  stationCaller, DIGEST_SYSTEM, type DigestConfig, type DigestResult, type DigestItem,
} from './digest.ts'
export { handleMemoryApi } from './api.ts'
