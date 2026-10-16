"""Tests for the migration admitting the ``code_run`` item type (``nn1a2b3c4d5e``).

Runs on SQLite always and on PostgreSQL when ``OMNIGENT_TEST_DB_URI`` points
at one. Checks the widened ``CHECK`` admits code 12 and still rejects unknown
codes, the table rebuild keeps the key and indexes, and the downgrade removes
``code_run`` rows before restoring the narrower ``CHECK``.
"""

from __future__ import annotations

import os
import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
import sqlalchemy as sa
from alembic import command
from sqlalchemy.engine import Engine

from omnigent.db.utils import _build_alembic_config, clear_engine_cache

_PRIOR = "mm1a2b3c4d5e"
_THIS = "nn1a2b3c4d5e"
_CONVERSATION = uuid.uuid4().bytes


def _postgres_uri() -> str | None:
    uri = os.environ.get("OMNIGENT_TEST_DB_URI", "")
    return uri if uri.startswith("postgresql") else None


@pytest.fixture(params=["sqlite", "postgresql"])
def engine(request: pytest.FixtureRequest, tmp_path: Path) -> Iterator[Engine]:
    """Engine on a fresh database migrated to the revision before this one."""
    admin = None
    if request.param == "sqlite":
        uri = f"sqlite:///{tmp_path / 'test.db'}"
    else:
        root_uri = _postgres_uri()
        if root_uri is None:
            pytest.skip("needs PostgreSQL (OMNIGENT_TEST_DB_URI)")
        name = f"nn1_code_run_{os.getpid()}"
        root = sa.make_url(root_uri)
        uri = root.set(database=name).render_as_string(hide_password=False)
        admin = sa.create_engine(root, isolation_level="AUTOCOMMIT")
        with admin.connect() as conn:
            conn.execute(sa.text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
            conn.execute(sa.text(f'CREATE DATABASE "{name}"'))
    engine = sa.create_engine(uri)
    _migrate(engine, command.upgrade, _PRIOR)
    try:
        yield engine
    finally:
        engine.dispose()
        clear_engine_cache()
        if admin is not None:
            with admin.connect() as conn:
                conn.execute(sa.text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
            admin.dispose()


def _migrate(engine: Engine, step: Any, target: str) -> None:
    cfg = _build_alembic_config(engine.url.render_as_string(hide_password=False))
    # A plain connection lets Alembic own transactions, as _run_migrations does;
    # earlier revisions open autocommit blocks for concurrent index builds.
    with engine.connect() as conn:
        cfg.attributes["connection"] = conn
        step(cfg, target)
        conn.commit()
    # Drop pooled connections so later reflection sees the migrated schema.
    engine.dispose()


def _insert_item(engine: Engine, type_code: int, position: int) -> None:
    with engine.begin() as conn:
        conn.execute(
            sa.text(
                "INSERT INTO conversation_items (workspace_id, conversation_id, id, "
                "response_id, created_at, status, position, type, data, search_text) "
                "VALUES (0, :conversation, :id, 'resp_1', 1, 1, :position, :type, '{}', '')"
            ),
            {
                "conversation": _CONVERSATION,
                "id": uuid.uuid4().bytes,
                "position": position,
                "type": type_code,
            },
        )


def _item_types(engine: Engine) -> list[int]:
    with engine.connect() as conn:
        rows = conn.execute(sa.text("SELECT type FROM conversation_items ORDER BY position"))
        return [row[0] for row in rows]


def _key_and_indexes(engine: Engine) -> tuple[Any, ...]:
    inspector = sa.inspect(engine)
    indexes = sorted(
        (index["name"], tuple(index["column_names"]), index["unique"])
        for index in inspector.get_indexes("conversation_items")
    )
    primary_key = inspector.get_pk_constraint("conversation_items")["constrained_columns"]
    return tuple(primary_key), tuple(indexes)


def test_upgrade_admits_code_run_type(engine: Engine) -> None:
    """Code 12 is rejected before the migration and accepted after it."""
    with pytest.raises(sa.exc.IntegrityError):
        _insert_item(engine, type_code=12, position=0)
    _insert_item(engine, type_code=1, position=1)
    schema_before = _key_and_indexes(engine)

    _migrate(engine, command.upgrade, _THIS)

    _insert_item(engine, type_code=12, position=2)
    with pytest.raises(sa.exc.IntegrityError):
        _insert_item(engine, type_code=13, position=3)
    assert _item_types(engine) == [1, 12]
    assert _key_and_indexes(engine) == schema_before


def test_downgrade_removes_code_run_rows_and_restores_check(engine: Engine) -> None:
    """Downgrade deletes code 12 rows, keeps the rest, and rejects 12 again."""
    _migrate(engine, command.upgrade, _THIS)
    _insert_item(engine, type_code=11, position=0)
    _insert_item(engine, type_code=12, position=1)
    schema_at_head = _key_and_indexes(engine)

    _migrate(engine, command.downgrade, _PRIOR)

    assert _item_types(engine) == [11]
    with pytest.raises(sa.exc.IntegrityError):
        _insert_item(engine, type_code=12, position=2)
    assert _key_and_indexes(engine) == schema_at_head
