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
  stationCaller, scrubFeeling, DIGEST_SYSTEM, type DigestConfig, type DigestResult, type DigestItem,
} from './digest.ts'
export {
  runRejudge, pickBatch, buildRejudgeMaterial, listProposals, takeProposal, dropProposal, undoProposal,
  REJUDGE_SYSTEM, type RejudgeResult, type Proposal,
} from './rejudge.ts'
export {
  ensurePrivacySchema, allowsPrivate, privacySql, markEpisodesPrivate, markTurnPrivate,
  markMemoryPrivate, privateCounts, PRIVATE,
} from './privacy.ts'
export { recallCandidates, bigrams, lexicalScorer, type Scored } from './recall.ts'
export { listRelationsOf, neighbors, addRelation, removeRelation, extractObRelations, renderNeighbors, KIND_LABEL } from './relations.ts'
export { addCorrection, listCorrections, acceptCorrection, keepCorrection, withdrawCorrection, renderCorrectionLine } from './corrections.ts'
export {
  runRecall, runRecallWithSemantics, judge, judgeDeliveries, recordDeliveries, recallMode, recallStats,
  renderRecallNote, buildAxis, mentionedPeople, distinctWords,
  type RecallMode, type RecallResult, type Picked,
} from './inject.ts'
export {
  embedConfig, apiEmbedder, indexMemories, queryVector, cachedQueryVector, warmQueryVector,
  vectorStats, cosine, vectorText,
  ensureVectorSchema, pruneQueryCache,
} from './embed.ts'
export { expandQuery, addAlias, removeAlias, listAliases, ensureAliasSchema, BUILTIN_ALIASES } from './aliases.ts'
export { searchQuotes, quoteSpan, renderQuotes, type Quote } from './quotes.ts'
export {
  replayRecall, graduation, addSpotcheck, listSpotchecks, ensureSpotcheckSchema,
  type ReplayReport, type Graduation,
} from './replay.ts'
export { handleMemoryApi } from './api.ts'
