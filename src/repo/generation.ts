const repoGenerations = new Map<string, number>();

export interface RepoGenerationSnapshot {
  repoGeneration: number;
  detectedAt: number;
}

export function getRepoGenerationSnapshot(projectDir: string, now = Date.now()): RepoGenerationSnapshot {
  const repoGeneration = repoGenerations.get(projectDir) ?? 1;
  repoGenerations.set(projectDir, repoGeneration);
  return { repoGeneration, detectedAt: now };
}

export function bumpRepoGeneration(projectDir: string, now = Date.now()): RepoGenerationSnapshot {
  const repoGeneration = (repoGenerations.get(projectDir) ?? 1) + 1;
  repoGenerations.set(projectDir, repoGeneration);
  return { repoGeneration, detectedAt: now };
}

export function __resetRepoGenerationsForTests(): void {
  repoGenerations.clear();
}
