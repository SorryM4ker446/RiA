import type { Config } from "tailwindcss";
import { fontFamily } from "tailwindcss/defaultTheme";

const config: Config = {
  darkMode: ["class"],
  content: [
    "./src/app/**/*.{ts,tsx}",
    "./src/components/**/*.{ts,tsx}",
    "./src/features/**/*.{ts,tsx}",
    "./src/lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        // Geist carries the Latin voice; the interface is Chinese, so the CJK
        // faces must follow it explicitly or the browser picks them per glyph
        // and the two halves of a line end up with different weights.
        sans: [
          "var(--font-sans)",
          "PingFang SC",
          "Hiragino Sans GB",
          "Microsoft YaHei",
          ...fontFamily.sans,
        ],
        mono: ["var(--font-mono)", ...fontFamily.mono],
      },
      colors: {
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        card: "hsl(var(--card))",
        "card-foreground": "hsl(var(--card-foreground))",
        popover: "hsl(var(--popover))",
        "popover-foreground": "hsl(var(--popover-foreground))",
        primary: "hsl(var(--primary))",
        "primary-foreground": "hsl(var(--primary-foreground))",
        secondary: "hsl(var(--secondary))",
        "secondary-foreground": "hsl(var(--secondary-foreground))",
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        muted: "hsl(var(--muted))",
        "muted-foreground": "hsl(var(--muted-foreground))",
        accent: "hsl(var(--accent))",
        "accent-foreground": "hsl(var(--accent-foreground))",
        destructive: "hsl(var(--destructive))",
        "destructive-foreground": "hsl(var(--destructive-foreground))",
        success: "hsl(var(--success))",
        "success-foreground": "hsl(var(--success-foreground))",
        warning: "hsl(var(--warning))",
        "warning-foreground": "hsl(var(--warning-foreground))",
        surface: "hsl(var(--surface))",
        elevated: "hsl(var(--elevated))",
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      // Geist carries its identity in tracking: display sizes compress hard,
      // body sizes relax back to normal. These are the steps the type scale
      // actually uses.
      letterSpacing: {
        display: "-0.05em",
        headline: "-0.032em",
        title: "-0.02em",
        label: "-0.012em",
      },
      boxShadow: {
        hairline: "0 0 0 1px hsl(var(--border))",
        card: "0 0 0 1px hsl(var(--border)), 0 1px 2px hsl(var(--shadow) / 0.05)",
        raised:
          "0 0 0 1px hsl(var(--border)), 0 2px 4px hsl(var(--shadow) / 0.06), 0 24px 48px -24px hsl(var(--shadow) / 0.24)",
        pop: "0 0 0 1px hsl(var(--border)), 0 8px 28px -8px hsl(var(--shadow) / 0.28)",
      },
      // Durations and easing come from the --dur-* / --ease-* tokens in
      // globals.css, so motion stays in step with the rest of the system.
      keyframes: {
        "fade-in": { from: { opacity: "0" }, to: { opacity: "1" } },
        "slide-up": {
          from: { opacity: "0", transform: "translateY(6px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "overlay-in": { from: { opacity: "0" }, to: { opacity: "1" } },
        "panel-in-right": {
          from: { opacity: "0", transform: "translateX(12px)" },
          to: { opacity: "1", transform: "none" },
        },
        "panel-in-left": {
          from: { opacity: "0", transform: "translateX(-12px)" },
          to: { opacity: "1", transform: "none" },
        },
        "panel-in-up": {
          from: { opacity: "0", transform: "translateY(8px) scale(0.99)" },
          to: { opacity: "1", transform: "none" },
        },
        "row-in": { from: { opacity: "0", transform: "translateY(4px)" }, to: { opacity: "1", transform: "none" } },
        "pop-in": { from: { opacity: "0", transform: "scale(0.97)" }, to: { opacity: "1", transform: "none" } },
        shimmer: { from: { backgroundPosition: "-200% 0" }, to: { backgroundPosition: "200% 0" } },
      },
      animation: {
        "fade-in": "fade-in var(--dur-base) var(--ease-out) both",
        "slide-up": "slide-up var(--dur-base) var(--ease-out) both",
        "overlay-in": "overlay-in var(--dur-base) var(--ease-out) both",
        "panel-in-right": "panel-in-right var(--dur-base) var(--ease-out) both",
        "panel-in-left": "panel-in-left var(--dur-base) var(--ease-out) both",
        "panel-in-up": "panel-in-up var(--dur-base) var(--ease-out) both",
        "row-in": "row-in var(--dur-fast) var(--ease-out) both",
        "pop-in": "pop-in var(--dur-fast) var(--ease-out) both",
        shimmer: "shimmer 1.6s linear infinite",
      },
    }
  },
  plugins: [],
};

export default config;
