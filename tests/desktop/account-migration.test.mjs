import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { test } from "node:test";
const { runDesktopMigrations } = createRequire(import.meta.url)("../../electron-dist/migrations.js");
test("account settings migration preserves historical data, backs up the old schema and cascades usage",()=>{
  const root=mkdtempSync(join(tmpdir(),"private-ai-account-upgrade-"));const databaseFile=join(root,"app.db"),migrationsDirectory=resolve("src/db/migrations"),migration="20260831150000_account_preferences_and_model_usage";
  const options={databaseFile,migrationsDirectory,backupsDirectory:join(root,"backups"),logger:{info(){},warn(){},error(){}}};
  try {
    const old=new DatabaseSync(databaseFile);
    try {
      old.exec("CREATE TABLE desktop_migrations (name TEXT PRIMARY KEY, appliedAt DATETIME DEFAULT CURRENT_TIMESTAMP)");
      for(const entry of readdirSync(migrationsDirectory,{withFileTypes:true}).filter(entry=>entry.isDirectory()&&entry.name<migration).sort((a,b)=>a.name.localeCompare(b.name))){old.exec(readFileSync(join(migrationsDirectory,entry.name,"migration.sql"),"utf8"));old.prepare("INSERT INTO desktop_migrations (name) VALUES (?)").run(entry.name);}
      old.exec("INSERT INTO users (id,email,updatedAt) VALUES ('owner','account-upgrade@example.invalid',CURRENT_TIMESTAMP); INSERT INTO chats (id,userId,title,updatedAt) VALUES ('chat','owner','History',CURRENT_TIMESTAMP); INSERT INTO messages (id,chatId,role,content) VALUES ('message','chat','user','Preserved content');");
    } finally {old.close();}
    const applied=runDesktopMigrations(options);assert.ok(applied.applied.includes(migration));
    const backup=new DatabaseSync(applied.backupFile,{readOnly:true});
    try{assert.equal(backup.prepare("SELECT content FROM messages").get().content,"Preserved content");assert.equal(backup.prepare("SELECT name FROM sqlite_master WHERE name='account_preferences'").get(),undefined);}finally{backup.close();}
    const db=new DatabaseSync(databaseFile);
    try{
      assert.equal(db.prepare("SELECT content FROM messages").get().content,"Preserved content");
      assert.equal(db.prepare("SELECT count(*) AS count FROM account_preferences").get().count,0);
      db.exec(`INSERT INTO account_preferences (userId,settings,updatedAt) VALUES ('owner','{"version":1,"defaultMode":"image"}',CURRENT_TIMESTAMP); INSERT INTO model_requests (id,userId,requestId,mode,modelId,status,durationMs,costSource) VALUES ('usage','owner','request','chat','offline/model','success',12,'unknown')`);
    } finally{db.close();}
    assert.deepEqual(runDesktopMigrations(options).applied,[]);
    const reopened=new DatabaseSync(databaseFile);
    try{
      assert.equal(reopened.prepare("SELECT durationMs FROM model_requests").get().durationMs,12);assert.equal(JSON.parse(reopened.prepare("SELECT settings FROM account_preferences").get().settings).defaultMode,"image");
      reopened.exec("PRAGMA foreign_keys=ON; DELETE FROM users WHERE id='owner'");
      for(const table of ["account_preferences","model_requests","chats"])assert.equal(reopened.prepare(`SELECT count(*) AS count FROM ${table}`).get().count,0);
    }finally{reopened.close();}
  } finally {
    if(resolve(dirname(root))!==resolve(tmpdir())||!root.startsWith(join(tmpdir(),"private-ai-account-upgrade-")))throw new Error("Unexpected test directory");rmSync(root,{recursive:true,force:true});
  }
});
