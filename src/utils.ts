import {PullRequestEvent, PullRequestReviewCommentEvent, PullRequestReviewEvent, Team} from "@octokit/webhooks-types";
import { createHmac, timingSafeEqual } from 'crypto'
import type { Context, Next, MiddlewareHandler } from 'hono'
import {
    TWO_APPROVAL_REPOS
} from "./config.js";
import {SlackSlashCommandPayload} from "./types.js";
import {mapper} from "./db.js"
import { Mutex } from "async-mutex";

/**
 * Finds the Slack channel ID for a given GitHub reviewer group.
 * @param reviewerGroups An array of GitHub team objects (e.g., from pull_request.requested_teams).
 * @returns The Slack channel ID or null if no mapping is found.
 */
export function getSlackChannelsForReviewerGroup(reviewerGroups: Team[]): string[] {
    return mapper.getSlackChannelsByGithubTeams(reviewerGroups.map(rg => rg.slug));
}

/**
 * Maps a GitHub username to a Slack User ID.
 * @param githubUsername The GitHub username.
 * @returns The Slack User ID or null if no mapping is found.
 */
export function getSlackUserId(githubUsername: string): string | null {
    return mapper.getSlackUsername(githubUsername);
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
 * Get some common useful information from the PR events.
 * @param data
 */
export const getPrMetaData = (data: PullRequestEvent | PullRequestReviewCommentEvent | PullRequestReviewEvent): {
    prNumber: number,
    repoId: number,
    repoFullName: string,
    prMsgKey: string
} => {
    return {
        prNumber: data.pull_request.number,
        repoId: data.repository.id,
        repoFullName: data.repository.full_name,
        prMsgKey: `${data.repository.id}:${data.pull_request.number}`,
    }
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

const locks = new Map<string, Mutex>();

function getMutex(key: string): Mutex {
    if (!locks.has(key)) {
        locks.set(key, new Mutex());
    }
    return locks.get(key)!;
}

export async function withPrLock<T>(prMsgKey: string, fn: () => Promise<T>): Promise<T> {
    const mutex = getMutex(prMsgKey);
    return mutex.runExclusive(fn);
}
