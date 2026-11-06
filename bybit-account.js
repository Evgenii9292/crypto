/* FXMR4: subaccount connector UI. Never store API credentials in this file or localStorage. */
(() => {
  "use strict";
  const status={available:false,configured:false,account:"Subaccount",connected:false,error:"",updatedAt:null,busy:false,formOpen:false};
  const enc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const canSend=location.protocol==="https:"||["localhost","127.0.0.1"].includes(location.hostname);
  const title="Подключение Bybit · субаккаунт";
  const panel=()=>document.getElementById("bybitConnectionPanel");

  function renderPanel(){
    const p=panel();
    if(!p)return;
    if(!status.available){
      p.innerHTML='<div class="connectorState"><strong>Серверное подключение не настроено</strong><p>Сейчас открыт публичный просмотр GitHub. Ввод API-ключей отключён. После запуска FXMR4 на HTTPS-сервере форма станет доступна здесь.</p><button class="btn" type="button" data-bybit-action="check">Проверить сервер</button></div>';
      return;
    }
    const stateText=status.connected?'Синхронизировано':status.configured?'Ключ задан · проверь синхронизацию':'Ключ ещё не задан';
    let controls=status.configured?
      '<button type="button" class="btn primary" data-bybit-action="refresh">Обновить позиции</button>':
      '<button type="button" class="btn primary" data-bybit-action="start">Подключить субаккаунт</button>';
    const form=status.formOpen&&!status.configured?
      '<form id="bybitConnectForm" class="bybitConnectForm" autocomplete="off"><div class="field"><label for="subLabel">Название субаккаунта</label><input id="subLabel" name="label" maxlength="40" value="Subaccount 1" required /></div><div class="field"><label for="subKey">API Key</label><input id="subKey" name="key" type="password" autocomplete="off" required /></div><div class="field"><label for="subSecret">API Secret</label><input id="subSecret" name="secret" type="password" autocomplete="off" required /></div><div class="safeNote">Ключи проверяются на сервере и сохраняются только в оперативной памяти до перезапуска. API с правами торговли не принимается.</div><div class="flexend"><button class="btn" type="button" data-bybit-action="cancel">Отмена</button><button class="btn primary" type="submit">Проверить и подключить</button></div></form>':'';
    p.innerHTML='<div class="connectorState"><div class="hrow"><div><strong>'+enc(title)+'</strong><div class="tiny">'+enc(status.account)+' · '+enc(stateText)+'</div></div><span class="connectBadge">'+(status.connected?'Read-Only':'Без позиций')+'</span></div>'+(status.updatedAt?'<p>Последняя синхронизация: '+new Date(status.updatedAt).toLocaleString('ru-RU')+'</p>':'')+(status.error?'<div class="bybitError">'+enc(status.error)+'</div>':'')+'<div class="bybitConnectActions">'+(status.busy?'Проверяю Bybit…':controls)+'</div>'+form+'</div>';
  }

  async function getJson(url,options={}){
    const ctl=new AbortController();
    const timeout=setTimeout(()=>ctl.abort(),16000);
    try{
      const r=await fetch(url,{method:options.method||"GET",cache:"no-store",credentials:"same-origin",headers:options.headers||{},body:options.body,signal:ctl.signal});
      const data=await r.json();
      if(!r.ok)throw Error(String(data.error||"HTTP "+r.status).slice(0,250));
      return data;
    }finally{clearTimeout(timeout)}
  }

  async function check(){
    if(!canSend){status.available=false;status.error="HTTPS обязателен";renderPanel();return}
    try{
      const data=await getJson("./api/status");
      if(data.backend!==true)throw Error("Это не приватный сервер FXMR4");
      status.available=true;
      status.configured=!!data.configured;
      status.account=data.account||"Subaccount";
      status.error="";
      window.fxmr4App?.onBackendStatus?.({available:true,configured:status.configured,connected:status.connected});
      renderPanel();
      if(status.configured)await refresh();
    }catch(e){
      status.available=false;
      status.configured=false;
      status.connected=false;
      status.error="Backend недоступен";
      window.fxmr4App?.onBackendStatus?.({available:false,configured:false,connected:false});
      renderPanel();
    }
  }

  async function refresh(){
    if(!status.available||!status.configured||status.busy)return;
    status.busy=true;renderPanel();
    try{
      const reply=await getJson("./api/snapshot");
      if(reply.connected!==true||!reply.data)throw Error("Bybit не вернул позиции");
      status.connected=true;
      status.error="";
      status.account=reply.data?.account?.name||"Subaccount";
      status.updatedAt=reply.data?.updatedAt||Date.now();
      window.fxmr4App?.onSnapshot?.(reply.data);
    }catch(e){
      status.connected=false;
      status.error=e.message||"Не удалось получить данные Bybit";
      window.fxmr4App?.onBackendStatus?.({available:true,configured:true,connected:false,error:status.error});
    }finally{
      status.busy=false;
      renderPanel();
    }
  }

  async function connect(fields){
    if(!status.available||!canSend)return;
    status.busy=true;status.error="";renderPanel();
    try{
      const reply=await getJson("./api/connect",{
        method:"POST",
        headers:{"Content-Type":"application/json","X-FXMR4-Action":"1"},
        body:JSON.stringify(fields)
      });
      if(reply.connected!==true)throw Error("API не подтвердил ключ");
      status.configured=true;
      status.formOpen=false;
      status.account=reply.account||fields.label;
      window.fxmr4App?.onBackendStatus?.({available:true,configured:true,connected:false});
      await refresh();
    }catch(e){
      status.error=e.message||"Ошибка подключения Bybit";
    }finally{
      status.busy=false;
      renderPanel();
    }
  }

  document.addEventListener("click",e=>{
    const b=e.target.closest?.("[data-bybit-action]");
    if(!b)return;
    if(b.dataset.bybitAction==="check")check();
    else if(b.dataset.bybitAction==="refresh")refresh();
    else if(b.dataset.bybitAction==="start"){status.formOpen=true;status.error="";renderPanel();}
    else if(b.dataset.bybitAction==="cancel"){status.formOpen=false;renderPanel();}
  });

  document.addEventListener("submit",e=>{
    if(e.target?.id!=="bybitConnectForm")return;
    e.preventDefault();
    const form=new FormData(e.target);
    const credentials={
      label:String(form.get("label")||"Subaccount 1").trim(),
      key:String(form.get("key")||"").trim(),
      secret:String(form.get("secret")||"").trim()
    };
    e.target.reset(); // Never keep credentials in form or browser storage.
    if(credentials.key.length<10||credentials.secret.length<10){status.error="Проверь API Key и Secret";renderPanel();return}
    connect(credentials);
  });

  window.fxmr4Bybit={renderPanel,check,refresh,isEditing:()=>status.formOpen,status:()=>({...status})};
  check();
  setInterval(()=>{if(!document.hidden&&status.configured&&status.available)refresh()},60000);
  document.addEventListener("visibilitychange",()=>{if(!document.hidden&&status.configured&&status.available)refresh()});
})();
