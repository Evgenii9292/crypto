/* FXMR4 cloud sync: private same-origin VPS storage.
   API keys are NEVER kept here; only Spot transactions, UI account labels,
   chart points, purchase levels and planned capital.
*/
(() => {
  "use strict";
  const PORTFOLIO="fxmr4_portfolio_public_preview_v1";
  const LEVELS="fxmr4_spot_levels_v1";
  const BACKUP="fxmr4_pending_local_backup";
  const hadPortfolioAtLoad=localStorage.getItem(PORTFOLIO)!==null;
  let active=false,ready=false,rev=0,waiting=false,writing=false,pending=false,remoteApplying=false;
  let lastWritten={};
  const $=id=>document.getElementById(id);
  const pause=()=>document.hidden||!!document.querySelector('#tradeForm,#slForm,#capitalForm,#bybitConnectForm');
  const canSend=location.protocol==="https:"||["localhost","127.0.0.1"].includes(location.hostname);

  async function api(url,body=null){
    const controller=new AbortController(),t=setTimeout(()=>controller.abort(),15000);
    try{
      const resp=await fetch(url,{
        method:body===null?"GET":"POST",
        credentials:"same-origin",
        cache:"no-store",
        signal:controller.signal,
        headers:body===null?{"Accept":"application/json"}:{"Content-Type":"application/json","X-FXMR4-Action":"1"},
        body:body===null?undefined:JSON.stringify(body)
      });
      let result;
      try{result=await resp.json()}catch(e){throw Error("Неверный ответ сервера")}
      if(!resp.ok){const error=Error(result.error||"HTTP "+resp.status);error.status=resp.status;throw error}
      return result;
    }finally{clearTimeout(t)}
  }

  function values(){
    let portfolio=null,levels=null;
    try{portfolio=JSON.parse(localStorage.getItem(PORTFOLIO)||"null")}catch(e){}
    try{levels=JSON.parse(localStorage.getItem(LEVELS)||"null")}catch(e){}
    return {portfolio:portfolio&&typeof portfolio==="object"?portfolio:{},
      levels:levels&&typeof levels==="object"?levels:{levels:{BTC:[{id:"btc-75000",price:75000,amount:null},{id:"btc-70000",price:70000,amount:null}],ETH:[]},alertsEnabled:false}};
  }

  function info(text,isError=false){
    const el=$("cloudStatus");
    if(el){el.textContent=text;el.dataset.error=isError?"true":"false"}
  }

  // Compare only user-edited portfolio fields. Live quotes, recorded PNL
  // series, and view preferences change without user input and must never
  // trigger a remote-state rebuild.
  const OWNED=["capital","trades","sources"];
  function owned(portfolio){
    const out={};
    for(const key of OWNED)out[key]=portfolio?portfolio[key]:undefined;
    return JSON.stringify(out);
  }
  function sameContent(a,b){
    return owned(a)===owned(b);
  }

  // The server owns the edited fields, but the PNL series is written by this
  // browser on every load. Replacing it with an older server copy would throw
  // away points the server has not received yet, so the longer series wins.
  function keepLonger(local,remote,key){
    const a=Array.isArray(local?.[key])?local[key]:[];
    const b=Array.isArray(remote?.[key])?remote[key]:[];
    return b.length>=a.length?b:a;
  }

  function applyRemote(remote){
    const {portfolio,levels}=remote;
    if(!portfolio||!levels)throw Error("Неполные данные VPS");
    const old=values();
    const portfolioChanged=!sameContent(old.portfolio,portfolio);
    const levelsChanged=JSON.stringify(old.levels)!==JSON.stringify(levels);
    // Keep quotes and PNL recordings gathered on this device. They are
    // observations, not edits to the user's saved allocation.
    const merged={...portfolio,
      quotes:old.portfolio.quotes||portfolio.quotes,
      chartPeriod:old.portfolio.chartPeriod||portfolio.chartPeriod,
      chartMetric:old.portfolio.chartMetric||portfolio.chartMetric,
      snapshots:keepLonger(old.portfolio,portfolio,"snapshots"),
      portfolioSnapshots:keepLonger(old.portfolio,portfolio,"portfolioSnapshots")};
    remoteApplying=true;
    try{
      localStorage.setItem(PORTFOLIO,JSON.stringify(merged));
      localStorage.setItem(LEVELS,JSON.stringify(levels));
      // Apply remote changes in memory. No full-page reload, no animation
      // restart, no flicker, no loss of the current tab or expanded cards.
      if(portfolioChanged)window.fxmr4App?.applyCloudState?.();
      if(levelsChanged)window.fxmr4Levels?.reloadLevels?.();
    }finally{remoteApplying=false}
    return portfolioChanged||levelsChanged;
  }

  function reloadOnRemote(remote){
    rev=remote.revision;
    applyRemote(remote);
    info("Сохранено на VPS");
  }

  async function write(){
    if(!active||!ready||writing||!pending||remoteApplying)return;
    writing=true;pending=false;
    try{
      const data=values();
      if(JSON.stringify(data)===JSON.stringify(lastWritten)){info("Сохранено на VPS");return}
      const outcome=await api("./api/user-data",{revision:rev,...data});
      rev=outcome.revision;
      lastWritten=JSON.parse(JSON.stringify(data));
      info("Сохранено на VPS");
    }catch(err){
      if(err.status===409){
        try{
          const server=await api("./api/user-data");
          // Do not silently overwrite edits from another device.
          localStorage.setItem(BACKUP,JSON.stringify({savedAt:Date.now(),...values()}));
          const overwrite=window.confirm("Портфель изменён на другом устройстве. Сохранить изменения этого устройства поверх новой версии? Отмена загрузит данные VPS. Локальная копия сохранена.");
          if(overwrite){rev=server.revision;pending=true;}
          else{ready=false;reloadOnRemote(server);}
        }catch(error){info("Ошибка синхронизации. Данные остались в браузере.",true);pending=true}
      }else{
        info("Нет связи с VPS. Данные сохранены на устройстве.",true);
        pending=true;
      }
    }finally{
      writing=false;
      if(pending)window.setTimeout(()=>{if(!pause())write()},5000);
    }
  }

  function schedule(){
    if(remoteApplying)return;
    pending=true;
    if(active&&ready&&!waiting) {
      waiting=true;
      setTimeout(()=>{waiting=false;write()},1400);
    }
  }

  async function bootstrap(){
    if(!canSend){info("Нужен HTTPS",true);return}
    try{
      const status=await api("./api/status");
      if(!status.backend)return;
      active=true;
      let remote=await api("./api/user-data");
      if(remote.exists){
        rev=remote.revision;
        lastWritten={portfolio:remote.portfolio,levels:remote.levels};
        ready=true;
        if(!pending){reloadOnRemote(remote)}
        else {
          // A local change happened during page loading. Use conflict-safe POST.
          rev=remote.revision;info("Синхронизация изменений…");await write();
        }
      }else{
        rev=0;ready=true;
        if(hadPortfolioAtLoad){
          pending=true;
          info("Переносим портфель с этого устройства на VPS…");
          await write();
        }else{
          info("На VPS пока нет портфеля. Открой FXMR4 на устройстве с покупками.",true);
        }
      }
      if(active&&(remote.exists||hadPortfolioAtLoad))info("Сохранено на VPS");
    }catch(err){
      info("Синхронизация с VPS недоступна",true);
      console.warn("FXMR4 sync:",err.message);
    }
  }

  document.addEventListener("visibilitychange",()=>{
    if(!document.hidden){
      if(pending)write();
      else poll();
    }
  });

  async function poll(){
    if(!active||!ready||writing||pending||pause())return;
    try{
      const remote=await api("./api/user-data");
      if(remote.exists&&remote.revision>rev){ready=false;reloadOnRemote(remote)}
    }catch(err){info("Синхронизация с VPS недоступна",true)}
  }

  window.fxmr4Cloud={schedule,status:()=>({active,ready,revision:rev})};
  bootstrap();
  setInterval(()=>{if(!document.hidden){if(pending)write();else poll()}},45000);
})();
