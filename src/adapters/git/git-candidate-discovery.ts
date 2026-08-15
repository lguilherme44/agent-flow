import type { GitClient } from './git-client.js';
import {
  filterAndNormalizeCandidatePaths,
  type CandidateDiscovery,
  type CandidateFilterOptions,
} from '../../core/repository-retriever.js';

/**
 * Discovers candidate repository files using the hook-isolated GitClient (M3-04).
 */
export class GitCandidateDiscovery implements CandidateDiscovery {
  constructor(
    private readonly gitClient: GitClient,
    private readonly options?: CandidateFilterOptions,
  ) {}

  async discoverCandidates(_projectDir: string, objective?: string): Promise<readonly string[]> {
    const isRepo = await this.gitClient.isRepository();
    if (!isRepo) {
      return Object.freeze([]);
    }
    const tracked = await this.gitClient.trackedFiles();
    return filterAndNormalizeCandidatePaths(tracked, {
      ...this.options,
      objective: objective ?? this.options?.objective,
    });
  }
}
