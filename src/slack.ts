import {getSlackUserId} from "./utils.js";
import {slackClient} from "./index.js";
import {PrSlackMessage} from "./types";
import {messageCache} from "./messageCache.js";

/**
 * Posts a new PR notification message to Slack and stores its essential info in local cache.
 * @param channelId The Slack channel ID.
 * @param prLink
 * @param prTitle
 * @param prCreatorGithub
 * @param prNumber
 * @param prMsgKey Key for storing data.
 * @param repoFullName The full repository name (owner/repo).
 * @returns The timestamp (ts) of the posted Slack message, or null on failure.
 */
export async function postPrNotification(
    channelIds: string[],
    prLink: string,
    prTitle: string,
    prCreatorGithub: string,
    prNumber: number,
    prMsgKey: string,
    repoFullName: string
): Promise<PrSlackMessage | null> {
    const messageText = buildMessageText(prLink, prTitle, prCreatorGithub, prNumber, repoFullName);

    const promises = channelIds.map(async (channelId) => {
        try {
            const response = await slackClient.chat.postMessage({
                channel: channelId,
                text: messageText,
                mrkdwn: true,
            });
            console.log(`Posted new PR notification to channel ${channelId}. Message TS: ${response.ts}`);

            return {
                success: true,
                channel: channelId,
                ts: response.ts as string
            };
        } catch (error: any) {
            console.error(`Error posting message to Slack channel ${channelId}:`, error.message);
            if (error.data) console.error("Slack API Error Data:", error.data);
            return {
                success: false,
                channel: channelId,
                ts: null,
                error
            };
        }
    });

    const results = await Promise.allSettled(promises);

    // Collect successful posts
    const successfulPosts = results
        .filter(result => result.status === 'fulfilled' && result.value.success)
        .map(result => ({
            channel: (result as PromiseFulfilledResult<any>).value.channel,
            ts: (result as PromiseFulfilledResult<any>).value.ts
        }));

    if (successfulPosts.length === 0) {
        console.error('Failed to post PR notification to any channels');
        return null;
    }

    // Create new prInfo based on successful posts
    const prInfo: PrSlackMessage = {
        slackMessages: successfulPosts,
        repoFullName: repoFullName,
        approvals: new Set(),
        changesRequested: new Set(),
        botReactions: new Set()
    };

    messageCache.set(prMsgKey, prInfo);
    console.log(`Stored essential PR info for ${prLink} with ${successfulPosts.length} messages in local cache.`);

    return prInfo;
}

// Helper function to build message text
function buildMessageText(
    prLink: string,
    prTitle: string,
    prCreatorGithub: string,
    prNumber: number,
    repoFullName: string
): string {
    const slackUserId = getSlackUserId(prCreatorGithub);
    const creatorMention = slackUserId
        ? `<@${slackUserId}>`
        : `*${prCreatorGithub}*`;

    let messageText = `*New Pull Request!* 🚀\n\n`;
    messageText += `<${prLink}|*#${prNumber}* - *${prTitle}*>\n\n`;
    messageText += `*Created by:* ${creatorMention}\n\n`;
    messageText += `_Repo:_ <https://github.com/${repoFullName}|${repoFullName}>\n`;
    messageText += `_Watch for reactions on this message to see its status._`;

    return messageText;
}

/**
 * Adds an emoji reaction to a Slack message and updates local state.
 * @param prInfo The PR Slack message info object.
 * @param reactionEmoji The name of the emoji
 * @param prMsgKey The cache key for the PR info.
 */
export async function addSlackReaction(prInfo: PrSlackMessage, reactionEmoji: string, prMsgKey: string) {
    if (prInfo.botReactions.has(reactionEmoji)) {
        return;
    }

    const promises = prInfo.slackMessages.map(async ({ channel, ts }) => {
        try {
            await slackClient.reactions.add({
                channel,
                timestamp: ts,
                name: reactionEmoji,
            });
            console.log(`Added :${reactionEmoji}: reaction to message ${ts} in channel ${channel}`);
            return { success: true, channel, ts };
        } catch (error: any) {
            if (error.data && error.data.error === 'already_reacted') {
                console.log(`Slack reported 'already_reacted' for :${reactionEmoji}: on message ${ts}. Syncing cache state.`);
                return { success: true, channel, ts };
            } else {
                console.error(`Error adding reaction :${reactionEmoji}: to message ${ts}:`, error.message);
                if (error.data) console.error("Slack API Error Data:", error.data);
                return { success: false, channel, ts, error };
            }
        }
    });

    const results = await Promise.allSettled(promises);

    // Update cache if all operations succeeded or were already present
    const allSucceeded = results.every(result =>
        result.status === 'fulfilled' && result.value.success
    );

    if (allSucceeded) {
        prInfo.botReactions.add(reactionEmoji);
        messageCache.set(prMsgKey, prInfo);
    }
}

/**
 * Removes an emoji reaction from a Slack message, updating local state.
 * Enhanced with better error handling and state synchronization.
 * @param prInfo The PR Slack message info object.
 * @param reactionEmoji The name of the emoji.
 * @param prMsgKey The cache key for the PR info.
 */
export async function removeSlackReaction(prInfo: PrSlackMessage, reactionEmoji: string, prMsgKey: string) {
    if (!prInfo.botReactions.has(reactionEmoji)) {
        return;
    }

    const promises = prInfo.slackMessages.map(async ({ channel, ts }) => {
        try {
            await slackClient.reactions.remove({
                channel,
                timestamp: ts,
                name: reactionEmoji,
            });
            console.log(`Removed :${reactionEmoji}: reaction from message ${ts} in channel ${channel}`);
            return { success: true, channel, ts };
        } catch (error: any) {
            if (error.data && error.data.error === 'not_reacted') {
                console.log(`Slack reported 'not_reacted' for :${reactionEmoji}: on message ${ts}. Syncing cache state.`);
                return { success: true, channel, ts };
            } else {
                console.error(`Error removing reaction :${reactionEmoji}: from message ${ts}:`, error.message);
                if (error.data) console.error("Slack API Error Data:", error.data);
                return { success: false, channel, ts, error };
            }
        }
    });

    const results = await Promise.allSettled(promises);

    // Update cache if all operations succeeded
    const allSucceeded = results.every(result =>
        result.status === 'fulfilled' && result.value.success
    );

    if (allSucceeded) {
        prInfo.botReactions.delete(reactionEmoji);
        messageCache.set(prMsgKey, prInfo);
    }
}