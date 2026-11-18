// Loaded only when an answer holds a formula: the parser, the renderer and KaTeX's fonts and styles.
import "katex/dist/katex.min.css";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";

export const mathRuntime = { remarkMath, rehypeKatex };
