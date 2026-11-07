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
 const ICONS=[["wallet","Кошелёк"],["trend","График"],["shield","Щит"],["bot","Бот"],["activity","Монеты"]];
 const iconName=x=>ICONS.some(o=>o[0]===x)?x:"wallet";
 const svg=name=>'<svg class="icon" aria-hidden="true"><use href="#'+(["edit","plus","sync"].includes(name)?name:iconName(name))+'"></use></svg>';
 const iconSelect=value=>'<select name="icon" aria-label="Иконка субаккаунта">'+ICONS.map(([v,label])=>
   '<option value="'+v+'"'+(v===iconName(value)?' selected':'')+'>'+label+'</option>').join('')+'</select>';
 function renderPanel(){
  const el=panel();if(!el)return;
  if(!status.available){
   const message=status.error==="HTTP 404"?"На VPS запущена старая версия FXMR4. Необходимо обновить сервер.":status.error||"Нет связи с сервером";
   el.innerHTML='<div class="connectorState bybitAccountsPanel">'+
     '<div class="bybitConnectActions"><button class="btn primary" type="button" disabled title="Сначала требуется связь с API FXMR4">'+
     svg("plus")+'Добавить субаккаунт</button></div>'+
     '<p class="bybitError" role="status">'+enc(message)+'</p>'+
     '<button class="btn" type="button" data-bybit-action="check">Проверить соединение</button></div>';
   return;
  }
  const list=status.accounts.map(a=>{
   const result=status.results[a.id],healthy=!!result&&!result.error;
   const equity=healthy?result.data?.totals?.equity:null;
   const badge='<span class="bybitExchangeBadge"><b aria-hidden="true">B</b>'+enc(brand(a))+'</span>';
   const accountIcon=iconName(a.icon);
   const editing=status.editing===a.id;
   const pencil=editing?'':'<button class="bybitEditIcon" type="button" data-bybit-action="rename" data-id="'+enc(a.id)+
     '" aria-label="Изменить название и иконку '+enc(a.label)+'" title="Изменить">'+svg("edit")+'</button>';
   const details='<span class="bybitAccountDetails">'+badge+
     (equity!=null&&Number.isFinite(Number(equity))?'<span class="bybitAccountBalance">'+money(equity)+'</span>':'')+'</span>';
   const editForm=editing?'<form class="bybitRenameForm" data-account-id="'+enc(a.id)+'">'+
     '<label>Название<input name="label" maxlength="40" value="'+enc(a.label)+'" required></label>'+
     '<label>Иконка'+iconSelect(accountIcon)+'</label>'+
     '<div class="bybitFormActions"><button class="btn primary" type="submit">Сохранить</button><button class="btn" type="button" data-bybit-action="cancel-rename">Отмена</button></div></form>':'';
   return '<div class="bybitAccountRow"><div class="bybitAccountMain"><span class="bybitAccountIcon">'+svg(accountIcon)+'</span>'+
     '<span class="bybitAccountMeta"><span class="bybitAccountNameLine"><strong>'+enc(a.label)+'</strong>'+pencil+'</span>'+
     details+(result?.error?'<span class="bybitError">'+enc(result.error)+'</span>':'')+
     '</span></div>'+(editing?editForm:'<div class="bybitAccountActions">'+
     '<button class="btn bybitDisconnect" type="button" data-bybit-action="remove" data-id="'+enc(a.id)+'">Отключить API</button></div>')+'</div>';
  }).join('');
  const form=status.formOpen?'<form id="bybitConnectForm" class="bybitConnectForm" autocomplete="off">'+
   '<div class="bybitFormTitle"><span class="bybitExchangeBadge"><b>B</b>Bybit</span>Новый субаккаунт</div>'+
   '<div class="field"><label>Название субаккаунта<input name="label" maxlength="40" placeholder="Например, 13 ордеров 2 стоп-лосс" required></label></div>'+
   '<div class="field"><label>Иконка'+iconSelect("wallet")+'</label></div>'+
   '<div class="field"><label>API Key<input name="key" type="password" autocomplete="new-password" required></label></div>'+
   '<div class="field"><label>API Secret<input name="secret" type="password" autocomplete="new-password" required></label></div>'+
   '<div class="bybitFormActions"><button class="btn" type="button" data-bybit-action="cancel">Отмена</button>'+
   '<button class="btn primary" type="submit">Проверить и подключить</button></div></form>':'';
  el.innerHTML='<div class="connectorState bybitAccountsPanel">'+
   (status.error?'<p class="bybitError" role="alert">'+enc(status.error)+'</p>':'')+
   '<div class="bybitConnectActions"><button class="btn primary" type="button" data-bybit-action="start"'+
     (status.busy?' disabled':'')+'>'+svg("plus")+'Добавить субаккаунт</button>'+
     (status.accounts.length?'<button class="btn bybitRefresh" type="button" data-bybit-action="refresh"'+
     (status.busy?' disabled':'')+'>'+svg("sync")+'Обновить позиции</button>':'')+'</div>'+
   '<div class="bybitAccountsList">'+(list||'<div class="sourceEmpty">Субаккаунтов пока нет</div>')+'</div>'+
   form+'</div>';
 }
 async function getJson(url,opts={}){
  const ctl=new AbortController(),clock=setTimeout(()=>ctl.abort(),22000);
  try{
   const r=await fetch(url,{method:opts.method||"GET",cache:"no-store",credentials:"same-origin",
    headers:opts.method==="POST"?authHeaders:{Accept:"application/json"},
    body:opts.body?JSON.stringify(opts.body):undefined,signal:ctl.signal});
   const data=await r.json();
   if(!r.ok)throw Error(r.status===404&&url.includes("/api/accounts")?
     "На VPS старая версия FXMR4. Необходимо обновить сервер.":String(data.error||"HTTP "+r.status).slice(0,250));
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
  if(status.formOpen||status.editing)return;
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
  if(!status.available||status.busy||status.formOpen||status.editing)return;
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
 async function rename(label,accountId="bybit-subaccount",icon="wallet"){
  if(!status.available||status.busy)return false;
  status.busy=true;renderPanel();
  try{
   const legacy=accountId==="bybit-subaccount";
   const data=await getJson(legacy?"./api/rename":"./api/account-rename",
    {method:"POST",body:legacy?{label,icon}:{id:accountId,label,icon}});
   if(!data.renamed)throw Error("Сервер не подтвердил изменение имени");
   const a=status.accounts.find(x=>x.id===accountId);if(a){a.label=label;a.icon=iconName(icon)}
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
   const fields={label:String(fd.get("label")||"").trim(),icon:iconName(fd.get("icon")),
     key:String(fd.get("key")||"").trim(),secret:String(fd.get("secret")||"").trim()};
   e.target.reset();
   if(fields.key.length<10||fields.secret.length<10||!fields.label){status.error="Заполни название и API-ключ";renderPanel();return}
   connect(fields);
  }
  if(e.target?.classList?.contains("bybitRenameForm")){
   e.preventDefault();
   const fd=new FormData(e.target);
   rename(String(fd.get("label")||"").trim(),e.target.dataset.accountId,iconName(fd.get("icon")));
  }
 });
 window.fxmr4Bybit={renderPanel,check,refresh,disconnect,rename,isEditing:()=>status.formOpen,status:()=>({...status})};
 check();
 setInterval(()=>{if(!document.hidden&&status.available&&status.accounts.length)refresh()},60000);
 document.addEventListener("visibilitychange",()=>{if(!document.hidden&&status.available&&!status.formOpen&&!status.editing)check()});
})();
