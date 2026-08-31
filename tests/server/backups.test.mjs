import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile, utimes, symlink, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database.mjs";
import { testPng } from "../helpers/model-provider.mjs";
const cleanup = createTestDatabase();
const { db } = await import("@/db");
const { createSession } = await import("@/lib/auth/session");
const storage = await import("@/lib/media/storage");
const archive = await import("@/lib/backups/archive");
const files = await import("@/lib/backups/files");
const { restoreAccountBackup } = await import("@/lib/backups/restore");
const { exclusiveDataOperation, protectDataOperation } = await import("@/lib/server/data-operations");
const { indexDocument } = await import("@/lib/documents/store");
const { saveChatMessage } = await import("@/lib/chat/store");
const { encodeMediaMessage } = await import("@/lib/media/message-codec");
const routes = { root: await import("@/app/api/backups/route"), item: await import("@/app/api/backups/[id]/route"), begin: await import("@/app/api/backups/import/route"), upload: await import("@/app/api/backups/import/[id]/route") };
let user, cookie;
const req = (path, method="GET", body, session=cookie, headers={}) => new NextRequest(`http://localhost${path}`, { method, headers: { cookie: session, "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const context = id => ({ params: Promise.resolve({ id }) });
const payload = async (response, code=200) => { assert.equal(response.status,code,await response.clone().text()); return response.json(); };
beforeEach(async t => { t.mock.method(console,"error",()=>{}); globalThis.__privateAiRateLimitStore?.clear(); user=await db.user.create({data:{email:`${randomUUID()}@example.invalid`}}); cookie=`app_session=${await createSession(user.id)}`; });
after(async()=>{await db.$disconnect();cleanup();});
async function seed() {
  const chat=await db.chat.create({data:{userId:user.id,title:"Backup source",tags:{create:{label:"保留"}}}});
  const input=await storage.createMediaAsset({userId:user.id,bytes:testPng,mediaType:"image/png",kind:"attachment"});
  const output=await storage.createMediaAsset({userId:user.id,bytes:testPng,mediaType:"image/png",kind:"generated-image",sourceChatId:chat.id,generation:{version:1,type:"image",modelId:"google/gemini-2.5-flash-image",prompt:"Saved",inputImages:[{assetId:input.id,mediaType:"image/png"}]}});
  await saveChatMessage({chatId:chat.id,role:"assistant",content:encodeMediaMessage({type:"image-result",modelId:"google/gemini-2.5-flash-image",text:"Saved image",assetId:output.id})});
  await db.memory.create({data:{userId:user.id,key:"preference",value:"保存中文",embedding:[1,0,0]}});
  await db.task.create({data:{userId:user.id,title:"Reminder",dueDate:new Date(Date.now()+60_000),reminderEnabled:true}});
  await indexDocument(user.id,{filename:"backup.txt",format:"txt",byteSize:6,pages:[{pageNumber:null,text:"备份检索示例"}]});
  return {chat,input,output};
}
test("account backups restore business rows, media dependencies and search while preserving login and other users",async()=>{
  const original=await seed(); const foreign=await db.user.create({data:{email:`${randomUUID()}@example.invalid`,chats:{create:{title:"Unchanged"}}}});
  const backup=await exclusiveDataOperation(()=>archive.createAccountBackup(user.id));
  const raw=await readFile(await files.backupFile(user.id,backup.id));
  assert.equal(raw.subarray(0,8).toString(),"PAIB0001");
  for(const secret of ["passwordHash","tokenHash","relativePath",user.email]) assert.equal(raw.includes(Buffer.from(secret)),false);
  await db.chat.update({where:{id:original.chat.id},data:{title:"Changed"}});
  const result=await exclusiveDataOperation(()=>restoreAccountBackup(user.id,backup.id));
  assert.ok(result.safetyBackupId);
  const restored=await db.chat.findFirst({where:{userId:user.id},include:{messages:true,tags:true}});
  assert.equal(restored.title,"Backup source"); assert.notEqual(restored.id,original.chat.id); assert.equal(restored.tags[0].label,"保留");
  const output=await db.mediaAsset.findFirst({where:{userId:user.id,kind:"generated-image"},include:{inputs:true,references:true}});
  assert.equal(output.sourceChatId,restored.id); assert.equal(output.references.length,1); assert.equal(output.inputs.length,1);
  assert.ok(restored.messages[0].content.includes(output.id)); assert.equal(restored.messages[0].content.includes(original.output.id),false);
  assert.deepEqual(await storage.readMediaAsset(output),testPng);
  assert.equal((await db.task.findFirst({where:{userId:user.id}})).reminderEnabled,false);
  assert.equal(await db.documentTerm.count({where:{chunk:{document:{userId:user.id}}}})>0,true);
  assert.equal(await db.session.count({where:{userId:user.id}}),1); assert.equal(await db.chat.count({where:{userId:foreign.id}}),1);
  await db.$disconnect(); assert.equal((await archive.inspectAccountBackup(user.id,backup.id)).counts.assets,2);
});

test("restore remaps structured references without rewriting user-authored text that resembles IDs or media URLs",async()=>{
  const original=await seed();
  const value={type:"user-message",text:original.chat.id,files:[{url:`/api/media/${original.input.id}`,mediaType:"image/png",filename:`/api/media/${original.input.id}`}]};
  await saveChatMessage({chatId:original.chat.id,role:"user",content:`__USER_MESSAGE__:${JSON.stringify(value)}`});
  const backup=await exclusiveDataOperation(()=>archive.createAccountBackup(user.id));await exclusiveDataOperation(()=>restoreAccountBackup(user.id,backup.id));
  const message=await db.message.findFirst({where:{chat:{userId:user.id},role:"user"}}),restored=JSON.parse(message.content.slice("__USER_MESSAGE__:".length));
  assert.equal(restored.text,original.chat.id);assert.equal(restored.files[0].filename,value.files[0].filename);assert.notEqual(restored.files[0].url,value.files[0].url);
});
test("backup import uses bounded ordered chunks and can restore into a different account",async()=>{
  await seed(); const backup=await exclusiveDataOperation(()=>archive.createAccountBackup(user.id)); const bytes=await readFile(await files.backupFile(user.id,backup.id));
  user=await db.user.create({data:{email:`${randomUUID()}@example.invalid`}}); cookie=`app_session=${await createSession(user.id)}`;
  const {data}=await payload(await routes.begin.POST(req("/api/backups/import","POST",{bytes:bytes.length})),201);
  for(let offset=0;offset<bytes.length;offset+=73) {
    const body=bytes.subarray(offset,offset+73);
    const response=await routes.upload.PUT(new NextRequest(`http://localhost/api/backups/import/${data.id}?offset=${offset}`,{method:"PUT",headers:{cookie,"content-type":"application/octet-stream"},body}),context(data.id));
    await payload(response);
  }
  await payload(await routes.upload.POST(req(`/api/backups/import/${data.id}`,"POST"),context(data.id)),201);
  await payload(await routes.item.POST(req(`/api/backups/${data.id}`,"POST",{confirm:true}),context(data.id)));
  assert.equal(await db.mediaAsset.count({where:{userId:user.id}}),2);
});
test("corrupt, incomplete and unconfirmed backups never replace live data",async()=>{
  const original=await seed(); const backup=await exclusiveDataOperation(()=>archive.createAccountBackup(user.id)); const file=await files.backupFile(user.id,backup.id); const bytes=await readFile(file);
  assert.equal((await routes.item.POST(req(`/api/backups/${backup.id}`,"POST",{confirm:false}),context(backup.id))).status,400);
  bytes[45]^=1; await writeFile(file,bytes);
  assert.equal((await routes.item.POST(req(`/api/backups/${backup.id}`,"POST",{confirm:true}),context(backup.id))).status,400);
  assert.equal((await db.chat.findUnique({where:{id:original.chat.id}})).title,"Backup source");
  const {data}=await payload(await routes.begin.POST(req("/api/backups/import","POST",{bytes:100})),201);
  assert.equal((await routes.upload.POST(req(`/api/backups/import/${data.id}`,"POST"),context(data.id))).status,409);
  await payload(await routes.upload.DELETE(req(`/api/backups/import/${data.id}`,"DELETE"),context(data.id)));
});

test("portable backups refuse unresolved legacy videos instead of silently omitting their files",async()=>{
  const chat=await db.chat.create({data:{userId:user.id,title:"Legacy video",messages:{create:{role:"assistant",content:'__VIDEO_RESULT__:{"type":"video-result","modelId":"old/model","text":"Legacy","videoUrl":"/generated-videos/old.mp4"}'}}}});
  await assert.rejects(exclusiveDataOperation(()=>archive.createAccountBackup(user.id)),/尚未迁移的旧视频/);
  assert.ok(await db.chat.findUnique({where:{id:chat.id}}));assert.equal((await files.listBackupFiles(user.id)).length,0);
});
test("backup boundaries reject foreign ownership, expiry, origins, oversize chunks and invalid offsets",async()=>{
  const backup=await exclusiveDataOperation(()=>archive.createAccountBackup(user.id));
  assert.equal((await routes.root.POST(req("/api/backups","POST",undefined,""))).status,401);
  assert.equal((await routes.root.POST(req("/api/backups","POST",undefined,cookie,{origin:"https://outside.invalid"}))).status,403);
  const other=await db.user.create({data:{email:`${randomUUID()}@example.invalid`}}), otherCookie=`app_session=${await createSession(other.id)}`;
  assert.equal((await routes.item.GET(req(`/api/backups/${backup.id}`,"GET",undefined,otherCookie),context(backup.id))).status,404);
  const {data}=await payload(await routes.begin.POST(req("/api/backups/import","POST",{bytes:50})),201);
  const overflow=new NextRequest(`http://localhost/api/backups/import/${data.id}?offset=0`,{method:"PUT",headers:{cookie,"content-type":"application/octet-stream"},body:Buffer.alloc(51)});
  assert.equal((await routes.upload.PUT(overflow,context(data.id))).status,413);
  await db.session.updateMany({where:{userId:user.id},data:{expiresAt:new Date(0)}});
  assert.equal((await routes.root.GET(req("/api/backups"))).status,401);
});
test("backup maintenance retains the newest complete backup and ignores unrecognized or linked files",async()=>{
  const old=await exclusiveDataOperation(()=>archive.createAccountBackup(user.id,false)); const newest=await exclusiveDataOperation(()=>archive.createAccountBackup(user.id,false));
  await utimes(await files.backupFile(user.id,old.id),new Date(0),new Date(0));
  const directory=await files.backupDirectory(user.id); await writeFile(join(directory,"keep.txt"),"untouched");
  assert.equal((await archive.pruneAccountBackups(user.id)).removed,1);
  assert.equal((await files.listBackupFiles(user.id)).some(file=>file.id===newest.id),true);
  assert.equal(await readFile(join(directory,"keep.txt"),"utf8"),"untouched");
  const victim=join(dirname(directory),"outside"); await mkdir(victim); const link=join(directory,`${randomUUID()}.paib`);
  await symlink(victim,link,"junction"); assert.equal((await files.listBackupFiles(user.id)).some(file=>link.endsWith(`${file.id}.paib`)),false);
});

test("a database failure rolls back restored rows and keeps original files plus a safety backup",async()=>{
  const original=await seed();const backup=await exclusiveDataOperation(()=>archive.createAccountBackup(user.id));
  await db.chat.update({where:{id:original.chat.id},data:{title:"Live changes"}});
  await db.$executeRawUnsafe("CREATE TRIGGER reject_restore_memory BEFORE INSERT ON memories BEGIN SELECT RAISE(ABORT, 'Synthetic restore failure'); END");
  try {
    await assert.rejects(exclusiveDataOperation(()=>restoreAccountBackup(user.id,backup.id)));
    assert.equal((await db.chat.findUnique({where:{id:original.chat.id}})).title,"Live changes");
    assert.deepEqual(await storage.readMediaAsset(await db.mediaAsset.findUnique({where:{id:original.output.id}})),testPng);
    assert.equal((await files.listBackupFiles(user.id)).filter(file=>file.extension==="paib").length,2);
    assert.equal(await db.memory.count({where:{userId:user.id}}),1);
  } finally { await db.$executeRawUnsafe("DROP TRIGGER reject_restore_memory"); }
});

test("checksummed but inconsistent backup relationships and media bytes are rejected before restoring",async()=>{
  const original=await seed();const backup=await exclusiveDataOperation(()=>archive.createAccountBackup(user.id));const path=await files.backupFile(user.id,backup.id),raw=await readFile(path);
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
  assert.equal((await files.listBackupFiles(user.id)).filter(file=>file.extension==="paib").length,1);
});

test("restored pending messages cannot replay approvals and cleanup cannot undo a completed backup",async()=>{
  const chat=await db.chat.create({data:{userId:user.id,title:"Approval history",messages:{create:{role:"assistant",status:"pending",content:'__ASSISTANT_TOOL_MESSAGE__:{"tools":[{"state":"approval-requested","approval":{"id":"old-approval"}}]}'}}}});
  const backup=await exclusiveDataOperation(()=>archive.createAccountBackup(user.id));
  await exclusiveDataOperation(()=>restoreAccountBackup(user.id,backup.id));
  const message=await db.message.findFirst({where:{chat:{userId:user.id}}});assert.equal(message.status,"error");assert.match(message.content,/output-denied/);assert.equal(message.content.includes("old-approval"),false);assert.equal(await db.chat.findUnique({where:{id:chat.id}}),null);
  await db.accountPreference.update({where:{userId:user.id},data:{settings:{invalid:true}}});
  assert.equal((await archive.pruneAccountBackupsSafely(user.id)).failed,1);
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
