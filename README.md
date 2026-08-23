# Deterministic Retrieval Public Benchmark

Public, reproducible retrieval benchmark for a deterministic non-LLM document retriever.

The first benchmark revision is frozen from the private source implementation before observing a successful public BEIR score.

## Frozen source

- Source repository: private `DaddysCoder/rag-work`
- Source PR: `#16`
- Frozen source commit recorded for the benchmark: `54e41943d0fca5f050241a51cc28b43327c3652f`

Only the retrieval tokenizer/ranker and benchmark harness are reproduced here. No application database, encryption implementation, participant information, secrets, UI, ingestion pipeline, or proprietary operational data is included.

## Pre-registered public datasets

- BEIR SciFact
- BEIR NFCorpus
- BEIR ArguAna

## Fixed configuration

- Candidate prefilter: top 350 by equality-equivalent token overlap
- Results evaluated: top 20
- No embeddings
- No LLM
- No external inference API
- No model download

## Metrics

Hit@1, Recall@3, Recall@10, Recall@20, MRR@10, nDCG@10, MAP@10, query coverage, and p50/p95 retrieval latency.

A plain local BM25 implementation is included only as an internal control; it is not represented as an official Pyserini/BEIR leaderboard score.

The initial public scores must be recorded before any tuning against these datasets.
