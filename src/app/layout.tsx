import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { AppShell } from "@/components/layout/app-shell";
import { DesktopStartup } from "@/components/layout/desktop-startup";
import "./globals.css";
import { LocaleProvider } from "@/lib/locale/client";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ToastProvider } from "@/components/ui/toast";
import { UpdateProvider } from "@/features/updates/update-provider";
import { SettingsProvider } from "@/features/settings/settings-overlay";
import { DEFAULT_THEME, LEGACY_PANEL_VISIBILITY_STORAGE_KEY, PANEL_VISIBILITY_STORAGE_KEY, RAIL_BOUNDS, RAIL_STORAGE_KEY, THEME_STORAGE_KEY } from "@/lib/ui-preferences";

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
        <script dangerouslySetInnerHTML={{ __html: `document.documentElement.dataset.desktopRuntime=String(Boolean(window.riaDesktop));try{var theme=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)})||${JSON.stringify(DEFAULT_THEME)};var dark=theme!=='light';document.documentElement.classList.toggle('dark',dark);document.documentElement.style.colorScheme=dark?'dark':'light'}catch{};try{var panels=JSON.parse(localStorage.getItem(${JSON.stringify(PANEL_VISIBILITY_STORAGE_KEY)})||localStorage.getItem(${JSON.stringify(LEGACY_PANEL_VISIBILITY_STORAGE_KEY)})||'null')||{};document.documentElement.dataset.conversationsOpen=String(panels.conversations!==false);document.documentElement.dataset.tasksOpen=String(panels.tasks!==false)}catch{};try{var rail=null;try{rail=JSON.parse(localStorage.getItem(${JSON.stringify(RAIL_STORAGE_KEY)})||'null')}catch{};if(rail&&typeof rail.width==='number'&&isFinite(rail.width))document.documentElement.style.setProperty('--rail-width',Math.round(Math.min(${RAIL_BOUNDS.max},Math.max(${RAIL_BOUNDS.min},rail.width)))+'px');document.documentElement.dataset.railCollapsed=String(!!(rail&&rail.collapsed===true))}catch{}` }} />
      </head>
      <body className={`${sans.variable} ${mono.variable} font-sans antialiased`}>
        <LocaleProvider><ToastProvider><ConfirmProvider><DesktopStartup><UpdateProvider><SettingsProvider><AppShell>{children}</AppShell></SettingsProvider></UpdateProvider></DesktopStartup></ConfirmProvider></ToastProvider></LocaleProvider>
      </body>
    </html>
  );
}
