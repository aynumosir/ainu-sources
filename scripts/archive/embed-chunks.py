# /// script
# requires-python = ">=3.11,<3.13"
# dependencies = ["sentence-transformers", "torch"]
# ///
"""Embed exported OCR chunks with bge-m3 into Vectorize ndjson shards.

The dense bge-m3 vectors here are what Workers AI's @cf/baai/bge-m3 computes
for queries at request time — same weights, so index and query live in one
space. Output shards go straight to `wrangler vectorize insert`.

Usage: uv run scripts/archive/embed-chunks.py chunks.jsonl out-dir
"""

import json
import sys
from pathlib import Path

import torch
from sentence_transformers import SentenceTransformer

SHARD_SIZE = 2500
BATCH_SIZE = 32

if len(sys.argv) != 3:
    print("usage: embed-chunks.py <chunks.jsonl> <out-dir>", file=sys.stderr)
    raise SystemExit(1)

chunks_path = Path(sys.argv[1])
out_dir = Path(sys.argv[2])
out_dir.mkdir(parents=True, exist_ok=True)

records = [json.loads(line) for line in chunks_path.open(encoding="utf-8")]
device = "cuda" if torch.cuda.is_available() else "cpu"
model = SentenceTransformer("BAAI/bge-m3", device=device)
print(f"device={device} chunks={len(records)}", file=sys.stderr)

for shard_index in range(0, len(records), SHARD_SIZE):
    shard = records[shard_index : shard_index + SHARD_SIZE]
    vectors = model.encode(
        [record["text"] for record in shard],
        batch_size=BATCH_SIZE,
        normalize_embeddings=True,
        show_progress_bar=False,
    )
    shard_path = out_dir / f"vectors-{shard_index // SHARD_SIZE:04d}.ndjson"
    with shard_path.open("w", encoding="utf-8") as f:
        for record, vector in zip(shard, vectors):
            f.write(json.dumps({"id": record["id"], "values": [round(float(v), 6) for v in vector]}) + "\n")
    print(f"{shard_path.name}: {len(shard)} vectors", file=sys.stderr)

print(json.dumps({"chunks": len(records), "shards": (len(records) + SHARD_SIZE - 1) // SHARD_SIZE}))
