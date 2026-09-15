import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile, utimes, symlink, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database.mjs";
import { localAccessCookie } from "../helpers/local-access.mjs";
import { testPng } from "../helpers/model-provider.mjs";
const cleanup = createTestDatabase();
const { db } = await import("@/db");

const storage = await import("@/lib/media/storage");
const archive = await import("@/lib/backups/archive");
const files = await import("@/lib/backups/files");
const { restoreAccountBackup } = await import("@/lib/backups/restore");
const { exclusiveDataOperation, protectDataOperation } = await import("@/lib/server/data-operations");
const { indexDocument } = await import("@/lib/documents/store");
const { saveChatMessage } = await import("@/lib/chat/store");
const { encodeMediaMessage } = await import("@/lib/media/message-codec");
const routes = { root: await import("@/app/api/backups/route"), item: await import("@/app/api/backups/[id]/route"), begin: await import("@/app/api/backups/import/route"), upload: await import("@/app/api/backups/import/[id]/route") };
let cookie;
const req = (path, method="GET", body, session=cookie, headers={}) => new NextRequest(`http://localhost${path}`, { method, headers: { cookie: session, "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const context = id => ({ params: Promise.resolve({ id }) });
const payload = async (response, code=200) => { assert.equal(response.status,code,await response.clone().text()); return response.json(); };
beforeEach(async t => { t.mock.method(console,"error",()=>{}); globalThis.__privateAiRateLimitStore?.clear(); cookie = localAccessCookie();
 for (const file of await files.listBackupFiles()) await files.removeBackupFile(file.id, file.extension);
 await db.message.deleteMany({});
 await db.chat.deleteMany({});
 await db.memory.deleteMany({});
 await db.task.deleteMany({});
 await db.knowledgeDocument.deleteMany({});
 await db.mediaAsset.deleteMany({});
 await db.modelRequest.deleteMany({});
 await db.workspacePreference.deleteMany({}); });
after(async()=>{await db.$disconnect();cleanup();});
async function seed() {
  const chat=await db.chat.create({data:{ title:"Backup source",tags:{create:{label:"保留"}}}});
  const input=await storage.createMediaAsset({ bytes:testPng,mediaType:"image/png",kind:"attachment"});
  const output=await storage.createMediaAsset({ bytes:testPng,mediaType:"image/png",kind:"generated-image",sourceChatId:chat.id,generation:{version:1,type:"image",modelId:"google/gemini-2.5-flash-image",prompt:"Saved",inputImages:[{assetId:input.id,mediaType:"image/png"}]}});
  await saveChatMessage({chatId:chat.id,role:"assistant",content:encodeMediaMessage({type:"image-result",modelId:"google/gemini-2.5-flash-image",text:"Saved image",assetId:output.id})});
  await db.memory.create({data:{ key:"preference",value:"保存中文",embedding:[1,0,0]}});
  await db.task.create({data:{ title:"Reminder",dueDate:new Date(Date.now()+60_000),reminderEnabled:true}});
  await indexDocument({filename:"backup.txt",format:"txt",byteSize:6,pages:[{pageNumber:null,text:"备份检索示例"}]});
  return {chat,input,output};
}
test("account backups restore business rows, media dependencies and search without carrying credentials",async()=>{
  const original=await seed();
  const backup=await exclusiveDataOperation(()=>archive.createAccountBackup());
  const raw=await readFile(await files.backupFile(backup.id));
  assert.equal(raw.subarray(0,8).toString(),"PAIB0001");
  for(const secret of ["passwordHash","tokenHash","relativePath","local_access"]) assert.equal(raw.includes(Buffer.from(secret)),false);
  await db.chat.update({where:{id:original.chat.id},data:{title:"Changed"}});
  const result=await exclusiveDataOperation(()=>restoreAccountBackup(backup.id));
  assert.ok(result.safetyBackupId);
  const restored=await db.chat.findFirst({where:{},include:{messages:true,tags:true}});
  assert.equal(restored.title,"Backup source"); assert.notEqual(restored.id,original.chat.id); assert.equal(restored.tags[0].label,"保留");
  const output=await db.mediaAsset.findFirst({where:{ kind:"generated-image"},include:{inputs:true,references:true}});
  assert.equal(output.sourceChatId,restored.id); assert.equal(output.references.length,1); assert.equal(output.inputs.length,1);
  assert.ok(restored.messages[0].content.includes(output.id)); assert.equal(restored.messages[0].content.includes(original.output.id),false);
  assert.deepEqual(await storage.readMediaAsset(output),testPng);
  assert.equal((await db.task.findFirst({where:{}})).reminderEnabled,false);
  assert.equal(await db.documentTerm.count({where:{chunk:{document:{}}}})>0,true);
  await db.$disconnect(); assert.equal((await archive.inspectAccountBackup(backup.id)).counts.assets,2);
});

test("archives exported by the account-scoped build keep importing and restoring",async()=>{
  await seed();
  const backup=await exclusiveDataOperation(()=>archive.createAccountBackup());
  // The manifest header is a frozen wire contract. Archives exported before the
  // workspace became single-user carry exactly these identifiers and these row
  // shapes, so changing either one silently strands the user's old exports.
  const handle=await files.openBackup(backup.id);
  let manifest;
  try { ({ manifest } = await archive.readBackupManifest(handle)); } finally { await handle.close(); }
  assert.equal(manifest.format,"private-ai-account-backup");
  assert.equal(manifest.version,1);
  const raw=await readFile(await files.backupFile(backup.id));
  // The old per-account columns were never part of the archive, which is what
  // lets the same file be read back into the workspace schema unchanged.
  assert.equal(raw.includes(Buffer.from("userId")),false);

  const result=await exclusiveDataOperation(()=>restoreAccountBackup(backup.id));
  assert.equal(result.restored,true);
  assert.equal(await db.chat.count(),1);
  assert.equal((await db.task.findFirst({where:{}})).title,"Reminder");
  assert.equal(await db.knowledgeDocument.count(),1);
});

test("restore remaps structured references without rewriting user-authored text that resembles IDs or media URLs",async()=>{
  const original=await seed();
  const value={type:"user-message",text:original.chat.id,files:[{url:`/api/media/${original.input.id}`,mediaType:"image/png",filename:`/api/media/${original.input.id}`}]};
  await saveChatMessage({chatId:original.chat.id,role:"user",content:`__USER_MESSAGE__:${JSON.stringify(value)}`});
  const backup=await exclusiveDataOperation(()=>archive.createAccountBackup());await exclusiveDataOperation(()=>restoreAccountBackup(backup.id));
  const message=await db.message.findFirst({where:{chat:{},role:"user"}}),restored=JSON.parse(message.content.slice("__USER_MESSAGE__:".length));
  assert.equal(restored.text,original.chat.id);assert.equal(restored.files[0].filename,value.files[0].filename);assert.notEqual(restored.files[0].url,value.files[0].url);
});
test("backup import uses bounded ordered chunks and can restore into a different account",async()=>{
  await seed(); const backup=await exclusiveDataOperation(()=>archive.createAccountBackup()); const bytes=await readFile(await files.backupFile(backup.id)); cookie=localAccessCookie();
  const {data}=await payload(await routes.begin.POST(req("/api/backups/import","POST",{bytes:bytes.length})),201);
  for(let offset=0;offset<bytes.length;offset+=73) {
    const body=bytes.subarray(offset,offset+73);
    const response=await routes.upload.PUT(new NextRequest(`http://localhost/api/backups/import/${data.id}?offset=${offset}`,{method:"PUT",headers:{cookie,"content-type":"application/octet-stream"},body}),context(data.id));
    await payload(response);
  }
  await payload(await routes.upload.POST(req(`/api/backups/import/${data.id}`,"POST"),context(data.id)),201);
  await payload(await routes.item.POST(req(`/api/backups/${data.id}`,"POST",{confirm:true}),context(data.id)));
  assert.equal(await db.mediaAsset.count({where:{}}),2);
});
test("corrupt, incomplete and unconfirmed backups never replace live data",async()=>{
  const original=await seed(); const backup=await exclusiveDataOperation(()=>archive.createAccountBackup()); const file=await files.backupFile(backup.id); const bytes=await readFile(file);
  assert.equal((await routes.item.POST(req(`/api/backups/${backup.id}`,"POST",{confirm:false}),context(backup.id))).status,400);
  bytes[45]^=1; await writeFile(file,bytes);
  assert.equal((await routes.item.POST(req(`/api/backups/${backup.id}`,"POST",{confirm:true}),context(backup.id))).status,400);
  assert.equal((await db.chat.findUnique({where:{id:original.chat.id}})).title,"Backup source");
  const {data}=await payload(await routes.begin.POST(req("/api/backups/import","POST",{bytes:100})),201);
  assert.equal((await routes.upload.POST(req(`/api/backups/import/${data.id}`,"POST"),context(data.id))).status,409);
  await payload(await routes.upload.DELETE(req(`/api/backups/import/${data.id}`,"DELETE"),context(data.id)));
});

test("portable backups refuse unresolved legacy videos instead of silently omitting their files",async()=>{
  const chat=await db.chat.create({data:{ title:"Legacy video",messages:{create:{role:"assistant",content:'__VIDEO_RESULT__:{"type":"video-result","modelId":"old/model","text":"Legacy","videoUrl":"/generated-videos/old.mp4"}'}}}});
  await assert.rejects(exclusiveDataOperation(()=>archive.createAccountBackup()),/尚未迁移的旧视频/);
  assert.ok(await db.chat.findUnique({where:{id:chat.id}}));assert.equal((await files.listBackupFiles()).length,0);
});
test("backup boundaries reject expiry, origins, oversize chunks and invalid offsets",async()=>{
  const backup=await exclusiveDataOperation(()=>archive.createAccountBackup());
  assert.equal((await routes.root.POST(req("/api/backups","POST",undefined,""))).status,401);
  assert.equal((await routes.root.POST(req("/api/backups","POST",undefined,cookie,{origin:"https://outside.invalid"}))).status,403);
  assert.equal((await routes.item.GET(req(`/api/backups/${backup.id}`,"GET",undefined,""),context(backup.id))).status,401);
  const {data}=await payload(await routes.begin.POST(req("/api/backups/import","POST",{bytes:50})),201);
  const overflow=new NextRequest(`http://localhost/api/backups/import/${data.id}?offset=0`,{method:"PUT",headers:{cookie,"content-type":"application/octet-stream"},body:Buffer.alloc(51)});
  assert.equal((await routes.upload.PUT(overflow,context(data.id))).status,413);
  const listed=await payload(await routes.root.GET(req("/api/backups")));
  assert.equal(listed.data.some(file=>file.id===backup.id),true);
  assert.equal((await routes.root.GET(req("/api/backups","GET",undefined,""))).status,401);
});
test("backup maintenance retains the newest complete backup and ignores unrecognized or linked files",async()=>{
  const old=await exclusiveDataOperation(()=>archive.createAccountBackup(false)); const newest=await exclusiveDataOperation(()=>archive.createAccountBackup(false));
  await utimes(await files.backupFile(old.id),new Date(0),new Date(0));
  const directory=await files.backupDirectory(); await writeFile(join(directory,"keep.txt"),"untouched");
  assert.equal((await archive.pruneAccountBackups()).removed,1);
  assert.equal((await files.listBackupFiles()).some(file=>file.id===newest.id),true);
  assert.equal(await readFile(join(directory,"keep.txt"),"utf8"),"untouched");
  const victim=join(dirname(directory),"outside"); await mkdir(victim); const link=join(directory,`${randomUUID()}.paib`);
  await symlink(victim,link,"junction"); assert.equal((await files.listBackupFiles()).some(file=>link.endsWith(`${file.id}.paib`)),false);
});

test("a database failure rolls back restored rows and keeps original files plus a safety backup",async()=>{
  const original=await seed();const backup=await exclusiveDataOperation(()=>archive.createAccountBackup());
  await db.chat.update({where:{id:original.chat.id},data:{title:"Live changes"}});
  await db.$executeRawUnsafe("CREATE TRIGGER reject_restore_memory BEFORE INSERT ON memories BEGIN SELECT RAISE(ABORT, 'Synthetic restore failure'); END");
  try {
    await assert.rejects(exclusiveDataOperation(()=>restoreAccountBackup(backup.id)));
    assert.equal((await db.chat.findUnique({where:{id:original.chat.id}})).title,"Live changes");
    assert.deepEqual(await storage.readMediaAsset(await db.mediaAsset.findUnique({where:{id:original.output.id}})),testPng);
    assert.equal((await files.listBackupFiles()).filter(file=>file.extension==="paib").length,2);
    assert.equal(await db.memory.count({where:{}}),1);
  } finally { await db.$executeRawUnsafe("DROP TRIGGER reject_restore_memory"); }
});

test("checksummed but inconsistent backup relationships and media bytes are rejected before restoring",async()=>{
  const original=await seed();const backup=await exclusiveDataOperation(()=>archive.createAccountBackup());const path=await files.backupFile(backup.id),raw=await readFile(path);
  const length=raw.readUInt32BE(8),manifest=JSON.parse(raw.subarray(44,44+length));
  const change=async transform=>{
    const next=structuredClone(manifest);transform(next);const json=Buffer.from(JSON.stringify(next));const header=Buffer.from(raw.subarray(0,44));header.writeUInt32BE(json.length,8);createHash("sha256").update(json).digest().copy(header,12);await writeFile(path,Buffer.concat([header,json,raw.subarray(44+length)]));
    assert.equal((await routes.item.POST(req(`/api/backups/${backup.id}`,"POST",{confirm:true}),context(backup.id))).status,400);
    assert.ok(await db.chat.findUnique({where:{id:original.chat.id}}));
  };
  await change(next=>next.chats[0].tags.push(next.chats[0].tags[0]));
  await change(next=>next.assets[0].relativePath="../outside.png");
  await change(next=>{const input=next.assets.find(asset=>asset.id===original.input.id);input.inputs=[{assetId:input.id,inputAssetId:original.output.id}];input.generation={version:1,type:"image",modelId:"google/gemini-2.5-flash-image",prompt:"Cycle",inputImages:[{assetId:original.output.id,mediaType:"image/png"}]};});
  raw[raw.length-1]^=1;await writeFile(path,raw);
  assert.equal((await routes.item.POST(req(`/api/backups/${backup.id}`,"POST",{confirm:true}),context(backup.id))).status,400);
  assert.equal((await files.listBackupFiles()).filter(file=>file.extension==="paib").length,1);
});

test("restored pending messages cannot replay approvals and cleanup cannot undo a completed backup",async()=>{
  const chat=await db.chat.create({data:{ title:"Approval history",messages:{create:{role:"assistant",status:"pending",content:'__ASSISTANT_TOOL_MESSAGE__:{"tools":[{"state":"approval-requested","approval":{"id":"old-approval"}}]}'}}}});
  const backup=await exclusiveDataOperation(()=>archive.createAccountBackup());
  await exclusiveDataOperation(()=>restoreAccountBackup(backup.id));
  const message=await db.message.findFirst({where:{chat:{}}});assert.equal(message.status,"error");assert.match(message.content,/output-denied/);assert.equal(message.content.includes("old-approval"),false);assert.equal(await db.chat.findUnique({where:{id:chat.id}}),null);
  await db.workspacePreference.upsert({where:{id:"local"},create:{id:"local",settings:{invalid:true}},update:{settings:{invalid:true}}});
  assert.equal((await archive.pruneAccountBackupsSafely()).failed,1);
});
test("restore refuses active writes and streams and releases its gate after failures",async()=>{
  let release; const pending=new Promise(resolve=>{release=resolve;});
  const route=protectDataOperation(async()=>{await pending;return Response.json({ok:true});});
  const inFlight=route(req("/api/test"));
  try { await assert.rejects(exclusiveDataOperation(async()=>{}),/仍有请求/); } finally {release();await inFlight;}
  const streaming=protectDataOperation(async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode("data: sample\n\n"));controller.close();}}),{headers:{"Content-Type":"text/event-stream"}}));
  const response=await streaming(req("/api/test")); await assert.rejects(exclusiveDataOperation(async()=>{}),/仍有请求/); await response.text();
  await assert.rejects(exclusiveDataOperation(async()=>{throw new Error("Expected");}),/Expected/); await exclusiveDataOperation(async()=>{});
});
