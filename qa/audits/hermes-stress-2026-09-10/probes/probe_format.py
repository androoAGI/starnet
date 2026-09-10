import asyncio,json
from pathlib import Path
from unittest.mock import AsyncMock,patch
from aiohttp.test_utils import TestClient,TestServer
from tests.gateway.test_api_server import _make_adapter,_create_app
async def main():
 adapter=_make_adapter();rows=[]
 async with TestClient(TestServer(_create_app(adapter))) as cli:
  with patch.object(adapter,'_run_agent',new_callable=AsyncMock) as run:
   run.return_value=({'final_response':'Markdown prose, not JSON','completed':True,'messages':[]},{'input_tokens':1,'output_tokens':1,'total_tokens':2})
   for kind in ['json_object','json_schema']:
    fmt={'type':kind}
    if kind=='json_schema':fmt['json_schema']={'name':'audit','strict':True,'schema':{'type':'object','properties':{'ok':{'type':'boolean'}},'required':['ok'],'additionalProperties':False}}
    r=await cli.post('/v1/chat/completions',json={'model':'hermes-agent','response_format':fmt,'messages':[{'role':'user','content':'Return JSON.'}]})
    rows.append({'type':kind,'status':r.status,'body':await r.json(),'agentKwargNames':list(run.call_args.kwargs)})
 Path('../hermes-json-format.json').write_text(json.dumps(rows,indent=2),encoding='utf8');print(json.dumps(rows),flush=True)
asyncio.run(main())
