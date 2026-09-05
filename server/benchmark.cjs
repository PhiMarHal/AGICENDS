// Synthetic CPU/payload probe, not an FPS or hosting-capacity certification.
const {performance}=require('node:perf_hooks');const S=require('../client/simulation.js'),P=require('../client/protocol.js');
for(const altitude of [0,100000]) {
 const m=S.makeMatch();m.mode='devils';m.roundState='running';m.hasStarted=true;m.nextIntervalIndex=altitude/5000;m.tick=18000;m.elapsedMs=m.tick*S.SIM.STEP_MS;
 for(let i=0;i<16;i++){const p=S.addPlayer(m,'p'+i);p.inRound=true;p.displayName='Player'+i;p.appearance={body:'solid',eyes:'cat',pupils:'slit',ears:'cat',tail:'cat'};}
 S.generateChunks(m.world,540-altitude-1620,m.elapsedMs);const ticks=[],enc=[],sizes=[];
 for(let k=0;k<900;k++) {
  let i=0;for(const p of m.players.values()){p.x=80+(i%8)*80;p.y=540-altitude-Math.floor(i/8)*140;p.vx=i%2?400:-400;p.vy=-623.333333333;p.alive=true;i++;}m.spikeY=1540-altitude;
  const start=performance.now();S.step(m);const end=performance.now();if(k>100)ticks.push(end-start);
  if(k%3===0){const t=performance.now();const payload=P.encode(S.buildSnapshot(m));if(k>100){enc.push(performance.now()-t);sizes.push(payload.length);}S.resetTickDeltas(m.world);m.eventsThisTick=[];}
 }
 const avg=a=>a.reduce((s,v)=>s+v,0)/a.length;const sorted=ticks.sort((a,b)=>a-b);
 console.log(JSON.stringify({altitude,players:16,meanTickMs:avg(ticks),p95TickMs:sorted[Math.floor(sorted.length*.95)],meanEncodeMs:avg(enc),meanSnapshotBytes:avg(sizes),clientKBPerSecond:avg(sizes)*20/1000,roomGBPerHourAt16HumanRecipients:avg(sizes)*20*16*3600/1e9,blocks:m.world.blocks.size,coins:m.world.coins.size,walls:m.world.sideWallSegments.length}));
}
