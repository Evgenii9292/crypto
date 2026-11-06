/* FXMR4: independent read-only API connections. Credentials never touch localStorage. */
(() => {
 "use strict";
 const status={available:false,configured:false,connected:false,error:"",busy:false,formOpen:false,updatedAt:null,accounts:[],results:{},editing:null};
 const enc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
 const canSend=location.protocol==="https:"||["localhost","127.0.0.1"].includes(location.hostname);
 const panel=()=>document.getElementById("bybitConnectionPanel");
 const authHeaders={"Content-Type":"application/json","X-FXMR4-Action":"1"};
 const money=n=>Number(n).toLocaleString("en-US",{style:"currency",currency:"USD"});
 const brand=a=>a.exchange||"Bybit";
 function renderPanel(){
  const el=panel();if(!el)return;
  if(!status.available){
   el.innerHTML='<div class="connectorState"><p class="tiny">'+enc(status.error||"Открой защищённый FXMR4 на VPS для подключения API.")+'</p><button type="button" class="btn" data-bybit-action="check">Проверить соединение</button></div>';
   return;
  }
  const list=status.accounts.map(a=>{
   const live=status.results[a.id],healthy=!!live&&!live.error;
   const metrics=healthy&&live.data?.totals?live.data.totals:null;
   const detail=live?.error?'<span class="bybitError">'+enc(live.error)+'</span>':
     metrics?'<span class="tiny">Баланс '+(metrics.equity==null?'—':money(metrics.equity))+'</span>':
     '<span class="tiny">Ожидается обновление</span>';
   const actions=status.editing===a.id?
      '<form class="bybitRenameForm" data-account-id="'+enc(a.id)+'"><input name="label" required maxlength="40" value="'+enc(a.label)+'" aria-label="Название субаккаунта"><button type="submit" class="btn primary">Сохранить</button><button type="button" class="btn" data-bybit-action="cancel-rename">Отмена</button></form>':
      '<div class="bybitAccountActions"><button type="button" class="btn" data-bybit-action="rename" data-id="'+enc(a.id)+'" aria-label="Переименовать '+enc(a.label)+'">Название</button><button type="button" class="btn" data-bybit-action="remove" data-id="'+enc(a.id)+'" aria-label="Отключить '+enc(a.label)+'">Отключить</button></div>';
   return '<div class="bybitAccountRow"><div class="bybitAccountMain"><span class="status-dot '+(live?.error?'isError':healthy?'':'isDisconnected')+'"></span><span class="bybitAccountMeta"><strong>'+enc(a.label)+'</strong><small>'+enc(brand(a))+' · API только чтение</small>'+detail+'</span></div>'+actions+'</div>';
  }).join('');
  const form=status.formOpen?'<form id="bybitConnectForm" class="bybitConnectForm" autocomplete="off">'+
   '<div class="field"><label>Биржа<select name="exchange" disabled><option>Bybit</option></select></label></div>'+
   '<div class="field"><label>Название субаккаунта<input name="label" maxlength="40" placeholder="Например, 13 ORD (2SL)" required></label></div>'+
   '<div class="field"><label>API Key<input name="key" type="password" autocomplete="off" required></label></div>'+
   '<div class="field"><label>API Secret<input name="secret" type="password" autocomplete="off" required></label></div>'+
   '<div class="tiny">Только Read-Only. Ключ проверяется сервером и хранится на VPS зашифрованным.</div>'+
   '<div class="flexend"><button class="btn" type="button" data-bybit-action="cancel">Отмена</button><button class="btn primary" type="submit">Проверить и подключить</button></div></form>':'';
  el.innerHTML='<div class="connectorState">'+
   (status.error?'<p class="bybitError" role="alert">'+enc(status.error)+'</p>':'')+
   '<div class="bybitAccountsList">'+(list||'<div class="sourceEmpty">Подключённых субаккаунтов пока нет.</div>')+'</div>'+
   '<div class="bybitConnectActions"><button type="button" class="btn primary" data-bybit-action="start">+ Добавить субаккаунт</button>'+
   (status.accounts.length?'<button type="button" class="btn" data-bybit-action="refresh" '+(status.busy?'disabled':'')+'>Обновить позиции</button>':'')+'</div>'+
   form+'</div>';
 }
 async function getJson(url,opts={}){
  const ctl=new AbortController(),clock=setTimeout(()=>ctl.abort(),22000);
  try{
   const r=await fetch(url,{method:opts.method||"GET",cache:"no-store",credentials:"same-origin",
    headers:opts.method==="POST"?authHeaders:{Accept:"application/json"},
    body:opts.body?JSON.stringify(opts.body):undefined,signal:ctl.signal});
   const data=await r.json();
   if(!r.ok)throw Error(String(data.error||"HTTP "+r.status).slice(0,250));
   return data;
  }finally{clearTimeout(clock)}
 }
 function inform(){
  const good=status.accounts.filter(a=>status.results[a.id]?.data&&!status.results[a.id]?.error);
  const failures=status.accounts.filter(a=>status.results[a.id]?.error);
  status.configured=status.accounts.length>0;
  status.connected=status.configured&&good.length===status.accounts.length;
  status.error=failures.length?failures.map(a=>a.label+' · '+status.results[a.id].error).join('; '):"";
  window.fxmr4App?.onBackendStatus?.({available:status.available,configured:status.configured,connected:status.connected,error:status.error});
 }
 async function check(){
  if(!canSend){status.error="HTTPS обязателен";status.available=false;renderPanel();return}
  try{
   const info=await getJson("./api/status");
   if(info.backend!==true)throw Error("Сервер FXMR4 не найден");
   const reply=await getJson("./api/accounts");
   status.available=true;
   status.accounts=Array.isArray(reply.accounts)?reply.accounts:[];
   for(const id of Object.keys(status.results))if(!status.accounts.some(a=>a.id===id))delete status.results[id];
   window.fxmr4App?.onAccounts?.(status.accounts);
   inform();renderPanel();
   if(status.accounts.length)await refresh(false);
  }catch(e){
   status.available=false;
   status.error=e.message||"Сервер недоступен";
   window.fxmr4App?.onBackendStatus?.({available:false,configured:false,connected:false,error:status.error});
   renderPanel();
  }
 }
 async function refresh(updateList=true){
  if(!status.available||status.busy)return;
  if(updateList){
   try{
    const data=await getJson("./api/accounts");
    status.accounts=Array.isArray(data.accounts)?data.accounts:[];
    for(const id of Object.keys(status.results))if(!status.accounts.some(a=>a.id===id))delete status.results[id];
    window.fxmr4App?.onAccounts?.(status.accounts);
   }catch(e){status.error=e.message||"Не удалось получить список субаккаунтов";renderPanel();return}
  }
  status.busy=true;renderPanel();
  try{
   // Each account gets its OWN authenticated API request and its OWN snapshot.
   // The existing legacy key remains untouched when new accounts are added.
   for(const a of status.accounts){
    try{
     const reply=await getJson("./api/account-snapshot?id="+encodeURIComponent(a.id));
     if(!reply.data||reply.connected!==true)throw Error("Bybit не вернул позиции");
     status.results[a.id]={data:reply.data};
     window.fxmr4App?.onSnapshot?.(reply.data);
    }catch(e){status.results[a.id]={error:e.message||"Нет связи с Bybit"}}
   }
   status.updatedAt=Date.now();
   inform();
  }finally{status.busy=false;renderPanel()}
 }
 async function connect(fields){
  if(!status.available||status.busy||!canSend)return;
  status.busy=true;status.error="";renderPanel();
  try{
   await getJson("./api/account-connect",{method:"POST",body:fields});
   status.formOpen=false;status.busy=false;
   await check();
  }catch(e){status.error=e.message||"Не удалось подключить API"}
  finally{status.busy=false;renderPanel()}
 }
 async function rename(label,accountId="bybit-subaccount"){
  if(!status.available||status.busy)return false;
  status.busy=true;renderPanel();
  try{
   const legacy=accountId==="bybit-subaccount";
   const data=await getJson(legacy?"./api/rename":"./api/account-rename",
    {method:"POST",body:legacy?{label}:{id:accountId,label}});
   if(!data.renamed)throw Error("Сервер не подтвердил изменение имени");
   const a=status.accounts.find(x=>x.id===accountId);if(a)a.label=label;
   status.editing=null;
   window.fxmr4App?.onAccounts?.(status.accounts);
   return true;
  }catch(e){status.error=e.message;return false}
  finally{status.busy=false;renderPanel()}
 }
 async function disconnect(accountId="bybit-subaccount"){
  if(!status.available||status.busy)return false;
  status.busy=true;status.error="";renderPanel();
  try{
   const legacy=accountId==="bybit-subaccount";
   const reply=await getJson(legacy?"./api/disconnect":"./api/account-delete",
    {method:"POST",body:legacy?{}:{id:accountId}});
   if(!reply.disconnected)throw Error("Сервер не подтвердил отключение");
   status.accounts=status.accounts.filter(a=>a.id!==accountId);
   delete status.results[accountId];
   window.fxmr4App?.onAccounts?.(status.accounts);
   inform();return true;
  }catch(e){status.error=e.message||"Не удалось отключить";return false}
  finally{status.busy=false;renderPanel()}
 }
 document.addEventListener("click",e=>{
  const b=e.target.closest?.("[data-bybit-action]");if(!b)return;
  const act=b.dataset.bybitAction,id=b.dataset.id;
  if(act==="check")check();
  if(act==="refresh")refresh();
  if(act==="start"){status.formOpen=true;status.error="";renderPanel();panel()?.querySelector?.('[name="label"]')?.focus?.()}
  if(act==="cancel"){status.formOpen=false;renderPanel()}
  if(act==="rename"){status.editing=id;renderPanel()}
  if(act==="cancel-rename"){status.editing=null;renderPanel()}
  if(act==="remove"&&window.confirm("Отключить субаккаунт? Его ключ удалится с VPS, на Bybit ключ останется действовать."))disconnect(id);
 });
 document.addEventListener("submit",e=>{
  if(e.target?.id==="bybitConnectForm"){
   e.preventDefault();
   const fd=new FormData(e.target);
   const fields={label:String(fd.get("label")||"").trim(),
     key:String(fd.get("key")||"").trim(),secret:String(fd.get("secret")||"").trim()};
   e.target.reset();
   if(fields.key.length<10||fields.secret.length<10||!fields.label){status.error="Заполни название и API-ключ";renderPanel();return}
   connect(fields);
  }
  if(e.target?.classList?.contains("bybitRenameForm")){
   e.preventDefault();
   const fd=new FormData(e.target);
   rename(String(fd.get("label")||"").trim(),e.target.dataset.accountId);
  }
 });
 window.fxmr4Bybit={renderPanel,check,refresh,disconnect,rename,isEditing:()=>status.formOpen,status:()=>({...status})};
 check();
 setInterval(()=>{if(!document.hidden&&status.available&&status.accounts.length)refresh()},60000);
 document.addEventListener("visibilitychange",()=>{if(!document.hidden&&status.available)check()});
})();
