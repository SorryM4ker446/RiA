"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { Loader2, Sparkles, UserPlus } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

function readErrorMessage(payload: unknown, fallback: string): string {
  if (
    payload &&
    typeof payload === "object" &&
    "error" in payload &&
    payload.error &&
    typeof payload.error === "object" &&
    "message" in payload.error &&
    typeof payload.error.message === "string"
  ) {
    return payload.error.message;
  }
  return fallback;
}

export default function RegisterPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError("密码至少需要 8 位。");
      return;
    }

    setIsSubmitting(true);

    try {
      const response = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, name: name || undefined }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(readErrorMessage(payload, "注册失败，请稍后重试。"));
      }

      window.location.href = "/chat";
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "注册失败，请稍后重试。");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-6 p-6">
      <div className="space-y-2 text-center">
        <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
          <Sparkles className="h-5 w-5 text-primary" />
        </div>
        <h1 className="text-2xl font-semibold">创建账号</h1>
        <p className="text-sm text-muted-foreground">注册后即可使用你的私有助手。</p>
      </div>

      <Card className="glass-surface">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <UserPlus className="h-4 w-4 text-primary" />
            注册
          </CardTitle>
          <CardDescription>创建一个新账号。</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-3" onSubmit={onSubmit}>
            <Input
              autoComplete="name"
              onChange={(event) => setName(event.target.value)}
              placeholder="昵称（可选）"
              type="text"
              value={name}
            />
            <Input
              autoComplete="email"
              onChange={(event) => setEmail(event.target.value)}
              placeholder="邮箱"
              required
              type="email"
              value={email}
            />
            <Input
              autoComplete="new-password"
              onChange={(event) => setPassword(event.target.value)}
              placeholder="密码（至少 8 位）"
              required
              type="password"
              value={password}
            />
            <Button className="w-full" disabled={isSubmitting} type="submit">
              {isSubmitting ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <UserPlus className="mr-2 h-4 w-4" />
              )}
              注册并登录
            </Button>
          </form>

          {error ? (
            <Alert className="mt-4" variant="destructive">
              <AlertTitle>注册失败</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          <p className="mt-4 text-center text-xs text-muted-foreground">
            已有账号？{" "}
            <Link className="font-medium text-primary underline underline-offset-4" href="/login">
              登录
            </Link>
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
