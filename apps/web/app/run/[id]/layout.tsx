import RunShell from "@/components/RunShell";

export default async function RunLayout({ children, params }: { children: React.ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RunShell id={id}>{children}</RunShell>;
}
