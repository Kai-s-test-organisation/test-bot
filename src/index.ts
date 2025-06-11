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
    GITHUB_WEBHOOK_SECRET,
    PORT,
    REDIS_URL,
    SLACK_BOT_TOKEN,
} from "./config.js";

import {handlePrEvent, handlePrReviewComment, handlePrReviewEvent} from "./webhookHandlers.js";

// Initialization
const app = new Hono();
export const redis = new Redis(REDIS_URL);
const webhooks = new Webhooks({secret: GITHUB_WEBHOOK_SECRET});
export const slackClient = new WebClient(SLACK_BOT_TOKEN);




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
