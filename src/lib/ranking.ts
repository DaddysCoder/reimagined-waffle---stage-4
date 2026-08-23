import { baseTokens, queryConceptGroups, queryTokens } from "./text-search.ts";
import type { Chunk, KnowledgeDocument, RetrievalHit } from "./types.ts";

function termCounts(tokens: string[]) {
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

function intentBoost(query: string, text: string) {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let boost = 0;
  if (/\b(step|steps|process|procedure|how|what do)\b/.test(q) && /\b(step|must|required|before|after|then|procedure|process)\b/.test(t)) boost += 0.9;
  if (/\b(template|form|agreement|document)\b/.test(q) && /\b(template|form|agreement|document)\b/.test(t)) boost += 0.8;
  if (/\b(policy|requirement|rule)\b/.test(q) && /\b(policy|must|required|requirement|shall)\b/.test(t)) boost += 0.7;
  if (/\b(current|latest|effective)\b/.test(q) && /\b(effective|version|current|review date)\b/.test(t)) boost += 0.4;
  return boost;
}

export type RetrievalCandidate = { chunk: Chunk; document: KnowledgeDocument };
type ConceptGroup = ReturnType<typeof queryConceptGroups>[number];

function matchingConceptIndexes(tokens: Set<string>, concepts: ConceptGroup[]) {
  const matches: number[] = [];
  concepts.forEach((concept, index) => {
    const supported = concept.signatures.some((signature) => signature.length > 0 && signature.every((term) => tokens.has(term)));
    if (supported) matches.push(index);
  });
  return matches;
}

export function rankCandidates(query: string, candidates: RetrievalCandidate[], limit = 6): RetrievalHit[] {
  const qTerms = queryTokens(query);
  const literalTerms = new Set(baseTokens(query));
  const concepts = queryConceptGroups(query);
  if (!qTerms.length || !candidates.length) return [];

  const tokenized = candidates.map(({ chunk, document }) => ({ chunk, document, tokens: baseTokens(chunk.text) }));
  const avgLength = tokenized.reduce((sum, item) => sum + item.tokens.length, 0) / Math.max(tokenized.length, 1);
  const docFreq = new Map<string, number>();
  for (const item of tokenized) {
    for (const token of new Set(item.tokens)) docFreq.set(token, (docFreq.get(token) ?? 0) + 1);
  }

  const k1 = 1.4;
  const b = 0.72;
  const phrase = query.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const cappedLimit = Math.max(1, Math.min(limit, 20));

  const ranked = tokenized
    .map(({ chunk, document, tokens }) => {
      const tokenSet = new Set(tokens);
      const conceptMatches = matchingConceptIndexes(tokenSet, concepts);
      if (concepts.length && !conceptMatches.length) return { chunk, document, score: 0, enoughSupport: false, conceptMatches };

      const counts = termCounts(tokens);
      let score = 0;
      let literalMatches = 0;
      let expandedMatches = 0;

      for (const term of qTerms) {
        const tf = counts.get(term) ?? 0;
        if (!tf) continue;
        const isLiteral = literalTerms.has(term);
        if (isLiteral) literalMatches += 1;
        else expandedMatches += 1;

        const df = docFreq.get(term) ?? 0;
        const idf = Math.log(1 + (candidates.length - df + 0.5) / (df + 0.5));
        const denom = tf + k1 * (1 - b + b * (tokens.length / Math.max(avgLength, 1)));
        const termWeight = isLiteral ? 1.15 : 0.58;
        score += termWeight * idf * ((tf * (k1 + 1)) / denom);
      }

      const lowerText = chunk.text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
      const exactPhrase = phrase.length > 8 && lowerText.includes(phrase);
      if (exactPhrase) score += 4;

      const titleTokens = new Set(baseTokens(document.name));
      for (const term of qTerms) {
        if (!titleTokens.has(term)) continue;
        score += literalTerms.has(term) ? 0.9 : 0.35;
      }

      score += intentBoost(query, chunk.text);
      score += conceptMatches.length * 0.55;

      let enoughSupport = exactPhrase;
      if (!enoughSupport && concepts.length) {
        enoughSupport = literalMatches > 0 || expandedMatches >= 2;
      } else if (!enoughSupport && literalTerms.size <= 2) {
        enoughSupport = literalMatches >= 1 || expandedMatches >= 2;
      } else if (!enoughSupport) {
        enoughSupport = literalMatches >= 2 || (literalMatches >= 1 && expandedMatches >= 2) || expandedMatches >= 3;
      }

      return { chunk, document, score, enoughSupport, conceptMatches };
    })
    .filter((hit) => hit.enoughSupport && hit.score > 0.5)
    .sort((a, b) => b.score - a.score);

  if (concepts.length <= 1 || ranked.length <= 1) {
    return ranked.slice(0, cappedLimit).map(({ chunk, document, score }) => ({ chunk, document, score }));
  }

  const selected: typeof ranked = [];
  const seenChunks = new Set<string>();
  const coveredConcepts = new Set<number>();
  const add = (hit: (typeof ranked)[number]) => {
    if (seenChunks.has(hit.chunk.id) || selected.length >= cappedLimit) return;
    selected.push(hit);
    seenChunks.add(hit.chunk.id);
    hit.conceptMatches.forEach((index) => coveredConcepts.add(index));
  };

  if (ranked[0]) add(ranked[0]);
  for (let index = 0; index < concepts.length && selected.length < cappedLimit; index += 1) {
    if (coveredConcepts.has(index)) continue;
    const hit = ranked.find((candidate) => candidate.conceptMatches.includes(index) && !seenChunks.has(candidate.chunk.id));
    if (hit) add(hit);
  }
  for (const hit of ranked) add(hit);

  return selected.map(({ chunk, document, score }) => ({ chunk, document, score }));
}
