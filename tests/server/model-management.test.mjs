import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { NextRequest } from "next/server";
import { MockLanguageModelV3 } from "ai/test";
import { createTestDatabase } from "../helpers/database.mjs";
import { localAccessCookie } from "../helpers/local-access.mjs";
import { seedTestModelPreferences } from "../helpers/model-library.mjs";
const cleanup=createTestDatabase(); process.env.PRIVATE_AI_TEST_PROVIDER="1";
const {db}=await import("@/db");
const {getModelPreferences,saveModelPreferences,removeOpenRouterModel,withModelLease}=await import("@/lib/models/preferences");
const {preferredModel}=await import("@/lib/models/preferences");
const {defaultModelPreferences}=await import("@/lib/models/preferences-schema");
const {upgradeModelPreferences}=await import("@/lib/models/preferences-schema");
const {usageCost,recordModelAttempt,usageSummary}=await import("@/lib/models/usage");
const {observeLanguageModel}=await import("@/lib/models/observe-language");
const {protectDataOperation}=await import("@/lib/server/data-operations"), {requireLocalWorkspace}=await import("@/lib/local/workspace");
const {getImageModel,providerState,resetProviderState,testPng}=await import("../helpers/model-provider.mjs");
const imageRoute=await import("@/app/api/image/route");
const models=await import("@/app/api/models/route"), usageRoute=await import("@/app/api/usage/route");
const catalogRoute=await import("@/app/api/models/catalog/route"), libraryRoute=await import("@/app/api/models/library/route");
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
  const settings=await getModelPreferences();settings.chat.modelId="google/gemini-3-flash-preview";settings.chat.fallbackId="anthropic/claude-opus-4.6";settings.defaultMode="image";
  await payload(await models.PUT(req("/api/models","PUT",settings)));await db.$disconnect();assert.deepEqual((await payload(await models.GET(req("/api/models")))).data,settings);
  for(const changed of [{...settings,chat:{modelId:"removed/model",fallbackId:null}},{...settings,chat:{modelId:settings.chat.modelId,fallbackId:settings.chat.modelId}},{...settings,rates:{model:{inputPerMillion:-1,outputPerMillion:null,perRequest:null}}}]) assert.equal((await models.PUT(req("/api/models","PUT",changed))).status,400);assert.deepEqual(await getModelPreferences(),settings);
});
test("new installations start empty and old saved model IDs migrate only as candidates",async()=>{
  const empty=defaultModelPreferences();
  assert.deepEqual(empty.library,[]);assert.equal(empty.chat.modelId,null);assert.equal(empty.image.modelId,null);
  const old={version:1,defaultMode:"chat",chat:{modelId:"old/chat",fallbackId:"old/fallback"},image:{modelId:"old/image",fallbackId:null},video:{modelId:"old/video",fallbackId:null},rates:{},backupRetentionDays:30,backupMaxCount:10};
  const upgraded=upgradeModelPreferences(old,"old/embed");
  assert.equal(upgraded.chat.modelId,null);assert.equal(upgraded.chat.fallbackId,null);assert.equal(upgraded.embeddingModelId,null);
  assert.deepEqual(upgraded.legacyCandidates.map(candidate=>candidate.modelId),["old/chat","old/fallback","old/image","old/video","old/embed"]);
});
test("model removal waits for an active provider lease",async()=>{
  const settings=await getModelPreferences();
  let enteredResolve;const entered=new Promise(resolve=>{enteredResolve=resolve;});
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const lease=withModelLease("chat",settings.chat.modelId,async()=>{enteredResolve();await gate;return "done";});
  await entered;
  let removed=false;
  const removal=removeOpenRouterModel(settings.chat.modelId).then(()=>{removed=true;});
  assert.equal(await Promise.race([removal.then(()=> "removed"),new Promise(resolve=>setTimeout(()=>resolve("pending"),50))]),"pending");
  release();
  assert.equal(await lease,"done");
  await removal;
  assert.equal(removed,true);
  assert.equal((await getModelPreferences()).chat.modelId,null);
});
test("model leases serialize authorization without serializing different model calls",async()=>{
  const settings=await getModelPreferences();
  const other=settings.library.find(item=>item.modes.includes("chat")&&item.modelId!==settings.chat.modelId)?.modelId;
  assert.ok(other);
  let entered=0,enteredResolve;const bothEntered=new Promise(resolve=>{enteredResolve=resolve;});
  let releaseFirst,releaseSecond;const firstGate=new Promise(resolve=>{releaseFirst=resolve;}),secondGate=new Promise(resolve=>{releaseSecond=resolve;});
  const enter=async()=>{if(++entered===2)enteredResolve();};
  const first=withModelLease("chat",settings.chat.modelId,async()=>{await enter();await firstGate;return "first";});
  const second=withModelLease("chat",other,async()=>{await enter();await secondGate;return "second";});
  assert.equal(await Promise.race([bothEntered.then(()=> "entered"),new Promise(resolve=>setTimeout(()=>resolve("blocked"),100))]),"entered");
  const removal=removeOpenRouterModel(settings.chat.modelId);
  assert.equal(await Promise.race([removal.then(()=> "removed"),new Promise(resolve=>setTimeout(()=>resolve("pending"),50))]),"pending");
  await assert.rejects(withModelLease("chat",settings.chat.modelId,()=>{throw new Error("provider should not be reached");}),/正在移除|不在“我的模型”/);
  releaseFirst();releaseSecond();
  assert.equal(await first,"first");assert.equal(await second,"second");await removal;
  assert.equal((await getModelPreferences()).chat.modelId,null);
});
test("media provider calls acquire the model lease at the provider boundary",async()=>{
  const settings=await getModelPreferences();
  let enteredResolve;const entered=new Promise(resolve=>{enteredResolve=resolve;});
  let release;const gate=new Promise(resolve=>{release=resolve;});
  providerState.imageEntered=enteredResolve;providerState.imageGate=gate;
  const request=imageRoute.POST(req("/api/image","POST",{prompt:"Lease boundary"}));
  await entered;
  let removed=false;
  const removal=removeOpenRouterModel(settings.image.modelId).then(()=>{removed=true;});
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
    const model=observeLanguageModel(primary,"anthropic/claude-opus-4.6",()=>backup);
    try {
      const result=await model.doStream({prompt:[{role:"user",content:[{type:"text",text:"Test"}]}],...(tools?{tools:[{type:"function",name:"task",inputSchema:{}}]}:{}),...(abort?{abortSignal:AbortSignal.abort()}: {})});
      const parts=[];for await(const part of result.stream)parts.push(part);return Response.json({parts});
    } catch {return Response.json({failed:true},{status:502});}
  });
  const response=await endpoint(req("/api/chat","POST",{}));return {response,backupCalls};
}
test("chat fallback is opt-in, records both attempts and only happens before output",async()=>{
  assert.equal((await languageCall()).backupCalls,0);
  const settings=await getModelPreferences();settings.chat.fallbackId="google/gemini-3-flash-preview";await saveModelPreferences(settings);
  const result=await languageCall();assert.equal(result.backupCalls,1);await payload(result.response);
  const summary=await usageSummary();assert.equal(summary.totals.requests,3);assert.equal(summary.recent.filter(row=>row.fallback).length,1);assert.equal(summary.recent.find(row=>row.fallback).inputTokens,10);
  const partial=await languageCall([{type:"text-start",id:"p"},{type:"text-delta",id:"p",delta:"Already shown"},{type:"error",error:new Error("Failure after text")}]);
  assert.equal(partial.backupCalls,0);
});
test("chat fallback refuses tool calls, cancellation and provider credential failures",async()=>{
  const settings=await getModelPreferences();settings.chat.fallbackId="google/gemini-3-flash-preview";await saveModelPreferences(settings);
  for(const options of [{tools:true},{abort:true},{status:401},{status:403},{status:400}]) assert.equal((await languageCall(undefined,options)).backupCalls,0);
});

test("failed streams retain late provider usage and usage retention stays bounded in the workspace",async()=>{
  const result=await languageCall([{type:"text-start",id:"p"},{type:"text-delta",id:"p",delta:"Partial"},{type:"error",error:new Error("Late failure")},{...finish,providerMetadata:{openrouter:{cost:0.12}}}]);
  await payload(result.response);const row=(await usageSummary()).recent[0];assert.equal(row.status,"error");assert.equal(row.inputTokens,10);assert.equal(row.costUsd,0.12);assert.equal(row.costSource,"provider");
  await db.modelRequest.create({data:{requestId:randomUUID(),mode:"chat",modelId:"old/model",status:"success",durationMs:1,costSource:"unknown",createdAt:new Date(0)}});
  await recordModelAttempt({ mode:"chat",modelId:"new/model",started:Date.now()});
  assert.equal(await db.modelRequest.count({where:{ modelId:"old/model"}}),0);assert.equal(await db.modelRequest.count({where:{}}),2);
  assert.ok((await usageSummary()).recent.length >= 1);
});
test("media fallback records actual selected models, respects defaults and leaves library regeneration on its original model",async t=>{
  const settings=await getModelPreferences();settings.image.modelId="google/gemini-3.1-flash-image-preview";settings.image.fallbackId="google/gemini-2.5-flash-image";settings.rates[settings.image.fallbackId]={inputPerMillion:null,outputPerMillion:null,perRequest:0.03};await saveModelPreferences(settings);
  const model=getImageModel(), original=model.doGenerate.bind(model);let calls=0;
  t.mock.method(model,"doGenerate",async options=>{if(calls++===0)throw Object.assign(new Error("Unavailable"),{statusCode:404});return original(options);});
  const result=await payload(await imageRoute.POST(req("/api/image","POST",{prompt:"Fallback"})));
  assert.equal(result.modelId,settings.image.fallbackId);assert.equal(calls,2);
  const asset=await db.mediaAsset.findUnique({where:{id:result.asset.assetId}});assert.equal(asset.generation.modelId,settings.image.fallbackId);
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
  settings.chat.modelId = "removed/model";
  await db.workspacePreference.upsert({ where: { id: "local" }, create: { id: "local", settings: { ...settings, chat: { ...settings.chat, modelId: null } } }, update: { settings: { ...settings, chat: { ...settings.chat, modelId: null } } } });
  const data = await payload(await models.GET(req("/api/models"))); assert.equal(data.data.library.length, 0);
  await recordModelAttempt({ mode:"chat",modelId:"removed/model",started:Date.now(),error:Object.assign(new Error("Private prompt"),{statusCode:404})});
  const report=await payload(await usageRoute.GET(req("/api/usage")));assert.equal(report.data.recent[0].errorCode,"MODEL_UNAVAILABLE");assert.equal(JSON.stringify(report).includes("Private prompt"),false);
  for(let i=0;i<20;i++)await models.PUT(req("/api/models","PUT",defaultModelPreferences()));assert.equal((await models.PUT(req("/api/models","PUT",defaultModelPreferences()))).status,429);
  assert.equal((await usageRoute.GET(req("/api/usage","GET",undefined,""))).status,401);
});

test("dynamic catalog snapshots preserve stale data and explicit membership controls model use",async t=>{
  let failVideoRefresh=false, invalidImageRefresh=false, includeValidImageRow=false;
  t.mock.method(globalThis,"fetch",async input=>{
    const url=String(input);
    if(url.endsWith("/images/models/acme/paint/endpoints")) return Response.json({endpoints:[{supported_parameters:{input_references:{type:"range",min:0,max:2}}},{supported_parameters:{input_references:{type:"range",min:0,max:1}}}]});
    if(url.endsWith("/images/models/acme/no-input/endpoints")) return Response.json({endpoints:[{supported_parameters:{input_references:{type:"range",min:0,max:0}}}]});
    if(url.endsWith("/videos/models")&&failVideoRefresh) return new Response("unavailable",{status:503});
    if(url.endsWith("/images/models")&&invalidImageRefresh) return Response.json({data:[{id:"acme/"+"x".repeat(201),name:"Invalid",description:"x".repeat(2001),architecture:{input_modalities:["text"],output_modalities:["image"]}},{id:"acme/price",name:"Price",description:"Invalid pricing",architecture:{input_modalities:["text"],output_modalities:["image"]},pricing:{["p".repeat(41)]:"v".repeat(81)}},...(includeValidImageRow?[{id:"acme/paint",name:"Paint",description:"Image generation",architecture:{input_modalities:["text","image"],output_modalities:["image"]}}]:[])]});
    if(url.endsWith("/images/models")) return Response.json({data:[{id:"acme/paint",name:"Paint",description:"Image generation",architecture:{input_modalities:["text","image"],output_modalities:["image"]},supported_parameters:{input_references:{type:"range",min:0,max:2}}},{id:"acme/no-input",name:"No input",description:"Image generation",architecture:{input_modalities:["text"],output_modalities:["image"]},supported_parameters:{input_references:{type:"range",min:0,max:0}}}]});
    if(url.endsWith("/videos/models")) return Response.json({data:[{id:"acme/video",name:"Video",description:"Video generation",supported_frame_images:["first_frame"],pricing_skus:{duration_seconds:"0.08"}}]});
    if(url.includes("/models?output_modalities=text")) return Response.json({data:[{id:"acme/vision",name:"Vision",description:"Chat vision",architecture:{input_modalities:["text","image"],output_modalities:["text"]},supported_parameters:["tools"],context_length:64000,pricing:{prompt:"0.000001"}}]});
    return Response.json({data:[{id:"acme/embed",name:"Embed",description:"Embedding",architecture:{input_modalities:["text"],output_modalities:["embeddings"]},pricing:{prompt:"0.00001"}}]});
  });
  const cachedImage = await payload(await catalogRoute.POST(req("/api/models/catalog", "POST", { mode: "image" })));
  assert.equal(cachedImage.catalogs.image.stale, false);
  await payload(await libraryRoute.POST(req("/api/models/library","POST",{action:"add",modelId:"acme/paint"})));
  await payload(await libraryRoute.POST(req("/api/models/library","POST",{action:"add",modelId:"acme/no-input"})));
  await payload(await catalogRoute.POST(req("/api/models/catalog","POST",{mode:"video"})));
  const video=await payload(await catalogRoute.POST(req("/api/models/catalog","POST",{mode:"video"})));
  assert.equal(video.catalogs.video.models[0].supportsImageInput,true);
  assert.equal(video.catalogs.video.models[0].pricing.duration_seconds,"0.08");
  failVideoRefresh=true;
  const stale=await payload(await catalogRoute.POST(req("/api/models/catalog","POST",{mode:"video"})));
  assert.equal(stale.catalogs.video.stale,true);assert.equal(stale.catalogs.video.models[0].modelId,"acme/video");
  invalidImageRefresh = true; includeValidImageRow = true;
  const invalidImage = await payload(await catalogRoute.POST(req("/api/models/catalog", "POST", { mode: "image" })));
  // A feed with a few malformed rows is not a failed fetch. The live snapshot is
  // kept, the bad rows are dropped, and the count travels back as `skipped`;
  // `stale` is reserved for a refresh that actually fell back to cache. This
  // used to assert stale===true, which described the old all-or-nothing
  // behaviour where one bad row discarded the whole catalog.
  assert.equal(invalidImage.catalogs.image.stale, false);
  assert.equal(invalidImage.catalogs.image.source, "live");
  // Only one row is actually malformed: an id past the 200-character bound.
  assert.equal(invalidImage.catalogs.image.skipped, 1);
  assert.equal(invalidImage.catalogs.image.models.some(row => row.modelId === "acme/paint"), true);
  // `acme/price` has over-long pricing keys, but nothing constrains their length
  // and the value is sliced rather than rejected, so it is a usable row. It was
  // previously absent only because the whole fetch used to throw and serve a
  // stale snapshot from before that row existed.
  assert.equal(invalidImage.catalogs.image.models.some(row => row.modelId === "acme/price"), true);
  // The one genuinely malformed row is the only thing dropped.
  assert.equal(invalidImage.catalogs.image.models.some(row => row.modelId.startsWith("acme/xxx")), false);
  const settings=await getModelPreferences();
  assert.equal(settings.library.find(row=>row.modelId==="acme/paint").endpointImageInput,true);
  assert.equal(settings.library.find(row=>row.modelId==="acme/no-input").endpointImageInput,false);
  settings.image.modelId="acme/paint";await payload(await models.PUT(req("/api/models","PUT",settings)));
  await assert.rejects(()=>preferredModel("image","acme/unadded"),/不在“我的模型”/);
  await payload(await libraryRoute.POST(req("/api/models/library","POST",{action:"remove",modelId:"acme/paint"})));
  const removed=await getModelPreferences();assert.equal(removed.image.modelId,null);assert.equal(removed.image.fallbackId,null);
  await assert.rejects(()=>preferredModel("image","acme/paint"),/不在“我的模型”/);
});
