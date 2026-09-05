const {test}=require('node:test');const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');const path=require('node:path');const WS=require('ws');const Protocol=require('../../client/protocol.js');
const waitFor=async(fn,ms=14000)=>{const end=Date.now()+ms;while(Date.now()<end){if(fn())return;await new Promise(r=>setTimeout(r,20));}throw Error('Timed out waiting for network state');};
test('real WebSockets: bot-filled modes, binary snapshots, input acknowledgement, late join and abandoned reset', {timeout:25000},async t=>{
 const child=spawn(process.execPath,[path.join(__dirname,'../server.js')],{env:{...process.env,PORT:'0',AUTH_WORKER_URL:'',GAME_SERVER_SHARED_SECRET:''}});
 let port,stderr='';child.stdout.on('data',b=>{const m=b.toString().match(/localhost:(\d+)/);if(m)port=+m[1];});child.stderr.on('data',b=>stderr+=b);
 const clients=[];t.after(()=>{for(const c of clients)c.ws.terminate();child.kill();});await waitFor(()=>port,5000);
 function connect(mode){const c={ws:new WS(`ws://localhost:${port}/?mode=${mode}`),roster:new Map(),sizes:[],snap:null};clients.push(c);
 c.ws.on('message',(data,binary)=>{if(binary){c.snap=Protocol.decode(data,c.roster);c.sizes.push(data.length);}else{const m=JSON.parse(data);if(m.type==='welcome')c.id=m.sessionId;if(m.type==='roster')c.roster=new Map(m.players.map(p=>[p.netId,p]));}});return c;}
 const a=connect('devils'),b=connect('devils'),ang=connect('angels');await waitFor(()=>a.id&&b.id&&ang.id);
 a.ws.send(JSON.stringify({type:'ready'}));b.ws.send(JSON.stringify({type:'ready'}));ang.ws.send(JSON.stringify({type:'ready'}));
 await waitFor(()=>a.snap?.roundState==='running'&&ang.snap?.roundState==='running');
 assert.equal(Object.values(a.snap.players).filter(p=>p.inRound).length,16);assert.equal(Object.values(a.snap.players).filter(p=>p.isBot).length,14);
 const initialSeq=a.snap.players[a.id].inputSeq;
 a.ws.send(JSON.stringify({type:'input',seq:initialSeq+1,held:true,tick:a.snap.tick+1,roundId:a.snap.roundId}));
 await waitFor(()=>a.snap.players[a.id].inputSeq===initialSeq+1,2000);
 const late=connect('angels');await waitFor(()=>late.id);late.ws.send(JSON.stringify({type:'ready'}));await waitFor(()=>late.snap?.players[late.id]?.inRound);
 assert.equal(Object.values(late.snap.players).filter(p=>p.inRound).length,16);assert.equal(Object.values(late.snap.players).filter(p=>p.isBot).length,14);
 assert.ok(a.sizes.slice(-5).every(n=>n<6000),'compact 16-player snapshots stay below 6 KB in this fixture');
 a.ws.close();b.ws.close();await waitFor(()=>a.ws.readyState===WS.CLOSED&&b.ws.readyState===WS.CLOSED);
 const fresh=connect('devils');await waitFor(()=>fresh.snap);assert.equal(fresh.snap.roundState,'waiting');assert.equal(Object.values(fresh.snap.players).filter(p=>p.isBot).length,0);
 assert.equal(stderr,'');
});
