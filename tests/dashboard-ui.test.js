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
 vm.runInNewContext(script.replace('window.fxmr4GetState=()=>', 'window.fxmr4Inspect={s,onAccounts,onSnapshot,render,monthlyFutures,monthlyFuturesSeries,positionAge};window.fxmr4GetState=()=>'),context,{filename:'index.html',timeout:3000});
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
 assert.match(spot,/План \$1,000/);
 assert.doesNotMatch(spot,/id="capitalForm"/,'collapsed by default');
 click('toggleCapital');
 const opened=element('content').innerHTML;
 assert.match(opened,/id="capitalForm"/);
 assert.match(opened,/id="plannedCapital"/);
 submit('capitalForm',{capital:'1200'});
 const saved=element('content').innerHTML;
 assert.match(saved,/План \$1,200/);
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

test('futures shows real 30-day ledger result, funding, fees, muted size and desktop ROI',()=>{
 const {element,window}=mount([{id:'bybit',name:'Bybit',accounts:[]}]);
 const view=window.fxmr4Inspect;
 view.onAccounts([{id:'sub-one',label:'Main subaccount'}]);
 view.onSnapshot({account:{id:'sub-one',name:'Main subaccount'},
  totals:{equity:3213.49,availableBalance:3000,perpUPL:-10,realisedPnl:-30,accountPnl:-40},
  positions:[{symbol:'XMRUSDT',side:'Long',size:91.72,initialMargin:20,pnl:4,openedAt:null}]});
 const now=Date.now();
 view.s.monthlyPerformance['sub-one']={
  from:now-30*86400000,to:now,netPnl:-5,tradingPnl:-2,funding:-1,fees:2,
  days:[{date:new Date(now-5*86400000).toISOString().slice(0,10),netPnl:-5}]
 };
 view.s.tab='futures';view.render();
 const rendered=element('content').innerHTML;
 assert.match(rendered,/30 дней · PNL/);
 assert.match(rendered,/Funding: −\$1\.00/);
 assert.match(rendered,/Комиссии: \$2\.00/);
 assert.match(rendered,/ROI · %/);
 assert.match(rendered,/posSize/);
 assert.match(rendered,/XMRUSDT/);
 assert.match(rendered,/polyline/,'monthly chart comes from the transaction ledger');
 assert.equal(view.monthlyFutures().netPnl,-5);
 assert.equal(view.monthlyFuturesSeries().length,3);
 assert.equal(view.positionAge(null),'—','unknown open time is not a 344-day position');
 assert.match(css,/\.futurePosition:not\(\.futureHead\) \.posSize strong\{color:var\(--sub\)/);
 assert.match(css,/@media\(max-width:960px\)[\s\S]*?\.futurePosition \.posRoi\{display:none\}/);
});

test('no historical ledger never invents a monthly profit',()=>{
 const {element,window}=mount([{id:'bybit',name:'Bybit',accounts:[]}]);
 const view=window.fxmr4Inspect;
 view.onAccounts([{id:'sub-two',label:'Second'}]);
 view.s.tab='futures';view.render();
 const rendered=element('content').innerHTML;
 assert.match(rendered,/30 дней · PNL/);
 assert.match(rendered,/Загружаем операции Bybit/);
 assert.equal(view.monthlyFutures(),null);
});

test('overview month mode draws exchange cash-PNL, not a synthetic portfolio curve',()=>{
 const {element,window}=mount([{id:'bybit',name:'Bybit',accounts:[]}]);
 const v=window.fxmr4Inspect;
 v.onAccounts([{id:'sub-one',label:'Primary'}]);
 const end=v.s.monthlyAnchorMs;
 v.s.monthlyPerformance['sub-one']={
  from:end-30*86400000,to:end,netPnl:13,tradingPnl:16,funding:-1,fees:2,
  days:[{date:new Date(end-86400000).toISOString().slice(0,10),netPnl:13}]
 };
 v.s.pnlMode='month';v.s.tab='overview';v.render();
 const html=element('content').innerHTML;
 assert.match(html,/PNL · Фьючерсы за 30 дней/);
 assert.match(html,/Результат завершённых операций/);
 assert.match(html,/data-pnl-mode="month"/);
 assert.match(html,/polyline/);
 assert.match(html,/\+\$13\.00/);
 assert.doesNotMatch(html,/data-period="24h" data-chart="overview"/);
});

test('multiaccount monthly summary requires one identical 30-day reporting window',()=>{
 const {window}=mount([{id:'bybit',name:'Bybit',accounts:[]}]);
 const v=window.fxmr4Inspect;
 v.onAccounts([{id:'a',label:'A'},{id:'b',label:'B'}]);
 const end=v.s.monthlyAnchorMs;
 const first={from:end-30*86400000,to:end,netPnl:3,tradingPnl:5,funding:-1,fees:1,days:[]};
 const second={...first,netPnl:2,tradingPnl:3};
 v.s.monthlyPerformance.a=first;
 v.s.monthlyPerformance.b={...second,to:end-300000};
 assert.equal(v.monthlyFutures(),null,'cannot mix unmatched reporting intervals');
 v.s.monthlyPerformance.b=second;
 assert.equal(v.monthlyFutures().netPnl,5);
});
