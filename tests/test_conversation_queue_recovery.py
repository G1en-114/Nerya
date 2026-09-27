from copy import deepcopy
import json
import pytest
from nerya.agent.command_runtime import CommandRuntime
from nerya.agent.command_store import CommandError
from nerya.agent.interactions import create_interaction
from nerya.core.config import Config,DEFAULT_CONFIG
from nerya.core.paths import WorkspacePaths
from nerya.db.sqlite import connect

pytestmark=pytest.mark.smoke

def runtime(tmp_path):
 return CommandRuntime(Config(paths=WorkspacePaths(root=tmp_path),data=deepcopy(DEFAULT_CONFIG)),lambda *_:{},epoch='queue-test')
def send(rt,cid):
 return rt.submit({'command_id':cid,'session_id':'queue-session','request':{'payload':{'text':cid}},'_auth_actor_id':'operator'},start=False)['command']
def finish(rt,row,state):
 rt.store.finish(row['command_id'],'queue-session','owner',state,{'turn_id':row['turn_id'],'stopped_reason':state})

def test_stop_request_wins_even_if_inflight_model_returns_success(tmp_path):
 rt=runtime(tmp_path);send(rt,'command-first');row=rt.store.claim('queue-session','owner');send(rt,'command-next')
 rt.store.control('queue-session','stop',cid=row['command_id'],revision=row['revision'])
 finish(rt,row,'succeeded')
 snapshot=rt.store.snapshot('queue-session');assert snapshot['queue']['paused'];assert next(c for c in snapshot['commands'] if c['command_id']==row['command_id'])['state']=='interrupted'
 assert rt.store.claim('queue-session','other') is None

@pytest.mark.parametrize('state',['awaiting_approval','awaiting_input'])
def test_resume_queue_cannot_bypass_a_pending_decision(tmp_path,state):
 rt=runtime(tmp_path);send(rt,'command-first');row=rt.store.claim('queue-session','owner');send(rt,'command-next')
 if state=='awaiting_input':create_interaction(rt.config,sid='queue-session',tid=row['turn_id'],call_id='ask-one',kind='question',payload={'title':'Choose'})
 finish(rt,row,state)
 q=rt.store.snapshot('queue-session')['queue']
 with pytest.raises(CommandError,match='decision_pending'):
  rt.store.control('queue-session','resume',revision=q['revision'])
 assert rt.store.claim('queue-session','other') is None

def test_checkpoint_continuation_does_not_release_other_paused_messages(tmp_path):
 rt=runtime(tmp_path);send(rt,'command-first');row=rt.store.claim('queue-session','owner');send(rt,'command-next');finish(rt,row,'blocked')
 rt.submit({'command_id':'command-continue','session_id':'queue-session','command_type':'resume','_auth_actor_id':'operator','request':{'payload':{},'resume_turn_id':row['turn_id'],'continuation_feedback':'Continue only this turn'}},start=False)
 assert rt.store.snapshot('queue-session')['queue']['paused']
 resumed=rt.store.claim('queue-session','owner');assert resumed['command_id']=='command-continue';finish(rt,resumed,'succeeded')
 assert rt.store.claim('queue-session','other') is None

def test_failed_error_is_cleared_when_same_turn_continuation_succeeds(tmp_path):
 rt=runtime(tmp_path);send(rt,'command-first');row=rt.store.claim('queue-session','owner')
 rt.store.finish(row['command_id'],'queue-session','owner','failed',{'turn_id':row['turn_id']}, {'code':'rate_limited'})
 rt.submit({'command_id':'command-continue','session_id':'queue-session','command_type':'resume','_auth_actor_id':'operator','request':{'payload':{},'resume_turn_id':row['turn_id'],'continuation_feedback':'Continue'}},start=False)
 resumed=rt.store.claim('queue-session','owner');finish(rt,resumed,'succeeded')
 con=connect(rt.config.paths.db)
 meta=json.loads(con.execute("SELECT meta_json FROM agent_messages WHERE message_id=?",(row['turn_id']+':assistant',)).fetchone()[0]);con.close()
 assert 'error' not in meta and 'error' not in meta['turn']

def test_retry_one_failed_input_runs_without_releasing_other_queue_items(tmp_path):
 rt=runtime(tmp_path);send(rt,'command-first');row=rt.store.claim('queue-session','owner');send(rt,'command-next');finish(rt,row,'failed')
 rt.submit({'command_id':'command-retry','session_id':'queue-session','_auth_actor_id':'operator','request':{'payload':{'text':'Retry first'},'run_only':True}},start=False)
 retry=rt.store.claim('queue-session','owner');assert retry['command_id']=='command-retry';assert retry['turn_id']!=row['turn_id'];finish(rt,retry,'succeeded')
 assert rt.store.claim('queue-session','other') is None
 q=rt.store.snapshot('queue-session')['queue'];rt.store.control('queue-session','resume',revision=q['revision'])
 assert rt.store.claim('queue-session','other')['command_id']=='command-next'

def test_reconcile_uses_exact_saved_terminal_status(tmp_path):
 rt=runtime(tmp_path);send(rt,'command-first');row=rt.store.claim('queue-session','owner');finish(rt,row,'succeeded')
 con=connect(rt.config.paths.db);con.execute("UPDATE agent_commands SET state='unconfirmed' WHERE command_id=?",(row['command_id'],));con.close()
 assert rt.reconcile('queue-session',row['command_id'])['command']['state']=='succeeded'

def test_blocked_turn_retains_error_code_for_actionable_ui(tmp_path):
 from nerya.agent.command_runtime import outcome_state
 assert outcome_state({'stopped_reason':'succeeded'})=='succeeded'

def test_pause_does_not_erase_approval_guard(tmp_path):
 rt=runtime(tmp_path);send(rt,'command-first');row=rt.store.claim('queue-session','owner');send(rt,'command-next');finish(rt,row,'awaiting_approval')
 q=rt.store.snapshot('queue-session')['queue'];rt.store.control('queue-session','pause',revision=q['revision']);q=rt.store.snapshot('queue-session')['queue']
 with pytest.raises(CommandError,match='decision_pending'):rt.store.control('queue-session','resume',revision=q['revision'])
 assert rt.store.claim('queue-session','other') is None

def test_old_one_turn_resume_never_replays_automatically_after_restart(tmp_path):
 rt=runtime(tmp_path);send(rt,'command-first');row=rt.store.claim('queue-session','owner');finish(rt,row,'failed')
 rt.submit({'command_id':'command-retry','session_id':'queue-session','_auth_actor_id':'operator','request':{'payload':{'text':'Retry'},'run_only':True}},start=False)
 restarted=CommandRuntime(rt.config,lambda *_:{},epoch='new-process')
 assert restarted.store.claim('queue-session','owner-new') is None

def test_queued_followup_does_not_hide_previous_failure_or_pending_approval():
 from nerya.agent.workbench import execution_view
 for state in ['failed','awaiting_approval','awaiting_input','interrupted']:
  commands=[{'kind':'send','state':state,'created_at':1,'turn_id':'first'},{'kind':'send','state':'queued','created_at':2,'turn_id':'next'}]
  assert execution_view(commands,[])['execution']==state

def test_resuming_queue_then_reading_does_not_pause_it_again(tmp_path):
 rt=runtime(tmp_path);send(rt,'command-first')
 restarted=CommandRuntime(rt.config,lambda *_:{},epoch='new-process')
 snapshot=restarted.store.snapshot('queue-session');assert snapshot['queue']['paused']
 restarted.store.control('queue-session','resume',revision=snapshot['queue']['revision'])
 assert restarted.store.claim('queue-session','owner') is not None

def test_stop_then_successful_response_keeps_result_evidence(tmp_path):
 rt=runtime(tmp_path);send(rt,'command-first');row=rt.store.claim('queue-session','owner');rt.store.control('queue-session','stop',cid=row['command_id'],revision=row['revision'])
 rt.store.finish(row['command_id'],'queue-session','owner','succeeded',{'turn_id':row['turn_id'],'final_text':'Existing result','artifact_index':{'created':['report.md']}})
 result=rt.store.snapshot('queue-session',row['command_id'])['command'];assert result['state']=='interrupted';assert result['result']['artifact_index']['created']==['report.md']

def test_runtime_failure_pauses_followups_and_explicit_retry_runs_once(tmp_path):
 import threading,time
 entered=threading.Event();release=threading.Event();calls=[]
 def execute(config,request):
  text=request['payload']['text'];calls.append(text)
  if text=='first':entered.set();release.wait(3);return {'ok':False,'error':'rate_limited','turn_id':request['turn_id']}
  return {'stopped_reason':'end_turn','turn_id':request['turn_id'],'final_text':'done'}
 rt=CommandRuntime(Config(paths=WorkspacePaths(root=tmp_path),data=deepcopy(DEFAULT_CONFIG)),execute,epoch='runtime-test')
 def submit(cid,text,run_only=False):
  return rt.submit({'command_id':cid,'session_id':'runtime-session','_auth_actor_id':'operator','request':{'payload':{'text':text},'run_only':run_only}})
 def wait_for(predicate):
  end=time.monotonic()+5
  while time.monotonic()<end:
   if predicate():return
   time.sleep(.02)
  raise AssertionError('runtime did not reach expected state')
 submit('runtime-first','first');assert entered.wait(2);submit('runtime-next','second');release.set()
 wait_for(lambda:rt.store.snapshot('runtime-session','runtime-first')['command']['state']=='failed')
 assert calls==['first']
 submit('runtime-retry','retry',True)
 wait_for(lambda:rt.store.snapshot('runtime-session','runtime-retry')['command']['state']=='succeeded')
 assert calls==['first','retry'];assert rt.store.snapshot('runtime-session','runtime-next')['command']['state']=='queued'
 submit('runtime-retry','retry',True);assert calls==['first','retry']
 queue=rt.store.snapshot('runtime-session')['queue'];rt.control({'session_id':'runtime-session','action':'resume','expected_revision':queue['revision']})
 wait_for(lambda:rt.store.snapshot('runtime-session','runtime-next')['command']['state']=='succeeded');assert calls==['first','retry','second']
