import type { EvaluationReport } from "@/lib/documents/evaluation";

const verdicts = { pass: "通过", fail: "未通过", uncertain: "不确定", "not-applicable": "不适用" };
const kinds: Record<string, string> = { grounding: "证据支持", citations: "引用支持", answerability: "回答与拒答", fact: "事实", condition: "前提条件", exception: "例外", quantity: "数值与单位", conflict: "冲突处理" };

export function QualityAssessment({ value }: { value: EvaluationReport["cases"][number]["quality"] }) {
  if (!value) return null;
  return <div className="space-y-2 rounded border p-3 text-xs" data-testid="quality-assessment">
    <p className="font-medium">模型语义评审{value.responseModelId ? ` · ${value.responseModelId}` : ""}</p>
    {value.status === "failed" ? <p role="alert" className="text-destructive">评审失败：{value.errorCode}。检索证据和已生成回答仍可检查；此题没有语义评审结论。</p> : <>
      <p>通过 {value.checks.filter(check => check.verdict === "pass").length} · 未通过 {value.checks.filter(check => check.verdict === "fail").length} · 不确定 {value.checks.filter(check => check.verdict === "uncertain").length} · 不适用 {value.checks.filter(check => check.verdict === "not-applicable").length}</p>
      <ul className="space-y-3">{value.checks.map(check => {
        const criterion = value.criteria.find(item => item.id === check.id);
        return <li key={check.id} className="space-y-1 break-words">
          <p className={check.verdict === "fail" ? "font-medium text-destructive" : "font-medium"}>{kinds[criterion?.kind ?? ""] ?? check.id}：{verdicts[check.verdict]}</p>
          {criterion && !["grounding", "citations", "answerability"].includes(check.id) ? <p>期望：{criterion.statement}</p> : null}
          <p>{check.reason}</p>
          {check.answerQuote ? <blockquote className="border-l-2 pl-2">回答摘录：{check.answerQuote}</blockquote> : null}
          {check.evidence.map((item, index) => <blockquote key={index} className="border-l-2 pl-2">证据摘录：{item.quote}</blockquote>)}
        </li>;
      })}</ul>
    </>}
    <p className="text-muted-foreground">摘录已核对实际回答和证据；语义判断由模型给出，可能误判，需要人工复核。</p>
  </div>;
}
