import {Hono} from 'hono';
import {serve} from '@hono/node-server';
import {Webhooks} from '@octokit/webhooks';
import {
    WebhookEvent,
    WebhookEventName,
    PullRequestEvent,
    PullRequestReviewEvent,
    PullRequestReviewCommentEvent
} from "@octokit/webhooks-types";
import Redis from 'ioredis';
import {WebClient} from '@slack/web-api';
import {
    GITHUB_TO_SLACK_USER_MAP,
    GITHUB_WEBHOOK_SECRET,
    PORT,
    REDIS_URL, REVIEWER_GROUP_CHANNEL_MAP,
    SLACK_BOT_TOKEN,
    TWO_APPROVAL_REPOS
} from "./config.js";



// --- Hono App and Clients Initialization ---
const app = new Hono();
const redis = new Redis(REDIS_URL);
const webhooks = new Webhooks({secret: GITHUB_WEBHOOK_SECRET});
const slackClient = new WebClient(SLACK_BOT_TOKEN);

// --- Type Definition for Redis Stored Data (Minimum for Status Tracking) ---
interface PrSlackMessageInfo {
    channel: string;
    ts: string;
    repoFullName: string; // Still needed for TWO_APPROVAL_REPOS check
    approvals: Set<string>; // Track who has approved (GitHub usernames)
    changesRequested: Set<string>; // Track who requested changes
    botReactions: Set<string>; // New: Track reactions added by the bot
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


    let messageText = `*New Pull Request!* 🚀\n\n`;

    messageText += `<${prLink}|*#${prNumber}* - *${prTitle}*>\n\n`;
    messageText += `*Created by:* ${creatorMention}\n\n`;
    messageText += `_Repo:_ <https://github.com/${repoFullName}|${repoFullName}>\n`;
    messageText += `_Watch for reactions on this message to see its status._`;

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
                repoFullName: repoFullName,
                approvals: new Set(),
                changesRequested: new Set(),
                botReactions: new Set()
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
 * Adds an emoji reaction to a Slack message, updating Redis state.
 * Enhanced with better error handling and state synchronization.
 * @param prInfo The PR Slack message info object.
 * @param reactionEmoji The name of the emoji (e.g., 'white_check_mark').
 * @param redisKey The Redis key for the PR info.
 */
async function addSlackReaction(prInfo: PrSlackMessageInfo, reactionEmoji: string, redisKey: string) {
    if (prInfo.botReactions.has(reactionEmoji)) {
        return;
    }

    try {
        await slackClient.reactions.add({
            channel: prInfo.channel,
            timestamp: prInfo.ts,
            name: reactionEmoji,
        });

        // Success - update local state
        prInfo.botReactions.add(reactionEmoji);
        await redis.set(redisKey, JSON.stringify(preparePrInfoForStorage(prInfo)));
        console.log(`Added :${reactionEmoji}: reaction to message ${prInfo.ts} in channel ${prInfo.channel}`);

    } catch (error: any) {
        if (error.data && error.data.error === 'already_reacted') {
            // Slack says it's already there, sync Redis
            console.log(`Slack reported 'already_reacted' for :${reactionEmoji}: on message ${prInfo.ts}. Syncing Redis state.`);
            prInfo.botReactions.add(reactionEmoji);
            await redis.set(redisKey, JSON.stringify(preparePrInfoForStorage(prInfo)));
        } else {
            // Some other error occurred
            console.error(`Error adding reaction :${reactionEmoji}: to message ${prInfo.ts}:`, error.message);
            if (error.data) console.error("Slack API Error Data:", error.data);
        }
    }
}

/**
 * Removes an emoji reaction from a Slack message, updating Redis state.
 * Enhanced with better error handling and state synchronization.
 * @param prInfo The PR Slack message info object.
 * @param reactionEmoji The name of the emoji.
 * @param redisKey The Redis key for the PR info.
 */
async function removeSlackReaction(prInfo: PrSlackMessageInfo, reactionEmoji: string, redisKey: string) {
    if (!prInfo.botReactions.has(reactionEmoji)) {
        return;
    }

    try {
        await slackClient.reactions.remove({
            channel: prInfo.channel,
            timestamp: prInfo.ts,
            name: reactionEmoji,
        });

        // Success - update local state
        prInfo.botReactions.delete(reactionEmoji);
        await redis.set(redisKey, JSON.stringify(preparePrInfoForStorage(prInfo)));
        console.log(`Removed :${reactionEmoji}: reaction from message ${prInfo.ts} in channel ${prInfo.channel}`);

    } catch (error: any) {
        if (error.data && error.data.error === 'not_reacted') {
            // Slack says it's not there, sync Redis.
            console.log(`Slack reported 'not_reacted' for :${reactionEmoji}: on message ${prInfo.ts}. Syncing Redis state.`);
            prInfo.botReactions.delete(reactionEmoji);
            await redis.set(redisKey, JSON.stringify(preparePrInfoForStorage(prInfo)));
        } else {
            // Some other error occurred
            console.error(`Error removing reaction :${reactionEmoji}: from message ${prInfo.ts}:`, error.message);
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
        changesRequested: new Set(parsed.changesRequested || []),
        botReactions: new Set(parsed.botReactions || [])
    };
}

/**
 * Helper function to prepare PR info for Redis storage (convert Sets to Arrays)
 */
function preparePrInfoForStorage(prInfo: PrSlackMessageInfo): any {
    return {
        ...prInfo,
        approvals: Array.from(prInfo.approvals),
        changesRequested: Array.from(prInfo.changesRequested),
        botReactions: Array.from(prInfo.botReactions)
    };
}

const getPrMetaData = (data: PullRequestEvent | PullRequestReviewCommentEvent | PullRequestReviewEvent): {
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

async function handlePrEvent(data: PullRequestEvent) {
    const action = data.action;
    const prPayload = data.pull_request; // Direct reference for brevity here

    const {prNumber, repoId, repoFullName, redisPrKey} = getPrMetaData(data);

    // TODO: change this to just review requested in the future.
    if (action === "opened" || action === "review_requested") {
        const requestedReviewerTeams = prPayload.requested_teams || [];
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
            await removeSlackReaction(prInfo, "white_check_mark", redisPrKey);
            await removeSlackReaction(prInfo, "rocket", redisPrKey);
            await removeSlackReaction(prInfo, "warning", redisPrKey);

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

            await addSlackReaction(prInfo, "white_check_mark", redisPrKey); // Final green tick
            await addSlackReaction(prInfo, "merged", redisPrKey); // Custom merged emoji
            await removeSlackReaction(prInfo, "rocket", redisPrKey);
            await removeSlackReaction(prInfo, "warning", redisPrKey);
            await removeSlackReaction(prInfo, "speech_balloon", redisPrKey);

            await redis.del(redisPrKey);
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

            await addSlackReaction(prInfo, "x", redisPrKey);
            await removeSlackReaction(prInfo, "white_check_mark", redisPrKey);
            await removeSlackReaction(prInfo, "rocket", redisPrKey);
            await removeSlackReaction(prInfo, "warning", redisPrKey);
            await removeSlackReaction(prInfo, "speech_balloon", redisPrKey);

            await redis.del(redisPrKey);
            console.log(`PR ${prPayload.html_url} closed (unmerged).`);
        } else {
            console.log(`Closed PR ${prPayload.html_url} not found in Redis map.`);
        }
    }
}

async function handlePrReviewComment(data: PullRequestReviewCommentEvent) {
    const {redisPrKey} = getPrMetaData(data);
    // These are inline comments in code review. A general comment emoji might be sufficient.
    const existingDataRaw = await redis.get(redisPrKey);
    if (existingDataRaw) {
        const prInfo = parsePrInfo(existingDataRaw);
        await addSlackReaction(prInfo, "speech_balloon", redisPrKey);
        console.log(`Code comment on PR ${data.pull_request.html_url}. Emoji added.`);
        // No change to approvals/changesRequested, so no need to save prInfo back
    } else {
        console.log(`Code comment for PR ${data.pull_request.html_url} not found in Redis map.`);
    }
}

async function handlePrReviewEvent(data: PullRequestReviewEvent) {
    const reviewState = data.review.state; // 'approved', 'changes_requested', 'commented'
    const reviewerGithub = data.review.user.login;
    const {redisPrKey} = getPrMetaData(data);

    const existingDataRaw = await redis.get(redisPrKey);
    if (!existingDataRaw) {
        console.log(`Review for PR ${data.pull_request.html_url} not found in Redis map. Cannot update slack message.`);
        return
    }

    const prInfo = parsePrInfo(existingDataRaw);

    if (reviewState === "approved") {
        prInfo.changesRequested.delete(reviewerGithub); // Remove from changes requested if they previously requested changes
        prInfo.approvals.add(reviewerGithub);

        await addSlackReaction(prInfo, "white_check_mark", redisPrKey);
        await removeSlackReaction(prInfo, "speech_balloon", redisPrKey);
        await removeSlackReaction(prInfo, "warning", redisPrKey);

        if (isPrReadyToMerge(prInfo.repoFullName, prInfo.approvals, prInfo.changesRequested)) {
            await removeSlackReaction(prInfo, "one", redisPrKey);
            await addSlackReaction(prInfo, "rocket", redisPrKey);
        } else if (prInfo.approvals.size > 0 && !isPrReadyToMerge(prInfo.repoFullName, prInfo.approvals, prInfo.changesRequested)) {
            // If approved but not enough approvals yet, keep a pending reaction if desired
            await addSlackReaction(prInfo, "one", redisPrKey);
        }

        console.log(`PR ${data.pull_request.html_url} approved by ${reviewerGithub}. Slack message updated.`);
    } else if (reviewState === "changes_requested") {
        prInfo.approvals.delete(reviewerGithub); // Remove from approvals if they previously approved
        prInfo.changesRequested.add(reviewerGithub);

        await addSlackReaction(prInfo, "warning", redisPrKey);
        await removeSlackReaction(prInfo, "rocket", redisPrKey);
        await removeSlackReaction(prInfo, "white_check_mark", redisPrKey);

        console.log(`PR ${data.pull_request.html_url} changes requested by ${reviewerGithub}. Slack message updated.`);
    }

    await redis.set(redisPrKey, JSON.stringify(preparePrInfoForStorage(prInfo)));
}

// TODO: Replace emojis with constants in config file.

// --- Hono Route for GitHub Webhooks ---
app.post('/github-webhook', async (c) => {
    const signature = c.req.header('X-Hub-Signature-256');
    const eventType = c.req.header('X-GitHub-Event') as WebhookEventName;
    const payload = await c.req.text();

    if (!signature || !eventType || !payload) {
        console.warn("Received webhook with missing headers or payload.");
        return c.json({message: 'Missing headers or payload'}, 400);
    }

    try {
        // Verify the webhook signature
        const isValid = await webhooks.verify(payload, signature);
        if (!isValid) {
            console.error(`Webhook signature verification failed for event ${eventType}`);
            return c.json({message: 'Invalid signature'}, 401);
        }
        console.log(`Webhook received for event: ${eventType}`);
    } catch (error) {
        console.error(`Webhook signature verification failed for event ${eventType}:`, error);
        return c.json({message: 'Invalid signature'}, 401);
    }

    const parsed_data = JSON.parse(payload) as WebhookEvent;

    if (eventType === "pull_request") {
        await handlePrEvent(parsed_data as PullRequestEvent)
    } else if (eventType === "pull_request_review_comment") {
        await handlePrReviewComment(parsed_data as PullRequestReviewCommentEvent)
    } else if (eventType === "pull_request_review") {
        handlePrReviewEvent(parsed_data as PullRequestReviewEvent)
    } else {
        console.log(`Unhandled GitHub event type: ${eventType}`);
    }

    return c.json({message: 'Webhook received and processed'});
});

// --- Start Server ---
serve({
    fetch: app.fetch,
    port: PORT
}, (info) => {
    console.log(`Server is listening on http://localhost:${info.port}`);
});

// TODO: Change redis ttls for PR messages.
