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
 const elements=new Map(),listeners={},store=new Map();
 const themeControls=Array.from({length:2},()=>({
  attrs:{},iconHref:'',
  setAttribute(k,v){this.attrs[k]=v},
  querySelector(sel){return sel==='use'?{setAttribute:(k,v)=>{this.iconHref=v}}:null}
 }));
 const element=id=>{
  if(!elements.has(id))elements.set(id,{
   id,innerHTML:'',textContent:'',dataset:{},style:{},offsetWidth:200,
   classList:{values:{},add(){},remove(){},toggle(name,value){this.values[name]=value}},
   setAttribute(){},scrollIntoView(){}
  });
  return elements.get(id);
 };
 const document={
  hidden:false,documentElement:{dataset:{}},getElementById:element,
  querySelector:q=>q==='.tabs'?element('tabs'):element('unknown'),
  querySelectorAll:q=>q==='[data-action="toggleTheme"]'?themeControls:
   q==='[data-tab]'?['overview','positions','futures'].map(tab=>({
    dataset:{tab},classList:{toggle(){}},setAttribute(){}
   })):[],
  addEventListener:(key,handler)=>(listeners[key]??=[]).push(handler)
 };
 const localStorage={
  getItem:k=>store.has(k)?store.get(k):k==='fxmr4_portfolio_public_preview_v1'?JSON.stringify({sources}):null,
  setItem(k,v){store.set(k,v)}
 };
 const context={
  document,localStorage,
  fetch:()=>new Promise(()=>{}),
  console,AbortController:class{abort(){}get signal(){return {}}},
  setTimeout:()=>1,clearTimeout(){},setInterval:()=>{},
  window:{},FormData:class{constructor(form){this.form=form}get(key){return this.form.fields?.[key]??null}}
 };
 vm.runInNewContext(script,context,{filename:'index.html',timeout:3000});
 const click=action=>{
  const target={dataset:{action},closest(selector){return selector==='[data-action]'?this:null}};
  for(const listener of listeners.click||[])listener({target});
 };
 const submit=(id,fields)=>{
  for(const listener of listeners.submit||[])listener({target:{id,fields},preventDefault(){}});
 };
 return {elements,window:context.window,element,store,document,themeControls,click,submit};
}

test('dashboard shows labeled current and monthly PNL with top-aligned Spot/Futures tiles',()=>{
 const {element}=mount([{id:'bybit',name:'Bybit',accounts:[]}]);
 const overview=element('content').innerHTML;
 assert.match(overview,/class="card tint overviewHero"/);
 assert.match(overview,/Баланс портфеля/);
 assert.match(overview,/class="sectitle">Портфель<\/div>/);
 assert.equal((overview.match(/Текущий PNL/g)||[]).length,3);
 assert.equal((overview.match(/Месячный PNL/g)||[]).length,3);
 assert.match(overview,/class="assetTopline"/);
 assert.match(overview,/class="assetPnlMetrics"/);
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

test('Capital is an inline, collapsible Spot budget, not a settings tab',()=>{
 const {element,click,submit,store}=mount([{id:'bybit',name:'Bybit',accounts:[]}]);
 click('goConnections');
 const settings=element('content').innerHTML;
 assert.match(settings,/id="bybitConnectionPanel"/);
 assert.doesNotMatch(settings,/settingsTabs|data-settings-pane|Плановый капитал|Запланированный капитал/);
 click('gotoSpot');
 const spot=element('content').innerHTML;
 assert.match(spot,/План \\$1,000/);
 assert.doesNotMatch(spot,/id="capitalForm"/,'collapsed by default');
 click('toggleCapital');
 const opened=element('content').innerHTML;
 assert.match(opened,/id="capitalForm"/);
 assert.match(opened,/id="plannedCapital"/);
 submit('capitalForm',{capital:'1200'});
 const saved=element('content').innerHTML;
 assert.match(saved,/План \\$1,200/);
 assert.doesNotMatch(saved,/id="capitalForm"/,'auto-collapsed after saving');
 const portfolio=JSON.parse(store.get('fxmr4_portfolio_public_preview_v1'));
 assert.equal(portfolio.capital,1200);
});

test('manual theme icon swaps dark/light and persists independently of portfolio',()=>{
 const {click,store,document,themeControls}=mount([{id:'bybit',name:'Bybit',accounts:[]}]);
 assert.match(html,/<script data-theme-init>/);
 assert.match(html,/data-action="toggleTheme"/);
 assert.match(css,/:root\[data-theme="dark"\]/);
 assert.match(css,/:root\[data-theme="light"\]/);
 click('toggleTheme');
 assert.equal(document.documentElement.dataset.theme,'dark');
 assert.equal(store.get('fxmr4_theme_v1'),'dark');
 assert.ok(themeControls.every(b=>b.iconHref==='#sun'));
 assert.ok(themeControls.every(b=>b.attrs['aria-label']==='Включить светлую тему'));
 click('toggleTheme');
 assert.equal(document.documentElement.dataset.theme,'light');
 assert.equal(store.get('fxmr4_theme_v1'),'light');
 assert.ok(themeControls.every(b=>b.iconHref==='#moon'));
});
