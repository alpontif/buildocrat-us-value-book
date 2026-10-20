'use strict';
/* US Land Value Book by Buildocrat — app */
const SC={AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',CT:'Connecticut',DE:'Delaware',DC:'District of Columbia',FL:'Florida',GA:'Georgia',HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',KY:'Kentucky',LA:'Louisiana',ME:'Maine',MD:'Maryland',MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',MS:'Mississippi',MO:'Missouri',MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',NJ:'New Jersey',NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',OH:'Ohio',OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',VA:'Virginia',WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming'};
const TYPEN=['City','Town','Community','ZIP code','Neighborhood','Village','Hamlet','Subdivision','Gated community'];
const URBAN_T=new Set([0,1,2,3,4,7,8]);
const DRANK=[0,1,2,9,4,3,5,6,6]; // map display order; ZIP codes are search-only (their dots would sit on top of cities)
const ZONEC=['#1D2675','#3C49A1','#7D87CA','#B7BCE6','#E8725B','#F2A28E','#CDB9A6'];
const CONF=[['H','High','Published land value for this census tract, and survey home values'],['M','Medium','Published land value for the ZIP code or county, and survey home values'],['L','Low','Some figures filled in from neighboring tracts'],['X','Modelled','Too few survey responses here; modelled from the surrounding tracts and county']];
const SQFT_ACRE=43560, QLOT=10890; // a quarter-acre lot, the FHFA standard
const TABS={
  land:{name:'Land value',head:'res',layers:[['res','Residential land','$/sq ft'],['acre','Per acre','$/acre'],['lsh','Land share of home value','%'],['farm','Farmland','$/acre'],['zone','Price tiers','']]},
  bld:{name:'Home value',head:'hv',layers:[['hv','Typical home','$'],['hvlo','Entry-level home','$'],['hvhi','Upper-end home','$'],['str','Structure value','$'],['bcost','Cost to build new','$/sq ft']]},
  rent:{name:'Rental value',head:'rent2',layers:[['rent1','1-bed','$/mo'],['rent2','2-bed','$/mo'],['rent3','3-bed','$/mo'],['rent4','4-bed','$/mo'],['yld','Gross yield','% a year']]}
};
const LAYERS=[].concat(...Object.values(TABS).map(t=>t.layers));
let TAB='land';

/* ---------- formatting ---------- */
const fmt=n=>n==null||!isFinite(n)?'\u2013':'$'+Math.round(n).toLocaleString('en-US');
function trim0(s){return s.includes('.')?s.replace(/0+$/,'').replace(/\.$/,''):s;}
function short(n){ if(n==null||!isFinite(n)) return '\u2013';
  if(n>=1e9){return '$'+trim0((n/1e9).toFixed(2))+'B';}
  if(n>=1e6){const v=n/1e6; return '$'+trim0(v.toFixed(v>=100?0:(v>=10?1:2)))+'M';}
  if(n>=1e4){const v=n/1e3; return '$'+trim0(v.toFixed(v>=100?0:1))+'K';}
  if(n>=100) return '$'+Math.round(n).toLocaleString('en-US');
  if(n>=10) return '$'+trim0(n.toFixed(1));
  return '$'+n.toFixed(2); }
const sig=(n,d=2)=>{ if(!n) return n; const p=Math.pow(10,Math.floor(Math.log10(n))-d+1); return Math.round(n/p)*p; };
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const norm=s=>String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9 ]+/g,' ').replace(/\s+/g,' ').trim();
const $=id=>document.getElementById(id);
const nfmt=n=>Number(n).toLocaleString('en-US');

/* ---------- data ----------
   The first view reads one small summary. County values, outlines, places, tracts and
   published land prices are separate per-state files, fetched when a state is opened,
   searched, or the map is actually shown. */
let ST=[], LG=[], PL=null, TR=null, EV=[], META={}, BORDERS=[], FILES={};
const STI={};
const placeHave=new Set(), tractHave=new Set(), countyHave=new Set(), geomHave=new Set(), evHave=new Set();
const stateJobs=new Map();
let summaryPromise=null, geomAll=null, countyAll=null, citiesPromise=null, zipPromise=null, ZIPMETA=null, zipReady=false;
let mapPromise=null, mapReady=false;
const pendingMap=[];
function dataUrl(p){ p=String(p||'').replace(/^\//,''); return p.startsWith('data/')?p:'data/'+p; }
async function fetchJSON(u){ const r=await fetch(u); if(!r.ok) throw new Error(u+' '+r.status); return r.json(); }
async function gzbin(u){ const r=await fetch(u); if(!r.ok) throw new Error(u+' '+r.status); const buf=new Uint8Array(await r.arrayBuffer());
  if(buf[0]===0x1f&&buf[1]===0x8b){ const ds=new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip')); return JSON.parse(await new Response(ds).text()); }
  return JSON.parse(new TextDecoder().decode(buf)); }
function undelta(a){ for(let j=1;j<a.length;j++) a[j]+=a[j-1]; return a; }
const VKF=['res','hv','hvlo','hvhi','rent1','rent2','rent3','rent4','resU','resR','lo','hi','farm'];
function valsFrom(arr){ const v={}; VKF.forEach((k,i)=>{ const x=arr?arr[i]:null; v[k]=x==null?'':x; if(v[k]==='') v[k]=null; }); return v; }
function finishCounty(g){ derive(g.v,g.s); const zs=g.zs||[]; let best=null; for(const r of zs){ if(!best||r[1]>best[1]) best=r; } g.v.zone=best?best[0]:null; return g; }
function allocPL(n){
  if(PL) return;
  PL={n:new Array(n), t:new Int16Array(n), la:new Int32Array(n), lo:new Int32Array(n), g:new Int32Array(n),
    v:new Int32Array(n), h:new Int32Array(n), r:new Int32Array(n), z:new Int16Array(n), c:new Int16Array(n),
    pa:new Int32Array(n).fill(-1), ok:new Uint8Array(n), ch:new Map()};
  SIDX=new Array(n); if(!PIDX) PIDX=new Map();
}
function allocTR(n){
  if(TR) return;
  TR={la:new Int32Array(n), lo:new Int32Array(n), g:new Int32Array(n), v:new Int32Array(n), h:new Int32Array(n),
    hl:new Int32Array(n), hh:new Int32Array(n), r1:new Int32Array(n), r2:new Int32Array(n), r3:new Int32Array(n), r4:new Int32Array(n),
    z:new Int16Array(n), c:new Int16Array(n), ok:new Uint8Array(n)};
  if(!TIDX) TIDX=new Map();
}
function indexPlace(j){
  const k=(Math.floor(PL.lo[j]/2000))+':'+(Math.floor(PL.la[j]/2000));
  let a=PIDX.get(k); if(!a){a=[];PIDX.set(k,a);} if(a.indexOf(j)<0) a.push(j);
}
function unindexPlace(j){
  if(!PIDX||!PL.ok[j]) return;
  const k=(Math.floor(PL.lo[j]/2000))+':'+(Math.floor(PL.la[j]/2000));
  const a=PIDX.get(k); if(!a) return; const i=a.indexOf(j); if(i>=0) a.splice(i,1);
}
function indexTract(i){
  const k=(Math.floor(TR.lo[i]/1000))+':'+(Math.floor(TR.la[i]/1000));
  let a=TIDX.get(k); if(!a){a=[];TIDX.set(k,a);} a.push(i);
}
function onceState(kind, st, fn){
  const key=kind+':'+st;
  if(!stateJobs.has(key)) stateJobs.set(key, Promise.resolve().then(fn).catch(err=>{ stateJobs.delete(key); throw err; }));
  return stateJobs.get(key);
}
async function loadSummary(){
  const a=await gzbin(dataUrl(window.LB_SUMMARY||'data/pkg/summary.bin'));
  ST=a.states; META=a.meta; FILES=a.files||{};
  ST.forEach((s,i)=>STI[s.c]=i);
  for(const s of ST) derive(s.v,s.c);
  LG=a.counties.map(row=>{
    const [n,s,cls,lat,lng,f,res,hv,rent2]=row;
    const num=x=>x==null||x===' '?null:x;
    return finishCounty({n,s,cls,lat,lng,f,mi2:0,cb:'',nt:0,np:0,conf:1,zs:[],r:null,
      v:{res:num(res),hv:num(hv),rent2:num(rent2),hvlo:null,hvhi:null,rent1:null,rent3:null,rent4:null,resU:null,resR:null,lo:null,hi:null,farm:null}});
  });
  allocPL(META.counts.places); allocTR(META.counts.tracts);
}
function loadCities(){
  if(citiesPromise) return citiesPromise;
  citiesPromise=(async()=>{
    await summaryPromise;
    const rows=await gzbin(dataUrl(FILES.cities));
    for(const c of rows){
      const [name,i,g,v,h,r,z,cf,la,lo]=c;
      if(placeHave.has(LG[g].s)) continue; // the full state file already has this city
      PL.n[i]=name; PL.t[i]=0; PL.g[i]=g; PL.v[i]=v; PL.h[i]=h; PL.r[i]=r; PL.z[i]=z; PL.c[i]=cf; PL.la[i]=la; PL.lo[i]=lo; PL.ok[i]=1;
      SIDX[i]=norm(name); indexPlace(i);
    }
  })();
  return citiesPromise;
}
function loadCountyState(st){
  if(countyHave.has(st)) return Promise.resolve();
  return onceState('c', st, async()=>{
    const d=await gzbin(dataUrl(FILES.c[st]));
    d.rows.forEach((row,k)=>{
      const g=LG[d.b+k]; const rings=g.r;
      const [mi2,cb,nt,np,conf,lat,lng,cls,vals,zs]=row;
      g.mi2=mi2; g.cb=cb||''; g.nt=nt; g.np=np; g.conf=conf; g.lat=lat; g.lng=lng; g.cls=cls; g.zs=zs||[];
      g.v=valsFrom(vals); if(rings) g.r=rings; finishCounty(g);
    });
    countyHave.add(st);
  });
}
function loadGeomState(st){
  if(geomHave.has(st)) return Promise.resolve();
  return onceState('g', st, async()=>{
    const d=await gzbin(dataUrl(FILES.g[st]));
    d.r.forEach((rings,k)=>{ LG[d.b+k].r=rings; });
    if(d.border&&d.border.length) BORDERS.push({c:st,r:d.border});
    geomHave.add(st); LGR=null;
    if(geomHave.size===ST.length&&FILES.borderOrder) BORDERS.sort((a,b)=>FILES.borderOrder.indexOf(a.c)-FILES.borderOrder.indexOf(b.c));
  });
}
function loadPlacesState(st){
  if(placeHave.has(st)) return Promise.resolve();
  return onceState('p', st, async()=>{
    const d=await gzbin(dataUrl(FILES.p[st]));
    const base=d.b, n=d.n.length;
    undelta(d.la); undelta(d.lo);
    for(let i=0;i<n;i++){
      const j=base+i;
      if(PL.ok[j]) unindexPlace(j);
      PL.n[j]=d.n[i]; PL.t[j]=d.t[i]; PL.la[j]=d.la[i]; PL.lo[j]=d.lo[i]; PL.g[j]=d.g[i];
      PL.v[j]=d.v[i]; PL.h[j]=d.h[i]; PL.r[j]=d.r[i]; PL.z[j]=d.z[i]; PL.c[j]=d.c[i]; PL.ok[j]=1;
      SIDX[j]=norm(d.n[i]); indexPlace(j);
      if(PL.t[j]===3){ if(!ZIPI) ZIPI=new Map(); ZIPI.set(String(PL.n[j]).slice(-5), j); }
    }
    if(d.pk){ let k=0; d.pk.forEach((dd,i)=>{ k+=dd; const p=d.pp[i]; const cj=base+k, pj=base+p;
      PL.pa[cj]=pj; let a2=PL.ch.get(pj); if(!a2){a2=[];PL.ch.set(pj,a2);} if(a2.indexOf(cj)<0) a2.push(cj); }); }
    placeHave.add(st);
  });
}
function loadTractsState(st){
  if(tractHave.has(st)) return Promise.resolve();
  return onceState('t', st, async()=>{
    const d=await gzbin(dataUrl(FILES.t[st]));
    const base=d.b, n=d.g.length;
    undelta(d.la); undelta(d.lo);
    for(let i=0;i<n;i++){
      const j=base+i;
      TR.la[j]=d.la[i]; TR.lo[j]=d.lo[i]; TR.g[j]=d.g[i]; TR.v[j]=d.v[i]; TR.h[j]=d.h[i]; TR.hl[j]=d.hl[i]; TR.hh[j]=d.hh[i];
      TR.r1[j]=d.r1[i]; TR.r2[j]=d.r2[i]; TR.r3[j]=d.r3[i]; TR.r4[j]=d.r4[i]; TR.z[j]=d.z[i]; TR.c[j]=d.c[i]; TR.ok[j]=1;
      indexTract(j);
    }
    tractHave.add(st);
  });
}
function loadEvidenceState(st){
  if(evHave.has(st)) return Promise.resolve();
  return onceState('e', st, async()=>{
    const rows=await gzbin(dataUrl(FILES.e[st]));
    for(const e of rows) EV.push([e[0],e[1],e[2],e[3],e[4],2015,st,e[5]]);
    EV.sort((a,b)=>(a[7]||0)-(b[7]||0));
    evHave.add(st);
  });
}
function loadAllCountyValues(){ if(!countyAll) countyAll=Promise.all(ST.map(s=>loadCountyState(s.c))); return countyAll; }
function loadAllGeom(){ if(!geomAll) geomAll=Promise.all(ST.map(s=>loadGeomState(s.c))); return geomAll; }
function loadAllPlaces(){ return Promise.all(ST.map(s=>loadPlacesState(s.c))); }
function loadAllEvidence(){ return Promise.all(ST.map(s=>loadEvidenceState(s.c))); }
function loadZipIndex(){
  if(zipPromise) return zipPromise;
  zipPromise=(async()=>{
    await summaryPromise;
    const d=await gzbin(dataUrl(FILES.z));
    ZIPMETA=d;
    if(!ZIPI) ZIPI=new Map();
    for(const z in d) if(!ZIPI.has(z)) ZIPI.set(z, d[z][0]);
    zipReady=true;
  })();
  return zipPromise;
}
function stateForPlace(j){
  const pb=FILES.pb||{};
  for(const st in pb){ const a=pb[st][0], b=pb[st][1]; if(j>=a&&j<=b) return st; }
  return LG[PL.g[j]]&&PL.ok[j]?LG[PL.g[j]].s:null;
}
function statesTouching(lat,lng){
  const out=[];
  for(const s of ST){ const b=s.bb; if(!b) continue; if(lng>=b[0]-0.45&&lng<=b[2]+0.45&&lat>=b[1]-0.45&&lat<=b[3]+0.45) out.push(s.c); }
  if(!out.length&&LG.length){ let best=0,d0=1e9; for(let i=0;i<LG.length;i++){ const d=km(lat,lng,LG[i].lat,LG[i].lng); if(d<d0){d0=d;best=i;} } out.push(LG[best].s); }
  return out;
}
function loadArea(lat,lng){
  const sts=statesTouching(lat,lng);
  return Promise.all(sts.flatMap(st=>[loadGeomState(st),loadTractsState(st),loadPlacesState(st),loadCountyState(st),loadEvidenceState(st)]));
}
function areaReady(lat,lng){ return statesTouching(lat,lng).every(st=>tractHave.has(st)&&placeHave.has(st)&&geomHave.has(st)); }
const REG={CT:'NE',ME:'NE',MA:'NE',NH:'NE',RI:'NE',VT:'NE',NJ:'NE',NY:'NE',PA:'NE',IL:'MW',IN:'MW',MI:'MW',OH:'MW',WI:'MW',IA:'MW',KS:'MW',MN:'MW',MO:'MW',NE:'MW',ND:'MW',SD:'MW',AZ:'W',CO:'W',ID:'W',MT:'W',NV:'W',NM:'W',UT:'W',WY:'W',AK:'W',CA:'W',HI:'W',OR:'W',WA:'W'};
const REGN={NE:'Northeast',MW:'Midwest',S:'South',W:'West'};
const regionOf=st=>REG[st]||'S';
function derive(v,st){ // measures derived from the modelled values
  v.acre=v.res?v.res*SQFT_ACRE:null;
  v.bcost=(META.build||{})[regionOf(st)]||null;
  v.lsh=null; v.str=null; if(v.hv&&v.res){ const lot=v.res*QLOT; if(lot<0.85*v.hv){ v.lsh=Math.max(1,100*lot/v.hv); v.str=v.hv-lot; } } // in condo and apartment areas a quarter-acre lot outprices the typical home, so no split is shown
  v.yld=(v.rent2&&v.hv)?100*12*v.rent2/v.hv:null;
  return v;
}

/* ---------- derived values ---------- */
function decode(enc){ const out=[]; let x=0,y=0; for(const p of enc.split(' ')){ const k=p.indexOf(','); x+=+p.slice(0,k); y+=+p.slice(k+1); out.push([x/1000,y/1000]); } return out; }
const RK=['rent1','rent2','rent3','rent4'];
function placeVals(j){
  const g=LG[PL.g[j]], o={res:PL.v[j]/100, hv:PL.h[j]*100, rent2:PL.r[j]||null, zone:PL.z[j]};
  const rh=g.v.hv?o.hv/g.v.hv:1, rr=(g.v.rent2&&o.rent2)?o.rent2/g.v.rent2:Math.pow(rh,0.45);
  o.hvlo=g.v.hvlo?g.v.hvlo*rh:null; o.hvhi=g.v.hvhi?g.v.hvhi*rh:null;
  for(const k of RK) if(k!=='rent2') o[k]=g.v[k]?g.v[k]*rr:null;
  if(!o.rent2&&g.v.rent2) o.rent2=g.v.rent2*rr;
  o.farm=(g.v.farm&&!URBAN_T.has(PL.t[j]))?g.v.farm:(PL.t[j]===5||PL.t[j]===6?g.v.farm:null);
  orderRents(o);
  return derive(o,g.s);
}
function orderRents(o){ if(o.rent1&&o.rent2) o.rent2=Math.max(o.rent2,o.rent1*1.08); if(o.rent2&&o.rent3) o.rent3=Math.max(o.rent3,o.rent2*1.1); if(o.rent3&&o.rent4) o.rent4=Math.max(o.rent4,o.rent3*1.08); if(o.hvlo&&o.hv) o.hvlo=Math.min(o.hvlo,o.hv); if(o.hvhi&&o.hv) o.hvhi=Math.max(o.hvhi,o.hv); }
function tractVals(i){
  const o={res:TR.v[i]/100, hv:TR.h[i]*100, hvlo:TR.hl[i]*100, hvhi:TR.hh[i]*100, rent1:TR.r1[i], rent2:TR.r2[i], rent3:TR.r3[i], rent4:TR.r4[i], zone:TR.z[i]};
  for(const k of ['hvlo','hvhi','rent1','rent2','rent3','rent4']) if(!(o[k]>0)) o[k]=null;
  return o;
}

/* ---------- map ---------- */
const CX=Math.cos(38*Math.PI/180);
const W2=(lng,lat)=>[lng*CX,-lat];
const canvas=$('map'), ctx=canvas.getContext('2d');
let dpr=1, view={s:1,tx:0,ty:0}, layer='res', breaks={}, lgaPaths=[], statePaths=[], hoverL=-1, selL=-1, selState=null, selPt=null, PIDX=null, TIDX=null;
function css(v){return getComputedStyle(document.documentElement).getPropertyValue(v).trim();}
let COL={};
function readColors(){ COL={sea:css('--sea'),land:css('--land'),edge:css('--edge'),sedge:css('--sedge'),sel:css('--sel'),nd:css('--nd'),ink:css('--ink'),muted:css('--muted'),pin:css('--pin'),surface:css('--surface'),accent:css('--accent'),s:[0,1,2,3,4,5,6].map(i=>css('--s'+i))}; }
function buildPaths(){
  lgaPaths=LG.map(g=>{ const p=new Path2D(); for(const enc of (g.r||[])){ const pts=decode(enc); pts.forEach(([lng,lat],i)=>{const [X,Y]=W2(lng,lat); i?p.lineTo(X,Y):p.moveTo(X,Y);}); p.closePath(); } return p; });
  statePaths=BORDERS.map(b=>{ const p=new Path2D(); for(const enc of b.r){ const pts=decode(enc); pts.forEach(([lng,lat],i)=>{const [X,Y]=W2(lng,lat); i?p.lineTo(X,Y):p.moveTo(X,Y);}); p.closePath(); } return {c:b.c,p}; });
}
function buildIndex(){ /* places and tracts are indexed as each state file arrives */ }
function computeBreaks(){
  for(const [k] of LAYERS){ const vals=LG.map(g=>g.v[k]).filter(v=>v>0).sort((a,b)=>a-b); const q=[0.2,0.42,0.62,0.78,0.9,0.97].map(f=>vals[Math.floor(vals.length*f)]); breaks[k]=q.map(v=>k==='yld'||k==='lsh'?Math.round(v*10)/10:sig(v,2)).filter((v,i,a)=>!i||v>a[i-1]); }
}
const cls=(k,v)=>{ if(k==='zone') return v==null?-1:v; if(!(v>0)) return -1; const b=breaks[k]; let i=0; while(i<b.length&&v>=b[i]) i++; return i; };
const colOf=(k,c)=>c<0?COL.nd:(k==='zone'?ZONEC[c]:COL.s[Math.min(6,c)]);
function pval(j,k){ return k==='res'?PL.v[j]/100:k==='hv'?PL.h[j]*100:k==='zone'?PL.z[j]:placeVals(j)[k]; }
function resize(){ const r=canvas.getBoundingClientRect(); dpr=window.devicePixelRatio||1; canvas.width=Math.round(r.width*dpr); canvas.height=Math.round(r.height*dpr); draw(); }
function fitBox(x0,y0,x1,y1,pad=0.04){ const r=canvas.getBoundingClientRect(); const w=(x1-x0)*(1+2*pad), h=(y1-y0)*(1+2*pad); const s=Math.min(r.width/w, r.height/h); view.s=s; view.tx=r.width/2-s*(x0+x1)/2; view.ty=r.height/2-s*(y0+y1)/2; draw(); }
function fitLL(lat0,lng0,lat1,lng1){ const a=W2(lng0,lat0), b=W2(lng1,lat1); fitBox(Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.max(a[0],b[0]),Math.max(a[1],b[1])); }
const US48=[24.4,-125,49.5,-66.8];
const fitAll=()=>fitLL(...US48);
function toWorld(px,py){ return [(px-view.tx)/view.s,(py-view.ty)/view.s]; }
function toLL(px,py){ const [X,Y]=toWorld(px,py); return [-Y, X/CX]; }
function toScreen(lat,lng){ const [X,Y]=W2(lng,lat); return [X*view.s+view.tx, Y*view.s+view.ty]; }
let raf=0; function draw(){ cancelAnimationFrame(raf); raf=requestAnimationFrame(render); }
function render(){
  if(!lgaPaths.length) return;
  const W=canvas.width, H=canvas.height;
  ctx.setTransform(1,0,0,1,0,0); ctx.fillStyle=COL.sea; ctx.fillRect(0,0,W,H);
  ctx.setTransform(dpr*view.s,0,0,dpr*view.s,dpr*view.tx,dpr*view.ty);
  const lw=1/view.s;
  for(let i=0;i<LG.length;i++){ ctx.fillStyle=colOf(layer,cls(layer,LG[i].v[layer])); ctx.fill(lgaPaths[i]); }
  if(view.s>14){ ctx.strokeStyle=COL.edge; ctx.lineWidth=lw*0.5; for(const p of lgaPaths) ctx.stroke(p); }
  ctx.strokeStyle=COL.sedge; ctx.lineWidth=lw*1.2; for(const b of statePaths) ctx.stroke(b.p);
  if(selState){ const b=statePaths.find(x=>x.c===selState); if(b){ ctx.strokeStyle=COL.sel; ctx.lineWidth=lw*2.6; ctx.stroke(b.p);} }
  if(hoverL>=0){ ctx.strokeStyle=COL.sel; ctx.lineWidth=lw*1.6; ctx.stroke(lgaPaths[hoverL]); }
  if(selL>=0){ ctx.strokeStyle=COL.sel; ctx.lineWidth=lw*3; ctx.stroke(lgaPaths[selL]); }
  ctx.setTransform(dpr,0,0,dpr,0,0);
  drawPlaces();
  if(selPt){ const [x,y]=toScreen(selPt[0],selPt[1]); ctx.fillStyle=COL.pin; ctx.strokeStyle=COL.surface; ctx.lineWidth=2.5; ctx.beginPath(); ctx.arc(x,y,7,0,Math.PI*2); ctx.fill(); ctx.stroke(); }
}
function visiblePlaces(minType){
  const r=canvas.getBoundingClientRect(); const [la1,lo0]=toLL(0,0), [la0,lo1]=toLL(r.width,r.height);
  const out=[]; const gx0=Math.floor(lo0*10000/2000), gx1=Math.floor(lo1*10000/2000), gy0=Math.floor(la0*10000/2000), gy1=Math.floor(la1*10000/2000);
  if((gx1-gx0)*(gy1-gy0)>8000) return null;
  for(let gx=gx0;gx<=gx1;gx++) for(let gy=gy0;gy<=gy1;gy++){ const a=PIDX.get(gx+':'+gy); if(a) for(const j of a) if(DRANK[PL.t[j]]<=minType) out.push(j); }
  return out;
}
let labelsDrawn=[];
function drawPlaces(){
  if(!PL){ labelsDrawn=[]; return; }
  const s=view.s; labelsDrawn=[];
  const maxT = s<60?0: s<160?1: s<400?2: s<900?4: s<2000?5: 6;
  let list;
  if(s<60){ list=[]; for(let j=0;j<PL.t.length;j++) if(PL.ok[j]&&PL.t[j]===0) list.push(j); }
  else list=visiblePlaces(maxT)||[];
  const r=canvas.getBoundingClientRect();
  const occ=new Set(); const cell=8; let nlab=0;
  list.sort((a,b)=>DRANK[PL.t[a]]-DRANK[PL.t[b]]||PL.h[b]-PL.h[a]);
  ctx.font='600 11px '+getComputedStyle(document.body).fontFamily;
  ctx.textBaseline='middle';
  let drawn=0;
  for(const j of list){
    if(drawn>5000) break;
    const [x,y]=toScreen(PL.la[j]/1e4,PL.lo[j]/1e4); if(x<-20||y<-20||x>r.width+20||y>r.height+20) continue;
    const t=PL.t[j], dt=DRANK[t], rad=dt===0?4.5:dt===1?3.5:dt<=3?2.8:dt===4?2.2:2.0;
    ctx.fillStyle=colOf(layer,cls(layer,pval(j,layer))); ctx.strokeStyle=t>=8?COL.pin:COL.ink; ctx.lineWidth=t<=1?1.2:0.8;
    ctx.beginPath(); ctx.arc(x,y,rad,0,Math.PI*2); ctx.fill(); ctx.stroke(); drawn++;
    labelsDrawn.push([j,x,y,rad]);
    const showLab = dt===0 || (dt===1&&s>=120) || (dt<=3&&s>=500) || (dt<=4&&s>=1200) || s>=2400;
    if(showLab && nlab<260){ const name=PL.n[j]; const w=ctx.measureText(name).width; const k1=Math.floor((x+4)/cell), k2=Math.floor((x+8+w)/cell), y1=Math.floor((y-9)/cell), y2=Math.floor((y+9)/cell);
      let free=true; for(let k=k1;k<=k2&&free;k++) for(let yy=y1;yy<=y2;yy++) if(occ.has(k+':'+yy)){free=false;break;}
      if(free){ nlab++; for(let k=k1;k<=k2;k++) for(let yy=y1;yy<=y2;yy++) occ.add(k+':'+yy); ctx.lineWidth=3; ctx.strokeStyle=COL.surface; ctx.strokeText(name,x+6,y); ctx.fillStyle=COL.ink; ctx.fillText(name,x+6,y); } }
  }
}
function lgaAt(px,py){
  const [lat,lng]=toLL(px,py); return lgaContaining(lat,lng,true);
}
function placeAt(px,py){ let best=-1,bd=81; for(const [j,x,y] of labelsDrawn){ const d=(x-px)**2+(y-py)**2; if(d<bd){bd=d;best=j;} } return best; }
function nearestPlaces(lat,lng,k=6,maxKm=8,types){
  const out=[]; const gx=Math.floor(lng*10000/2000), gy=Math.floor(lat*10000/2000);
  for(let dx=-1;dx<=1;dx++) for(let dy=-1;dy<=1;dy++){ const a=PIDX.get((gx+dx)+':'+(gy+dy)); if(a) for(const j of a){ if(types&&!types.has(PL.t[j])) continue; const d=km(lat,lng,PL.la[j]/1e4,PL.lo[j]/1e4); if(d<=maxKm) out.push([j,d]); } }
  out.sort((a,b)=>a[1]-b[1]); return out.slice(0,k);
}
function nearestTracts(lat,lng,k=5,maxKm=25){
  const out=[]; const gx=Math.floor(lng*10000/1000), gy=Math.floor(lat*10000/1000);
  for(let ring=0;ring<=3&&out.length<k;ring++){
    for(let dx=-ring;dx<=ring;dx++) for(let dy=-ring;dy<=ring;dy++){ if(Math.max(Math.abs(dx),Math.abs(dy))!==ring) continue; const a=TIDX.get((gx+dx)+':'+(gy+dy)); if(a) for(const i of a){ const d=km(lat,lng,TR.la[i]/1e4,TR.lo[i]/1e4); if(d<=maxKm) out.push([i,d]); } }
  }
  out.sort((a,b)=>a[1]-b[1]); return out.slice(0,k);
}
function km(a,b,c,d){ const R=6371,t=Math.PI/180; const h=Math.sin((c-a)*t/2)**2+Math.cos(a*t)*Math.cos(c*t)*Math.sin((d-b)*t/2)**2; return 2*R*Math.asin(Math.sqrt(h)); }

/* interaction */
const tip=$('tip'), card=$('mapcard');
let drag=null, moved=false; const ptrs=new Map(); let pinch=null;
canvas.addEventListener('pointerdown',e=>{ canvas.setPointerCapture(e.pointerId); ptrs.set(e.pointerId,{x:e.clientX,y:e.clientY}); drag={x:e.clientX,y:e.clientY}; moved=false; canvas.classList.add('drag'); });
canvas.addEventListener('pointermove',e=>{
  const r=canvas.getBoundingClientRect();
  if(ptrs.has(e.pointerId)){
    const prev=ptrs.get(e.pointerId); ptrs.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(ptrs.size===2){ const [a,b]=[...ptrs.values()]; const d=Math.hypot(a.x-b.x,a.y-b.y); if(pinch){ zoomAt(d/pinch,(a.x+b.x)/2-r.left,(a.y+b.y)/2-r.top);} pinch=d; moved=true; return; }
    const dx=e.clientX-prev.x, dy=e.clientY-prev.y; if(Math.abs(e.clientX-drag.x)+Math.abs(e.clientY-drag.y)>4) moved=true;
    if(moved){ view.tx+=dx; view.ty+=dy; tip.hidden=true; draw(); }
    return;
  }
  const px=e.clientX-r.left, py=e.clientY-r.top; const i=lgaAt(px,py);
  const j=placeAt(px,py);
  if(i!==hoverL){ hoverL=i; draw(); }
  if(j>=0) tip.innerHTML=tipPlace(j); else if(i>=0) tip.innerHTML=tipLGA(i);
  if(i>=0||j>=0){ tip.hidden=false; let x=px+14, y=py+12; if(x>r.width-250) x=px-250; if(y>r.height-90) y=py-80; tip.style.left=x+'px'; tip.style.top=y+'px'; } else tip.hidden=true;
});
const endPtr=e=>{ const was=moved; ptrs.delete(e.pointerId); if(ptrs.size<2) pinch=null; if(!ptrs.size){ canvas.classList.remove('drag'); if(was) canvasLoadPlaces(); } };
canvas.addEventListener('pointerup',e=>{ const wasMoved=moved; endPtr(e); if(wasMoved||e.button>0) return; const r=canvas.getBoundingClientRect(); const px=e.clientX-r.left, py=e.clientY-r.top;
  const j=placeAt(px,py); if(j>=0){ selectPlace(j,false); return; }
  const [lat,lng]=toLL(px,py); const i=lgaAt(px,py); if(i<0) return; selectPoint(lat,lng,i); });
canvas.addEventListener('pointercancel',endPtr);
canvas.addEventListener('pointerleave',()=>{ tip.hidden=true; if(hoverL>=0){hoverL=-1; draw();} });
canvas.addEventListener('wheel',e=>{ e.preventDefault(); const r=canvas.getBoundingClientRect(); zoomAt(e.deltaY<0?1.25:0.8,e.clientX-r.left,e.clientY-r.top); },{passive:false});
canvas.addEventListener('dblclick',e=>{ const r=canvas.getBoundingClientRect(); zoomAt(2,e.clientX-r.left,e.clientY-r.top); });
function statesInBounds(west,south,east,north){
  const out=[];
  for(const s of ST){ const b=s.bb; if(!b) continue; if(b[2]<west||b[0]>east||b[3]<south||b[1]>north) continue; out.push(s.c); }
  return out;
}
let visTimer=0;
function scheduleVisiblePlaces(west,south,east,north,onDone){
  clearTimeout(visTimer);
  visTimer=setTimeout(()=>{
    const jobs=statesInBounds(west,south,east,north).filter(st=>!placeHave.has(st)).map(loadPlacesState);
    if(!jobs.length){ if(onDone) onDone(); return; }
    Promise.all(jobs).then(()=>{ if(onDone) onDone(); }).catch(()=>{});
  },80);
}
function canvasLoadPlaces(){
  if(view.s<60||!mapReady) return;
  const r=canvas.getBoundingClientRect(); const [la1,lo0]=toLL(0,0), [la0,lo1]=toLL(r.width,r.height);
  scheduleVisiblePlaces(Math.min(lo0,lo1),Math.min(la0,la1),Math.max(lo0,lo1),Math.max(la0,la1),()=>draw());
}
function zoomAt(f,px,py){ const ns=Math.max(8,Math.min(30000,view.s*f)); f=ns/view.s; view.tx=px-(px-view.tx)*f; view.ty=py-(py-view.ty)*f; view.s=ns; draw(); canvasLoadPlaces(); }
$('zin').onclick=()=>MAPI.zoom(1.6);
$('zout').onclick=()=>MAPI.zoom(1/1.6);
$('zall').onclick=()=>MAPI.fitAll();
function lgaBox(i){ const b=ringsOf(i).bb; return [b[1],b[0],b[3],b[2]]; }
const CANVAS_MAP={ kind:'canvas', refresh:()=>draw(), fitAll:()=>fitAll(), fitLL:(a,b,c,d)=>fitLL(a,b,c,d),
  fitLGA(i){ const [a,b,c,d]=lgaBox(i); const p=0.15*Math.max(c-a,d-b); fitLL(a-p,b-p,c+p,d+p); },
  flyPlace(la,lo,t){ const [X,Y]=W2(lo,la); const r=canvas.getBoundingClientRect(); view.s=Math.max(view.s, t<=1?600:1600); view.tx=r.width/2-X*view.s; view.ty=r.height/2-Y*view.s; draw(); },
  zoom(f){ const r=canvas.getBoundingClientRect(); zoomAt(f,r.width/2,r.height/2); },
  sat(la,lo){ this.flyPlace(la,lo,7); } };
let MAPI=CANVAS_MAP;
function unitOf(k){ return (LAYERS.find(l=>l[0]===k)||['','',''])[2]; }
function fmtL(k,v){ return v==null||!isFinite(v)?'\u2013':k==='yld'||k==='lsh'?v.toFixed(1)+'%':k==='zone'?(META.zones||[])[v]||'\u2013':short(v); }
function buildLayers(){
  $('layers').innerHTML=TABS[TAB].layers.map(([k,n])=>`<button type="button" data-k="${k}" aria-pressed="${k===layer}">${n}</button>`).join('');
}
$('layers').addEventListener('click',e=>{ const b=e.target.closest('button'); if(!b) return; layer=b.dataset.k; [...$('layers').children].forEach(x=>x.setAttribute('aria-pressed',x.dataset.k===layer)); legend(); MAPI.refresh(); });
function setTab(t){
  if(!TABS[t]||(t===TAB&&$('tabs').dataset.ready)) return; TAB=t; $('tabs').dataset.ready=1;
  [...$('tabs').querySelectorAll('[role=tab]')].forEach(b=>{ b.setAttribute('aria-selected',b.dataset.t===TAB); b.tabIndex=b.dataset.t===TAB?0:-1; });
  layer=TABS[TAB].head;
  buildLayers(); legend(); MAPI.refresh(); if(RER) RER(); if(TBL) TBL();
}
$('tabs').addEventListener('click',e=>{ const b=e.target.closest('[role=tab]'); if(b) setTab(b.dataset.t); });
document.querySelectorAll('.tlead[data-tab]').forEach(b=>b.addEventListener('click',()=>{ setTab(b.dataset.tab); $('mapsec').scrollIntoView(); }));
$('tabs').addEventListener('keydown',e=>{ if(e.key!=='ArrowRight'&&e.key!=='ArrowLeft') return; const k=Object.keys(TABS); const n=k[(k.indexOf(TAB)+(e.key==='ArrowRight'?1:k.length-1))%k.length]; setTab(n); $('tabs').querySelector(`[data-t="${n}"]`).focus(); });
function legend(){ const L=LAYERS.find(l=>l[0]===layer);
  if(layer==='zone'){ $('legend').innerHTML=`<div>Price tiers (dots); counties by their most common tier</div><div class="zleg">${(META.zones||[]).map((z,i)=>`<span><i style="background:${ZONEC[i]}"></i>${esc(z)}</span>`).join('')}</div>`; return; }
  const b=breaks[layer];
  if(!b){ $('legend').innerHTML=`<div>${TABS[TAB].name}: ${L[1]}, ${L[2]} (county median)</div>`; return; }
  $('legend').innerHTML=`<div>${TABS[TAB].name}: ${L[1]}, ${L[2]} (county median)</div><div class="row">${[0,1,2,3,4,5,6].map(i=>`<i style="background:var(--s${i})"></i>`).join('')}</div><div class="lab">${b.map(v=>`<span>${layer==='yld'||layer==='lsh'?v.toFixed(1):short(v).replace('$','')}</span>`).join('')}<span></span></div>`; }
function tipPlace(j){ const v=placeVals(j); return `<b>${esc(PL.n[j])}</b> <span class="muted">${TYPEN[PL.t[j]]}</span><br>${esc(LG[PL.g[j]].n)}, ${esc(LG[PL.g[j]].s)}<br><span class="num">${fmtL(layer,layer==='zone'?PL.z[j]:v[layer])}</span> ${layer==='zone'?'tier':unitOf(layer)}`; }
function tipLGA(i){ const g=LG[i]; return `<b>${esc(g.n)}</b> <span class="muted">${g.s}</span><br>${esc(SC[g.s])} \u00b7 ${g.cls}<br><span class="num">${fmtL(layer,g.v[layer])}</span> ${layer==='zone'?'most common tier':unitOf(layer)} ${layer==='zone'?'':'median'}<br><span class="muted small">Click to value this exact spot</span>`; }

/* ---------- panel ---------- */
const osm=(la,lo,z=18)=>`https://www.openstreetmap.org/?mlat=${la.toFixed(6)}&mlon=${lo.toFixed(6)}#map=${z}/${la.toFixed(6)}/${lo.toFixed(6)}`;
function confPill(c){ const C=CONF[c]||CONF[3]; return `<span class="pill c-${C[0]==='X'?'L':C[0]}" title="${esc(C[2])}">${C[1]}</span>`; }
const cell=(label,val,unit)=>`<div><span>${label}</span><b>${val}</b><small>${unit}</small></div>`;
function valueBlock(v,where,note){
  const zn=v.zone!=null&&META.zones?`<span class="ztag" style="--zc:${ZONEC[v.zone]}">${esc(META.zones[v.zone])}</span>`:'';
  if(TAB==='land') return `<div><p class="eyebrow">Residential land${where}</p><div class="headline"><span class="big num">${short(v.res)}</span><span class="muted">per sq ft</span>${zn}</div><p class="note">${note}</p></div>
   <div class="vals">${cell('Per acre',short(v.acre),'residential land')}${cell('Quarter-acre lot',short(v.res*QLOT),'10,890 sq ft')}${cell('City lot',short(v.res*5000),'5,000 sq ft')}${cell('Land share of a typical home',fmtL('lsh',v.lsh),v.lsh?'quarter-acre lot basis':'condo and apartment area')}${cell('Farmland',v.farm?short(v.farm):'\u2013',v.farm?'per acre, county average':'built-up, n/a')}${cell('One acre, 5 acres',v.acre?short(v.acre)+' \u00b7 '+short(v.acre*5*0.8):'\u2013','larger tracts sell for less per acre')}</div>`;
  if(TAB==='bld') return `<div><p class="eyebrow">Typical home${where}</p><div class="headline"><span class="big num">${short(v.hv)}</span><span class="muted">median value</span>${zn}</div><p class="note">${note}</p></div>
   <div class="vals">${cell('Entry-level home',short(v.hvlo),'lower quartile')}${cell('Upper-end home',short(v.hvhi),'upper quartile')}${cell('Structure value',short(v.str),'typical home minus its land')}${cell('Cost to build new',v.bcost?short(v.bcost):'\u2013','per sq ft, '+REGN[regionOf(curSt())]+', no land')}${cell('2,000 sq ft home, new',v.bcost?short(v.bcost*2000):'\u2013','construction only')}${cell('Land share',fmtL('lsh',v.lsh),'of the typical home')}</div>`;
  return `<div><p class="eyebrow">Rent, 2-bedroom${where}</p><div class="headline"><span class="big num">${short(v.rent2)}</span><span class="muted">per month</span>${zn}</div><p class="note">${note}</p></div>
   <div class="vals">${cell('1-bedroom',short(v.rent1),'per month')}${cell('3-bedroom',short(v.rent3),'per month')}${cell('4-bedroom',short(v.rent4),'per month')}${cell('2-bed, a year',v.rent2?short(v.rent2*12):'\u2013','12 months')}${cell('Gross yield',fmtL('yld',v.yld),'2-bed rent \u00f7 typical home')}${cell('Price-to-rent',v.rent2&&v.hv?(v.hv/(12*v.rent2)).toFixed(1)+'\u00d7':'\u2013','years of rent')}</div>`;
}
let CUR_ST='';
const curSt=()=>CUR_ST;
function zoneTable(zs,title){
  if(!zs||!zs.length) return '';
  return `<div><p class="eyebrow" style="margin-bottom:4px">${title}</p><table class="mini zt"><tr><td class="muted small">Tier</td><td class="r muted small">Land $/sq ft</td><td class="r muted small">Typical home</td><td class="r muted small">Rent 2-bed</td></tr>${zs.map(([z,n,res,hv,r2])=>`<tr><td><span class="zdot" style="background:${ZONEC[z]}"></span>${esc(META.zones[z])} <span class="muted small">${nfmt(n)} tracts</span></td><td class="r">${short(res)}</td><td class="r">${short(hv)}</td><td class="r">${short(r2)}</td></tr>`).join('')}</table><p class="note">Price tiers rank neighborhoods by home value within each metro area (Top tier = top 10%, Upper = next 25%, Mid = middle 35%, Entry = lowest 30%); outside metro areas they follow how built-up the land is. Tiers describe prices only.</p></div>`;
}
function actions(la,lo,st,exact){
  const satBtn=MAPI.kind==='mapbox'?`<button class="btn" type="button" data-sat="${la.toFixed(6)},${lo.toFixed(6)}">Satellite close-up</button>`:`<a class="btn" href="${osm(la,lo)}" target="_blank" rel="noopener">Open in OpenStreetMap \u2197</a>`;
  return `<div class="actions">${satBtn}<a class="btn wab" href="${waHref({name:'this spot in '+SC[st],lat:la,lng:lo})}" target="_blank" rel="noopener">WhatsApp us about it</a><a class="btn ghost" href="mailto:buildocrat@gmail.com?subject=${encodeURIComponent('US Land Value Book: '+la.toFixed(5)+', '+lo.toFixed(5))}">Email us</a></div>
  <div class="pc" data-pc="${la.toFixed(6)},${lo.toFixed(6)}" data-exact="${exact?1:0}"><p class="eyebrow">ZIP code</p><p class="note">Looking up this spot\u2026</p></div>
  <p class="note">Coordinates <span class="mono">${la.toFixed(5)}, ${lo.toFixed(5)}</span> <button class="linkbtn" type="button" data-copy="${la.toFixed(6)}, ${lo.toFixed(6)}">Copy</button> \u00b7 <button class="linkbtn" type="button" data-copy="https://valued.buildocrat.store/#at=${la.toFixed(5)},${lo.toFixed(5)}">Copy link</button></p>`; }
function nearbyEvidence(la,lo){
  if(TAB!=='land') return '';
  const rows=EV.map(e=>({e,d:km(la,lo,e[2],e[3])})).filter(x=>x.d<=12).sort((a,b)=>a.d-b.d).slice(0,6);
  if(!rows.length) return `<p class="note">No published FHFA land price for a ZIP code within 12 km. Land here is modelled from home values and the county figure.</p>`;
  return `<div><p class="eyebrow" style="margin-bottom:4px">Published FHFA land prices within 12 km</p><table class="mini">${rows.map(({e,d})=>`<tr><td>ZIP ${esc(e[0])} <span class="muted small">${esc(e[1])} \u00b7 ${d.toFixed(1)} km</span></td><td class="r">${short(e[4]/SQFT_ACRE)}/sq ft</td><td class="r muted">${e[5]}</td></tr>`).join('')}</table><p class="note">Per-acre values for a standard quarter-acre lot as FHFA publishes them (2012–2022 data at 2015 prices); the book brings them up to date with FHFA's house price index.</p></div>`; }
function crumbs(parts){ return `<div class="crumbs">${parts.map(([t,a],i)=>(a?`<button type="button" data-go="${a}">${esc(t)}</button>`:`<span>${esc(t)}</span>`)+(i<parts.length-1?'<span>\u203a</span>':'')).join('')}</div>`; }
function ancestors(j){ const out=[]; let p=PL.pa[j], n=0; while(p>=0&&n<5){ out.unshift(p); p=PL.pa[p]; n++; } return out; }
let SEL=null, RER=null;
const WA_NO='2347018024292';
function waText(s){ return s?`Hello Buildocrat, I'm interested in ${s.name.replace(/^Pinned spot/,'a spot')} on the US Land Value Book: https://valued.buildocrat.store/#at=${s.lat.toFixed(5)},${s.lng.toFixed(5)} . `:"Hello Buildocrat, I'm on the US Land Value Book (valued.buildocrat.store). "; }
const waHref=s=>`https://wa.me/${WA_NO}?text=${encodeURIComponent(waText(s))}`;
function setSel(s){ SEL=s; estimate(); const a=$('wa'); if(a) a.href=waHref(s); }
function selectPlace(j,fly=true){
  if(!PL) return;
  if(!PL.ok[j]){
    const st=stateForPlace(j); if(!st) return;
    $('panel').innerHTML='<div class="loading">Loading places\u2026</div>';
    Promise.all([loadPlacesState(st),loadCountyState(st),loadEvidenceState(st)]).then(()=>selectPlace(j,fly));
    return;
  }
  const st=LG[PL.g[j]].s;
  if(!placeHave.has(st)||!countyHave.has(st)||!evHave.has(st)){
    $('panel').innerHTML='<div class="loading">Loading places\u2026</div>';
    Promise.all([loadPlacesState(st),loadCountyState(st),loadEvidenceState(st)]).then(()=>selectPlace(j,fly));
    return;
  }
  RER=()=>selectPlace(j,false);
  const g=LG[PL.g[j]], la=PL.la[j]/1e4, lo=PL.lo[j]/1e4, v=placeVals(j), t=PL.t[j];
  selL=PL.g[j]; selState=null; selPt=[la,lo]; CUR_ST=g.s;
  const show=()=>{ if(fly) MAPI.flyPlace(la,lo,DRANK[t]); MAPI.refresh(); };
  if(mapReady) show(); else if(fly) whenMap(show);
  const anc=ancestors(j), kids=(PL.ch.get(j)||[]).slice().sort((a,b)=>PL.t[a]-PL.t[b]||PL.h[b]-PL.h[a]);
  const base=TAB==='land'?`County median ${short(g.v.res)}/sq ft.`:TAB==='bld'?`County median home ${short(g.v.hv)}.`:`County 2-bed rent ${short(g.v.rent2)} a month.`;
  $('panel').innerHTML=`${crumbs([['United States','us'],[SC[g.s],'s:'+g.s],[g.n,'l:'+PL.g[j]]].concat(anc.map(a=>[PL.n[a],'p:'+a])).concat([[PL.n[j],null]]))}
   <div class="ptitle"><div><h3>${esc(PL.n[j])}</h3><div class="tags"><span class="tag ${URBAN_T.has(t)?'u':''}">${TYPEN[t]}</span>${anc.length?`<span class="tag">in ${esc(PL.n[anc[anc.length-1]])}</span>`:''}<span class="tag">${esc(g.n)}, ${g.s}</span></div></div>${confPill(PL.c[j])}</div>
   ${valueBlock(v,'',`${(CONF[PL.c[j]]||CONF[3])[2]}. ${base}`)}${actions(la,lo,g.s,false)}
   ${kids.length?`<div><p class="eyebrow" style="margin-bottom:4px">Inside ${esc(PL.n[j])} (${kids.length})</p><table class="mini">${kids.slice(0,40).map(k=>`<tr><td><button type="button" data-place="${k}">${esc(PL.n[k])}</button> <span class="muted small">${TYPEN[PL.t[k]]}</span></td><td class="r">${fmtL(TABS[TAB].head,pval(k,TABS[TAB].head))}</td></tr>`).join('')}</table></div>`:''}
   ${nearbyEvidence(la,lo)}`;
  zipFill();
  setSel({kind:'place',name:PL.n[j]+', '+g.n+', '+g.s,lat:la,lng:lo,st:g.s,v,conf:PL.c[j]});
}
const BKEYS=['res','hv','hvlo','hvhi','rent1','rent2','rent3','rent4'];
function spotValues(la,lo,i){ // value at any point: blend of the nearest census tracts, else the county
  const g=LG[i]; const nb=nearestTracts(la,lo,5,25);
  let v, note, conf=3;
  if(nb.length){ const acc={}, wk={}; BKEYS.forEach(k=>{acc[k]=0; wk[k]=0;});
    for(const [t,d] of nb){ const w=1/Math.max(0.25,d)**2; const tv=tractVals(t); BKEYS.forEach(k=>{ if(tv[k]>0){ acc[k]+=w*Math.log(tv[k]); wk[k]+=w; } }); }
    v={}; BKEYS.forEach(k=>v[k]=wk[k]>0?Math.exp(acc[k]/wk[k]):null);
    v.zone=TR.z[nb[0][0]]; conf=TR.c[nb[0][0]]; v.farm=v.zone>=5?g.v.farm:null;
    const np=nearestPlaces(la,lo,1,6,new Set([0,1,2,4,5,6,7,8]));
    note=`Blended from the ${nb.length} nearest census tracts (closest ${nb[0][1].toFixed(1)} km)${np.length?`; nearest named place ${esc(PL.n[np[0][0]])}, ${np[0][1].toFixed(1)} km`:''}.`; }
  else { v={...g.v}; note='No census tract center within 25 km, so this uses the county values. Likely rural or undeveloped land.'; v.res=g.v.resR||g.v.res; v.zone=6; }
  orderRents(v);
  return {v:derive(v,g.s),note,conf,nb};
}
function selectPoint(la,lo,i){
  if(!areaReady(la,lo)||!evHave.has(LG[i].s)){
    $('panel').innerHTML='<div class="loading">Loading census tracts and places\u2026</div>';
    Promise.all([loadArea(la,lo),loadEvidenceState(LG[i].s)]).then(()=>selectPoint(la,lo,i));
    return;
  }
  RER=()=>selectPoint(la,lo,i);
  const g=LG[i]; const {v,note,conf}=spotValues(la,lo,i);
  selL=i; selState=null; selPt=[la,lo]; CUR_ST=g.s; MAPI.refresh();
  const np=nearestPlaces(la,lo,6,8,new Set([0,1,2,4,5,6,7,8]));
  $('panel').innerHTML=`${crumbs([['United States','us'],[SC[g.s],'s:'+g.s],[g.n,'l:'+i]].concat(np.length&&np[0][1]<1.5?ancestors(np[0][0]).concat([np[0][0]]).map(a=>[PL.n[a],'p:'+a]):[]).concat([['Pinned spot',null]]))}
   <div class="ptitle"><div><h3>Pinned spot</h3><div class="tags"><span class="tag">${esc(g.n)}, ${g.s}</span><span class="tag">${g.cls}</span></div></div>${confPill(conf)}</div>
   ${valueBlock(v,' here',note)}${actions(la,lo,g.s,true)}
   ${np.length?`<div><p class="eyebrow" style="margin-bottom:4px">Nearest places</p><table class="mini">${np.map(([j,d])=>`<tr><td><button type="button" data-place="${j}">${esc(PL.n[j])}</button> <span class="muted small">${TYPEN[PL.t[j]]}, ${d.toFixed(1)} km</span></td><td class="r">${fmtL(TABS[TAB].head,pval(j,TABS[TAB].head))}</td></tr>`).join('')}</table></div>`:''}
   ${nearbyEvidence(la,lo)}`;
  zipFill();
  setSel({kind:'point',name:'Pinned spot in '+g.n+', '+g.s,lat:la,lng:lo,st:g.s,v,conf});
}
const LTYPES=[['','All places'],['0','Cities'],['1','Towns'],['2','Communities'],['3','ZIP codes'],['4','Neighborhoods'],['5','Villages'],['7','Subdivisions'],['8','Gated communities'],['6','Hamlets']];
function selectLGA(i,fly=true){
  const st=LG[i].s;
  if(!placeHave.has(st)||!countyHave.has(st)){
    $('panel').innerHTML='<div class="loading">Loading places\u2026</div>';
    Promise.all([loadPlacesState(st),loadCountyState(st),loadGeomState(st)]).then(()=>selectLGA(i,fly));
    return;
  }
  RER=()=>selectLGA(i,false);
  const g=LG[i]; selL=i; selState=null; selPt=null; CUR_ST=g.s;
  if(fly) whenMap(()=>{ MAPI.fitLGA(i); MAPI.refresh(); }); else MAPI.refresh();
  const hk=TABS[TAB].head;
  const pl=[]; for(let j=0;j<PL.g.length;j++) if(PL.g[j]===i) pl.push(j);
  const pv=new Map(pl.map(j=>[j,pval(j,hk)||0])); pl.sort((a,b)=>pv.get(b)-pv.get(a));
  const note=TAB==='land'?`Built-up areas ${short(g.v.resU)}/sq ft, rural land ${short(g.v.resR)}/sq ft. Range across the county's tracts ${short(g.v.lo)} to ${short(g.v.hi)}/sq ft.`:`Median across ${esc(g.n)}; pick a place or a spot for its own figure.`;
  $('panel').innerHTML=`${crumbs([['United States','us'],[SC[g.s],'s:'+g.s],[g.n,null]])}
   <div class="ptitle"><div><h3>${esc(g.n)}</h3><div class="tags"><span class="tag ${g.cls==='Rural'?'':'u'}">${g.cls}</span><span class="tag">${esc(SC[g.s])}</span>${g.cb?`<span class="tag">${esc(g.cb)}</span>`:''}<span class="tag">${nfmt(g.mi2)} sq mi</span><span class="tag">${nfmt(g.nt)} tracts</span></div></div>${confPill(g.conf)}</div>
   ${valueBlock(g.v,', county median',note)}
   ${zoneTable(g.zs,'Price tiers in '+esc(g.n))}
   <div><p class="eyebrow" style="margin-bottom:4px">Places in ${esc(g.n)} (${nfmt(pl.length)})</p>
   <div class="lgafilt"><input type="search" id="lgaPlaceQ" placeholder="Find a place in this county"><select id="lgaPlaceT" aria-label="Level">${LTYPES.map(([v,n])=>`<option value="${v}">${n}</option>`).join('')}</select></div>
   <table class="mini" id="lgaPlaces"></table></div>`;
  const draw2=()=>{ const q=norm($('lgaPlaceQ').value), ty=$('lgaPlaceT').value; const rows=pl.filter(j=>(!q||norm(PL.n[j]).includes(q))&&(ty===''||PL.t[j]===+ty)).slice(0,80);
    $('lgaPlaces').innerHTML=rows.map(j=>`<tr><td><button type="button" data-place="${j}">${esc(PL.n[j])}</button> <span class="muted small">${TYPEN[PL.t[j]]}</span></td><td class="r">${fmtL(hk,pv.get(j))}${TAB==='land'?'/sq ft':''}</td></tr>`).join('')||'<tr><td class="muted">No match.</td></tr>'; };
  $('lgaPlaceQ').addEventListener('input',draw2); $('lgaPlaceT').addEventListener('input',draw2); draw2();
  setSel({kind:'lga',name:g.n+', '+g.s,lat:g.lat,lng:g.lng,st:g.s,v:g.v,conf:g.conf});
}
function selectState(c,fly=true){
  RER=()=>selectState(c,false);
  const s=ST[STI[c]]; selState=c; selL=-1; selPt=null; CUR_ST=c;
  if(fly){ const b=s.bb; whenMap(()=>{ MAPI.fitLL(b[1],b[0],b[3],b[2]); MAPI.refresh(); }); } else MAPI.refresh();
  const hk=TABS[TAB].head;
  const lg=LG.map((g,i)=>[g,i]).filter(([g])=>g.s===c).sort((a,b)=>(b[0].v[hk]||0)-(a[0].v[hk]||0));
  $('panel').innerHTML=`${crumbs([['United States','us'],[SC[c],null]])}
   <div class="ptitle"><div><h3>${esc(SC[c])}</h3><div class="tags"><span class="tag u">Largest city: ${esc(s.big)}</span><span class="tag">Capital: ${esc(s.cap)}</span><span class="tag">${lg.length} counties</span><span class="tag">${nfmt(s.np)} places</span></div></div>${confPill(s.conf)}</div>
   ${valueBlock(s.v,', state median',`Medians across the state's census tracts, weighted by homes. Rural land across ${esc(SC[c])}: ${short(s.v.resR)}/sq ft; farmland ${s.v.farm?short(s.v.farm)+' an acre':'\u2013'}.`)}
   ${zoneTable(s.zs,'Price tiers across '+esc(SC[c]))}
   <div><p class="eyebrow" style="margin-bottom:4px">Counties by ${TABS[TAB].layers.find(l=>l[0]===hk)[1].toLowerCase()}</p><table class="mini">${lg.map(([g,i])=>`<tr><td><button type="button" data-lga="${i}">${esc(g.n)}</button> <span class="muted small">${g.cls}</span></td><td class="r">${fmtL(hk,g.v[hk])}</td></tr>`).join('')}</table></div>`;
  setSel({kind:'state',name:SC[c],lat:s.lat,lng:s.lng,st:c,v:s.v,conf:s.conf});
}
function nationalPanel(){
  RER=()=>nationalPanel();
  selState=null; selL=-1; selPt=null; MAPI.refresh();
  const hk=TABS[TAB].head, hn=TABS[TAB].layers.find(l=>l[0]===hk)[1].toLowerCase();
  const top=[...LG.keys()].sort((a,b)=>(LG[b].v[hk]||0)-(LG[a].v[hk]||0)).slice(0,10);
  $('panel').innerHTML=`<div class="ptitle"><div><h3>United States</h3><div class="tags"><span class="tag">50 states and DC</span><span class="tag">${nfmt(LG.length)} counties</span><span class="tag">${PL?nfmt(PL.n.length)+' places':'loading places\u2026'}</span></div></div></div>
   <p class="note">Click a state, a county, a dot or any house on the map, or enter coordinates above. Switch between land, home and rental values with the tabs. Each result gives the ZIP code for the exact spot.</p>
   <div><p class="eyebrow" style="margin-bottom:4px">Highest counties, ${hn}</p><table class="mini">${top.map(i=>`<tr><td><button type="button" data-lga="${i}">${esc(LG[i].n)}</button> <span class="muted small">${LG[i].s}</span></td><td class="r">${fmtL(hk,LG[i].v[hk])}</td></tr>`).join('')}</table></div>
   <div><p class="eyebrow" style="margin-bottom:4px">States, median</p><table class="mini">${[...ST].sort((a,b)=>(b.v[hk]||0)-(a.v[hk]||0)).map(s=>`<tr><td><button type="button" data-go="s:${s.c}">${esc(SC[s.c])}</button> <span class="muted small">${esc(s.big)}</span></td><td class="r">${fmtL(hk,s.v[hk])}</td></tr>`).join('')}</table></div>`;
}
$('panel').addEventListener('click',e=>{
  const b=e.target.closest('[data-go],[data-place],[data-lga],[data-copy],[data-sat]'); if(!b) return;
  if(b.dataset.sat){ const [a,c]=b.dataset.sat.split(',').map(Number); MAPI.sat(a,c); return; }
  if(b.dataset.copy){ const t=b.dataset.copy; const done=()=>{b.textContent='Copied';}; try{ navigator.clipboard.writeText(t).then(done,()=>{}); }catch(err){} return; }
  if(b.dataset.place) return selectPlace(+b.dataset.place);
  if(b.dataset.lga) return selectLGA(+b.dataset.lga);
  const g=b.dataset.go; if(g==='us'){ MAPI.fitAll(); nationalPanel(); } else if(g.startsWith('s:')) selectState(g.slice(2)); else if(g.startsWith('l:')) selectLGA(+g.slice(2)); else if(g.startsWith('p:')) selectPlace(+g.slice(2));
});

/* ---------- enter a pin: coordinates, map links, DMS ---------- */
const inUS=(a,b)=>isFinite(a)&&isFinite(b)&&((a>=18.5&&a<=72&&b>=-180&&b<=-64)||(a>=51&&a<=72&&b>=170));
function parseSpot(q){
  q=String(q||'').trim(); if(!q) return null; let m;
  const ok=(a,b)=>inUS(a,b)?[a,b]:(inUS(b,a)?[b,a]:(inUS(a,-Math.abs(b))&&b>0?[a,-b]:null));
  if((m=q.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/))) return ok(+m[1],+m[2]);
  if((m=q.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/))) return ok(+m[1],+m[2]);
  if((m=q.match(/[?&](?:q|query|ll|sll|daddr|destination|center)=(-?\d+\.\d+)(?:,|%2C)\s*(-?\d+\.\d+)/i))) return ok(+m[1],+m[2]);
  if((m=q.match(/mlat=(-?\d+\.\d+).*mlon=(-?\d+\.\d+)/))) return ok(+m[1],+m[2]);
  if((m=q.match(/#map=\d+(?:\.\d+)?\/(-?\d+\.\d+)\/(-?\d+\.\d+)/))) return ok(+m[1],+m[2]);
  if((m=q.match(/#at=(-?\d+\.\d+),(-?\d+\.\d+)/))) return ok(+m[1],+m[2]);
  const dms=[...q.matchAll(/(\d{1,3})\s*[\u00b0d:\s]\s*(\d{1,2})?\s*['\u2032m:\s]?\s*(\d{1,2}(?:\.\d+)?)?\s*["\u2033s]?\s*([NSEW])/gi)];
  if(dms.length>=2){ const dec=x=>(+x[1]+(+x[2]||0)/60+(+x[3]||0)/3600)*(/[SW]/i.test(x[4])?-1:1); const a=dms.find(x=>/[NS]/i.test(x[4])), b=dms.find(x=>/[EW]/i.test(x[4])); if(a&&b) return ok(dec(a),dec(b)); }
  if((m=q.match(/^\s*(-?\d{1,3}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/))) return ok(+m[1],+m[2]);
  return null;
}
function goSpot(){ const p=parseSpot($('pinq').value); const msg=$('pinmsg');
  if(!p){ msg.textContent='Enter latitude and longitude (e.g. 33.7490, -84.3880), degrees-minutes-seconds, or paste a Google Maps, Apple Maps or OpenStreetMap link.'; return; }
  if(!pickSpot(p[0],p[1],true)){ msg.textContent='That point is outside the 50 states and DC.'; return; }
  msg.textContent=`Valued ${p[0].toFixed(5)}, ${p[1].toFixed(5)}.`; history.replaceState(null,'','#at='+p[0].toFixed(5)+','+p[1].toFixed(5)); }
$('pinform').addEventListener('submit',e=>{ e.preventDefault(); goSpot(); });
$('pinme').addEventListener('click',()=>{ const msg=$('pinmsg'); if(!navigator.geolocation){ msg.textContent='This browser cannot share its location.'; return; }
  msg.textContent='Finding you\u2026'; navigator.geolocation.getCurrentPosition(p=>{ $('pinq').value=p.coords.latitude.toFixed(6)+', '+p.coords.longitude.toFixed(6); goSpot(); }, err=>{ msg.textContent='Location not available ('+err.message+').'; },{enableHighAccuracy:true,timeout:15000}); });

/* ---------- search ---------- */
let SIDX=null, ZIPI=null;
function search(q0){
  if(!ST.length) return [{k:'none',label:'Loading the places directory\u2026',sub:'One moment',score:0}];
  const ll=parseSpot(q0); if(ll) return [{k:'at',id:ll,label:'Coordinates '+ll[0].toFixed(5)+', '+ll[1].toFixed(5),sub:'Value this spot',score:0}];
  const zm=String(q0).trim().match(/^(\d{5})(?:-\d{4})?$/);
  if(zm){
    if(!zipReady) return [{k:'none',label:'ZIP '+zm[1],sub:'Looking it up\u2026',score:0}];
    const j=ZIPI&&ZIPI.get(zm[1]);
    if(j==null) return [{k:'none',label:'ZIP '+zm[1]+' not found',sub:'Try the town name',score:0}];
    if(!PL.ok[j]) return [{k:'none',label:'ZIP '+zm[1],sub:'Opening\u2026',score:0}];
    return [{k:'p',id:j,label:'ZIP '+zm[1],sub:LG[PL.g[j]].n+', '+LG[PL.g[j]].s,score:0}];
  }
  let q=norm(q0); let stf=null; const m2=q.match(/^(.*?)\s+([a-z]{2})$/); if(m2&&SC[m2[2].toUpperCase()]){ q=m2[1]; stf=m2[2].toUpperCase(); }
  if(q.length<2) return [];
  const out=[];
  for(const s of ST) if(norm(SC[s.c]).startsWith(q)||s.c.toLowerCase()===q) out.push({k:'s',id:s.c,label:SC[s.c],sub:'State \u00b7 largest city '+s.big,score:0});
  LG.forEach((g,i)=>{ if(stf&&g.s!==stf) return; const n=norm(g.n); if(n.startsWith(q)) out.push({k:'l',id:i,label:g.n,sub:SC[g.s],score:1}); else if(q.length>=4&&n.includes(q)) out.push({k:'l',id:i,label:g.n,sub:SC[g.s],score:3}); });
  if(SIDX){
    const sub=j=>TYPEN[PL.t[j]]+' \u00b7 '+(PL.pa[j]>=0?PL.n[PL.pa[j]]+', ':'')+LG[PL.g[j]].n+', '+LG[PL.g[j]].s;
    for(let j=0;j<SIDX.length&&out.length<500;j++){ if(!SIDX[j]||PL.t[j]===3) continue; if(stf&&LG[PL.g[j]].s!==stf) continue; const n=SIDX[j]; if(n===q&&PL.t[j]<=1) out.push({k:'p',id:j,label:PL.n[j],sub:sub(j),score:(PL.t[j]===0?0.3:0.8)}); else if(n.startsWith(q)) out.push({k:'p',id:j,label:PL.n[j],sub:sub(j),score:2+DRANK[PL.t[j]]*0.1-Math.log10(PL.h[j]+1)*0.001}); else if(q.length>=4&&n.includes(' '+q)) out.push({k:'p',id:j,label:PL.n[j],sub:sub(j),score:4+DRANK[PL.t[j]]*0.1}); }
  }
  return out.sort((a,b)=>a.score-b.score).slice(0,14);
}
let searchGen=0;
function paintSugg(){ sact=-1; if(!sres.length){ sg.hidden=true; return; } sg.innerHTML=sres.map((r,i)=>`<li><button type="button" role="option" data-i="${i}"><span>${esc(r.label)}</span><span class="k">${esc(r.sub)}</span></button></li>`).join(''); sg.hidden=false; }
const qi=$('q'), sg=$('sugg'); let sres=[], sact=-1;
function showSugg(){
  const q=qi.value, gen=++searchGen;
  const paints=()=>{ if(gen!==searchGen) return; sres=search(qi.value); paintSugg(); };
  paints();
  const zm=String(q).trim().match(/^(\d{5})(?:-\d{4})?$/);
  if(zm){ loadZipIndex().then(()=>{ const pair=ZIPMETA&&ZIPMETA[zm[1]]; return pair?loadPlacesState(LG[pair[1]].s):null; }).then(paints).catch(()=>{}); return; }
  if(parseSpot(q)) return;
  const nq=norm(q); const m2=nq.match(/^(.*?)\s+([a-z]{2})$/);
  const stf=m2&&SC[m2[2].toUpperCase()]?m2[2].toUpperCase():null;
  if(stf){ loadCities().then(paints).catch(()=>{}); loadPlacesState(stf).then(paints).catch(()=>{}); return; }
  if(nq.length<2){ loadCities().then(paints).catch(()=>{}); return; }
  // cities first, so a city name resolves before the rest of the directory arrives
  loadCities().then(paints).catch(()=>{});
  loadAllPlaces().then(paints).catch(()=>{});
}
function pick(r){ if(!r||r.k==='none') return; sg.hidden=true; qi.value=r.label; document.getElementById('mapsec').scrollIntoView(); if(r.k==='s') selectState(r.id); else if(r.k==='l') selectLGA(r.id); else if(r.k==='at') pickSpot(r.id[0],r.id[1],true); else selectPlace(r.id); }
qi.addEventListener('input',showSugg);
qi.addEventListener('keydown',e=>{ if(sg.hidden) return; if(e.key==='ArrowDown'||e.key==='ArrowUp'){ e.preventDefault(); sact=(sact+(e.key==='ArrowDown'?1:-1)+sres.length)%sres.length; [...sg.querySelectorAll('button')].forEach((b,i)=>b.setAttribute('aria-selected',i===sact)); } else if(e.key==='Enter'){ e.preventDefault(); pick(sres[Math.max(0,sact)]); } else if(e.key==='Escape') sg.hidden=true; });
sg.addEventListener('click',e=>{ const b=e.target.closest('button'); if(b) pick(sres[+b.dataset.i]); });
document.addEventListener('click',e=>{ if(!e.target.closest('.searchbox')) sg.hidden=true; });

/* ---------- tables ---------- */
function sortable(tbl, cols, getRows, render, pager, pageSize=50){
  const oldH=tbl.querySelector('thead'); const thead=oldH.cloneNode(false); oldH.replaceWith(thead);
  if(pager){ const np=pager.cloneNode(false); pager.replaceWith(np); pager=np; }
  let key=cols.find(c=>c.def)?.k||cols[0].k, dir=-1, page=0;
  const tbody=tbl.querySelector('tbody');
  thead.innerHTML='<tr>'+cols.map(c=>`<th data-k="${c.sort===false?'':c.k}" class="${c.r?'r':''}">${c.h}${c.k===key?(dir<0?' \u2193':' \u2191'):''}</th>`).join('')+'</tr>';
  function go(){ const rows=getRows(); const c=cols.find(x=>x.k===key); const f=c.val||(r=>r[key]);
    rows.sort((a,b)=>{ const x=f(a), y=f(b); return (typeof x==='string'? x.localeCompare(y): (x||0)-(y||0))*dir; });
    const pages=Math.max(1,Math.ceil(rows.length/pageSize)); page=Math.min(page,pages-1);
    tbody.innerHTML=rows.slice(page*pageSize,(page+1)*pageSize).map(render).join('')||`<tr><td colspan="${cols.length}" class="muted">No matches. Clear a filter.</td></tr>`;
    if(pager) pager.innerHTML=`<button class="btn ghost sm" type="button" data-p="-1" ${page?'':'disabled'}>Previous</button><span>Page ${page+1} of ${nfmt(pages)} \u00b7 ${nfmt(rows.length)} rows</span><button class="btn ghost sm" type="button" data-p="1" ${page<pages-1?'':'disabled'}>Next</button>`;
    thead.querySelectorAll('th').forEach(th=>{ const cc=cols.find(x=>x.k===th.dataset.k); if(cc) th.innerHTML=cc.h+(cc.k===key?(dir<0?' \u2193':' \u2191'):''); }); }
  function sortBy(k){ if(!k) return; if(key===k) dir=-dir; else { key=k; const col=cols.find(c=>c.k===key); dir=col&&col.asc?1:-1; } page=0; go(); }
  thead.addEventListener('click',e=>{ const th=e.target.closest('th'); if(!th||!th.dataset.k) return; sortBy(th.dataset.k); });
  if(pager) pager.addEventListener('click',e=>{ const b=e.target.closest('[data-p]'); if(b){ page+=+b.dataset.p; go(); tbl.scrollIntoView({block:'nearest'}); } });
  return {go, reset:()=>{page=0; go();}, step(d){ page+=d; go(); }, sortBy};
}
const confCell=c=>{ const C=CONF[c]||CONF[3]; return `<span class="pill c-${C[0]==='X'?'L':C[0]}">${C[1]}</span>`; };
const TCOLS={
  land:[['res','Land $/sq ft'],['acre','$/acre'],['lsh','Land share'],['farm','Farmland $/acre']],
  bld:[['hvlo','Entry-level'],['hv','Typical home'],['hvhi','Upper-end'],['str','Structure'],['bcost','Build $/sq ft']],
  rent:[['rent1','1-bed'],['rent2','2-bed'],['rent3','3-bed'],['rent4','4-bed'],['yld','Yield']]
};
const HEADCOL={land:0,bld:1,rent:1};
let TBL=null, lT=null, stT=null, eT=null;
function tables(){
  // State medians are in the summary, so that table is live immediately. County, place and
  // evidence rows are already in the HTML; their files load the first time someone sorts,
  // filters, pages, or switches the land / home / rent tabs.
  for(const s of [...ST].sort((a,b)=>SC[a.c].localeCompare(SC[b.c]))){ $('lst').insertAdjacentHTML('beforeend',`<option value="${s.c}">${esc(SC[s.c])}</option>`); $('pst').insertAdjacentHTML('beforeend',`<option value="${s.c}">${esc(SC[s.c])}</option>`); $('est').insertAdjacentHTML('beforeend',`<option value="${s.c}">${esc(SC[s.c])}</option>`); }
  $('stable').addEventListener('click',e=>{ const tr=e.target.closest('tr[data-go]'); if(tr){ selectState(tr.dataset.go.slice(2)); $('mapsec').scrollIntoView(); } });
  $('ltable').addEventListener('click',e=>{ const b=e.target.closest('[data-lga]'); if(b){ selectLGA(+b.dataset.lga); $('mapsec').scrollIntoView(); } });
  $('ptable').addEventListener('click',e=>{ const b=e.target.closest('[data-place]'); if(b){ selectPlace(+b.dataset.place); $('mapsec').scrollIntoView(); } });
  $('etable').addEventListener('click',e=>{ const b=e.target.closest('[data-at]'); if(b){ const [a,c]=b.dataset.at.split(',').map(Number); pickSpot(a,c,true); $('mapsec').scrollIntoView(); } });
  const lrows=()=>{ const q=norm($('lq').value), s=$('lst').value, c=$('lcl').value; return LG.map((g,i)=>({...g,i})).filter(g=>(!s||g.s===s)&&(!c||g.cls===c)&&(!q||norm(g.n+' '+SC[g.s]).includes(q))); };
  const colsNow=()=>{ const tc=TCOLS[TAB], hc=HEADCOL[TAB]; return {tc, hc, vc:tc.map(([k,h],n)=>({k,h,r:1,def:n===hc?1:0,val:r=>r.v[k]})), cells:v=>tc.map(([k],n)=>`<td class="r num">${n===hc?'<b>':''}${fmtL(k,v[k])}${n===hc?'</b>':''}</td>`).join('')}; };
  function renderState(){
    const {vc, cells}=colsNow();
    $('stabT').textContent=`${TABS[TAB].name}: state medians across census tracts.`;
    stT=sortable($('stable'),[{k:'c',h:'Code',asc:true},{k:'name',h:'State',asc:true,val:r=>SC[r.c]},{k:'big',h:'Largest city',asc:true}].concat(vc).concat(TAB==='land'?[{k:'resR',h:'Rural land $/sq ft',r:1,val:r=>r.v.resR}]:[]).concat([{k:'nc',h:'Counties',r:1},{k:'conf',h:'Conf.',val:r=>-r.conf}]),
      ()=>[...ST],r=>`<tr data-go="s:${r.c}" style="cursor:pointer"><td class="code mono">${r.c}</td><td class="nm">${esc(SC[r.c])}</td><td>${esc(r.big)}</td>${cells(r.v)}${TAB==='land'?`<td class="r num">${short(r.v.resR)}</td>`:''}<td class="r num">${r.nc}</td><td>${confCell(r.conf)}</td></tr>`,null,60);
    stT.go();
  }
  function renderCounties(){
    const {vc, cells}=colsNow();
    lT=sortable($('ltable'),[{k:'n',h:'County',asc:true},{k:'s',h:'State',asc:true},{k:'cls',h:'Setting',asc:true}].concat(vc).concat(TAB==='land'?[{k:'range',h:'Rural \u2192 core',r:1,val:r=>r.v.hi}]:[]).concat([{k:'np',h:'Places',r:1},{k:'nt',h:'Tracts',r:1},{k:'conf',h:'Conf.',val:r=>-r.conf},{k:'x',h:'',sort:false}]),
      lrows,g=>`<tr><td class="nm">${esc(g.n)}<small>${g.cb?esc(g.cb)+' \u00b7 ':''}${nfmt(g.mi2)} sq mi</small></td><td class="mono">${g.s}</td><td class="small">${g.cls}</td>${cells(g.v)}${TAB==='land'?`<td class="r num">${short(g.v.lo)} \u2013 ${short(g.v.hi)}</td>`:''}<td class="r num">${nfmt(g.np)}</td><td class="r num">${g.nt}</td><td>${confCell(g.conf)}</td><td><button class="linkbtn" type="button" data-lga="${g.i}">Map</button></td></tr>`,$('lpager'));
    lT.go();
  }
  let countyJob=null;
  function ensureCounties(){ if(!countyJob) countyJob=loadAllCountyValues(); return countyJob.then(()=>renderCounties()); }
  ['lq','lst','lcl'].forEach(id=>$(id).addEventListener('input',()=>{ ensureCounties().then(()=>lT.reset()); }));
  $('lpager').addEventListener('click',e=>{ const b=e.target.closest('[data-p]'); if(!b||lT) return; const dir=+b.dataset.p; ensureCounties().then(()=>lT.step(dir)); });
  $('ltable').querySelector('thead').addEventListener('click',e=>{ const th=e.target.closest('th'); if(!th||!th.dataset.k||lT) return; const k=th.dataset.k; ensureCounties().then(()=>lT.sortBy(k)); });
  const pT={page:0}; let placesReady=false, placeJob=null;
  function prender(){
    if(!PL||!placesReady) return;
    const q=norm($('pq').value), s=$('pst').value, ty=$('pty').value, so=$('psort').value, hk=TABS[TAB].head;
    const out=[]; const n=PL.n.length;
    for(let j=0;j<n;j++){ if(!PL.ok[j]) continue; if(s&&LG[PL.g[j]].s!==s) continue; if(ty!==''&&PL.t[j]!==+ty) continue; if(q&&!(SIDX[j]||'').includes(q)) continue; out.push(j); }
    const sv=hk==='res'?(j=>PL.v[j]):hk==='hv'?(j=>PL.h[j]):(j=>pval(j,hk)||0);
    if(so==='v') out.sort((a,b)=>sv(b)-sv(a)); else if(so==='l') out.sort((a,b)=>sv(a)-sv(b)); else out.sort((a,b)=>PL.n[a].localeCompare(PL.n[b]));
    const ps=50, pages=Math.max(1,Math.ceil(out.length/ps)); pT.page=Math.min(Math.max(0,pT.page),pages-1);
    const PC={land:[['res','Land $/sq ft'],['qlot','Quarter-acre lot']],bld:[['hv','Typical home'],['hvlo','Entry-level']],rent:[['rent2','Rent 2-bed'],['rent3','Rent 3-bed']]}[TAB];
    $('ptable').querySelector('thead').innerHTML=`<tr><th data-k="">Place</th><th data-k="">Level</th><th data-k="">Within \u00b7 County</th><th data-k="">State</th>${PC.map(([,h])=>`<th data-k="" class="r">${h}</th>`).join('')}<th data-k="">Tier</th><th data-k="">Conf.</th><th data-k=""></th></tr>`;
    $('ptable').querySelector('tbody').innerHTML=out.slice(pT.page*ps,(pT.page+1)*ps).map(j=>{ const g=LG[PL.g[j]], v=placeVals(j); const within=PL.pa[j]>=0?PL.n[PL.pa[j]]:'';
      return `<tr><td class="nm"><button class="linkbtn" style="font-size:inherit;font-weight:600;text-decoration:none;color:var(--ink)" type="button" data-place="${j}">${esc(PL.n[j])}</button></td><td class="small"><span class="tag ${URBAN_T.has(PL.t[j])?'u':''}">${TYPEN[PL.t[j]]}</span></td><td class="small">${within?esc(within)+' \u00b7 ':''}${esc(g.n)}</td><td class="mono">${g.s}</td>${PC.map(([k],n)=>`<td class="r num">${n===1?'':'<b>'}${k==='qlot'?short(v.res*QLOT):fmtL(k,v[k])}${n===1?'':'</b>'}</td>`).join('')}<td class="small"><span class="zdot" style="background:${ZONEC[PL.z[j]]}"></span>${esc((META.zones||[])[PL.z[j]]||'')}</td><td>${confCell(PL.c[j])}</td><td><button class="linkbtn" type="button" data-place="${j}">Map</button></td></tr>`; }).join('')||'<tr><td colspan="10" class="muted">No places match.</td></tr>';
    $('ppager').innerHTML=`<button class="btn ghost sm" type="button" data-p="-1" ${pT.page?'':'disabled'}>Previous</button><span>Page ${pT.page+1} of ${nfmt(pages)} \u00b7 ${nfmt(out.length)} places</span><button class="btn ghost sm" type="button" data-p="1" ${pT.page<pages-1?'':'disabled'}>Next</button>`;
  }
  function ensurePlaces(){ if(!placeJob) placeJob=loadAllPlaces().then(()=>{ placesReady=true; }); return placeJob; }
  let pt=0; ['pq','pst','pty','psort'].forEach(id=>$(id).addEventListener('input',()=>{ clearTimeout(pt); pt=setTimeout(()=>{ ensurePlaces().then(()=>{ pT.page=0; prender(); }); },150); }));
  $('ppager').addEventListener('click',e=>{ const b=e.target.closest('[data-p]'); if(!b) return; const dir=+b.dataset.p; const run=()=>{ pT.page+=dir; prender(); }; if(!placesReady) ensurePlaces().then(()=>{ pT.page=0; run(); }); else run(); });
  function renderEvidence(){
    eT=sortable($('etable'),[
      {k:'z',h:'ZIP code',asc:true,val:r=>r[0]},{k:'pl',h:'Place',asc:true,val:r=>r[1]},{k:'st',h:'State',asc:true,val:r=>r[6]},{k:'acre',h:'Per acre (published)',r:1,def:1,val:r=>r[4]},{k:'sf',h:'Per sq ft',r:1,val:r=>r[4]},{k:'yr',h:'Price level',r:1,val:r=>r[5]},{k:'x',h:'',sort:false}
    ],()=>{ const q=norm($('eq').value), s=$('est').value; return EV.filter(e=>(!s||e[6]===s)&&(!q||e[0].startsWith(q)||norm(e[1]).includes(q))); },
    e=>`<tr><td class="mono">${esc(e[0])}</td><td class="nm">${esc(e[1])}</td><td class="mono">${e[6]}</td><td class="r num"><b>${short(e[4])}</b></td><td class="r num">${short(e[4]/SQFT_ACRE)}</td><td class="r num">${e[5]}</td><td><button class="linkbtn" type="button" data-at="${e[2]},${e[3]}">Map</button></td></tr>`,$('epager'));
    eT.go();
  }
  let evJob=null;
  function ensureEvidence(){ if(!evJob) evJob=loadAllEvidence().then(()=>renderEvidence()); return evJob; }
  ['est','eq'].forEach(id=>$(id).addEventListener('input',()=>ensureEvidence().then(()=>eT.reset())));
  $('epager').addEventListener('click',e=>{ const b=e.target.closest('[data-p]'); if(!b||eT) return; const dir=+b.dataset.p; ensureEvidence().then(()=>eT.step(dir)); });
  $('etable').querySelector('thead').addEventListener('click',e=>{ const th=e.target.closest('th'); if(!th||!th.dataset.k||eT) return; const k=th.dataset.k; ensureEvidence().then(()=>eT.sortBy(k)); });
  TBL=()=>{
    renderState();
    if(!$('tabs').dataset.ready) return;
    ensureCounties();
    ensurePlaces().then(()=>{ pT.page=0; prender(); });
    ensureEvidence();
  };
  renderState();
}

/* ---------- estimator: land + building + rent ---------- */
const nv=id=>parseFloat($(id).value)||0;
function lotSqft(){ const n=Math.max(0,nv('e_size')); return $('e_unit').value==='ac'?n*SQFT_ACRE:n; }
function estimate(){
  if(!SEL){ return; }
  $('e_loc').innerHTML=`<b>${esc(SEL.name)}</b> <span class="muted">(${(CONF[SEL.conf]||CONF[3])[1].toLowerCase()} confidence)</span>`;
  const use=$('e_use').value, v=SEL.v, sq=lotSqft();
  // residential: $/sq ft falls for big lots (a 1-acre lot is not 4x a quarter acre); farmland: per acre
  let land, rate;
  if(use==='farm'){ rate=(v.farm||v.res*SQFT_ACRE*0.15)/SQFT_ACRE; land=rate*sq; }
  else { const k=Math.pow(Math.max(sq,500)/QLOT,-0.35); rate=v.res*Math.min(1.6,k); land=rate*sq; }
  const adj=nv('e_shape')*nv('e_road')*nv('e_zone'); land=Math.round(land*adj/100)*100;
  const bf=nv('e_bld'); const gfa=bf?Math.max(0,nv('e_gfa')):0;
  const bc=v.bcost||(META.build||{})[regionOf(SEL.st)]||180;
  const newc=Math.round(bc*gfa*bf*nv('e_fin')/100)*100; const dep=Math.min(0.6,0.0125*Math.max(0,nv('e_age'))); const depAmt=Math.round(newc*dep/100)*100; const bld=newc-depAmt, total=land+bld;
  const band=[0.12,0.2,0.3,0.4][SEL.conf]??0.4;
  const beds=+$('e_beds').value; const rk='rent'+Math.max(1,Math.min(4,beds));
  const rent=!bf?null:Math.round((v[rk]||0)*Math.pow(nv('e_fin'),0.5)*(1-dep*0.4)/5)*5;
  const S=(id,x)=>$(id).textContent=x;
  S('o_total',fmt(total)); S('o_range',`Likely range ${short(total*(1-band))} to ${short(total*(1+band))}`);
  S('o_rate','$'+(rate*adj).toFixed(2)); S('o_adj','\u00d7 '+adj.toFixed(3)); S('o_land',fmt(land)); S('o_new',fmt(newc)); S('o_dep',depAmt?'\u2212 '+fmt(depAmt)+` (${Math.round(dep*100)}%)`:'\u2013'); S('o_bld',fmt(bld));
  S('o_rent',rent?fmt(rent)+' a month':'\u2013'); S('o_yield',rent&&total?(100*12*rent/total).toFixed(1)+'% gross':'\u2013');
  S('o_bc','$'+Math.round(bc)+'/sq ft ('+REGN[regionOf(SEL.st)]+')');
  ['e_gfa','e_fin','e_age','e_beds'].forEach(id=>$(id).disabled=!bf);
}
$('ef').addEventListener('input',estimate);

/* ---------- method ---------- */
function method(){
  const m=META, s=m.src||{};
  $('methodcols').innerHTML=`
  <div><h3>The data</h3><p>Every figure comes from public US government data, brought up to ${dlong(m.date)}:</p>
  <ul><li>Land: FHFA residential land prices for ${nfmt(m.counts.landTracts)} census tracts, ${nfmt(m.counts.landZips)} ZIP codes and ${nfmt(m.counts.landCounties)} counties (${esc(s.fhfaYear||'latest')} data)</li>
  <li>Home values: Census American Community Survey ${esc(s.acs||'')} 5-year estimates for ${nfmt(m.counts.tracts)} tracts</li>
  <li>Rents: HUD Fair Market Rents FY${esc(s.fmr||'')}, by county and ZIP code</li>
  <li>Price trend since the survey: FHFA House Price Index (${esc(s.hpi||'latest')})</li>
  <li>Farmland: USDA NASS land values ${esc(s.nass||'')}</li><li>Build cost: Census Survey of Construction ${esc(s.soc||'')}</li></ul></div>
  <div><h3>The model</h3><p>Each census tract gets its own land value per square foot (from FHFA's tract, ZIP or county figure, in that order), its median, entry-level and upper-end home value, and rents by bedroom (HUD's ZIP or county Fair Market Rent, adjusted for how the tract's survey rents compare with its county). Survey values are moved forward to today with the county's FHFA price index. Where a tract has too few survey answers, the neighboring tracts fill the gap. Any spot on the map is a distance-weighted blend of the nearest tracts; every city, town, ZIP code, neighborhood and subdivision (${nfmt(PL.n.length)} places) is valued the same way.</p>
  <p style="margin-top:8px"><b>Price tiers.</b> Within each metro area, tracts are ranked by typical home value: Top tier (top 10%), Upper (next 25%), Mid (middle 35%) and Entry (lowest 30%). Outside metro areas, tracts are Small town, Rural or Farmland by how built-up they are. The tiers describe prices only and say nothing about who lives there. Land check: ${m.fit?`the model's land value is within a factor of 2 of FHFA's published ZIP figure for ${m.fit.within2}% of ZIP codes held out of the fit`:'see the About page'}.</p></div>
  <div><h3>Reading the values</h3><ul>
   <li><span class="pill c-H">High</span> FHFA land price for the tract itself.</li><li><span class="pill c-M">Medium</span> land from the ZIP code or county.</li><li><span class="pill c-L">Low</span> some values filled from neighbors.</li><li><span class="pill c-L">Modelled</span> no survey data for the tract.</li></ul>
   <p style="margin-top:8px">Land values are for residential land on a standard quarter-acre lot; small lots sell for more per square foot and large tracts for less. Home values are what owners report to the Census, indexed forward. Rents are gross rents (including utilities) a month. Gross yield is a year's 2-bedroom rent over the typical home value. These are indicative figures, not an appraisal: for lending, a tax appeal or legal use, hire a state-licensed or certified appraiser.</p>
   <p style="margin-top:8px">Sources: <a href="https://www.fhfa.gov/research/papers/wp1901" target="_blank" rel="noopener">FHFA land prices</a> (Davis, Larson, Oliner and Shui), <a href="https://www.fhfa.gov/data/hpi" target="_blank" rel="noopener">FHFA HPI</a>, <a href="https://www.census.gov/programs-surveys/acs" target="_blank" rel="noopener">Census ACS</a>, <a href="https://www.huduser.gov/portal/datasets/fmr.html" target="_blank" rel="noopener">HUD Fair Market Rents</a>, <a href="https://www.nass.usda.gov/" target="_blank" rel="noopener">USDA NASS</a>, <a href="https://www.census.gov/construction/chars/" target="_blank" rel="noopener">Census Survey of Construction</a>, <a href="https://www.census.gov/geographies/reference-files/time-series/geo/gazetteer-files.html" target="_blank" rel="noopener">Census Gazetteer and boundaries</a>, <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>, <a href="https://www.mapbox.com" target="_blank" rel="noopener">Mapbox</a>. This product uses the Census Bureau Data API but is not endorsed or certified by the Census Bureau.</p></div>`;
}

/* ---------- helpers ---------- */
const MONTHS=['January','February','March','April','May','June','July','August','September','October','November','December'];
function dlong(iso){ const d=new Date((iso||'')+'T12:00:00'); return isNaN(d)?String(iso||''):MONTHS[d.getMonth()]+' '+d.getDate()+', '+d.getFullYear(); }
const slug=s=>norm(s).replace(/ /g,'-');
let LGR=null;
function ringsOf(i){ if(!LGR) LGR=LG.map(g=>{ if(!g.r) return {rs:[],bb:[1e9,1e9,-1e9,-1e9]}; const rs=g.r.map(decode); let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9; for(const r of rs) for(const [x,y] of r){ if(x<x0)x0=x; if(x>x1)x1=x; if(y<y0)y0=y; if(y>y1)y1=y; } return {rs,bb:[x0,y0,x1,y1]}; }); return LGR[i]; }
function pipRing(x,y,r){ let c=false; for(let a=0,b=r.length-1;a<r.length;b=a++){ const [xi,yi]=r[a],[xj,yj]=r[b]; if(((yi>y)!==(yj>y))&&(x<(xj-xi)*(y-yi)/(yj-yi)+xi)) c=!c; } return c; }
let lastC=null;
function lgaContaining(lat,lng,quick){
  const key=lat.toFixed(3)+','+lng.toFixed(3); if(lastC&&lastC[0]===key) return lastC[1];
  let best=-1;
  for(let i=0;i<LG.length;i++){ const o=ringsOf(i), b=o.bb; if(lng<b[0]||lng>b[2]||lat<b[1]||lat>b[3]) continue; let n=0; for(const r of o.rs) if(pipRing(lng,lat,r)) n++; if(n%2===1){ best=i; break; } if(n) best=i; }
  if(best<0&&!quick){ let d0=12; for(let i=0;i<LG.length;i++){ const d=km(lat,lng,LG[i].lat,LG[i].lng); if(d<d0){d0=d;best=i;} } }
  lastC=[key,best]; return best;
}
function pickSpot(lat,lng,fly){
  if(!inUS(lat,lng)) return false;
  const go=()=>{ const i=lgaContaining(lat,lng); if(i<0) return false; if(fly) whenMap(()=>MAPI.flyPlace(lat,lng,4)); selectPoint(lat,lng,i); return true; };
  if(!areaReady(lat,lng)){ $('panel').innerHTML='<div class="loading">Loading census tracts and places\u2026</div>'; loadArea(lat,lng).then(()=>go()); return true; }
  return go();
}

/* ---------- ZIP code at the exact spot (Census ZCTA shapes, loaded by area) ---------- */
const zipTiles=new Map();
function zipTile(lat,lng){ const k=(Math.floor(lat/2)*2)+'_'+(Math.floor(lng/2)*2); if(!zipTiles.has(k)) zipTiles.set(k,fetch('data/zip/'+k+'.json').then(r=>r.ok?r.json():{z:[],r:[]}).catch(()=>({z:[],r:[]}))); return zipTiles.get(k); }
async function zipAt(lat,lng){
  const t=await zipTile(lat,lng); let best=null, bd=1e9;
  for(let i=0;i<t.z.length;i++){ const rs=t.r[i].map(decode); let n=0; for(const r of rs) if(pipRing(lng,lat,r)) n++; if(n%2===1) return {zip:t.z[i],inside:true}; }
  for(let i=0;i<t.z.length;i++){ const c=t.c[i]; const d=km(lat,lng,c[1],c[0]); if(d<bd){bd=d;best=t.z[i];} }
  return best&&bd<6?{zip:best,inside:false,km:bd}:null;
}
async function zipFill(){
  const el=document.querySelector('#panel .pc'); if(!el) return;
  const [la,lo]=el.dataset.pc.split(',').map(Number);
  try{ const z=await zipAt(la,lo); if(!el.isConnected) return;
    if(!z){ el.innerHTML=`<p class="eyebrow">ZIP code</p><p class="note">No ZIP Code Tabulation Area here (open land, water or a ZIP with no homes). The USPS ZIP lookup at tools.usps.com has the delivery ZIP for a street address.</p>`; return; }
    const j=ZIPI.get(z.zip);
    el.innerHTML=`<p class="eyebrow">ZIP code${z.inside?'':' nearby'}</p><div class="pcode"><span class="mono">${esc(z.zip)}</span><button class="linkbtn" type="button" data-copy="${esc(z.zip)}">Copy</button>${j!=null?`<button class="linkbtn" type="button" data-place="${j}">ZIP ${esc(z.zip)} values</button>`:''}</div>
      <p class="note">${z.inside?'Census ZIP Code Tabulation Area containing this spot':'Nearest ZIP Code Tabulation Area, '+z.km.toFixed(1)+' km away'}. ZCTAs follow USPS ZIP codes closely; for mail, confirm the address with USPS.</p>`;
  }catch(err){ if(el.isConnected) el.innerHTML='<p class="eyebrow">ZIP code</p><p class="note">The ZIP lookup did not load. Reload to try again.</p>'; }
}

/* ---------- Mapbox GL satellite map ---------- */
const NP=()=>window.LB_CONFIG||{};
function loadMapbox(){ return new Promise((ok,no)=>{ if(window.mapboxgl) return ok();
  const v='3.10.0', l=document.createElement('link'); l.rel='stylesheet'; l.href=`https://api.mapbox.com/mapbox-gl-js/v${v}/mapbox-gl.css`; document.head.appendChild(l);
  const s=document.createElement('script'); s.src=`https://api.mapbox.com/mapbox-gl-js/v${v}/mapbox-gl.js`; s.onload=()=>ok(); s.onerror=no; document.head.appendChild(s); }); }
function MapboxMap(){
  const c=NP(); mapboxgl.accessToken=c.mapboxToken;
  const el=$('mbmap'); el.hidden=false; canvas.hidden=true; $('mapcard').classList.add('mb'); $('basemap').hidden=false;
  const US=[[-125,24.4],[-66.8,49.5]];
  let sat=true, curLayer=null, selShown=-1, hoverShown=-1, marker=null, plTimer=0;
  const map=new mapboxgl.Map({container:el, style:c.styleSatellite||'mapbox://styles/mapbox/satellite-streets-v12', bounds:US, fitBoundsOptions:{padding:16}, maxBounds:[[-200,10],[-40,75]], projection:'mercator', attributionControl:true});
  map.addControl(new mapboxgl.NavigationControl({showCompass:false}),'bottom-right');
  const geo=new mapboxgl.GeolocateControl({positionOptions:{enableHighAccuracy:true},fitBoundsOptions:{maxZoom:17},showUserLocation:true});
  map.addControl(geo,'bottom-right'); geo.on('geolocate',p=>pickSpot(p.coords.latitude,p.coords.longitude,false));
  map.addControl(new mapboxgl.ScaleControl({unit:'imperial'}),'bottom-right');
  const LKEYS=LAYERS.map(l=>l[0]);
  const lgaFC={type:'FeatureCollection',features:LG.map((g,i)=>{ const p={i}; for(const k of LKEYS) p['k_'+k]=cls(k,g.v[k]); return {type:'Feature',id:i,properties:p,geometry:{type:'MultiPolygon',coordinates:ringsOf(i).rs.map(r=>[r])}}; })};
  const stFC={type:'FeatureCollection',features:BORDERS.map(b=>({type:'Feature',properties:{c:b.c},geometry:{type:'MultiLineString',coordinates:b.r.map(decode)}}))};
  const colr=()=>{ const e=['match',['get','k_'+layer]]; for(let i=0;i<7;i++) e.push(i,layer==='zone'?ZONEC[i]:COL.s[i]); e.push(COL.nd); return e; };
  function placesFC(){
    if(!PL) return {type:'FeatureCollection',features:[]};
    const z=map.getZoom(), b=map.getBounds(); const maxT=z<5.5?0: z<7?1: z<8.6?2: z<10.2?4: z<11.3?5: 6;
    let js=[];
    if(z<5.5){ for(let j=0;j<PL.t.length;j++) if(PL.ok[j]&&PL.t[j]===0) js.push(j); }
    else { const gx0=Math.floor(b.getWest()*5), gx1=Math.floor(b.getEast()*5), gy0=Math.floor(b.getSouth()*5), gy1=Math.floor(b.getNorth()*5);
      if((gx1-gx0+1)*(gy1-gy0+1)<9000) for(let gx=gx0;gx<=gx1;gx++) for(let gy=gy0;gy<=gy1;gy++){ const a=PIDX.get(gx+':'+gy); if(a) for(const j of a) if(DRANK[PL.t[j]]<=maxT) js.push(j); } }
    if(js.length>7000){ js.sort((a,b)=>DRANK[PL.t[a]]-DRANK[PL.t[b]]||PL.h[b]-PL.h[a]); js=js.slice(0,7000); }
    return {type:'FeatureCollection',features:js.map(j=>({type:'Feature',properties:{j,n:PL.n[j],t:DRANK[PL.t[j]],e:PL.t[j]>=8?1:0,col:colOf(layer,cls(layer,pval(j,layer)))},geometry:{type:'Point',coordinates:[PL.lo[j]/1e4,PL.la[j]/1e4]}}))};
  }
  function addLayers(){
    const halo=sat?'rgba(10,16,13,.85)':'#ffffff', ink=sat?'#ffffff':'#16201B', edge=sat?'rgba(255,255,255,.45)':'rgba(22,32,27,.3)';
    map.addSource('lga',{type:'geojson',data:lgaFC}); map.addSource('st',{type:'geojson',data:stFC}); const pfc=placesFC(); map.addSource('pl',{type:'geojson',data:pfc}); map.addSource('plL',{type:'geojson',data:pfc});
    const op=sat?['interpolate',['linear'],['zoom'],3,0.62,8,0.42,11,0.16,13.5,0]:['interpolate',['linear'],['zoom'],3,0.8,9,0.5,12,0.22,14,0.08];
    map.addLayer({id:'lga-fill',type:'fill',source:'lga',paint:{'fill-color':colr(),'fill-opacity':op}});
    map.addLayer({id:'lga-edge',type:'line',source:'lga',paint:{'line-color':edge,'line-width':['interpolate',['linear'],['zoom'],3,0.15,6,0.5,10,1]}});
    map.addLayer({id:'lga-hi',type:'line',source:'lga',paint:{'line-color':COL.pin,'line-width':['case',['boolean',['feature-state','sel'],false],3.2,['boolean',['feature-state','hover'],false],1.8,0],'line-opacity':['case',['boolean',['feature-state','sel'],false],1,['boolean',['feature-state','hover'],false],0.9,0]}});
    map.addLayer({id:'st-line',type:'line',source:'st',paint:{'line-color':sat?'#ffffff':'#3f4b44','line-width':['interpolate',['linear'],['zoom'],3,0.8,10,2.2],'line-opacity':0.85}});
    map.addLayer({id:'st-sel',type:'line',source:'st',filter:['==',['get','c'],selState||''],paint:{'line-color':COL.pin,'line-width':3.4}});
    map.addLayer({id:'pl-dot',type:'circle',source:'pl',paint:{'circle-color':['get','col'],
      'circle-radius':['interpolate',['linear'],['zoom'],4,['match',['get','t'],0,3.5,1,2.5,2],12,['match',['get','t'],0,8,1,7,2,6,3,5.5,4,5,4.5],16,['match',['get','t'],0,10,1,9,2,8,6.5]],
      'circle-stroke-color':['case',['==',['get','e'],1],COL.pin,sat?'#ffffff':'#16201B'],'circle-stroke-width':['match',['get','t'],0,1.6,1,1.4,1],'circle-opacity':['interpolate',['linear'],['zoom'],14,1,17,0.55]}});
    map.addLayer({id:'pl-lab',type:'symbol',source:'plL',layout:{'text-field':['get','n'],'text-font':['DIN Pro Medium','Arial Unicode MS Regular'],'text-size':['match',['get','t'],0,14,1,13,2,12.5,11.5],
      'text-variable-anchor':['left','right','top','bottom'],'text-radial-offset':0.7,'text-justify':'auto','symbol-sort-key':['+',['*',['get','t'],10],['*',['get','e'],-5]],'text-optional':true,'text-max-width':10},
      paint:{'text-color':ink,'text-halo-color':halo,'text-halo-width':1.6}});
    curLayer=layer; selShown=-1; hoverShown=-1; api.refresh();
  }
  map.on('style.load',addLayers);
  map.on('moveend',()=>{ clearTimeout(plTimer); plTimer=setTimeout(()=>{
    const apply=()=>{ const s=map.getSource('pl'), sL=map.getSource('plL'); if(s){ const d=placesFC(); s.setData(d); if(sL) sL.setData(d); } };
    if(map.getZoom()>=5.5){ const b=map.getBounds(); scheduleVisiblePlaces(b.getWest(),b.getSouth(),b.getEast(),b.getNorth(),apply); }
    else apply();
  },60); });
  const setHover=i=>{ if(i===hoverShown) return; if(hoverShown>=0) map.setFeatureState({source:'lga',id:hoverShown},{hover:false}); hoverShown=i; if(i>=0) map.setFeatureState({source:'lga',id:i},{hover:true}); };
  const box=p=>[[p.x-6,p.y-6],[p.x+6,p.y+6]];
  map.on('mousemove',e=>{
    const f=map.getLayer('pl-dot')?map.queryRenderedFeatures(box(e.point),{layers:['pl-dot']})[0]:null;
    const r=el.getBoundingClientRect(); const i=f?PL.g[f.properties.j]:lgaContaining(e.lngLat.lat,e.lngLat.lng,true);
    setHover(i);
    if(f){ tip.innerHTML=tipPlace(f.properties.j); el.style.cursor='pointer'; }
    else if(i>=0){ tip.innerHTML=tipLGA(i); el.style.cursor='crosshair'; }
    if(i>=0||f){ tip.hidden=false; let x=e.point.x+14, y=e.point.y+12; if(x>r.width-250) x=e.point.x-250; if(y>r.height-100) y=e.point.y-90; tip.style.left=x+'px'; tip.style.top=y+'px'; } else tip.hidden=true;
  });
  map.on('mouseout',()=>{ tip.hidden=true; setHover(-1); });
  map.on('movestart',()=>{ tip.hidden=true; });
  map.on('click',e=>{ const f=map.queryRenderedFeatures(box(e.point),{layers:['pl-dot']})[0];
    if(f&&map.getZoom()<15.5){ selectPlace(f.properties.j,false); return; }
    pickSpot(e.lngLat.lat,e.lngLat.lng,false); });
  function setBase(s){ if(s===sat) return; sat=s; [...$('basemap').children].forEach(b=>b.setAttribute('aria-pressed',(b.dataset.b==='sat')===sat)); map.setStyle(sat?(c.styleSatellite||'mapbox://styles/mapbox/satellite-streets-v12'):(c.styleStreets||'mapbox://styles/mapbox/light-v11'),{diff:false}); }
  $('basemap').addEventListener('click',e=>{ const b=e.target.closest('button'); if(b) setBase(b.dataset.b==='sat'); });
  const whenReady=f=>{ if(map.loaded()) f(); else { f(); map.once('load',f); } };
  const api={ kind:'mapbox', map,
    refresh(){ if(!map.isStyleLoaded()||!map.getLayer('lga-fill')) return;
      if(curLayer!==layer){ map.setPaintProperty('lga-fill','fill-color',colr()); curLayer=layer; const d=placesFC(); map.getSource('pl').setData(d); map.getSource('plL').setData(d); }
      if(selShown!==selL){ if(selShown>=0) map.setFeatureState({source:'lga',id:selShown},{sel:false}); if(selL>=0) map.setFeatureState({source:'lga',id:selL},{sel:true}); selShown=selL; }
      map.setFilter('st-sel',['==',['get','c'],selState||'']);
      if(selPt){ if(!marker) marker=new mapboxgl.Marker({color:COL.pin}); marker.setLngLat([selPt[1],selPt[0]]).addTo(map); } else if(marker) marker.remove(); },
    fitAll(){ whenReady(()=>map.fitBounds(US,{padding:16})); },
    fitLL(a,b,c2,d){ whenReady(()=>map.fitBounds([[b,a],[d,c2]],{padding:30,maxZoom:13})); },
    fitLGA(i){ const [a,b,c2,d]=lgaBox(i); whenReady(()=>map.fitBounds([[b,a],[d,c2]],{padding:30,maxZoom:13})); },
    flyPlace(la,lo,t){ const o={center:[lo,la],zoom:Math.max(map.getZoom(),t<=1?11:14)}; if(map.loaded()) map.flyTo({...o,essential:true}); else map.jumpTo(o); },
    zoom(f){ f>1?map.zoomIn():map.zoomOut(); },
    sat(la,lo){ setBase(true); map.flyTo({center:[lo,la],zoom:18,essential:true}); $('mapsec').scrollIntoView({block:'start'}); } };
  return api;
}

/* ---------- deep links: #state=TX  #county=48453  #zip=78701  #at=30.27,-97.74 ---------- */
function route(){
  const h=decodeURIComponent(location.hash.slice(1)); if(!h) return false; const [k,v]=h.split('=');
  if(k==='state'&&v&&STI[v.toUpperCase()]!=null){ selectState(v.toUpperCase()); return true; }
  if(k==='county'&&v){ const i=LG.findIndex(g=>g.f===v||(g.s+'/'+slug(g.n))===v); if(i>=0){ selectLGA(i); return true; } }
  if(k==='zip'&&v){
    loadZipIndex().then(()=>{ const pair=ZIPMETA&&ZIPMETA[v]; if(!pair) return; const j=pair[0]; loadPlacesState(LG[pair[1]].s).then(()=>selectPlace(j)); });
    return true;
  }
  if(k==='at'&&v){ const [a,b]=v.split(',').map(Number); if(isFinite(a)&&isFinite(b)) return pickSpot(a,b,true); }
  return false;
}

/* ---------- shared into the installed app (Android share sheet): a map link or coordinates opens on that spot ---------- */
function shared(){
  const u=new URLSearchParams(location.search); const txt=[u.get('su'),u.get('stx'),u.get('st')].filter(Boolean).join(' '); if(!txt) return false;
  history.replaceState(null,'',location.pathname+location.hash);
  const p=parseSpot(txt)||(txt.match(/https?:\/\/\S+/g)||[]).map(parseSpot).find(Boolean);
  if(p&&pickSpot(p[0],p[1],true)){ history.replaceState(null,'','#at='+p[0].toFixed(5)+','+p[1].toFixed(5)); $('mapsec').scrollIntoView({block:'start'}); return true; }
  $('pinq').value=txt.slice(0,300); $('pinmsg').textContent='No coordinates found in what was shared. In Google Maps, drop a pin and share that pin, or paste the coordinates here.'; $('pinform').scrollIntoView({block:'center'}); return false;
}

/* ---------- map loads when it scrolls into view or Show map is tapped ---------- */
function whenMap(fn){ if(mapReady) fn(); else { pendingMap.push(fn); requestMap(); } }
function requestMap(){
  if(mapPromise) return mapPromise;
  const hold=$('maphold');
  const btn=hold&&hold.querySelector('button');
  if(btn) btn.textContent='Loading the map\u2026';
  mapPromise=(async()=>{
    await summaryPromise;
    await Promise.all([loadAllGeom(), loadAllCountyValues(), loadCities()]);
    buildPaths(); computeBreaks(); legend();
    let usedBox=false;
    if(NP().mapboxToken){
      try{
        await loadMapbox();
        if(mapboxgl.supported&&!mapboxgl.supported()) throw new Error('WebGL unavailable');
        MAPI=MapboxMap(); usedBox=true;
      }catch(err){ console.warn('Mapbox unavailable, using the plain map', err); MAPI=CANVAS_MAP; }
    }
    if(!usedBox){
      $('mbmap').hidden=true; canvas.hidden=false;
      if(hold) hold.hidden=true;
      resize(); fitAll();
      if(!canvas._ro){ canvas._ro=1; new ResizeObserver(()=>resize()).observe(canvas); }
    } else if(hold) hold.hidden=true;
    mapReady=true;
    pendingMap.splice(0).forEach(fn=>{ try{ fn(); }catch(err){ console.error(err); } });
    if(MAPI.kind==='mapbox') MAPI.refresh();
  })().catch(err=>{
    console.error(err); mapPromise=null;
    if(btn) btn.textContent='Show map';
    $('panel').insertAdjacentHTML('beforeend','<p class="note">The map did not load. Reload the page to try again.</p>');
  });
  return mapPromise;
}
function armMap(){
  const el=$('mapcard'); if(!el) return;
  const go=()=>requestMap();
  if('IntersectionObserver' in window){
    const io=new IntersectionObserver(es=>{ if(es.some(e=>e.isIntersecting)){ io.disconnect(); go(); } },{threshold:0.2});
    io.observe(el);
  }
  const b=$('showmap'); if(b) b.addEventListener('click',go);
}

/* ---------- boot ---------- */
(async()=>{
  readColors();
  buildLayers();
  summaryPromise=loadSummary();
  armMap();
  try{ await summaryPromise; }catch(err){ console.error(err); $('panel').innerHTML='<p class="note">The data files did not load. Reload the page to try again.</p>'; return; }
  $('edDate').textContent=dlong(META.date); $('sDate').textContent=dlong(META.date);
  document.querySelectorAll('.evDate').forEach(e=>e.textContent=dlong(META.date));
  $('sCounties').textContent=nfmt(LG.length); $('hCounties').textContent=nfmt(LG.length); $('sTracts').textContent=nfmt(META.counts.tracts); $('sPlaces').textContent=nfmt(META.counts.places); $('hPlaces').textContent=nfmt(META.counts.places); $('sZips').textContent=nfmt(META.counts.zipPlaces||META.counts.zips); $('sEv').textContent=nfmt(META.counts.evidence||EV.length);
  const h0=location.hash;
  if(!h0||!route()) nationalPanel();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change',()=>{readColors(); MAPI.refresh();});
  new MutationObserver(()=>{readColors(); MAPI.refresh();}).observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
  if(!shared()&&!h0&&RER) RER();
  window.addEventListener('hashchange',route);
  if(qi.value) showSugg();
  tables(); method();
  dispatchEvent(new Event('usvb-ready'));
})();
