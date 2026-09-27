"""Operator-configured wallet/DEX process adapter; no shell interpolation."""
from dataclasses import dataclass,field
import json
import os
import shutil
import subprocess
from ..protocol import WalletProvider,WalletReadiness,WalletCapabilities,WalletCapability,WalletBalance
from ..errors import WalletDependencyError,WalletPolicyDenied,WalletTransportError
from ..adapter_contract import VERSION,parse_quote,parse_result,finite


@dataclass
class ExternalWallet(WalletProvider):
    id:str='external'
    label:str='External wallet / DEX adapter'
    config:dict=field(default_factory=dict)
    workspace:str=''

    def readiness(self):
        command=self.config.get('command')
        ready=isinstance(command,list) and bool(command) and all(isinstance(x,str) and x for x in command)
        ready=bool(ready and shutil.which(command[0]))
        return WalletReadiness(provider=self.id,ready=ready,missing=[] if ready else ['adapter:command'],
            install_hint='Configure an installed adapter command as an argv array; see adapter Skill.')

    def capabilities(self):
        return WalletCapabilities(balance=WalletCapability(True,'partial','Adapter contract'),
            quote=WalletCapability(True,'partial','Adapter contract'),swap=WalletCapability(True,'partial','describe handshake required'),
            market_data=WalletCapability(True,'partial','Configured adapter or public USD token data'),
            execution_profile='partial',chains=tuple(self.config.get('chains') or ()),
            swap_chains=tuple(self.config.get('chains') or ()),minimum_output='adapter_contract',receipt_polling=True)

    def _invoke(self,command,payload):
        ready=self.readiness()
        if not ready.ready:raise WalletDependencyError(self.id,ready.missing,ready.install_hint)
        if command not in {'describe','balance','quote','swap','get_execution_status','candles'}:
            raise WalletPolicyDenied('unknown wallet adapter action')
        env=os.environ.copy()
        for name,ref in (self.config.get('env_refs') or {}).items():
            if not str(ref).startswith('vault://'):raise WalletPolicyDenied('adapter env values must be vault references')
            from .self_custody import SelfCustodyWallet
            env[name]=SelfCustodyWallet(workspace=self.workspace)._resolve_vault_secret(ref)
        try:
            proc=subprocess.run(self.config['command'],input=json.dumps({'protocol_version':VERSION,'command':command,'payload':payload}),
                text=True,capture_output=True,cwd=self.workspace or None,env=env,
                timeout=min(120,max(1,float(self.config.get('timeout_s',45)))),check=False)
        except (OSError,subprocess.TimeoutExpired) as exc:
            raise WalletTransportError('external adapter failed: '+type(exc).__name__) from exc
        finally:
            env.clear()
        if proc.returncode:raise WalletTransportError(f'external adapter exited {proc.returncode}')
        try:doc=json.loads(proc.stdout.strip().splitlines()[-1])
        except (ValueError,IndexError) as exc:raise WalletTransportError('external adapter returned invalid JSON') from exc
        if not isinstance(doc,dict) or doc.get('protocol_version')!=VERSION:
            raise WalletTransportError('external adapter protocol_version mismatch')
        return doc

    def describe(self):
        return self._invoke('describe',{})

    def get_balance(self,*,chain,address,token,**kw):
        doc=self._invoke('balance',{'chain':chain,'address':address,'token':token})
        if doc.get('address',address)!=address or doc.get('token',token)!=token:
            raise WalletPolicyDenied('adapter balance identity mismatch')
        decimals=doc.get('decimals')
        if not isinstance(decimals,int) or not 0<=decimals<=36:raise WalletPolicyDenied('adapter decimals missing/invalid')
        return WalletBalance(provider=self.id,chain=chain,address=address,token=token,
            balance=finite(doc.get('balance'),'balance'),symbol=str(doc.get('symbol') or ''),decimals=decimals)

    def quote(self,*,chain,token_in,token_out,amount_in,slippage_bps=50,**kw):
        request=dict(chain=chain,token_in=token_in,token_out=token_out,amount_in=amount_in,slippage_bps=slippage_bps)
        return parse_quote(self.id,request,self._invoke('quote',{**request,**kw}))

    def swap(self,*,chain,token_in,token_out,amount_in,slippage_bps=50,receiver=None,live=False,**kw):
        if not live:raise WalletPolicyDenied('live execution is disabled')
        caps=self.describe()
        if chain not in caps.get('swap_chains',[]) or caps.get('minimum_output')!='enforced' or not caps.get('receipt_polling'):
            raise WalletPolicyDenied('adapter must declare supported chain, enforced minimum and receipt polling')
        callback=kw.pop('on_broadcast',None)
        request=dict(chain=chain,token_in=token_in,token_out=token_out,amount_in=amount_in,
                     slippage_bps=slippage_bps,receiver=receiver or '')
        if finite(kw.get('min_out'),'min_out',positive=True)<=0:raise WalletPolicyDenied('minimum required')
        return parse_result(self.id,request,self._invoke('swap',{**request,**kw}),on_broadcast=callback)

    def get_execution_status(self,*,request,transaction):
        return parse_result(self.id,request,self._invoke('get_execution_status',{'request':request,'transaction':transaction}))

    def get_token_klines(self,*,chain,token,interval='1h',limit=100,**kw):
        if not self.config.get('adapter_candles'):
            return super().get_token_klines(chain=chain,token=token,interval=interval,limit=limit,**kw)
        doc=self._invoke('candles',dict(chain=chain,token=token,interval=interval,limit=limit,
            **{k:kw[k] for k in ('start','end') if k in kw}))
        if doc.get('chain')!=chain or doc.get('token')!=token or doc.get('price_currency') not in ('USD','pool_pair'):
            raise WalletPolicyDenied('adapter candles need matching asset and explicit price_currency')
        from ...core.truth import live_envelope,tag_list_envelope
        rows={}
        for row in doc.get('candles') or []:
            ts=int(row['ts'])
            if ts<=0 or ts>10**11:raise WalletPolicyDenied('candle timestamp must be unix seconds')
            normalized={k:finite(row[k],k,positive=k!='volume') for k in ('open','high','low','close','volume')}
            if normalized['low']>min(normalized['open'],normalized['close']) or normalized['high']<max(normalized['open'],normalized['close']):
                raise WalletPolicyDenied('inconsistent candle high/low')
            if (kw.get('start') is not None and ts<int(kw['start'])) or (kw.get('end') is not None and ts>int(kw['end'])):continue
            rows[ts]={'ts':ts,**normalized,'price_currency':doc['price_currency']}
        return tag_list_envelope([rows[k] for k in sorted(rows)][-max(1,min(int(limit),10000)):],live_envelope(source='external_adapter',venue=chain))
