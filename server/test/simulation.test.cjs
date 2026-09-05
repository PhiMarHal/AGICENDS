const {test}=require('node:test');
const assert=require('node:assert/strict');
const Sim=require('../../client/simulation.js');
const Protocol=require('../../client/protocol.js');
const Predictor=require('../../client/prediction.js');
function running(n=2){const m=Sim.makeMatch();m.mode='devils';m.roundState='running';m.hasStarted=true;m.world.blocks.clear();m.world.lastChunkY=-1000000;for(let i=0;i<n;i++){const p=Sim.addPlayer(m,'human'+i);p.inRound=true;p.x=160+i*140;p.y=0;}return m;}
function decoded(m){const roster=new Map(Protocol.rosterOf(m).map(p=>[p.netId,p]));return Protocol.decode(Protocol.encode(Sim.buildSnapshot(m)),roster);}
test('countdown fills 16 slots; humans replace bots; starts spaced with no overlap',()=>{
 const m=Sim.makeMatch();m.mode='devils';Sim.addPlayer(m,'a');Sim.beginCountdown(m,'a');Sim.fillLobby(m);
 assert.equal(m.readyPlayers.size,16);assert.equal([...m.players.values()].filter(p=>p.isBot).length,15);
 Sim.addPlayer(m,'b');Sim.joinLobby(m,'b');assert.equal([...m.players.values()].filter(p=>p.isBot).length,14);
 for(let i=0;i<600;i++)Sim.step(m);
 assert.equal(m.roundState,'running');const ps=[...m.players.values()].filter(p=>p.inRound);
 assert.equal(ps.length,16);for(let i=0;i<16;i++)for(let j=i+1;j<16;j++)assert.ok(Math.hypot(ps[i].x-ps[j].x,ps[i].y-ps[j].y)>=60);
});
test('equal-mass restitution 1 exchanges approaching velocities and conserves energy',()=>{
 const m=running();const [a,b]=m.players.values();Object.assign(a,{x:300,y:0,vx:400,vy:0});Object.assign(b,{x:350,y:0,vx:-400,vy:0});
 Sim.resolvePlayerContacts(m,1/60);assert.equal(a.vx,-400);assert.equal(b.vx,400);assert.ok(b.x-a.x>=60);
});
test('coincident and swept contacts remain finite; ghosts do not collide',()=>{
 const m=running();const [a,b]=m.players.values();Object.assign(a,{x:300,y:0});Object.assign(b,{x:300,y:0});
 Sim.resolvePlayerContacts(m,1/60);assert.ok(Number.isFinite(a.x));assert.ok(b.x-a.x>=60);
 Object.assign(a,{previousX:300,previousY:0,x:420,y:0,vx:800,vy:0});Object.assign(b,{previousX:400,previousY:0,x:280,y:0,vx:-800,vy:0});
 Sim.resolvePlayerContacts(m,1/60);assert.equal(a.vx,-800);assert.equal(b.vx,800);
 a.activePowerups.ghost=10000;Object.assign(a,{x:300,vx:400});Object.assign(b,{x:350,vx:-400});Sim.resolvePlayerContacts(m,1/60);assert.equal(a.vx,400);
});
test('physics rejects variable steps; held flap cadence is exactly 12 ticks',()=>{
 const m=running(1);const p=[...m.players.values()][0];p.inputHeld=true;const flaps=[];
 assert.throws(()=>Sim.step(m,.1));
 for(let i=0;i<60;i++){const before=p.lastFlapTime;Sim.step(m);if(p.lastFlapTime!==before)flaps.push(m.tick);}
 assert.deepEqual(flaps,[1,13,25,37,49]);
});
test('world deltas survive multiple physics steps until explicit publication',()=>{
 const m=running(1);m.world.coins.set('coin',{id:'coin',x:160,y:0});
 Sim.step(m);assert.deepEqual(m.world.removedCoinIds,['coin']);Sim.step(m);Sim.step(m);
 assert.deepEqual(m.world.removedCoinIds,['coin']);Sim.resetTickDeltas(m.world);assert.equal(m.world.removedCoinIds.length,0);
});
test('old static world removed; retained corridor and wall allocations are bounded',()=>{
 const m=running(1);const p=[...m.players.values()][0];p.y=-100000;m.spikeY=1000;
 m.world.coins.set('oldcoin',{id:'oldcoin',x:100,y:0});m.world.blocks.set('oldblock',{id:'oldblock',x:100,y:0,scale:1,hits:0});
 Sim.step(m);assert.ok(m.spikeY<=p.y+Sim.SIM.MAX_WORLD_SPAN+100);
 assert.equal(m.world.coins.has('oldcoin'),false);assert.equal(m.world.blocks.has('oldblock'),false);assert.equal(m.world.sideWallSegments.length,0);
});
test('compact codec preserves prediction fields, permanent powers, names and large altitude',()=>{
 const m=running();m.tick=700;m.elapsedMs=m.tick*Sim.SIM.STEP_MS;const p=[...m.players.values()][0];
 Object.assign(p,{y:-100000.25,inputSeq:17,inputHeld:true,lastFlapTime:m.elapsedMs-200,lastStunTime:-Infinity,flapQueuedAt:m.elapsedMs-50,nextFlapDirection:-1,displayName:'Name'});
 p.activePowerups.secondWind=Infinity;p.activePowerups.ghost=m.elapsedMs+6000;
 const out=decoded(m).players[p.id];assert.equal(out.y,p.y);assert.equal(out.inputSeq,17);assert.equal(out.nextFlapDirection,-1);
 assert.equal(out.activePowerups.secondWind,Infinity);assert.equal(out.activePowerups.ghost,p.activePowerups.ghost);assert.equal(out.displayName,'Name');assert.equal(out.lastStunTime,-Infinity);
 assert.throws(()=>Protocol.decode(new Uint8Array(1),new Map()));
});
test('prediction replays pending inputs; acknowledgement removes them and round init clears them',()=>{
 const m=running(1);let now=0;const commands=[];const predictor=new Predictor(c=>commands.push(c),()=>now);
 predictor.init(Sim.buildWorldInit(m.world));predictor.receive(decoded(m),'human0');predictor.input(true);
 assert.equal(commands.length,1);assert.ok(Sim.enqueueInput(m,m.players.get('human0'),commands[0]));
 Sim.step(m);Sim.step(m);assert.equal(m.players.get('human0').inputSeq,1);
 now=33.333333;predictor.receive(decoded(m),'human0');assert.equal(predictor.pending.length,0);
 Sim.step(m);const a=m.players.get('human0'),b=predictor.player('human0');assert.ok(Math.abs(a.x-b.x)<.001);assert.ok(Math.abs(a.y-b.y)<.001);assert.equal(a.nextFlapDirection,b.nextFlapDirection);
 predictor.init(Sim.buildWorldInit(m.world));assert.equal(predictor.pending.length,0);assert.equal(predictor.match,null);
});
test('input sequencing rejects duplicates, wrong rounds and excessive future ticks',()=>{
 const m=running(1),p=m.players.get('human0');assert.equal(Sim.enqueueInput(m,p,{seq:1,held:true,roundId:99,tick:1}),false);
 assert.ok(Sim.enqueueInput(m,p,{seq:1,held:true,roundId:0,tick:1000}));assert.equal(p.inputQueue[0].tick,12);
 assert.equal(Sim.enqueueInput(m,p,{seq:1,held:true,roundId:0,tick:1}),false);
});
test('Angels join replaces a bot without exceeding 16; reset removes bots and input state',()=>{
 const m=Sim.makeMatch();m.mode='angels';Sim.addPlayer(m,'a');Sim.beginCountdown(m,'a');Sim.fillLobby(m);for(let i=0;i<600;i++)Sim.step(m);
 const late=Sim.addPlayer(m,'late');assert.ok(Sim.joinAngels(m,late));assert.equal(late.alive,false);assert.equal([...m.players.values()].filter(p=>p.inRound).length,16);
 Sim.resetMatch(m);assert.equal([...m.players.values()].filter(p=>p.isBot).length,0);assert.equal(m.tick,0);assert.equal(m.roundId,1);
});
