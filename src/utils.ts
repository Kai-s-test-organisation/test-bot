import {GITHUB_TO_SLACK_USER_MAP, REVIEWER_GROUP_CHANNEL_MAP, TWO_APPROVAL_REPOS} from "./config.js";
import {PrSlackMessageInfo} from "./types.js";
import {PullRequestEvent, PullRequestReviewCommentEvent, PullRequestReviewEvent} from "@octokit/webhooks-types";

/**
 * Finds the Slack channel ID for a given GitHub reviewer group.
 * @param reviewerGroups An array of GitHub team objects (e.g., from pull_request.requested_teams).
 * @returns The Slack channel ID or null if no mapping is found.
 */
export function getSlackChannelForReviewerGroup(reviewerGroups: any[]): string | null {
    return "C0904A41ABH"
    for (const group of reviewerGroups) {
        if (group.slug && REVIEWER_GROUP_CHANNEL_MAP[group.slug]) {
            return REVIEWER_GROUP_CHANNEL_MAP[group.slug];
        }
    }
    return null;
}

/**
 * Maps a GitHub username to a Slack User ID.
 * @param githubUsername The GitHub username.
 * @returns The Slack User ID or null if no mapping is found.
 */
export function getSlackUserId(githubUsername: string): string | null {
    return GITHUB_TO_SLACK_USER_MAP[githubUsername] || null;
}

/**
 * Determines if a PR has enough approvals to be ready for merge
 * @param repoFullName The full repository name (owner/repo)
 * @param approvals Set of GitHub usernames who approved
 * @param changesRequested Set of GitHub usernames who requested changes
 * @returns true if PR is ready to merge
 */
export function isPrReadyToMerge(repoFullName: string, approvals: Set<string>, changesRequested: Set<string>): boolean {
    // If anyone has requested changes, PR is not ready
    if (changesRequested.size > 0) {
        return false;
    }

    const requiredApprovals = TWO_APPROVAL_REPOS.has(repoFullName) ? 2 : 1;
    return approvals.size >= requiredApprovals;
}

 /**
 * Helper function to parse stored PR info and convert arrays back to Sets
 */
 export function parsePrInfo(storedData: string): PrSlackMessageInfo {
    const parsed = JSON.parse(storedData);
    return {
        ...parsed,
        approvals: new Set(parsed.approvals || []),
        changesRequested: new Set(parsed.changesRequested || []),
        botReactions: new Set(parsed.botReactions || [])
    };
}

/**
 * Helper function to prepare PR info for Redis storage (convert Sets to Arrays)
 */
export function preparePrInfoForStorage(prInfo: PrSlackMessageInfo): any {
    return {
        ...prInfo,
        approvals: Array.from(prInfo.approvals),
        changesRequested: Array.from(prInfo.changesRequested),
        botReactions: Array.from(prInfo.botReactions)
    };
}

export const getPrMetaData = (data: PullRequestEvent | PullRequestReviewCommentEvent | PullRequestReviewEvent): {
    prNumber: number,
    repoId: number,
    repoFullName: string,
    redisPrKey: string
} => {
    return {
        prNumber: data.pull_request.number,
        repoId: data.repository.id,
        repoFullName: data.repository.full_name,
        redisPrKey: `pr:${data.repository.id}:${data.pull_request.number}`,
    }
}