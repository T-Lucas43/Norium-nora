"""Masked OpenAI embeddings, scoped PostgreSQL storage, lexical fallback by callers."""
from __future__ import annotations
import asyncio
import hashlib
import json
import math
import os
import time
import httpx
from app.core.ai_guardrails import minimize_for_ai
from app.core.ai_provider_policy import approved_provider
from app.core.request_context import current_workspace_id
from app.core.identity import require_user_id, require_team_id
from app.infrastructure.persistence import postgres_store
from app.services.ai_costs import Meter

MODEL = "text-embedding-3-small"
SCHEMA = """CREATE TABLE IF NOT EXISTS nora_knowledge_embeddings (
 tenant TEXT NOT NULL,user_id TEXT NOT NULL,workspace TEXT NOT NULL,entry_id TEXT NOT NULL,
 content_digest TEXT NOT NULL,model TEXT NOT NULL,embedding TEXT NOT NULL,updated_at DOUBLE PRECISION NOT NULL,
 PRIMARY KEY(tenant,user_id,workspace,entry_id))"""


async def embed(user, texts, *, client_factory=httpx.AsyncClient):
    approved_provider(user, {"provider":"openai"})
    if not texts or len(texts) > 64:
        raise ValueError("Embedding batch must contain 1-64 chunks")
    key = os.getenv("OPENAI_API_KEY", "")
    if not key:
        raise ValueError("embeddings_not_configured")
    masked = [minimize_for_ai(str(text), max_chars=8000) for text in texts]
    async with Meter({"provider":"openai", "model":MODEL, "managed":True}, masked, 1,
                     user_id=require_user_id(user), source="knowledge-embedding") as meter:
        meter.sent()
        async with client_factory(timeout=30, follow_redirects=False) as client:
            response = await client.post("https://api.openai.com/v1/embeddings",
                headers={"Authorization":"Bearer " + key},
                json={"input":masked, "model":MODEL, "dimensions":256, "encoding_format":"float"})
        if response.status_code != 200:
            meter.rejected()
            raise ValueError("embedding_provider_unavailable")
        body = response.json()
        vectors = [row["embedding"] for row in sorted(body.get("data", []), key=lambda row:row["index"])]
        if len(vectors) != len(texts) or any(len(v) != 256 or any(not isinstance(n,(int,float)) or not math.isfinite(n) for n in v) for v in vectors):
            raise ValueError("invalid_embedding_response")
        tokens = (body.get("usage") or {}).get("prompt_tokens")
        if not isinstance(tokens, int) or tokens < 0:
            raise ValueError("embedding_usage_unknown")
        await meter.record({"model":MODEL,"usage":{"input_tokens":tokens,"output_tokens":0}})
        return vectors


def digest(text):
    return hashlib.sha256(minimize_for_ai(str(text), max_chars=8000).encode()).hexdigest()


def write_vectors(user, chunks, vectors):
    if not postgres_store.configured():
        raise ValueError("embedding_postgresql_required")
    scope = (require_team_id(user), require_user_id(user), current_workspace_id())
    with postgres_store.connection() as db:
        db.execute(SCHEMA)
        for chunk, vector in zip(chunks, vectors):
            db.execute("""INSERT INTO nora_knowledge_embeddings VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT(tenant,user_id,workspace,entry_id) DO UPDATE SET
                content_digest=EXCLUDED.content_digest,model=EXCLUDED.model,embedding=EXCLUDED.embedding,updated_at=EXCLUDED.updated_at""",
                (*scope, chunk["id"], digest(chunk["text"]), MODEL, json.dumps(vector), time.time()))


def read_vectors(user, chunks):
    if not postgres_store.configured():
        return {}
    with postgres_store.connection() as db:
        db.execute(SCHEMA)
        rows = db.execute("SELECT entry_id,content_digest,model,embedding FROM nora_knowledge_embeddings WHERE tenant=%s AND user_id=%s AND workspace=%s",
            (require_team_id(user), require_user_id(user), current_workspace_id())).fetchall()
    valid = {c["id"]:digest(c["text"]) for c in chunks}
    return {r["entry_id"]:json.loads(r["embedding"]) for r in rows
            if r["model"] == MODEL and valid.get(r["entry_id"]) == r["content_digest"]}


async def ensure_vectors(user, chunks):
    existing = await asyncio.to_thread(read_vectors, user, chunks)
    missing = [c for c in chunks if c["id"] not in existing]
    for offset in range(0, len(missing), 32):
        batch = missing[offset:offset+32]
        vectors = await embed(user, [c["text"] for c in batch])
        await asyncio.to_thread(write_vectors, user, batch, vectors)
        existing.update({c["id"]:v for c,v in zip(batch,vectors)})
    return existing


def cosine(a,b):
    if len(a) != len(b):
        return 0
    denominator = math.sqrt(sum(v*v for v in a) * sum(v*v for v in b))
    return sum(x*y for x,y in zip(a,b)) / denominator if denominator else 0
