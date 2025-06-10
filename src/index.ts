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

// --- Type Definition for Redis Stored Data (Minimum for Status Tracking) ---
interface PrSlackMessageInfo {
    channel: string;
    ts: string;
    repoFullName: string; // Still needed for TWO_APPROVAL_REPOS check
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
 * Posts a new PR notification message to Slack and stores its essential info in Redis.
 * @param channelId The Slack channel ID.
 * @param prLink The URL of the PR.
 * @param prTitle The title of the PR.
 * @param prCreatorGithub The GitHub username of the PR creator.
 * @param requestedReviewersGithub An array of GitHub user objects.
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
    prNumber: number,
    repoId: number,
    repoFullName: string
): Promise<string | null> {

    const creatorMention = getSlackUserId(prCreatorGithub)
        ? `<@${getSlackUserId(prCreatorGithub)}>`
        : `*${prCreatorGithub}*`;





    // Start with a clear header
    let messageText = `*New Pull Request!* 🚀\n\n`;

    // Main PR details: Number, Title (hyperlinked)
    messageText += `<${prLink}|*#${prNumber}* - *${prTitle}*>\n`;

    messageText += `*Created by:* ${creatorMention}\n`;

    messageText += `_Repo:_ <https://github.com/${repoFullName}|${repoFullName}>\n\n`; // Add double line break for spacing

    messageText += `_Watch for reactions on this message to see its status._`;

    try {
        const response = await slackClient.chat.postMessage({
            channel: channelId,
            text: messageText,
            mrkdwn: true, // Ensure Markdown is rendered
        });
        console.log(`Posted new PR notification to channel ${channelId}. Message TS: ${response.ts}`);

        if (response.ts) {
            const prInfo: PrSlackMessageInfo = {
                channel: channelId,
                ts: response.ts,
                repoFullName: repoFullName,
                approvals: new Set(),
                changesRequested: new Set()
            };

            await redis.set(`pr:${repoId}:${prNumber}`, JSON.stringify(preparePrInfoForStorage(prInfo)));
            console.log(`Stored essential PR info for ${prLink} with TS ${response.ts} in Redis.`);
        }
        return response.ts as string;
    } catch (error: any) {
        console.error(`Error posting message to Slack channel ${channelId}:`, error.message);
        if (error.data) console.error("Slack API Error Data:", error.data);
        return null;
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
            // This is common and not an error we need to log as an error
            // console.log(`Reaction :${reactionEmoji}: already exists on message ${timestamp}.`);
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
        // 'not_reacted' is common if we try to remove a reaction that's not there
        if (error.data && error.data.error === 'not_reacted') {
            // console.log(`Reaction :${reactionEmoji}: does not exist on message ${timestamp} to remove.`);
        } else {
            console.error(`Error removing reaction :${reactionEmoji}: from message ${timestamp}:`, error.message);
            if (error.data) console.error("Slack API Error Data:", error.data);
        }
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

    // Common PR identification from payload
    let prDetailsFromEvent: any = null; // This will hold the 'pull_request' or 'issue' object that contains PR info
    if (data.pull_request) { // For 'pull_request' and 'pull_request_review' events
        prDetailsFromEvent = data.pull_request;
    } else if (data.issue?.pull_request) { // For 'issue_comment' on a PR
        prDetailsFromEvent = data.issue;
    }

    const prNumber = prDetailsFromEvent ? prDetailsFromEvent.number : null;
    const repoId = data.repository ? data.repository.id : null;
    const repoFullName = data.repository ? data.repository.full_name : null;
    const redisPrKey = prNumber && repoId ? `pr:${repoId}:${prNumber}` : null;

    if (!redisPrKey || !repoFullName || !prDetailsFromEvent) {
        console.warn(`Could not form a valid Redis key, get repo name, or missing prDetailsFromEvent for incoming event: ${eventType}. Skipping.`);
        return c.json({ message: 'Invalid PR data for key generation or update' }, 400);
    }

    // --- Handle Pull Request Events ---
    if (eventType === "pull_request" && data.pull_request) {
        const action = data.action;
        const prPayload = data.pull_request; // Direct reference for brevity here

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

                // Clear approvals and changes requested on new commits
                prInfo.approvals.clear();
                prInfo.changesRequested.clear();

                // Remove approval/ready-to-merge reactions
                await removeSlackReaction(prInfo.channel, prInfo.ts, "white_check_mark");
                await removeSlackReaction(prInfo.channel, prInfo.ts, "rocket");
                await removeSlackReaction(prInfo.channel, prInfo.ts, "warning"); // Remove warning if it was there

                await redis.set(redisPrKey, JSON.stringify(preparePrInfoForStorage(prInfo)));
                console.log(`PR ${prPayload.html_url} synchronized. Approvals/Reviews reset.`);
            } else {
                console.log(`Synchronized PR ${prPayload.html_url} not found in Redis map.`);
            }
        }
        // Handle PR closed and merged
        else if (action === "closed" && prPayload.merged) {
            const existingDataRaw = await redis.get(redisPrKey);
            if (existingDataRaw) {
                const prInfo = parsePrInfo(existingDataRaw);

                await addSlackReaction(prInfo.channel, prInfo.ts, "white_check_mark"); // Final green tick
                await addSlackReaction(prInfo.channel, prInfo.ts, "merged"); // Custom merged emoji
                await removeSlackReaction(prInfo.channel, prInfo.ts, "rocket");
                await removeSlackReaction(prInfo.channel, prInfo.ts, "warning"); // In case it was changes requested
                await removeSlackReaction(prInfo.channel, prInfo.ts, "speech_balloon"); // In case it had comments

                await redis.del(redisPrKey); // PR is merged, remove from Redis tracking
                console.log(`PR ${prPayload.html_url} merged. Status reflected with emojis.`);
            } else {
                console.log(`Merged PR ${prPayload.html_url} not found in Redis map.`);
            }
        }
        // Handle PR closed (unmerged)
        else if (action === "closed" && !prPayload.merged) {
            const existingDataRaw = await redis.get(redisPrKey);
            if (existingDataRaw) {
                const prInfo = parsePrInfo(existingDataRaw);

                await addSlackReaction(prInfo.channel, prInfo.ts, "x"); // Indicate closed without merge
                await removeSlackReaction(prInfo.channel, prInfo.ts, "white_check_mark");
                await removeSlackReaction(prInfo.channel, prInfo.ts, "rocket");
                await removeSlackReaction(prInfo.channel, prInfo.ts, "warning");
                await removeSlackReaction(prInfo.channel, prInfo.ts, "speech_balloon");

                await redis.del(redisPrKey); // PR is closed, remove from Redis tracking
                console.log(`PR ${prPayload.html_url} closed (unmerged). Status reflected with emojis.`);
            } else {
                console.log(`Closed (unmerged) PR ${prPayload.html_url} not found in Redis map.`);
            }
        }
    }
    // --- Handle Pull Request Review Events (formal reviews) ---
    else if (eventType === "pull_request_review" && data.pull_request && data.review) {
        const reviewState = data.review.state; // 'approved', 'changes_requested', 'commented'
        const reviewerGithub = data.review.user.login;

        const existingDataRaw = await redis.get(redisPrKey);
        if (existingDataRaw) {
            const prInfo = parsePrInfo(existingDataRaw);

            if (reviewState === "approved") {
                prInfo.changesRequested.delete(reviewerGithub); // Remove from changes requested if they previously requested changes
                prInfo.approvals.add(reviewerGithub);

                await addSlackReaction(prInfo.channel, prInfo.ts, "white_check_mark");
                await removeSlackReaction(prInfo.channel, prInfo.ts, "speech_balloon"); // Remove comment reaction if previously added
                await removeSlackReaction(prInfo.channel, prInfo.ts, "warning"); // Remove warning if previously changes requested

                if (isPrReadyToMerge(prInfo.repoFullName, prInfo.approvals, prInfo.changesRequested)) {
                    await addSlackReaction(prInfo.channel, prInfo.ts, "rocket");
                } else if (prInfo.approvals.size > 0 && !isPrReadyToMerge(prInfo.repoFullName, prInfo.approvals, prInfo.changesRequested)) {
                    // If approved but not enough approvals yet, keep a pending reaction if desired
                    // await addSlackReaction(prInfo.channel, prInfo.ts, "hourglass_flowing_sand");
                }

                console.log(`PR ${data.pull_request.html_url} approved by ${reviewerGithub}. Emojis updated.`);
            } else if (reviewState === "changes_requested") {
                prInfo.approvals.delete(reviewerGithub); // Remove from approvals if they previously approved
                prInfo.changesRequested.add(reviewerGithub);

                await addSlackReaction(prInfo.channel, prInfo.ts, "warning"); // Or a specific 'changes_requested' emoji
                await removeSlackReaction(prInfo.channel, prInfo.ts, "rocket"); // Remove ready-to-merge indicator
                await removeSlackReaction(prInfo.channel, prInfo.ts, "white_check_mark"); // Remove approval if now changes requested
                // await removeSlackReaction(prInfo.channel, prInfo.ts, "hourglass_flowing_sand");

                console.log(`PR ${data.pull_request.html_url} changes requested by ${reviewerGithub}. Emojis updated.`);
            } else if (reviewState === "commented") {
                // This refers to a general review comment, not a specific "commented" state
                // We can add a simple comment emoji if desired
                await addSlackReaction(prInfo.channel, prInfo.ts, "speech_balloon");
                console.log(`PR ${data.pull_request.html_url} commented on by ${reviewerGithub}. Emoji added.`);
            }

            await redis.set(redisPrKey, JSON.stringify(preparePrInfoForStorage(prInfo)));
        } else {
            console.log(`Review for PR ${data.pull_request.html_url} not found in Redis map. Cannot update emojis.`);
        }
    }
    // --- Handle Pull Request Review Comment Events (code review comments) ---
    else if (eventType === "pull_request_review_comment" && data.pull_request && data.comment) {
        // These are inline comments in code review. A general comment emoji might be sufficient.
        const existingDataRaw = await redis.get(redisPrKey);
        if (existingDataRaw) {
            const prInfo = parsePrInfo(existingDataRaw);
            await addSlackReaction(prInfo.channel, prInfo.ts, "speech_balloon");
            console.log(`Code comment on PR ${data.pull_request.html_url}. Emoji added.`);
            // No change to approvals/changesRequested, so no need to save prInfo back
        } else {
            console.log(`Code comment for PR ${data.pull_request.html_url} not found in Redis map.`);
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