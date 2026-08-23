import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { rankCandidates } from "../src/lib/ranking.ts";
import { baseTokens, queryTokens } from "../src/lib/text-search.ts";
import type { Chunk, KnowledgeDocument } from "../src/lib/types.ts";

type BeirDoc = { _id: string; title?: string; text: string };
type BeirQuery = { _id: string; text: string };
type PreparedDoc = {
  id: string;
  allTokens: string[];
  bodyTokenSet: Set<string>;
  termCounts: Map<string, number>;
  document: KnowledgeDocument;
  chunk: Chunk;
};
type RankedItem = { id: string; score: number };
type Run = Map<string, RankedItem[]>;
type Qrels = Map<string, Map<string, number>>;

const datasetDir = process.env.BEIR_DATASET_DIR;
const datasetName = process.env.BENCH_DATASET ?? path.basename(datasetDir ?? "unknown");
const outputPath = process.env.BENCH_OUTPUT ?? path.join("benchmark-results", `${datasetName}.json`);
const candidateLimit = 350;
const resultLimit = 20;
if (!datasetDir) throw new Error("BEIR_DATASET_DIR is required");

function readJsonl<T>(filePath: string): T[] {
  return fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as T);
}

function loadQrels(filePath: string): Qrels {
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
  const qrels: Qrels = new Map();
  for (const line of lines.slice(1)) {
    const [queryId, corpusId, scoreText] = line.split("\t");
    const score = Number(scoreText);
    if (!queryId || !corpusId || !Number.isFinite(score) || score <= 0) continue;
    if (!qrels.has(queryId)) qrels.set(queryId, new Map());
    qrels.get(queryId)!.set(corpusId, score);
  }
  return qrels;
}

function knowledgeDocument(doc: BeirDoc): KnowledgeDocument {
  return {
    id: doc._id,
    name: doc.title?.trim() || doc._id,
    originalName: doc.title?.trim() || doc._id,
    mimeType: "text/plain",
    size: Buffer.byteLength(doc.text, "utf8"),
    contentHash: `beir-${doc._id}`,
    status: "approved",
    uploadedAt: "1970-01-01T00:00:00.000Z",
    inspection: {
      wordCount: doc.text.split(/\s+/).filter(Boolean).length,
      possiblePersonalInfo: false,
      possibleSupersededLanguage: false,
      possibleSecrets: false,
      possiblePromptInjection: false,
      lowTextContent: false,
      notes: [],
    },
  };
}

function counts(tokens: string[]) {
  const result = new Map<string, number>();
  for (const token of tokens) result.set(token, (result.get(token) ?? 0) + 1);
  return result;
}

function prepareCorpus(corpus: BeirDoc[]): PreparedDoc[] {
  return corpus.map((doc) => {
    const bodyTokens = baseTokens(doc.text);
    const allTokens = baseTokens(`${doc.title?.trim() ?? ""} ${doc.text}`);
    const document = knowledgeDocument(doc);
    const chunk: Chunk = { id: `beir-${doc._id}`, documentId: doc._id, index: 0, text: doc.text };
    return { id: doc._id, allTokens, bodyTokenSet: new Set(bodyTokens), termCounts: counts(allTokens), document, chunk };
  });
}

function productionCandidatePool(query: string, corpus: PreparedDoc[]) {
  const terms = queryTokens(query);
  if (!terms.length) return [];
  return corpus.map((doc) => ({ doc, overlap: terms.reduce((sum, term) => sum + (doc.bodyTokenSet.has(term) ? 1 : 0), 0) }))
    .filter((item) => item.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap || a.doc.id.localeCompare(b.doc.id))
    .slice(0, candidateLimit)
    .map(({ doc }) => ({ document: doc.document, chunk: doc.chunk }));
}

function buildBm25Stats(corpus: PreparedDoc[]) {
  const documentFrequency = new Map<string, number>();
  let totalLength = 0;
  for (const doc of corpus) {
    totalLength += doc.allTokens.length;
    for (const token of new Set(doc.allTokens)) documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
  }
  return { documentFrequency, averageLength: totalLength / Math.max(corpus.length, 1) };
}

function plainBm25(query: string, corpus: PreparedDoc[], stats: ReturnType<typeof buildBm25Stats>): RankedItem[] {
  const terms = [...new Set(baseTokens(query))];
  if (!terms.length) return [];
  const k1 = 1.2;
  const b = 0.75;
  const n = corpus.length;
  const ranked: RankedItem[] = [];
  for (const doc of corpus) {
    let score = 0;
    for (const term of terms) {
      const tf = doc.termCounts.get(term) ?? 0;
      if (!tf) continue;
      const df = stats.documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      const denom = tf + k1 * (1 - b + b * (doc.allTokens.length / Math.max(stats.averageLength, 1)));
      score += idf * ((tf * (k1 + 1)) / denom);
    }
    if (score > 0) ranked.push({ id: doc.id, score });
  }
  return ranked.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, resultLimit);
}

function percentile(values: number[], p: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

function dcg(items: RankedItem[], relevant: Map<string, number>, k: number) {
  let value = 0;
  for (let i = 0; i < Math.min(k, items.length); i += 1) {
    const relevance = relevant.get(items[i].id) ?? 0;
    if (relevance > 0) value += (2 ** relevance - 1) / Math.log2(i + 2);
  }
  return value;
}

function idealDcg(relevant: Map<string, number>, k: number) {
  return [...relevant.values()].sort((a, b) => b - a).slice(0, k)
    .reduce((sum, relevance, index) => sum + (2 ** relevance - 1) / Math.log2(index + 2), 0);
}

function evaluate(run: Run, qrels: Qrels) {
  let hit1 = 0, recall3 = 0, recall10 = 0, recall20 = 0, mrr10 = 0, ndcg10 = 0, map10 = 0, returnedAny = 0, evaluated = 0;
  for (const [queryId, relevant] of qrels) {
    if (!relevant.size) continue;
    evaluated += 1;
    const items = run.get(queryId) ?? [];
    if (items.length) returnedAny += 1;
    if (items[0] && relevant.has(items[0].id)) hit1 += 1;
    const recallAt = (k: number) => items.slice(0, k).filter((item) => relevant.has(item.id)).length / relevant.size;
    recall3 += recallAt(3); recall10 += recallAt(10); recall20 += recallAt(20);
    const firstRelevant = items.slice(0, 10).findIndex((item) => relevant.has(item.id));
    if (firstRelevant >= 0) mrr10 += 1 / (firstRelevant + 1);
    const ideal = idealDcg(relevant, 10);
    if (ideal > 0) ndcg10 += dcg(items, relevant, 10) / ideal;
    let found = 0, precisionSum = 0;
    items.slice(0, 10).forEach((item, index) => {
      if (!relevant.has(item.id)) return;
      found += 1; precisionSum += found / (index + 1);
    });
    map10 += precisionSum / Math.min(relevant.size, 10);
  }
  const divide = (value: number) => evaluated ? value / evaluated : 0;
  return { queries: evaluated, hitAt1: divide(hit1), recallAt3: divide(recall3), recallAt10: divide(recall10), recallAt20: divide(recall20), mrrAt10: divide(mrr10), ndcgAt10: divide(ndcg10), mapAt10: divide(map10), queryCoverage: divide(returnedAny) };
}

const corpus = readJsonl<BeirDoc>(path.join(datasetDir, "corpus.jsonl"));
const queries = readJsonl<BeirQuery>(path.join(datasetDir, "queries.jsonl"));
const qrels = loadQrels(path.join(datasetDir, "qrels", "test.tsv"));
const queryMap = new Map(queries.map((query) => [query._id, query.text]));
const prepared = prepareCorpus(corpus);
const bm25Stats = buildBm25Stats(prepared);
const productionRun: Run = new Map(), bm25Run: Run = new Map();
const productionTimes: number[] = [], bm25Times: number[] = [];

for (const queryId of qrels.keys()) {
  const query = queryMap.get(queryId);
  if (!query) continue;
  const productionStart = performance.now();
  const candidates = productionCandidatePool(query, prepared);
  const hits = rankCandidates(query, candidates, resultLimit);
  productionTimes.push(performance.now() - productionStart);
  productionRun.set(queryId, hits.map((hit) => ({ id: hit.document.id, score: hit.score })));
  const bm25Start = performance.now();
  bm25Run.set(queryId, plainBm25(query, prepared, bm25Stats));
  bm25Times.push(performance.now() - bm25Start);
}

const report = {
  benchmark: "BEIR public retrieval benchmark",
  dataset: datasetName,
  corpusDocuments: corpus.length,
  testQueries: qrels.size,
  generatedAt: new Date().toISOString(),
  gitSha: process.env.GITHUB_SHA ?? null,
  node: process.version,
  productionConfiguration: { candidateLimit, resultLimit, candidateSelection: "plaintext equality-equivalent of production blind-index overlap prefilter", rankingModule: "src/lib/ranking.ts", externalModel: false, externalApi: false, embeddings: false },
  systems: {
    deterministicProductionRetriever: { metrics: evaluate(productionRun, qrels), latencyMs: { p50: percentile(productionTimes, 0.5), p95: percentile(productionTimes, 0.95) } },
    localBm25Baseline: { description: "Plain BM25 over title + body using the same base tokenizer; not an official Pyserini/BEIR leaderboard run.", metrics: evaluate(bm25Run, qrels), latencyMs: { p50: percentile(bm25Times, 0.5), p95: percentile(bm25Times, 0.95) } },
  },
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
const markdownPath = outputPath.replace(/\.json$/i, ".md");
const pct = (value: number) => `${(value * 100).toFixed(2)}%`;
const ours = report.systems.deterministicProductionRetriever.metrics;
const baseline = report.systems.localBm25Baseline.metrics;
const markdown = `# Public retrieval benchmark — ${datasetName}\n\nCorpus: ${corpus.length.toLocaleString()} documents  \nTest queries: ${qrels.size.toLocaleString()}  \nCandidate limit: ${candidateLimit}  \nResult limit: ${resultLimit}\n\n| Metric | Deterministic retriever | Local BM25 baseline |\n|---|---:|---:|\n| Hit@1 | ${pct(ours.hitAt1)} | ${pct(baseline.hitAt1)} |\n| Recall@3 | ${pct(ours.recallAt3)} | ${pct(baseline.recallAt3)} |\n| Recall@10 | ${pct(ours.recallAt10)} | ${pct(baseline.recallAt10)} |\n| Recall@20 | ${pct(ours.recallAt20)} | ${pct(baseline.recallAt20)} |\n| MRR@10 | ${ours.mrrAt10.toFixed(4)} | ${baseline.mrrAt10.toFixed(4)} |\n| nDCG@10 | ${ours.ndcgAt10.toFixed(4)} | ${baseline.ndcgAt10.toFixed(4)} |\n| MAP@10 | ${ours.mapAt10.toFixed(4)} | ${baseline.mapAt10.toFixed(4)} |\n| Query coverage | ${pct(ours.queryCoverage)} | ${pct(baseline.queryCoverage)} |\n\nThe BM25 column is a local control implemented in this harness, not an official BEIR/Pyserini leaderboard score.\n`;
fs.writeFileSync(markdownPath, markdown);
console.log(markdown);
