/* eslint-disable camelcase */
import { Octokit } from '@octokit/rest';
import type { RequestError as OctokitRequestError } from '@octokit/types';
import { promises as fs } from 'fs';
import path from 'path';
import semver from 'semver/preload';
import { promisify } from 'util';

type Repo = {
  owner: string;
  repo: string;
};

type Release = {
  name: string;
  tag: string;
  notes: string;
};

type Asset = {
  name?: string;
  path: string;
  contentType?: string;
};

type Tag = {
  name: string;
  sha: string;
};

type ReleaseAsset = {
  id: number;
  name: string;
  url: string;
};

type ReleaseDetails = {
  draft: boolean;
  upload_url: string;
  id: number;
  assets?: ReleaseAsset[];
  html_url: string;
  tag_name: string;
};

type Branch = {
  ref: string;
  url: string;
  object: {
    sha: string;
    type: string;
    url: string;
  };
};

const setTimeoutAsync = promisify(setTimeout);

function throwRetryableError(message: string): never {
  const err = new Error(message);
  (err as any).retry = true;
  throw err;
}

function isRetryableError(err: any): boolean {
  return err.retry === true;
}

function isOctokitError(err: any): err is OctokitRequestError {
  return 'status' in err;
}

async function waitFor<T>(
  fn: (...args: unknown[]) => Promise<T>,
  timeout = 60_000,
  interval = 100,
  message:
    | string
    | ((err: any, attempts: number) => string) = 'Timeout exceeded for task',
  signal?: AbortSignal
): Promise<T> {
  let lastError: any;
  let attempts = 0;
  const controller = new AbortController();
  // eslint-disable-next-line chai-friendly/no-unused-expressions
  signal?.addEventListener('abort', () => {
    controller.abort(signal.reason);
  });
  const tid = setTimeout(() => {
    controller.abort(
      new Error(
        typeof message === 'function' ? message(lastError, attempts) : message
      )
    );
  }, timeout);
  try {
    while (!controller.signal.aborted) {
      try {
        attempts++;
        return await fn();
      } catch (err) {
        lastError = err;
        await setTimeoutAsync(interval);
      }
    }
    // If we ended up here either timeout expired or passed signal was aborted,
    // either way this internal controller was aborted with a correct reason
    throw controller.signal.reason;
  } finally {
    clearTimeout(tid);
  }
}

export class GithubRepo {
  private octokit: Octokit;
  readonly repo: Readonly<Repo>;

  constructor(repo: Repo, octokit: Octokit) {
    this.octokit = octokit;
    this.repo = Object.freeze({ ...repo });
  }

  /**
   * Returns the most recent draft tag for the given release version (without leading `v`).
   */
  async getMostRecentDraftTagForRelease(
    releaseVersion: string | undefined
  ): Promise<Tag | undefined> {
    if (!releaseVersion) {
      return undefined;
    }

    const sortedTags = (await this.getTagsOrdered()).filter(
      (t) =>
        t.name &&
        t.name.startsWith(`v${releaseVersion}-draft`) &&
        t.name.match(/^v\d+\.\d+\.\d+-draft\.\d+/)
    );

    const mostRecentTag = sortedTags[0];
    return mostRecentTag
      ? {
        name: mostRecentTag.name,
        sha: mostRecentTag.sha,
      }
      : undefined;
  }

  /**
   * Returns the predecessor release tag of the given release (without leading `v`).
   * @param releaseVersion The successor release
   */
  async getPreviousReleaseTag(
    releaseVersion: string | undefined
  ): Promise<Tag | undefined> {
    const releaseSemver = semver.parse(releaseVersion);
    if (!releaseSemver) {
      return undefined;
    }

    return (await this.getTagsOrdered())
      .filter((t) => t.name.match(/^v\d+\.\d+\.\d+$/))
      .find((t) => {
        const tagSemver = semver.parse(t.name);
        return tagSemver && tagSemver.compare(releaseSemver) < 0;
      });
  }

  /**
   * Get all tags from the Github repository, sorted by highest version to lowest version.
   * Tagged package releases (e.g. `foo@v2.3.4`) are sorted alphabetically, following tags
   * that are not associated with a specific package.
   */
  private async getTagsOrdered(): Promise<Tag[]> {
    const tags = await this.octokit.paginate<{name: string, commit: {sha: string}}>(
      'GET /repos/:owner/:repo/tags',
      this.repo
    );

    return tags
      .map((t) => ({
        name: t.name,
        sha: t.commit.sha,
        compareKey: ['', ...t.name.split('@')].slice(-2) // [pkgname | '', semver]
      }))
      .sort((t1, t2) => {
        if (t1.compareKey[0] < t2.compareKey[0]) return -1;
        if (t1.compareKey[0] > t2.compareKey[0]) return 1;
        return semver.rcompare(t1.compareKey[1], t2.compareKey[1]);
      }).map(({ name, sha }) => ({ name, sha }));
  }

  /**
   * Creates a new draft release or updates an existing draft release for the given details.
   * An existing release is discovered by a matching tag.
   *
   * @param release The release details
   */
  async updateDraftRelease(release: Release): Promise<void> {
    let existingRelease: ReleaseDetails | null = null;

    try {
      existingRelease = await this.getReleaseByTag(release.tag);
    } catch {
      // If we failed to get release by tag for whatever reason, try creating a
      // new one
      await this.octokit.repos
        .createRelease({
          ...this.repo,
          tag_name: release.tag,
          name: release.name,
          body: release.notes,
          draft: true,
        })
        .catch(this._ignoreAlreadyExistsError());

      existingRelease = await this.getReleaseByTag(release.tag);
    }

    if (!existingRelease.draft) {
      throw new Error(
        'Cannot update an existing release after it was published'
      );
    } else {
      await this.octokit.repos.updateRelease({
        ...this.repo,
        release_id: existingRelease.id,
        tag_name: release.tag,
        name: release.name,
        body: release.notes,
        draft: true,
      });
    }
  }

  async _uploadAsset(
    releaseDetails: ReleaseDetails,
    asset: Asset
  ): Promise<void> {
    const assetName = asset.name ?? path.basename(asset.path);
    const existingAsset = releaseDetails.assets?.find(
      (a) => a.name === assetName
    );

    if (existingAsset) {
      try {
        await this.octokit.repos.deleteReleaseAsset({
          ...this.repo,
          asset_id: existingAsset.id,
        });
      } catch (err) {
        if ((err as OctokitRequestError).status === 404) {
          // Sometimes the file would be in release details, but not acually
          // fully uploaded (potentially on retries?), leading to 404 errors
          // when trying to delete it. Ignore 404 errors for that reason. If
          // file actually exists, trying to upload it will fail anyway even if
          // we ignored the error here
        }
        throw err;
      }
    }

    const params = {
      method: 'POST',
      url: releaseDetails.upload_url,
      headers: asset.contentType ? {
        'content-type': asset.contentType,
      } : {},
      name: assetName,
      data: await fs.readFile(asset.path),
    };

    await this.octokit.request(params);
  }

  /**
   * Uploads an asset (or multiple assets) for a Github release, if the assets
   * already exists it will be removed and re-uploaded.
   */
  async uploadReleaseAsset(releaseTag: string, assets: Asset | Asset[]): Promise<void> {
    const releaseDetails = await this.getReleaseByTag(releaseTag);
    if (!Array.isArray(assets)) {
      assets = [assets];
    }
    // Doing in sequence to not overload GitHub with requests
    for (const asset of assets) {
      const controller = new AbortController();
      await waitFor(
        async() => {
          try {
            await this._uploadAsset(releaseDetails, asset);
          } catch (err) {
            if (!isOctokitError(err) && !isRetryableError(err)) {
              controller.abort(err);
            }
            throw err;
          }
        },
        process.env.TEST_UPLOAD_RELEASE_ASSET_TIMEOUT
          ? Number(process.env.TEST_UPLOAD_RELEASE_ASSET_TIMEOUT)
          // File upload is slow, we allow 10 minutes per file to allow for additional retries
          : 60_000 * 10,
        100,
        (lastError, attempts) => {
          return (
            `Failed to upload asset ${path.basename(asset.path)} after ${attempts} attempts` +
            (lastError
              ? `\n\nLast encountered error:\n\n${this._getErrorMessage(lastError)}`
              : '')
          );
        },
        controller.signal
      );
    }
  }

  async getReleaseByTag(tag: string): Promise<ReleaseDetails> {
    const controller = new AbortController();
    return await waitFor(
      async() => {
        try {
          const releases = await this.octokit.paginate<ReleaseDetails>(
            'GET /repos/:owner/:repo/releases',
            this.repo
          );
          const taggedRelease = releases.find(
            ({ tag_name }) => tag_name === tag
          );
          if (!taggedRelease) {
            throwRetryableError(`Can\'t find release with a tag ${tag}`);
          }
          return taggedRelease;
        } catch (err) {
          if (!isOctokitError(err) && !isRetryableError(err)) {
            controller.abort(err);
          }
          throw err;
        }
      },
      process.env.TEST_GET_RELEASE_TIMEOUT
        ? Number(process.env.TEST_GET_RELEASE_TIMEOUT)
        : 60_000,
      100,
      (lastError, attempts) => {
        return (
          `Failed to fetch releases from GitHub after ${attempts} attempts` +
          (lastError
            ? `\n\nLast encountered error:\n\n${this._getErrorMessage(lastError)}`
            : '')
        );
      },
      controller.signal
    );
  }

  async promoteRelease(config: {version: string}): Promise<string> {
    const tag = `v${config.version}`;

    const releaseDetails = await this.getReleaseByTag(tag);

    if (!releaseDetails.draft) {
      console.info(`Release for ${tag} is already public.`);
      return releaseDetails.html_url;
    }

    const params = {
      ...this.repo,
      release_id: releaseDetails.id,
      draft: false,
    };

    await this.octokit.repos.updateRelease(params);
    return releaseDetails.html_url;
  }

  /**
   * Creates a new branch pointing to the latest commit of the given source branch.
   * @param branchName The name of the branch (not including refs/heads/)
   * @param sourceSha The SHA hash of the commit to branch off from
   */
  async createBranch(branchName: string, sourceSha: string): Promise<void> {
    await this.octokit.git.createRef({
      ...this.repo,
      ref: `refs/heads/${branchName}`,
      sha: sourceSha,
    });
  }

  /**
   * Retrieves the details of the given branch.
   * @param branchName The name of the branch (not including refs/heads/)
   */
  async getBranchDetails(branchName: string): Promise<Branch> {
    const result = await this.octokit.git.getRef({
      ...this.repo,
      ref: `heads/${branchName}`,
    });
    return result.data;
  }

  /**
   * Removes the given branch by deleting the corresponding ref.
   * @param branchName The branch name to remove (not including refs/heads/)
   */
  async deleteBranch(branchName: string): Promise<void> {
    await this.octokit.git.deleteRef({
      ...this.repo,
      ref: `heads/${branchName}`,
    });
  }

  /**
   * Gets the content of the given file from the repository.
   * Assumes the loaded file is a utf-8 encoded text file.
   *
   * @param pathInRepo Path to the file from the repository root
   * @param branchOrTag Branch/tag name to load content from
   */
  async getFileContent(
    pathInRepo: string,
    branchOrTag: string
  ): Promise<{ blobSha: string; content: string }> {
    const response = await this.octokit.repos.getContents({
      ...this.repo,
      path: pathInRepo,
      ref: branchOrTag,
    });

    if (response.data.type !== 'file') {
      throw new Error(`${pathInRepo} does not reference a file`);
    } else if (response.data.encoding !== 'base64') {
      throw new Error(
        `Octokit returned unexpected encoding: ${response.data.encoding}`
      );
    }

    const content = Buffer.from(response.data.content, 'base64').toString(
      'utf-8'
    );
    return {
      blobSha: response.data.sha,
      content,
    };
  }

  /**
   * Updates the content of a given file in the repository.
   * Assumes the given file content is utf-8 encoded text.
   *
   * @param message The commit message
   * @param baseSha The blob SHA of the file to update
   * @param pathInRepo Path to the file from the repository root
   * @param newContent New file content
   * @param branch Branch name to commit to
   */
  async commitFileUpdate(
    message: string,
    baseSha: string,
    pathInRepo: string,
    newContent: string,
    branch: string
  ): Promise<{ blobSha: string; commitSha: string }> {
    const response = await this.octokit.repos.createOrUpdateFile({
      ...this.repo,
      message,
      content: Buffer.from(newContent, 'utf-8').toString('base64'),
      path: pathInRepo,
      sha: baseSha,
      branch,
    });

    return {
      blobSha: response.data.content.sha,
      commitSha: response.data.commit.sha,
    };
  }

  async createPullRequest(
    title: string,
    description: string,
    fromBranch: string,
    toBaseBranch: string
  ): Promise<{ prNumber: number; url: string }> {
    const response = await this.octokit.pulls.create({
      ...this.repo,
      base: toBaseBranch,
      head: fromBranch,
      title,
      body: description,
    });

    return {
      prNumber: response.data.number,
      url: response.data.html_url,
    };
  }

  async mergePullRequest(prNumber: number): Promise<void> {
    await this.octokit.pulls.merge({
      ...this.repo,
      pull_number: prNumber,
    });
  }

  private _ignoreAlreadyExistsError(): (error: any) => Promise<void> {
    // eslint-disable-next-line @typescript-eslint/require-await
    return async(error: any): Promise<void> => {
      if (this._isAlreadyExistsError(error)) {
        return;
      }
      throw error;
    };
  }

  private _isAlreadyExistsError(error: any): boolean {
    return (
      error.name === 'HttpError' &&
      error.status === 422 &&
      error.errors &&
      error.errors.length === 1 &&
      error.errors[0].code === 'already_exists'
    );
  }

  private _getErrorMessage(_err: any): string {
    if (_err.status) {
      return (
        (_err as OctokitRequestError).errors
          ?.map((err) => err.message ?? null)
          .filter((msg): msg is string => !!msg)
          .join('\n\n')
          .trim() || `Octokit request failed with ${_err.name} (${_err.status})`
      );
    }
    return _err.stack ?? _err.message;
  }
}
