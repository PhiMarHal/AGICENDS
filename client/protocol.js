// Version 2: small JSON world/events header plus fixed 48-byte player records.
// Little endian. Times use fixed-step ticks; no long-lived metadata in motion records.
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.AGProtocol=api;})(globalThis,function(){
'use strict';
const VERSION=2, RECORD=48, DT=1000/60;
const encoder=new TextEncoder(),decoder=new TextDecoder();
const powers=['mult','vacuum','ghost','secondWind'];
function rosterOf(match){return [...match.players.values()].map(p=>({id:p.id,netId:p.netId,displayName:p.displayName,appearance:p.appearance,isBot:p.isBot}));}
function encode(snap) {
    const header={...snap};delete header.players;
    // Empty deltas dominate small rooms if serialized literally.
    for(const k of Object.keys(header)) {
        const v=header[k];if(v && typeof v==='object' && !Object.keys(v).length) delete header[k];
    }
    const json=encoder.encode(JSON.stringify(header));
    const entries=Object.values(snap.players);
    const bytes=new Uint8Array(12+json.length+entries.length*RECORD),view=new DataView(bytes.buffer);
    view.setUint16(0,0x4147,true);view.setUint16(2,VERSION,true);view.setUint32(4,json.length,true);view.setUint16(8,entries.length,true);
    bytes.set(json,12);
    const age=t=>Math.min(65535,Math.max(0,Math.round((snap.tServer-t)/DT)));
    const remaining=t=>t===Infinity?65535:Math.min(65534,Math.max(0,Math.round((t-snap.tServer)/DT)));
    entries.forEach((p,i)=>{
        const o=12+json.length+i*RECORD;
        const flags=(p.alive?1:0)|(p.inRound?2:0)|(p.pendingInRound?4:0)|(p.facingRight?8:0)|
            (p.stunned?16:0)|(p.phasing?32:0)|(p.isBot?64:0)|(p.inputHeld?128:0)|(p.flapQueued?256:0)|(p.nextFlapDirection===1?512:0);
        view.setUint16(o,p.netId,true);view.setUint16(o+2,flags,true);view.setInt32(o+4,p.score||0,true);
        ['x','y','vx','vy'].forEach((k,j)=>view.setFloat32(o+8+j*4,p[k],true));
        view.setUint32(o+24,p.inputSeq||0,true);
        [age(p.lastFlapTime),age(p.lastStunTime),age(p.flapQueuedAt),remaining(p.secondWindGhostUntil||0),
            ...powers.map(k=>remaining(p.activePowerups[k]||0)),p.queuePosition||0].forEach((v,j)=>view.setUint16(o+28+j*2,v,true));
    });return bytes;
}
function decode(data,roster) {
    const bytes=data instanceof Uint8Array?data:new Uint8Array(data),v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    if(bytes.length<12||v.getUint16(0,true)!==0x4147||v.getUint16(2,true)!==VERSION)throw new Error('Unsupported game protocol');
    const len=v.getUint32(4,true),n=v.getUint16(8,true);
    if(12+len+n*RECORD!==bytes.length)throw new Error('Invalid snapshot length');
    const snap=JSON.parse(decoder.decode(bytes.subarray(12,12+len)));snap.players={};
    const timeAgo=t=>t===65535?-Infinity:snap.tServer-t*DT;
    const until=t=>t===65535?Infinity:t===0?0:snap.tServer+t*DT;
    for(let i=0;i<n;i++) {
        const o=12+len+i*RECORD,id=v.getUint16(o,true),meta=roster.get(id);if(!meta)throw new Error('Missing roster');
        const f=v.getUint16(o+2,true),p={...meta,score:v.getInt32(o+4,true)};
        ['x','y','vx','vy'].forEach((k,j)=>p[k]=v.getFloat32(o+8+j*4,true));
        p.alive=!!(f&1);p.inRound=!!(f&2);p.pendingInRound=!!(f&4);p.facingRight=!!(f&8);p.stunned=!!(f&16);
        p.phasing=!!(f&32);p.isBot=!!(f&64);p.inputHeld=!!(f&128);p.flapQueued=!!(f&256);p.nextFlapDirection=f&512?1:-1;
        p.inputSeq=v.getUint32(o+24,true);p.lastFlapTime=timeAgo(v.getUint16(o+28,true));p.lastStunTime=timeAgo(v.getUint16(o+30,true));
        p.flapQueuedAt=timeAgo(v.getUint16(o+32,true));p.secondWindGhostUntil=until(v.getUint16(o+34,true));
        p.activePowerups={};p.powerups={};
        powers.forEach((k,j)=>{const ticks=v.getUint16(o+36+j*2,true);p.activePowerups[k]=until(ticks);if(ticks)p.powerups[k]=ticks===65535?true:ticks*DT/1000;});
        if(!p.powerups.secondWind && p.secondWindGhostUntil>snap.tServer)p.powerups.secondWind=(p.secondWindGhostUntil-snap.tServer)/1000;
        const queue=v.getUint16(o+44,true);if(queue)p.queuePosition=queue;
        snap.players[meta.id]=p;
    }
    return snap;
}
return {VERSION,RECORD,rosterOf,encode,decode};
});
