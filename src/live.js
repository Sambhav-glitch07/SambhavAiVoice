import { GoogleGenAI } from '@google/genai';
const WORKLET = `class P extends AudioWorkletProcessor{constructor(){super();this.b=[];this.n=0}
process(i){const c=i[0][0];if(c){this.b.push(new Float32Array(c));this.n+=c.length;
if(this.n>=1024){const o=new Float32Array(this.n);let k=0;for(const x of this.b){o.set(x,k);k+=x.length}this.b=[];this.n=0;this.port.postMessage(o,[o.buffer])}}return true}}
registerProcessor('pcm-cap',P)`;
const b64=u8=>{let s='';for(let i=0;i<u8.length;i+=8192)s+=String.fromCharCode.apply(null,u8.subarray(i,i+8192));return btoa(s);};
const unb64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
function level(an,buf,fq){an.getByteTimeDomainData(buf);let s=0;for(let i=0;i<buf.length;i++){const v=(buf[i]-128)/128;s+=v*v;}an.getByteFrequencyData(fq);let b=0;for(let i=1;i<9;i++)b+=fq[i];return{rms:Math.min(1,Math.sqrt(s/buf.length)*3.2),bass:Math.min(1,b/8/255*1.2)};}
export class Live{
constructor(h){this.h=h;this.active=false;this.muted=false;this.q=new Set();this.next=0;this.reset();}
reset(){this.uText='';this.aText='';this.turnDone=true;this.speechAt=0;this.lastLoud=0;this.gotOutput=false;}
mic(){return this.micAn&&!this.muted?level(this.micAn,this.micBuf,this.micFq):{rms:0,bass:0};}
out(){return this.outAn?level(this.outAn,this.outBuf,this.outFq):{rms:0,bass:0};}
async start(){if(this.active)return;this.active=true;this.h.state('connecting');try{
const stream=this.stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true,channelCount:1}});
const ctx=this.ctx=new AudioContext({latencyHint:'interactive'});await ctx.resume();
const an=fft=>{const a=ctx.createAnalyser();a.fftSize=fft;a.smoothingTimeConstant=.6;return a;};
const src=ctx.createMediaStreamSource(stream);this.micAn=an(512);this.micBuf=new Uint8Array(512);this.micFq=new Uint8Array(256);src.connect(this.micAn);
this.outAn=an(512);this.outBuf=new Uint8Array(512);this.outFq=new Uint8Array(256);this.outAn.connect(ctx.destination);
const url=URL.createObjectURL(new Blob([WORKLET],{type:'text/javascript'}));await ctx.audioWorklet.addModule(url);URL.revokeObjectURL(url);
const node=this.node=new AudioWorkletNode(ctx,'pcm-cap');const mute=ctx.createGain();mute.gain.value=0;src.connect(node);node.connect(mute);mute.connect(ctx.destination);
const ratio=ctx.sampleRate/16000;node.port.onmessage=e=>{if(!this.session||this.muted)return;const f=e.data,n=Math.floor(f.length/ratio),o=new Int16Array(n);for(let i=0;i<n;i++){let s=0,a=Math.floor(i*ratio),z=Math.floor((i+1)*ratio);for(let j=a;j<z;j++)s+=f[j];const v=Math.max(-1,Math.min(1,s/(z-a)));o[i]=v<0?v*32768:v*32767;}try{this.session.sendRealtimeInput({audio:{data:b64(new Uint8Array(o.buffer)),mimeType:'audio/pcm;rate=16000'}});}catch{}};
const r=await fetch('/api/live-token',{method:'POST',headers:{Authorization:'Bearer '+await this.h.jwt()}});
const j=await r.json();if(!r.ok)throw new Error(j.error||'Token request failed');
const ai=new GoogleGenAI({apiKey:j.token,httpOptions:{apiVersion:'v1alpha'}});
this.session=await ai.live.connect({model:j.model,config:j.config,callbacks:{onopen:()=>{this.h.state('listening');this.h.opened?.();},onmessage:m=>this.msg(m),onerror:e=>this.h.error(e?.message||'Connection error'),onclose:()=>this.stop()}});
this.timer=setInterval(()=>this.tick(),100);
}catch(e){this.stop();throw e;}}
tick(){const now=performance.now(),r=this.mic();if(r.rms>.14){this.speechAt=now;this.lastLoud=now;}if(this.h.mode()==='listening'&&this.speechAt&&!this.gotOutput&&now-this.lastLoud>700)this.h.state('thinking');}
msg(m){const sc=m.serverContent;if(m.toolCall?.functionCalls)this.tools(m.toolCall.functionCalls);if(!sc)return;
if(sc.interrupted){this.flush();this.persist();this.h.state('listening');}
if(sc.inputTranscription?.text){this.uText+=sc.inputTranscription.text;this.turnDone=false;this.h.transcript(this.uText,this.aText);}
if(sc.outputTranscription?.text){this.aText+=sc.outputTranscription.text;this.h.transcript(this.uText,this.aText);}
for(const p of sc.modelTurn?.parts||[])if(p.inlineData?.data&&/audio\/pcm/.test(p.inlineData.mimeType||''))this.play(p.inlineData.data);
if(sc.turnComplete){this.persist();this.turnDone=true;this.gotOutput=false;this.speechAt=0;if(!this.q.size)this.h.state('listening');}}
play(data){const bytes=unb64(data);const i16=new Int16Array(bytes.buffer,bytes.byteOffset,Math.floor(bytes.byteLength/2));const f=new Float32Array(i16.length);for(let i=0;i<f.length;i++)f[i]=i16[i]/32768;
const buf=this.ctx.createBuffer(1,f.length,24000);buf.copyToChannel(f,0);const s=this.ctx.createBufferSource();s.buffer=buf;s.connect(this.outAn);const t=Math.max(this.next,this.ctx.currentTime+.03);s.start(t);this.next=t+buf.duration;this.q.add(s);this.gotOutput=true;this.h.state('speaking');s.onended=()=>{this.q.delete(s);if(!this.q.size&&this.turnDone)this.h.state('listening');};}
flush(){for(const s of this.q){s.onended=null;try{s.stop();}catch{}}this.q.clear();this.next=0;this.gotOutput=false;}
interrupt(){this.flush();this.h.state('listening');}
async tools(calls){this.h.state('thinking');const functionResponses=await Promise.all(calls.map(async c=>{try{const r=await fetch('/api/tool',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+await this.h.jwt()},body:JSON.stringify({name:c.name,args:c.args})});return{id:c.id,name:c.name,response:await r.json()};}catch{return{id:c.id,name:c.name,response:{ok:false,error:'network'}};}}));try{this.session?.sendToolResponse({functionResponses});}catch{}}
persist(){const u=this.uText.trim(),a=this.aText.trim();this.uText='';this.aText='';if(u)this.h.save('user',u);if(a)this.h.save('assistant',a);}
setMuted(v){this.muted=v;this.stream?.getAudioTracks().forEach(t=>t.enabled=!v);if(v)try{this.session?.sendRealtimeInput({audioStreamEnd:true});}catch{}}
stop(){if(!this.active)return;this.active=false;clearInterval(this.timer);this.persist();this.flush();try{this.session?.close();}catch{}this.session=null;this.stream?.getTracks().forEach(t=>t.stop());try{this.node?.disconnect();}catch{}try{this.ctx?.close();}catch{}this.stream=this.node=this.ctx=this.micAn=this.outAn=null;this.reset();this.h.state('idle');}
}
