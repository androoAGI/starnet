import asyncio,json,os
from pathlib import Path
from unittest.mock import AsyncMock,patch
from aiohttp.test_utils import TestClient,TestServer
from tests.gateway.test_api_server import _make_adapter,_create_app
async def main():
 rows=[]
 adapter=_make_adapter()
 async with TestClient(TestServer(_create_app(adapter))) as client:
  with patch.object(adapter,'_run_agent',new_callable=AsyncMock) as run:
   for i in range(3):
    run.return_value=({'final_response':'PARTIAL: started checking the report.','completed':False,'partial':True,'failed':True,'error':'401 Unauthorized: AUDIT_FATAL_PROVIDER','messages':[],'api_calls':1},{'input_tokens':0,'output_tokens':0,'total_tokens':0})
    r=await client.post('/v1/chat/completions',json={'model':'hermes-agent','messages':[{'role':'user','content':f'Check {i}'}]})
    rows.append({'case':'partial-failure','repeat':i+1,'status':r.status,'body':await r.json()})
   run.return_value=({'final_response':'OK','completed':True,'messages':[],'api_calls':1},{'input_tokens':10,'output_tokens':2,'total_tokens':12})
   for i in range(3):
    before=run.call_count
    body={'model':'hermes-agent','messages':[{'role':'user','content':f'idempotency {i}'}]}
    replies=[]
    for j in range(2):
     r=await client.post('/v1/chat/completions',json=body,headers={'Idempotency-Key':f'audit-key-731-{i}'})
     replies.append({'status':r.status,'body':await r.json()})
    rows.append({'case':'idempotency','repeat':i+1,'agentCalls':run.call_count-before,'replies':replies})
 Path('../hermes-http-probe.json').write_text(json.dumps(rows,indent=2),encoding='utf8')
 print(json.dumps([{'case':r['case'],'repeat':r['repeat'],'status':r.get('status'),'finish_reason':r.get('body',{}).get('choices',[{}])[0].get('finish_reason'),'agentCalls':r.get('agentCalls')} for r in rows]),flush=True)
asyncio.run(main())
