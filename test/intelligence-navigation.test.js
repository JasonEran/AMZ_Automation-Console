import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';

test('intelligence mounts once, retains controls and only polls while visible without a dialog', async () => {
  const elements=new Map(), timers=[];
  let mounts=0, bindings=0, requests=0, visible=true, dialogOpen=false, click;
  const control=()=>({value:'',hidden:false,textContent:'',innerHTML:'',disabled:false,
    classList:{toggle(){}},setAttribute(){},addEventListener(){}});
  const tabs=['compare','events','targets'].map(name=>({...control(),dataset:{tab:name}}));
  const root={
    append(){mounts++;},
    querySelector(selector){
      if(selector==='dialog[open]')return dialogOpen?{}:null;
      if(!elements.has(selector))elements.set(selector,control());
      return elements.get(selector);
    },
    querySelectorAll(selector){return selector==='[data-tab]'?tabs:[];},
    addEventListener(type,handler){assert.equal(type,'click');bindings++;click=handler;}
  };
  root.querySelector('#targetForm').elements={role:control(),storeKey:control()};
  const host={attachShadow(){return root;},getClientRects(){return visible?[{}]:[];}};
  const document={hidden:false,getElementById(id){
    return id==='intelligenceView'?host:{content:{cloneNode(){return {};}}};
  }};
  const window={};
  const context=vm.createContext({window,document,setInterval(fn){timers.push(fn);},fetch:async()=>{
    requests++;return {ok:true,status:200,json:async()=>({summary:{targets:0,enabled:0,unreviewed:0,collectionGaps:0},settings:{autoCollect:false},canManage:false,targets:[],events:[],comparisons:[]})};
  }});
  vm.runInContext(fs.readFileSync(new URL('../src/web/intelligence-client.js',import.meta.url),'utf8'),context);
  const settled=()=>new Promise(resolve=>setImmediate(resolve));
  assert.equal(requests,0);
  window.amzIntelligence.activate();await settled();
  assert.equal(requests,1);
  const search=root.querySelector('#search'),filter=root.querySelector('#filter');
  search.value='saved search';search.oninput({target:search});
  filter.value='gaps';filter.onchange({target:filter});
  click({target:{closest:()=>({dataset:{tab:'targets'},hasAttribute:()=>false})}});
  for(let i=0;i<3;i++){
    visible=false;window.amzIntelligence.suspend();timers[0]();await settled();
    visible=true;window.amzIntelligence.activate();await settled();
  }
  assert.equal(mounts,1);assert.equal(bindings,1);assert.equal(timers.length,1);assert.equal(requests,1);
  assert.equal(search.value,'saved search');assert.equal(filter.value,'gaps');
  assert.equal(root.querySelector('#targetsPanel').hidden,false);
  assert.equal(root.querySelector('#comparePanel').hidden,true);
  dialogOpen=true;timers[0]();await settled();assert.equal(requests,1);
  dialogOpen=false;document.hidden=true;timers[0]();await settled();assert.equal(requests,1);
  document.hidden=false;timers[0]();await settled();assert.equal(requests,2);
  await window.amzIntelligence.refresh();assert.equal(requests,3);
  assert.equal(search.value,'saved search');assert.equal(filter.value,'gaps');
  assert.equal(root.querySelector('#targetsPanel').hidden,false);
});
