"""The server attaches the code-run notice to the message it forwards."""

from __future__ import annotations

import dataclasses
import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from omnigent.entities import CodeRunData, MessageData, NewConversationItem
from omnigent.inner.native_attachments import FRAMEWORK_NOTICE_BLOCK_TYPE
from omnigent.server.routes._sessions import orchestration
from omnigent.server.schemas import SessionEventInput
from omnigent.stores.conversation_store.sqlalchemy_store import SqlAlchemyConversationStore

pytestmark = pytest.mark.asyncio

_TYPED = [{"type": "input_text", "text": "why did it fail?"}]


def _store_with_finished_run(tmp_path: Path, *, wrapper: str | None = None) -> tuple[Any, Any]:
    store = SqlAlchemyConversationStore(f"sqlite:///{tmp_path / 'chat.db'}")
    conv = store.create_conversation(title="code runs")
    if wrapper is not None:
        conv = dataclasses.replace(conv, labels={"omnigent.wrapper": wrapper})
    store.append(
        conv.id,
        [
            NewConversationItem(
                type="message",
                response_id="resp_1",
                data=MessageData(
                    role="assistant",
                    agent="coder",
                    content=[{"type": "output_text", "text": "```bash\nfalse\n```"}],
                ),
            ),
            NewConversationItem(
                type="code_run",
                response_id="code_run",
                data=CodeRunData(
                    run_id="run_1",
                    phase="started",
                    message_id="msg_1",
                    block_hash="h1",
                    language="shell",
                    command="false",
                    timeout=120,
                    started_at=1,
                ),
            ),
            NewConversationItem(
                type="code_run",
                response_id="code_run",
                data=CodeRunData(
                    run_id="run_1",
                    phase="finished",
                    status="exited",
                    exit_code=1,
                    duration_ms=20,
                    output=[{"stream": "stderr", "text": "boom\n"}],
                    truncated=False,
                ),
            ),
        ],
    )
    return store, conv


def _capturing_runner(bodies: list[dict[str, Any]]) -> httpx.AsyncClient:
    def _handler(request: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(request.content))
        return httpx.Response(202, json={"queued": True})

    return httpx.AsyncClient(
        base_url="http://runner.test", transport=httpx.MockTransport(_handler)
    )


def _notices(content: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [block for block in content if block.get("type") == FRAMEWORK_NOTICE_BLOCK_TYPE]


def _message() -> SessionEventInput:
    return SessionEventInput(type="message", data={"role": "user", "content": _TYPED})


async def test_sdk_forward_carries_the_notice_and_stores_the_message_as_typed(
    tmp_path: Path,
) -> None:
    store, conv = _store_with_finished_run(tmp_path)
    bodies: list[dict[str, Any]] = []

    async with _capturing_runner(bodies) as runner_client:
        item_id = await orchestration._forward_event_to_runner(
            conv.id, conv, _message(), store, runner_client
        )

    forwarded = bodies[-1]["content"]
    assert forwarded[: len(_TYPED)] == _TYPED
    [notice] = _notices(forwarded)
    assert "boom" in notice["text"]
    assert "exit code 1" in notice["text"]
    stored = store.get_item(conv.id, item_id)
    assert stored is not None
    assert stored.data.content == _TYPED


async def test_sdk_forward_without_runs_adds_no_notice(tmp_path: Path) -> None:
    store = SqlAlchemyConversationStore(f"sqlite:///{tmp_path / 'chat.db'}")
    conv = store.create_conversation(title="no runs")
    bodies: list[dict[str, Any]] = []

    async with _capturing_runner(bodies) as runner_client:
        await orchestration._forward_event_to_runner(
            conv.id, conv, _message(), store, runner_client
        )

    assert bodies[-1]["content"] == _TYPED


@pytest.mark.parametrize(
    ("wrapper", "delivered"),
    [("codex-native-ui", True), ("claude-code-native-ui", True), ("kiro-native-ui", False)],
)
async def test_native_forward_carries_the_notice_for_harnesses_that_read_it(
    tmp_path: Path, wrapper: str, delivered: bool
) -> None:
    store, conv = _store_with_finished_run(tmp_path, wrapper=wrapper)
    bodies: list[dict[str, Any]] = []

    async with _capturing_runner(bodies) as runner_client:
        await orchestration._forward_native_terminal_message(
            runner_client, conv.id, conv, _message(), conversation_store=store
        )

    forwarded = bodies[-1]["content"]
    assert forwarded[: len(_TYPED)] == _TYPED
    assert bool(_notices(forwarded)) is delivered
