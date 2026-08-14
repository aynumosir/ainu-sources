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

import hashlib
import json
import os
import sys
import time
from pathlib import Path

import torch
from sentence_transformers import SentenceTransformer

SHARD_SIZE = 2500
BATCH_SIZE = 16
# bge-m3 accepts 8192 tokens, which at any useful batch size needs more VRAM
# than a desktop GPU has spare. Exported chunks are capped at 4,000 characters
# and 97% of them stay under 2,000; a 2,048-token window therefore covers a
# paragraph block whole, and truncates only the tail of the few chunks that
# carry a work's entire text, where a single vector is a coarse summary either
# way. Peak use at this setting is about 2.4 GiB.
MAX_SEQ_TOKENS = 2048
# Resuming a run skips shards already written, so an interrupted backfill costs
# only the shard it was in the middle of. A shard file appears under its final
# name only once it is complete, and the manifest ties the directory to one
# input: shard files are positional, so reusing a directory across different
# exports would keep vectors for chunks the new export no longer holds and
# leave the chunks now in those positions unembedded.
RESUME = True

if len(sys.argv) != 3:
    print("usage: embed-chunks.py <chunks.jsonl> <out-dir>", file=sys.stderr)
    raise SystemExit(1)

chunks_path = Path(sys.argv[1])
out_dir = Path(sys.argv[2])
out_dir.mkdir(parents=True, exist_ok=True)

records = [json.loads(line) for line in chunks_path.open(encoding="utf-8")]

digest = hashlib.sha256()
with chunks_path.open("rb") as f:
    for block in iter(lambda: f.read(1 << 20), b""):
        digest.update(block)
manifest = {"input_sha256": digest.hexdigest(), "chunks": len(records), "shard_size": SHARD_SIZE}
manifest_path = out_dir / "manifest.json"
if manifest_path.exists():
    previous = json.loads(manifest_path.read_text(encoding="utf-8"))
    if previous != manifest:
        print(
            f"{out_dir} holds shards for a different export ({previous}); embed into a fresh directory",
            file=sys.stderr,
        )
        raise SystemExit(1)
else:
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

device = os.environ.get("EMBED_DEVICE") or ("cuda" if torch.cuda.is_available() else "cpu")
batch_size = int(os.environ.get("EMBED_BATCH_SIZE", BATCH_SIZE))
model = SentenceTransformer("BAAI/bge-m3", device=device)
model.max_seq_length = MAX_SEQ_TOKENS
print(f"device={device} batch={batch_size} chunks={len(records)} window={MAX_SEQ_TOKENS}", file=sys.stderr)


def encode(texts: list[str]) -> list:
    """Encode a shard, backing off when the GPU is short of memory.

    A desktop GPU is shared: another program can claim most of the card
    mid-run, and the batch that was comfortable a minute ago then fails. Each
    failure halves the batch and waits for the other program to settle, so a
    long backfill rides out the squeeze instead of dying at shard 23.
    """
    size = batch_size
    for attempt in range(6):
        try:
            return model.encode(texts, batch_size=size, normalize_embeddings=True, show_progress_bar=False)
        except (torch.cuda.OutOfMemoryError, RuntimeError) as error:
            if device != "cuda" or "CUDA" not in str(error) and "memory" not in str(error):
                raise
            torch.cuda.empty_cache()
            size = max(1, size // 2)
            wait = 15 * (attempt + 1)
            print(f"  GPU busy ({str(error).splitlines()[0][:80]}); retrying at batch {size} in {wait}s", file=sys.stderr)
            time.sleep(wait)
    raise SystemExit("the GPU stayed unavailable across six attempts; rerun with EMBED_DEVICE=cpu to finish on CPU")


for shard_index in range(0, len(records), SHARD_SIZE):
    shard = records[shard_index : shard_index + SHARD_SIZE]
    shard_path = out_dir / f"vectors-{shard_index // SHARD_SIZE:04d}.ndjson"
    if RESUME and shard_path.exists():
        print(f"{shard_path.name}: kept", file=sys.stderr)
        continue
    vectors = encode([record["text"] for record in shard])
    partial_path = shard_path.with_suffix(".ndjson.partial")
    with partial_path.open("w", encoding="utf-8") as f:
        for record, vector in zip(shard, vectors):
            f.write(json.dumps({"id": record["id"], "values": [round(float(v), 6) for v in vector]}) + "\n")
        f.flush()
        os.fsync(f.fileno())
    os.replace(partial_path, shard_path)
    print(f"{shard_path.name}: {len(shard)} vectors", file=sys.stderr)

print(json.dumps({"chunks": len(records), "shards": (len(records) + SHARD_SIZE - 1) // SHARD_SIZE}))
