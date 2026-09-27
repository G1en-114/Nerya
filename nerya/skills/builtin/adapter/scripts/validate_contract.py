"""Validate captured quote/result JSON; never imports or executes an adapter."""
from nerya.wallet.adapter_contract import parse_quote,parse_result,VERSION
from nerya.skills.manifest import cli_main


def run(_ctx=None,**payload):
    kind=payload.get('kind');doc=payload.get('response') or {};request=payload.get('request') or {}
    if doc.get('protocol_version')!=VERSION:return {'ok':False,'error':'protocol_version must be 1'}
    try:
        if kind=='quote':result=parse_quote('external',request,doc)
        elif kind=='result':result=parse_result('external',request,doc)
        else:return {'ok':False,'error':'kind must be quote or result'}
        return {'ok':True,'normalized':result.to_dict()}
    except Exception as exc:
        return {'ok':False,'error':str(exc)}


if __name__=='__main__':cli_main(run)
