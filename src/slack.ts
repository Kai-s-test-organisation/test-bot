import { getSlackUserId } from "./utils.js";
import { slackClient } from "./index.js";
import { PrSlackMessage } from "./types";
import { messageCache } from "./messageCache.js";
import { logger } from "./config.js"; // ✅ Pino logger

/**
 * Posts a new PR notification message to Slack and stores its essential info in local cache.
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

            logger.info({ channel: channelId, ts: response.ts }, 'Posted new PR notification to Slack');

            return {
                success: true,
                channel: channelId,
                ts: response.ts as string
            };
        } catch (error: any) {
            logger.error({ channel: channelId, err: error }, 'Error posting message to Slack channel');
            if (error.data) logger.error({ data: error.data }, 'Slack API Error Data');
            return {
                success: false,
                channel: channelId,
                ts: null,
                error
            };
        }
    });

    const results = await Promise.allSettled(promises);

    const successfulPosts = results
        .filter(result => result.status === 'fulfilled' && result.value.success)
        .map(result => ({
            channel: (result as PromiseFulfilledResult<any>).value.channel,
            ts: (result as PromiseFulfilledResult<any>).value.ts
        }));

    if (successfulPosts.length === 0) {
        logger.error('Failed to post PR notification to any channels');
        return null;
    }

    const prInfo: PrSlackMessage = {
        slackMessages: successfulPosts,
        repoFullName,
        approvals: new Set(),
        changesRequested: new Set(),
        botReactions: new Set()
    };

    messageCache.set(prMsgKey, prInfo);
    logger.info({ prLink, channels: successfulPosts.length }, 'Stored PR info in local cache');

    return prInfo;
}

// Helper to format message text
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

            logger.info({ emoji: reactionEmoji, ts, channel }, 'Added reaction to Slack message');
            return { success: true, channel, ts };
        } catch (error: any) {
            if (error.data && error.data.error === 'already_reacted') {
                logger.info({ emoji: reactionEmoji, ts }, `'already_reacted' reported. Syncing cache state.`);
                return { success: true, channel, ts };
            } else {
                logger.error({ emoji: reactionEmoji, ts, err: error }, 'Error adding Slack reaction');
                if (error.data) logger.error({ data: error.data }, 'Slack API Error Data');
                return { success: false, channel, ts, error };
            }
        }
    });

    const results = await Promise.allSettled(promises);
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

            logger.info({ emoji: reactionEmoji, ts, channel }, 'Removed reaction from Slack message');
            return { success: true, channel, ts };
        } catch (error: any) {
            if (error.data && error.data.error === 'not_reacted') {
                logger.info({ emoji: reactionEmoji, ts }, `'not_reacted' reported. Syncing cache state.`);
                return { success: true, channel, ts };
            } else {
                logger.error({ emoji: reactionEmoji, ts, err: error }, 'Error removing Slack reaction');
                if (error.data) logger.error({ data: error.data }, 'Slack API Error Data');
                return { success: false, channel, ts, error };
            }
        }
    });

    const results = await Promise.allSettled(promises);
    const allSucceeded = results.every(result =>
        result.status === 'fulfilled' && result.value.success
    );

    if (allSucceeded) {
        prInfo.botReactions.delete(reactionEmoji);
        messageCache.set(prMsgKey, prInfo);
    }
}
