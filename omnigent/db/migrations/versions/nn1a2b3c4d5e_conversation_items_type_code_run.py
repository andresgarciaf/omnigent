"""admit the code_run item type in conversation_items

Revision ID: nn1a2b3c4d5e
Revises: mm1a2b3c4d5e
Create Date: 2026-10-16 00:00:00.000000

Widens ``ck_conversation_items_type`` to accept ``12`` (``code_run``, a chat
code block run, see ``omnigent.db.enum_codecs.ITEM_TYPE``). Uses the batch
recipe from ``u1a2b3c4d5e6``: ``render_as_batch`` rebuilds the SQLite table so
the constraint swap lands; other dialects drop and re-add the constraint.

Deployment: additive; older application code never writes code 12. Roll back
by downgrading this revision, which deletes ``code_run`` rows first: older code
cannot decode them, and the narrower ``CHECK`` would refuse them.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Literal

from alembic import op

revision: str = "nn1a2b3c4d5e"
down_revision: str | None = "mm1a2b3c4d5e"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "conversation_items"
_CHECK = "ck_conversation_items_type"
# Pinned here rather than read from enum_codecs so the migration keeps the
# codes it was written against.
_CODE_RUN = 12
_PRIOR_CODES = tuple(range(1, _CODE_RUN))


def _set_type_check(codes: Sequence[int]) -> None:
    """Replace the item type ``CHECK`` with one admitting ``codes``."""
    recreate: Literal["always", "auto"] = (
        "always" if op.get_bind().dialect.name == "sqlite" else "auto"
    )
    with op.batch_alter_table(_TABLE, recreate=recreate) as batch_op:
        batch_op.drop_constraint(_CHECK, type_="check")
        batch_op.create_check_constraint(_CHECK, f"type IN ({', '.join(map(str, codes))})")


def upgrade() -> None:
    _set_type_check((*_PRIOR_CODES, _CODE_RUN))


def downgrade() -> None:
    op.execute(f"DELETE FROM {_TABLE} WHERE type = {_CODE_RUN}")
    _set_type_check(_PRIOR_CODES)
