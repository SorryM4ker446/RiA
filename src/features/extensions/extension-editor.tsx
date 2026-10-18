"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { SelectField, SelectOption } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { getApiErrorMessage } from "@/lib/api-error-message";
import type { ExtensionView } from "@/lib/extensions/store";
import type { ExtensionConfig } from "@/lib/extensions/schema";
import type { RegistryConnectionDraft } from "@/lib/extensions/registry-types";

const defaultSchema = JSON.stringify({ type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false }, null, 2);

type CredentialDraft = { key: string; value: string; required?: boolean; description?: string; placeholder?: string };

export function ExtensionEditor({ row, draft, open, returnFocus, encryptionAvailable, localProcessesAllowed, onClose, onSaved }: { row: ExtensionView | null; draft?: RegistryConnectionDraft; open: boolean; returnFocus: () => void; encryptionAvailable: boolean; localProcessesAllowed: boolean; onClose: () => void; onSaved: (row: ExtensionView) => void }) {
  const [name, setName] = useState(row?.name ?? draft?.name ?? "");
  const [kind, setKind] = useState<ExtensionConfig["type"]>(row?.config.type ?? "mcp-http");
  const [url, setUrl] = useState(row?.config.type !== "mcp-stdio" ? row?.config.url ?? draft?.url ?? "" : "");
  const [command, setCommand] = useState(row?.config.type === "mcp-stdio" ? row.config.command : "");
  const [cwd, setCwd] = useState(row?.config.type === "mcp-stdio" ? row.config.cwd : "");
  const [args, setArgs] = useState(row?.config.type === "mcp-stdio" ? JSON.stringify(row.config.args, null, 2) : "[]");
  const [permission, setPermission] = useState(false);
  const [method, setMethod] = useState(row?.config.type === "http" ? row.config.method : "POST");
  const [description, setDescription] = useState(row?.config.type === "http" ? row.config.description : "");
  const [schema, setSchema] = useState(row?.config.type === "http" ? JSON.stringify(row.config.inputSchema, null, 2) : defaultSchema);
  const [credentials, setCredentials] = useState<CredentialDraft[]>(draft?.headers.length ? draft.headers : [{ key: "", value: "" }]);
  const [clearCredentials, setClearCredentials] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [invalid, setInvalid] = useState("");
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);

  async function save(event: FormEvent) {
    event.preventDefault(); if (pending.current) return;
    setError(""); setInvalid("");
    let config: ExtensionConfig;
    try {
      if (kind === "http") {
        let inputSchema;
        try { inputSchema = JSON.parse(schema); } catch { setInvalid("schema"); throw new Error("参数格式必须是有效的 JSON Schema。"); }
        config = { type: kind, url, method, description, inputSchema };
      } else if (kind === "mcp-stdio") {
        let parsed;
        try { parsed = JSON.parse(args); if (!Array.isArray(parsed) || parsed.some(item => typeof item !== "string")) throw new Error(); } catch { setInvalid("args"); throw new Error("程序参数必须是 JSON 字符串数组。"); }
        if (!permission) throw new Error("请先确认本地程序的运行权限。");
        config = { type: kind, command, args: parsed, cwd, processPermission: true };
      } else config = { type: kind, url };
      const filled = credentials.filter(item => item.required === false && !item.value ? false : item.key.trim() || item.value);
      if (filled.some(item => !item.key.trim() || !item.value)) throw new Error("请完整填写凭据名称和值，或移除该行。");
      if (new Set(filled.map(item => item.key.trim().toLowerCase())).size !== filled.length) throw new Error("凭据名称不能重复。");
      const controller = new AbortController(); pending.current = controller; setBusy(true);
      const response = await fetch(row ? `/api/extensions/${row.id}` : "/api/extensions", { method: row ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, config, ...(row ? { revision: row.revision } : {}), ...(filled.length ? { credentials: Object.fromEntries(filled.map(item => [item.key.trim(), item.value])) } : {}), clearCredentials }), signal: controller.signal });
      const payload = await response.json();
      if (!response.ok) throw new Error(getApiErrorMessage(payload, "扩展保存失败。"));
      onSaved(payload.data);
    } catch (failure) { if (!pending.current?.signal.aborted) setError(failure instanceof Error ? failure.message : "扩展保存失败。"); }
    finally { pending.current = null; setBusy(false); }
  }
  // The form owns the request. Closing while idle discards only this draft.
  return <Sheet open={open} onOpenChange={next => { if (!next && !busy) onClose(); }}><SheetContent side="right" className="extension-editor flex flex-col" closeLabel="关闭扩展配置" onCloseAutoFocus={event => { event.preventDefault(); setCredentials([{ key: "", value: "" }]); returnFocus(); }}>
    <header className="flex shrink-0 flex-col gap-2 px-6 pb-4 pt-7 pr-14"><SheetTitle>{row ? "编辑扩展" : "添加扩展"}</SheetTitle><SheetDescription className="break-words [overflow-wrap:anywhere]">{draft ? `来自 MCP 官方 Registry · ${draft.source.name} · v${draft.source.version}。请核对配置，保存后检测连接。` : "配置连接后，检测并选择允许助理使用的工具。"}</SheetDescription></header>
    <form onSubmit={event => void save(event)} className="flex min-h-0 flex-1 flex-col">
      <div className="chat-list-scroll flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 pb-6">
        {error && <Alert variant="destructive"><AlertTitle>未保存</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
        <fieldset disabled={busy} className="min-w-0"><FieldGroup className="gap-5">
          <Field><FieldLabel htmlFor="extension-name">扩展名称</FieldLabel><Input id="extension-name" required maxLength={80} value={name} onChange={event => setName(event.target.value)} placeholder="例如：我的资料服务" /></Field>
          <Field><FieldLabel htmlFor="extension-type">连接类型</FieldLabel><SelectField id="extension-type" value={kind} onValueChange={value => { setKind(value as typeof kind); setCredentials([{ key: "", value: "" }]); setPermission(false); }}><SelectOption value="mcp-http">MCP · 远程服务</SelectOption><SelectOption value="http">HTTP · API 接口</SelectOption>{localProcessesAllowed && <SelectOption value="mcp-stdio">MCP · 本地程序</SelectOption>}</SelectField><FieldDescription>{kind === "mcp-http" ? "连接支持 Streamable HTTP 的 MCP 服务。" : kind === "http" ? "将一个固定 API 接口作为工具，使用 JSON 参数调用。" : "运行已安装的 MCP 程序；需要你单独安装所需运行环境。"}</FieldDescription></Field>
          {kind === "mcp-stdio" ? <>
            <Field><FieldLabel htmlFor="extension-command">程序绝对路径</FieldLabel><Input id="extension-command" required value={command} onChange={event => setCommand(event.target.value)} placeholder="C:\Program Files\nodejs\node.exe" /></Field>
            <Field data-invalid={invalid === "args"}><FieldLabel htmlFor="extension-args">程序参数（JSON 数组）</FieldLabel><Textarea id="extension-args" aria-invalid={invalid === "args"} value={args} onChange={event => setArgs(event.target.value)} rows={3} /><FieldDescription>例如 [&quot;C:\\tools\\server.js&quot;]，不支持 Shell 或自动安装命令。</FieldDescription></Field>
            <Field><FieldLabel htmlFor="extension-cwd">工作目录</FieldLabel><Input id="extension-cwd" required value={cwd} onChange={event => setCwd(event.target.value)} placeholder="C:\tools" /></Field>
            <Field orientation="horizontal"><input id="extension-permission" type="checkbox" required checked={permission} onChange={event => setPermission(event.target.checked)} /><FieldLabel htmlFor="extension-permission">允许此程序以当前用户权限运行</FieldLabel></Field>
            <FieldDescription>本地程序具有当前用户的系统权限，RiA 的资料目录授权不会限制它。只连接你信任的程序。</FieldDescription>
          </> : <Field><FieldLabel htmlFor="extension-url">接口地址</FieldLabel><Input id="extension-url" required type="url" value={url} onChange={event => setUrl(event.target.value)} placeholder="https://example.com/mcp" /><FieldDescription>使用完整 HTTP(S) 地址，凭据请填在下方，不要放在地址中。</FieldDescription></Field>}
          {kind === "http" && <>
            <Field><FieldLabel htmlFor="extension-method">请求方法</FieldLabel><SelectField id="extension-method" value={method} onValueChange={value => setMethod(value as typeof method)}>{["GET", "POST", "PUT", "PATCH", "DELETE"].map(value => <SelectOption key={value} value={value}>{value}</SelectOption>)}</SelectField></Field>
            <Field><FieldLabel htmlFor="extension-description">工具用途</FieldLabel><Textarea id="extension-description" required maxLength={2000} value={description} onChange={event => setDescription(event.target.value)} rows={3} placeholder="描述接口可以完成的操作，以及适合什么时候调用。" /></Field>
            <Field data-invalid={invalid === "schema"}><FieldLabel htmlFor="extension-schema">参数格式（JSON Schema）</FieldLabel><Textarea id="extension-schema" aria-invalid={invalid === "schema"} value={schema} onChange={event => setSchema(event.target.value)} rows={9} /><FieldDescription>GET 参数放入查询字符串，其他方法发送 JSON 请求体。检测连接只发送 HEAD 请求。</FieldDescription></Field>
          </>}
          <FieldGroup className="gap-3"><Field><FieldLabel>{kind === "mcp-stdio" ? "进程环境变量" : "凭据请求头"}</FieldLabel><FieldDescription>{row?.hasCredentials ? "已保存凭据，留空保留。更换连接地址或程序会清除原凭据。" : "可选。凭据加密保存，已有值不会回显。"}</FieldDescription></Field>
            {credentials.map((item, index) => <FieldGroup className="gap-2" key={index}><Field orientation="horizontal"><Input aria-label={`凭据名称 ${index + 1}`} required={item.required} autoComplete="off" placeholder={kind === "mcp-stdio" ? "API_TOKEN" : "Authorization"} value={item.key} disabled={!encryptionAvailable} onChange={event => setCredentials(old => old.map((value, i) => i === index ? { ...value, key: event.target.value } : value))} /><Input aria-label={`凭据值 ${index + 1}`} required={item.required} type="password" autoComplete="new-password" placeholder={item.placeholder || "凭据值"} disabled={!encryptionAvailable} value={item.value} onChange={event => setCredentials(old => old.map((value, i) => i === index ? { ...value, value: event.target.value } : value))} /><Button type="button" size="icon-sm" variant="ghost" aria-label={`移除凭据 ${index + 1}`} disabled={item.required} onClick={() => setCredentials(old => old.filter((_, i) => i !== index))}><Trash2 /></Button></Field>{(item.required || item.description) && <FieldDescription>{item.required ? "必填 · " : ""}{item.description || "请填写完整请求头值。"}</FieldDescription>}</FieldGroup>)}
            <Button type="button" size="sm" variant="ghost" className="self-start" disabled={!encryptionAvailable || credentials.length >= 20} onClick={() => setCredentials(old => [...old, { key: "", value: "" }])}><Plus data-icon="inline-start" />添加凭据</Button>
            {!encryptionAvailable && <FieldDescription>凭据加密不可用。可先配置无需认证的服务；请检查本机的系统加密和密钥设置。</FieldDescription>}
            {row?.hasCredentials && <Field orientation="horizontal"><input id="extension-clear" type="checkbox" checked={clearCredentials} onChange={event => setClearCredentials(event.target.checked)} /><FieldLabel htmlFor="extension-clear">清除已保存的凭据</FieldLabel></Field>}
          </FieldGroup>
        </FieldGroup></fieldset>
      </div>
      <footer className="flex shrink-0 items-center justify-end gap-2 px-6 py-4"><Button type="button" variant="ghost" disabled={busy} onClick={onClose}>取消</Button><Button type="submit" disabled={busy || (!encryptionAvailable && credentials.some(item => item.required || item.value))}>{busy && <Loader2 data-icon="inline-start" className="animate-spin" />}保存配置</Button></footer>
    </form>
  </SheetContent></Sheet>;
}
