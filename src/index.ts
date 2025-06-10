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
    // Add more repos that require 2 approvals
]);

// --- Hono App and Clients Initialization ---
const app = new Hono();
const redis = new Redis(REDIS_URL);
const webhooks = new Webhooks({ secret: GITHUB_WEBHOOK_SECRET });
const slackClient = new WebClient(SLACK_BOT_TOKEN);

// --- Type Definition for Redis Stored Data ---
interface PrSlackMessageInfo {
    channel: string;
    ts: string;
    prLink: string;
    prTitle: string;
    prCreatorGithub: string;
    repoFullName: string; // Store repo name for approval requirements
    // Store requested reviewers if needed for later reconstruction of initial message
    requestedReviewersGithub: { login: string }[];
    activities: string[]; // Array of strings like "Approved by <@user>"
    currentStatus: string; // "Open", "Approved", "Changes Requested", "Merged", "Ready to Merge"
    approvals: Set<string>; // Track who has approved (GitHub usernames)
    changesRequested: Set<string>; // Track who requested changes
}

// --- Helper Functions ---

/**
 * Finds the Slack channel ID for a given GitHub reviewer group.
 * @param reviewerGroups An array of GitHub team objects (e.g., from pull_request.requested_teams).
 * @returns The Slack channel ID or null if no mapping is found.
 */
function getSlackChannelForReviewerGroup(reviewerGroups: any[]): string | null {
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
function getSlackUserId(githubUsername: string): string | null {
    return GITHUB_TO_SLACK_USER_MAP[githubUsername] || null;
}

/**
 * Determines if a PR has enough approvals to be ready for merge
 * @param repoFullName The full repository name (owner/repo)
 * @param approvals Set of GitHub usernames who approved
 * @param changesRequested Set of GitHub usernames who requested changes
 * @returns true if PR is ready to merge
 */
function isPrReadyToMerge(repoFullName: string, approvals: Set<string>, changesRequested: Set<string>): boolean {
    // If anyone has requested changes, PR is not ready
    if (changesRequested.size > 0) {
        return false;
    }

    const requiredApprovals = TWO_APPROVAL_REPOS.has(repoFullName) ? 2 : 1;
    return approvals.size >= requiredApprovals;
}

/**
 * Gets the current PR status based on approvals and change requests
 * @param repoFullName The full repository name
 * @param approvals Set of approvers
 * @param changesRequested Set of users who requested changes
 * @returns Status string
 */
function getPrStatus(repoFullName: string, approvals: Set<string>, changesRequested: Set<string>): string {
    if (changesRequested.size > 0) {
        return "Changes Requested";
    }

    if (isPrReadyToMerge(repoFullName, approvals, changesRequested)) {
        return "Ready to Merge";
    }

    if (approvals.size > 0) {
        const requiredApprovals = TWO_APPROVAL_REPOS.has(repoFullName) ? 2 : 1;
        return `Approved (${approvals.size}/${requiredApprovals})`;
    }

    return "Open";
}

/**
 * Posts a new PR notification message to Slack and stores its info in Redis.
 * @param channelId The Slack channel ID.
 * @param prLink The URL of the PR.
 * @param prTitle The title of the PR.
 * @param prCreatorGithub The GitHub username of the PR creator.
 * @param requestedReviewersGithub An array of GitHub user objects (e.g., from pull_request.requested_reviewers).
 * @param prNumber The PR number.
 * @param repoId The repository ID.
 * @param repoFullName The full repository name (owner/repo).
 * @returns The timestamp (ts) of the posted Slack message, or null on failure.
 */
async function postPrNotification(
    channelId: string,
    prLink: string,
    prTitle: string,
    prCreatorGithub: string,
    requestedReviewersGithub: { login: string }[],
    prNumber: number,
    repoId: number,
    repoFullName: string
): Promise<string | null> {
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
    const approvalText = requiredApprovals > 1 ? ` (${requiredApprovals} approvals required)` : '';

    let messageText = `🚀 New PR created by ${creatorMention}: <${prLink}|*${prTitle}*>\n`;
    if (reviewerMentions) {
        messageText += `Reviewers: ${reviewerMentions}`;
    } else {
        messageText += `_No specific reviewers requested yet._`;
    }
    messageText += `\nStatus: *Open*${approvalText}`;

    try {
        const response = await slackClient.chat.postMessage({
            channel: channelId,
            text: messageText,
            mrkdwn: true,
        });
        console.log(`Posted new PR notification to channel ${channelId}. Message TS: ${response.ts}`);

        if (response.ts) {
            const prInfo: PrSlackMessageInfo = {
                channel: channelId,
                ts: response.ts,
                prLink: prLink,
                prTitle: prTitle,
                prCreatorGithub: prCreatorGithub,
                repoFullName: repoFullName,
                requestedReviewersGithub: requestedReviewersGithub,
                activities: [],
                currentStatus: "Open",
                approvals: new Set(),
                changesRequested: new Set()
            };

            // Convert Sets to Arrays for JSON storage
            const prInfoForStorage = {
                ...prInfo,
                approvals: Array.from(prInfo.approvals),
                changesRequested: Array.from(prInfo.changesRequested)
            };

            await redis.set(`pr:${repoId}:${prNumber}`, JSON.stringify(prInfoForStorage));
            console.log(`Stored PR ${prLink} with TS ${response.ts} and initial context in Redis.`);
        }
        return response.ts as string;
    } catch (error: any) {
        console.error(`Error posting message to Slack channel ${channelId}:`, error.message);
        if (error.data) console.error("Slack API Error Data:", error.data);
        return null;
    }
}

/**
 * Updates an existing PR notification message in Slack.
 * @param prInfo The object containing all stored PR and Slack message info from Redis.
 */
async function updatePrNotification(prInfo: PrSlackMessageInfo) {
    const creatorMention = getSlackUserId(prInfo.prCreatorGithub)
        ? `<@${getSlackUserId(prInfo.prCreatorGithub)}>`
        : `*${prInfo.prCreatorGithub}*`;

    const reviewerMentions = prInfo.requestedReviewersGithub
        .map(reviewer => getSlackUserId(reviewer.login)
            ? `<@${getSlackUserId(reviewer.login)}>`
            : `*${reviewer.login}*`
        )
        .join(', ');

    const requiredApprovals = TWO_APPROVAL_REPOS.has(prInfo.repoFullName) ? 2 : 1;
    const approvalText = requiredApprovals > 1 ? ` (${requiredApprovals} approvals required)` : '';

    let updatedMessageText = `🚀 PR by ${creatorMention}: <${prInfo.prLink}|*${prInfo.prTitle}*>\n`;
    if (reviewerMentions) {
        updatedMessageText += `Reviewers: ${reviewerMentions}\n`;
    } else {
        updatedMessageText += `_No specific reviewers requested yet._\n`;
    }

    if (prInfo.activities.length > 0) {
        updatedMessageText += `\n*Activity:*\n` + prInfo.activities.join('\n');
    } else {
        updatedMessageText += `\n_No recent activity._`;
    }

    updatedMessageText += `\nStatus: *${prInfo.currentStatus}*${approvalText}`;

    try {
        await slackClient.chat.update({
            channel: prInfo.channel,
            ts: prInfo.ts,
            text: updatedMessageText,
        });
        console.log(`Updated message ${prInfo.ts} in channel ${prInfo.channel} for PR ${prInfo.prLink}.`);
    } catch (error: any) {
        console.error(`Error updating message ${prInfo.ts} in channel ${prInfo.channel}:`, error.message);
        if (error.data) console.error("Slack API Error Data:", error.data);
    }
}

/**
 * Adds an emoji reaction to a Slack message.
 * @param channelId The Slack channel ID of the message.
 * @param timestamp The timestamp (ts) of the Slack message.
 * @param reactionEmoji The name of the emoji (e.g., 'white_check_mark', 'speech_balloon').
 */
async function addSlackReaction(channelId: string, timestamp: string, reactionEmoji: string) {
    try {
        await slackClient.reactions.add({
            channel: channelId,
            timestamp: timestamp,
            name: reactionEmoji,
        });
        console.log(`Added :${reactionEmoji}: reaction to message ${timestamp} in channel ${channelId}.`);
    } catch (error: any) {
        if (error.data && error.data.error === 'already_reacted') {
            console.log(`Reaction :${reactionEmoji}: already exists on message ${timestamp}.`);
        } else {
            console.error(`Error adding reaction :${reactionEmoji}: to message ${timestamp}:`, error.message);
            if (error.data) console.error("Slack API Error Data:", error.data);
        }
    }
}

/**
 * Removes an emoji reaction from a Slack message.
 * @param channelId The Slack channel ID of the message.
 * @param timestamp The timestamp (ts) of the Slack message.
 * @param reactionEmoji The name of the emoji.
 */
async function removeSlackReaction(channelId: string, timestamp: string, reactionEmoji: string) {
    try {
        await slackClient.reactions.remove({
            channel: channelId,
            timestamp: timestamp,
            name: reactionEmoji,
        });
        console.log(`Removed :${reactionEmoji}: reaction from message ${timestamp} in channel ${channelId}.`);
    } catch (error: any) {
        console.error(`Error removing reaction :${reactionEmoji}: from message ${timestamp}:`, error.message);
        if (error.data) console.error("Slack API Error Data:", error.data);
    }
}

/**
 * Helper function to parse stored PR info and convert arrays back to Sets
 */
function parsePrInfo(storedData: string): PrSlackMessageInfo {
    const parsed = JSON.parse(storedData);
    return {
        ...parsed,
        approvals: new Set(parsed.approvals || []),
        changesRequested: new Set(parsed.changesRequested || [])
    };
}

/**
 * Helper function to prepare PR info for Redis storage (convert Sets to Arrays)
 */
function preparePrInfoForStorage(prInfo: PrSlackMessageInfo): any {
    return {
        ...prInfo,
        approvals: Array.from(prInfo.approvals),
        changesRequested: Array.from(prInfo.changesRequested)
    };
}

// --- Hono Route for GitHub Webhooks ---
app.post('/github-webhook', async (c) => {
    const signature = c.req.header('X-Hub-Signature-256');
    const eventType = c.req.header('X-GitHub-Event');
    const payload = await c.req.text(); // Get raw body for signature verification

    if (!signature || !eventType || !payload) {
        console.warn("Received webhook with missing headers or payload.");
        return c.json({ message: 'Missing headers or payload' }, 400);
    }

    try {
        // Verify the webhook signature
        const isValid = await webhooks.verify(payload, signature);
        if (!isValid) {
            console.error(`Webhook signature verification failed for event ${eventType}`);
            return c.json({ message: 'Invalid signature' }, 401);
        }
        console.log(`Webhook received for event: ${eventType}`);
    } catch (error) {
        console.error(`Webhook signature verification failed for event ${eventType}:`, error);
        return c.json({ message: 'Invalid signature' }, 401);
    }

    const data = JSON.parse(payload);

    // Common PR identification from payload (works for pull_request, pull_request_review, issue_comment)
    const prNumber = data.pull_request ? data.pull_request.number : (data.issue?.pull_request ? data.issue.number : null);
    const repoId = data.repository ? data.repository.id : null;
    const repoFullName = data.repository ? data.repository.full_name : null;
    const redisPrKey = prNumber && repoId ? `pr:${repoId}:${prNumber}` : null;

    if (!redisPrKey) {
        console.warn(`Could not form a valid Redis key for incoming event: ${eventType}. Skipping.`);
        return c.json({ message: 'Invalid PR data for key generation' }, 400);
    }

    // --- Handle Pull Request Events ---
    if (eventType === "pull_request" && data.pull_request) {
        const action = data.action;
        const prPayload = data.pull_request;

        // Handle initial PR opened, reopened, or review requested
        if (action === "opened" || action === "reopened" || action === "review_requested") {
            const requestedReviewerTeams = prPayload.requested_teams || [];
            const requestedReviewersUsers = prPayload.requested_reviewers || [];
            const channelId = getSlackChannelForReviewerGroup(requestedReviewerTeams);

            if (channelId) {
                const existingDataRaw = await redis.get(redisPrKey);
                if (existingDataRaw) {
                    console.log(`PR ${prPayload.html_url} already tracked. Not posting a new message for action: ${action}.`);
                } else {
                    await postPrNotification(
                        channelId,
                        prPayload.html_url,
                        prPayload.title,
                        prPayload.user.login,
                        requestedReviewersUsers,
                        prNumber!,
                        repoId!,
                        repoFullName!
                    );
                }
            } else {
                console.log(`No Slack channel found for requested reviewer teams: ${JSON.stringify(requestedReviewerTeams)} for PR ${prPayload.html_url}`);
            }
        }
        // Handle PR synchronize (new commits pushed)
        else if (action === "synchronize") {
            const existingDataRaw = await redis.get(redisPrKey);
            if (existingDataRaw) {
                const prInfo = parsePrInfo(existingDataRaw);

                // Clear all approvals and change requests on synchronize
                prInfo.approvals.clear();
                prInfo.changesRequested.clear();
                prInfo.activities.push(`🔄 New commits pushed - approvals reset`);
                prInfo.currentStatus = "Open";

                // Remove approval reactions
                await removeSlackReaction(prInfo.channel, prInfo.ts, "white_check_mark");
                await removeSlackReaction(prInfo.channel, prInfo.ts, "merged");

                await updatePrNotification(prInfo);
                await redis.set(redisPrKey, JSON.stringify(preparePrInfoForStorage(prInfo)));
                console.log(`PR ${prInfo.prLink} synchronized. Approvals reset and message updated.`);
            } else {
                console.log(`Synchronized PR ${prPayload.html_url} not found in Redis map.`);
            }
        }
        // Handle PR merged
        else if (action === "closed" && prPayload.merged) {
            const existingDataRaw = await redis.get(redisPrKey);
            if (existingDataRaw) {
                const prInfo = parsePrInfo(existingDataRaw);

                // Add merged activity
                const mergerGithub = prPayload.merged_by ? prPayload.merged_by.login : 'unknown';
                const mergerMention = getSlackUserId(mergerGithub) ? `<@${getSlackUserId(mergerGithub)}>` : `*${mergerGithub}*`;
                prInfo.activities.push(`📦 Merged by ${mergerMention}`);
                prInfo.currentStatus = "Merged";

                await updatePrNotification(prInfo);
                await addSlackReaction(prInfo.channel, prInfo.ts, "white_check_mark");
                await addSlackReaction(prInfo.channel, prInfo.ts, "merged");

                await redis.del(redisPrKey);
                console.log(`PR ${prInfo.prLink} merged. Message updated and removed from Redis.`);
            } else {
                console.log(`Merged PR ${prPayload.html_url} not found in Redis map.`);
            }
        }
    }
    // --- Handle Pull Request Review Events (formal reviews) ---
    else if (eventType === "pull_request_review" && data.pull_request && data.review) {
        const reviewState = data.review.state; // 'approved', 'changes_requested', 'commented'
        const reviewerGithub = data.review.user.login;
        const reviewerMention = getSlackUserId(reviewerGithub) ? `<@${getSlackUserId(reviewerGithub)}>` : `*${reviewerGithub}*`;

        const existingDataRaw = await redis.get(redisPrKey);
        if (existingDataRaw) {
            const prInfo = parsePrInfo(existingDataRaw);

            if (reviewState === "approved") {
                // Remove from changes requested if they previously requested changes
                prInfo.changesRequested.delete(reviewerGithub);
                prInfo.approvals.add(reviewerGithub);

                prInfo.activities.push(`✅ Approved by ${reviewerMention}`);
                prInfo.currentStatus = getPrStatus(prInfo.repoFullName, prInfo.approvals, prInfo.changesRequested);

                await addSlackReaction(prInfo.channel, prInfo.ts, "white_check_mark");
                await removeSlackReaction(prInfo.channel, prInfo.ts, "speech_balloon");

                // Add special reaction if ready to merge
                if (isPrReadyToMerge(prInfo.repoFullName, prInfo.approvals, prInfo.changesRequested)) {
                    await addSlackReaction(prInfo.channel, prInfo.ts, "rocket");
                }

                console.log(`${reviewerMention} approved PR ${prInfo.prLink}. Status: ${prInfo.currentStatus}`);
            } else if (reviewState === "changes_requested") {
                // Remove from approvals if they previously approved
                prInfo.approvals.delete(reviewerGithub);
                prInfo.changesRequested.add(reviewerGithub);

                prInfo.activities.push(`⚠️ Changes requested by ${reviewerMention}`);
                prInfo.currentStatus = getPrStatus(prInfo.repoFullName, prInfo.approvals, prInfo.changesRequested);

                await addSlackReaction(prInfo.channel, prInfo.ts, "warning");
                await removeSlackReaction(prInfo.channel, prInfo.ts, "rocket"); // Remove ready-to-merge indicator

                console.log(`${reviewerMention} requested changes on PR ${prInfo.prLink}.`);
            } else if (reviewState === "commented") {
                prInfo.activities.push(`💬 Reviewed by ${reviewerMention}`);
                await addSlackReaction(prInfo.channel, prInfo.ts, "speech_balloon");
                console.log(`${reviewerMention} commented on PR ${prInfo.prLink}.`);
            }

            await redis.set(redisPrKey, JSON.stringify(preparePrInfoForStorage(prInfo)));
            await updatePrNotification(prInfo);
        } else {
            console.log(`Review for PR ${data.pull_request.html_url} not found in Redis map. Cannot update message.`);
        }
    }
    // --- Handle Pull Request Review Comment Events (code review comments) ---
    else if (eventType === "pull_request_review_comment" && data.pull_request && data.comment) {
        const commenterGithub = data.comment.user.login;
        const commenterMention = getSlackUserId(commenterGithub) ? `<@${getSlackUserId(commenterGithub)}>` : `*${commenterGithub}*`;

        const existingDataRaw = await redis.get(redisPrKey);
        if (existingDataRaw) {
            const prInfo = parsePrInfo(existingDataRaw);

            prInfo.activities.push(`💬 Code comment by ${commenterMention}`);
            await addSlackReaction(prInfo.channel, prInfo.ts, "speech_balloon");

            await redis.set(redisPrKey, JSON.stringify(preparePrInfoForStorage(prInfo)));
            await updatePrNotification(prInfo);
            console.log(`${commenterMention} commented on code in PR ${prInfo.prLink}.`);
        } else {
            console.log(`Code comment for PR ${data.pull_request.html_url} not found in Redis map.`);
        }
    }
    // --- Handle Issue Comment Events (for general comments on PRs) ---
    else if (eventType === "issue_comment" && data.issue && data.comment) {
        // Ensure it's a comment on a Pull Request
        if (data.issue.pull_request) {
            const commenterGithub = data.comment.user.login;
            const commenterMention = getSlackUserId(commenterGithub) ? `<@${getSlackUserId(commenterGithub)}>` : `*${commenterGithub}*`;

            const existingDataRaw = await redis.get(redisPrKey);
            if (existingDataRaw) {
                const prInfo = parsePrInfo(existingDataRaw);

                prInfo.activities.push(`💬 Commented by ${commenterMention}`);
                await addSlackReaction(prInfo.channel, prInfo.ts, "speech_balloon");

                await redis.set(redisPrKey, JSON.stringify(preparePrInfoForStorage(prInfo)));
                await updatePrNotification(prInfo);
                console.log(`${commenterMention} commented on PR ${prInfo.prLink}.`);
            } else {
                console.log(`Comment for PR ${data.issue.pull_request.html_url} not found in Redis map.`);
            }
        }
    } else {
        console.log(`Unhandled GitHub event type: ${eventType}`);
    }

    return c.json({ message: 'Webhook received and processed' });
});

// --- Start Server ---
serve({
    fetch: app.fetch,
    port: PORT
}, (info) => {
    console.log(`Server is listening on http://localhost:${info.port}`);
});