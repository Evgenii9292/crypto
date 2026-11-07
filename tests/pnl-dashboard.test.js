const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.join(__dirname,'..');
const main=fs.readFileSync(path.join(root,'index.html'),'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
const levels=fs.readFileSync(path.join(root,'levels.js'),'utf8');
function mount(history=[],localPortfolio=null){
 const nodes=new Map(),listeners={};
 const el=id=>{
  if(!nodes.has(id))nodes.set(id,{
    id,innerHTML:'',textContent:'',dataset:{},style:{},offsetWidth:700,
    classList:{add(){},remove(){},toggle(){}},
    scrollIntoView(){},setAttribute(){},getAttribute(){return null}
  });
  return nodes.get(id);
 };
 const document={
  hidden:false,getElementById:el,querySelector:()=>el('tabs'),querySelectorAll:()=>[],
  addEventListener:(type,fn)=>(listeners[type]??=[]).push(fn)
 };
 const data=new Map();
 if(localPortfolio)data.set('fxmr4_portfolio_public_preview_v1',JSON.stringify(localPortfolio));
 const localStorage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)};
 const fetch=url=>String(url).includes('/api/pnl-history')
    ?Promise.resolve({ok:true,json:async()=>({points:history})})
    :new Promise(()=>{});
 const window={};
 const context={document,window,localStorage,fetch,
  console,AbortController:class{abort(){}get signal(){return {}}},
  setTimeout:()=>1,clearTimeout(){},setInterval:()=>{},
  FormData:class{}};
 const instrumented=main.replace('window.fxmr4GetState=()=>','window.fxmr4Test={s,render};window.fxmr4GetState=()=>');
 vm.runInNewContext(instrumented,context,{filename:'index.html',timeout:3000});
 return {el,window,document,listeners,data};
}
test('overview labels current PNL and historical results separately',()=>{
 const {el}=mount();
 const markup=el('content').innerHTML;
 assert.match(markup,/Баланс портфеля/);
 assert.match(markup,/Текущий PNL[\s\S]*Учтённые покупки Spot \+ открытые фьючерсы/);
 assert.match(markup,/Фьючерсы · 30 дней[\s\S]*Результат закрытых операций Bybit/);
 for(const mode of ['all','spot','futures'])assert.match(markup,new RegExp(`data-pnl-mode="${mode}"`));
 assert.doesNotMatch(markup,/data-pnl-mode="month"|Всего на счетах|heroBreakdown/);
 assert.match(markup,/class="assetTopline"/);
});
test('overview never treats Spot-only samples as combined ledger history',async()=>{
 const now=Date.now();
 const history=[{t:now-3600000,spot:-.18,total:49.7},{t:now-200000,spot:-.2,total:53}];
 const {window,el}=mount(history);
 for(let i=0;i<100;i++)await Promise.resolve();
 window.fxmr4App.onAccounts([{id:'bybit-subaccount',label:'Account'}]);
 window.fxmr4App.onSnapshot({account:{id:'bybit-subaccount'},totals:{equity:1100,perpUPL:-3.12},positions:[],updatedAt:now});
 const markup=el('content').innerHTML;
 assert.match(markup,/нет полной сопоставимой истории/);
 assert.doesNotMatch(markup,/<polyline points=|\+\$49\.7|\+\$53\.00/);
});
test('offline server samples fill gaps in the Spot observations chart',async()=>{
 const now=Date.now(),t=h=>now-h*3600000;
 const local={capital:1000,trades:[],snapshots:[{time:t(6),pnl:-.50},{time:t(1),pnl:-.30}]};
 const {el,listeners}=mount([{t:t(4),spot:-.40},{t:t(2),spot:-.38}],local);
 for(let i=0;i<150;i++)await Promise.resolve();
 click(listeners,'[data-tab]',{tab:'positions'});
 const points=el('content').innerHTML.match(/<polyline points="([^"]+)"/)?.[1];
 assert.equal(points?.trim().split(' ').length,4);
});
function click(listeners,selector,dataset){
 for(const fn of listeners.click||[])fn({target:{closest:q=>q===selector?{dataset}:null}});
}
test('closing a losing futures position keeps the realised loss in the trading result',()=>{
 const {window,el,listeners}=mount();
 const bridge=window.fxmr4App,{s,render}=window.fxmr4Test;
 const id='bybit-subaccount',at=Date.now(),end=s.monthlyAnchorMs,from=end-30*86400000;
 bridge.onAccounts([{id,label:'Account'}]);
 const report=netPnl=>({from,to:end,netPnl,days:[],points:[{t:end-300000,netPnl}]});
 s.monthlyPerformance[id]=report(-3);
 bridge.onSnapshot({account:{id,name:'Account'},totals:{equity:1000,perpUPL:-12,positionCount:1},
  positions:[{symbol:'XMRUSDT',size:100,pnl:-12,side:'Long'}],updatedAt:at});
 click(listeners,'[data-tab]',{tab:'futures'});
 assert.match(el('content').innerHTML,/Открытые позиции · PNL<\/div>\s*<div[^>]*>−\$12\.00/);
 s.monthlyPerformance[id]=report(-15);
 bridge.onSnapshot({account:{id,name:'Account'},totals:{equity:1000,perpUPL:0,positionCount:0},positions:[],updatedAt:at+300000});
 render();
 const markup=el('content').innerHTML;
 assert.match(markup,/Результат за 30 дней<\/div>\s*<div[^>]*>−\$15\.00/);
 assert.doesNotMatch(markup,/\+\$12\.00/);
});
test('equity view charts observed balances as money without a profit sign',()=>{
 const {window,el,listeners}=mount();
 const id='bybit-subaccount',now=Date.now();
 window.fxmr4App.onAccounts([{id,label:'Account'}]);
 window.fxmr4Test.s.equityHistory=[{t:now-600000,accountId:id,equity:1000},{t:now-300000,accountId:id,equity:1100}];
 click(listeners,'[data-tab]',{tab:'futures'});
 click(listeners,'[data-futures-view]',{futuresView:'equity'});
 const chart=el('content').innerHTML.split('<section class="section pnlChart')[1];
 assert.match(chart,/Стоимость счёта · наблюдения/);
 assert.match(chart,/<polyline/);
 assert.match(chart,/>\$1,100\.00</);
 assert.doesNotMatch(chart,/\+\$1,100/);
});
test('Spot cards no longer show invested/coin-stack noise',()=>{
 const {window,el,listeners}=mount();
 for(const fn of listeners.click||[])fn({target:{closest:selector=>selector==='[data-tab]'?{dataset:{tab:'positions'}}:null}});
 const markup=el('content').innerHTML.split('<section class="section pnlChart')[0];
 assert.match(markup,/Стоимость монет/);
 assert.match(markup,/Резерв/);
 assert.doesNotMatch(markup,/Вложено|монеты в работе|spotHeroCoins/);
 assert.match(markup,/spotCardBottom/);
});
test('buying plan defaults closed and opens without resetting its saved levels',()=>{
 const events={},store=new Map(),area={innerHTML:''};
 const window={fxmr4GetState:()=>({
  tab:'positions',capital:1000,quotes:{BTC:{price:75000,updated_at:'x'},ETH:{price:2200,updated_at:'x'}},
  holdings:{BTC:{invested:25},ETH:{invested:25}}
 }),fxmr4HistoryChart:{render:()=>'<div>price history</div>'}};
 const document={
  getElementById:id=>id==='strategyMount'?area:null,
  querySelector:()=>null,
  addEventListener:(type,fn)=>(events[type]??=[]).push(fn)
 };
 const storage={getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,v)};
 vm.runInNewContext(levels,{window,document,localStorage:storage,
  console,fetch:()=>new Promise(()=>{}),
  AbortController:class{abort(){}get signal(){return {}}},
  setTimeout:()=>1,clearTimeout(){},Notification:undefined},
 {filename:'levels.js',timeout:3000});
 assert.match(area.innerHTML,/План покупок/);
 assert.doesNotMatch(area.innerHTML,/sl-grid-cards/);
 events.click[0]({target:{closest:selector=>selector==='[data-level-action]'?{dataset:{levelAction:'togglePlan'}}:null}});
 assert.match(area.innerHTML,/sl-grid-cards/);
 assert.match(area.innerHTML,/75,000/);
 assert.equal(store.get('fxmr4_buyplan_expanded_v1'),'1');
 events.click[0]({target:{closest:selector=>selector==='[data-level-action]'?{dataset:{levelAction:'togglePlan'}}:null}});
 assert.doesNotMatch(area.innerHTML,/sl-grid-cards/);
 assert.equal(store.get('fxmr4_buyplan_expanded_v1'),'0');
});
