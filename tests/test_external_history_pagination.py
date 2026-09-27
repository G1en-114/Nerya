"""Real temporary SQLite and route contracts; no model, MCP transport or network."""
import base64
import json
from pathlib import Path
from types import SimpleNamespace

import nerya
import pytest

from nerya.agent import external_history
from nerya.agent.history_mutations import delete_session, mutate_message
from nerya.api.routes_agent import routes
from nerya.core.paths import WorkspacePaths
from nerya.db.repositories import AgentSessionRepository
from nerya.db.sqlite import connect
from nerya.mcp.inbound_sessions import CallTrace, InboundSessions
from nerya.mcp.operator_messages import append_message

pytestmark = pytest.mark.smoke
SID = 'ext_mcp_' + 'a' * 32
OTHER = 'ext_mcp_' + 'b' * 32


@pytest.fixture
def history(tmp_path):
    assert Path(nerya.__file__).resolve().is_relative_to(Path.cwd())
    paths = WorkspacePaths(root=tmp_path)
    config = SimpleNamespace(paths=paths)
    con = connect(paths.db)
    repo = AgentSessionRepository(con)
    for sid in (SID, OTHER):
        repo.upsert_session(session_id=sid, source='mcp', title=sid, ts=10)
    yield SimpleNamespace(paths=paths, config=config, con=con, repo=repo)
    con.close()


def call_row(history, i, *, sid=SID, sequence=None, ts=100, status='succeeded'):
    cid = f'call-{i:04}'
    turn_id = 'turn-B' if i % 3 == 1 else 'turn-A'
    trace = {'call_id': cid, 'sequence': i + 1 if sequence is None else sequence,
             'source': 'mcp', 'remote_session_id': sid, 'turn_id': turn_id,
             'tool': 'nerya_native_read_file', 'status': status,
             'activity': {'next': f'Inspect {i}', 'conclusion': 'fixture'}, 'purpose': 'test only',
             'arguments': {'path': 'fixture.txt'}, 'result': {'ok': True, 'approval_id': f'approval-{i}'},
             'presentation_blocks': [{'type': 'chart', 'data': [i, i + 1]}],
             'nodes': [{'call_id': f'{cid}-node-{j}', 'parent_call_id': cid,
                        'tool': 'nerya_native_read_file' if j == 0 else 'child',
                        'arguments': {'path': 'fixture.txt'}, 'status': 'succeeded',
                        'result': {'text': 'x' * 300, 'approval_id': f'child-approval-{j}'},
                        'presentation_blocks': [{'type': 'artifact', 'id': j}]} for j in range(4)]}
    history.repo.record_message(message_id=cid + ':assistant', session_id=sid, role='assistant',
                                turn_id=turn_id, ts=ts, content='body' * 4000,
                                meta={'source': 'mcp', 'turn': {'harness': 'external', 'external_call': trace}})
    return trace


def page(history, sid=SID, **query):
    handler = next(handler for method, name, handler in routes()
                   if (method, name) == ('GET', '/agent/session/transcript'))
    return handler(SimpleNamespace(config=history.config), {'session_id': sid, **query})


def ids(response):
    return [m['message_id'] for m in response['messages']]


def test_thousand_calls_and_operator_messages_page_without_loss_or_split(history, monkeypatch):
    expected = []
    history.con.execute('BEGIN')
    for i in range(1000):
        trace = call_row(history, i, sequence=i * 2 + 1)
        expected.append(trace['call_id'] + ':assistant')
        if i % 100 == 0:
            mid = f'operator-{i}'
            history.repo.record_message(message_id=mid, session_id=SID, role='user', ts=100, content='operator',
                                        turn_id='turn-A', meta={'external_request': {'id': mid, 'sequence': i * 2 + 2, 'state': 'queued'}})
            expected.append(mid)
    history.con.execute('COMMIT')
    original = external_history._message
    decoded = []
    def observe(con, sid, row):
        decoded.append(row['message_id'])
        return original(con, sid, row)
    monkeypatch.setattr(external_history, '_message', observe)
    first = page(history)
    assert first['ok'] and first['limit'] == 60 and first['count'] == 60 and first['has_more']
    assert len(decoded) == 60  # No all-history payload materialization in Python.
    before, collected = None, []
    while True:
        result = page(history, limit=37, **({'before': before} if before else {}))
        assert result['ok'] and 0 < result['count'] <= 37
        collected = ids(result) + collected
        for message in result['messages']:
            if message['role'] == 'assistant':
                call = message['turn']['external_call']
                assert len(call['nodes']) == 4
                assert call['nodes'][0]['arguments'] == call['arguments']
                assert call['nodes'][3]['result']['approval_id'] == 'child-approval-3'
                assert call['activity']['conclusion'] == 'fixture' and call['presentation_blocks']
                assert len(message['content']) == 16000
        if not result['has_more']:
            assert result['next_before_cursor'] is None
            break
        assert result['next_before_cursor'] != before
        before = result['next_before_cursor']
    assert collected == expected and len(set(collected)) == 1010
    full = page(history, full='1', limit='invalid')
    assert full['ok'] and full['count'] == 1010 and not full['has_more']
    assert page(history, all='1')['count'] == 1010


def test_real_persist_refresh_retains_children_and_shared_turn(history):
    store = InboundSessions(history.config, None)
    first = CallTrace(store, SID, 'real-call', 'fixture-tool', {}, sequence=1, turn_id='turn-A', started_at=100)
    first.nodes = [{'call_id': 'mirror', 'parent_call_id': first.call_id, 'tool': first.tool, 'status': 'running'}]
    store.persist(first)
    initial = page(history)
    assert initial['messages'][0]['turn']['external_call']['status'] == 'running'
    for i in range(3):
        call_row(history, i, sequence=i + 2, ts=101 + i)
    cursor = page(history, limit=2)['next_before_cursor']
    first.status = 'awaiting_approval'
    first.result = {'error': {'code': 'approval_required', 'approval_id': 'real-approval'}}
    first.nodes[0]['status'] = 'awaiting_approval'
    first.nodes.append({'call_id': 'child', 'parent_call_id': 'mirror', 'tool': 'child', 'status': 'succeeded'})
    first.presentation_blocks = [{'type': 'chart', 'data': [1, 2]}]
    store.persist(first)
    refreshed = page(history, limit=2, refresh_call_ids='real-call')
    assert ids(refreshed) == ['call-0001:assistant', 'call-0002:assistant']
    actual = refreshed['refreshed_messages'][0]['turn']['external_call']
    assert actual == first.payload()
    older = page(history, limit=2, before=cursor)
    assert ids(older) == ['real-call:assistant', 'call-0000:assistant']
    assert not older['has_more']
    # Polling does not allocate another call/turn or deliver operator requests.
    added = append_message(history.config, {'session_id': SID, 'text': 'inspect only', 'client_request_id': 'operator-test'})
    operator = next(m for m in page(history)['messages'] if m['message_id'] == added['message']['id'])
    assert operator['meta']['external_request']['state'] == 'queued'
    anchored = page(history, limit=1, anchor_message_id=operator['message_id'])
    assert ids(anchored) == [operator['message_id']]
    assert history.con.execute('SELECT COUNT(*) FROM agent_messages WHERE session_id=?', (SID,)).fetchone()[0] == 5


def test_anchor_is_bounded_and_can_traverse_both_directions(history):
    for i in range(100):
        call_row(history, i)
    result = page(history, limit=7, anchor_call_id='call-0020')
    assert ids(result) == [f'call-{i:04}:assistant' for i in range(14, 21)]
    assert result['anchor_message_id'] == 'call-0020:assistant'
    assert result['has_more'] and result['has_newer']
    assert ids(page(history, limit=7, anchor_message_id='call-0020:assistant')) == ids(result)
    older = page(history, before=result['next_before_cursor'], limit=7)
    assert ids(older) == [f'call-{i:04}:assistant' for i in range(7, 14)]
    newer = page(history, after=result['next_after_cursor'], limit=7)
    assert ids(newer) == [f'call-{i:04}:assistant' for i in range(21, 28)]
    assert newer['has_newer']
    for target in ['call-9999', 'call-0020-node-1']:
        assert page(history, anchor_call_id=target)['code'] == 'external_anchor_not_found'


def test_sequence_then_timestamp_then_identity_not_turn_grouping(history):
    call_row(history, 2, sequence=1, ts=102)
    call_row(history, 1, sequence=1, ts=102)
    call_row(history, 0, sequence=1, ts=101)
    call_row(history, 3, sequence=2, ts=100)  # sequence survives a wall-clock reversal
    result = page(history)
    assert ids(result) == [f'call-{i:04}:assistant' for i in range(4)]
    assert [m['turn_id'] for m in result['messages']] == ['turn-A', 'turn-B', 'turn-A', 'turn-A']
    assert page(history, limit=1)['messages'][0]['turn']['external_call']['call_id'] == 'call-0003'


def test_after_poll_does_not_skip_burst_or_lose_empty_tail_cursor(history):
    call_row(history, 0)
    tail = page(history, limit=2)
    after = tail['next_after_cursor']
    assert after and not tail['has_newer']
    empty = page(history, after=after, limit=2)
    assert empty['messages'] == [] and empty['next_after_cursor'] == after
    for i in range(1, 8):
        call_row(history, i)
    read = []
    while True:
        result = page(history, after=after, limit=2)
        read += ids(result)
        after = result['next_after_cursor']
        if not result['has_newer']:
            break
    assert read == [f'call-{i:04}:assistant' for i in range(1, 8)]


def test_session_filter_applies_to_anchor_cursor_and_refresh(history):
    call_row(history, 1)
    call_row(history, 2)
    cursor = page(history, limit=1)['next_before_cursor']
    assert page(history, sid=OTHER, before=cursor)['code'] == 'external_cursor_session_mismatch'
    assert page(history, sid=OTHER, anchor_message_id='call-0001:assistant')['code'] == 'external_anchor_not_found'
    assert page(history, sid=OTHER, anchor_call_id='call-0001')['code'] == 'external_anchor_not_found'
    foreign = page(history, sid=OTHER, refresh_call_ids=['call-0001'])
    assert foreign['messages'] == foreign['refreshed_messages'] == []
    assert foreign['missing_call_ids'] == ['call-0001']
    assert page(history, sid='ext_mcp_' + 'f' * 32)['code'] == 'external_session_not_found'


@pytest.mark.parametrize('value', ['', 'not-a-cursor', 'eyJ2IjoxfQ', 'x' * 2049, base64.b64encode(b'[0,1,2]').decode()])
def test_malformed_old_cursor_is_structured(history, value):
    result = page(history, before=value)
    assert not result['ok'] and result['code'] == 'invalid_external_cursor'
    assert result['messages'] == []


@pytest.mark.parametrize('value', [0, -1, 201, 'bogus', '1.5', True, 1.5])
def test_invalid_limits_do_not_enable_unbounded_reads(history, value):
    assert page(history, limit=value)['code'] == 'invalid_external_limit'


def test_conflicts_refresh_bounds_and_deleted_cursor(history):
    for i in range(3):
        call_row(history, i)
    result = page(history, limit=1)
    before = result['next_before_cursor']
    assert page(history, before=before, anchor_call_id='call-0001')['code'] == 'external_pagination_conflict'
    assert page(history, refresh_call_ids=['bad'] * 61)['code'] == 'invalid_external_refresh'
    history.repo.delete_message('call-0002:assistant')
    assert page(history, before=before)['code'] == 'external_cursor_not_found'
    assert page(history, anchor_call_id='call-0002')['code'] == 'external_anchor_not_found'
    assert page(history, refresh_call_ids='call-0002')['missing_call_ids'] == ['call-0002']


def test_operator_delete_invalidates_old_history_and_never_revives_journal(history):
    history.repo.record_message(message_id='operator', session_id=SID, role='user', ts=10, content='delete me',
                                meta={'external_request': {'sequence': 1, 'state': 'queued'}})
    call_row(history, 1, sequence=2)
    before = page(history, limit=1)['next_before_cursor']
    assert mutate_message(history.paths, {'session_id': SID, 'message_id': 'operator'}, delete=True)['ok']
    result = page(history, before=before)
    assert result['code'] == 'external_history_changed' and result['reset_required']
    assert page(history, anchor_message_id='operator')['code'] == 'external_anchor_not_found'
    assert ids(page(history)) == ['call-0001:assistant']
    assert delete_session(history.paths, {'session_id': SID})['ok']
    assert page(history)['code'] == 'session_deleted'
    assert page(history, before=before)['code'] == 'session_deleted'


def test_existing_normal_and_empty_external_contracts(history):
    empty = page(history)
    assert empty['ok'] and empty['messages'] == [] and not empty['has_more']
    assert empty['next_before_cursor'] is None and empty['pagination'] == 'external_calls_v1'
    history.repo.upsert_session(session_id='normal', source='user_chat')
    for i in range(5):
        history.repo.record_message(message_id=f'user-{i}', session_id='normal', role='user', content='hello', ts=100 + i)
    normal = page(history, sid='normal', max_pairs=1)
    assert normal['ok'] and normal['count'] == 2 and normal['has_more']
    assert 'pagination' not in normal


def test_tunnel_and_legacy_missing_sequence_remain_readable(history):
    sid = 'ext_tunnel_' + 'c' * 32
    history.repo.upsert_session(session_id=sid, source='tunnel')
    for i in range(3):
        call_row(history, i, sid=sid, sequence=0, ts=100 + i)
    tail = page(history, sid=sid, limit=1)
    assert tail['source'] == 'tunnel' and ids(tail) == ['call-0002:assistant']
    older = page(history, sid=sid, before=tail['next_before_cursor'])
    assert ids(older) == ['call-0000:assistant', 'call-0001:assistant']


def test_deleted_last_unit_is_empty_canonical_history_and_reads_do_not_write(history):
    call_row(history, 0)
    history.repo.delete_message('call-0000:assistant')
    journal = history.paths.journal('agent')
    journal.parent.mkdir(parents=True, exist_ok=True)
    journal.write_text(json.dumps({'kind': 'agent.turn.start', 'session_id': SID, 'turn_id': 'old', 'user_text': 'must not revive'}) + '\n')
    before = history.con.execute('SELECT meta_json FROM agent_sessions WHERE session_id=?', (SID,)).fetchone()[0]
    statements = []
    history.con.set_trace_callback(statements.append)
    result = external_history.external_transcript_page(history.con, SID, {})
    history.con.set_trace_callback(None)
    assert result['ok'] and result['messages'] == []
    assert page(history)['messages'] == []
    assert history.con.execute('SELECT meta_json FROM agent_sessions WHERE session_id=?', (SID,)).fetchone()[0] == before
    assert not any(sql.lstrip().upper().startswith(('INSERT ', 'UPDATE ', 'DELETE ', 'CREATE ')) for sql in statements)
