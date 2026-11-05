"""Read-only bounded verification of a design package, not product tests.

Requires Python 3, jsonschema, and an installed tsc. Missing tools are NOT_RUN.
Optional --report-dir writes an explicit result copy; default only prints JSON.
"""
from __future__ import annotations
import argparse
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from html.parser import HTMLParser
from urllib.parse import unquote
from strict_json import read_json, decode_json
from check_sqlite_snapshot import observe as observe_snapshot

ROOT = Path(__file__).resolve().parents[1]
checks: list[dict] = []
logs: dict[str, str] = {}
def load(rel: str):
    return read_json(ROOT / rel)
def run_check(name, group, fn):
    try:
        detail = fn()
        checks.append({'name': name, 'group': group, 'status': 'VERIFIED_REFERENCE_ONLY', 'detail': detail})
    except ModuleNotFoundError as e:
        checks.append({'name': name, 'group': group, 'status': 'NOT_RUN', 'detail': str(e)})
    except Exception as e:
        checks.append({'name': name, 'group': group, 'status': 'FAILED', 'detail': f'{type(e).__name__}: {e}'})

def json_parse():
    paths = sorted(ROOT.rglob('*.json'))
    for p in paths:
        read_json(p)
    return {'jsonFilesParsed': len(paths), 'scope': 'syntax only'}

def contract_structure():
    from jsonschema import Draft202012Validator
    schema = load('schemas/boundary-contract.schema.json')
    c = load('examples/order.boundary.json')
    Draft202012Validator.check_schema(schema)
    v = Draft202012Validator(schema)
    v.validate(c)
    bad=copy.deepcopy(c);bad['http']['path']='//other.invalid/action'
    assert not v.is_valid(bad)
    for section in ('response', 'page', 'bindings'):
        bad=copy.deepcopy(c);del bad[section]
        assert not v.is_valid(bad), section
    bad=copy.deepcopy(c);bad['guards']['Audience']=['public']
    assert not v.is_valid(bad)
    for s in [c['input']['schema'],c['output']['schema'],c['page']['viewSchema']]:
        Draft202012Validator.check_schema(s)
        assert set(s['required']) <= set(s['properties'])
    keys=set(c['input']['schema']['properties'])
    assert keys == set(c['input']['codecs'])
    assert not keys.intersection(c['serverOwnedFields'])
    assert c['http']['maxEntries'] >= len(keys) + 2
    for k,s in c['input']['schema']['properties'].items():
        assert c['input']['codecs'][k] == {'string':'text','integer':'decimal-integer'}[s['type']]
    assert c['response']['success']['parameterFrom'].split('.')[1] in c['output']['schema']['properties']
    module=(ROOT/'examples'/c['bindings']['module']).resolve()
    assert module.is_relative_to(ROOT) and module.is_file()
    Draft202012Validator(c['page']['viewSchema']).validate(load('examples/page-view.json'))
    Draft202012Validator(c['output']['schema']).validate(load('examples/public-receipt.json'))
    return {'authoritativeContract': 'examples/order.boundary.json','negativeSchemaCases':5,'scope':'metadata and sample data, not runtime'}

def generated_types():
    from jsonschema import Draft202012Validator
    command=[sys.executable,str(ROOT/'validation/generate_reference_types.py'),'--check']
    p=subprocess.run(command,capture_output=True,text=True,timeout=20)
    logs['generated-types.txt']=p.stdout+p.stderr
    assert p.returncode == 0,p.stdout+p.stderr
    assert not list(ROOT.rglob('*.boundary.ts'))
    c=load('examples/order.boundary.json')
    f=load('examples/form-check.generated.json');start=load('examples/start-form-check.generated.json')
    h=hashlib.sha256((ROOT/'examples/order.boundary.json').read_bytes()).hexdigest()
    v=Draft202012Validator(load('schemas/form-check.schema.json'))
    v.validate(f);v.validate(start)
    assert f['source']['sha256']==h and start['source']['sha256']==h
    assert f['input']==c['input']
    assert f['action']=={'id':c['id'],'method':c['http']['method'],'path':c['http']['path'],'encoding':c['http']['body'],'parserProfile':c['http']['parserProfile']}
    assert set(f['protocolFields'])=={c['protocol']['csrfField'],c['protocol']['requestKeyField']}
    assert start['protocolFields']==[c['protocol']['csrfField']]
    assert set(start['input']['schema']['properties'])=={'productId'}
    assert start['action']['path']==c['page']['intentInitialization']['path']
    assert not set(f).intersection({'bindings','guards','headers','page','output'})
    assert f['source']['runtimeCoverage']=='not-evaluated'
    return {'exitCode':p.returncode,'sourceSha256':h,'derivedArtifacts':4,'formProjectionScope':'selected structural fields only; not a product loader'}

class HtmlSnapshot(HTMLParser):
    def __init__(self):
        super().__init__();self.tags=[]
    def handle_starttag(self,tag,attrs):
        self.tags.append((tag,dict(attrs)))
    def handle_startendtag(self,tag,attrs):
        self.handle_starttag(tag,attrs)

def html_snapshots():
    c=load('examples/order.boundary.json')
    config=load('examples/doctor.config.json')
    for filename in ['form.initial.html','form.invalid.html','start.html']:
        h=HtmlSnapshot();h.feed((ROOT/'examples/html'/filename).read_text(encoding='utf-8'))
        ids=[a['id'] for _,a in h.tags if 'id' in a];assert len(ids)==len(set(ids))
        form=[a for t,a in h.tags if t=='form'];assert len(form)==1
        action=c['page']['intentInitialization']['path'] if filename=='start.html' else c['http']['path']
        assert form[0]['action']==action and form[0]['method'].upper()==c['http']['method']
        assert form[0]['enctype']=='application/x-www-form-urlencoded'
        assert form[0]['accept-charset'].lower()=='utf-8'
        inputs={a['name']:a for t,a in h.tags if t=='input' and 'name' in a}
        expected={'productId','_bc_csrf'} if filename=='start.html' else set(c['input']['schema']['properties'])|{'_bc_csrf','_bc_request'}
        assert set(inputs)==expected
        if filename!='start.html':
            q=inputs['quantity'];assert q['type']=='text' and q['inputmode']=='numeric' and 'required' in q
            assert q['maxlength']=='2'
            for value in map(str,range(1,21)): assert re.fullmatch(q['pattern'],value)
            for value in ['0','21','1e2','01','+1','1.0','-1',' 1','1 ']:assert not re.fullmatch(q['pattern'],value)
            assert any(t=='label' and a.get('for')==q['id'] for t,a in h.tags)
            if filename=='form.invalid.html':assert q['aria-invalid']=='true' and 'quantity-error' in q['aria-describedby'].split()
        for _,a in h.tags:
            for k in ('aria-describedby','aria-labelledby'):
                assert all(x in ids for x in a.get(k,'').split())
            assert not any(k.startswith('th:') for k in a)
    return {'snapshots':3,'scope':'explicit structural assertions using Python HTMLParser, not an HTML5 browser or accessibility engine'}

def markdown_links():
    count=0
    for p in sorted(ROOT.rglob('*.md')):
        text=p.read_text(encoding='utf-8')
        assert len(re.findall(r'^```',text,re.M))%2==0, str(p)
        for target in re.findall(r'\[[^\]]*\]\(([^)]+)\)',text):
            if re.match(r'^\w+://',target) or target.startswith('mailto:'):continue
            f,_,anchor=target.partition('#');dest=(p.parent/unquote(f)).resolve() if f else p
            assert dest.is_relative_to(ROOT),target
            assert dest.exists(),f'{p.relative_to(ROOT)} -> {target}'
            if anchor and dest.suffix=='.md':
                content=dest.read_text(encoding='utf-8')
                assert f'id="{anchor}"' in content or f"id='{anchor}'" in content, target
            count+=1
    return {'localLinksChecked':count,'scope':'file and explicit source anchors; no remote crawl'}

def feedback_and_sources():
    sources=load('evidence/sources.json')['sources'];ids=[s['id'] for s in sources]
    assert len(ids)==len(set(ids))
    for p in ROOT.rglob('*.md'):
        for sid in re.findall(r'\[(R\d+)\]',p.read_text(encoding='utf-8')):assert sid in ids,sid
    items=load('evidence/feedback-decisions.json')['items'];fids=[i['id'] for i in items]
    assert len(fids)==len(set(fids))
    for i in items:assert (ROOT/i['document']).is_file()
    assert load('examples/coverage.expected.json')['status']=='authored-expectation-not-scanner-output'
    diagnostic=load('examples/diagnostic-attribution.expected.json')
    assert diagnostic['status']=='authored-expectation-not-scanner-output'
    assert diagnostic['productRun'] is False
    for item in diagnostic['findings']:
        assert item['evidenceRef'] is None
        assert item['comparativeValue']=='not-evaluated'
        assert item['engineOrigin'] and item['originalRuleId']
    for row in load('examples/coverage.expected.json')['rows']:
        if '#' not in row['target']: continue
        filename,formid=row['target'].split('#',1)
        doc=HtmlSnapshot();doc.feed((ROOT/filename).read_text())
        assert sum(1 for tag,attrs in doc.tags if tag=='form' and attrs.get('id')==formid)==1
        assert any(x['path']==filename and any(y['formId']==formid for y in x['bindings']) for x in load('examples/doctor.config.json')['documents'])
    return {'sourceRecords':len(sources),'feedbackDecisions':len(items),'authoredDiagnostics':'not product output'}

def experiment_design_consistency():
    plan=load('experiments/p0-plan.json')
    result=load('experiments/results.template.json')
    inventory=load('experiments/adoption-inventory.template.json')
    assert plan['status']=='planned-not-executed'
    assert result['status']=='template-not-executed'
    assert inventory['status']=='template-not-executed'
    assert plan['measurements'] is None and plan['decision'] is None
    arms=[a['id'] for a in plan['arms']];assert arms==['B','L','S','D']
    ids=[c['id'] for c in plan['cases']]
    assert len(ids)==len(set(ids))==11
    assert ids==[c['id'] for c in result['cases']]
    assert [c['id'] for c in plan['cases'] if c['kind']=='candidate-defect']==['C1','C2','C3']
    assert not (ROOT/'experiments/three-changes.json').exists()
    for case in plan['cases']:
        assert case['realFixturePath'] is None and case['rawExecutionEvidence'] is None
    for case in result['cases']:
        assert set(case['byArm'])==set(arms)
        assert case['comparativeJudgement'] is None
        for values in case['byArm'].values():
            assert values['status']=='NOT_RUN'
            assert all(v is None for k,v in values.items() if k!='status')
    for values in result['armSetup'].values(): assert all(v is None for v in values.values())
    assert inventory['rows']==[]
    assert all(v is None for v in inventory['summary'].values())
    assert inventory['maxSubmissionPaths']==10
    assert plan['fairness']['scriptArtificialLineLimit'] is None
    return {'arms':len(arms),'plannedCases':len(ids),'resultSlots':len(arms)*len(ids),
            'allProductMeasurementsUnexecuted':True,'actualFormInventoryPerformed':False,
            'scope':'plan/template consistency, not a baseline or Doctor evaluation'}

def typecheck():
    executable=shutil.which('tsc')
    if executable is None:raise ModuleNotFoundError('tsc not available; reference types NOT_RUN')
    v=subprocess.run([executable,'--version'],capture_output=True,text=True,timeout=20)
    command=[executable,'-p',str(ROOT/'reference/tsconfig.json'),'--pretty','false']
    p=subprocess.run(command,capture_output=True,text=True,timeout=45)
    # Count only explicit compile-error directives, not comments about the marker.
    n=len(re.findall(r'^// @ts-expect-error', (ROOT/'reference/type-rejection-cases.ts').read_text(),re.M))
    logs['tsc-reference.txt']='version: '+v.stdout.strip()+'\ncommand: tsc -p reference/tsconfig.json --pretty false\nexit: '+str(p.returncode)+'\n'+p.stdout+p.stderr
    assert p.returncode==0,p.stdout+p.stderr
    assert n==9,n
    return {'version':v.stdout.strip(),'exitCode':p.returncode,'expectedTypeRejections':n,'scope':'reference role fixtures; no production or latest-toolchain claim'}

def sql_illustration():
    db=sqlite3.connect(':memory:',isolation_level=None)
    B='a'*64;H='b'*64
    def issue(id,revision=7,expiry=86500):
        db.execute('INSERT INTO form_intents VALUES (?,?,?,?,?,?,?,?,?,?)',(id,'t','u','orders.createDraft','p',revision,B,100,expiry,None))
    try:
        db.executescript((ROOT/'reference/sqlite-schema.sql').read_text())
        assert db.execute('PRAGMA foreign_keys').fetchone()[0]==1
        db.execute('INSERT INTO memberships VALUES (?,?,?)',('t','u',1))
        db.execute('INSERT INTO products VALUES (?,?,?,?,?,?)',('t','p',7,1,12000,'KRW'))
        issue('i');sql=(ROOT/'reference/insert-draft-cas.sql').read_text()
        params=dict(draftId='draft_a',subjectId='u',quantity=2,tenantId='t',productId='p',expectedRevision=7,intentId='i',behaviorHash=B,now=200)
        db.execute('BEGIN IMMEDIATE')
        assert db.execute(sql,params).rowcount==1
        db.execute('UPDATE form_intents SET consumed_at=200 WHERE id="i"')
        db.execute('INSERT INTO action_results VALUES (?,?,?,?,?,?)',('i',B,H,'draft_a',200,86600))
        db.execute('INSERT INTO boundary_audit(intent_id,action_id,outcome,created_at) VALUES (?,?,?,?)',('i','orders.createDraft','created',200))
        db.execute('COMMIT')
        assert db.execute('SELECT total_minor FROM order_drafts WHERE id="draft_a"').fetchone()[0]==24000
        assert db.execute(sql,{**params,'draftId':'draft_consumed'}).rowcount==0
        issue('stale')
        db.execute('UPDATE products SET revision=8,price_minor=15000')
        # Re-reading the new current revision must NOT accept a previously displayed quote.
        assert db.execute(sql,{**params,'intentId':'stale','draftId':'draft_new_price','expectedRevision':8}).rowcount==0
        db.execute('UPDATE products SET revision=7,price_minor=12000')
        assert db.execute(sql,{**params,'intentId':'stale','draftId':'draft_wrong_revision','expectedRevision':8}).rowcount==0
        assert db.execute(sql,{**params,'intentId':'stale','draftId':'draft_wrong_behavior','behaviorHash':'c'*64}).rowcount==0
        issue('other')
        try:
            db.execute('INSERT INTO action_results VALUES (?,?,?,?,?,?)',('other',B,H,'draft_a',200,86600))
            raise AssertionError('cross-intent result reference should fail')
        except sqlite3.IntegrityError:pass
        try:
            db.execute("INSERT INTO order_drafts SELECT 'duplicate','i',tenant_id,subject_id,product_id,product_revision,quantity,total_minor,currency,state FROM order_drafts WHERE id='draft_a'")
            raise AssertionError('business intent uniqueness should fail')
        except sqlite3.IntegrityError:pass
        db.execute('BEGIN IMMEDIATE')
        assert db.execute(sql,{**params,'intentId':'stale','draftId':'draft_rollback'}).rowcount==1
        db.execute('ROLLBACK')
        assert db.execute('SELECT COUNT(*) FROM order_drafts').fetchone()[0]==1
        db.execute('UPDATE memberships SET active=0')
        assert db.execute(sql,{**params,'intentId':'stale','draftId':'draft_denied'}).rowcount==0
        db.execute('UPDATE memberships SET active=1')
        issue('expired',expiry=200)
        assert db.execute(sql,{**params,'intentId':'expired','draftId':'draft_expired'}).rowcount==0
        # Deliberately inconsistent data is preserved for diagnosis, not silently erased.
        issue('orphan')
        db.execute("UPDATE form_intents SET consumed_at=200 WHERE id='orphan'")
        audit=(ROOT/'reference/audit-intent-consistency.sql').read_text()
        assert ('orphan','CONSUMED_WITHOUT_RESULT') in db.execute(audit).fetchall()
        cleanup=(ROOT/'reference/cleanup-intents.sql').read_text()
        db.execute(cleanup,{'now':86500})
        assert db.execute("SELECT COUNT(*) FROM form_intents WHERE id != 'orphan'").fetchone()[0]==1
        db.execute(cleanup,{'now':86600})
        assert db.execute("SELECT COUNT(*) FROM form_intents WHERE id != 'orphan'").fetchone()[0]==0
        assert db.execute("SELECT COUNT(*) FROM form_intents WHERE id='orphan'").fetchone()[0]==1
        assert db.execute('SELECT COUNT(*) FROM action_results').fetchone()[0]==0
        assert db.execute('SELECT COUNT(*) FROM order_drafts').fetchone()[0]==1
        result={'sqliteVersion':sqlite3.sqlite_version,'connection':'one in-memory Python connection','observations':['DDL and foreign keys enabled','conditional insert at issued revision','computed total 24000','consumed intent inserts zero rows','new current revision cannot silently replace shown quote','wrong revision and behavior digest rejected','cross-intent result reference rejected','business draft intent uniqueness enforced','rollback removes attempted draft','inactive member inserts zero rows','exact expiry is expired','temporary cleanup preserves business draft','inconsistent consumed intent preserved and reported'],'notRun':['Bun adapter','two-connection behavior in this in-memory check','HTTP idempotency handler','power loss or crash recovery']}
        logs['sqlite-reference.json']=json.dumps(result,ensure_ascii=False,indent=2)+'\n'
        return result
    finally:db.close()

def digest_semantics():
    spec=importlib.util.spec_from_file_location('reference_derivation',ROOT/'validation/generate_reference_types.py')
    module=importlib.util.module_from_spec(spec);assert spec.loader is not None;spec.loader.exec_module(module)
    c=load('examples/order.boundary.json');base=module.behavior_digest(c)
    reordered=json.loads(json.dumps(c,sort_keys=True,indent=4))
    assert module.behavior_digest(reordered)==base
    cosmetic=copy.deepcopy(c);cosmetic['status']='different-document-status'
    assert module.behavior_digest(cosmetic)==base
    changed=copy.deepcopy(c);changed['input']['schema']['properties']['quantity']['maximum']=10
    assert module.behavior_digest(changed)!=base
    changed=copy.deepcopy(c);changed['operationRevision']+=1
    assert module.behavior_digest(changed)!=base
    assert load('reference/contract-digests.generated.json')['behaviorSha256']==base
    return {'behaviorSha256':base,'sourceFormattingIgnored':True,'selectedInputChangeDetected':True,'explicitOperationRevisionChangeDetected':True,'callbackEquivalenceProven':False}

def wire_reference():
    tsc=shutil.which('tsc');node=shutil.which('node')
    if not tsc or not node:raise ModuleNotFoundError('tsc or node missing; wire reference NOT_RUN')
    with tempfile.TemporaryDirectory(prefix='bc-wire-') as d:
        command=[tsc,str(ROOT/'reference/wire-semantics.ts'),'--target','ES2022','--module','commonjs','--strict','--noUncheckedIndexedAccess','--lib','ES2022,DOM','--outDir',d,'--pretty','false']
        p=subprocess.run(command,capture_output=True,text=True,timeout=30)
        assert p.returncode==0,p.stdout+p.stderr
        q=subprocess.run([node,str(ROOT/'validation/check_wire_reference.cjs'),str(Path(d)/'wire-semantics.js')],capture_output=True,text=True,timeout=20)
        logs['wire-reference.json']=q.stdout
        assert q.returncode==0,q.stdout+q.stderr
        result=json.loads(q.stdout)
        # Independent standard hash computation, not an HTTP/signature guarantee.
        assert hashlib.sha256(result['canonicalInput'].encode()).hexdigest()==result['sha256']
        return result

def strict_json_reference():
    samples=[b'{"x":1,"x":2}',b'{"x":1,"\\u0078":2}',b'{"x":NaN}',b'{"x":9007199254740992}',b'{"x":"\\ud800"}',b'\xef\xbb\xbf{}',b'{"x":1.5}']
    for raw in samples:
        try: decode_json(raw,integer_only=True)
        except (ValueError,UnicodeError): pass
        else: raise AssertionError('bad source accepted: '+repr(raw))
    assert decode_json(b'{"x":1,"title":"ok"}',integer_only=True)=={'x':1,'title':'ok'}
    return {'rejectedCases':len(samples),'validCase':True,'scope':'reference metadata reader, not product CLI'}

def state_reference():
    tsc=shutil.which('tsc');node=shutil.which('node')
    if not tsc or not node: raise ModuleNotFoundError('tsc or node missing; state references NOT_RUN')
    with tempfile.TemporaryDirectory(prefix='bc-state-') as d:
        files=['intent-decisions.ts','sync-result.ts','native-target.ts']
        command=[tsc,*[str(ROOT/'reference'/name) for name in files],'--target','ES2022','--module','commonjs','--strict','--noUncheckedIndexedAccess','--exactOptionalPropertyTypes','--lib','ES2022,DOM','--outDir',d,'--pretty','false']
        p=subprocess.run(command,capture_output=True,text=True,timeout=30)
        assert p.returncode==0,p.stdout+p.stderr
        q=subprocess.run([node,str(ROOT/'validation/check_state_reference.cjs'),d],capture_output=True,text=True,timeout=15)
        assert q.returncode==0,q.stdout+q.stderr
        logs['state-reference.json']=q.stdout
        return json.loads(q.stdout)

def sqlite_snapshot_reference():
    result=observe_snapshot()
    logs['sqlite-snapshot-reference.json']=json.dumps(result,ensure_ascii=False,indent=2)+'\n'
    return result

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--report-dir',type=Path);args=parser.parse_args()
    ordered=[('contract_and_data','ARTIFACT',contract_structure),
             ('generated_type_freshness','ARTIFACT',generated_types),
             ('strict_json_reader','ARTIFACT',strict_json_reference),
             ('behavior_digest_semantics','ARTIFACT',digest_semantics),
             ('html_snapshot_assertions','ARTIFACT',html_snapshots),
             ('feedback_and_sources','ARTIFACT',feedback_and_sources),
             ('experiment_plan_consistency','ARTIFACT',experiment_design_consistency),
             ('tsc_reference_roles','REFERENCE_TYPES',typecheck),
             ('wire_reference_semantics','WIRE_REFERENCE',wire_reference),
             ('sqlite_reference_semantics','SQL_ILLUSTRATION',sql_illustration),
             ('state_sync_url_reference','STATE_REFERENCE',state_reference),
             ('sqlite_snapshot_reference','SQL_SNAPSHOT_REFERENCE',sqlite_snapshot_reference)]
    for name,group,fn in ordered: run_check(name,group,fn)
    # Persist only actual completed reference observations before resolving report links.
    if args.report_dir:
        args.report_dir.mkdir(parents=True,exist_ok=True)
        for name,text in logs.items():(args.report_dir/name).write_text(text,encoding='utf-8')
        (args.report_dir/'verification.json').write_text(json.dumps(
            {'status':'RUNNING_ARTIFACT_LINK_CHECK','completedChecks':checks},
            ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    run_check('json_syntax','ARTIFACT',json_parse)
    run_check('markdown_links','ARTIFACT',markdown_links)
    result={'generatedAtUtc':datetime.now(timezone.utc).isoformat(),
            'python':platform.python_version(),'platform':platform.system(),'checks':checks,
            'productValidation':{'httpRuntime':'NOT_IMPLEMENTED_NOT_RUN',
             'doctorScanner':'NOT_IMPLEMENTED_NOT_RUN','browserAndAccessibilityEngine':'NOT_RUN',
             'isolatedNativeDomAttempt':'NOT_ATTEMPTED_V05_PRIOR_V04_BLOCK_RETAINED',
             'bunSqliteAdapter':'NOT_IMPLEMENTED_NOT_RUN','targetStableTypeScript':'NOT_RUN',
             'actualFormInventory':'NOT_RUN','p0BLSDValueComparison':'NOT_RUN',
             'postgresAsyncAdapter':'NOT_IMPLEMENTED_NOT_RUN','performance':'NOT_RUN'},
            'scope':'design-package consistency and bounded reference examples only'}
    if args.report_dir:
        (args.report_dir/'verification.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(result,ensure_ascii=False,indent=2))
    return 0 if all(c['status']=='VERIFIED_REFERENCE_ONLY' for c in checks) else 1
if __name__=='__main__':raise SystemExit(main())
