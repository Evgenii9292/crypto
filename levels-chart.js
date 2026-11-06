/* Interactive historical Spot price charts for BTC and ETH.
   Public, real Bybit/CryptoCompare candles are loaded by levels.js.
   This renderer does not trade or persist API credentials. */
(function fxmr4HistoryChart(){
'use strict';
const COINS=['BTC','ETH'];
const W=720,H=255,L=74,R=18,T=20,B=38;
const registry={BTC:{period:null,series:[],levels:[],info:{price:0},zoom:1,pan:0},
                ETH:{period:null,series:[],levels:[],info:{price:0},zoom:1,pan:0}};
let drag=null,pending=new Set(),repaintScheduled=false;
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const money=n=>'$'+Number(n).toLocaleString('en-US',{maximumFractionDigits:n>=1000?0:2});
function tick(t,span){
 const d=new Date(t),opt=span>730*86400000?{year:'numeric'}:
 span>110*86400000?{month:'short',year:'2-digit'}:
 span>2*86400000?{day:'numeric',month:'short'}:
 {day:'numeric',month:'short',hour:'2-digit'};
 return d.toLocaleDateString('ru-RU',opt);
}
function viewport(sym){
 const st=registry[sym],items=st.series;
 if(items.length<2)return {start:Date.now()-30*86400000,end:Date.now(),full:1,width:1,first:0,maxZoom:1};
 const first=items[0].time,last=items[items.length-1].time,full=Math.max(1,last-first);
 const maxZoom=Math.min(24,Math.max(1,(items.length-1)/9));
 st.zoom=clamp(st.zoom,1,maxZoom);
 st.pan=clamp(st.pan,0,1);
 const width=full/st.zoom,start=first+(full-width)*(1-st.pan);
 return {first,last,full,width,start,end:start+width,maxZoom};
}
function graph(sym){
 const s=registry[sym],data=s.series,view=viewport(sym),info=s.info,levels=s.levels;
 const shown=data.filter(q=>q.time>=view.start&&q.time<=view.end);
 const prices=shown.map(q=>q.price);
 if(!prices.length&&info.price>0)prices.push(info.price);
 if(!prices.length)prices.push(...levels.map(l=>Number(l.price)).filter(n=>n>0));
 if(!prices.length)return '<div class="sl-empty">История цен загружается</div>';
 let lo=Math.min(...prices),hi=Math.max(...prices),spread=Math.max(hi-lo,hi*.02,1);
 // Price axis is based on the viewed historical period; far-away buy targets
 // must not shrink the chart into a flat line.
 for(const target of levels){
  const value=Number(target.price);
  if(value>=lo-spread*.12&&value<=hi+spread*.12){lo=Math.min(lo,value);hi=Math.max(hi,value)}
 }
 spread=Math.max(hi-lo,hi*.02,1);
 const min=lo-spread*.10,max=hi+spread*.10;
 const x=time=>L+(time-view.start)/Math.max(1,view.width)*(W-L-R);
 const y=price=>T+(max-price)/(max-min)*(H-T-B);
 let grids='';
 for(let i=0;i<=4;i++){
  const v=max-(max-min)*i/4,yy=y(v);
  const caption=v>=10000?'$'+Math.round(v/1000)+'k':'$'+Math.round(v).toLocaleString('en-US');
  grids+='<line x1="'+L+'" x2="'+(W-R)+'" y1="'+yy.toFixed(1)+'" y2="'+yy.toFixed(1)+'" class="sl-grid"/>'+
    '<text x="'+(L-10)+'" y="'+(yy+4).toFixed(1)+'" text-anchor="end" class="sl-axis">'+caption+'</text>';
 }
 for(const fraction of [0,.5,1]){
  const tx=L+(W-L-R)*fraction,ts=view.start+view.width*fraction;
  grids+='<text x="'+tx.toFixed(1)+'" y="'+(H-9)+'" text-anchor="'+(fraction===0?'start':fraction===1?'end':'middle')+'" class="sl-axis">'+tick(ts,view.width)+'</text>';
 }
 // Insert nearest neighbors at both ends to avoid discontinuity when panning.
 const firstIndex=data.findIndex(q=>q.time>=view.start);
 const before=firstIndex>0?[data[firstIndex-1]]:[];
 const lastIndex=data.findLastIndex(q=>q.time<=view.end);
 const after=lastIndex>=0&&lastIndex<data.length-1?[data[lastIndex+1]]:[];
 const plotted=before.concat(shown,after);
 const curve=plotted.length>1?'<polyline points="'+plotted.map(q=>x(q.time).toFixed(1)+','+y(q.price).toFixed(1)).join(' ')+'" class="sl-price-line" clip-path="url(#sl-clip-'+sym+')"/>':'';
 const targets=levels.filter(l=>Number(l.price)>=min&&Number(l.price)<=max).map(l=>{
  const cy=y(Number(l.price)).toFixed(1);
  return '<line x1="'+L+'" x2="'+(W-R)+'" y1="'+cy+'" y2="'+cy+'" class="sl-target-line"/>'+
    '<circle cx="'+(W-R-2)+'" cy="'+cy+'" r="4" class="sl-target-dot"><title>Уровень: '+money(l.price)+'</title></circle>';
 }).join('');
 const current=info.price>=min&&info.price<=max?'<line x1="'+L+'" x2="'+(W-R)+'" y1="'+y(info.price).toFixed(1)+'" y2="'+y(info.price).toFixed(1)+'" class="sl-current-line"/>':'';
 const svg='<svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="xMidYMid meet" role="img" aria-label="История цены '+sym+' с отмеченными уровнями докупки">'+
  '<defs><clipPath id="sl-clip-'+sym+'"><rect x="'+L+'" y="'+T+'" width="'+(W-L-R)+'" height="'+(H-T-B)+'"/></clipPath></defs>'+
  '<g>'+grids+'</g>'+curve+targets+current+'</svg>';
 return svg+(data.length<2?'<div class="sl-graph-note">История цен загружается</div>':'')+
   '<div class="sl-hover-line" hidden></div><div class="sl-hover-tip" hidden></div>';
}
function render(sym,period,series,info,levels){
 if(!COINS.includes(sym))return '';
 const st=registry[sym];
 if(st.period!==period){st.period=period;st.zoom=1;st.pan=0}
 st.series=(Array.isArray(series)?series:[]).filter(x=>Number.isFinite(x.time)&&x.price>0).sort((a,b)=>a.time-b.time);
 st.info=info||{price:0};st.levels=Array.isArray(levels)?levels:[];
 return '<div class="sl-chart-tools" role="toolbar" aria-label="Масштаб графика '+sym+'">'+
  '<button type="button" data-history-action="back" data-coin="'+sym+'" title="Назад по истории" aria-label="Назад по истории '+sym+'">‹</button>'+
  '<button type="button" data-history-action="out" data-coin="'+sym+'" title="Отдалить" aria-label="Отдалить график '+sym+'">−</button>'+
  '<button type="button" data-history-action="in" data-coin="'+sym+'" title="Приблизить" aria-label="Приблизить график '+sym+'">+</button>'+
  '<button type="button" data-history-action="forward" data-coin="'+sym+'" title="К текущей дате" aria-label="Вперёд по истории '+sym+'">›</button>'+
  '<button type="button" data-history-action="reset" data-coin="'+sym+'" class="sl-chart-reset" title="Весь выбранный период">Сброс</button></div>'+
  '<div class="sl-canvas sl-interactive" data-history-coin="'+sym+'" tabindex="0" aria-label="График '+sym+': перетаскивай, приближай колесом мыши или кнопками">'+graph(sym)+'</div>';
}
function repaint(sym){
 const canvas=document.querySelector?.('#strategyMount [data-history-coin="'+sym+'"]');
 if(canvas)canvas.innerHTML=graph(sym);
}
function schedule(sym){
 pending.add(sym);
 if(repaintScheduled)return;
 repaintScheduled=true;
 const frame=()=>{repaintScheduled=false;for(const coin of pending)repaint(coin);pending.clear()};
 if(typeof requestAnimationFrame==='function')requestAnimationFrame(frame);else setTimeout(frame,16);
}
function zoom(sym,factor,anchor=.5){
 if(!COINS.includes(sym))return;
 const st=registry[sym],before=viewport(sym);
 if(st.series.length<2)return;
 const next=clamp(st.zoom*factor,1,before.maxZoom);
 if(Math.abs(next-st.zoom)<.00001)return;
 const at=before.start+before.width*anchor,width=before.full/next,start=at-width*anchor;
 st.zoom=next;st.pan=before.full>width?clamp(1-(start-before.first)/(before.full-width),0,1):0;
 schedule(sym);
}
function shift(sym,amount){
 const st=registry[sym];if(!st||st.zoom<=1)return;
 st.pan=clamp(st.pan+amount/(st.zoom-1),0,1);
 schedule(sym);
}
function hint(e,canvas,sym){
 const line=canvas.querySelector?.('.sl-hover-line'),tip=canvas.querySelector?.('.sl-hover-tip'),st=registry[sym];
 if(!line||!tip||st.series.length<2)return;
 const rect=canvas.getBoundingClientRect(),f=clamp((e.clientX-rect.left)/Math.max(1,rect.width),0,1);
 const view=viewport(sym),axisFraction=clamp((f*W-L)/(W-L-R),0,1);
 const time=view.start+axisFraction*view.width;
 let best=st.series[0],distance=Infinity;
 for(const p of st.series){
  const d=Math.abs(p.time-time);
  if(d<distance){distance=d;best=p}
 }
 line.hidden=false;line.style.left=(f*100)+'%';
 tip.hidden=false;tip.style.left=(clamp(f,.17,.83)*100)+'%';
 tip.textContent=new Date(best.time).toLocaleDateString('ru-RU',{day:'numeric',month:'short',year:'numeric'})+' · '+money(best.price);
}
document.addEventListener('click',e=>{
 const b=e.target.closest?.('[data-history-action]');if(!b)return;
 const sym=b.dataset.coin,action=b.dataset.historyAction;
 if(!COINS.includes(sym))return;
 if(action==='in')zoom(sym,1.65);
 if(action==='out')zoom(sym,1/1.65);
 if(action==='back')shift(sym,.4);
 if(action==='forward')shift(sym,-.4);
 if(action==='reset'){registry[sym].zoom=1;registry[sym].pan=0;schedule(sym)}
});
document.addEventListener('wheel',e=>{
 const canvas=e.target.closest?.('[data-history-coin]');if(!canvas)return;
 const sym=canvas.dataset.historyCoin;if(!COINS.includes(sym))return;
 e.preventDefault();
 const rect=canvas.getBoundingClientRect(),anchor=clamp((e.clientX-rect.left)/Math.max(1,rect.width),0,1);
 zoom(sym,e.deltaY<0?1.22:1/1.22,anchor);
},{passive:false});
document.addEventListener('pointerdown',e=>{
 const canvas=e.target.closest?.('[data-history-coin]');if(!canvas||!COINS.includes(canvas.dataset.historyCoin))return;
 if(e.pointerType==='mouse'&&e.button!==0)return;
 drag={sym:canvas.dataset.historyCoin,startX:e.clientX,initial:registry[canvas.dataset.historyCoin].pan,width:Math.max(1,canvas.getBoundingClientRect().width)};
});
document.addEventListener('pointermove',e=>{
 const canvas=e.target.closest?.('[data-history-coin]');
 if(drag){
  const st=registry[drag.sym];
  if(st.zoom>1&&Math.abs(e.clientX-drag.startX)>=3){
   st.pan=clamp(drag.initial+(e.clientX-drag.startX)/drag.width/(st.zoom-1),0,1);
   schedule(drag.sym);
   if(e.cancelable&&e.pointerType==='touch')e.preventDefault();
  }
  return;
 }
 if(canvas&&COINS.includes(canvas.dataset.historyCoin))hint(e,canvas,canvas.dataset.historyCoin);
});
document.addEventListener('pointerup',()=>{drag=null});
document.addEventListener('pointercancel',()=>{drag=null});
document.addEventListener('pointerleave',e=>{
 const canvas=e.target.closest?.('[data-history-coin]');if(!canvas)return;
 const line=canvas.querySelector?.('.sl-hover-line'),tip=canvas.querySelector?.('.sl-hover-tip');
 if(line)line.hidden=true;if(tip)tip.hidden=true;
},true);
document.addEventListener('keydown',e=>{
 const canvas=e.target.closest?.('[data-history-coin]');if(!canvas)return;
 const sym=canvas.dataset.historyCoin;
 if(e.key==='+'||e.key==='='){e.preventDefault();zoom(sym,1.65)}
 if(e.key==='-'){e.preventDefault();zoom(sym,1/1.65)}
 if(e.key==='ArrowLeft'){e.preventDefault();shift(sym,.3)}
 if(e.key==='ArrowRight'){e.preventDefault();shift(sym,-.3)}
});
window.fxmr4HistoryChart={render,zoom,shift,viewport};
})();
