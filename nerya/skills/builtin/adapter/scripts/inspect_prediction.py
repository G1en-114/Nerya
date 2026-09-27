"""Read prediction outcomes/book/history without private credentials."""
from nerya.connectors.polymarket import PolymarketConnector
from nerya.data.candles import fetch_candles
from nerya.skills.manifest import cli_main


def run(_ctx=None,**payload):
    provider=str(payload.get('provider') or 'polymarket')
    if provider not in ('polymarket','polymarket_v2','pm'):
        return {'ok':False,'error':'prediction provider is not implemented'}
    connector=PolymarketConnector()
    market=str(payload.get('market') or '')
    if not market:
        return {'ok':True,'read_only':True,'markets':connector.list_markets(limit=min(100,int(payload.get('limit') or 20)))}
    token,meta=connector._resolve_token(market)
    result={'ok':True,'read_only':True,'market':market,'token_id':token,'metadata':meta,'book':connector.get_order_book(market)}
    if payload.get('history'):
        result['history']=fetch_candles(market,interval=str(payload.get('interval') or '1h'),count=min(1000,int(payload.get('limit') or 24)),
            allow_mock=False,**{k:int(payload[k]) for k in ('start','end') if payload.get(k) is not None})
    return result


if __name__=='__main__':cli_main(run)
