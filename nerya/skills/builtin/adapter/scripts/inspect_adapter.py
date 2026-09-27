"""Inspect an exact wallet binding and optionally validate a read-only quote."""
from nerya.core.config import load_config
from nerya.wallet.bindings import resolve_binding
from nerya.wallet.registry import build_provider
from nerya.wallet.swap_approval import prepare_swap
from nerya.skills.manifest import cli_main


def run(_ctx=None,**payload):
    config=getattr(_ctx,'config',None) or load_config(payload.pop('workspace',None))
    wid,name,cfg=resolve_binding(config,payload)
    provider=build_provider(name,cfg,workspace=config.paths.root)
    result={'wallet_id':wid,'provider':name,'readiness':provider.readiness().to_dict(),
            'capabilities':provider.capabilities().to_dict(),
            'methods':{m:callable(getattr(provider,m,None)) for m in ('get_balance','quote','swap','get_execution_status')}}
    if payload.pop('quote',False):
        _,quote=prepare_swap(config,payload)
        result['quote']=quote
    return result


if __name__=='__main__':cli_main(run)
