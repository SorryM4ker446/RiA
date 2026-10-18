"use client";

import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Field, FieldLabel } from "@/components/ui/field";
import type { PluginManifest } from "@/lib/plugins/types";

export function SkillFiles({ snapshot }: { snapshot: NonNullable<PluginManifest["marketplace"]> }) {
  const [path, setPath] = useState("SKILL.md");
  const [characters, setCharacters] = useState(12_000);
  const selected = snapshot.files.find(file => file.path === path) ?? snapshot.files.find(file => file.path === "SKILL.md")!;
  const scriptFiles = snapshot.files.filter(file => /(?:^|\/)scripts\/|\.(?:py|js|mjs|cjs|ts|sh|ps1|bat|exe)$/i.test(file.path));
  const url = `https://skills.sh/${snapshot.repository}/${snapshot.skill}`;
  return <section aria-label="Skill 文件与兼容性" className="plugin-preview flex min-w-0 flex-col gap-4">
    <div className="flex flex-wrap items-center gap-2"><Badge variant="outline">skills.sh</Badge><Badge variant="secondary">{snapshot.files.length} 个文件</Badge><Button variant="ghost" size="sm" asChild><a href={url} target="_blank" rel="noreferrer">查看来源<ExternalLink data-icon="inline-end" /></a></Button></div>
    <p className="text-xs leading-6 text-muted-foreground">启用后，助理会按需读取技能指令和参考资料。{scriptFiles.length ? `包含 ${scriptFiles.length} 个脚本或程序文件，仅作为只读参考。` : ""}技能要求的软件、账号或外部服务需要另行配置；安装不会增加文件权限或自动执行脚本。</p>
    <Field><FieldLabel htmlFor="skill-resource">技能文件</FieldLabel><Select value={selected.path} onValueChange={value => { setPath(value); setCharacters(12_000); }}><SelectTrigger id="skill-resource" className="min-w-0 w-full"><SelectValue /></SelectTrigger><SelectContent>{snapshot.files.map(file => <SelectItem key={file.path} value={file.path}>{file.path}</SelectItem>)}</SelectContent></Select></Field>
    <pre className="whitespace-pre-wrap break-words rounded-xl bg-muted/40 p-4 text-xs leading-6 [overflow-wrap:anywhere]">{selected.contents.slice(0, characters)}</pre>
    {selected.contents.length > characters && <Button variant="ghost" size="sm" className="self-start" onClick={() => setCharacters(value => value + 12_000)}>继续阅读 · 剩余 {selected.contents.length - characters} 字符</Button>}
  </section>;
}
