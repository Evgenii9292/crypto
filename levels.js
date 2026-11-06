/* FXMR4 Spot buy-level planner v1 · no trade execution, no API credentials */
(function fxmr4SpotLevels(){
'use strict';
const STORE='fxmr4_spot_levels_v1',symbols=['BTC','ETH'],periods={'7d':{interval:'240',limit:45,days:7},'30d':{interval:'D',limit:34,days:30},'90d':{interval:'D',limit:95,days:90}};
const HOSTS=['https://api.bybit.id','https://api.bybit.com','https://api.bytick.com'];
const defaults={BTC:[{id:'btc-75000',price:75000,amount:null},{id:'btc-70000',price:70000,amount:null}],ETH:[]};
let config={levels:structuredLevels(defaults),alertsEnabled:false},period='30d',edit=null,draft=null,mount=null,cache={},fetching={},lastReaching={},lastSource={},message='',lastState=null;
const money=(v,dec=0)=>'$'+Number(v||0).toLocaleString('en-US',{minimumFractionDigits:dec,maximumFractionDigits:dec});
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[c]));
const fmtPct=n=>(n<0?'−':n>0?'+':'')+Math.abs(n).toFixed(2)+'%';
function structuredLevels(o){const out={BTC:[],ETH:[]};for(const sym of symbols){const arr=Array.isArray(o?.[sym])?o[sym]:[];out[sym]=arr.filter(x=>x&&Number(x.price)>0).slice(0,20).map(x=>({id:String(x.id||sym+'-'+Math.random().toString(36).slice(2)),price:Number(x.price),amount:x.amount===null||x.amount===''||x.amount===undefined?null:Number(x.amount)>0?Number(x.amount):null}));}return out;}
function load(){
 try{const raw=localStorage.getItem(STORE);if(raw){const o=JSON.parse(raw);config.levels=structuredLevels(o.levels);config.alertsEnabled=!!o.alertsEnabled;}}catch(e){console.warn('Strategy read error',e)}
}
function persist(){try{localStorage.setItem(STORE,JSON.stringify(config));}catch(e){message='Не удалось сохранить уровни в браузере.';console.warn(e)}}
function state(){
 const v=typeof window.fxmr4GetState==='function'?window.fxmr4GetState():null;
 return v&&typeof v==='object'?v:null;
}
function priceInfo(sym,st){
 const q=st?.quotes?.[sym],price=Number(q?.price);
 const reliable=price>0 && (q?.updated_at||q?.source==='Вручную');
 return {price:price>0?price:0,reliable:!!reliable,source:q?.source||'нет данных'};
}
function changePercent(target,price){return price>0?(target/price-1)*100:NaN}
function statusFor(level,info){
 if(!info.reliable)return {label:'Нет актуальной цены',kind:'muted'};
 if(info.price<=level.price)return {label:'Уровень достигнут',kind:'hit'};
 return {label:'До уровня '+fmtPct(changePercent(level.price,info.price)),kind:'waiting'};
}
function notifyCrossings(st){
 if(!st||st.tab!=='positions')return;
 for(const sym of symbols){
  const info=priceInfo(sym,st);
  for(const level of config.levels[sym]){
   if(!info.reliable)continue;
   const reached=info.price<=level.price,key=sym+'/'+level.id,prev=lastReaching[key];
   if(reached&&prev===false){
    message=sym+' достиг '+money(level.price)+' · цена '+money(info.price)+'.';
    if(config.alertsEnabled&&typeof Notification!=='undefined'&&Notification.permission==='granted'){
     try{new Notification('FXMR4 · Уровень докупки',{body:message,tag:'fxmr4-'+key})}catch(e){console.warn('Notification failed',e)}
    }
   }
   lastReaching[key]=reached;
  }
 }
}
function fmtPrice(value){if(value>=10000)return money(value);return money(value,2)}
function periodTick(time,p){return new Date(time).toLocaleDateString('ru-RU',p==='7d'?{day:'2-digit',month:'short',hour:'2-digit'}:{day:'2-digit',month:'short'});}
function chart(sym,st){
 const info=priceInfo(sym,st),levels=config.levels[sym],key=sym+'-'+period,series=cache[key]?.data||[],w=720,h=255,left=74,right=18,top=20,bottom=39;
 const relevantPrices=[...series.map(x=>x.price),...(info.price>0?[info.price]:[]),...levels.map(x=>x.price)].filter(x=>Number.isFinite(x)&&x>0);
 if(!relevantPrices.length)return '<div class="sl-empty">Нет данных о ценах и уровнях</div>';
 const lo=Math.min(...relevantPrices),hi=Math.max(...relevantPrices),span=Math.max(hi-lo,hi*.02),min=lo-span*.09,max=hi+span*.09;
 const y=n=>top+(max-n)/(max-min)*(h-top-bottom);
 const start=series[0]?.time||Date.now()-periods[period].days*86400000,end=series[series.length-1]?.time||Date.now();
 const x=t=>left+(t-start)/Math.max(1,end-start)*(w-left-right);
 let guides='';
 for(let j=0;j<=4;j++){
  const v=max-(max-min)*j/4,yy=y(v);
  guides+='<line x1="'+left+'" x2="'+(w-right)+'" y1="'+yy.toFixed(2)+'" y2="'+yy.toFixed(2)+'" class="sl-grid"/><text x="'+(left-10)+'" y="'+(yy+3).toFixed(2)+'" text-anchor="end" class="sl-axis">'+escape(v>=10000?'$'+Math.round(v/1000)+'k':'$'+Math.round(v).toLocaleString('en-US'))+'</text>';
 }
 for(const p of [0,.5,1]){
  const xx=left+(w-left-right)*p,stamp=start+(end-start)*p;
  guides+='<text x="'+xx.toFixed(2)+'" y="'+(h-10)+'" text-anchor="'+(p===0?'start':p===1?'end':'middle')+'" class="sl-axis">'+escape(periodTick(stamp,period))+'</text>';
 }
 const curve=series.length>=2?'<polyline points="'+series.map(p=>x(p.time).toFixed(2)+','+y(p.price).toFixed(2)).join(' ')+'" class="sl-price-line"/>':'';
 const bands=levels.map((l,i)=>'<line x1="'+left+'" x2="'+(w-right)+'" y1="'+y(l.price).toFixed(1)+'" y2="'+y(l.price).toFixed(1)+'" class="sl-target-line"/><circle cx="'+(w-right-2)+'" cy="'+y(l.price).toFixed(1)+'" r="4" class="sl-target-dot"><title>'+escape('#'+(i+1)+' '+fmtPrice(l.price)+(l.amount?' · '+money(l.amount):''))+'</title></circle>').join('');
 const current=info.price>0?'<line x1="'+left+'" x2="'+(w-right)+'" y1="'+y(info.price).toFixed(1)+'" y2="'+y(info.price).toFixed(1)+'" class="sl-current-line"/>':'';
 return '<div class="sl-canvas"><svg viewBox="0 0 '+w+' '+h+'" preserveAspectRatio="xMidYMid meet" role="img" aria-label="График цены '+sym+' с уровнями покупки"><g>'+guides+'</g>'+curve+bands+current+'</svg></div>'+(series.length<2?'<div class="sl-graph-note">История цены недоступна</div>':'');
}
function levelRow(sym,l,st,index){
 const info=priceInfo(sym,st),status=statusFor(l,info),drop=changePercent(l.price,info.price),pctDisplay=Number.isFinite(drop)?fmtPct(drop):'—';
 return '<div class="sl-level '+status.kind+'"><div class="sl-level-left"><span class="sl-indicator"></span><div><strong>'+fmtPrice(l.price)+'</strong><small>'+escape(status.label)+'</small></div></div><div class="sl-level-middle"><strong>'+(l.amount?money(l.amount):'Сумма не задана')+'</strong><small>'+pctDisplay+' от текущей цены</small></div><button type="button" class="sl-edit-btn" data-level-action="edit" data-coin="'+sym+'" data-index="'+index+'" aria-label="Изменить уровень '+sym+'">Изменить</button></div>';
}
function editor(){
 if(!edit)return '';
 return '<form id="slForm" class="sl-editor"><div class="sl-editor-heading">'+(edit.index===null?'Новый уровень':'Изменить уровень')+' · '+edit.coin+'</div><div class="sl-fields"><label>Цена покупки, $<input name="target" data-level-field="target" type="number" min=".00000001" step="any" inputmode="decimal" placeholder="Например, 75000" value="'+escape(draft?.target||'')+'" required /></label><label>Сумма покупки, $<input name="amount" data-level-field="amount" type="number" min=".01" step="any" inputmode="decimal" placeholder="Пока не определена" value="'+escape(draft?.amount||'')+'" /></label></div><div class="sl-editor-actions"><button class="sl-button primary" type="submit">Сохранить</button><button class="sl-button" type="button" data-level-action="cancel">Отмена</button>'+(edit.index!==null?'<button class="sl-button danger" type="button" data-level-action="remove">Удалить уровень</button>':'')+'</div></form>';
}
function card(sym,st){
 const info=priceInfo(sym,st),spent=Number(st?.holdings?.[sym]?.invested)||0,reserve=Math.max(0,(Number(st?.capital)||1000)/2-spent),targets=config.levels[sym].slice().sort((a,b)=>b.price-a.price),planned=targets.reduce((sum,x)=>sum+(x.amount||0),0),source=cache[sym+'-'+period];
 const hit=targets.filter(l=>info.reliable&&info.price<=l.price);
 const periodButtons=Object.keys(periods).map(p=>'<button type="button" class="'+(p===period?'selected':'')+'" data-level-action="period" data-period="'+p+'">'+p+'</button>').join('');
 return '<section class="sl-card"><div class="sl-header"><div class="sl-heading"><span class="sl-coin '+sym.toLowerCase()+'">'+(sym==='BTC'?'₿':'◆')+'</span><div><strong>'+sym+' · уровни докупок</strong><span>Текущая цена <b>'+ (info.price?fmtPrice(info.price):'—')+'</b></span></div></div><button class="sl-button" type="button" data-level-action="add" data-coin="'+sym+'">+ Уровень</button></div><div class="sl-meta"><span>Лимит <b>'+money((Number(st?.capital)||1000)/2)+'</b></span><span>Свободно <b>'+money(reserve)+'</b></span><span>Запланировано <b>'+money(planned)+'</b></span></div>'+chart(sym,st)+'<div class="sl-caption"><span class="sl-legend"><i></i> Цель покупки <em></em> Текущая цена</span></div>'+(hit.length?'<div class="sl-alert">Достигнуты уровни: '+hit.map(l=>fmtPrice(l.price)).join(', ')+'. Проверь стратегию перед покупкой.</div>':'')+'<div class="sl-level-list">'+(targets.length?targets.map(l=>levelRow(sym,l,st,config.levels[sym].findIndex(a=>a.id===l.id))).join(''):'<div class="sl-empty-level">Уровни ещё не указаны. Добавь цену и сумму своей следующей покупки.</div>')+'</div>'+(planned>reserve+.0001?'<div class="sl-warning">Запланированные покупки превышают свободный лимит '+sym+'.</div>':'')+(edit?.coin===sym?editor():'')+'</section>';
}
function render(){
 const st=state();lastState=st;
 const area=document.getElementById('strategyMount');
 if(!area||!st||st.tab!=='positions'){mount=null;return}
 mount=area;notifyCrossings(st);
 const controls='<div class="sl-top"><div><div class="sl-title">План покупок</div></div><div class="sl-controls"><div class="sl-period">'+Object.keys(periods).map(p=>'<button type="button" class="'+(p===period?'selected':'')+'" data-level-action="period" data-period="'+p+'">'+p+'</button>').join('')+'</div><button class="sl-button" data-level-action="alerts" type="button">'+(config.alertsEnabled?'Уведомления включены':'Уведомлять')+'</button></div></div>';
 const note='';
 area.innerHTML='<div class="sl-shell">'+controls+(message?'<div class="sl-message">'+escape(message)+'</div>':'')+'<div class="sl-grid-cards">'+symbols.map(sym=>card(sym,st)).join('')+'</div>'+note+'</div>';
 refreshHistories();
}
async function request(url){
 const controller=new AbortController(),clock=setTimeout(()=>controller.abort(),6200);
 try{
  const response=await fetch(url,{cache:'no-store',signal:controller.signal});
  if(!response.ok)throw Error('HTTP '+response.status);
  return await response.json();
 }finally{clearTimeout(clock)}
}
async function kline(sym,p){
 const {interval,limit}=periods[p];
 const results=await Promise.any(HOSTS.map(async host=>{
  const raw=await request(host+'/v5/market/kline?category=spot&symbol='+sym+'USDT&interval='+interval+'&limit='+limit);
  const rows=raw?.result?.list;
  if(raw?.retCode!==0||!Array.isArray(rows)||rows.length<2)throw Error('Invalid kline response');
  const data=rows.map(item=>({time:Number(item[0]),price:Number(item[4])})).filter(q=>Number.isFinite(q.time)&&q.price>0).sort((a,b)=>a.time-b.time);
  if(data.length<2)throw Error('Empty candle history');
  return {source:host.includes('bybit.id')?'Bybit Spot (ID)':'Bybit Spot',data};
 }));
 return results;
}
async function fallbackHistory(sym,p){
 const days=periods[p].days;
 const url=days===7?'https://min-api.cryptocompare.com/data/v2/histohour?fsym='+sym+'&tsym=USD&limit=168':'https://min-api.cryptocompare.com/data/v2/histoday?fsym='+sym+'&tsym=USD&limit='+days;
 const raw=await request(url);
 const bars=raw?.Data?.Data;
 if(!Array.isArray(bars)||bars.length<2)throw Error('No fallback candles');
 const data=bars.map(x=>({time:Number(x.time)*1000,price:Number(x.close)})).filter(x=>Number.isFinite(x.time)&&x.price>0);
 if(data.length<2)throw Error('Invalid fallback candles');
 return {source:'CryptoCompare',data};
}
async function refreshHistories(force=false){
 if(!mount||!document.getElementById('strategyMount'))return;
 for(const sym of symbols){
  const key=sym+'-'+period,existing=cache[key];
  if(fetching[key]||(!force&&existing&&Date.now()-existing.when<10*60*1000))continue;
  fetching[key]=true;
  (async()=>{
   try{
    let result;
    try{result=await kline(sym,period)}catch(e){result=await fallbackHistory(sym,period)}
    cache[key]={...result,when:Date.now()};
   }catch(e){
    cache[key]={source:'Нет доступа к API',data:[],when:Date.now()};
    console.warn(sym+' history unavailable',e);
   }finally{
    delete fetching[key];
    const cur=state();
    if(cur?.tab==='positions'&&document.getElementById('strategyMount'))drawNoFetch();
   }
  })();
 }
}
function drawNoFetch(){
 const st=state();if(!st||st.tab!=='positions')return;
 const area=document.getElementById('strategyMount');if(!area)return;
 const keepFocus=document.activeElement?.getAttribute?.('data-level-field')||null;
 if(keepFocus)return;
 const old=refreshHistories;
 // Render without triggering a new request: cache timestamps suppress it.
 const saved=refreshHistories;refreshHistories=()=>{};try{render()}finally{refreshHistories=saved}
}
function startEdit(sym,index=null){
 if(!symbols.includes(sym))return;
 const entry=index!==null?config.levels[sym][index]:null;
 edit={coin:sym,index:index!==null?index:null};
 draft={target:entry?.price?String(entry.price):'',amount:entry?.amount?String(entry.amount):''};
 message='';render();
 const field=document.querySelector('#strategyMount [data-level-field="target"]');field?.focus();
}
function saveEditor(){
 if(!edit)return;
 const sym=edit.coin,price=Number(draft?.target),amount=draft?.amount===''||draft?.amount==null?null:Number(draft.amount);
 if(!Number.isFinite(price)||price<=0){message='Укажи корректную цену уровня.';render();return}
 if(amount!==null&&(!Number.isFinite(amount)||amount<=0)){message='Сумма должна быть больше нуля.';render();return}
 const other=config.levels[sym].filter((_,i)=>i!==edit.index);
 if(other.some(x=>Math.abs(x.price-price)<.000001)){message='Такой уровень уже есть.';render();return}
 if(other.reduce((n,x)=>n+(x.amount||0),0)+(amount||0)+Number(lastState?.holdings?.[sym]?.invested||0)>(Number(lastState?.capital)||1000)/2+.0001){message='Сумма всех покупок превысит лимит '+money((Number(lastState?.capital)||1000)/2)+' на '+sym+'.';render();return}
 const item={id:edit.index===null?'custom-'+Date.now().toString(36):config.levels[sym][edit.index].id,price,amount};
 if(edit.index===null){config.levels[sym].push(item)}else{config.levels[sym][edit.index]=item}
 edit=null;draft=null;message='Уровень сохранён.';persist();render();
}
function eventClick(e){
 const b=e.target.closest?.('[data-level-action]');
 if(!b)return;
 const action=b.dataset.levelAction;
 if(action==='add')return startEdit(b.dataset.coin);
 if(action==='edit')return startEdit(b.dataset.coin,Number(b.dataset.index));
 if(action==='cancel'){edit=null;draft=null;message='';render();return}
 if(action==='remove'&&edit){
  config.levels[edit.coin].splice(edit.index,1);edit=null;draft=null;message='Уровень удалён.';persist();render();return
 }
 if(action==='period'){
  if(!periods[b.dataset.period])return;
  period=b.dataset.period;message='';render();return;
 }
 if(action==='alerts'){
  (async()=>{
   if(config.alertsEnabled){config.alertsEnabled=false;message='Уведомления выключены.';persist();render();return}
   if(typeof Notification==='undefined'){message='Этот браузер не поддерживает системные уведомления. Подсветка уровней работает.';render();return}
   try{
    const permission=await Notification.requestPermission();
    if(permission==='granted'){config.alertsEnabled=true;message='Уведомления разрешены, пока страница открыта.';persist();}
    else{message='Нет разрешения на системные уведомления. Уровни будут подсвечиваться в приложении.'}
   }catch(e){message='Браузер не разрешил уведомления. Внутренняя подсветка доступна.'}
   render();
  })();
 }
}
function eventInput(e){
 const field=e.target?.dataset?.levelField;
 if(!field||!edit)return;
 draft[field]=String(e.target.value);
}
function eventSubmit(e){
 if(e.target?.id!=='slForm')return;
 e.preventDefault();
 const data=new FormData(e.target);
 draft={target:String(data.get('target')||''),amount:String(data.get('amount')||'')};
 saveEditor();
}
load();
document.addEventListener('click',eventClick);
document.addEventListener('input',eventInput);
document.addEventListener('submit',eventSubmit);
window.fxmr4Levels={render};
render();
})();
