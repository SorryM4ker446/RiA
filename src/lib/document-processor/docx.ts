import JSZip from "jszip";
import { escapeMarkup, plainText, type DocumentNode, type DocumentTree } from "./ast";

const namespace = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const relationships = "http://schemas.openxmlformats.org/package/2006/relationships";
const officeRelationships = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const xml = (body: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${body}`;
type Marks = { bold?: boolean; italic?: boolean; strike?: boolean; code?: boolean };
function run(value: string, marks: Marks = {}) {
  const properties = `${marks.code ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>' : ""}${marks.bold ? "<w:b/>" : ""}${marks.italic ? "<w:i/>" : ""}${marks.strike ? "<w:strike/>" : ""}${marks.code ? '<w:shd w:fill="F4F4F5"/>' : ""}`;
  return `<w:r>${properties ? `<w:rPr>${properties}</w:rPr>` : ""}${value.split(/(\n|\t)/).map(part => part === "\n" ? "<w:br/>" : part === "\t" ? "<w:tab/>" : `<w:t xml:space="preserve">${escapeMarkup(part)}</w:t>`).join("")}</w:r>`;
}
export async function wordDocument(tree: DocumentTree, signal?: AbortSignal) {
  const numbering: Array<{ abstract: string; num: string }> = [];
  function inline(node: DocumentNode, marks: Marks = {}): string {
    const children = () => "children" in node ? node.children.map(child => inline(child, marks)).join("") : "";
    switch (node.type) {
      case "strong": return node.children.map(child => inline(child, { ...marks, bold: true })).join("");
      case "emphasis": return node.children.map(child => inline(child, { ...marks, italic: true })).join("");
      case "delete": return node.children.map(child => inline(child, { ...marks, strike: true })).join("");
      case "inlineCode": return run(node.value, { ...marks, code: true });
      case "text": case "html": return run(node.value, marks);
      case "break": return run("\n", marks);
      case "image": case "imageReference": case "link": case "linkReference": case "footnoteReference": return run(plainText(node, tree), marks);
      default: return children();
    }
  }
  const paragraph = (content: string, properties = "") => `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ""}${content}</w:p>`;
  function block(node: DocumentNode, level = 0, listId?: number): string {
    signal?.throwIfAborted();
    const children = () => "children" in node ? node.children.map(child => block(child, level)).join("") : "";
    const listProperties = listId === undefined ? "" : `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${listId}"/></w:numPr><w:ind w:left="${(level + 1) * 360}" w:hanging="240"/>`;
    switch (node.type) {
      case "root": return children();
      case "heading": return paragraph(inline(node), `<w:pStyle w:val="Heading${node.depth}"/>${listProperties}`);
      case "paragraph": return paragraph(inline(node), listProperties);
      case "code": return paragraph(run(node.value, { code: true }), '<w:pStyle w:val="CodeBlock"/>');
      case "blockquote": return paragraph(run(plainText(node, tree).trim()), '<w:ind w:left="480"/><w:pStyle w:val="Quote"/>');
      case "thematicBreak": return paragraph(run("———"));
      case "definition": return "";
      case "table": {
        const columns = Math.max(1, ...node.children.map(row => row.children.length));
        return `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map(side => `<w:${side} w:val="single" w:sz="4" w:color="DDDDDD"/>`).join("")}</w:tblBorders></w:tblPr><w:tblGrid>${Array(columns).fill(`<w:gridCol w:w="${Math.floor(9360 / columns)}"/>`).join("")}</w:tblGrid>${node.children.map((row, index) => `<w:tr>${index === 0 ? "<w:trPr><w:tblHeader/></w:trPr>" : ""}${row.children.map(cell => `<w:tc><w:tcPr><w:tcW w:w="${Math.floor(9360 / columns)}" w:type="dxa"/>${index === 0 ? '<w:shd w:fill="F4F4F5"/>' : ""}</w:tcPr>${paragraph(index === 0 ? cell.children.map(child => inline(child, { bold: true })).join("") : inline(cell))}</w:tc>`).join("")}</w:tr>`).join("")}</w:tbl>${paragraph("")}`;
      }
      case "list": {
        const id = numbering.length + 1;
        numbering.push({ abstract: `<w:abstractNum w:abstractNumId="${id}"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="${node.ordered ? node.start ?? 1 : 1}"/><w:numFmt w:val="${node.ordered ? "decimal" : "bullet"}"/><w:lvlText w:val="${node.ordered ? "%1." : "•"}"/><w:lvlJc w:val="left"/></w:lvl></w:abstractNum>`, num: `<w:num w:numId="${id}"><w:abstractNumId w:val="${id}"/></w:num>` });
        return node.children.map(item => item.children.map((child, index) => {
          const result = block(child, child.type === "list" ? level + 1 : level, index === 0 ? id : undefined);
          return index === 0 && item.checked != null ? result.replace(/(<w:p>(?:<w:pPr>.*?<\/w:pPr>)?)/, `$1${run(item.checked ? "☑ " : "☐ ")}`) : result;
        }).join("")).join("");
      }
      case "footnoteDefinition": return paragraph(run(`注释 ${node.identifier}：${node.children.map(child => plainText(child, tree)).join("").trim()}`));
      default: return paragraph(inline(node), listProperties);
    }
  }
  const body = block(tree.root);
  const zip = new JSZip();
  zip.file("[Content_Types].xml", xml('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>'));
  zip.file("_rels/.rels", xml(`<Relationships xmlns="${relationships}"><Relationship Id="document" Type="${officeRelationships}/officeDocument" Target="word/document.xml"/></Relationships>`));
  zip.file("word/document.xml", xml(`<w:document xmlns:w="${namespace}"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1273" w:bottom="1440" w:left="1273"/></w:sectPr></w:body></w:document>`));
  zip.file("word/_rels/document.xml.rels", xml(`<Relationships xmlns="${relationships}"><Relationship Id="styles" Type="${officeRelationships}/styles" Target="styles.xml"/><Relationship Id="numbering" Type="${officeRelationships}/numbering" Target="numbering.xml"/></Relationships>`));
  zip.file("word/styles.xml", xml(`<w:styles xmlns:w="${namespace}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Microsoft YaHei"/><w:sz w:val="22"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="320" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>${[1, 2, 3, 4, 5, 6].map(depth => `<w:style w:type="paragraph" w:styleId="Heading${depth}"><w:name w:val="heading ${depth}"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="280" w:after="160"/><w:outlineLvl w:val="${depth - 1}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${[36, 30, 26, 24, 22, 22][depth - 1]}"/></w:rPr></w:style>`).join("")}<w:style w:type="paragraph" w:styleId="CodeBlock"><w:name w:val="Code Block"/><w:basedOn w:val="Normal"/><w:pPr><w:shd w:fill="F4F4F5"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:rPr><w:i/></w:rPr></w:style></w:styles>`));
  zip.file("word/numbering.xml", xml(`<w:numbering xmlns:w="${namespace}">${numbering.map(item => item.abstract).join("")}${numbering.map(item => item.num).join("")}</w:numbering>`));
  signal?.throwIfAborted();
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
