import {Context, Hono} from 'hono';
import {serve} from '@hono/node-server';
import {Webhooks} from '@octokit/webhooks';
import {
    WebhookEvent,
    WebhookEventName,
    PullRequestEvent,
    PullRequestReviewEvent,
    PullRequestReviewCommentEvent
} from "@octokit/webhooks-types";
import {WebClient} from '@slack/web-api';
import {
    GITHUB_WEBHOOK_SECRET,
    PORT,
    SLACK_BOT_TOKEN, SLACK_WEBHOOK_SECRET,
} from "./config.js";

import {handlePrEvent, handlePrReviewComment, handlePrReviewEvent} from "./webhookHandlers.js";
import {parseSlackBody, verifySlackSignature} from "./utils.js";

// Initialization
const app = new Hono<{
    Variables: {
        slackBody: string
    }
}>()

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
        await handlePrReviewEvent(parsed_data as PullRequestReviewEvent)
    } else {
        console.log(`Unhandled GitHub event type: ${eventType}`);
    }

    return c.json({message: 'Webhook received and processed'});
});

// Slash command handler for /addGithubUser
// Modified route handlers with proper TypeScript types
app.post('/slack/addGithubUser', verifySlackSignature(SLACK_WEBHOOK_SECRET), async (c: Context) => {
    try {
        // Get the raw body from middleware
        const rawBody = c.get('slackBody')

        // Parse the form data with type safety
        const slackData = parseSlackBody(rawBody)

        if (!slackData.text || !slackData.text.trim()) {
            return c.json({
                response_type: 'ephemeral',
                text: 'Please provide a GitHub username. Usage: /addGithubUser <github-username>'
            })
        }

        if (!slackData.user_id) {
            return c.json({
                response_type: 'ephemeral',
                text: 'Unable to identify user. Please try again.'
            })
        }

        const githubUsername = slackData.text.trim()
        const slackUserId = slackData.user_id

        // Your Redis logic here...
        console.log(`User ${slackUserId} wants to add GitHub user: ${githubUsername}`)

        return c.json({
            response_type: 'ephemeral',
            text: `✅ Successfully linked your Slack account to GitHub username: ${githubUsername}`
        })

    } catch (error) {
        console.error('Error handling /addGithubUser:', error)
        return c.json({
            response_type: 'ephemeral',
            text: '❌ Error processing your request. Please try again.'
        }, 500)
    }
})


app.post('/slack/addChannel', verifySlackSignature(SLACK_WEBHOOK_SECRET), async (c: Context) => {
    try {
        const rawBody = c.get('slackBody')
        const slackData = parseSlackBody(rawBody)

        if (!slackData.text || !slackData.text.trim()) {
            return c.json({
                response_type: 'ephemeral',
                text: 'Please provide a GitHub team name. Usage: /addChannel <github-team>'
            })
        }

        if (!slackData.channel_id) {
            return c.json({
                response_type: 'ephemeral',
                text: 'Unable to identify channel. Please try again.'
            })
        }

        const githubTeam = slackData.text.trim()
        const channelId = slackData.channel_id

        // Your Redis logic here...
        console.log(`Channel ${channelId} wants to add GitHub team: ${githubTeam}`)

        return c.json({
            response_type: 'ephemeral',
            text: `✅ Successfully linked this channel to GitHub team: ${githubTeam}`
        })

    } catch (error) {
        console.error('Error handling /addChannel:', error)
        return c.json({
            response_type: 'ephemeral',
            text: '❌ Error processing your request. Please try again.'
        }, 500)
    }
})


// --- Start Server ---
serve({
    fetch: app.fetch,
    port: PORT
}, (info) => {
    console.log(`Server is listening on http://localhost:${info.port}`);
});

// TODO: Change redis ttls for PR messages.
