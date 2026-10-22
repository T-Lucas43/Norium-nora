"""One document commit, with locked read dependencies and inbox authority."""
from __future__ import annotations

import copy
from contextlib import ExitStack
from pathlib import Path

from app.core.tenant import read_json_file, write_json_file
from app.infrastructure.persistence import document_cache, postgres_store
from app.infrastructure.persistence.json_repository import _lock_for, validate_shape


def atomic_document(path: Path, fallback: dict, operation, *, reads=(), grant=None, ids=()):
    """Callbacks cannot write other documents or call an external provider.

    Lock order: quota, inbox authority, document keys. Only `path` is written;
    dependencies are locked against concurrent edits until the commit finishes.
    """
    from app.modules.whatsapp_team import access, repository, schema

    def check(value):
        if grant is not None:
            for identifier in ids:
                access.assert_conversation(grant, value, identifier)

    documents = [(path, fallback), *reads]
    if postgres_store.configured() or postgres_store.required():
        from psycopg.types.json import Jsonb
        postgres_store.initialize()
        keys = {postgres_store.canonical_key(item): default for item, default in documents}
        target = postgres_store.canonical_key(path)
        try:
            with postgres_store.connection() as db:
                postgres_store._quota_lock(db)
                if grant is not None:
                    schema.initialize(db)
                    check(repository._read(db, grant.scope, lock=True))
                values = {}
                for key in sorted(keys):
                    db.execute("INSERT INTO norium_documents(store_key,payload) VALUES (%s,%s) ON CONFLICT DO NOTHING", (key, Jsonb(keys[key])))
                    row = db.execute("SELECT payload FROM norium_documents WHERE store_key=%s FOR UPDATE", (key,)).fetchone()
                    values[key] = copy.deepcopy(row["payload"])
                    validate_shape(values[key], keys[key], Path(key))
                result = operation(values[target], [values[postgres_store.canonical_key(item)] for item, _ in reads])
                postgres_store.check_document_growth(db, target, values[target])
                db.execute("UPDATE norium_documents SET payload=%s,revision=revision+1,updated_at=clock_timestamp() WHERE store_key=%s", (Jsonb(values[target]), target))
            return result
        finally:
            for key in keys:
                document_cache.forget(key)
    with ExitStack() as stack:
        if grant is not None:
            stack.enter_context(_lock_for(grant.scope.file_path()))
            check(repository.snapshot(grant.scope))
        for item in sorted({item for item, _ in documents}, key=str):
            stack.enter_context(_lock_for(item))
        values = {item: copy.deepcopy(read_json_file(item, default)) for item, default in documents}
        for item, default in documents:
            validate_shape(values[item], default, item)
        result = operation(values[path], [values[item] for item, _ in reads])
        write_json_file(path, values[path])
        return result
