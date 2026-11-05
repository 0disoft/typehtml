"""Optional isolated Chromium observations. No target app, Doctor, external site or benchmark.
Uses an installed Chromium and playwright; never downloads browsers. Output is explicit.
"""
from pathlib import Path
import argparse, json, shutil, datetime, platform
ROOT=Path(__file__).resolve().parents[1]
def main():
    p=argparse.ArgumentParser();p.add_argument('--output',type=Path);args=p.parse_args()
    from playwright.sync_api import sync_playwright
    exe=shutil.which('chromium') or shutil.which('google-chrome')
    if not exe: raise SystemExit('NOT_RUN: installed Chromium not found')
    spec=json.loads((ROOT/'reference/native-form-cases.json').read_text());rows=[]
    with sync_playwright() as pw:
        browser=pw.chromium.launch(executable_path=exe,headless=True,args=['--no-sandbox'])
        context=browser.new_context();context.route('**/*',lambda route:route.fulfill(status=200,content_type='text/html',body='<!doctype html><title>isolated</title>'))
        page=context.new_page();page.goto(spec['documentUrl'])
        for c in spec['cases']:
            page.set_content('<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body>'+c['html']+'</body></html>')
            result=page.evaluate('''c => {
              const f=document.getElementById('f');
              const button=c.submitter ? document.getElementById(c.submitter) : null;
              if(c.mutation==='formdata-demo') f.addEventListener('formdata',e=>e.formData.append('injected','yes'));
              const data=button ? new FormData(f,button) : new FormData(f);
              const result={entries:[...data.entries()].map(([k,v])=>[k,typeof v==='string'?v:'FILE']),valid:f.checkValidity(),
                effective:{url:button?.hasAttribute('formaction')?button.formAction:f.action,
                  method:button?.hasAttribute('formmethod')?button.formMethod:f.method,
                  encoding:button?.hasAttribute('formenctype')?button.formEnctype:f.enctype,
                  skipValidation:f.noValidate || (button?.formNoValidate ?? false)}};
              if(c.inspect) result.willValidate=document.getElementById(c.inspect).willValidate;
              if(c.probe==='request-submit') {
                let n=0;f.addEventListener('submit',e=>{e.preventDefault();n++});
                f.requestSubmit(button);result.normalSubmitEvents=n;
                button.formNoValidate=true;f.requestSubmit(button);result.noValidateSubmitEvents=n;
              }
              return result;
            }''',c)
            matches=all(result.get(k)==v for k,v in c['expect'].items())
            rows.append({'id':c['id'],'status':'OBSERVED_MATCH' if matches else 'MISMATCH','expectedSubset':c['expect'],'observed':result})
        version=browser.version;context.close();browser.close()
    report={'generatedAtUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'classification':'ISOLATED_NATIVE_DOM_REFERENCE','platform':platform.system(),'browser':'Chromium '+version,'executable':exe,'externalNetworkUsed':False,'cases':rows,'productClaims':{'doctorExecuted':False,'httpRuntimeExecuted':False,'accessibilityEngineExecuted':False,'p0Executed':False,'crossBrowserCoverage':False},'scope':'single browser, synthetic DOM; FormData observations are not actual HTTP submissions'}
    if args.output:args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'browser':report['browser'],'cases':len(rows),'matches':sum(r['status']=='OBSERVED_MATCH' for r in rows),'scope':report['scope']},ensure_ascii=False))
    return 0 if all(r['status']=='OBSERVED_MATCH' for r in rows) else 1
if __name__=='__main__':
    try:
        raise SystemExit(main())
    except Exception as exc:
        import sys
        report={'classification':'NATIVE_DOM_REFERENCE_ATTEMPT','status':'NOT_COMPLETED',
                'error':str(exc),'executedCaseCount':None,'productRun':False,
                'scope':'No success assertion. Do not work around environment navigation policy.'}
        if '--output' in sys.argv:
            at=sys.argv.index('--output')+1
            if at<len(sys.argv):
                target=Path(sys.argv[at]);target.parent.mkdir(parents=True,exist_ok=True)
                target.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
        print(json.dumps(report,ensure_ascii=False));raise SystemExit(2)

