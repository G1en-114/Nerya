const ts=require('typescript');
require.extensions['.ts']=(module,filename)=>{
  const fs=require('fs');module._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,filename);
};
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {isLocalRequest,isLoopbackHost}=require('../lib/requestLocality.ts');

function request(headers){
  return {headers:{get:(name)=>headers[name.toLowerCase()] ?? null}};
}

test('loopback hosts are recognized with and without a port',()=>{
  for (const host of ['127.0.0.1','127.0.0.1:3001','localhost','localhost:3001','::1','[::1]:3001','127.0.0.53']) {
    assert.equal(isLoopbackHost(host),true,host);
  }
  for (const host of ['','example.com','192.168.1.10','203.0.113.9','[2001:db8::1]:3001']) {
    assert.equal(isLoopbackHost(host),false,host);
  }
});

test('a browser on this machine stays local even though Next appends its own hop',()=>{
  assert.equal(isLocalRequest(request({
    'host':'127.0.0.1:3001','x-forwarded-for':'127.0.0.1','x-forwarded-host':'127.0.0.1:3001',
  })),true);
  assert.equal(isLocalRequest(request({'host':'localhost:3001','x-forwarded-for':'::1'})),true);
  assert.equal(isLocalRequest(request({'host':'127.0.0.1:3001'})),true);
});

test('any non-loopback hop makes the request remote',()=>{
  // Tunnelled or LAN traffic: a real client address is in the chain.
  assert.equal(isLocalRequest(request({'host':'127.0.0.1:3001','x-forwarded-for':'203.0.113.9, 127.0.0.1'})),false);
  assert.equal(isLocalRequest(request({'host':'127.0.0.1:3001','x-forwarded-for':'192.168.1.10'})),false);
  // Loopback chain but the browser addressed the box by its LAN name.
  assert.equal(isLocalRequest(request({'host':'192.168.1.10:3001','x-forwarded-for':'127.0.0.1'})),false);
  assert.equal(isLocalRequest(request({'host':'','x-forwarded-for':'127.0.0.1'})),false);
});

test('an injected peer key still requires both the key and a loopback host',()=>{
  const key='secret-peer-key';
  process.env.NERYA_LOCAL_PEER_KEY=key;
  try {
    assert.equal(isLocalRequest(request({'host':'127.0.0.1:3001','x-nerya-local-peer':key})),true);
    assert.equal(isLocalRequest(request({'host':'127.0.0.1:3001','x-nerya-local-peer':'wrong'})),false);
    assert.equal(isLocalRequest(request({'host':'203.0.113.9:3001','x-nerya-local-peer':key})),false);
  } finally {
    delete process.env.NERYA_LOCAL_PEER_KEY;
  }
});
