#!/usr/bin/env node
// Offline, read-only preflight. No database import, network call, or credentials.
const fs=require('fs');
function validate(d){
 const errors=[],warnings=[],tables=['customers','courses','staff','orders','payments','opening_balances'];
 for(const t of tables)if(!Array.isArray(d[t]))errors.push(t+': expected array');
 if(errors.length)return {ok:false,errors,warnings};
 const map={};for(const t of tables){map[t]=new Map();for(const [n,r]of d[t].entries()){if(!r.external_id||map[t].has(String(r.external_id)))errors.push(t+' row '+(n+1)+': missing/duplicate external_id');map[t].set(String(r.external_id),r);if(Object.keys(r).some(k=>/password|secret|token|cvv/i.test(k)))errors.push(t+' row '+(n+1)+': secret fields prohibited');}}
 const cents=v=>typeof v==='string'&&/^\d+(?:\.\d{1,2})?$/.test(v)?Math.round(Number(v)*100):null;
 const ref=(table,id,label)=>{if(!map[table].has(String(id)))errors.push(label+': unresolved '+table+' reference');};
 const phones=new Set();for(const r of d.customers){if(!r.name?.trim()||!r.phone?.trim())errors.push('customer '+r.external_id+': name/phone required');if(phones.has(r.phone))errors.push('duplicate customer phone');phones.add(r.phone);if(/^TEST-|وهمي/.test(r.phone)||/وهمي/.test(r.name))errors.push('customer '+r.external_id+': fictional marker requires exclusion');}
 for(const r of d.courses){if(cents(r.price)===null)errors.push('course '+r.external_id+': decimal-string price required');else if(cents(r.price)===0)warnings.push('course '+r.external_id+': zero price requires owner confirmation');}
 const roles=Object.keys(require('../src/lib/permissions').ROLES);for(const r of d.staff)if(!r.name?.trim()||!r.email?.includes('@')||!roles.includes(r.role))errors.push('staff '+r.external_id+': valid name/email/role required');
 for(const r of d.orders){ref('customers',r.customer_id,'order '+r.external_id);ref('courses',r.course_id,'order '+r.external_id);ref('staff',r.sales_id,'order '+r.external_id);if(cents(r.total)===null)errors.push('order '+r.external_id+': decimal total required');if(!['approved','cancelled'].includes(r.status))errors.push('order '+r.external_id+': explicit status required');}
 const paid=new Map();for(const r of d.payments){ref('orders',r.order_id,'payment '+r.external_id);let c=cents(r.amount);if(c===null||c===0)errors.push('payment '+r.external_id+': positive decimal amount required');if(!['active','voided'].includes(r.status))errors.push('payment '+r.external_id+': explicit status required');if(r.status==='active')paid.set(String(r.order_id),(paid.get(String(r.order_id))||0)+(c||0));}
 for(const r of d.orders){const p=paid.get(String(r.external_id))||0;if(p>(cents(r.total)||0))errors.push('order '+r.external_id+': collections exceed total');if(r.status==='cancelled'&&p)errors.push('order '+r.external_id+': cancelled with active collection');}
 for(const r of d.opening_balances)if(typeof r.amount!=='string'||!/^\-?\d+(?:\.\d{1,2})?$/.test(r.amount)||!r.as_of||!r.approved_by)errors.push('opening balance '+r.external_id+': signed decimal, as-of and owner approval required');
 return {ok:errors.length===0,errors,warnings,counts:Object.fromEntries(tables.map(t=>[t,d[t].length])),approved_orders_cents:d.orders.filter(r=>r.status==='approved').reduce((s,r)=>s+(cents(r.total)||0),0),active_collections_cents:[...paid.values()].reduce((s,v)=>s+v,0),mode:'offline_preflight_only_not_import_approval'};
}
if(require.main===module){try{if(process.argv.length!==3)throw Error('Usage: node scripts/validate-migration.cjs INPUT.json');console.log(JSON.stringify(validate(JSON.parse(fs.readFileSync(process.argv[2],'utf8'))),null,2));}catch(e){console.error('Invalid input: '+e.message);process.exitCode=1;}}
module.exports={validate};
