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
 vm.runInNewContext(main,context,{filename:'index.html',timeout:3000});
 return {el,window,document,listeners,data};
}
test('overview restores three labeled current and monthly PNL pairs',()=>{
 const {el}=mount();
 const markup=el('content').innerHTML;
 assert.match(markup,/Баланс портфеля/);
 assert.equal((markup.match(/Текущий PNL/g)||[]).length,3);
 assert.equal((markup.match(/Месячный PNL/g)||[]).length,3);
 assert.doesNotMatch(markup,/Всего на счетах|heroBreakdown|Баланс субаккаунта/);
 assert.match(markup,/class="assetTopline"/);
});
test('combined chart does not mistake Spot-only history for total PNL',async()=>{
 const now=Date.now();
 const h=[
  {t:now-3*3600000,spot:-.12,total:-.12},
  {t:now-2*3600000,spot:-.17,futures:-2.1,total:-2.27},
  {t:now-3600000,spot:-.18,total:49.7},
  {t:now-200000,spot:-.20,futures:-3.1,total:-3.30}
 ];
 const {window,el}=mount(h);
 for(let i=0;i<100;i++)await Promise.resolve();
 window.fxmr4App.onSnapshot({
  account:{name:'sub'},totals:{equity:1100,perpUPL:-3.12},
  positions:[],updatedAt:now
 });
 const markup=el('content').innerHTML;
 const points=markup.match(/<polyline points="([^"]+)"/)?.[1];
 assert.ok(points);
 assert.equal(points.trim().split(' ').length,3);
 assert.doesNotMatch(markup,/\+\$49\.7/);
});
test('offline server PNL samples fill gaps BETWEEN existing local samples',async()=>{
 const now=Date.now();
 const t=h=>now-h*3600000;
 const local={
   capital:1000,trades:[
     {id:1,coin:'BTC',spent:25,entry:76200,buy_date:'2026-11-06'},
     {id:2,coin:'ETH',spent:25,entry:2247,buy_date:'2026-11-06'}
   ],
   snapshots:[{time:t(6),pnl:-.50},{time:t(1),pnl:-.30}],
   portfolioSnapshots:[
     {time:t(6),spot:-.50,futures:-2,total:-2.5},
     {time:t(1),spot:-.30,futures:-1,total:-1.3}
   ]
 };
 const offline=[
   {t:t(4),spot:-.40,futures:-1.8,total:-2.2},
   {t:t(2),spot:-.38,futures:-1.5,total:-1.88}
 ];
 const {el,listeners}=mount(offline,local);
 for(let i=0;i<150;i++)await Promise.resolve();
 const extract=()=>el('content').innerHTML.match(/<polyline points="([^"]+)"/)?.[1]?.trim().split(' ').length;
 assert.equal(extract(),4,'combined chart contains both local and offline server samples');
 for(const cb of listeners.click||[])cb({target:{closest:selector=>selector==='[data-tab]'?{dataset:{tab:'positions'}}:null}});
 assert.equal(extract(),4,'Spot chart also uses server history during closed browser time');
});
test('balance mode presents actual equity as money, never as positive profit',()=>{
 const {window,el,listeners}=mount();
 window.fxmr4App.onSnapshot({
  account:{name:'sub'},totals:{equity:1100,perpUPL:-3},
  positions:[],updatedAt:Date.now()
 });
 const click=target=>{
  for(const fn of listeners.click||[])fn({target:{closest:selector=>
    selector==='[data-tab]'&&target.tab?{dataset:{tab:target.tab}}:
    selector==='[data-metric]'&&target.metric?{dataset:{metric:target.metric,chart:'futures'}}:null}});
 };
 click({tab:'futures'});
 click({metric:'balance'});
 const output=el('content').innerHTML;
 assert.match(output,/График баланса|История баланса/);
 assert.match(output,/>\$1,100\.00</); 
 assert.doesNotMatch(output,/\+\$1,100/);
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
