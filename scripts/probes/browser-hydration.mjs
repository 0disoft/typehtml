import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {chromium} from 'playwright';
import React from 'react';
import {renderToString} from 'react-dom/server';
import {render} from 'svelte/server';
import {App} from './ReactApp.mjs';
import SvelteApp from './SvelteComponent-server.mjs';
const require=createRequire(import.meta.url);
const props=JSON.parse(await readFile('props.json','utf8'));
const pages={};
for(const framework of ['react','svelte'])for(const state of ['initial','invalid']) {
  const markup=props[state];
  const content=framework==='react'?renderToString(React.createElement(React.StrictMode,null,React.createElement(App,{markup}))):render(SvelteApp,{props:{markup}}).body;
  pages[`/${framework}?state=${state}`]=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${framework} hydration fixture</title></head><body><div id="root">${content}</div><script type="application/json" id="props">${JSON.stringify({markup}).replaceAll('<','\\u003c')}</script><script type="module" src="/${framework}.js"></script></body></html>`;
}
const bundles=Object.fromEntries(await Promise.all(['react','svelte'].map(async f=>[`/${f}.js`,await readFile(`${f}.js`)])));
const server=createServer((req,res)=>{
  if(req.url==='/submit'&&req.method==='POST') {
    const chunks=[];
    req.on('data',chunk=>chunks.push(chunk));
    req.on('end',()=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify([...new URLSearchParams(Buffer.concat(chunks).toString())]));});
    return;
  }
  if(req.url==='/favicon.ico'){res.writeHead(204);res.end();return;}
  if(bundles[req.url]){res.writeHead(200,{'content-type':'text/javascript'});res.end(bundles[req.url]);return;}
  if(pages[req.url]){res.writeHead(200,{'content-type':'text/html'});res.end(pages[req.url]);return;}
  res.writeHead(404);res.end();
});
let browser;
const checks=[];
const errors=[];
function observeErrors(page, label) {
  page.on('pageerror',e=>errors.push(`${label}: ${e.message}`));
  page.on('console',m=>{if(['error','warning'].includes(m.type()))errors.push(`${label}: ${m.text()}`);});
}
async function accessibility(page) {
  await page.addScriptTag({path:require.resolve('axe-core/axe.min.js')});
  const audit=await page.evaluate(()=>window.axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa']}}));
  assert.deepEqual(audit.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)})),[]);
  return {passes:audit.passes.length,manualReview:audit.incomplete.map(v=>v.id)};
}
try {
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({channel:'chrome',headless:true});
  for(const framework of ['react','svelte']) {
    const native=await browser.newPage({javaScriptEnabled:false});
    await native.goto(`${origin}/${framework}?state=initial`);
    assert.equal(await native.getByRole('textbox',{name:'Display name'}).inputValue(),'Ada');
    assert.equal(await native.getByRole('textbox',{name:'Notes',exact:true}).inputValue(),'\nFirst\nSecond');
    assert.equal(await native.getByRole('combobox',{name:'Size'}).inputValue(),'M');
    assert.equal(await native.getByRole('radio',{name:'yes',exact:true}).isChecked(),true);
    assert.equal((await native.locator('form').getAttribute('method')).toLowerCase(),'post');
    assert.equal(await native.locator('form').getAttribute('action'),'/submit');
    await native.getByRole('textbox',{name:'Display name'}).fill('Native POST');
    const response= native.waitForResponse(r=>r.url()===`${origin}/submit`);
    await native.getByRole('button',{name:'Save',exact:true}).click();
    assert.deepEqual((await (await response).json()).filter(([key])=>key!=='_bc_csrf'),[['name','Native POST'],['colors','red'],['notes','\r\nFirst\r\nSecond'],['size','M'],['choice','yes']]);
    await native.close();
    const page=await browser.newPage();
    observeErrors(page,framework);
    let release;
    const gate=new Promise(resolve=>{release=resolve;});
    await page.route(`**/${framework}.js`,async route=>{await gate;await route.continue();});
    await page.goto(`${origin}/${framework}?state=initial`,{waitUntil:'commit'});
    await page.getByRole('textbox',{name:'Display name'}).fill('Before hydration');
    await page.getByRole('textbox',{name:'Notes',exact:true}).fill('\nEdited before hydration');
    if(framework==='react')await page.getByRole('textbox',{name:'React props field'}).fill('Edited props');
    await page.evaluate(()=>{window.originalInput=document.querySelector('input[name=name]');});
    release();
    await page.waitForFunction(()=>window.ready===true);
    assert.equal(await page.getByRole('textbox',{name:'Display name'}).inputValue(),'Before hydration');
    assert.equal(await page.evaluate(()=>window.originalInput===document.querySelector('input[name=name]')),true);
    assert.equal(await page.getByRole('textbox',{name:'Notes',exact:true}).inputValue(),'\nEdited before hydration');
    if(framework==='react')assert.equal(await page.getByRole('textbox',{name:'React props field'}).inputValue(),'Edited props');
    await page.getByRole('textbox',{name:'Display name'}).fill('After hydration');
    await page.keyboard.press('Tab');
    assert.equal(await page.getByRole('checkbox',{name:'Email updates'}).evaluate(e=>e===document.activeElement),true);
    await page.getByRole('checkbox',{name:'Email updates'}).check();
    await page.getByRole('checkbox',{name:'Blue',exact:true}).check();
    await page.getByRole('combobox',{name:'Size'}).selectOption('S');
    await page.getByRole('radio',{name:'no',exact:true}).check();
    const entries=await page.evaluate(()=>[...new FormData(document.querySelector('form'))]);
    assert.deepEqual(entries.filter(([key])=>key!=='_bc_csrf'),[['name','After hydration'],['enabled','on'],['colors','red'],['colors','blue'],['notes','\nEdited before hydration'],['size','S'],['choice','no']]);
    await page.getByRole('button',{name:'Save',exact:true}).focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(()=>document.getElementById('status').textContent==='submitting');
    assert.equal(await page.getByRole('button',{name:'Start task',exact:true}).isDisabled(),true);
    assert.equal(await page.evaluate(async()=>{try{await window.qa.run(()=>1);return 'unexpected';}catch(e){return e.name;}}),'SubmissionPendingError');
    await page.evaluate(()=>{window.oldResolve=window.resolveTask;});
    await page.getByRole('button',{name:'Cancel task',exact:true}).focus();
    await page.keyboard.press('Space');
    await page.waitForFunction(()=>document.getElementById('status').textContent==='cancelled');
    assert.equal(await page.evaluate(()=>window.lastSignal.aborted),true);
    await page.getByRole('button',{name:'Start task',exact:true}).click();
    await page.waitForFunction(()=>document.getElementById('status').textContent==='submitting');
    await page.evaluate(()=>window.oldResolve('stale'));
    assert.equal(await page.locator('#status').textContent(),'submitting');
    await page.evaluate(()=>window.resolveTask('done'));
    await page.waitForFunction(()=>document.getElementById('status').textContent==='complete');
    assert.equal(await page.getByRole('textbox',{name:'Display name'}).inputValue(),'After hydration');
    if(framework==='react') {
      assert.equal(await page.getByRole('textbox',{name:'React props field'}).inputValue(),'Edited props');
      assert.deepEqual(await page.evaluate(()=>window.recovery),[]);
    }
    assert.equal(await page.evaluate(async()=>{const original=new Error('host failed');try{await window.qa.run(()=>Promise.reject(original));}catch(e){return e===original;}}),true);
    await page.waitForFunction(()=>document.getElementById('status').textContent==='error');
    assert.equal(await page.evaluate(async()=>{const controller=new AbortController();controller.abort(new Error('already cancelled'));let calls=0;try{await window.qa.run(()=>{calls++;},{signal:controller.signal});}catch(e){return calls===0&&e===controller.signal.reason;}}),true);
    await page.waitForFunction(()=>document.getElementById('status').textContent==='cancelled');
    const audit=await accessibility(page);
    await page.getByRole('button',{name:'Start task',exact:true}).click();
    await page.waitForFunction(()=>document.getElementById('status').textContent==='submitting');
    await page.getByRole('button',{name:'Unmount',exact:true}).click();
    await page.waitForFunction(()=>window.disposed&&window.lastSignal.aborted&&document.getElementById('root').childElementCount===0);
    await page.close();
    const invalid=await browser.newPage();
    observeErrors(invalid,`${framework}/invalid`);
    await invalid.goto(`${origin}/${framework}?state=invalid`);
    await invalid.waitForFunction(()=>window.ready===true);
    const links=await invalid.evaluate(()=>[...document.querySelectorAll('[aria-describedby],[aria-labelledby]')].every(e=>['aria-describedby','aria-labelledby'].every(attr=>(e.getAttribute(attr)??'').split(/\s+/).filter(Boolean).every(id=>document.getElementById(id)))));
    assert.equal(links,true);
    assert.equal(await invalid.getByRole('textbox',{name:'Display name'}).getAttribute('aria-invalid'),'true');
    assert.equal(await invalid.evaluate(()=>window.focusSummary()),true);
    assert.equal(await invalid.locator('[data-typehtml-error-summary]').evaluate(e=>e===document.activeElement),true);
    await invalid.getByRole('link',{name:'Enter at least two characters'}).focus();
    await invalid.keyboard.press('Enter');
    assert.equal(await invalid.getByRole('textbox',{name:'Display name'}).evaluate(e=>e===document.activeElement),true);
    const invalidAudit=await accessibility(invalid);
    if(framework==='react')assert.deepEqual(await invalid.evaluate(()=>window.recovery),[]);
    checks.push({framework,noJavaScriptNativeControls:true,ssrHydrated:true,preHydrationEditsPreserved:true,keyboard:true,cancellation:true,hostErrorPreserved:true,unmount:true,axe:audit,invalidAxe:invalidAudit,violations:0});
    await invalid.close();
  }
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({status:'passed',browser:await browser.version(),versions:Object.fromEntries(['@0disoft/typehtml','react','react-dom','svelte','axe-core','playwright'].map(p=>[p,require(`${p}/package.json`).version])),checks,consoleErrors:errors}));
} finally {
  if(browser)await browser.close();
  server.closeAllConnections();
  await new Promise(resolve=>server.close(resolve));
}
