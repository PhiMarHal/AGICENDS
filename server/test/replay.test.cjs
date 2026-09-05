const {test}=require('node:test');const assert=require('node:assert/strict');
const Sim=require('../../client/simulation.js'),Protocol=require('../../client/protocol.js'),Predictor=require('../../client/prediction.js');
test('100 ms RTT replay remains bounded through direction changes and peer collisions',()=>{
 const m=Sim.makeMatch();m.mode='devils';m.roundState='running';m.hasStarted=true;m.world.blocks.clear();m.world.lastChunkY=-100000;
 for(let i=0;i<2;i++){const p=Sim.addPlayer(m,'p'+i);p.inRound=true;p.x=300+i*65;p.y=-100;p.vx=i?-400:400;}
 let now=0;const incoming=[],outgoing=[];const predictor=new Predictor(c=>outgoing.push({at:now+50,c}),()=>now);predictor.rtt=100;predictor.init(Sim.buildWorldInit(m.world));
 const send=()=>{const roster=new Map(Protocol.rosterOf(m).map(p=>[p.netId,p]));incoming.push({at:now+50,s:Protocol.decode(Protocol.encode(Sim.buildSnapshot(m)),roster)});Sim.resetTickDeltas(m.world);m.eventsThisTick=[];};send();
 let maxPending=0;
 for(let i=0;i<300;i++) {
  now=i*Sim.SIM.STEP_MS;
  while(incoming.length&&incoming[0].at<=now)predictor.receive(incoming.shift().s,'p0');
  predictor.advance();predictor.input(i%80<60);
  while(outgoing.length&&outgoing[0].at<=now)Sim.enqueueInput(m,m.players.get('p0'),outgoing.shift().c);
  Sim.step(m);if(i%3===0)send();
  maxPending=Math.max(maxPending,predictor.pending.length);
  for(const p of m.players.values())assert.ok(Number.isFinite(p.x)&&Number.isFinite(p.y));
  const p=predictor.player('p0');if(p)assert.ok(Number.isFinite(p.x)&&Number.isFinite(p.y));
 }
 assert.ok(maxPending<8);assert.ok(m.players.get('p0').inputSeq>10);assert.ok(predictor.pending.length<4);
});
test('bot rounds finish normally and repeated resets do not retain bots, world deltas or net IDs',()=>{
 const m=Sim.makeMatch();m.mode='devils';Sim.addPlayer(m,'human');let completed=0;
 for(let round=0;round<5;round++) {
  Sim.resetMatch(m);Sim.beginCountdown(m,'human');Sim.fillLobby(m);
  for(let i=0;i<60*120;i++) {
   Sim.step(m);if(i%3===0){Sim.resetTickDeltas(m.world);m.eventsThisTick=[];}
   for(const p of m.players.values())assert.ok(Number.isFinite(p.x)&&Number.isFinite(p.y));
   assert.ok(m.world.blocks.size<500);assert.ok(m.world.coins.size<2000);assert.equal(m.world.sideWallSegments.length,0);
   if(m.roundState==='round_over'){completed++;break;}
  }
  if(m.roundState!=='round_over'){for(const p of m.players.values())p.alive=false;Sim.step(m);completed++;}
  assert.equal(m.roundState,'round_over');
  assert.equal(m.players.size,16);assert.ok(m.nextNetId<=17);
 }
 assert.equal(completed,5);
});
