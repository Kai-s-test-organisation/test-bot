import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { Webhooks } from '@octokit/webhooks';
import Redis from 'ioredis';
import { WebClient } from '@slack/web-api';
import dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

// --- Configuration from Environment Variables ---
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const REDIS_URL = process.env.REDIS_URL;
const REVIEWER_GROUP_CHANNEL_MAP_RAW = process.env.REVIEWER_GROUP_CHANNEL_MAP || '{}';
const GITHUB_TO_SLACK_USER_MAP_RAW = process.env.GITHUB_TO_SLACK_USER_MAP || '{}';
const PORT = parseInt(process.env.PORT || '3000', 10);

// Validate essential environment variables
if (!GITHUB_WEBHOOK_SECRET || !SLACK_BOT_TOKEN || !REDIS_URL) {
    console.error("ERROR: Missing essential environment variables. Check .env file.");
    process.exit(1);
}

// Parse JSON mappings
const REVIEWER_GROUP_CHANNEL_MAP: { [key: string]: string } = JSON.parse(REVIEWER_GROUP_CHANNEL_MAP_RAW);
const GITHUB_TO_SLACK_USER_MAP: { [key: string]: string } = JSON.parse(GITHUB_TO_SLACK_USER_MAP_RAW);

// --- Hard-coded configuration for repos requiring two approvals ---
const TWO_APPROVAL_REPOS = new Set([
    'your-org/critical-repo',  // Replace with actual repo names in format 'owner/repo'
    'your-org/production-app',
]);

// --- Hono App and Clients Initialization ---
const app = new Hono();
const redis = new Redis(REDIS_URL);
const webhooks = new Webhooks({ secret: GITHUB_WEBHOOK_SECRET });
const slackClient = new WebClient(SLACK_BOT_TOKEN);

// --- Simplified Type Definition for Redis Stored Data ---
// We only need to store what's necessary to find the message and manage state for emojis.
interface PrStateInfo {
    channel: string;
    ts: string;
    repoFullName: string;
    approvals: string[];      // Array of GitHub usernames who approved
    changesRequested: string[]; // Array of GitHub usernames who requested changes
}

// --- Helper Functions ---

/**
 * Finds the Slack channel ID for a given GitHub reviewer group.
 */
function getSlackChannelForReviewerGroup(reviewerGroups: any[]): string | null {
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
 */
function getSlackUserId(githubUsername: string): string | null {
    return GITHUB_TO_SLACK_USER_MAP[githubUsername] || null;
}

/**
 * Determines if a PR has enough approvals to be ready for merge.
 * This is used to decide if the 'ready to merge' emoji should be added.
 */
function isPrReadyToMerge(repoFullName: string, approvals: Set<string>, changesRequested: Set<string>): boolean {
    if (changesRequested.size > 0) {
        return false;
    }
    const requiredApprovals = TWO_APPROVAL_REPOS.has(repoFullName) ? 2 : 1;
    return approvals.size >= requiredApprovals;
}

/**
 * Posts the initial PR notification to Slack. This message will not be updated again.
 */
async function postInitialPrNotification(
    channelId: string,
    prLink: string,
    prTitle: string,
    prCreatorGithub: string,
    requestedReviewersGithub: { login: string }[],
    prNumber: number,
    repoId: number,
    repoFullName: string
): Promise<void> {
    const creatorMention = getSlackUserId(prCreatorGithub)
        ? `<@${getSlackUserId(prCreatorGithub)}>`
        : `*${prCreatorGithub}*`;

    const reviewerMentions = requestedReviewersGithub
        .map(reviewer => getSlackUserId(reviewer.login)
            ? `<@${getSlackUserId(reviewer.login)}>`
            : `*${reviewer.login}*`
        )
        .join(', ');

    const requiredApprovals = TWO_APPROVAL_REPOS.has(repoFullName) ? 2 : 1;
    const approvalText = requiredApprovals > 1 ? `*(${requiredApprovals} approvals required)*` : '';

    let messageText = `🚀 New PR from ${creatorMention}: <${prLink}|*${prTitle}*> ${approvalText}\n`;
    if (reviewerMentions) {
        messageText += `Reviewers: ${reviewerMentions}`;
    }

    try {
        const response = await slackClient.chat.postMessage({
            channel: channelId,
            text: messageText,
            mrkdwn: true,
        });
        console.log(`Posted new PR notification to channel ${channelId}. TS: ${response.ts}`);

        if (response.ts) {
            const prState: PrStateInfo = {
                channel: channelId,
                ts: response.ts,
                repoFullName: repoFullName,
                approvals: [],
                changesRequested: []
            };
            await redis.set(`pr:${repoId}:${prNumber}`, JSON.stringify(prState));
            console.log(`Stored PR state in Redis for ${prLink}.`);
        }
    } catch (error: any) {
        console.error(`Error posting message to Slack channel ${channelId}:`, error.message);
    }
}

/**
 * Adds an emoji reaction to a Slack message.
 */
async function addSlackReaction(channelId: string, timestamp: string, reactionEmoji: string) {
    try {
        await slackClient.reactions.add({
            channel: channelId,
            timestamp: timestamp,
            name: reactionEmoji,
        });
        console.log(`Added :${reactionEmoji}: to message ${timestamp}.`);
    } catch (error: any) {
        if (error.data?.error !== 'already_reacted') {
            console.error(`Error adding reaction :${reactionEmoji}:`, error.message);
        }
    }
}

/**
 * Removes an emoji reaction from a Slack message.
 */
async function removeSlackReaction(channelId: string, timestamp: string, reactionEmoji: string) {
    try {
        await slackClient.reactions.remove({
            channel: channelId,
            timestamp: timestamp,
            name: reactionEmoji,
        });
        console.log(`Removed :${reactionEmoji}: from message ${timestamp}.`);
    } catch (error: any) {
        if (error.data?.error !== 'no_reaction') {
            console.error(`Error removing reaction :${reactionEmoji}:`, error.message);
        }
    }
}

// --- Helper to get PR state from Redis and parse it into a usable format ---
async function getPrState(redisKey: string): Promise<{ state: PrStateInfo, approvals: Set<string>, changesRequested: Set<string> } | null> {
    const storedData = await redis.get(redisKey);
    if (!storedData) {
        return null;
    }
    const state: PrStateInfo = JSON.parse(storedData);
    return {
        state,
        approvals: new Set(state.approvals || []),
        changesRequested: new Set(state.changesRequested || [])
    };
}


// --- Hono Route for GitHub Webhooks ---
app.post('/github-webhook', async (c) => {
    const signature = c.req.header('X-Hub-Signature-256');
    const eventType = c.req.header('X-GitHub-Event');
    const payload = await c.req.text();

    if (!signature || !eventType) {
        return c.json({ message: 'Missing headers' }, 400);
    }

    // Verify the webhook signature
    if (!await webhooks.verify(payload, signature)) {
        console.error('Webhook signature verification failed.');
        return c.json({ message: 'Invalid signature' }, 401);
    }

    const data = JSON.parse(payload);
    const pr = data.pull_request || data.issue;
    const repo = data.repository;
    if (!pr || !repo) {
        return c.json({ message: 'Webhook processed (no PR/Repo)' });
    }
    const redisPrKey = `pr:${repo.id}:${pr.number}`;


    // --- Handle Pull Request Events ---
    if (eventType === "pull_request") {
        const action = data.action;

        // A. New PR: Post the initial message to Slack
        if (action === "opened" || action === "reopened" || action === "ready_for_review") {
            const channelId = getSlackChannelForReviewerGroup(pr.requested_teams || []);
            if (channelId) {
                await postInitialPrNotification(
                    channelId,
                    pr.html_url,
                    pr.title,
                    pr.user.login,
                    pr.requested_reviewers || [],
                    pr.number,
                    repo.id,
                    repo.full_name
                );
            }
        }

        // B. New Commits: Reset approval emojis
        else if (action === "synchronize") {
            const prStateData = await getPrState(redisPrKey);
            if (prStateData) {
                const { state, approvals, changesRequested } = prStateData;
                approvals.clear();
                changesRequested.clear();
                state.approvals = [];
                state.changesRequested = [];
                await redis.set(redisPrKey, JSON.stringify(state));

                await removeSlackReaction(state.channel, state.ts, "white_check_mark");
                await removeSlackReaction(state.channel, state.ts, "warning");
                await removeSlackReaction(state.channel, state.ts, "rocket");
                console.log(`PR ${pr.html_url} synchronized. Emojis reset.`);
            }
        }

        // C. PR Merged: Add merged emoji and clean up
        else if (action === "closed" && pr.merged) {
            const state = await redis.get(redisPrKey);
            if (state) {
                const { channel, ts } = JSON.parse(state) as PrStateInfo;
                await addSlackReaction(channel, ts, "merged");
                await removeSlackReaction(channel, ts, "rocket");
                await redis.del(redisPrKey); // Clean up
                console.log(`PR ${pr.html_url} merged. Marked and removed from Redis.`);
            }
        }
    }

    // --- Handle Review Events (Approvals / Changes Requested) ---
    else if (eventType === "pull_request_review") {
        const prStateData = await getPrState(redisPrKey);
        if (prStateData) {
            const { state, approvals, changesRequested } = prStateData;
            const reviewer = data.review.user.login;

            if (data.review.state === "approved") {
                approvals.add(reviewer);
                changesRequested.delete(reviewer); // An approval overrides a change request
                await addSlackReaction(state.channel, state.ts, "white_check_mark");
                await removeSlackReaction(state.channel, state.ts, "warning");
            } else if (data.review.state === "changes_requested") {
                changesRequested.add(reviewer);
                approvals.delete(reviewer); // A change request overrides an approval
                await addSlackReaction(state.channel, state.ts, "warning");
                await removeSlackReaction(state.channel, state.ts, "white_check_mark");
                await removeSlackReaction(state.channel, state.ts, "rocket"); // No longer ready
            }

            // Check if PR is now ready to merge
            if (isPrReadyToMerge(state.repoFullName, approvals, changesRequested)) {
                await addSlackReaction(state.channel, state.ts, "rocket");
            }

            // Save the updated state
            state.approvals = Array.from(approvals);
            state.changesRequested = Array.from(changesRequested);
            await redis.set(redisPrKey, JSON.stringify(state));
        }
    }

    // --- Handle Comment Events (just add a speech bubble) ---
    else if (eventType === "pull_request_review_comment") {
        if (data.action === "created") {
            const state = await redis.get(redisPrKey);
            if (state) {
                const { channel, ts } = JSON.parse(state) as PrStateInfo;
                await addSlackReaction(channel, ts, "speech_balloon");
            }
        }
    }

    return c.json({ message: 'Webhook processed' });
});

// --- Start Server ---
serve({
    fetch: app.fetch,
    port: PORT
}, (info) => {
    console.log(`✅ Server is listening on http://localhost:${info.port}`);
});