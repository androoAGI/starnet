import json,sys
from tools.delegation_output_schema import coerce_output_schema,validate_output
from agent.markdown_tables import realign_markdown_tables
from rich.console import Console
from cli import _render_final_assistant_content
from io import StringIO
from pathlib import Path
root=Path('..')
cases=json.loads((root/'starnet-schema.json').read_text(encoding='utf-8-sig'))
values={'basic':('{"score":4}','{}'),'minimum':('{"score":4}','{"score":-1}'),'pattern':('{"code":"ABC"}','{"code":"a1"}'),'minItems':('["a","b"]','["a"]'),'oneOf':('4','true'),'ref':('4','"no"')}
rows=[]
for c in cases:
 schema,error=coerce_output_schema(c['schema']);good,bad=values[c['name']];rows.append({'name':c['name'],'schemaError':error,'valid':validate_output(good,schema),'invalid':validate_output(bad,schema)})
(root/'hermes-schema.json').write_text(json.dumps(rows,indent=2),encoding='utf8')
report=json.loads((root/'live.json').read_text())['output']
for width in [40,80,120]:
 buf=StringIO();Console(file=buf,width=width,force_terminal=False,color_system=None).print(_render_final_assistant_content(report));(root/f'hermes-render-{width}.txt').write_text(buf.getvalue(),encoding='utf8')
print(json.dumps(rows,indent=2));print('rendered widths 40,80,120')
