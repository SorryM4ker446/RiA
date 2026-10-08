/** Split pipe tables without treating escaped delimiters or inline code as cells. */
export function tableCells(line: string): string[] {
  const cells: string[] = []; let cell = ""; let escaped = false; let code = 0;
  let text = line.trim().replace(/^\|/u, "");
  if (text.endsWith("|")) {
    let backslashes = 0;
    for (let index = text.length - 2; index >= 0 && text[index] === "\\"; index--) backslashes++;
    if (backslashes % 2 === 0) text = text.slice(0, -1);
  }
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (escaped) { cell += character; escaped = false; continue; }
    if (character === "\\") { cell += character; escaped = true; continue; }
    if (character === "`") {
      let end = index + 1; while (text[end] === "`") end++;
      const length = end - index; code = code === length ? 0 : code || length;
      cell += text.slice(index, end); index = end - 1; continue;
    }
    if (character === "|" && !code) { cells.push(cell.trim()); cell = ""; } else cell += character;
  }
  cells.push(cell.trim()); return cells;
}

export function documentBlocks(text: string) {
  const lines = text.split("\n"); const blocks: Array<{ text: string; table: boolean }> = [];
  let paragraph: string[] = []; let fence: string | null = null;
  const flush = () => { if (paragraph.length) blocks.push({ text: paragraph.join("\n").trim(), table: false }); paragraph = []; };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]; const marker = /^\s{0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker; else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      paragraph.push(line); continue;
    }
    if (!fence && line.includes("|") && index + 1 < lines.length) {
      const header = tableCells(line); const divider = tableCells(lines[index + 1]);
      if (header.length >= 1 && header.length === divider.length && divider.every(cell => /^:?-{3,}:?$/u.test(cell))) {
        flush(); const table = [line, lines[++index]];
        while (index + 1 < lines.length && lines[index + 1].includes("|") && tableCells(lines[index + 1]).length === header.length) table.push(lines[++index]);
        blocks.push({ text: table.join("\n"), table: true }); continue;
      }
    }
    if (!fence && (!line.trim() || /^#{1,6}\s/u.test(line))) { flush(); if (line.trim()) paragraph.push(line); }
    else paragraph.push(line);
  }
  flush(); return blocks;
}

export function tableChunks(text: string, limit = 1000) {
  const [header, divider, ...rows] = text.split("\n"); const prefix = `${header}\n${divider}`;
  const chunks: string[] = []; let current = prefix;
  if (prefix.length > limit || rows.some(row => prefix.length + row.length + 1 > limit)) throw new Error("表格表头与单行合计超过 1000 字符，请先拆分宽表或过长单元格。");
  for (const row of rows) {
    if (current.length + row.length + 1 > limit) { chunks.push(current); current = prefix; }
    current += `\n${row}`;
  }
  chunks.push(current); return chunks;
}
