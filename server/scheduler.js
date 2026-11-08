import {routeGaps} from './manager.js';
import {now,query,run,records} from './store.js';
import {enqueue,drain} from './agents.js';
import {send,ingest} from './channels.js';
export async function tick(env,ctx){
 const local=new Date(Date.now()+8*3600000),date=local.toISOString().slice(0,10),hour=local.getUTCHours(),day=local.getUTCDay();
 const tenants=await query(env,"SELECT tenant FROM subscriptions WHERE status='active' AND expires_at>?",now());
 for(const {tenant} of tenants){
  const approved=(await records(env,tenant,'strategy')).some(s=>s.data.status==='approved');if(!approved)continue;
  const kinds=[...(hour>=9?['report']:[]),...([1,3,5].includes(day)&&hour>=10?['content']:[])];
  for(const kind of kinds){const key='schedule:'+tenant+':'+date+':'+kind;const inserted=await run(env,'INSERT OR IGNORE INTO channel_events VALUES (?,?,?,?,?,?)',key,tenant,'scheduler','{}','processed',now());if(inserted.meta.changes)await enqueue(env,tenant,kind==='report'?'manager':'operations',kind,{period:day===1?'weekly':'daily'});}
  // Recover durable Meta payloads left behind by a terminated request. ingest deduplicates by provider message id.
  const pending=await query(env,"SELECT * FROM channel_events WHERE tenant=? AND channel='meta_raw' AND status='received' ORDER BY created_at LIMIT 20",tenant);
  for(const raw of pending){try{
   const payload=JSON.parse(raw.data);
   for(const entry of payload.entry||[]){
    for(const change of entry.changes||[]){const v=change.value||{};const account=await query(env,"SELECT id FROM channels WHERE tenant=? AND channel='whatsapp' AND account_id=? AND health!='disconnected'",tenant,v.metadata?.phone_number_id||'');if(!account.length)continue;
     for(const msg of v.messages||[])if(msg.type==='text')await ingest(env,tenant,{channel:'whatsapp',external_id:msg.from,text:msg.text.body,event_id:msg.id,timestamp:Number(msg.timestamp)*1000,name:v.contacts?.find(x=>x.wa_id===msg.from)?.profile?.name});
    }
    const accounts=await query(env,"SELECT id FROM channels WHERE tenant=? AND channel='facebook' AND account_id=? AND health!='disconnected'",tenant,entry.id);if(accounts.length)for(const event of entry.messaging||[])if(event.message?.text&&!event.message.is_echo)await ingest(env,tenant,{channel:'facebook',external_id:event.sender.id,text:event.message.text,event_id:event.message.mid,timestamp:event.timestamp});
   }
   await run(env,"UPDATE channel_events SET status='processed' WHERE id=?",raw.id);
  }catch{await run(env,"UPDATE channel_events SET status='blocked' WHERE id=?",raw.id);}}
  if(hour>=9)await routeGaps(env,tenant);
  ctx.waitUntil(drain(env,tenant,send));
 }
 return {ok:true,tenants:tenants.length};
}
