import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { NextRequest } from "next/server";
import { MockLanguageModelV3 } from "ai/test";
import { createTestDatabase } from "../helpers/database.mjs";
const cleanup=createTestDatabase(); process.env.PRIVATE_AI_TEST_PROVIDER="1";
const {db}=await import("@/db"), {createSession}=await import("@/lib/auth/session");
const {getModelPreferences,saveModelPreferences}=await import("@/lib/models/preferences");
const {defaultModelPreferences}=await import("@/lib/models/preferences-schema");
const {usageCost,recordModelAttempt,usageSummary}=await import("@/lib/models/usage");
const {observeLanguageModel}=await import("@/lib/models/observe-language");
const {protectDataOperation}=await import("@/lib/server/data-operations"), {requireRequestUser}=await import("@/lib/auth/request-user");
const {getImageModel,providerState,testPng}=await import("../helpers/model-provider.mjs");
const imageRoute=await import("@/app/api/image/route");
const models=await import("@/app/api/models/route"), usageRoute=await import("@/app/api/usage/route");
let user,cookie;
const req=(path,method="GET",body,session=cookie,headers={})=>new NextRequest(`http://localhost${path}`,{method,headers:{cookie:session,"content-type":"application/json",...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
const payload=async(response,status=200)=>{assert.equal(response.status,status,await response.clone().text());return response.json();};
beforeEach(async t=>{t.mock.method(console,"error",()=>{});globalThis.__privateAiRateLimitStore?.clear();user=await db.user.create({data:{email:`${randomUUID()}@example.invalid`}});cookie=`app_session=${await createSession(user.id)}`;process.env.OPENROUTER_API_KEY="offline-placeholder";providerState.imageCalls.length=0;});
after(async()=>{await db.$disconnect();cleanup();});
test("model preferences persist by account and reject unavailable models, duplicate fallbacks and invalid prices",async()=>{
  const settings=defaultModelPreferences();settings.chat.modelId="google/gemini-3-flash-preview";settings.chat.fallbackId="anthropic/claude-opus-4.6";settings.defaultMode="image";
  await payload(await models.PUT(req("/api/models","PUT",settings)));await db.$disconnect();assert.deepEqual((await payload(await models.GET(req("/api/models")))).data,settings);
  for(const changed of [{...settings,chat:{modelId:"removed/model",fallbackId:null}},{...settings,chat:{modelId:settings.chat.modelId,fallbackId:settings.chat.modelId}},{...settings,rates:{model:{inputPerMillion:-1,outputPerMillion:null,perRequest:null}}}]) assert.equal((await models.PUT(req("/api/models","PUT",changed))).status,400);
  const other=await db.user.create({data:{email:`${randomUUID()}@example.invalid`}});assert.deepEqual(await getModelPreferences(other.id),defaultModelPreferences());
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
    await requireRequestUser(request);
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
  const settings=defaultModelPreferences();settings.chat.fallbackId="google/gemini-3-flash-preview";await saveModelPreferences(user.id,settings);
  const result=await languageCall();assert.equal(result.backupCalls,1);await payload(result.response);
  const summary=await usageSummary(user.id);assert.equal(summary.totals.requests,3);assert.equal(summary.recent.filter(row=>row.fallback).length,1);assert.equal(summary.recent.find(row=>row.fallback).inputTokens,10);
  const partial=await languageCall([{type:"text-start",id:"p"},{type:"text-delta",id:"p",delta:"Already shown"},{type:"error",error:new Error("Failure after text")}]);
  assert.equal(partial.backupCalls,0);
});
test("chat fallback refuses tool calls, cancellation and provider credential failures",async()=>{
  const settings=defaultModelPreferences();settings.chat.fallbackId="google/gemini-3-flash-preview";await saveModelPreferences(user.id,settings);
  for(const options of [{tools:true},{abort:true},{status:401},{status:403},{status:400}]) assert.equal((await languageCall(undefined,options)).backupCalls,0);
});

test("failed streams retain late provider usage and usage retention stays isolated by account",async()=>{
  const result=await languageCall([{type:"text-start",id:"p"},{type:"text-delta",id:"p",delta:"Partial"},{type:"error",error:new Error("Late failure")},{...finish,providerMetadata:{openrouter:{cost:0.12}}}]);
  await payload(result.response);const row=(await usageSummary(user.id)).recent[0];assert.equal(row.status,"error");assert.equal(row.inputTokens,10);assert.equal(row.costUsd,0.12);assert.equal(row.costSource,"provider");
  const other=await db.user.create({data:{email:`${randomUUID()}@example.invalid`}});
  for(const owner of [user.id,other.id]) await db.modelRequest.create({data:{userId:owner,requestId:randomUUID(),mode:"chat",modelId:"old/model",status:"success",durationMs:1,costSource:"unknown",createdAt:new Date(0)}});
  await recordModelAttempt({userId:user.id,mode:"chat",modelId:"new/model",started:Date.now()});
  assert.equal(await db.modelRequest.count({where:{userId:user.id,modelId:"old/model"}}),0);assert.equal(await db.modelRequest.count({where:{userId:other.id}}),1);
  assert.equal((await usageSummary(user.id)).recent.some(row=>row.userId===other.id),false);
});
test("media fallback records actual selected models, respects defaults and leaves library regeneration on its original model",async t=>{
  const settings=defaultModelPreferences();settings.image.modelId="google/gemini-3.1-flash-image-preview";settings.image.fallbackId="google/gemini-2.5-flash-image";settings.rates[settings.image.fallbackId]={inputPerMillion:null,outputPerMillion:null,perRequest:0.03};await saveModelPreferences(user.id,settings);
  const model=getImageModel(), original=model.doGenerate.bind(model);let calls=0;
  t.mock.method(model,"doGenerate",async options=>{if(calls++===0)throw Object.assign(new Error("Unavailable"),{statusCode:404});return original(options);});
  const result=await payload(await imageRoute.POST(req("/api/image","POST",{prompt:"Fallback"})));
  assert.equal(result.modelId,settings.image.fallbackId);assert.equal(calls,2);
  const asset=await db.mediaAsset.findUnique({where:{id:result.asset.assetId}});assert.equal(asset.generation.modelId,settings.image.fallbackId);
  const report=await usageSummary(user.id);assert.equal(report.totals.requests,2);assert.equal(report.recent.find(row=>row.fallback).costUsd,0.03);
  t.mock.method(model,"doGenerate",async()=>{calls++;throw new Error("Outage");});
  const regenerate=await import("@/app/api/media/[id]/regenerate/route");const before=calls;
  assert.equal((await regenerate.POST(req(`/api/media/${asset.id}/regenerate`,"POST",{confirm:true}),{params:Promise.resolve({id:asset.id})})).status,502);assert.equal(calls-before,1);
  assert.deepEqual(await (await import("@/lib/media/storage")).readMediaAsset(asset),testPng);
});
test("model APIs enforce session, Origin, quotas and removed-model warnings without returning prompts or secrets",async()=>{
  assert.equal((await models.GET(req("/api/models","GET",undefined,""))).status,401);
  assert.equal((await models.PUT(req("/api/models","PUT",{},cookie,{origin:"https://outside.invalid"}))).status,403);
  const settings=defaultModelPreferences();settings.chat.modelId="removed/model";await db.accountPreference.create({data:{userId:user.id,settings}});
  const data=await payload(await models.GET(req("/api/models")));assert.equal(data.unavailable.length,1);
  await recordModelAttempt({userId:user.id,mode:"chat",modelId:"removed/model",started:Date.now(),error:Object.assign(new Error("Private prompt"),{statusCode:404})});
  const report=await payload(await usageRoute.GET(req("/api/usage")));assert.equal(report.data.recent[0].errorCode,"MODEL_UNAVAILABLE");assert.equal(JSON.stringify(report).includes("Private prompt"),false);
  for(let i=0;i<20;i++)await models.PUT(req("/api/models","PUT",defaultModelPreferences()));assert.equal((await models.PUT(req("/api/models","PUT",defaultModelPreferences()))).status,429);
  await db.session.updateMany({where:{userId:user.id},data:{expiresAt:new Date(0)}});assert.equal((await usageRoute.GET(req("/api/usage"))).status,401);
});
