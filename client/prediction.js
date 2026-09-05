(function(root,factory){const api=factory(typeof module==='object'&&module.exports?require('./simulation.js'):root.AGSim);if(typeof module==='object'&&module.exports)module.exports=api;else root.AGPredictor=api;})(globalThis,function(Sim){
'use strict';
class Predictor {
    constructor(send,now=()=>performance.now()){this.send=send;this.now=now;this.rtt=0;this.reset();}
    reset(){this.world=null;this.match=null;this.pending=[];this.seq=0;this.roundId=null;this.held=false;this.lastSend=0;this.snapshot=null;this.receivedAt=0;}
    init(world){this.reset();this.world=Sim.worldFromInit(world);}
    receive(snap,id){
        if(!this.world)return;
        this.id=id;
        if(this.roundId!==snap.roundId){this.pending=[];this.seq=0;this.held=false;this.roundId=snap.roundId;}
        Sim.applyWorldDelta(this.world,snap);this.snapshot=snap;this.receivedAt=this.now();
        const me=snap.players[id];
        if(me){this.seq=Math.max(this.seq,me.inputSeq);this.pending=this.pending.filter(c=>c.seq>me.inputSeq);}
        this.match=Sim.predictionMatch(snap,this.world);
        const predicted=this.match.players.get(id);
        if(predicted)predicted.inputQueue=this.pending.map(c=>({...c,tick:Math.max(snap.tick+1,c.tick)}));
        this.advance();
    }
    advance(){
        if(!this.match||this.match.roundState!=='running')return;
        // A bounded prediction horizon prevents runaway catch-up after hidden tabs/stalls.
        const age=Math.max(0,this.now()-this.receivedAt);
        // Predict to the time our next input reaches the authority: inbound + outbound transit.
        const lead=Math.min(300,this.rtt);
        const target=this.snapshot.tick+Math.min(36,Math.floor((age+lead)/Sim.SIM.STEP_MS)+1);
        while(this.match.tick<target)Sim.step(this.match);
    }
    input(held){
        if(!this.match||this.match.roundState!=='running')return;
        const p=this.match.players.get(this.id);if(!p||!p.inRound||!p.alive)return;
        const now=this.now();
        if(held===this.held && now-this.lastSend<250)return;
        if(this.pending.length>=32)return;
        this.held=held;this.lastSend=now;
        const command={type:'input',seq:++this.seq,held,tick:this.match.tick+1,roundId:this.roundId};
        this.pending.push(command);p.inputQueue.push({...command});this.send(command);
    }
    player(id){return this.match&&this.match.players.get(id);}
}
return Predictor;
});
