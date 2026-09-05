const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const source=fs.readFileSync(path.join(__dirname,'../../worker/stats.js'),'utf8').replace(/^import .*;$/m,'').replace(/export /g,'');
function fixture(){const db=new DatabaseSync(':memory:');db.exec(fs.readFileSync(path.join(__dirname,'../../worker/schema.sql'),'utf8'));
 let queries=0;const api=new Function('json','safeJson','one','all','run',source+';return {recordMatch,updateMmrForMatch};')(
  (body,status=200)=>({body,status}),r=>r.json(),async(e,sql,...v)=>{queries++;return db.prepare(sql).get(...v)},
  async(e,sql,...v)=>{queries++;return db.prepare(sql).all(...v)},async(e,sql,...v)=>{queries++;const r=db.prepare(sql).run(...v);return {meta:{last_row_id:Number(r.lastInsertRowid)}}});
 return {db,api,count:()=>queries};}
test('16-player results and normalized Elo fit in a small number of SQL statements',async()=>{
 const f=fixture(),players=[];
 for(let i=1;i<=16;i++){f.db.prepare('INSERT INTO users(id,display_name,created_at) VALUES(?,?,?)').run(i,'user'+i,1);players.push({user_id:i,display_name:'user'+i,final_score:17-i,finishing_rank:i});}
 const req={headers:{get:()=> 'test-secret'},json:async()=>({mode:'devils',ended_at:1234,players})};
 const result=await f.api.recordMatch(req,{GAME_SERVER_SHARED_SECRET:'test-secret'});
 assert.equal(result.status,200);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM match_players').get().n,16);
 assert.equal(f.db.prepare('SELECT mmr FROM users WHERE id=1').get().mmr,1516);
 assert.equal(f.db.prepare('SELECT mmr FROM users WHERE id=16').get().mmr,1484);
 assert.ok(f.count()<=5);f.db.close();
});
test('bots/anonymous players do not create rating opponents',async()=>{
 const f=fixture();f.db.exec("INSERT INTO users(id,display_name,created_at) VALUES(1,'human',1)");
 const changes=await f.api.updateMmrForMatch({},[{user_id:1,finishing_rank:1},{display_name:'BOT 1',finishing_rank:2}]);assert.deepEqual(changes,{});f.db.close();
});
