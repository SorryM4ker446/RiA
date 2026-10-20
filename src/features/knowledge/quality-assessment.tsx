"use client";
import { useLocale } from "@/lib/locale/client";
import { t } from "@/lib/locale";
import type { EvaluationReport } from "@/lib/documents/evaluation";

const verdicts = () => ({ pass: t("ui.knowledge.quality-assessment.pass"), fail: t("ui.knowledge.quality-assessment.fail"), uncertain: t("ui.knowledge.quality-assessment.uncertain"), "not-applicable": t("ui.knowledge.quality-assessment.notApplicable") });
const kinds = (): Record<string, string> => ({ grounding: t("ui.knowledge.quality-assessment.evidenceSupport"), citations: t("ui.knowledge.quality-assessment.citationSupport"), answerability: t("ui.knowledge.quality-assessment.answersRefusals"), fact: t("ui.knowledge.quality-assessment.facts"), condition: t("ui.knowledge.quality-assessment.conditions"), exception: t("ui.knowledge.quality-assessment.exceptions"), quantity: t("ui.knowledge.quality-assessment.quantitiesUnits"), conflict: t("ui.knowledge.quality-assessment.conflictHandling") });

export function QualityAssessment({ value }: { value: EvaluationReport["cases"][number]["quality"] }) {
  useLocale();
  if (!value) return null;
  return <div className="space-y-2 rounded border p-3 text-xs" data-testid="quality-assessment">
    <p className="font-medium">{t("ui.knowledge.quality-assessment.modelSemanticReview")}{value.responseModelId ? ` · ${value.responseModelId}` : ""}</p>
    {value.status === "failed" ? <p role="alert" className="text-destructive">{t("ui.knowledge.quality-assessment.reviewFailed")}{value.errorCode}{t("ui.knowledge.quality-assessment.retrievedEvidenceAndGeneratedAnswersAre")}</p> : <>
      <p>{t("ui.knowledge.quality-assessment.pass")}{value.checks.filter(check => check.verdict === "pass").length} {t("ui.knowledge.quality-assessment.failed")}{value.checks.filter(check => check.verdict === "fail").length} {t("ui.knowledge.quality-assessment.uncertain2")}{value.checks.filter(check => check.verdict === "uncertain").length} {t("ui.knowledge.quality-assessment.notApplicable2")}{value.checks.filter(check => check.verdict === "not-applicable").length}</p>
      <ul className="space-y-3">{value.checks.map(check => {
        const criterion = value.criteria.find(item => item.id === check.id);
        return <li key={check.id} className="space-y-1 break-words">
          <p className={check.verdict === "fail" ? "font-medium text-destructive" : "font-medium"}>{kinds()[criterion?.kind ?? ""] ?? check.id}：{verdicts()[check.verdict]}</p>
          {criterion && !["grounding", "citations", "answerability"].includes(check.id) ? <p>{t("ui.knowledge.quality-assessment.expected")}{criterion.statement}</p> : null}
          <p>{check.reason}</p>
          {check.answerQuote ? <blockquote className="border-l-2 pl-2">{t("ui.knowledge.quality-assessment.answerExcerpt")}{check.answerQuote}</blockquote> : null}
          {check.evidence.map((item, index) => <blockquote key={index} className="border-l-2 pl-2">{t("ui.knowledge.quality-assessment.evidenceExcerpt")}{item.quote}</blockquote>)}
        </li>;
      })}</ul>
    </>}
    <p className="text-muted-foreground">{t("ui.knowledge.quality-assessment.excerptsWereCheckedAgainstActualAnswers")}</p>
  </div>;
}
