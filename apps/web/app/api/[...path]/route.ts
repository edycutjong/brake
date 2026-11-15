import { api } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const handle = (req: Request) => api()(req);
export const GET = handle;
export const POST = handle;
