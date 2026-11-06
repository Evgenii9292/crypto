/* Regression: FXMR4 cloud sync must never force a full-page reload.
   Run: node --test tests/cloud-sync.test.js */
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const code=fs.readFileSync(require('node:path').join(__dirname,'..','cloud-sync.js'),'utf8');

async function simulate(remote,{spent=25,price=76000}={}){
 const PK='fxmr4_portfolio_public_preview_v1',LK='fxmr4_spot_levels_v1';
 const store=new Map([
  [PK,JSON.stringify({capital:1000,trades:[{coin:'BTC',spent}],quotes:{BTC:{price}},sources:[{id:'bybit',name:'Bybit',accounts:[]}]})],
  [LK,JSON.stringify({levels:{BTC:[],ETH:[]},alertsEnabled:false})]
 ]);
 const calls=[],element={textContent:'',dataset:{}};
 const win={
   fxmr4App:{applyCloudState:()=>calls.push('portfolio')},
   fxmr4Levels:{reloadLevels:()=>calls.push('levels')},
   confirm:()=>false,setTimeout:()=>{}
 };
 const location={protocol:'https:',hostname:'fxmr4.test',reload:()=>calls.push('RELOAD')};
 const document={hidden:false,querySelector:()=>null,getElementById:()=>element,addEventListener:()=>{}};
 const storage={getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,v)};
 const fetch=async url=>({ok:true,json:async()=>url.endsWith('/api/status')?{backend:true}:remote});
 const context={window:win,location,document,localStorage:storage,fetch,
  setTimeout:()=>{},clearTimeout:()=>{},setInterval:()=>{},
  AbortController:class{abort(){}get signal(){return {}}},console};
 vm.runInNewContext(code,context,{filename:'cloud-sync.js',timeout:2000});
 for(let i=0;i<200;i++)await Promise.resolve();
 return {calls,portfolio:JSON.parse(store.get(PK)),levels:JSON.parse(store.get(LK)),ready:win.fxmr4Cloud.status().ready};
}
const remote=(spent,levels=[])=>({
 revision:7,exists:true,
 portfolio:{capital:1000,trades:[{coin:'BTC',spent}],quotes:{BTC:{price:74000}},sources:[{id:'bybit',name:'Bybit',accounts:[]}]},
 levels:{levels:{BTC:levels,ETH:[]},alertsEnabled:false}
});
test('live quote changes do not reload or rebuild',async()=>{
 const r=await simulate(remote(25));
 assert.deepEqual(r.calls,[]);
 assert.equal(r.portfolio.quotes.BTC.price,76000);
 assert.ok(r.ready);
});
test('a new purchase is applied without a page reload',async()=>{
 const r=await simulate(remote(50));
 assert.deepEqual(r.calls,['portfolio']);
 assert.equal(r.portfolio.trades[0].spent,50);
});
test('target levels refresh without a page reload',async()=>{
 const r=await simulate(remote(25,[{id:'btc-75000',price:75000}]));
 assert.deepEqual(r.calls,['levels']);
 assert.equal(r.levels.levels.BTC[0].price,75000);
});
