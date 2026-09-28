import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { NextRequest } from "next/server";
import { MockLanguageModelV3 } from "ai/test";
import { createTestDatabase } from "../helpers/database.mjs";
import { localAccessCookie } from "../helpers/local-access.mjs";
import { CHAT_MODEL_REF, IMAGE_MODEL_REF, VIDEO_MODEL_REF, seedTestModelPreferences } from "../helpers/model-library.mjs";
const cleanup=createTestDatabase(); process.env.PRIVATE_AI_TEST_PROVIDER="1";
const {db}=await import("@/db");
const {getModelPreferences,saveModelPreferences,removeModel,withModelLease}=await import("@/lib/models/preferences");
const {preferredModel}=await import("@/lib/models/preferences");
const {defaultModelPreferences,providerIds,upgradeModelPreferences}=await import("@/lib/models/preferences-schema");
const {listModelProviders,getModelProvider}=await import("@/lib/models/providers");
const {usageCost,recordModelAttempt,usageSummary}=await import("@/lib/models/usage");
const {observeLanguageModel}=await import("@/lib/models/observe-language");
const {getChatModel}=await import("@/lib/ai/client");
const {protectDataOperation}=await import("@/lib/server/data-operations"), {requireLocalWorkspace}=await import("@/lib/local/workspace");
const {getImageModel,providerState,resetProviderState,testPng}=await import("../helpers/model-provider.mjs");
const imageRoute=await import("@/app/api/image/route");
const models=await import("@/app/api/models/route"), usageRoute=await import("@/app/api/usage/route");
const catalogRoute=await import("@/app/api/models/catalog/route"), libraryRoute=await import("@/app/api/models/library/route");
const reindexRoute=await import("@/app/api/memory/reindex/route");
const ref=modelId=>({providerId:"openrouter",modelId});
// A stored catalog row, as `addModel` reads it back from the snapshot table.
const catalogRow=(modelId,modes)=>({providerId:"openrouter",modelId,name:modelId,description:"",modes,supportsImageInput:false,endpointImageInput:null,supportsTools:false,contextLength:null,pricing:{}});
const storeSnapshot=(mode,rows)=>db.modelCatalogSnapshot.upsert({where:{providerId_mode:{providerId:"openrouter",mode}},create:{providerId:"openrouter",mode,fetchedAt:new Date(),models:rows},update:{fetchedAt:new Date(),models:rows}});
const addCatalogModel=async(modelId,modes)=>{await storeSnapshot(modes[0],[catalogRow(modelId,modes)]);await (await import("@/lib/models/preferences")).addModel(ref(modelId));};
let user,cookie;
const req=(path,method="GET",body,session=cookie,headers={})=>new NextRequest(`http://localhost${path}`,{method,headers:{cookie:session,"content-type":"application/json",...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
const payload=async(response,status=200)=>{assert.equal(response.status,status,await response.clone().text());return response.json();};
beforeEach(async t=>{t.mock.method(console,"error",()=>{});globalThis.__privateAiRateLimitStore?.clear();cookie = localAccessCookie();
await db.message.deleteMany({});
await db.chat.deleteMany({});
await db.memory.deleteMany({});
await db.modelRequest.deleteMany({});
await db.modelCatalogSnapshot.deleteMany({});
await db.workspacePreference.deleteMany({});
await db.task.deleteMany({});
await db.knowledgeDocument.deleteMany({});
await db.mediaAsset.deleteMany({});
process.env.OPENROUTER_API_KEY="offline-placeholder";resetProviderState();await seedTestModelPreferences(db);});
after(async()=>{await db.$disconnect();cleanup();});
test("model preferences persist in the workspace and reject unavailable models, duplicate fallbacks and invalid prices",async()=>{
  const settings=await getModelPreferences();settings.chat.model=ref("google/gemini-3-flash-preview");settings.chat.fallback=ref("anthropic/claude-opus-4.6");settings.defaultMode="image";
  await payload(await models.PUT(req("/api/models","PUT",settings)));await db.$disconnect();assert.deepEqual((await payload(await models.GET(req("/api/models")))).data,settings);
  for(const changed of [{...settings,chat:{model:ref("removed/model"),fallback:null}},{...settings,chat:{model:settings.chat.model,fallback:settings.chat.model}},{...settings,rates:{"openrouter:model":{inputPerMillion:-1,outputPerMillion:null,perRequest:null}}}]) assert.equal((await models.PUT(req("/api/models","PUT",changed))).status,400);assert.deepEqual(await getModelPreferences(),settings);
  // The library is owned by the add/remove endpoints, so a settings write
  // cannot smuggle an entry in: the stored library is the one that is kept.
  await payload(await models.PUT(req("/api/models","PUT",{...settings,library:[...settings.library,{...settings.library[0],modelId:"smuggled/model"}]})));
  assert.deepEqual((await getModelPreferences()).library,settings.library);
});
test("every registered provider id is one a stored model reference may name",()=>{
  // A library row names a provider by id. An adapter that is registered but
  // missing from `providerIds` could be called but never stored, which is
  // exactly the kind of gap that only shows up on a user's machine.
  for(const provider of listModelProviders()) assert.ok(providerIds.includes(provider.id),`${provider.id} is not in providerIds`);
  assert.equal(getModelProvider("openrouter").id,"openrouter");
  assert.throws(()=>getModelProvider("unknown"),/Unknown model provider/);
});
test("new installations start empty and old saved model IDs migrate only as candidates",async()=>{
  const empty=defaultModelPreferences();
  assert.deepEqual(empty.library,[]);assert.equal(empty.chat.model,null);assert.equal(empty.image.model,null);assert.equal(empty.embedding,null);
  const old={version:1,defaultMode:"chat",chat:{modelId:"old/chat",fallbackId:"old/fallback"},image:{modelId:"old/image",fallbackId:null},video:{modelId:"old/video",fallbackId:null},rates:{},backupRetentionDays:30,backupMaxCount:10};
  const upgraded=upgradeModelPreferences(old,"old/embed");
  assert.equal(upgraded.chat.model,null);assert.equal(upgraded.chat.fallback,null);assert.equal(upgraded.embedding,null);
  assert.deepEqual(upgraded.legacyCandidates.map(candidate=>candidate.ref),[ref("old/chat"),ref("old/fallback"),ref("old/image"),ref("old/video"),ref("old/embed")]);
  assert.deepEqual(upgraded.legacyCandidates.map(candidate=>candidate.mode),["chat","chat","image","video","embedding"]);
  assert.equal(upgraded.embedding,null);
});
test("the library era upgrades to provider-qualified references instead of losing them",()=>{
  // Version 2 is not a guess: every model in it was reached through OpenRouter,
  // so the conversion is a relabelling and the selections stay active.
  const library=[{providerId:"openrouter",modelId:"anthropic/claude-opus-4.6",name:"Claude",description:"",modes:["chat","embedding"],supportsImageInput:false,endpointImageInput:null,supportsTools:true,contextLength:null,pricing:{},addedAt:new Date().toISOString(),lastSeenAt:new Date().toISOString()}];
  const v2={version:2,defaultMode:"chat",chat:{modelId:"anthropic/claude-opus-4.6",fallbackId:null},image:{modelId:null,fallbackId:null},video:{modelId:null,fallbackId:null},embeddingModelId:"anthropic/claude-opus-4.6",library,
    rates:{"anthropic/claude-opus-4.6":{inputPerMillion:3,outputPerMillion:15,perRequest:null}},backupRetentionDays:30,backupMaxCount:10};
  const upgraded=upgradeModelPreferences(v2);
  assert.equal(upgraded.version,3);
  assert.deepEqual(upgraded.chat,{model:ref("anthropic/claude-opus-4.6"),fallback:null});
  assert.deepEqual(upgraded.image,{model:null,fallback:null});
  assert.deepEqual(upgraded.embedding,ref("anthropic/claude-opus-4.6"));
  assert.deepEqual(upgraded.library,library);
  // Rates are keyed by provider and model, so a bare key from the old era is
  // prefixed rather than silently dropped.
  assert.deepEqual(upgraded.rates,{"openrouter:anthropic/claude-opus-4.6":{inputPerMillion:3,outputPerMillion:15,perRequest:null}});
  // A key that already carried a provider is left exactly as it is.
  const kept=upgradeModelPreferences({...v2,rates:{"openrouter:anthropic/claude-opus-4.6":{inputPerMillion:3,outputPerMillion:15,perRequest:null}}});
  assert.deepEqual(Object.keys(kept.rates),["openrouter:anthropic/claude-opus-4.6"]);
  // Reading an unsupported version is refused rather than silently reset.
  assert.throws(()=>upgradeModelPreferences({version:9}),/Unsupported model preference schema/);
});
test("a stored version 1 or 2 workspace upgrades in place on read",async()=>{
  const libraryEntry={providerId:"openrouter",modelId:CHAT_MODEL_REF.modelId,name:"Chat",description:"",modes:["chat"],supportsImageInput:false,endpointImageInput:null,supportsTools:true,contextLength:null,pricing:{},addedAt:new Date().toISOString(),lastSeenAt:new Date().toISOString()};
  for(const [settings,expected] of [
    // Version 1 predates the library, so the id cannot become an active
    // selection; it is preserved as a migration candidate.
    [{version:1,defaultMode:"chat",chat:{modelId:CHAT_MODEL_REF.modelId,fallbackId:null},image:{modelId:"old/image",fallbackId:null},video:{modelId:"old/video",fallbackId:null},rates:{},backupRetentionDays:30,backupMaxCount:10},{model:null,candidates:["anthropic/claude-opus-4.6","old/image","old/video"].map(ref)}],
    // Version 2 is a relabelling of a workspace that already had the model
    // added, so the selection stays active.
    [{version:2,defaultMode:"chat",chat:{modelId:CHAT_MODEL_REF.modelId,fallbackId:null},image:{modelId:null,fallbackId:null},video:{modelId:null,fallbackId:null},embeddingModelId:null,library:[libraryEntry],rates:{},backupRetentionDays:30,backupMaxCount:10},{model:CHAT_MODEL_REF,candidates:[]}],
  ]) {
    await db.workspacePreference.upsert({where:{id:"local"},create:{id:"local",settings},update:{settings}});
    const read=await getModelPreferences();
    assert.equal(read.version,3);
    assert.deepEqual(read.chat.model,expected.model);
    assert.deepEqual(read.legacyCandidates.map(candidate=>candidate.ref),expected.candidates);
    // The upgrade is persisted, so the next read is an ordinary version 3 read.
    assert.deepEqual((await db.workspacePreference.findUnique({where:{id:"local"}})).settings,read);
  }
});
test("model removal waits for an active provider lease",async()=>{
  const settings=await getModelPreferences();
  let enteredResolve;const entered=new Promise(resolve=>{enteredResolve=resolve;});
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const lease=withModelLease("chat",settings.chat.model,async()=>{enteredResolve();await gate;return "done";});
  await entered;
  let removed=false;
  const removal=removeModel(settings.chat.model).then(()=>{removed=true;});
  assert.equal(await Promise.race([removal.then(()=> "removed"),new Promise(resolve=>setTimeout(()=>resolve("pending"),50))]),"pending");
  release();
  assert.equal(await lease,"done");
  await removal;
  assert.equal(removed,true);
  assert.equal((await getModelPreferences()).chat.model,null);
});
test("model leases serialize authorization without serializing different model calls",async()=>{
  const settings=await getModelPreferences();
  const other=settings.library.find(item=>item.modes.includes("chat")&&item.modelId!==settings.chat.model.modelId);
  assert.ok(other);
  let entered=0,enteredResolve;const bothEntered=new Promise(resolve=>{enteredResolve=resolve;});
  let releaseFirst,releaseSecond;const firstGate=new Promise(resolve=>{releaseFirst=resolve;}),secondGate=new Promise(resolve=>{releaseSecond=resolve;});
  const enter=async()=>{if(++entered===2)enteredResolve();};
  const first=withModelLease("chat",settings.chat.model,async()=>{await enter();await firstGate;return "first";});
  const second=withModelLease("chat",other,async()=>{await enter();await secondGate;return "second";});
  assert.equal(await Promise.race([bothEntered.then(()=> "entered"),new Promise(resolve=>setTimeout(()=>resolve("blocked"),100))]),"entered");
  const removal=removeModel(settings.chat.model);
  assert.equal(await Promise.race([removal.then(()=> "removed"),new Promise(resolve=>setTimeout(()=>resolve("pending"),50))]),"pending");
  await assert.rejects(withModelLease("chat",settings.chat.model,()=>{throw new Error("provider should not be reached");}),/正在移除|不在“我的模型”/);
  releaseFirst();releaseSecond();
  assert.equal(await first,"first");assert.equal(await second,"second");await removal;
  assert.equal((await getModelPreferences()).chat.model,null);
});
test("removing a model clears only the references that named it",async()=>{
  const target=ref("google/gemini-3-flash-preview");
  const settings=await getModelPreferences();
  const other=settings.library.find(item=>item.modes.includes("image")&&item.modelId!==settings.image.model.modelId);
  await addCatalogModel(target.modelId,["chat","embedding"]);
  const owned=await getModelPreferences();
  owned.chat.fallback=target;
  owned.embedding=target;
  owned.image.fallback={providerId:other.providerId,modelId:other.modelId};
  owned.rates[`openrouter:${target.modelId}`]={inputPerMillion:1,outputPerMillion:2,perRequest:null};
  await saveModelPreferences(owned);
  await payload(await libraryRoute.POST(req("/api/models/library","POST",{action:"remove",model:target})));
  const removed=await getModelPreferences();
  assert.equal(removed.chat.fallback,null);
  assert.equal(removed.embedding,null);
  // The default selections and any other reference are untouched: removal is
  // scoped to the one provider and model that was removed.
  assert.deepEqual(removed.chat.model,CHAT_MODEL_REF);
  assert.deepEqual(removed.image.model,IMAGE_MODEL_REF);
  assert.deepEqual(removed.video.model,VIDEO_MODEL_REF);
  assert.deepEqual(removed.image.fallback,{providerId:other.providerId,modelId:other.modelId});
  // The lease key is provider and model together, so the other provider's entry
  // with the same name would be a different entry entirely and is not touched.
  assert.ok(removed.library.some(item=>item.modelId===other.modelId));
  assert.ok(!removed.library.some(item=>item.modelId===target.modelId));
  // The model is gone, so it can no longer be removed again.
  assert.equal((await libraryRoute.POST(req("/api/models/library","POST",{action:"remove",model:target}))).status,404);
});
test("a chat model is refused without a request context, not only inside one",async()=>{
  // The membership check used to be skipped when no request context was
  // present, which meant any caller that simply did not come through a route
  // could reach the provider. Only usage recording may depend on the context.
  const unknown=ref("acme/not-added");
  const call=reference=>observeLanguageModel(getChatModel(),reference,()=>getChatModel());
  await assert.rejects(()=>call(unknown).doStream({prompt:[{role:"user",content:[{type:"text",text:"Test"}]}]}),/不在“我的模型”|已从“我的模型”中移除/);
  await assert.rejects(()=>call(unknown).doGenerate({prompt:[{role:"user",content:[{type:"text",text:"Test"}]}]}),/不在“我的模型”/);
  // A model that is in the library is unaffected by the absence of a context:
  // the check is membership, not the presence of a request.
  const allowed=await call(CHAT_MODEL_REF).doStream({prompt:[{role:"user",content:[{type:"text",text:"Test"}]}]});
  const parts=[];for await(const part of allowed.stream)parts.push(part);
  assert.ok(parts.some(part=>part.type==="finish"));
  assert.equal(await db.modelRequest.count({where:{}}),0);
});
test("media provider calls acquire the model lease at the provider boundary",async()=>{
  const settings=await getModelPreferences();
  let enteredResolve;const entered=new Promise(resolve=>{enteredResolve=resolve;});
  let release;const gate=new Promise(resolve=>{release=resolve;});
  providerState.imageEntered=enteredResolve;providerState.imageGate=gate;
  const request=imageRoute.POST(req("/api/image","POST",{prompt:"Lease boundary"}));
  await entered;
  let removed=false;
  const removal=removeModel(settings.image.model).then(()=>{removed=true;});
  try { assert.equal(await Promise.race([removal.then(()=> "removed"),new Promise(resolve=>setTimeout(()=>resolve("pending"),50))]),"pending"); }
  finally { release(); providerState.imageGate=undefined; }
  assert.equal((await request).status,200);
  await removal;
  assert.equal(removed,true);
});
test("usage cost distinguishes provider values, configured estimates and unknown or zero values",()=>{
  const rate={inputPerMillion:2,outputPerMillion:4,perRequest:0.05};
  assert.equal(usageCost("chat",{inputTokens:{total:1000},outputTokens:{total:500}},{},rate).costUsd,0.004);
  assert.equal(usageCost("image",undefined,{},rate).costUsd,0.05);
  assert.equal(usageCost("chat",{inputTokens:2,outputTokens:2},{openrouter:{cost:0}},rate).costUsd,0);
  assert.equal(usageCost("chat",{},{}).costUsd,null);
  assert.equal(usageCost("embedding",{tokens:1000},{},rate).costUsd,0.002);
});
const finish={type:"finish",finishReason:{unified:"stop",raw:undefined},usage:{inputTokens:{total:10},outputTokens:{total:3}}};
async function languageCall(chunks,{tools,abort,status=503}={}) {
  let backupCalls=0;
  const backup=new MockLanguageModelV3({doStream:async()=>{backupCalls++;return {stream:new ReadableStream({start(controller){for(const part of [{type:"stream-start",warnings:[]},{type:"text-start",id:"b"},{type:"text-delta",id:"b",delta:"Backup answer"},{type:"text-end",id:"b"},finish]) controller.enqueue(part);controller.close();}})};}});
  const failure=Object.assign(new Error("synthetic upstream failure"),{statusCode:status});
  const primary=new MockLanguageModelV3({doStream:async()=>({stream:new ReadableStream({start(controller){for(const part of chunks??[{type:"stream-start",warnings:[]},{type:"error",error:failure}])controller.enqueue(part);controller.close();}})})});
  const endpoint=protectDataOperation(async request=>{
    await requireLocalWorkspace(request);
    const model=observeLanguageModel(primary,CHAT_MODEL_REF,()=>backup);
    try {
      const result=await model.doStream({prompt:[{role:"user",content:[{type:"text",text:"Test"}]}],...(tools?{tools:[{type:"function",name:"task",inputSchema:{}}]}:{}),...(abort?{abortSignal:AbortSignal.abort()}: {})});
      const parts=[];for await(const part of result.stream)parts.push(part);return Response.json({parts});
    } catch {return Response.json({failed:true},{status:502});}
  });
  const response=await endpoint(req("/api/chat","POST",{}));return {response,backupCalls};
}
test("chat fallback is opt-in, records both attempts and only happens before output",async()=>{
  assert.equal((await languageCall()).backupCalls,0);
  const settings=await getModelPreferences();settings.chat.fallback=ref("google/gemini-3-flash-preview");await saveModelPreferences(settings);
  const result=await languageCall();assert.equal(result.backupCalls,1);await payload(result.response);
  const summary=await usageSummary();assert.equal(summary.totals.requests,3);assert.equal(summary.recent.filter(row=>row.fallback).length,1);
  const backupRow=summary.recent.find(row=>row.fallback);
  assert.equal(backupRow.inputTokens,10);
  // Usage is recorded against the provider-qualified pair, so the log says
  // which endpoint was actually billed rather than only what it was called.
  assert.deepEqual({modelId:backupRow.modelId,modelProvider:backupRow.modelProvider},{modelId:"google/gemini-3-flash-preview",modelProvider:"openrouter"});
  const partial=await languageCall([{type:"text-start",id:"p"},{type:"text-delta",id:"p",delta:"Already shown"},{type:"error",error:new Error("Failure after text")}]);
  assert.equal(partial.backupCalls,0);
});
test("chat fallback refuses tool calls, cancellation and provider credential failures",async()=>{
  const settings=await getModelPreferences();settings.chat.fallback=ref("google/gemini-3-flash-preview");await saveModelPreferences(settings);
  for(const options of [{tools:true},{abort:true},{status:401},{status:403},{status:400}]) assert.equal((await languageCall(undefined,options)).backupCalls,0);
});

test("failed streams retain late provider usage and usage retention stays bounded in the workspace",async()=>{
  const result=await languageCall([{type:"text-start",id:"p"},{type:"text-delta",id:"p",delta:"Partial"},{type:"error",error:new Error("Late failure")},{...finish,providerMetadata:{openrouter:{cost:0.12}}}]);
  await payload(result.response);const row=(await usageSummary()).recent[0];assert.equal(row.status,"error");assert.equal(row.inputTokens,10);assert.equal(row.costUsd,0.12);assert.equal(row.costSource,"provider");
  await db.modelRequest.create({data:{requestId:randomUUID(),mode:"chat",modelId:"old/model",modelProvider:"openrouter",status:"success",durationMs:1,costSource:"unknown",createdAt:new Date(0)}});
  await recordModelAttempt({ mode:"chat",modelId:"new/model",modelProvider:"openrouter",started:Date.now()});
  assert.equal(await db.modelRequest.count({where:{ modelId:"old/model"}}),0);assert.equal(await db.modelRequest.count({where:{}}),2);
  assert.ok((await usageSummary()).recent.length >= 1);
});
test("media fallback records actual selected models, respects defaults and leaves library regeneration on its original model",async t=>{
  const settings=await getModelPreferences();settings.image.model=ref("google/gemini-3.1-flash-image-preview");settings.image.fallback=ref("google/gemini-2.5-flash-image");settings.rates["openrouter:google/gemini-2.5-flash-image"]={inputPerMillion:null,outputPerMillion:null,perRequest:0.03};await saveModelPreferences(settings);
  const model=getImageModel({providerId:"openrouter",modelId:"google/gemini-3.1-flash-image-preview"}), original=model.doGenerate.bind(model);let calls=0;
  t.mock.method(model,"doGenerate",async options=>{if(calls++===0)throw Object.assign(new Error("Unavailable"),{statusCode:404});return original(options);});
  const result=await payload(await imageRoute.POST(req("/api/image","POST",{prompt:"Fallback"})));
  assert.equal(result.modelId,settings.image.fallback.modelId);assert.equal(result.modelProvider,"openrouter");assert.equal(calls,2);
  const asset=await db.mediaAsset.findUnique({where:{id:result.asset.assetId}});assert.equal(asset.generation.modelId,settings.image.fallback.modelId);assert.equal(asset.generation.modelProvider,"openrouter");
  const report=await usageSummary();assert.equal(report.totals.requests,2);assert.equal(report.recent.find(row=>row.fallback).costUsd,0.03);
  t.mock.method(model,"doGenerate",async()=>{calls++;throw new Error("Outage");});
  const regenerate=await import("@/app/api/media/[id]/regenerate/route");const before=calls;
  assert.equal((await regenerate.POST(req(`/api/media/${asset.id}/regenerate`,"POST",{confirm:true}),{params:Promise.resolve({id:asset.id})})).status,502);assert.equal(calls-before,1);
  assert.deepEqual(await (await import("@/lib/media/storage")).readMediaAsset(asset),testPng);
});
test("model APIs enforce the local access credential, Origin, quotas and removed-model warnings without returning prompts or secrets",async()=>{
  assert.equal((await models.GET(req("/api/models","GET",undefined,""))).status,401);
  assert.equal((await models.PUT(req("/api/models","PUT",{},cookie,{origin:"https://outside.invalid"}))).status,403);
  const settings = defaultModelPreferences();
  await db.workspacePreference.upsert({ where: { id: "local" }, create: { id: "local", settings }, update: { settings } });
  const data = await payload(await models.GET(req("/api/models"))); assert.equal(data.data.library.length, 0); assert.deepEqual(data.availability,{});
  await recordModelAttempt({ mode:"chat",modelId:"removed/model",modelProvider:"openrouter",started:Date.now(),error:Object.assign(new Error("Private prompt"),{statusCode:404})});
  const report=await payload(await usageRoute.GET(req("/api/usage")));assert.equal(report.data.recent[0].errorCode,"MODEL_UNAVAILABLE");assert.equal(JSON.stringify(report).includes("Private prompt"),false);
  for(let i=0;i<20;i++)await models.PUT(req("/api/models","PUT",defaultModelPreferences()));assert.equal((await models.PUT(req("/api/models","PUT",defaultModelPreferences()))).status,429);
  assert.equal((await usageRoute.GET(req("/api/usage","GET",undefined,""))).status,401);
});
test("library availability separates unconfigured, unchecked, unreachable and delisted models",async()=>{
  const { resolveLibraryAvailability }=await import("@/lib/models/availability");
  const at=new Date().toISOString();
  const row={providerId:"openrouter",modelId:"acme/present",name:"Present",description:"",modes:["chat"],supportsImageInput:false,endpointImageInput:null,supportsTools:false,contextLength:null,pricing:{}};
  // A read that succeeded carries a timestamp; one that never ran does not.
  const read=(mode,models,{failure=null,fetchedAt=at}={})=>({providerId:"openrouter",mode,models,fetchedAt,stale:false,source:failure?"empty":"live",error:failure?"unreadable":null,failure,skipped:0});
  const neverRead=mode=>read(mode,[],{fetchedAt:null});
  const catalogs=chat=>Object.fromEntries(["chat","image","video","embedding"].map(mode=>[mode,chat(mode)]));
  await db.modelCatalogSnapshot.upsert({where:{providerId_mode:{providerId:"openrouter",mode:"chat"}},create:{providerId:"openrouter",mode:"chat",fetchedAt:new Date(),models:[row]},update:{fetchedAt:new Date(),models:[row]}});
  const current=await addCatalogModel("acme/present",["chat"]).then(()=>getModelPreferences());
  const key="openrouter:acme/present";
  // A catalog that was read successfully and still lists the model is ready.
  assert.deepEqual(resolveLibraryAvailability(current,{openrouter:catalogs(mode=>mode==="chat"?read(mode,[row]):read(mode,[]))})[key],{state:"ready",reason:null});
  // A catalog that was read successfully and no longer lists the model is a
  // delisting, which is a fact about the model rather than about the read.
  assert.deepEqual(resolveLibraryAvailability(current,{openrouter:catalogs(mode=>read(mode,[]))})[key],{state:"notInCatalog",reason:null});
  // A category that was never read says nothing about the model at all, so it
  // must not be reported as removed either.
  assert.deepEqual(resolveLibraryAvailability(current,{openrouter:catalogs(neverRead)})[key],{state:"notChecked",reason:null});
  assert.deepEqual(resolveLibraryAvailability(current,{openrouter:{chat:read("chat",[],{fetchedAt:null})}})[key],{state:"notChecked",reason:null});
  // A read that failed is reported as unreachable, with the reason preserved,
  // so a temporary outage is never shown as every model being removed.
  for(const failure of ["http","unauthorized","network"]) {
    const failed=catalogs(mode=>mode==="chat"?read(mode,[],{failure}):read(mode,[]));
    assert.deepEqual(resolveLibraryAvailability(current,{openrouter:failed})[key],{state:"catalogUnavailable",reason:failure});
  }
  // Without a credential nothing can be called, so nothing is reported as ready.
  const stored=process.env.OPENROUTER_API_KEY;process.env.OPENROUTER_API_KEY="";
  try { assert.deepEqual(resolveLibraryAvailability(current,{openrouter:catalogs(mode=>mode==="chat"?read(mode,[row]):read(mode,[]))})[key],{state:"unconfigured",reason:null}); }
  finally { process.env.OPENROUTER_API_KEY=stored; }
});
test("GET /api/models reports availability beside the library without fetching a catalog",async t=>{
  const calls=[];
  t.mock.method(globalThis,"fetch",async input=>{calls.push(String(input));throw new Error("the settings page must not fetch a catalog");});
  await storeSnapshot("chat",[catalogRow(CHAT_MODEL_REF.modelId,["chat"])]);
  const data=await payload(await models.GET(req("/api/models")));
  assert.deepEqual(Object.keys(data.availability).sort(),data.data.library.map(item=>`${item.providerId}:${item.modelId}`).sort());
  assert.deepEqual(data.availability[`openrouter:${CHAT_MODEL_REF.modelId}`],{state:"ready",reason:null});
  // Every registered provider is listed, whether or not this instance has a key
  // for it: an unconfigured one is something the user can go and configure.
  assert.deepEqual(data.providers,[{providerId:"openrouter",displayName:"OpenRouter",configured:true},{providerId:"deepseek",displayName:"DeepSeek",configured:false}]);
  assert.equal(calls.length,0);
});
test("embedding reindex counts stale vectors, rebuilds them and is a safe no-op without a model",async()=>{
  const summary=await payload(await reindexRoute.GET(req("/api/memory/reindex")));
  assert.deepEqual(summary.data,{total:0,stale:0,embedding:null});
  for(const [index,row] of [["a","SQLite"],["b","旅行"]].entries()) {
    await db.memory.create({data:{key:row[1],value:`Value ${index}`,score:0.5,embedding:[1,0,0],embeddingModelId:"old/embed",embeddingModelProvider:"openrouter"}});
  }
  await db.memory.create({data:{key:"fresh",value:"Current",score:0.5,embedding:[1,0,0],embeddingModelId:"openai/text-embedding-3-small",embeddingModelProvider:"openrouter"}});
  await addCatalogModel("openai/text-embedding-3-small",["embedding"]);
  await saveModelPreferences({...await getModelPreferences(),embedding:ref("openai/text-embedding-3-small")});
  // Vectors written by a different model are not comparable with the ones the
  // current model would produce, so they count as stale even though they exist.
  const staleReport=await payload(await reindexRoute.GET(req("/api/memory/reindex")));
  assert.equal(staleReport.data.total,3);assert.equal(staleReport.data.stale,2);assert.equal(staleReport.data.embedding,"openrouter:openai/text-embedding-3-small");
  const rebuilt=await payload(await reindexRoute.POST(req("/api/memory/reindex","POST",{confirm:true})));
  assert.equal(rebuilt.data.reindexed,2);assert.equal(rebuilt.data.remaining,0);assert.equal(rebuilt.data.embedding,"openrouter:openai/text-embedding-3-small");
  assert.equal((await payload(await reindexRoute.GET(req("/api/memory/reindex")))).data.stale,0);
  assert.deepEqual((await db.memory.findMany({where:{}})).map(row=>row.embeddingModelProvider),["openrouter","openrouter","openrouter"]);
  // A second rebuild has nothing to do and spends nothing.
  const again=await payload(await reindexRoute.POST(req("/api/memory/reindex","POST",{confirm:true})));
  assert.deepEqual(again.data,{reindexed:0,remaining:0,embedding:"openrouter:openai/text-embedding-3-small"});
  // Re-embedding is a paid request per memory, so it is not a bulk operation
  // to repeat until the queue drains.
  assert.equal((await reindexRoute.POST(req("/api/memory/reindex","POST",{confirm:true}))).status,429);
});
test("reindexing without a configured embedding model does nothing and calls no provider",async t=>{
  for(const key of [["a","SQLite"],["b","旅行"]]) await db.memory.create({data:{key:key[1],value:"Value",score:0.5}});
  const calls=[];
  t.mock.method(globalThis,"fetch",async input=>{calls.push(String(input));throw new Error("no provider call is allowed");});
  const summary=await payload(await reindexRoute.GET(req("/api/memory/reindex")));
  assert.deepEqual(summary.data,{total:2,stale:2,embedding:null});
  const result=await payload(await reindexRoute.POST(req("/api/memory/reindex","POST",{confirm:true})));
  // With no embedding model selected the rebuild is refused as a no-op: the
  // rows stay without vectors, keyword scoring still finds them, and nothing is
  // spent on a model the user did not choose.
  assert.deepEqual(result.data,{reindexed:0,remaining:2,embedding:null});
  assert.equal(calls.length,0);
  assert.deepEqual((await db.memory.findMany({where:{}})).map(row=>row.embeddingModelId),[null,null]);
});

test("dynamic catalog snapshots preserve stale data and explicit membership controls model use",async t=>{
  let failVideoRefresh=false, unauthorizedChatRefresh=false, invalidImageRefresh=false, includeValidImageRow=false, videoRows=[{id:"acme/video",name:"Video",description:"Video generation",supported_frame_images:["first_frame"],pricing_skus:{duration_seconds:"0.08"}}], chatRows=[{id:"acme/vision",name:"Vision",description:"Chat vision",architecture:{input_modalities:["text","image"],output_modalities:["text"]},supported_parameters:["tools"],context_length:64000,pricing:{prompt:"0.000001"}}];
  t.mock.method(globalThis,"fetch",async input=>{
    const url=String(input);
    if(url.endsWith("/images/models/acme/paint/endpoints")) return Response.json({endpoints:[{supported_parameters:{input_references:{type:"range",min:0,max:2}}},{supported_parameters:{input_references:{type:"range",min:0,max:1}}}]});
    if(url.endsWith("/images/models/acme/no-input/endpoints")) return Response.json({endpoints:[{supported_parameters:{input_references:{type:"range",min:0,max:0}}}]});
    if(url.endsWith("/videos/models")&&failVideoRefresh) return new Response("unavailable",{status:503});
    if(url.endsWith("/videos/models")) return Response.json({data:videoRows});
    if(url.endsWith("/images/models")&&invalidImageRefresh) return Response.json({data:[{id:"acme/"+"x".repeat(201),name:"Invalid",description:"x".repeat(2001),architecture:{input_modalities:["text"],output_modalities:["image"]}},{id:"acme/price",name:"Price",description:"Invalid pricing",architecture:{input_modalities:["text"],output_modalities:["image"]},pricing:{["p".repeat(41)]:"v".repeat(81)}},...(includeValidImageRow?[{id:"acme/paint",name:"Paint",description:"Image generation",architecture:{input_modalities:["text","image"],output_modalities:["image"]}}]:[])]});
    if(url.endsWith("/images/models")) return Response.json({data:[{id:"acme/paint",name:"Paint",description:"Image generation",architecture:{input_modalities:["text","image"],output_modalities:["image"]},supported_parameters:{input_references:{type:"range",min:0,max:2}}},{id:"acme/no-input",name:"No input",description:"Image generation",architecture:{input_modalities:["text"],output_modalities:["image"]},supported_parameters:{input_references:{type:"range",min:0,max:0}}}]});
    if(url.includes("/models?output_modalities=text")) return unauthorizedChatRefresh?new Response("denied",{status:401}):Response.json({data:chatRows});
    return Response.json({data:[{id:"acme/embed",name:"Embed",description:"Embedding",architecture:{input_modalities:["text"],output_modalities:["embeddings"]},pricing:{prompt:"0.00001"}}]});
  });
  const openrouterCatalog=response=>response.catalogs.openrouter;
  const cachedImage = await payload(await catalogRoute.POST(req("/api/models/catalog", "POST", { mode: "image" })));
  assert.equal(openrouterCatalog(cachedImage).image.stale, false);
  assert.equal(openrouterCatalog(cachedImage).image.providerId,"openrouter");
  await payload(await libraryRoute.POST(req("/api/models/library","POST",{action:"add",model:ref("acme/paint")})));
  await payload(await libraryRoute.POST(req("/api/models/library","POST",{action:"add",model:ref("acme/no-input")})));
  await payload(await catalogRoute.POST(req("/api/models/catalog","POST",{mode:"video"})));
  const video=await payload(await catalogRoute.POST(req("/api/models/catalog","POST",{mode:"video"})));
  assert.equal(openrouterCatalog(video).video.models[0].supportsImageInput,true);
  assert.equal(openrouterCatalog(video).video.models[0].pricing.duration_seconds,"0.08");
  failVideoRefresh=true;
  const stale=await payload(await catalogRoute.POST(req("/api/models/catalog","POST",{mode:"video"})));
  assert.equal(openrouterCatalog(stale).video.stale,true);assert.equal(openrouterCatalog(stale).video.models[0].modelId,"acme/video");
  // A failed refresh keeps the last good copy and says why, rather than
  // reporting an empty catalog that reads as "every model was removed".
  assert.equal(openrouterCatalog(stale).video.failure,"http");assert.equal(openrouterCatalog(stale).video.source,"cache");
  invalidImageRefresh = true; includeValidImageRow = true;
  const invalidImage = await payload(await catalogRoute.POST(req("/api/models/catalog", "POST", { mode: "image" })));
  // A feed with a few malformed rows is not a failed fetch. The live snapshot is
  // kept, the bad rows are dropped, and the count travels back as `skipped`;
  // `stale` is reserved for a refresh that actually fell back to cache. This
  // used to assert stale===true, which described the old all-or-nothing
  // behaviour where one bad row discarded the whole catalog.
  assert.equal(openrouterCatalog(invalidImage).image.stale, false);
  assert.equal(openrouterCatalog(invalidImage).image.source, "live");
  // Only one row is actually malformed: an id past the 200-character bound.
  assert.equal(openrouterCatalog(invalidImage).image.skipped, 1);
  assert.equal(openrouterCatalog(invalidImage).image.models.some(row => row.modelId === "acme/paint"), true);
  // `acme/price` has over-long pricing keys, but nothing constrains their length
  // and the value is sliced rather than rejected, so it is a usable row. It was
  // previously absent only because the whole fetch used to throw and serve a
  // stale snapshot from before that row existed.
  assert.equal(openrouterCatalog(invalidImage).image.models.some(row => row.modelId === "acme/price"), true);
  // The one genuinely malformed row is the only thing dropped.
  assert.equal(openrouterCatalog(invalidImage).image.models.some(row => row.modelId.startsWith("acme/xxx")), false);
  const settings=await getModelPreferences();
  assert.equal(settings.library.find(row=>row.modelId==="acme/paint").endpointImageInput,true);
  assert.equal(settings.library.find(row=>row.modelId==="acme/no-input").endpointImageInput,false);
  settings.image.model=ref("acme/paint");await payload(await models.PUT(req("/api/models","PUT",settings)));
  await assert.rejects(()=>preferredModel("image",ref("acme/unadded")),/不在“我的模型”/);
  await payload(await libraryRoute.POST(req("/api/models/library","POST",{action:"remove",model:ref("acme/paint")})));
  const removed=await getModelPreferences();assert.equal(removed.image.model,null);assert.equal(removed.image.fallback,null);
  await assert.rejects(()=>preferredModel("image",ref("acme/paint")),/不在“我的模型”/);
  // A rejected read is reported as a rejected read, and the last good copy
  // stays browsable rather than being presented as "every model is gone".
  failVideoRefresh=false;unauthorizedChatRefresh=true;
  await storeSnapshot("chat",[catalogRow(CHAT_MODEL_REF.modelId,["chat"])]);
  const before=await payload(await models.GET(req("/api/models")));
  assert.deepEqual(before.availability[`openrouter:${CHAT_MODEL_REF.modelId}`],{state:"ready",reason:null});
  const rejectedCatalog=await payload(await catalogRoute.POST(req("/api/models/catalog","POST",{mode:"chat"})));
  assert.equal(openrouterCatalog(rejectedCatalog).chat.failure,"unauthorized");
  assert.equal(openrouterCatalog(rejectedCatalog).chat.source,"cache");
  // The settings page reads stored snapshots only, so it never claims a
  // delisting on the strength of a read it did not make. It does still report
  // the reason the last refresh failed, so a rejected credential survives a
  // page reload instead of being forgotten and shown as "still fine".
  assert.deepEqual((await payload(await models.GET(req("/api/models")))).availability[`openrouter:${CHAT_MODEL_REF.modelId}`],{state:"catalogUnavailable",reason:"unauthorized"});
  // A catalog that is read successfully and simply no longer lists the model
  // is a delisting. A catalog that comes back entirely empty is a failed read
  // instead, so the feed keeps one unrelated row to make the two distinct.
  unauthorizedChatRefresh=false;chatRows=[{id:"acme/other",name:"Other",description:"Chat",architecture:{input_modalities:["text"],output_modalities:["text"]}}];
  const delistedCatalog=await payload(await catalogRoute.POST(req("/api/models/catalog","POST",{mode:"chat"})));
  assert.equal(openrouterCatalog(delistedCatalog).chat.failure,null);
  assert.equal(openrouterCatalog(delistedCatalog).chat.models.some(row=>row.modelId===CHAT_MODEL_REF.modelId),false);
  assert.deepEqual((await payload(await models.GET(req("/api/models")))).availability[`openrouter:${CHAT_MODEL_REF.modelId}`],{state:"notInCatalog",reason:null});
});
