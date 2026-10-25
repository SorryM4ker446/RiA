// Lists every animation or transition timing that is not one of the motion
// tokens defined on :root in src/app/globals.css (--dur-*, --ease-*,
// --stagger-*, --delay-*). Exits non-zero when any is found, so a new hard-coded 200ms or
// ease-out shows up in review instead of drifting the app's rhythm.
//
//   node scripts/check-motion.mjs
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const files = [];
(function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (/\.(css|tsx?)$/.test(entry.name)) files.push(path);
  }
})(join(root, "src"));
files.push(join(root, "tailwind.config.ts"));

const findings = [];
const report = (file, line, text, why) => findings.push(`${relative(root, file).replaceAll("\\", "/")}:${line}  ${why}  ${text.trim().slice(0, 140)}`);

// A literal time or easing inside a motion declaration. Token definitions on
// :root are the one place literals belong; 0s/0ms switches motion off.
const motionProperty = /\b(transition|animation)(-duration|-delay|-timing-function)?\s*:/;
const literalTime = /(?<![\w-])(?!0m?s\b)\d*\.?\d+m?s\b/;
const literalEasing = /cubic-bezier\(|steps\(|(?<![\w-])(ease|ease-in|ease-out|ease-in-out|linear)(?![\w-])/;
// Tailwind classes that set a duration, delay or easing without a token.
const utility = /(?<![\w[-])(duration|delay)-(\d+|\[\d*\.?\d+m?s\])(?![\w-])|(?<![\w[-])ease-(in|out|in-out|linear)(?![\w-])/;
// Inline style or Web Animations timings written as literals.
const inlineTiming = /\b(transition|animation)\w*\s*[:=]\s*[`"'][^`"']*\d+m?s/;
const animateOptions = /\b(duration|delay)\s*:\s*\d+/;

for (const file of files) {
  const source = readFileSync(file, "utf8");
  // A file may opt out with a stated reason, for choreography timed as a whole.
  if (/motion-exempt: \S/.test(source)) continue;
  const lines = source.split(/\r?\n/);
  const css = file.endsWith(".css");
  lines.forEach((text, index) => {
    const line = index + 1;
    if (css) {
      if (/^\s*--(dur|ease|stagger|delay)-[\w-]+\s*:/.test(text)) return;
      for (const declaration of text.split(";")) {
        if (!motionProperty.test(declaration)) continue;
        if (literalTime.test(declaration.replace(/var\([^)]*\)/g, ""))) report(file, line, declaration, "time");
        if (literalEasing.test(declaration.replace(/var\([^)]*\)/g, "").replace(/allow-discrete/g, ""))) report(file, line, declaration, "easing");
        // A shorthand that names a duration but no easing falls back to the
        // browser's `ease`, which is not one of the app's curves. Discrete
        // properties switch at a point and need none.
        const shorthand = /\b(transition|animation)\s*:(.*)$/.exec(declaration);
        if (shorthand) for (const item of shorthand[2].split(/,(?![^(]*\))/)) {
          if (/var\(--dur-/.test(item) && !/var\(--ease-/.test(item) && !/allow-discrete/.test(item)) report(file, line, item, "no easing");
        }
      }
      return;
    }
    if (utility.test(text)) report(file, line, text, "utility");
    if (inlineTiming.test(text)) report(file, line, text, "inline");
    if (animateOptions.test(text) && /\.animate\(/.test(text)) report(file, line, text, "animate()");
  });
}

if (findings.length) {
  console.log(`${findings.length} motion timing(s) outside the tokens:\n${findings.join("\n")}`);
  process.exitCode = 1;
} else console.log("All motion timings use the tokens.");
