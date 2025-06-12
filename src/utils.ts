import {
    GITHUB_TO_SLACK_USER_MAP,
    REVIEWER_GROUP_CHANNEL_MAP,
    THREE_DAYS_IN_SECONDS,
    TWO_APPROVAL_REPOS
} from "./config.js";
import {PrSlackMessageInfo, SlackSlashCommandPayload} from "./types.js";
import {PullRequestEvent, PullRequestReviewCommentEvent, PullRequestReviewEvent} from "@octokit/webhooks-types";
import { redis } from "./index.js";
import { createHmac, timingSafeEqual } from 'crypto'
import type { Context, Next, MiddlewareHandler } from 'hono'

/**
 * Finds the Slack channel ID for a given GitHub reviewer group.
 * @param reviewerGroups An array of GitHub team objects (e.g., from pull_request.requested_teams).
 * @returns The Slack channel ID or null if no mapping is found.
 */
export function getSlackChannelForReviewerGroup(reviewerGroups: any[]): string | null {
    // return "C0904A41ABH"
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

/**
 * Get some common useful information from the PR events.
 * @param data
 */
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

export function setPrMessageInfo(redisPrKey:string, prInfo: PrSlackMessageInfo): any {
    redis.setex(redisPrKey, THREE_DAYS_IN_SECONDS, JSON.stringify(preparePrInfoForStorage(prInfo)));
}




// Slack signature verification middleware
export const verifySlackSignature = (signingSecret: string): MiddlewareHandler => {
    return async (c: Context, next: Next) => {
        const signature = c.req.header('x-slack-signature')
        const timestamp = c.req.header('x-slack-request-timestamp')
        const body = await c.req.text()

        // Check if signature and timestamp are present
        if (!signature || !timestamp) {
            return c.json({ error: 'Missing signature or timestamp' }, 401)
        }

        // Check if request is too old (prevent replay attacks)
        const currentTime = Math.floor(Date.now() / 1000)
        if (Math.abs(currentTime - parseInt(timestamp)) > 300) { // 5 minutes
            return c.json({ error: 'Request too old' }, 401)
        }

        // Slack's signature format: v0:{timestamp}:{body}
        const sigBaseString = `v0:${timestamp}:${body}`

        // Create HMAC hash
        const hmac = createHmac('sha256', signingSecret)
        hmac.update(sigBaseString)
        const computedSignature = `v0=${hmac.digest('hex')}`

        // Compare signatures using timing-safe comparison
        const sigBuffer = Buffer.from(signature)
        const computedBuffer = Buffer.from(computedSignature)

        if (sigBuffer.length !== computedBuffer.length ||
            !timingSafeEqual(sigBuffer, computedBuffer)) {
            return c.json({ error: 'Invalid signature' }, 401)
        }

        // Store the parsed body for later use
        c.set('slackBody', body)

        await next()
    }
}

// Helper function to parse only the fields we need
export const parseSlackBody = (body: string): Partial<SlackSlashCommandPayload> => {
    const params = new URLSearchParams(body)
    return {
        user_id: params.get('user_id') || undefined,
        channel_id: params.get('channel_id') || undefined,
        text: params.get('text') || undefined,
    }
}
