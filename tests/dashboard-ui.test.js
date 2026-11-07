const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const css=fs.readFileSync(path.join(__dirname,'..','styles.css'),'utf8');
const script=html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
if(!script)throw Error('inline portfolio script is missing');

function mount(sources,fetchImpl=null,sharedStore=null){
 const elements=new Map(),listeners={},store=sharedStore||new Map();
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
  fetch:fetchImpl||(()=>new Promise(()=>{})),
  console,AbortController:class{abort(){}get signal(){return {}}},
  setTimeout:()=>1,clearTimeout(){},setInterval:()=>{},
  window:{},FormData:class{constructor(form){this.form=form}get(key){return this.form.fields?.[key]??null}}
 };
 vm.runInNewContext(script.replace('window.fxmr4GetState=()=>', 'window.fxmr4Inspect={s,onAccounts,onSnapshot,render,renderLive,reconcileLive,pnlWindow,monthlyFutures,monthlyFuturesSeries,positionAge,futuresLedgerData,activeFuturesReports,positionAccountEquity,loadFuturesPeriod,observedEquitySeries,futuresCSVText,futuresValue,pnlBarSections,positionCostsFromBybit,overviewSpotHistory,overviewHistoryData,combineBybitChunks,fetchLongBybitPeriod,loadSpotHistory,loadMonthlyPerformance,persistBybitHistory,restoreBybitHistory};window.fxmr4GetState=()=>'),context,{filename:'index.html',timeout:3000});
 const click=(action,id='')=>{
  const target={dataset:{action,id},closest(selector){return selector==='[data-action]'?this:null}};
  for(const listener of listeners.click||[])listener({target});
 };
 const chooseFutureMode=futureMode=>{
  const target={dataset:{futureMode},closest(selector){return selector==='[data-future-mode]'?this:null}};
  for(const listener of listeners.click||[])listener({target});
 };
 const submit=(id,fields)=>{
  for(const listener of listeners.submit||[])listener({target:{id,fields},preventDefault(){}});
 };
 return {elements,window:context.window,element,store,document,themeControls,click,chooseFutureMode,submit};
}

test('overview has only All Spot Futures modes and true current open PNL',()=>{
 const {element}=mount([{id:'bybit',name:'Bybit',accounts:[]}]);
 const overview=element('content').innerHTML;
 assert.match(overview,/class="card tint overviewHero"/);
 assert.match(overview,/Баланс портфеля/);
 assert.match(overview,/Текущий PNL/);
 assert.match(overview,/Учтённые покупки Spot \+ открытые фьючерсы/);
 assert.match(overview,/data-overview-period/);
 assert.match(overview,/История PNL/);
 assert.match(overview,/data-pnl-mode="all"/);
 assert.match(overview,/data-pnl-mode="spot"/);
 assert.match(overview,/data-pnl-mode="futures"/);
 assert.doesNotMatch(overview,/data-pnl-mode="month"/);
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

test('futures shows real 30-day ledger, muted size and percentage of subaccount equity',()=>{
 const {element,window}=mount([{id:'bybit',name:'Bybit',accounts:[]}]);
 const view=window.fxmr4Inspect;
 view.onAccounts([{id:'sub-one',label:'Main subaccount'}]);
 view.onSnapshot({account:{id:'sub-one',name:'Main subaccount'},
  totals:{equity:3213.49,availableBalance:3000,perpUPL:-10,realisedPnl:-30,accountPnl:-40},
  positions:[{symbol:'XMRUSDT',side:'Long',size:91.72,initialMargin:20,pnl:4,openedAt:Date.now()-2*86400000}]});
 const now=Date.now();
 view.s.monthlyPerformance['sub-one']={
  from:now-30*86400000,to:now,netPnl:-5,tradingPnl:-2,funding:-1,fees:2,
  days:[{date:new Date(now-5*86400000).toISOString().slice(0,10),netPnl:-5}],
  points:[{t:now-5*86400000,netPnl:-5}],
  costEventsComplete:true,
  costEvents:[{t:now-86400000,symbol:'XMRUSDT',funding:-1,fees:2}]
 };
 view.s.tab='futures';view.render();
 const rendered=element('content').innerHTML;
 assert.match(rendered,/Результат за 30 дней/);
 assert.match(rendered,/Funding: −\$1\.00/);
 assert.match(rendered,/Комиссии: \$2\.00/);
 const top=rendered.split('class="section pnlChart')[0];
 assert.doesNotMatch(top,/Funding:/,'funding must not appear in summary');
 assert.doesNotMatch(top,/Комиссии:/,'commission must not appear in summary');
 assert.match(rendered,/К балансу, %/);
 assert.match(rendered,/0\.12%/);
 assert.doesNotMatch(rendered,/ROI · %/);
 assert.match(rendered,/posSize/);
 assert.match(rendered,/XMRUSDT/);
 assert.match(rendered,/polyline/,'monthly chart comes from the transaction ledger');
 assert.match(rendered,/Результат торгов · Bybit/);
 assert.doesNotMatch(rendered,/data-metric="balance"/);
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
 assert.match(rendered,/Результат за 30 дней/);
 assert.match(rendered,/Нет подтверждённой истории за этот период/);
 assert.equal(view.monthlyFutures(),null);
});

test('overview Futures tab uses actual Bybit ledger and not unlabelled account PNL',()=>{
 const {element,window}=mount([{id:'bybit',name:'Bybit',accounts:[]}]);
 const v=window.fxmr4Inspect;
 v.onAccounts([{id:'sub-one',label:'Primary'}]);
 const end=v.s.monthlyAnchorMs;
 v.s.monthlyPerformance['sub-one']={
  from:end-30*86400000,to:end,netPnl:13,tradingPnl:16,funding:-1,fees:2,
  days:[{date:new Date(end-86400000).toISOString().slice(0,10),netPnl:13}],
  points:[{t:end-86400000,netPnl:13}]
 };
 v.s.pnlMode='futures';v.s.chartPeriod.overview='30d';v.s.tab='overview';v.render();
 const overview=element('content').innerHTML;
 assert.match(overview,/История PNL/);
 assert.match(overview,/Реализованные сделки Bybit/);
 assert.match(overview,/polyline/);
 assert.match(overview,/\+\$13\.00/);
 assert.match(overview,/data-pnl-mode="futures"/);
 assert.doesNotMatch(overview,/data-pnl-mode="month"/);
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

test('observation periods remain available only in Spot and Futures sections',()=>{
 const {window,element}=mount([{id:'bybit',name:'Bybit',accounts:[]}]);
 const view=window.fxmr4Inspect,now=Date.now();
 view.s.backendConnection.configured=true;
 view.s.pnlHistory=[
  {t:now-600000,spot:0.7,futuresAccount:-288.18},
  {t:now-300000,spot:1.2,futuresAccount:-275.18}
 ];
 const total=view.pnlWindow('all','all').points;
 assert.equal(total.length,2);
 assert.equal(total[0].v,0);
 assert.ok(Math.abs(total[1].v-13.5)<0.000001);
 assert.ok(Math.abs(view.pnlWindow('spot','1y').points[1].v-0.5)<0.000001);
 view.s.tab='overview';view.render();
 assert.doesNotMatch(element('content').innerHTML,/data-period="all" data-chart="overview"/);
 view.s.tab='positions';view.render();
 assert.match(element('content').innerHTML,/data-period="1y" data-chart="spot"/);
 assert.match(element('content').innerHTML,/data-period="all" data-chart="spot"/);
 view.s.tab='futures';view.s.chartMetric.futures='pnl';view.render();
 assert.match(element('content').innerHTML,/data-period="1y" data-chart="futures"/);
 assert.match(element('content').innerHTML,/data-period="all" data-chart="futures"/);
});

test('passive DOM reconciler retains active form, focus and unchanged nodes',()=>{
 const {window,document}=mount([{id:'bybit',name:'Bybit',accounts:[]}]);
 const view=window.fxmr4Inspect;
 const textNode=value=>({nodeType:3,nodeValue:value,cloneNode(){return textNode(this.nodeValue)}});
 const el=(tag,children=[])=>{
  const node={nodeType:1,tagName:tag,id:'',isContentEditable:false,childNodes:children,
   attributes:[],hasAttribute(){return false},getAttribute(){return null},
   contains(x){return this.childNodes.includes(x)},
   cloneNode(){return el(this.tagName,this.childNodes.map(n=>n.cloneNode()))},
   appendChild(n){this.childNodes.push(n)},
   removeAttribute(){},setAttribute(){}};
  return node;
 };
 const typed=el('INPUT'),form=el('FORM',[typed]);
 typed.value='Мой незаконченный текст';
 const price=el('SPAN',[textNode('$100')]);
 const root=el('DIV',[form,price]);
 const incoming=el('DIV',[el('FORM',[el('INPUT')]),el('SPAN',[textNode('$101')])]);
 document.activeElement=typed;
 view.reconcileLive(root,incoming);
 assert.equal(root.childNodes[0],form,'must not replace focused form');
 assert.equal(form.childNodes[0],typed,'focused input remains same object');
 assert.equal(typed.value,'Мой незаконченный текст');
 assert.equal(root.childNodes[1],price,'stable metric container is not recreated');
 assert.equal(price.childNodes[0].nodeValue,'$101','only metric text changed');
 const fragment={nodeType:11,childNodes:[el('FORM',[el('INPUT')]),el('SPAN',[textNode('$102')])]};
 view.reconcileLive(root,fragment);
 assert.equal(root.childNodes[0],form,'template fragment must not replace the workspace');
 assert.equal(price.childNodes[0].nodeValue,'$102');
});

test('automatic updates do not restart pane animation or remount buying strategy',()=>{
 assert.match(html,/function renderLive\(\)/);
 assert.match(html,/reconcileLive\(content,template\.content\)/);
 assert.match(html,/current\.id==='strategyMount'/);
 assert.match(html,/current\.tagName==='FORM'&&active&&current\.contains\(active\)/);
 assert.doesNotMatch(html,/classList\.remove\('pane'\)/);
 assert.doesNotMatch(html,/classList\.add\('pane'\)/);
});

test('existing portfolio keeps a full historical Spot chart without overview time controls',()=>{
 const {window,store,element}=mount([{id:'bybit',name:'Bybit',accounts:[]}]);
 assert.equal(window.fxmr4Inspect.s.chartPeriod.spot,'all');
 assert.equal(store.get('fxmr4_chart_range_all_v1'),'1');
 assert.match(element('content').innerHTML,/class="section pnlChart card overviewLedger"/);
 assert.doesNotMatch(element('content').innerHTML,/data-period="all" data-chart="overview"/);
});
test('overview current PNL sums Spot and open futures, not lifetime account PNL',()=>{
 const {element,window}=mount([{id:'bybit',name:'Bybit',accounts:[]}]);
 const v=window.fxmr4Inspect;
 v.onAccounts([{id:'sub-a',label:'Alpha'},{id:'sub-b',label:'Beta'}]);
 for(const [id,upl] of [['sub-a',-17],['sub-b',3]]){
  v.onSnapshot({account:{id,name:id==='sub-a'?'Alpha':'Beta'},updatedAt:Date.now(),
   totals:{equity:100,perpUPL:upl,accountPnl:-200,realisedPnl:-186,positionCount:1},
   positions:[{symbol:'BTCUSDT',side:'Long',pnl:upl,size:120}]});
 }
 const end=v.s.monthlyAnchorMs;
 const base={from:end-30*86400000,to:end,tradingPnl:0,funding:0,fees:0,days:[],
  points:[{t:end-86400000,netPnl:0}]};
 v.s.monthlyPerformance['sub-a']={...base,netPnl:25,points:[{t:end-86400000,netPnl:25}]};
 v.s.monthlyPerformance['sub-b']={...base,netPnl:-4,points:[{t:end-86400000,netPnl:-4}]};
 v.s.tab='futures';v.s.futureMode='account';v.render();
 const futures=element('content').innerHTML;
 assert.match(futures,/Открытые позиции · PNL/);
 assert.match(futures,/−\$14\.00/);
 assert.match(futures,/\+\$21\.00/);
 assert.match(futures,/Alpha/);
 assert.match(futures,/Beta/);
 v.s.tab='overview';v.render();
 const overview=element('content').innerHTML;
 const holdings=window.fxmr4GetState().holdings;
 const expected=holdings.BTC.profit+holdings.ETH.profit-14;
 const fmt=(expected<0?'−':'+')+'$'+Math.abs(expected).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
 assert.match(overview,/Текущий PNL/);
 assert.ok(overview.includes(fmt),'overview current PNL includes tracked Spot and both open subaccounts');
 assert.match(overview,/−\$14\.00/);
 assert.match(overview,/\+\$21\.00/);
 assert.doesNotMatch(overview,/−\$400\.00/);
});

test('Bybit performance periods are computed from each subaccount ledger, never account onboarding',()=>{
 const {window,element}=mount([{id:'bybit',name:'Bybit',accounts:[]}]);
 const v=window.fxmr4Inspect;
 v.onAccounts([{id:'a',label:'A'},{id:'b',label:'B'}]);
 const end=v.s.monthlyAnchorMs,from=end-7*86400000;
 v.s.periodReports['7d']={
  a:{period:'7d',from,to:end,netPnl:10,funding:-1,fees:3,receivedAt:Date.now(),
   points:[{t:from+3600000,netPnl:10}]},
  b:{period:'7d',from,to:end,netPnl:-4,funding:0,fees:1,receivedAt:Date.now(),
   points:[{t:from+3600000,netPnl:-4}]}
 };
 const combined=v.futuresLedgerData('7d');
 assert.equal(combined.netPnl,6);
 assert.equal(combined.points[0].v,0);
 assert.equal(combined.points.at(-1).v,6);
 assert.equal(combined.points.length,3);
 v.s.chartPeriod.futures='7d';v.s.tab='futures';v.render();
 const screen=element('content').innerHTML;
 assert.match(screen,/Результат торгов · Bybit/);
 assert.match(screen,/data-period="7d" data-chart="futures" class="period active"/);
 assert.match(screen,/polyline/);
 assert.match(screen,/\+\$6\.00/);
 assert.doesNotMatch(screen,/PNL счёта/);
 assert.doesNotMatch(screen,/data-metric="balance"/);
 // One new subaccount without fetched history must not create fake profit.
 v.onAccounts([{id:'a',label:'A'},{id:'b',label:'B'},{id:'c',label:'C'}]);
 assert.equal(v.futuresLedgerData('7d'),null);
});

test('position percentage uses each account balance, never individual margin',()=>{
 const {window,element}=mount([{id:'bybit',name:'Bybit',accounts:[]}]);
 const v=window.fxmr4Inspect;
 v.onAccounts([{id:'a',label:'A'},{id:'b',label:'B'}]);
 for(const [id,equity] of [['a',1000],['b',200]]){
  v.onSnapshot({account:{id,name:id},updatedAt:Date.now(),
   totals:{equity,perpUPL:10,accountPnl:-100,positionCount:1},
   positions:[{symbol:'ADAUSDT',side:'Long',pnl:10,size:100,initialMargin:2}]});
 }
 v.s.tab='futures';v.render();
 const screen=element('content').innerHTML;
 assert.match(screen,/1\.00%/,'position on 1000 subaccount has 1 percent');
 assert.match(screen,/5\.00%/,'position on 200 subaccount has 5 percent');
 assert.doesNotMatch(screen,/500\.00%/,'never divide by $2 initial margin');
 assert.match(screen,/К балансу/);
 assert.equal(v.positionAccountEquity(v.s.futuresPositions.find(p=>p.accountId==='a')),1000);
});

test('selected period is requested from Bybit through authenticated backend, not old snapshots',()=>{
 assert.match(html,/api\/period-performance\?id=/);
 assert.match(html,/function loadFuturesPeriod\(period\)/);
 assert.match(html,/void loadFuturesPeriod\(s\.chartPeriod\.futures\)/);
 assert.match(html,/data-period="\$\{q\}"/);
 assert.doesNotMatch(html,/title='Доходность к начальной марже'/);
});

test('clicking history period fetches both Bybit subaccounts and reuses cached reporting',async()=>{
 const urls=[];
 const stub=async url=>{
  if(!String(url).includes('/api/period-performance?'))return new Promise(()=>{});
  if(!String(url).includes('period=24h'))return {ok:false,json:async()=>({error:'Данные за сегодня не загружены'})};
  urls.push(String(url));
  const key=url.includes('id=sub-a')?'sub-a':'sub-b';
  const end=Number(url.match(/endAt=(\d+)/)[1]);
  return {ok:true,json:async()=>({
   period:'24h',from:end-86400000,to:end,bucketMs:3600000,
   netPnl:key==='sub-a'?7:-2,funding:0,fees:0,
   points:[{t:end-3600000,netPnl:key==='sub-a'?7:-2}]
  })};
 };
 const {window,element}=mount([{id:'bybit',name:'Bybit',accounts:[]}],stub);
 const v=window.fxmr4Inspect;
 v.onAccounts([{id:'sub-a',label:'Alpha'},{id:'sub-b',label:'Beta'}]);
 v.s.backendConnection.available=true;
 await v.loadFuturesPeriod('24h');
 assert.equal(urls.length,2);
 assert.ok(urls.every(url=>url.includes('period=24h')&&url.includes('endAt=')));
 assert.equal(v.futuresLedgerData('24h').netPnl,5);
 await v.loadFuturesPeriod('24h');
 assert.equal(urls.length,2,'period data stays cached for same reporting window');
 v.s.chartPeriod.futures='24h';
 v.s.tab='futures';v.render();
 const markup=element('content').innerHTML;
 assert.match(markup,/data-period="24h" data-chart="futures" class="period active"/);
 assert.match(markup,/\+\$5\.00/);
 assert.match(markup,/polyline/);
});

test('overview current PNL excludes historic realised loss while Futures shows today separately',()=>{
 const {element,window}=mount([{id:'bybit',name:'Bybit',accounts:[]}]);
 const v=window.fxmr4Inspect;
 v.onAccounts([{id:'a',label:'Alpha'},{id:'b',label:'Beta'}]);
 for(const [id,equity,upl] of [['a',1000,3],['b',500,-5]]){
  v.onSnapshot({account:{id,name:id},updatedAt:Date.now(),
   totals:{equity,perpUPL:upl,accountPnl:-100,realisedPnl:-98,positionCount:1},
   positions:[{symbol:'ADAUSDT',pnl:upl,side:'Long',size:40}]});
 }
 const end=v.s.monthlyAnchorMs,begin=Math.floor(end/86400000)*86400000;
 const report=(netPnl)=>({from:begin,to:end,netPnl,funding:0,fees:0,
  points:[{t:begin+3600000,netPnl}],days:[],symbols:[]});
 v.s.periodReports.today={a:report(7),b:report(-4)};
 v.s.monthlyPerformance.a={...report(14),from:end-30*86400000};
 v.s.monthlyPerformance.b={...report(2),from:end-30*86400000};
 v.s.tab='overview';v.render();
 const markup=element('content').innerHTML;
 const h=window.fxmr4GetState().holdings;
 const combined=h.BTC.profit+h.ETH.profit-2;
 const expected=(combined<0?'−':'+')+'$'+Math.abs(combined).toFixed(2);
 assert.match(markup,/Текущий PNL/);
 assert.ok(markup.includes(expected),'sum Spot and current futures value');
 assert.match(markup,/\+\$16\.00/);
 assert.doesNotMatch(markup,/−\$200\.00/);
 v.s.tab='futures';v.render();
 assert.match(element('content').innerHTML,/PNL за сегодня/);
});

test('daily result and symbol bars use the same Bybit ledger and can export CSV',()=>{
 const {window,element}=mount([{id:'bybit',name:'Bybit',accounts:[]}]);
 const v=window.fxmr4Inspect;
 v.onAccounts([{id:'a',label:'Main'}]);
 const end=v.s.monthlyAnchorMs,from=end-60*86400000;
 v.s.periodReports['60d']={a:{from,to:end,netPnl:15,funding:-1,fees:2,receivedAt:Date.now(),
  points:[{t:from+3600000,netPnl:10},{t:from+2*3600000,netPnl:5}],
  days:[{date:'2026-10-01',netPnl:10},{date:'2026-10-08',netPnl:5}],
  symbols:[{symbol:'ADAUSDT',netPnl:18,operations:5},{symbol:'XMRUSDT',netPnl:-3,operations:1}]
 }};
 v.s.tab='futures';v.s.chartPeriod.futures='60d';v.render();
 const markup=element('content').innerHTML;
 assert.match(markup,/Результат по периодам/);
 assert.match(markup,/По активам/);
 assert.match(markup,/ADAUSDT/);
 assert.match(markup,/XMRUSDT/);
 assert.match(markup,/pnlBarItem/);
 assert.match(markup,/data-futures-unit="pct"/);
 assert.match(markup,/data-futures-account/);
 assert.match(markup,/data-action="exportFuturesCsv"/);
 const csv=v.futuresCSVText('60d','all','pnl');
 assert.match(csv,/daily/);
 assert.match(csv,/symbol/);
 assert.match(csv,/ADAUSDT/);
 assert.match(csv,/XMRUSDT/);
 assert.match(csv,/15/);
});

test('observed equity never invents a jump when another account joins',()=>{
 const {window,element}=mount([{id:'bybit',name:'Bybit',accounts:[]}]);
 const v=window.fxmr4Inspect;
 v.onAccounts([{id:'a',label:'Alpha'},{id:'b',label:'Beta'}]);
 const now=Math.floor(Date.now()/300000)*300000;
 v.s.equityHistory=[
  {accountId:'a',t:now-900000,equity:1100},
  {accountId:'a',t:now-600000,equity:1100},
  {accountId:'b',t:now-600000,equity:2200},
  {accountId:'a',t:now-300000,equity:1110},
  {accountId:'b',t:now-300000,equity:2190}
 ];
 const series=v.observedEquitySeries('7d');
 assert.equal(series.length,2);
 assert.equal(series[0].v,3300);
 assert.equal(series[1].v,3300);
 const one=v.observedEquitySeries('7d','a');
 assert.equal(one.length,3);
 v.s.tab='futures';v.s.futuresView='equity';v.s.chartPeriod.futures='7d';v.render();
 const markup=element('content').innerHTML;
 assert.match(markup,/Стоимость счёта · наблюдения/);
 assert.match(markup,/История стоимости сохраняется автоматически/);
 assert.match(markup,/polyline/);
 const csv=v.futuresCSVText('7d','all','equity');
 assert.match(csv,/observed_equity/);
 assert.match(csv,/3300/);
 assert.doesNotMatch(markup,/data-futures-unit="pct" class="active"/);
});

test('history and daily bars can filter one Bybit subaccount without changing aggregate cards',()=>{
 const {window,element}=mount([{id:'bybit',name:'Bybit',accounts:[]}]);
 const v=window.fxmr4Inspect;
 v.onAccounts([{id:'a',label:'Alpha'},{id:'b',label:'Beta'}]);
 for(const [id,equity] of [['a',1000],['b',2000]]){
  v.onSnapshot({account:{id,name:id},updatedAt:Date.now(),
   totals:{equity,perpUPL:0,positionCount:0},positions:[]});
 }
 const end=v.s.monthlyAnchorMs,from=end-30*86400000;
 const day=new Date(end-86400000).toISOString().slice(0,10);
 const report=(amount,symbol)=>({
  from,to:end,netPnl:amount,fees:0,funding:0,
  points:[{t:from+86400000,netPnl:amount}],
  days:[{date:day,netPnl:amount}],
  symbols:[{symbol,netPnl:amount,operations:2}]});
 v.s.monthlyPerformance.a=report(30,'ADAUSDT');
 v.s.monthlyPerformance.b=report(-10,'BTCUSDT');
 assert.equal(v.futuresLedgerData('30d','all').netPnl,20);
 assert.equal(v.futuresLedgerData('30d','a').netPnl,30);
 assert.equal(v.futuresLedgerData('30d','b').netPnl,-10);
 assert.equal(v.futuresValue(30,'pct','a'),'+3.00%');
 assert.equal(v.futuresValue(-10,'pct','b'),'−0.50%');
 v.s.tab='futures';
 v.s.futuresAccountFilter='a';v.s.futuresValueMode='pct';v.render();
 const markup=element('content').innerHTML;
 assert.match(markup,/\+3\.00%/,'the 30-day percent is net PNL divided by Alpha current equity');
 assert.match(markup,/ADAUSDT/);
 assert.doesNotMatch(markup,/BTCUSDT/);
 assert.match(markup,/data-futures-account/);
});

test('historical Spot mode uses real Bybit candle closes and recorded purchase dates',()=>{
 const {window,element}=mount([{id:'bybit',name:'Bybit',accounts:[]}]);
 const v=window.fxmr4Inspect,utc=Math.floor(Date.now()/86400000)*86400000;
 const t0=utc-2*86400000,t1=utc-86400000;
 v.s.trades=[{id:1,coin:'BTC',spent:100,entry:100,
  buy_date:new Date(t0).toISOString().slice(0,10),confirmed:true}];
 v.s.spotHistoricalReports['30d']={to:utc,from:utc-30*86400000,
  prices:{
   BTC:[{t:t0,close:100},{t:t1,close:120}],
   ETH:[{t:t0,close:200},{t:t1,close:210}]
  }};
 const spot=v.overviewHistoryData('spot','30d');
 assert.equal(spot.points.length,2);
 assert.equal(spot.points[0].v,0);
 assert.equal(spot.points[1].v,20);
 v.onAccounts([{id:'a',label:'Alpha'}]);
 v.s.monthlyPerformance.a={from:t0-86400000,to:t1+86400000,
  netPnl:10,tradingPnl:10,fees:0,funding:0,days:[],
  points:[{t:t1,netPnl:10}]};
 const futures=v.overviewHistoryData('futures','30d');
 assert.equal(futures.points.at(-1).v,10);
 const all=v.overviewHistoryData('all','30d');
 assert.equal(all.points.length,2);
 assert.equal(all.points[0].v,0);
 assert.equal(all.points[1].v,30,'combined chart is Spot change + futures trades on shared interval');
 v.s.pnlMode='all';v.s.tab='overview';v.render();
 const markup=element('content').innerHTML;
 assert.match(markup,/data-pnl-mode="all"/);
 assert.match(markup,/data-pnl-mode="spot"/);
 assert.match(markup,/data-pnl-mode="futures"/);
 assert.doesNotMatch(markup,/data-pnl-mode="month"/);
 assert.match(markup,/polyline/);
 assert.match(markup,/\+\$30\.00/);
});

test('missing Spot history never turns a six-month Futures total into a fake All portfolio chart',()=>{
 const {window,element}=mount([{id:'bybit',name:'Bybit',accounts:[]}]);
 const v=window.fxmr4Inspect;
 v.onAccounts([{id:'a',label:'A'}]);
 const day=Math.floor(Date.now()/86400000)*86400000;
 v.s.periodReports['6m']={a:{from:day-180*86400000,to:day,netPnl:142,
  points:[{t:day-86400000,netPnl:142}],days:[],symbols:[]}};
 assert.equal(v.overviewHistoryData('all','6m'),null);
 assert.equal(v.overviewHistoryData('futures','6m').points.at(-1).v,142);
 v.s.chartPeriod.overview='6m';v.s.tab='overview';v.s.pnlMode='all';v.render();
 const markup=element('content').innerHTML;
 assert.match(markup,/data-overview-period/);
 assert.match(markup,/нет полной сопоставимой истории/);
 assert.match(markup,/Для выбранного периода пока нет полной сопоставимой истории/);
 assert.doesNotMatch(markup,/<polyline/);
});

test('six-day Bybit chunks merge into 180-day report without gaps, duplicates or silent partial totals',async()=>{
 const seen=[];
 const startId='sub-one';
 const stub=async url=>{
  if(!String(url).includes('/api/period-chunk?'))return new Promise(()=>{});
  const u=String(url),start=Number(u.match(/startAt=(\d+)/)[1]),
   end=Number(u.match(/endAt=(\d+)/)[1]);
  seen.push([start,end]);
  return {ok:true,json:async()=>({from:start,to:end,netPnl:2,tradingPnl:2,
   funding:0,fees:0,points:[{t:start+1000,netPnl:2}],
   days:[{date:new Date(start).toISOString().slice(0,10),netPnl:2}],
   symbols:[{symbol:'ADAUSDT',netPnl:2,operations:1}]})};
 };
 const {window}=mount([{id:'bybit',name:'Bybit',accounts:[]}],stub);
 const v=window.fxmr4Inspect;
 v.onAccounts([{id:startId,label:'Alpha'}]);
 v.s.backendConnection.available=true;
 await v.loadFuturesPeriod('6m');
 assert.ok(seen.length>=30&&seen.length<=31,
  '180 rolling days require UTC-aligned six-day slices with at most two partial windows');
 assert.ok(seen.every(([start,end])=>end-start>0&&end-start<=6*86400000));
 assert.ok(seen.some(([start,end])=>end-start===6*86400000),
  'complete stable six-day windows must be reusable across subsequent days');
 const data=v.futuresLedgerData('6m');
 assert.ok(data,'all slices must have been checked before drawing history');
 assert.equal(data.netPnl,seen.length*2);
 assert.equal(data.days.length,seen.length);
 assert.equal(data.symbols[0].netPnl,seen.length*2);
 await v.loadFuturesPeriod('6m');
 assert.ok(seen.length<=31,'reload must reuse the period cache');
 const parts=[{from:0,to:1000,netPnl:1,points:[]},{from:1100,to:2000,netPnl:1,points:[]}];
 let threw=false;
 try{v.combineBybitChunks(parts,0,2000,'6m')}catch(e){threw=true}
 assert.ok(threw,'a missing history interval must never be labelled as zero PNL');
});

test('funding and fees appear only on the matching open position after its actual open time',()=>{
 const {element,window}=mount([{id:'bybit',name:'Bybit',accounts:[]}]);
 const v=window.fxmr4Inspect;
 v.onAccounts([{id:'a',label:'Alpha'},{id:'b',label:'Beta'}]);
 const opened=Date.now()-2*86400000;
 for(const accountId of ['a','b']){
  v.onSnapshot({account:{id:accountId,name:accountId},updatedAt:Date.now(),
   totals:{equity:1000,perpUPL:1,accountPnl:-20,positionCount:1},
   positions:[{symbol:'ADAUSDT',side:'Long',pnl:1,size:50,openedAt:opened}]});
 }
 const end=v.s.monthlyAnchorMs,from=end-30*86400000;
 const report={from,to:end,netPnl:1,funding:0,fees:0,points:[],days:[],
  costEventsComplete:true,costEvents:[
   {t:opened-60000,symbol:'ADAUSDT',funding:999,fees:999},
   {t:opened+60000,symbol:'ADAUSDT',funding:-0.6,fees:0.12},
   {t:opened+120000,symbol:'BTCUSDT',funding:100,fees:100}]};
 v.s.monthlyPerformance.a=report;
 v.s.monthlyPerformance.b={...report,costEvents:[
  {t:opened+100000,symbol:'ADAUSDT',funding:0.2,fees:0.02}]};
 const a=v.s.futuresPositions.find(p=>p.accountId==='a'),
       b=v.s.futuresPositions.find(p=>p.accountId==='b');
 const costsA=v.positionCostsFromBybit(a),costsB=v.positionCostsFromBybit(b);
 assert.ok(Math.abs(costsA.funding+0.6)<1e-8);
 assert.ok(Math.abs(costsA.fees-0.12)<1e-8);
 assert.ok(Math.abs(costsB.funding-0.2)<1e-8);
 assert.ok(Math.abs(costsB.fees-0.02)<1e-8);
 v.s.tab='futures';v.s.futureMode='all';v.render();
 const markup=element('content').innerHTML;
 assert.match(markup,/Funding: −\$0\.60/);
 assert.match(markup,/Комиссии: \$0\.12/);
 assert.match(markup,/Funding: \+\$0\.20/);
 assert.match(markup,/Комиссии: \$0\.02/);
 assert.doesNotMatch(markup,/\$999\.00/);
 const top=markup.split('class="section pnlChart')[0];
 assert.doesNotMatch(top,/Funding:/);
 assert.doesNotMatch(top,/Комиссии:/);
});
test('fees remain unknown for old positions, missing opening time and incomplete exchange reports',()=>{
 const {window}=mount([{id:'bybit',name:'Bybit',accounts:[]}]);
 const v=window.fxmr4Inspect;
 v.onAccounts([{id:'a',label:'Alpha'}]);
 const end=v.s.monthlyAnchorMs,from=end-30*86400000;
 v.s.monthlyPerformance.a={from,to:end,netPnl:10,costEventsComplete:true,
  costEvents:[{t:end-1000,symbol:'XMRUSDT',funding:-1,fees:1}]};
 const base={exchangeId:'bybit',accountId:'a',symbol:'XMRUSDT'};
 assert.ok(v.positionCostsFromBybit({...base,openedAt:null}).reason);
 assert.ok(v.positionCostsFromBybit({...base,openedAt:from-1}).reason);
 assert.ok(v.positionCostsFromBybit({...base,openedAt:end+1}).reason);
 v.s.monthlyPerformance.a.costEventsComplete=false;
 assert.ok(v.positionCostsFromBybit({...base,openedAt:from+1}).reason);
});

test('Futures cards keep equal layout, short today label, and four bottom descriptions',()=>{
 const {element,window}=mount([{id:'bybit',name:'Bybit',accounts:[]}]);
 const v=window.fxmr4Inspect;
 v.onAccounts([{id:'sub-one',label:'Alpha'}]);
 v.onSnapshot({account:{id:'sub-one',name:'Alpha'},updatedAt:Date.now(),
  totals:{equity:3000,availableBalance:2900,perpUPL:5,positionCount:1},
  positions:[{symbol:'ADAUSDT',side:'Long',size:90,pnl:5}]});
 v.s.tab='futures';v.render();
 const content=element('content').innerHTML;
 assert.equal(content.split('class="card tint futureMetricCard"').length-1,4);
 assert.equal(content.split('class="pnlParts"').length-1,4);
 assert.ok(content.includes('PNL за сегодня'));
 assert.ok(content.includes('1 позиций'));
 assert.ok(!content.includes('не закрыты'));
 assert.ok(!content.includes('Операции за сегодня · UTC'));
 assert.ok(css.includes('.futureMetricCard .pnlParts'));
 assert.ok(css.includes('margin-top:auto'));
});

test('Futures subaccounts and exchanges open by default and still close on click',()=>{
 const {window,element,click,chooseFutureMode}=mount([{id:'bybit',name:'Bybit',accounts:[]}]);
 const v=window.fxmr4Inspect;
 v.onAccounts([{id:'sub-one',label:'Alpha'}]);
 v.onSnapshot({account:{id:'sub-one',name:'Alpha'},updatedAt:Date.now(),
  totals:{equity:3000,perpUPL:1,positionCount:1},
  positions:[{symbol:'ADAUSDT',side:'Long',size:91,pnl:1}]});
 v.s.tab='futures';v.s.openedAccounts['bybit:sub-one']=false;
 chooseFutureMode('account');
 assert.equal(v.s.openedAccounts['bybit:sub-one'],true);
 assert.ok(element('content').innerHTML.includes('ADAUSDT'));
 click('toggleAccount','bybit:sub-one');
 assert.equal(v.s.openedAccounts['bybit:sub-one'],false);
 v.s.openedExchanges.bybit=false;
 chooseFutureMode('exchange');
 assert.equal(v.s.openedExchanges.bybit,true);
 assert.equal(v.s.openedAccounts['bybit:sub-one'],true);
 assert.ok(element('content').innerHTML.includes('sourceChildren'));
 click('toggleExchange','bybit');
 assert.equal(v.s.openedExchanges.bybit,false);
 delete v.s.openedExchanges.bybit;delete v.s.openedAccounts['bybit:sub-one'];
 v.render();
 assert.ok(element('content').innerHTML.includes('ADAUSDT'));
});

test('Sidebar icon and labels, Futures headings, native selector match UI feedback',()=>{
 assert.ok(!html.includes('<div class="navLabel">'));
 assert.ok(!html.includes('<div class="accountTotalLabel">Общий баланс</div>'));
 const overviewIcon=html.split('<symbol id="activity"')[1]?.split('</symbol>')[0];
 const futuresIcon=html.split('<symbol id="trend"')[1]?.split('</symbol>')[0];
 assert.ok(overviewIcon&&futuresIcon&&overviewIcon!==futuresIcon);
 assert.ok(html.includes('<span class="hLong">Объём</span>'));
 assert.ok(html.includes('<span class="hLong">PNL</span>'));
 assert.ok(!html.includes('<span class="hLong">Плавающий PNL</span>'));
 assert.ok(!html.includes('<span class="hLong">Объём · USD</span>'));
 const {element,window}=mount([{id:'bybit',name:'Bybit',accounts:[]}]);
 const v=window.fxmr4Inspect;v.s.tab='futures';v.render();
 assert.ok(element('content').innerHTML.includes('pnlAccountSelect'));
 assert.ok(element('content').innerHTML.includes('data-futures-account'));
 assert.ok(css.includes('.pnlAccountLabel .pnlAccountSelect select'));
 assert.ok(css.includes('appearance:none'));
});

test('Bar chart includes all daily values but only 3 non-overlapping axis ticks',()=>{
 const {element,window}=mount([{id:'bybit',name:'Bybit',accounts:[]}]);
 const v=window.fxmr4Inspect;v.onAccounts([{id:'a',label:'Alpha'}]);
 const end=v.s.monthlyAnchorMs;
 const start=Math.floor(end/86400000)*86400000-29*86400000;
 const days=Array.from({length:30},(_,i)=>({
  date:new Date(start+i*86400000).toISOString().slice(0,10),netPnl:i%2?1:-0.4
 }));
 const netPnl=days.reduce((sum,d)=>sum+d.netPnl,0);
 v.s.monthlyPerformance.a={from:start,to:end,netPnl,days,fees:0,funding:0,
  points:days.map((d,i)=>({t:start+i*86400000,netPnl:d.netPnl})),
  symbols:[{symbol:'ADAUSDT',netPnl,operations:30}]};
 v.s.tab='futures';v.s.chartPeriod.futures='30d';v.render();
 const content=element('content').innerHTML;
 const axis=content.split('class="pnlBarAxis"')[1]?.split('</div>')[0]||'';
 assert.ok(axis,'date axis must be visible');
 assert.equal(axis.split('<span>').length-1,3);
 assert.equal(content.split('class="pnlBarItem"').length-1,30);
 assert.ok(content.includes('ADAUSDT'));
 assert.ok(css.includes('.pnlBarList{gap:3px'));
 assert.ok(!content.includes('class="pnlBarItem"><small>'));
});

test('saved complete 180-day Bybit chart survives full browser reload with zero new API requests',async()=>{
 const shared=new Map(),urls=[];
 const stub=async url=>{
  const u=String(url);
  if(!u.includes('/api/period-chunk?'))return new Promise(()=>{});
  urls.push(u);
  const start=Number(u.match(/startAt=(\d+)/)[1]),
        end=Number(u.match(/endAt=(\d+)/)[1]);
  return {ok:true,json:async()=>({from:start,to:end,netPnl:3,tradingPnl:3,
   funding:0,fees:0,points:[{t:start+1000,netPnl:3}],
   days:[{date:new Date(start).toISOString().slice(0,10),netPnl:3}],
   symbols:[{symbol:'BTCUSDT',netPnl:3,operations:1}]})};
 };
 const first=mount([{id:'bybit',name:'Bybit',accounts:[]}],stub,shared);
 first.window.fxmr4Inspect.onAccounts([{id:'a',label:'Account A'}]);
 first.window.fxmr4Inspect.s.backendConnection.available=true;
 await first.window.fxmr4Inspect.loadFuturesPeriod('6m');
 const previous=first.window.fxmr4Inspect.futuresLedgerData('6m');
 assert.ok(previous&&previous.netPnl>0);
 assert.ok(shared.has('fxmr4_bybit_reports_v1'));
 assert.ok(shared.has('fxmr4_bybit_chunks_v1'));
 const originalRequests=urls.length;
 assert.ok(originalRequests>=30);
 const second=mount([{id:'bybit',name:'Bybit',accounts:[]}],stub,shared);
 second.window.fxmr4Inspect.onAccounts([{id:'a',label:'Account A'}]);
 second.window.fxmr4Inspect.s.backendConnection.available=true;
 assert.equal(second.window.fxmr4Inspect.futuresLedgerData('6m').netPnl,
   previous.netPnl,'chart data must exist before any new fetch');
 await second.window.fxmr4Inspect.loadFuturesPeriod('6m');
 assert.equal(urls.length,originalRequests,'reopening current history makes no repeat API calls');
 second.window.fxmr4Inspect.s.tab='futures';
 second.window.fxmr4Inspect.s.chartPeriod.futures='6m';
 second.window.fxmr4Inspect.render();
 assert.match(second.element('content').innerHTML,/polyline/);
 assert.doesNotMatch(second.element('content').innerHTML,/Нет подтверждённой истории за этот период/);
});

test('cached 30-day report remains when Bybit temporarily refuses its refresh',async()=>{
 const shared=new Map(),anchor=Math.floor(Date.now()/300000)*300000;
 const source={from:anchor-30*86400000,to:anchor,netPnl:23,fees:0,funding:0,
  points:[{t:anchor-86400000,netPnl:23}],days:[],symbols:[],
  receivedAt:Date.now()-3600000};
 const first=mount([{id:'bybit',name:'Bybit',accounts:[]}],null,shared);
 const a=first.window.fxmr4Inspect;
 a.onAccounts([{id:'a',label:'A'}]);
 a.s.monthlyPerformance.a=source;
 a.persistBybitHistory();
 const second=mount([{id:'bybit',name:'Bybit',accounts:[]}],
  async()=>({ok:false,json:async()=>({error:'Temporary Bybit outage'})}),shared);
 const b=second.window.fxmr4Inspect;
 b.onAccounts([{id:'a',label:'A'}]);
 b.s.backendConnection.available=true;
 assert.equal(b.futuresLedgerData('30d').netPnl,23,'data restored immediately');
 await b.loadMonthlyPerformance('a');
 assert.equal(b.futuresLedgerData('30d').netPnl,23,'temporary failure cannot erase graph');
 assert.ok(b.s.monthlyErrors.a);
});

test('chunk downloads reuse fixed historical windows and never repeat closed old slices',async()=>{
 const urls=[],stub=async url=>{
  const u=String(url);
  if(!u.includes('period-chunk'))return new Promise(()=>{});
  urls.push(u);
  const start=Number(u.match(/startAt=(\d+)/)[1]),end=Number(u.match(/endAt=(\d+)/)[1]);
  return {ok:true,json:async()=>({from:start,to:end,netPnl:1,tradingPnl:1,
   funding:0,fees:0,points:[{t:start+1000,netPnl:1}],days:[],symbols:[]})};
 };
 const {window}=mount([{id:'bybit',name:'Bybit',accounts:[]}],stub);
 const v=window.fxmr4Inspect;
 v.onAccounts([{id:'a',label:'A'}]);v.s.backendConnection.available=true;
 await v.loadFuturesPeriod('90d');
 const before=urls.length,oldChunks=Object.keys(v.s.periodChunkCache);
 assert.ok(oldChunks.length>=15);
 delete v.s.periodReports['90d'].a;
 await v.loadFuturesPeriod('90d');
 assert.equal(urls.length,before,'same UTC day only reuses downloaded chunks');
});

test('desktop sidebar stays viewport-height and sticky while main content scrolls',()=>{
 const desktop=css.match(/@media\(min-width:961px\)\s*\{([\s\S]*?)\n\}/)?.[1];
 assert.ok(desktop,'desktop breakpoint exists');
 assert.match(desktop,/\.sidebar\s*\{[^}]*position:sticky;top:26px/);
 assert.match(desktop,/\.sidebar\s*\{[^}]*height:calc\(100dvh - 52px\)/);
 assert.match(desktop,/\.sidebar\s*\{[^}]*align-self:start/);
 assert.match(desktop,/\.shell\s*\{[^}]*overflow:visible/);
 assert.match(desktop,/\.sidebar\s*\{[^}]*overflow-y:auto/);
 assert.match(css,/@media\(max-width:960px\)\s*\{[\s\S]*?\.tabs\s*\{\s*position:fixed/);
 assert.doesNotMatch(css,/@media\(max-width:960px\)\s*\{\s*\.sidebar\s*\{[^}]*position:sticky/);
});
