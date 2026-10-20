"use client";
import { useLocale } from "@/lib/locale/client";

import { t, tf, localizeMessage } from "@/lib/locale";

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
  useLocale();
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
  const [credentials, setCredentials] = useState<CredentialDraft[]>(draft?.headers.length ? draft.headers : row?.credentialFields.length ? row.credentialFields.map(field => ({ ...field, value: "", required: field.required && !row.hasCredentials })) : [{ key: "", value: "" }]);
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
        try { inputSchema = JSON.parse(schema); } catch { setInvalid("schema"); throw new Error(t("ui.extensions.extension-editor.parameterFormatMustBeAValid")); }
        config = { type: kind, url, method, description, inputSchema };
      } else if (kind === "mcp-stdio") {
        let parsed;
        try { parsed = JSON.parse(args); if (!Array.isArray(parsed) || parsed.some(item => typeof item !== "string")) throw new Error(); } catch { setInvalid("args"); throw new Error(t("ui.extensions.extension-editor.programArgumentsMustBeAJSON")); }
        if (!permission) throw new Error(t("ui.extensions.extension-editor.confirmPermissionToRunTheLocal"));
        config = { type: kind, command, args: parsed, cwd, processPermission: true };
      } else config = { type: kind, url };
      const filled = credentials.filter(item => item.required === false && !item.value ? false : item.key.trim() || item.value);
      if (filled.some(item => !item.key.trim() || !item.value)) throw new Error(t("ui.extensions.extension-editor.enterBothCredentialNameAndValue"));
      if (new Set(filled.map(item => item.key.trim().toLowerCase())).size !== filled.length) throw new Error(t("ui.extensions.extension-editor.credentialNamesMustBeUnique"));
      const controller = new AbortController(); pending.current = controller; setBusy(true);
      const response = await fetch(row ? `/api/extensions/${row.id}` : "/api/extensions", { method: row ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, config, ...(row ? { revision: row.revision } : {}), ...(filled.length ? { credentials: Object.fromEntries(filled.map(item => [item.key.trim(), item.value])) } : {}), clearCredentials }), signal: controller.signal });
      const payload = await response.json();
      if (!response.ok) throw new Error(getApiErrorMessage(payload, t("ui.extensions.extension-editor.couldNotSaveExtension")));
      onSaved(payload.data);
    } catch (failure) { if (!pending.current?.signal.aborted) setError(failure instanceof Error ? failure.message : t("ui.extensions.extension-editor.couldNotSaveExtension")); }
    finally { pending.current = null; setBusy(false); }
  }
  // The form owns the request. Closing while idle discards only this draft.
  return <Sheet open={open} onOpenChange={next => { if (!next && !busy) onClose(); }}><SheetContent side="right" className="extension-editor flex flex-col" closeLabel={t("ui.extensions.extension-editor.closeExtensionConfiguration")} onCloseAutoFocus={event => { event.preventDefault(); setCredentials([{ key: "", value: "" }]); returnFocus(); }}>
    <header className="flex shrink-0 flex-col gap-2 px-6 pb-4 pt-7 pr-14"><SheetTitle>{row ? t("ui.extensions.extension-editor.editExtension") : t("ui.extensions.extension-editor.addExtension")}</SheetTitle><SheetDescription className="break-words [overflow-wrap:anywhere]">{draft ? tf("ui.extensions.extension-editor.fromTheOfficialMCPRegistryV", { v0: draft.source.name, v1: draft.source.version }) : t("ui.extensions.extension-editor.configureTheConnectionThenTestAnd")}</SheetDescription></header>
    <form onSubmit={event => void save(event)} className="flex min-h-0 flex-1 flex-col">
      <div className="chat-list-scroll flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 pb-6">
        {error && <Alert variant="destructive"><AlertTitle>{t("ui.extensions.extension-editor.unsaved")}</AlertTitle><AlertDescription>{localizeMessage(error)}</AlertDescription></Alert>}
        <fieldset disabled={busy} className="min-w-0"><FieldGroup className="gap-5">
          <Field><FieldLabel htmlFor="extension-name">{t("ui.extensions.extension-editor.extensionName")}</FieldLabel><Input id="extension-name" required maxLength={80} value={name} onChange={event => setName(event.target.value)} placeholder={t("ui.extensions.extension-editor.forExampleMyKnowledgeService")} /></Field>
          <Field><FieldLabel htmlFor="extension-type">{t("ui.extensions.extension-editor.connectionType")}</FieldLabel><SelectField id="extension-type" value={kind} onValueChange={value => { setKind(value as typeof kind); setCredentials([{ key: "", value: "" }]); setPermission(false); }}><SelectOption value="mcp-http">{t("ui.extensions.extension-editor.mCPRemoteService")}</SelectOption><SelectOption value="http">{t("ui.extensions.extension-editor.hTTPAPIEndpoint")}</SelectOption>{localProcessesAllowed && <SelectOption value="mcp-stdio">{t("ui.extensions.extension-editor.mCPLocalProgram")}</SelectOption>}</SelectField><FieldDescription>{kind === "mcp-http" ? t("ui.extensions.extension-editor.connectToAnMCPServiceSupporting") : kind === "http" ? t("ui.extensions.extension-editor.exposeAFixedAPIEndpointAs") : t("ui.extensions.extension-editor.runAnInstalledMCPProgramInstall")}</FieldDescription></Field>
          {kind === "mcp-stdio" ? <>
            <Field><FieldLabel htmlFor="extension-command">{t("ui.extensions.extension-editor.absoluteProgramPath")}</FieldLabel><Input id="extension-command" required value={command} onChange={event => setCommand(event.target.value)} placeholder="C:\Program Files\nodejs\node.exe" /></Field>
            <Field data-invalid={invalid === "args"}><FieldLabel htmlFor="extension-args">{t("ui.extensions.extension-editor.programArgumentsJSONArray")}</FieldLabel><Textarea id="extension-args" aria-invalid={invalid === "args"} value={args} onChange={event => setArgs(event.target.value)} rows={3} /><FieldDescription>{t("ui.extensions.extension-editor.forExampleQuotCToolsServer")}</FieldDescription></Field>
            <Field><FieldLabel htmlFor="extension-cwd">{t("ui.extensions.extension-editor.workingDirectory")}</FieldLabel><Input id="extension-cwd" required value={cwd} onChange={event => setCwd(event.target.value)} placeholder="C:\tools" /></Field>
            <Field orientation="horizontal"><input id="extension-permission" type="checkbox" required checked={permission} onChange={event => setPermission(event.target.checked)} /><FieldLabel htmlFor="extension-permission">{t("ui.extensions.extension-editor.allowThisProgramToRunWith")}</FieldLabel></Field>
            <FieldDescription>{t("ui.extensions.extension-editor.localProgramsHaveYourSystemPermissions")}</FieldDescription>
          </> : <Field><FieldLabel htmlFor="extension-url">{t("ui.extensions.extension-editor.endpointURL")}</FieldLabel><Input id="extension-url" required type="url" value={url} onChange={event => setUrl(event.target.value)} placeholder="https://example.com/mcp" /><FieldDescription>{t("ui.extensions.extension-editor.useAFullHTTPSURL")}</FieldDescription></Field>}
          {kind === "http" && <>
            <Field><FieldLabel htmlFor="extension-method">{t("ui.extensions.extension-editor.requestMethod")}</FieldLabel><SelectField id="extension-method" value={method} onValueChange={value => setMethod(value as typeof method)}>{["GET", "POST", "PUT", "PATCH", "DELETE"].map(value => <SelectOption key={value} value={value}>{value}</SelectOption>)}</SelectField></Field>
            <Field><FieldLabel htmlFor="extension-description">{t("ui.extensions.extension-editor.toolPurpose")}</FieldLabel><Textarea id="extension-description" required maxLength={2000} value={description} onChange={event => setDescription(event.target.value)} rows={3} placeholder={t("ui.extensions.extension-editor.describeWhatThisEndpointDoesAnd")} /></Field>
            <Field data-invalid={invalid === "schema"}><FieldLabel htmlFor="extension-schema">{t("ui.extensions.extension-editor.parametersJSONSchema")}</FieldLabel><Textarea id="extension-schema" aria-invalid={invalid === "schema"} value={schema} onChange={event => setSchema(event.target.value)} rows={9} /><FieldDescription>{t("ui.extensions.extension-editor.gETParametersUseTheQueryString")}</FieldDescription></Field>
          </>}
          <FieldGroup className="gap-3"><Field><FieldLabel>{kind === "mcp-stdio" ? t("ui.extensions.extension-editor.processEnvironmentVariables") : t("ui.extensions.extension-editor.credentialHeaders")}</FieldLabel><FieldDescription>{row?.hasCredentials ? t("ui.extensions.extension-editor.credentialsAreSavedLeaveBlankTo") : t("ui.extensions.extension-editor.optionalCredentialsAreEncryptedAndExisting")}</FieldDescription></Field>
            {credentials.map((item, index) => <FieldGroup className="gap-2" key={index}><Field orientation="horizontal"><Input aria-label={tf("ui.extensions.extension-editor.credentialName", { v0: index + 1 })} required={item.required} autoComplete="off" placeholder={kind === "mcp-stdio" ? "API_TOKEN" : "Authorization"} value={item.key} disabled={!encryptionAvailable} onChange={event => setCredentials(old => old.map((value, i) => i === index ? { ...value, key: event.target.value } : value))} /><Input aria-label={tf("ui.extensions.extension-editor.credentialValue", { v0: index + 1 })} required={item.required} type="password" autoComplete="new-password" placeholder={item.placeholder || t("ui.extensions.extension-editor.credentialValue2")} disabled={!encryptionAvailable} value={item.value} onChange={event => setCredentials(old => old.map((value, i) => i === index ? { ...value, value: event.target.value } : value))} /><Button type="button" size="icon-sm" variant="ghost" aria-label={tf("ui.extensions.extension-editor.removeCredential", { v0: index + 1 })} disabled={item.required} onClick={() => setCredentials(old => old.filter((_, i) => i !== index))}><Trash2 /></Button></Field>{(item.required || item.description) && <FieldDescription>{item.required ? t("ui.extensions.extension-editor.required") : ""}{item.description || t("ui.extensions.extension-editor.enterTheFullHeaderValue")}</FieldDescription>}</FieldGroup>)}
            <Button type="button" size="sm" variant="ghost" className="self-start" disabled={!encryptionAvailable || credentials.length >= 20} onClick={() => setCredentials(old => [...old, { key: "", value: "" }])}><Plus data-icon="inline-start" />{t("ui.extensions.extension-editor.addCredential")}</Button>
            {!encryptionAvailable && <FieldDescription>{t("ui.extensions.extension-editor.credentialEncryptionIsUnavailableConfigureA")}</FieldDescription>}
            {row?.hasCredentials && <Field orientation="horizontal"><input id="extension-clear" type="checkbox" checked={clearCredentials} onChange={event => setClearCredentials(event.target.checked)} /><FieldLabel htmlFor="extension-clear">{t("ui.extensions.extension-editor.clearSavedCredentials")}</FieldLabel></Field>}
          </FieldGroup>
        </FieldGroup></fieldset>
      </div>
      <footer className="flex shrink-0 items-center justify-end gap-2 px-6 py-4"><Button type="button" variant="ghost" disabled={busy} onClick={onClose}>{t("knowledge.cancelEdit")}</Button><Button type="submit" disabled={busy || (!encryptionAvailable && credentials.some(item => item.required || item.value))}>{busy && <Loader2 data-icon="inline-start" className="animate-spin" />}{t("ui.extensions.extension-editor.saveConfiguration")}</Button></footer>
    </form>
  </SheetContent></Sheet>;
}
