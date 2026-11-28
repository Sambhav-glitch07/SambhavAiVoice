import * as THREE from 'three';
import { createClient } from '@supabase/supabase-js';
import { Live } from './live.js';
const NOISE=`
vec3 mod289(vec3 x){return x-floor(x*(1./289.))*289.;}
vec4 mod289(vec4 x){return x-floor(x*(1./289.))*289.;}
vec4 permute(vec4 x){return mod289(((x*34.)+1.)*x);}
float snoise(vec3 v){const vec3 C=vec3(1./6.,1./3.,0.);const vec4 D=vec4(0.,.5,1.,2.);
vec3 i=floor(v+dot(v,C.yyy));vec3 x0=v-i+dot(i,C.xxx);vec3 g=step(x0.yzx,x0.xyz);vec3 l=1.-g;
vec3 i1=min(g.xyz,l.zxy);vec3 i2=max(g.xyz,l.zxy);vec3 x1=x0-i1+C.xxx;vec3 x2=x0-i2+C.yyy;vec3 x3=x0-D.yyy;
i=mod289(i);vec4 p=permute(permute(permute(i.z+vec4(0.,i1.z,i2.z,1.))+i.y+vec4(0.,i1.y,i2.y,1.))+i.x+vec4(0.,i1.x,i2.x,1.));
vec3 ns=.142857142857*D.wyz-D.xzx;vec4 j=p-49.*floor(p*ns.z*ns.z);vec4 x_=floor(j*ns.z);vec4 y_=floor(j-7.*x_);
vec4 x=x_*ns.x+ns.yyyy;vec4 y=y_*ns.x+ns.yyyy;vec4 h=1.-abs(x)-abs(y);vec4 b0=vec4(x.xy,y.xy);vec4 b1=vec4(x.zw,y.zw);
vec4 s0=floor(b0)*2.+1.;vec4 s1=floor(b1)*2.+1.;vec4 sh=-step(h,vec4(0.));
vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
vec3 p0=vec3(a0.xy,h.x);vec3 p1=vec3(a0.zw,h.y);vec3 p2=vec3(a1.xy,h.z);vec3 p3=vec3(a1.zw,h.w);
vec4 nr=1.79284291400159-.85373472095314*vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3));
p0*=nr.x;p1*=nr.y;p2*=nr.z;p3*=nr.w;
vec4 m=max(.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.);m=m*m;
return 42.*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));}`;
const VERT=NOISE+`
uniform float uTime,uAmp,uBass;varying vec3 vN,vV,vObj;
float disp(vec3 p){float t=uTime;
 float n=snoise(p*1.1+vec3(0.,t*.18,t*.1))*.55+snoise(p*2.3-vec3(t*.22,0.,t*.15))*.25;
 n+=uBass*snoise(p*3.2+vec3(t*1.1))*.3;
 return n*(.035+uAmp*.15);}
void main(){
 vec3 n=normalize(position);vec3 up=abs(n.y)>.99?vec3(1.,0.,0.):vec3(0.,1.,0.);
 vec3 t1=normalize(cross(n,up));vec3 t2=cross(n,t1);float e=.02;
 vec3 a=normalize(n+t1*e);vec3 b=normalize(n+t2*e);
 vec3 p0=n*(1.+disp(n));vec3 p1=a*(1.+disp(a));vec3 p2=b*(1.+disp(b));
 vec3 nn=normalize(cross(p1-p0,p2-p0));
 vN=normalMatrix*nn;vObj=n;
 vec4 mv=modelViewMatrix*vec4(p0*(1.+uBass*.045),1.);vV=-mv.xyz;
 gl_Position=projectionMatrix*mv;}`;
const FRAG=NOISE+`
uniform float uTime,uAmp,uThink,uGlow,uBack;varying vec3 vN,vV,vObj;
vec3 pal(float t){return .5+.5*cos(6.28318*(t+vec3(0.,.33,.67)));}
vec3 envm(vec3 d){
 float up=d.y*.5+.5;vec3 c=vec3(.012,.015,.022)+vec3(.05,.065,.1)*pow(up,3.);
 vec3 k=normalize(vec3(-.6,.8,.5));c+=vec3(1.,.97,.93)*smoothstep(.86,.93,dot(d,k))*1.4;
 vec3 s=normalize(vec3(.9,.1,.3));c+=vec3(.7,.85,1.)*smoothstep(.93,.975,dot(d,s))*smoothstep(-.35,.1,d.y)*(1.-smoothstep(.2,.6,d.y))*.9;
 c+=vec3(.9,.55,.4)*pow(max(-d.y,0.),2.)*.2;return c;}
void main(){
 vec3 N=normalize(vN);if(uBack>.5)N=-N;vec3 V=normalize(vV);
 float ndv=clamp(dot(N,V),0.,1.);float fr=pow(1.-ndv,3.);
 vec3 R=reflect(-V,N);vec3 Rf=refract(-V,N,1./1.35);
 float t=uTime;float sw=t*(.14+uThink*.9);
 vec3 q=vObj*1.3+Rf*.9;
 float r1=1.-abs(snoise(q+vec3(sw,sw*.6,-sw*.4)));
 float r2=1.-abs(snoise(q*1.8-vec3(-sw*.7,sw,sw*.5)));
 float rib=pow(r1,5.)*.8+pow(r2,7.)*.6;
 vec3 lp=normalize(vec3(sin(t*1.4),cos(t*.9)*.6,cos(t*1.4)));
 float orb=pow(max(dot(normalize(Rf+vObj*.35),lp),0.),10.)*uThink;
 vec3 ir=mix(pal(ndv*1.2+snoise(vObj*1.5+t*.05)*.25+.55),vec3(.8,.9,1.),.4);
 float lvl=.3+uAmp*1.4+uGlow;
 vec3 inner=rib*lvl*ir+orb*ir*.9;
 vec3 core=pow(ndv,2.)*(.035+uGlow*.3+uAmp*.35)*vec3(.5,.65,1.);
 vec3 col;
 if(uBack>.5){col=inner*.9+core+ir*fr*.12+envm(R)*.06;}
 else{col=envm(R)*(.1+fr*1.15)+inner*.55+ir*fr*.4+vec3(.7,.8,1.)*pow(1.-ndv,6.)*.5;}
 col=1.-exp(-col*1.25);
 gl_FragColor=vec4(col,1.);}`;
const HVERT='varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}';
const HFRAG='uniform float uI;varying vec2 vUv;void main(){float d=length(vUv-.5)*2.;float g=exp(-d*d*3.2)*uI;gl_FragColor=vec4(vec3(.42,.52,.85)*g,1.);}';
const $=id=>document.getElementById(id);
let renderer;
try{renderer=new THREE.WebGLRenderer({canvas:$('gl'),antialias:false,alpha:false,powerPreference:'high-performance'});}
catch(e){$('err').style.display='grid';}
if(renderer){
const coarse=matchMedia('(pointer:coarse)').matches;
// Adaptive resolution: starts at the original ratio, only ever steps down if frames run slow.
const PR_MAX=Math.min(devicePixelRatio||1,coarse?1.5:2);
let pr=PR_MAX;
renderer.setPixelRatio(pr);
renderer.setClearColor(0x0c0d0f,1);
const scene=new THREE.Scene();
const cam=new THREE.PerspectiveCamera(35,1,.1,50);cam.position.z=6;
const U={uTime:{value:0},uAmp:{value:0},uBass:{value:0},uThink:{value:0},uGlow:{value:.05},uBack:{value:0}};
const mk=(side,back)=>new THREE.ShaderMaterial({vertexShader:VERT,fragmentShader:FRAG,side,transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,uniforms:Object.assign({},U,{uBack:{value:back}})});
const geo=new THREE.IcosahedronGeometry(1,coarse?26:34);
const mBack=mk(THREE.BackSide,1),mFront=mk(THREE.FrontSide,0);
const grp=new THREE.Group();
const back=new THREE.Mesh(geo,mBack);back.renderOrder=1;
const front=new THREE.Mesh(geo,mFront);front.renderOrder=2;
grp.add(back,front);scene.add(grp);
const halo=new THREE.Mesh(new THREE.PlaneGeometry(1,1),new THREE.ShaderMaterial({vertexShader:HVERT,fragmentShader:HFRAG,uniforms:{uI:{value:.12}},transparent:true,depthWrite:false,blending:THREE.AdditiveBlending}));
halo.position.z=-1.5;halo.renderOrder=0;scene.add(halo);
let R0=1,Y0=0,visH=1;
function resize(){const w=innerWidth,h=innerHeight;renderer.setSize(w,h,false);cam.aspect=w/h;cam.updateProjectionMatrix();visH=2*cam.position.z*Math.tan(cam.fov*Math.PI/360);R0=Math.min(.31*visH,.43*visH*cam.aspect);Y0=.025*visH;halo.scale.setScalar(R0*3.6*(1+1.5/6));}
addEventListener('resize',resize);resize();

// GPU context loss (common on mobile when switching apps): recover instead of freezing.
$('gl').addEventListener('webglcontextlost',e=>e.preventDefault());
$('gl').addEventListener('webglcontextrestored',()=>location.reload());

/* ---------------- state & UI ---------------- */
let mode='idle',muted=false,lvl={a:0,b:0},tg={think:0,glow:.05};
const st=$('status'),cap=$('cap'),mic=$('mic'),muteBtn=$('mute'),authEl=$('auth'),am=$('am'),callState=$('callState');
const LABEL={idle:'Tap to talk',connecting:'Connecting',listening:'Listening',thinking:'Thinking',speaking:'Speaking'};
const GLOW={idle:.05,connecting:.08,listening:.14,thinking:.2,speaking:.22};
let errHold=0,lastMs=0;

function paintMute(){
 muteBtn.classList.toggle('on',muted);
 muteBtn.setAttribute('aria-pressed',muted);
 const l=muted?'Unmute microphone':'Mute microphone';
 muteBtn.setAttribute('aria-label',l);muteBtn.title=l;
}

function paintCall(){
 if(!callState)return;
 callState.className=mode==='idle'?'':'active';
 callState.textContent=mode==='idle'?'':'● LIVE'+(lastMs?' · '+lastMs+' ms':'');
}

function setMode(m){
 mode=m;
 // keep an error message visible for a moment instead of instantly overwriting it
 if(!(m==='idle'&&performance.now()<errHold))st.textContent=LABEL[m]||m;
 mic.classList.toggle('on',m!=='idle');
 tg.think=m==='thinking'?1:0;
 tg.glow=GLOW[m]??.05;
 if(m==='idle')lastMs=0;
 paintCall();
 if(m==='idle'&&muted){muted=false;live.setMuted(false);paintMute();} // a new call always starts unmuted
}
function showError(msg){
 errHold=performance.now()+3500;st.textContent=msg;
 setTimeout(()=>{if(mode==='idle')st.textContent=LABEL.idle;},3600);
}

const esc=s=>String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

let sb=null,convId=null;
const jwt=async()=>(await sb.auth.getSession()).data.session?.access_token;
async function save(role,content){try{if(!convId){const{data,error}=await sb.from('conversations').insert({}).select('id').single();if(error)throw error;convId=data.id;}const{error}=await sb.from('messages').insert({conversation_id:convId,role,content});if(error)throw error;}catch(e){console.warn('save failed',e);}}

// Add ?debug to the page URL to see a live latency breakdown on screen
const dbgEl=/[?&]debug\b/.test(location.search)?document.createElement('div'):null;
if(dbgEl){dbgEl.style.cssText='position:fixed;left:10px;bottom:10px;z-index:9;font:11px/1.5 monospace;color:#bbb;background:rgba(0,0,0,.6);padding:6px 9px;border-radius:8px;pointer-events:none';document.body.appendChild(dbgEl);}
const debug=(ms,i)=>{if(dbgEl)dbgEl.textContent=`total ${ms}ms | last word heard ${i.afterTranscript}ms ago | tools ${i.tool}ms`;};
const live=new Live({jwt,save,mode:()=>mode,state:setMode,transcript:(u,a)=>{cap.innerHTML=(u?'<b>'+esc(u)+'</b><br>':'')+esc(a);},error:msg=>showError(msg),latency:(ms,i)=>{lastMs=ms;paintCall();debug(ms,i);}});

const fail=e=>{setMode('idle');showError(e?.name==='NotAllowedError'?'Microphone blocked':(e?.message||'Could not connect').slice(0,60));};

// ---- voice picker ----
const VOICE_LABEL={male:'Male',female:'Female',boy:'Boy',girl:'Girl',robot:'Robot'};
const vb=$('vb'),vp=$('vp');
let voiceKey;try{voiceKey=localStorage.getItem('sambhav.voice');}catch{}
if(!VOICE_LABEL[voiceKey])voiceKey='female';
live.setVoice(voiceKey);
function paintVoice(){
 vb.querySelector('span').textContent=VOICE_LABEL[voiceKey];
 for(const o of vp.querySelectorAll('[data-v]'))o.setAttribute('aria-checked',o.dataset.v===voiceKey);
}
const closeVoice=()=>{vp.classList.remove('show');vb.setAttribute('aria-expanded','false');};
vb.onclick=()=>{const open=vp.classList.toggle('show');vb.setAttribute('aria-expanded',open);};
vp.onclick=e=>{
 const o=e.target.closest('[data-v]');if(!o)return;
 closeVoice();if(o.dataset.v===voiceKey)return;
 voiceKey=o.dataset.v;try{localStorage.setItem('sambhav.voice',voiceKey);}catch{}
 live.setVoice(voiceKey);paintVoice();
 // Gemini fixes the voice when a session opens, so an active call restarts with the new voice
 if(mode!=='idle'){live.stop();cap.innerHTML='';mic.click();}
};
document.addEventListener('pointerdown',e=>{if(!e.target.closest('#voiceWrap'))closeVoice();});
paintVoice();

// SPEED: get the Gemini token ready the moment a finger/cursor reaches the mic button
for(const ev of ['pointerenter','pointerdown'])mic.addEventListener(ev,()=>{if(sb&&mode==='idle')live.prewarm();},{passive:true});

let starting=false;
mic.onclick=async()=>{
 if(!sb||starting)return;
 if(!(await jwt())){authEl.classList.add('show');return;}
 if(mode==='idle'){
  starting=true;cap.innerHTML='';convId=null;
  try{await live.start();}catch(e){fail(e);}finally{starting=false;}
 }else if(mode!=='connecting')live.interrupt();
};
$('end').onclick=()=>{live.stop();cap.innerHTML='';};
muteBtn.onclick=()=>{muted=!muted;live.setMuted(muted);paintMute();};
$('tb').onclick=e=>{const on=e.currentTarget.getAttribute('aria-pressed')!=='true';e.currentTarget.setAttribute('aria-pressed',on);$('ui').classList.toggle('off',!on);};
$('so').onclick=async()=>{live.stop();await sb.auth.signOut();};

// Keyboard: M = mute, Esc = end call (ignored while typing in a field)
addEventListener('keydown',e=>{
 if(e.target.closest?.('input,textarea')||e.metaKey||e.ctrlKey||e.altKey)return;
 if(e.key==='m'||e.key==='M')muteBtn.click();
 else if(e.key==='Escape')$('end').click();
});

const doAuth=async up=>{
 am.textContent='';
 const email=$('em').value.trim(),password=$('pw').value;
 const{data,error}=up?await sb.auth.signUp({email,password}):await sb.auth.signInWithPassword({email,password});
 if(error)am.textContent=error.message;
 else if(up&&!data.session)am.textContent='Check your email to confirm, then sign in.';
};
$('af').onsubmit=e=>{e.preventDefault();doAuth(false);};
$('su').onclick=()=>doAuth(true);

(async()=>{try{
 const cfg=await(await fetch('/api/config')).json();
 if(!cfg.supabaseUrl)throw 0;
 sb=createClient(cfg.supabaseUrl,cfg.supabaseAnonKey);
 const on=s=>{$('so').hidden=!s;authEl.classList.toggle('show',!s);};
 sb.auth.onAuthStateChange((_e,s)=>{on(!!s);if(!s)live.stop();});
 on(!!(await sb.auth.getSession()).data.session);
}catch{st.textContent='Backend not configured';}})();

/* ---------------- render loop (globe maths unchanged) ---------------- */
let px=0,py=0,tx=0,ty=0;
addEventListener('pointermove',e=>{tx=(e.clientX/innerWidth-.5)*2;ty=(e.clientY/innerHeight-.5)*2;});
const reduce=matchMedia('(prefers-reduced-motion:reduce)').matches;
const clock=new THREE.Clock();let T=0;
let slow=0,seen=0;
function frame(){
 requestAnimationFrame(frame);
 if(document.hidden){clock.getDelta();return;}
 const raw=clock.getDelta(),dt=Math.min(raw,.05);T+=dt;

 // adaptive resolution: ~1.5s of consistently slow frames -> drop pixel ratio one step (never below 1)
 seen++;if(raw>.026)slow++;
 if(seen>=90){if(slow>60&&pr>1){pr=Math.max(1,pr-.25);renderer.setPixelRatio(pr);resize();}slow=0;seen=0;}

 let tA=0,tB=0;
 if(mode==='listening'){const r=live.mic();tA=r.rms;tB=r.bass;}
 else if(mode==='speaking'){const r=live.out();tA=r.rms;tB=r.bass;}
 const k=tA>lvl.a?.4:.08;
 lvl.a+=(tA-lvl.a)*k;lvl.b+=(tB-lvl.b)*(tB>lvl.b?.45:.1);
 for(const m of [mBack,mFront]){const u=m.uniforms;u.uTime.value=T;u.uAmp.value=lvl.a;u.uBass.value=lvl.b;u.uThink.value+=(tg.think-u.uThink.value)*.04;u.uGlow.value+=(tg.glow-u.uGlow.value)*.05;}
 halo.material.uniforms.uI.value=.1+lvl.a*.35+tg.glow*.4+mFront.uniforms.uThink.value*.08;
 px+=(tx-px)*.04;py+=(ty-py)*.04;
 const f=reduce?.2:1;const think=mFront.uniforms.uThink.value;
 const s=R0*(1+lvl.a*.05);grp.scale.setScalar(s);
 grp.position.y=Y0+Math.sin(T*.6)*.035*R0*f-py*.02*R0;grp.position.x=px*.03*R0;
 grp.rotation.y=T*(.06+think*.25)*f+px*.25;grp.rotation.x=Math.sin(T*.25)*.1*f+py*.15;
 halo.position.x=grp.position.x;halo.position.y=grp.position.y;
 renderer.render(scene,cam);
}
frame();
}