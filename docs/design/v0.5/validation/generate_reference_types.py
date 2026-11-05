"""Documentation-only derivation from one known contract; no server code generation."""
from pathlib import Path
import argparse, copy, hashlib, json
from strict_json import read_json
ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'examples/order.boundary.json'
BEHAVIOR_FIELDS = ('id','operationRevision','operation','http','protocol','input','serverOwnedFields','guards','output','response')
def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',',':'), allow_nan=False).encode('utf-8')
def behavior_digest(c):
    obj={'profile':'boundary-behavior/1','contract':{k:c[k] for k in BEHAVIOR_FIELDS}}
    return hashlib.sha256(canonical(obj)).hexdigest()
def ts_type(s):
    if 'const' in s: return json.dumps(s['const'],ensure_ascii=False)
    if 'enum' in s: return ' | '.join(json.dumps(v,ensure_ascii=False) for v in s['enum'])
    if s['type']=='string': return 'string'
    if s['type']=='integer': return 'number'
    if s['type']=='object':
        req=set(s['required'])
        return '{\n'+'\n'.join('  readonly '+json.dumps(k)+('' if k in req else '?')+': '+ts_type(v)+';' for k,v in s['properties'].items())+'\n}'
    raise ValueError('Outside reference subset: '+s['type'])
def derived():
    c=read_json(SOURCE,integer_only=True)
    h=hashlib.sha256(SOURCE.read_bytes()).hexdigest(); b=behavior_digest(c)
    out='// GENERATED from examples/order.boundary.json; do not edit.\n// Source SHA256: '+h+'\n// Numeric/string constraints remain runtime responsibilities.\n'
    for name,s in [('OrderInput',c['input']['schema']),('PublicReceipt',c['output']['schema']),('OrderPageView',c['page']['viewSchema'])]: out+='export type '+name+' = '+ts_type(s)+';\n'
    source={'path':'examples/order.boundary.json','sha256':h,'generator':'validation/generate_reference_types.py','projection':'exact-for-selected-structural-fields','runtimeCoverage':'not-evaluated','behaviorSha256':b}
    base={'format':'boundary-form-check/0.2-draft','status':'generated-design-reference-not-product-output','source':source,'action':{'id':c['id'],'method':c['http']['method'],'path':c['http']['path'],'encoding':c['http']['body'],'parserProfile':c['http']['parserProfile']},'input':c['input'],'protocolFields':[c['protocol']['csrfField'],c['protocol']['requestKeyField']]}
    start=copy.deepcopy(base); start['action'].update({'id':c['id']+'.begin','path':c['page']['intentInitialization']['path']})
    fields=c['page']['intentInitialization']['inputFields']
    start['input']['schema']['properties']={k:v for k,v in start['input']['schema']['properties'].items() if k in fields}
    start['input']['schema']['required']=[k for k in start['input']['schema']['required'] if k in fields]
    start['input']['codecs']={k:v for k,v in start['input']['codecs'].items() if k in fields}
    start['protocolFields']=[c['protocol']['csrfField']]
    digests={'format':'boundary-reference-digests/1','status':'generated-design-reference','sourceSha256':h,'behaviorProfile':'boundary-behavior/1','behaviorSha256':b,'includedFields':list(BEHAVIOR_FIELDS),'operationRevision':c['operationRevision'],'callbackCompatibility':'manual-operationRevision; not inferred from source code'}
    j=lambda v:json.dumps(v,ensure_ascii=False,indent=2)+'\n'
    return {'reference/order-types.generated.ts':out,'examples/form-check.generated.json':j(base),'examples/start-form-check.generated.json':j(start),'reference/contract-digests.generated.json':j(digests)}
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--check',action='store_true');a=p.parse_args()
    for name,body in derived().items():
        target=ROOT/name
        if a.check:
            if not target.exists() or target.read_text(encoding='utf-8')!=body: raise SystemExit('stale derived artifact: '+name)
        else:target.write_text(body,encoding='utf-8')
    print('four derived artifacts '+('match' if a.check else 'written from')+' authoritative JSON')
