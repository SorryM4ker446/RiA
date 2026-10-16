import { TopicWorkspace } from "@/features/topics/topic-workspace";
export default async function TopicPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TopicWorkspace key={id} topicId={id} />;
}
