import Link from "next/link";
export function TopicEntry() {
  return <p className="text-sm"><Link className="underline underline-offset-4" href="/topics">打开知识专题工作区</Link> · 按资料集合组织会话，并生成带来源的报告、方案和总结。</p>;
}
