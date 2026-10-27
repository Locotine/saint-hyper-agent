// FILE: lib/githubStars.ts
// Purpose: Fetches and formats the public GitLab star count shown in the navbar.
// Layer: server utility.

const GITLAB_PROJECT_API_URL = "https://gitlab.com/api/v4/projects/locotine%2Fsaint-hyper-agent";

export async function getStars(): Promise<number | null> {
  if (process.env.VISUAL_TEST === "1") return 4300;

  try {
    const res = await fetch(GITLAB_PROJECT_API_URL, { next: { revalidate: 3600 } });
    if (!res.ok) return null;
    const data = await res.json();
    return data.star_count ?? null;
  } catch {
    return null;
  }
}

export function formatStars(count: number): string {
  if (count >= 1000) {
    const k = count / 1000;
    return k >= 100 ? `${Math.round(k)}K` : `${k.toFixed(1).replace(/\.0$/, "")}K`;
  }
  return count.toString();
}
