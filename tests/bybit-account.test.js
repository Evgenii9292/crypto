const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const code=fs.readFileSync(path.join(__dirname,'..','bybit-account.js'),'utf8');
function setup(){
 const listeners={},notifications=[],storage=[];
 const panel={innerHTML:'',querySelector:()=>({focus(){}})};
 const accounts=[{id:'bybit-subaccount',label:'Original',legacy:true},
                 {id:'sub-existing',label:'Second',legacy:false}];
 const window={confirm:()=>true,fxmr4App:{
  onAccounts:a=>notifications.push({type:'accounts',count:a.length}),
  onSnapshot:s=>notifications.push({type:'snapshot',id:s.account.id}),
  onBackendStatus:status=>notifications.push({type:'status',connected:status.connected})
 }};
 const document={hidden:false,getElementById:id=>id==='bybitConnectionPanel'?panel:null,
  addEventListener:(type,fn)=>(listeners[type]??=[]).push(fn)};
 const fetch=async(url,options)=>{
  let result;
  if(url.endsWith('/api/status'))result={backend:true};
  else if(url.endsWith('/api/accounts'))result={accounts:accounts.slice()};
  else if(url.includes('/api/account-snapshot')){
   const id=decodeURIComponent(url.split('=')[1]);
   result={connected:true,data:{account:{id,name:id},totals:{equity:100,perpUPL:1},positions:[],updatedAt:Date.now()}};
  }else if(url.endsWith('/api/account-connect')){
   const body=JSON.parse(options.body);
   notifications.push({type:'write',hasKey:!!body.key,hasSecret:!!body.secret});
   accounts.push({id:'sub-new',label:body.label});
   result={connected:true,account:{id:'sub-new',label:body.label}};
  }else throw Error('Unexpected request '+url);
  return {ok:true,json:async()=>result};
 };
 const context={window,document,location:{protocol:'https:',hostname:'fxmr4.example'},
  fetch,setTimeout:()=>1,clearTimeout(){},setInterval(){},
  AbortController:class{abort(){}get signal(){return {}}},
  FormData:class{constructor(form){this.form=form}get(name){return this.form[name]}}};
 vm.runInNewContext(code,context,{filename:'bybit-account.js',timeout:3000});
 const settle=async()=>{for(let i=0;i<250;i++)await Promise.resolve()};
 const click=act=>{
  const b={dataset:{bybitAction:act},closest:selector=>selector==='[data-bybit-action]'?b:null};
  for(const handler of listeners.click||[])handler({target:b});
 };
 return {accounts,notifications,storage,panel,window,listeners,click,settle};
}
test('existing and newly added Bybit API accounts are all refreshed',async()=>{
 const x=setup();await x.settle();
 assert.equal(x.notifications.filter(n=>n.type==='snapshot').length,2);
 assert.equal(x.window.fxmr4Bybit.status().connected,true);
 assert.match(x.panel.innerHTML,/\+ Добавить субаккаунт/);
 assert.match(x.panel.innerHTML,/Обновить позиции/);
 x.click('start');
 assert.match(x.panel.innerHTML,/API Key/);
 assert.match(x.panel.innerHTML,/API Secret/);
 const form={id:'bybitConnectForm',label:'Third',key:'test-key-01234567',secret:'test-secret-01234567',reset(){this.key='';this.secret=''}};
 for(const handler of x.listeners.submit||[])handler({target:form,preventDefault(){}});
 await x.settle();
 assert.equal(x.accounts.length,3);
 assert.equal(x.notifications.filter(n=>n.type==='snapshot').length,5);
 assert.equal(x.window.fxmr4Bybit.status().connected,true);
 assert.ok(x.notifications.some(n=>n.type==='write'&&n.hasKey&&n.hasSecret));
 assert.doesNotMatch(x.panel.innerHTML,/test-secret-01234567/);
 assert.doesNotMatch(JSON.stringify(x.window.fxmr4Bybit.status()),/test-secret-01234567/);
});
test('background refresh is suppressed while API credentials are being entered',async()=>{
 const x=setup();await x.settle();
 x.click('start');
 const n=x.notifications.length;
 await x.window.fxmr4Bybit.refresh();
 assert.equal(x.notifications.length,n);
 assert.match(x.panel.innerHTML,/bybitConnectForm/);
});
