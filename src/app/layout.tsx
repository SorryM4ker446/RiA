import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { AppShell } from "@/components/layout/app-shell";
import { DesktopStartup } from "@/components/layout/desktop-startup";
import "./globals.css";
import { LocaleProvider } from "@/lib/locale/client";
import { DEFAULT_THEME, PANEL_VISIBILITY_STORAGE_KEY, THEME_STORAGE_KEY } from "@/lib/ui-preferences";

const sans = Geist({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const mono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "RiA",
  description: "A personal AI assistant built with Next.js, Vercel AI SDK, and SQLite",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" className={DEFAULT_THEME} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: `document.documentElement.dataset.desktopRuntime=String(Boolean(window.privateAiDesktop));try{var theme=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)})||${JSON.stringify(DEFAULT_THEME)};var dark=theme!=='light';document.documentElement.classList.toggle('dark',dark);document.documentElement.style.colorScheme=dark?'dark':'light'}catch{};try{var panels=JSON.parse(localStorage.getItem(${JSON.stringify(PANEL_VISIBILITY_STORAGE_KEY)})||'null')||{};document.documentElement.dataset.conversationsOpen=String(panels.conversations!==false);document.documentElement.dataset.tasksOpen=String(panels.tasks!==false)}catch{}` }} />
      </head>
      <body className={`${sans.variable} ${mono.variable} font-sans antialiased`}>
        <LocaleProvider><DesktopStartup><AppShell>{children}</AppShell></DesktopStartup></LocaleProvider>
      </body>
    </html>
  );
}
