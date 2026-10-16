// Cloudflare Pages Functions
//   POST /api/play   … 1ゲームを最後まで遊ぶごとに1回。集計して「今日のセーフ率」を返す。名前があれば今日の記名用紙に載せる
//   POST /api/sign   … 結果画面で名前を記入したとき
//   GET  /api/sheet  … 今日の記名用紙（新しい40件と、今日の人数）＋本日の様子（食数・いちばん人気・セーフ率）
// 必要なもの：D1 のバインディング名 DB（表は schema.sql）
const J=(o,s=200)=>new Response(JSON.stringify(o),{status:s,headers:{'content-type':'application/json','cache-control':'no-store'}});
const day=()=>new Date(Date.now()+324e5).toISOString().slice(0,10).replace(/-/g,''); // 日本時間の日付 YYYYMMDD
const MODES=['st','sh'],CROWDS=['lo','hi'],RES=['safe','late','out'];
const MIN=20; // その日・その組み合わせの回数がこれ未満のあいだはセーフ率を出さない
// 名前のチェック（前作と同じ NG ワード）
const NG=['しね','死ね','ころす','殺す','ばか','あほ','ちんこ','ちんぽ','まんこ','おっぱい','うんこ','くそ','自殺','きちがい','せっくす','ふぁっく','れいぷ','fuck','shit','sex','nazi','porn','rape','nigger'];
const norm=s=>s.normalize('NFKC').toLowerCase().replace(/[\s_\-.*・ー〜~]+/g,'').replace(/[ァ-ヶ]/g,c=>String.fromCharCode(c.charCodeAt(0)-96));
const cleanName=s=>String(s||'').normalize('NFKC').replace(/[^\p{L}\p{N}ー・_\-☆★♪ ]/gu,'').replace(/\s+/g,' ').trim().slice(0,10);
const badName=s=>NG.some(w=>norm(s).includes(w))||/https?|www|\.com/i.test(s);
const enc=new TextEncoder(),hex=b=>[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('');
const hashId=async id=>/^[0-9a-f]{32}$/.test(id||'')?hex(await crypto.subtle.digest('SHA-256',enc.encode('hd:'+id))).slice(0,32):null; // 端末のIDはそのまま保存しない

export async function onRequest(ctx){
 const {request:req,env,params}=ctx,path=[].concat(params.path||[]).join('/');
 if(!env.DB)return J({error:'no db'},500);
 if(path==='play'&&req.method==='POST')return play(ctx,env,req);
 if(path==='sheet'&&req.method==='GET')return sheet(env,req);
 if(path==='sign'&&req.method==='POST'){let b;try{b=await req.json()}catch(e){return J({error:'bad json'},400)}return J(await sign(ctx,env,day(),b&&b.name,b&&b.id,b&&b.smenu))}
 return J({error:'not found'},404);
}

async function play(ctx,env,req){
 let b;try{b=await req.json()}catch(e){return J({error:'bad json'},400)}
 const m=b&&b.m,c=b&&b.c,r=b&&b.r,menu=String((b&&b.menu)||'').replace(/[^\p{L}\p{N}ー・]/gu,'').slice(0,16);
 if(!MODES.includes(m)||!CROWDS.includes(c)||!RES.includes(r))return J({error:'bad'},400);
 const d=day();
 // 今日の集計（多くても4行）。ここからセーフ率と、書き込みの間引き率を決める
 const {results}=await env.DB.prepare('SELECT m,c,plays,safe FROM days WHERE d=?').bind(d).all();
 let total=0,mine=null;for(const x of results){total+=x.plays;if(x.m===m&&x.c===c)mine=x}
 // 間引き：今日のプレイ数が増えたら 10回・100回に1回だけ書き込み、その回数ぶん足す（D1 の書き込み上限対策）
 // 決まった間隔にしたいときは、環境変数 SAMPLE に数字を入れる
 const S=+env.SAMPLE||(total<20000?1:total<200000?10:100);
 if(Math.random()<1/S){
  const st=[env.DB.prepare(`INSERT INTO days(d,m,c,plays,safe,late,out) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(d,m,c) DO UPDATE SET plays=plays+excluded.plays,safe=safe+excluded.safe,late=late+excluded.late,out=out+excluded.out`)
    .bind(d,m,c,S,r==='safe'?S:0,r==='late'?S:0,r==='out'?S:0)];
  if(menu)st.push(env.DB.prepare('INSERT INTO menus(d,m,menu,n) VALUES(?,?,?,?) ON CONFLICT(d,m,menu) DO UPDATE SET n=n+excluded.n').bind(d,m,menu,S));
  ctx.waitUntil(env.DB.batch(st));
 }
 const out={rate:mine&&mine.plays>=MIN?Math.round(mine.safe/mine.plays*100):null};
 // 記名用紙：名前があれば、その端末の今日の1行目だけ書く（2回目以降は名前の書き換えだけ）。間引きはしない
 Object.assign(out,await sign(ctx,env,d,b.name,b.id,b.smenu));
 return J(out);
}

// smenu：その日はじめて載るときのご注文（例：鴨南蛮そば＋冷奴・味噌汁）。2回目以降は変えない
async function sign(ctx,env,d,raw,id,smenu){
 const name=cleanName(raw),h=name&&!badName(name)?await hashId(id):null;if(!h)return {};
 try{
  const ex=await env.DB.prepare('SELECT no,name FROM sheet WHERE d=? AND h=?').bind(d,h).first();
  if(ex){if(ex.name!==name)ctx.waitUntil(env.DB.prepare('UPDATE sheet SET name=? WHERE d=? AND h=?').bind(name,d,h).run());return {no:ex.no}}
  const n=await env.DB.prepare('INSERT INTO sheetn(d,n) VALUES(?,1) ON CONFLICT(d) DO UPDATE SET n=n+1 RETURNING n').bind(d).first();
  const mn=String(smenu||'').normalize('NFKC').replace(/[^\p{L}\p{N}ー・+]/gu,'').replace(/\+/g,'＋').slice(0,24);
  await env.DB.prepare('INSERT OR IGNORE INTO sheet(d,no,h,name,t,menu) VALUES(?,?,?,?,?,?)').bind(d,n.n,h,name,Date.now(),mn).run();return {no:n.n,new:true};
 }catch(e){return {}}
}

async function sheet(env,req){
 const d=day(),u=new URL(req.url),h=await hashId(u.searchParams.get('id'));
 const [cnt,rows,me]=await Promise.all([
  env.DB.prepare('SELECT n FROM sheetn WHERE d=?').bind(d).first(),
  env.DB.prepare('SELECT no,name,t,menu FROM sheet WHERE d=? ORDER BY no DESC LIMIT 40').bind(d).all(),
  h?env.DB.prepare('SELECT no FROM sheet WHERE d=? AND h=?').bind(d,h).first():null]);
 // 本日の様子：失敗しても記名用紙は返す
 let stat=null;try{const [tot,top,dy]=await Promise.all([
   env.DB.prepare('SELECT SUM(n) n FROM menus WHERE d=?').bind(d).first(),
   env.DB.prepare('SELECT menu,SUM(n) n FROM menus WHERE d=? GROUP BY menu ORDER BY n DESC LIMIT 1').bind(d).first(),
   env.DB.prepare('SELECT SUM(plays) p,SUM(safe) s FROM days WHERE d=?').bind(d).first()]);
  stat={meals:tot&&tot.n||0,top:top?top.menu:'',rate:dy&&dy.p>=MIN?Math.round(dy.s/dy.p*100):null}}catch(e){}
 return J({d,n:cnt?cnt.n:0,rows:rows.results||[],mine:me?me.no:null,stat});
}
