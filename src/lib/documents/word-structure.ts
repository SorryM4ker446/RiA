type WordNode = { type: string; value?: string; children?: WordNode[]; body?: WordNode[]; styleId?: string; styleName?: string;
  numbering?: { isOrdered?: boolean }; colSpan?: number; rowSpan?: number; isHeader?: boolean; checked?: boolean };

/** Self-contained because the bounded parser worker runs this function's source. */
export function serializeWordDocument(document: WordNode, limit: number): string {
  let visited = 0;
  const fail = () => { throw Object.assign(new Error("文档结构过大或表格跨度无效。"), { code: "PAYLOAD_TOO_LARGE" }); };
  const bounded = (value: string) => { if (value.length > limit) fail(); return value; };
  const cellText = (value: string) => value.trim().replace(/\r?\n+/g, " / ").replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/`/g, "\\`");
  function render(node: WordNode, depth = 0): string {
    if (++visited > 100_000 || depth > 64) fail();
    if (node.type === "text") return bounded(node.value ?? "");
    if (node.type === "tab") return "\t";
    if (node.type === "break") return "\n";
    if (node.type === "checkbox") return node.checked ? "[x] " : "[ ] ";
    if (node.type === "image" || node.type === "commentReference") return "";
    if (node.type === "table") {
      const rows = node.children ?? [];
      if (rows.length > 2000) fail();
      const grid: string[][] = rows.map(() => []);
      rows.forEach((row, index) => {
        let column = 0;
        for (const cell of row.children ?? []) {
          while (grid[index][column] !== undefined) column++;
          const width = cell.colSpan ?? 1; const height = cell.rowSpan ?? 1;
          if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || column + width > 64 || index + height > rows.length) fail();
          const text = cellText((cell.children ?? []).map(child => render(child, depth + 1)).join(""));
          const value = text + (width > 1 || height > 1 ? `（合并 ${height} 行/${width} 列）` : "");
          for (let y = index; y < index + height; y++) for (let x = column; x < column + width; x++) {
            if (grid[y][x] !== undefined) fail(); grid[y][x] = value;
          }
          column += width;
        }
      });
      const columns = Math.max(0, ...grid.map(row => row.length));
      if (!columns) return "";
      const headers = rows[0]?.isHeader ? grid.shift()! : Array.from({ length: columns }, (_, index) => `列 ${index + 1}`);
      const line = (row: string[]) => `| ${Array.from({ length: columns }, (_, index) => row[index] ?? "").join(" | ")} |`;
      return bounded([line(headers), line(Array(columns).fill("---")), ...grid.map(line)].join("\n") + "\n\n");
    }
    const children = bounded((node.children ?? node.body ?? []).map(child => render(child, depth + 1)).join(""));
    if (node.type === "paragraph") {
      const heading = /^(?:heading|标题)\s*([1-6])$/i.exec(node.styleName ?? node.styleId ?? "");
      const prefix = heading ? "#".repeat(Number(heading[1])) + " " : node.numbering ? (node.numbering.isOrdered ? "1. " : "- ") : "";
      return bounded(prefix + children.trim() + "\n\n");
    }
    return children;
  }
  return bounded(render(document)).trim();
}
