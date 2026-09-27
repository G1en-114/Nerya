import {test,expect} from "@playwright/test";
import {projectCommand,type ConversationCommand} from "../../lib/conversationCommands";
import {conversationError,redactDiagnosticText} from "../../lib/conversationError";
import {newThread} from "../../lib/chat";

const command:ConversationCommand={command_id:"command-test-1",session_id:"session-test",kind:"send",state:"running",revision:1,turn_id:"turn-test",position:1,created_at:100,updated_at:100,input:"Read the evidence",attachments:[],context:{}};
test("replayed command snapshots and events are projected once",()=>{
  const thread={...newThread("Test"),id:command.session_id};
  const event={event_id:"event-1",seq:1,kind:"tool.start",call_id:"read-1"};
  const first=projectCommand(thread,command,[event]);
  const replay=projectCommand(first,command,[event]);
  expect(replay.messages).toHaveLength(2);
  const assistant=replay.messages[1];expect(assistant.role === "assistant" && assistant.live_events?.length).toBe(1);
  const stopped=projectCommand(replay,{...command,state:"stopping",revision:2});
  expect(stopped.messages[1].role === "assistant" && stopped.messages[1].loading).toBe(true);
  const finished=projectCommand(stopped,{...command,state:"interrupted",revision:3});
  expect(finished.messages[1].role === "assistant" && finished.messages[1].loading).toBe(false);
});
test("old command snapshots cannot overwrite the current resumed turn",()=>{
  const thread={...newThread("Test"),id:command.session_id};
  const original=projectCommand(thread,{...command,state:"blocked"});
  const resumed=projectCommand(original,{...command,command_id:"command-resumed",kind:"resume",created_at:200,state:"running"});
  const stale=projectCommand(resumed,{...command,state:"blocked",revision:9});
  expect(stale.messages[1].role === "assistant" && stale.messages[1].execution_status).toBe("running");
  expect(stale.messages[1].command_id).toBe("command-resumed");
});

test("terminal errors do not promise future automatic retries and redact credentials",()=>{
  const model=conversationError(JSON.stringify({code:"rate_limited",status_code:429,retrying:false}),true);
  expect(model.message).toContain("自动重试已结束");
  const text=redactDiagnosticText('Authorization: Bearer real-token\n{"api_key":"sensitive-key","password":"pass-value"}');
  expect(text).not.toContain("real-token");expect(text).not.toContain("sensitive-key");expect(text).not.toContain("pass-value");
  expect(conversationError('{"code":"execution_unconfirmed"}',false).canRerun).toBe(false);
});


test("blocked command failures retain actionable diagnostics",()=>{
 const thread={...newThread("Test"),id:command.session_id};
 const projected=projectCommand(thread,{...command,state:"blocked",error:{code:"strategy_version_changed"}});
 const message=projected.messages.find(item=>item.role==="assistant");
 expect(message?.role==="assistant"&&message.error).toContain("strategy_version_changed");
 expect(conversationError('{"code":"turn_failed","status_code":401}',false).needsSettings).toBe(true);
 expect(conversationError('{"code":"event_persistence_failed"}',false).canRerun).toBe(false);
});
