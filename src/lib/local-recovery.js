const crypto=require('node:crypto');const fs=require('fs');const path=require('path');
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');const ident=x=>'"'+x.replace(/"/g,'""')+'"';
async function snapshot(client,{migrationDir=path.join(__dirname,'../../migrations')}={}){
 await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 try{
 const applied=(await client.query('SELECT name FROM _migrations ORDER BY name')).rows.map(r=>r.name);
 const migrations=applied.map(name=>{if(path.basename(name)!==name)throw Error('Invalid migration name');const sql=fs.readFileSync(path.join(migrationDir,name),'utf8');return {name,sql,sha256:hash(sql)};});
 const names=(await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name")).rows.map(r=>r.table_name);
 const tables=[];for(const name of names){const rows=(await client.query('SELECT row_to_json(t) AS row FROM '+ident(name)+' t')).rows.map(r=>r.row);tables.push({name,rows,count:rows.length,sha256:hash(JSON.stringify(rows))});}
 const sequences=(await client.query("SELECT sequencename FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename")).rows;for(const s of sequences){Object.assign(s,(await client.query('SELECT last_value::text,is_called FROM '+ident(s.sequencename))).rows[0]);}
 await client.query('COMMIT');return {format:'kayan-recovery-v2',generated_at:new Date().toISOString(),migrations,tables,sequences};
 }catch(e){await client.query('ROLLBACK');throw e;}
}
async function restore(client,doc,{migrationDir=path.join(__dirname,'../../migrations')}={}){
 if(doc.format!=='kayan-recovery-v2'||!Array.isArray(doc.tables)||!Array.isArray(doc.migrations))throw Error('Unsupported recovery format');
 for(const m of doc.migrations){if(path.basename(m.name)!==m.name||hash(m.sql)!==m.sha256)throw Error('Migration integrity failed');const trusted=fs.readFileSync(path.join(migrationDir,m.name),'utf8');if(hash(trusted)!==m.sha256)throw Error('Migration differs from reviewed recovery source');}
 for(const t of doc.tables)if(t.count!==t.rows.length||hash(JSON.stringify(t.rows))!==t.sha256)throw Error('Table integrity failed');
 if((await client.query("SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' LIMIT 1")).rowCount)throw Error('Restore requires a completely empty separate database');
 await client.query('BEGIN');try{
 await client.query('CREATE TABLE _migrations(name TEXT PRIMARY KEY,applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
 for(const m of doc.migrations){await client.query(m.sql);await client.query('INSERT INTO _migrations(name) VALUES($1)',[m.name]);}
 const actual=(await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name")).rows.map(r=>r.table_name);
 if(JSON.stringify(actual)!==JSON.stringify(doc.tables.map(t=>t.name).sort()))throw Error('Schema/table manifest mismatch');
 const fks=(await client.query("SELECT c.conname,t.relname,c.condeferrable,c.condeferred FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' AND c.contype='f'")).rows;
 for(const f of fks)await client.query('ALTER TABLE '+ident(f.relname)+' ALTER CONSTRAINT '+ident(f.conname)+' DEFERRABLE INITIALLY DEFERRED');
 await client.query('SET CONSTRAINTS ALL DEFERRED');await client.query('TRUNCATE '+actual.map(ident).join(',')+' CASCADE');
 for(const t of doc.tables){for(const row of t.rows){await client.query('INSERT INTO '+ident(t.name)+' SELECT * FROM json_populate_record(NULL::'+ident(t.name)+',$1::json)',[JSON.stringify(row)]);}}
 await client.query('SET CONSTRAINTS ALL IMMEDIATE');
 for(const f of fks)await client.query('ALTER TABLE '+ident(f.relname)+' ALTER CONSTRAINT '+ident(f.conname)+(f.condeferrable?' DEFERRABLE '+(f.condeferred?'INITIALLY DEFERRED':'INITIALLY IMMEDIATE'):' NOT DEFERRABLE'));
 for(const s of doc.sequences)await client.query('SELECT setval($1::regclass,$2::bigint,$3)',[ident(s.sequencename),s.last_value,s.is_called]);
 await client.query('COMMIT');return {tables:doc.tables.length};
 }catch(e){await client.query('ROLLBACK');throw e;}
}
module.exports={snapshot,restore,hash};
