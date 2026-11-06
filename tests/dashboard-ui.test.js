const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const css=fs.readFileSync(path.join(__dirname,'..','styles.css'),'utf8');
const script=html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
if(!script)throw Error('inline portfolio script is missing');

function mount(sources){
 const elements=new Map(),listeners={};
 const element=id=>{
  if(!elements.has(id))elements.set(id,{
   id,innerHTML:'',textContent:'',dataset:{},style:{},offsetWidth:200,
   classList:{values:{},add(){},remove(){},toggle(name,value){this.values[name]=value}},
   setAttribute(){},scrollIntoView(){}
  });
  return elements.get(id);
 };
 const document={
  hidden:false,getElementById:element,
  querySelector:q=>q==='.tabs'?element('tabs'):element('unknown'),
  querySelectorAll:q=>q==='[data-tab]'?['overview','positions','futures'].map(tab=>({
   dataset:{tab},classList:{toggle(){}},setAttribute(){}
  })):[],
  addEventListener:(key,handler)=>(listeners[key]??=[]).push(handler)
 };
 const localStorage={
  getItem:k=>k==='fxmr4_portfolio_public_preview_v1'?JSON.stringify({sources}):null,
  setItem(){}
 };
 const context={
  document,localStorage,
  fetch:()=>new Promise(()=>{}),
  console,AbortController:class{abort(){}get signal(){return {}}},
  setTimeout:()=>1,clearTimeout(){},setInterval:()=>{},
  window:{},FormData:class{}
 };
 vm.runInNewContext(script,context,{filename:'index.html',timeout:3000});
 return {elements,window:context.window,element};
}

test('dashboard keeps only balance, PNL and two account tiles',()=>{
 const {element}=mount([{id:'bybit',name:'Bybit',accounts:[]}]);
 const overview=element('content').innerHTML;
 assert.match(overview,/class="card tint overviewHero"/);
 assert.match(overview,/class="sectitle">Портфель<\/div>/);
 for(const noise of ['Всего на счетах','Общий текущий PNL','heroBreakdown','assetSub','Весь портфель, спот или фьючерсы отдельно']){
  assert.ok(!overview.includes(noise),'unexpected UI noise: '+noise);
 }
 assert.ok(!html.includes('class="brandBadge">FXMR4'));
});

test('offline exchange is named in a red footer status',()=>{
 const {element}=mount([
  {id:'bybit',name:'Bybit',accounts:[]},
  {id:'bingx',name:'BingX',accounts:[]}
 ]);
 assert.equal(element('connectionStatusText').textContent,'BingX · не подключена');
 assert.equal(element('connectionDot').classList.values.isError,true);
});

test('bottom menu is fixed with icons below 960px and sync success is hidden',()=>{
 assert.match(css,/@media\(max-width:960px\)\s*\{[\s\S]*?\.tabs\s*\{\s*position:fixed/);
 assert.match(css,/\.tabs \.tab \.icon\s*\{display:block/);
 assert.match(css,/safe-area-inset-bottom/);
 assert.match(css,/\.cloudSyncStatus\s*\{display:none\}/);
 assert.match(css,/\.cloudSyncStatus\[data-error="true"\]\s*\{display:block/);
});
