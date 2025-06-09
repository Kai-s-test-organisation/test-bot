import { Hono } from 'hono';
import { Webhooks } from "@octokit/webhooks";
import {
    PullRequestOpenedEvent,
    PullRequestReopenedEvent,
    PullRequestReviewRequestedEvent,
    PullRequestClosedEvent,
    PullRequestReviewSubmittedEvent,
    IssueCommentCreatedEvent
} from "@octokit/webhooks-types";
import Redis from 'ioredis';
import { WebClient } from '@slack/web-api';
import dotenv from 'dotenv';

dotenv.config();

// Types for Redis storage and internal use
interface RedisStoredData {
    channel: string;
    ts: string;
}

// Union type for pull request events we handle
type PullRequestEvent =
    | PullRequestOpenedEvent
    | PullRequestReopenedEvent
    | PullRequestReviewRequestedEvent
    | PullRequestClosedEvent;


// Environment variables with proper typing
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET!;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN!;
const REDIS_URL = process.env.REDIS_URL!;
const REVIEWER_GROUP_CHANNEL_MAP_RAW = process.env.REVIEWER_GROUP_CHANNEL_MAP || '{}';

// Parse and type the reviewer group channel mapping
const REVIEWER_GROUP_CHANNEL_MAP: Record<string, string> = JSON.parse(REVIEWER_GROUP_CHANNEL_MAP_RAW);

// Initialize services
const app = new Hono();
const redis = new Redis(REDIS_URL);
const webhooks = new Webhooks({
    secret: GITHUB_WEBHOOK_SECRET,
});
const slackClient = new WebClient(SLACK_BOT_TOKEN);

// --- Helper Functions ---

/**
 * Get Slack channel ID from GitHub reviewer team slugs
 */
function getSlackChannelForReviewerGroup(reviewerTeams: PullRequestEvent['pull_request']['requested_teams']): string | null {
    return REVIEWER_GROUP_CHANNEL_MAP["runtime-terrors-be"];

    if (!reviewerTeams) return null;

    for (const team of reviewerTeams) {
        if (team.slug && REVIEWER_GROUP_CHANNEL_MAP[team.slug]) {
            return REVIEWER_GROUP_CHANNEL_MAP[team.slug];
        }
    }
    return null;
}

/**
 * GitHub username to Slack user ID mapping
 * IMPORTANT: Replace with your actual team mappings
 */
const GITHUB_TO_SLACK_USER_MAP: Record<string, string> = {
    "kaiack": "U09049XGK3R", // Replace with actual Slack User IDs
    "githubuser2": "U0987654321",
    // Add all your team members here
};

function getSlackUserId(githubUsername: string): string | null {
    return GITHUB_TO_SLACK_USER_MAP[githubUsername] || null;
}

/**
 * Post a PR notification to Slack
 */
async function postPrNotification(
    channelId: string,
    prLink: string,
    prTitle: string,
    prCreatorGithub: string,
    requestedReviewers: PullRequestEvent['pull_request']['requested_reviewers']
): Promise<string | null> {
    const creatorSlackId = getSlackUserId(prCreatorGithub);
    const creatorMention = creatorSlackId ? `<@${creatorSlackId}>` : `@${prCreatorGithub}`;

    const messageText = `🚀 New PR created by ${creatorMention}! <${prLink}|*${prTitle}*>\n`

    try {
        const response = await slackClient.chat.postMessage({
            channel: channelId,
            text: messageText,
            mrkdwn: true,
        });
        return response.ts as string;
    } catch (error) {
        console.error(`Error posting message to Slack:`, error);
        return null;
    }
}

/**
 * Add a reaction to a Slack message
 */
async function addSlackReaction(channelId: string, timestamp: string, reactionEmoji: string): Promise<void> {
    try {
        await slackClient.reactions.add({
            channel: channelId,
            timestamp: timestamp,
            name: reactionEmoji,
        });
    } catch (error: any) {
        // Ignore if reaction already exists
        if (error.data?.error === 'already_reacted') {
            console.log(`Reaction ${reactionEmoji} already exists on message ${timestamp}.`);
        } else {
            console.error(`Error adding reaction '${reactionEmoji}':`, error);
        }
    }
}

/**
 * Generate Redis key for PR storage
 */
function generatePrRedisKey(repositoryId: number, prNumber: number): string {
    return `pr:${repositoryId}:${prNumber}`;
}

// --- Hono Routes ---

app.post('/github-webhook', async (c) => {
    const signature = c.req.header('X-Hub-Signature-256');
    const eventType = c.req.header('X-GitHub-Event');
    const payload = await c.req.text();

    if (!signature || !eventType || !payload) {
        console.warn("Missing webhook headers or payload.");
        return c.json({ message: 'Missing headers or payload' }, 400);
    }

    try {
        // Verify GitHub webhook signature
        await webhooks.verifyAndReceive({
            id: c.req.header('X-GitHub-Delivery') || '',
            name: eventType as any,
            signature: signature,
            payload: payload,
        });
    } catch (error) {
        console.error(`Webhook signature verification failed:`, error);
        return c.json({ message: 'Invalid signature' }, 401);
    }

    const data = JSON.parse(payload);

    try {
        if (eventType === "pull_request") {
            await handlePullRequestEvent(data as PullRequestEvent);
        } else if (eventType === "pull_request_review") {
            await handlePullRequestReviewEvent(data as PullRequestReviewSubmittedEvent);
        } else if (eventType === "issue_comment") {
            await handleIssueCommentEvent(data as IssueCommentCreatedEvent);
        }
    } catch (error) {
        console.error(`Error processing webhook event:`, error);
        return c.json({ message: 'Error processing webhook' }, 500);
    }

    return c.json({ message: 'Webhook received and processed' });
});

/**
 * Handle pull request events (opened, reopened, review_requested, closed)
 */
async function handlePullRequestEvent(data: PullRequestEvent): Promise<void> {
    const { action, pull_request: pr, repository } = data;
    const prLink = pr.html_url;
    const prTitle = pr.title;
    const prCreatorGithub = pr.user.login;

    const redisPrKey = generatePrRedisKey(repository.id, pr.number);

    // Handle initial PR creation/review request
    if (action === "opened" || action === "reopened" || action === "review_requested") {
        const requestedReviewerTeams = pr.requested_teams || [];
        const channelId = getSlackChannelForReviewerGroup(requestedReviewerTeams);

        if (channelId) {
            const existingData = await redis.get(redisPrKey);
            let messageTs: string | null = null;

            if (existingData) {
                const parsedData: RedisStoredData = JSON.parse(existingData);
                messageTs = parsedData.ts;
                console.log(`PR ${prLink} already in Redis. Using existing Slack message TS: ${messageTs}`);
                // Optionally, you could update the message if reviewers change
            } else {
                console.log(`Posting new PR notification for ${prLink}...`);
                messageTs = await postPrNotification(
                    channelId,
                    prLink,
                    prTitle,
                    prCreatorGithub,
                    pr.requested_reviewers || []
                );
                if (messageTs) {
                    const redisData: RedisStoredData = { channel: channelId, ts: messageTs };
                    await redis.set(redisPrKey, JSON.stringify(redisData));
                    console.log(`Stored PR ${prLink} with TS ${messageTs} in Redis.`);
                }
            }
        } else {
            console.log(`No Slack channel found for requested reviewer teams: ${JSON.stringify(requestedReviewerTeams)} for PR ${prLink}`);
        }
    }
    // Handle PR merged
    else if (action === "closed" && pr.merged) {
        const existingData = await redis.get(redisPrKey);
        if (existingData) {
            const { channel, ts }: RedisStoredData = JSON.parse(existingData);
            await addSlackReaction(channel, ts, "white_check_mark");
            await addSlackReaction(channel, ts, "merged");
            await redis.del(redisPrKey);
            console.log(`PR ${prLink} merged. Reactions added and removed from Redis.`);
        } else {
            console.log(`Merged PR ${prLink} not found in Redis.`);
        }
    }
}

/**
 * Handle pull request review events
 */
async function handlePullRequestReviewEvent(data: PullRequestReviewSubmittedEvent): Promise<void> {
    console.log("handling request review event")
    const prLink = data.pull_request.html_url;
    const reviewState = data.review.state;
    const reviewerGithub = data.review.user.login;
    const reviewerSlackId = getSlackUserId(reviewerGithub);
    const reviewerMention = reviewerSlackId ? `<@${reviewerSlackId}>` : `@${reviewerGithub}`;

    const redisPrKey = generatePrRedisKey(data.repository.id, data.pull_request.number);
    const existingData = await redis.get(redisPrKey);

    if (existingData) {
        const { channel, ts }: RedisStoredData = JSON.parse(existingData);
        if (reviewState === "approved") {
            await addSlackReaction(channel, ts, "white_check_mark");
            console.log(`${reviewerMention} approved PR ${prLink}. Tick reaction added.`);
        } else if (reviewState === "commented" || reviewState === "changes_requested") {
            await addSlackReaction(channel, ts, "speech_balloon");
            console.log(`${reviewerMention} commented/requested changes on PR ${prLink}. Speech balloon reaction added.`);
        }
    } else {
        console.log(`Review for PR ${prLink} not found in Redis.`);
    }
}

/**
 * Handle issue comment events (comments on PRs)
 */

// TODO: not sure if this ever occurs!
async function handleIssueCommentEvent(data: IssueCommentCreatedEvent): Promise<void> {
    // Ensure it's a comment on a Pull Request
    console.log("handling Issue comment event")
    if (data.issue?.pull_request) {
        const prLink = data.issue.pull_request.html_url;
        const commenterGithub = data.comment.user.login;
        const commenterSlackId = getSlackUserId(commenterGithub);
        const commenterMention = commenterSlackId ? `<@${commenterSlackId}>` : `@${commenterGithub}`;

        const redisPrKey = generatePrRedisKey(data.repository.id, data.issue.number);
        const existingData = await redis.get(redisPrKey);

        if (existingData) {
            const { channel, ts }: RedisStoredData = JSON.parse(existingData);
            await addSlackReaction(channel, ts, "speech_balloon");
            console.log(`${commenterMention} commented on PR ${prLink}. Speech balloon reaction added.`);
        } else {
            console.log(`Comment for PR ${prLink} not found in Redis.`);
        }
    }
}

// Health check endpoint
app.get('/health', (c) => {
    return c.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// --- Start Server ---
const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

// Handle different runtime environments
async function startServer() {
    const { serve } = await import('@hono/node-server');
    serve({
        fetch: app.fetch,
        port
    }, (info: { port: any; }) => {
        console.log(`Listening on http://localhost:${info.port}`);
    });

}

// Start the server if not in production (for local development)
if (process.env.NODE_ENV !== 'production') {
    startServer().catch(console.error);
}

// Single default export for all environments
export default app;