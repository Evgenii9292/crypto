const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const script=source.match(/<script>([\s\S]*?)<\/script>/)?.[1];
if(!script)throw Error('main script not found');
function app(){
 const nodes=new Map(),listeners={},store=new Map();
 const el=id=>{
  if(!nodes.has(id))nodes.set(id,{innerHTML:'',textContent:'',style:{},dataset:{},offsetWidth:700,
   classList:{toggle(){},add(){},remove(){}},setAttribute(){},scrollIntoView(){}});
  return nodes.get(id);
 };
 const document={hidden:false,getElementById:el,querySelector:()=>el('tabs'),querySelectorAll:()=>[],
  addEventListener:(key,fn)=>(listeners[key]??=[]).push(fn)};
 const window={};
 const localStorage={getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,v)};
 vm.runInNewContext(script,{window,document,localStorage,
  fetch:()=>new Promise(()=>{}),console,
  AbortController:class{abort(){}get signal(){return {}}},
  setTimeout:()=>1,clearTimeout(){},setInterval:()=>{},FormData:class{}},
 {filename:'index.html',timeout:3000});
 const go=tab=>{
  for(const listener of listeners.click||[])listener({target:{closest:selector=>selector==='[data-tab]'?{dataset:{tab}}:null}});
 };
 return {window,el,go};
}
function snapshot(id,name,equity,pnl,coin){
 const now=Date.now();
 return {account:{id,name},totals:{equity,perpUPL:pnl,realisedPnl:0,accountPnl:pnl,availableBalance:equity/2,positionCount:1},
  positions:[{symbol:coin,side:'Long',size:90,pnl,openedAt:now-3600000}],updatedAt:now};
}
test('two Bybit subaccounts aggregate equity and PNL exactly once',()=>{
 const {window,el,go}=app();
 const bridge=window.fxmr4App;
 bridge.onAccounts([{id:'bybit-subaccount',label:'Legacy'},{id:'sub-b',label:'Another'}]);
 bridge.onSnapshot(snapshot('bybit-subaccount','Legacy',800,-3,'XMRUSDT'));
 assert.doesNotMatch(el('content').innerHTML,/\$1,150/,'do not show incomplete account sum');
 bridge.onSnapshot(snapshot('sub-b','Another',300,2,'ADAUSDT'));
 const overview=el('content').innerHTML;
 assert.match(overview,/\$1,150\.00/);
 assert.match(overview,/−\$1\.00/);
 go('futures');
 const fut=el('content').innerHTML;
 assert.match(fut,/XMRUSDT/);assert.match(fut,/ADAUSDT/);
 assert.match(fut,/В сделке/);
 assert.doesNotMatch(fut,/Марк \$|posBar/);
 assert.match(fut,/1ч 0мин/);
});
test('removing a subaccount from the server list keeps the surviving account',()=>{
 const {window,el,go}=app(),bridge=window.fxmr4App;
 bridge.onAccounts([{id:'bybit-subaccount',label:'First'},{id:'sub-b',label:'Second'}]);
 bridge.onSnapshot(snapshot('bybit-subaccount','First',800,-3,'XMRUSDT'));
 bridge.onSnapshot(snapshot('sub-b','Second',300,2,'ADAUSDT'));
 bridge.onAccounts([{id:'bybit-subaccount',label:'First'}]);
 go('futures');
 const fut=el('content').innerHTML;
 assert.match(fut,/XMRUSDT/);
 assert.doesNotMatch(fut,/ADAUSDT/);
 assert.match(fut,/\$800\.00/);
});
test('settings presents one real Add subaccount control, not a fake local record form',()=>{
 const {el,go}=app();
 go('connections');
 const markup=el('content').innerHTML;
 assert.match(markup,/id="bybitConnectionPanel"/);
 assert.doesNotMatch(markup,/Название субаккаунта<\/button>|\+ Биржа|futureForm/);
});
