const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const root=path.join(__dirname,'..');
const code=fs.readFileSync(path.join(root,'levels-chart.js'),'utf8');
const planner=fs.readFileSync(path.join(root,'levels.js'),'utf8');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const make=()=>{
 const handlers={};
 const canvas={innerHTML:'',getBoundingClientRect:()=>({left:0,width:720}),
   querySelector:()=>null};
 const document={
  addEventListener:(type,fn)=>(handlers[type]??=[]).push(fn),
  querySelector:selector=>selector.includes('data-history-coin')?canvas:null
 };
 const window={};
 vm.runInNewContext(code,{document,window,requestAnimationFrame:fn=>fn(),setTimeout:fn=>fn(),console},
 {filename:'levels-chart.js',timeout:3000});
 return {chart:window.fxmr4HistoryChart,handlers,canvas};
};
const day=86400000;
const weekly=Array.from({length:540},(_,i)=>({
 time:Date.UTC(2016,0,1)+i*7*day,
 price:2200+i*125+(i%11)*35
}));

test('historical selectors request genuine Bybit weekly and daily candles',()=>{
 assert.match(planner,/'all':\{interval:'W',limit:1000/);
 assert.match(planner,/'1y':\{interval:'D',limit:370/);
 assert.match(planner,/category=spot&symbol=/);
 assert.ok(html.indexOf('levels-chart.js')<html.indexOf('levels.js'));
});

test('full available history renders dates, real points and buying levels',()=>{
 const {chart}=make();
 const markup=chart.render('BTC','all',weekly,{price:75000},[{price:75000,amount:25}]);
 assert.match(markup,/2016|2017|2018/);
 assert.match(markup,/sl-price-line/);
 assert.match(markup,/sl-target-line/);
 assert.match(markup,/data-history-coin="BTC"/);
});

test('zooming and panning change only the viewed interval',()=>{
 const {chart}=make();
 chart.render('BTC','all',weekly,{price:75000},[]);
 const before=chart.viewport('BTC');
 chart.zoom('BTC',2);
 const zoomed=chart.viewport('BTC');
 assert.ok(zoomed.width<before.width);
 chart.shift('BTC',.3);
 assert.ok(chart.viewport('BTC').start<zoomed.start);
 chart.render('ETH','1y',weekly.slice(-52),{price:75000},[]);
 assert.equal(chart.viewport('ETH').width,51*7*day);
});

test('period change resets chart zoom without erasing target data',()=>{
 const {chart}=make();
 chart.render('BTC','all',weekly,{price:75000},[{price:75000}]);
 chart.zoom('BTC',3);
 assert.ok(chart.viewport('BTC').width<chart.viewport('BTC').full);
 const markup=chart.render('BTC','90d',weekly.slice(-13),{price:75000},[{price:75000}]);
 assert.equal(chart.viewport('BTC').width,chart.viewport('BTC').full);
 assert.match(markup,/sl-target-line/);
});

test('Spot reserve and duplicate account accordion are gone; purchase history remains',()=>{
 const start=html.indexOf('function positions(){');
 const end=html.indexOf('function futureSortValue(',start);
 const positions=html.slice(start,end);
 assert.doesNotMatch(positions,/spotAccounts\(\)/);
 assert.doesNotMatch(positions,/Задействовано|reserveNote|не в PNL/);
 assert.match(positions,/История покупок/);
});
