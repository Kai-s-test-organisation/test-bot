import {getSlackUserId, preparePrInfoForStorage, setPrMessageInfo} from "./utils.js";
import {slackClient, redis} from "./index.js";
import {PrSlackMessageInfo} from "./types";

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
export async function postPrNotification(
    channelId: string,
    prLink: string,
    prTitle: string,
    prCreatorGithub: string,
    prNumber: number,
    redisPrKey: string,
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

            await setPrMessageInfo(redisPrKey, prInfo);
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
export async function addSlackReaction(prInfo: PrSlackMessageInfo, reactionEmoji: string, redisKey: string) {
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
        await setPrMessageInfo(redisKey, prInfo);
        console.log(`Added :${reactionEmoji}: reaction to message ${prInfo.ts} in channel ${prInfo.channel}`);

    } catch (error: any) {
        if (error.data && error.data.error === 'already_reacted') {
            // Slack says it's already there, sync Redis
            console.log(`Slack reported 'already_reacted' for :${reactionEmoji}: on message ${prInfo.ts}. Syncing Redis state.`);
            prInfo.botReactions.add(reactionEmoji);
            await setPrMessageInfo(redisKey, prInfo);
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
export async function removeSlackReaction(prInfo: PrSlackMessageInfo, reactionEmoji: string, redisKey: string) {
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
        await setPrMessageInfo(redisKey, prInfo);
        console.log(`Removed :${reactionEmoji}: reaction from message ${prInfo.ts} in channel ${prInfo.channel}`);

    } catch (error: any) {
        if (error.data && error.data.error === 'not_reacted') {
            // Slack says it's not there, sync Redis.
            console.log(`Slack reported 'not_reacted' for :${reactionEmoji}: on message ${prInfo.ts}. Syncing Redis state.`);
            prInfo.botReactions.delete(reactionEmoji);
            await setPrMessageInfo(redisKey, prInfo);
        } else {
            // Some other error occurred
            console.error(`Error removing reaction :${reactionEmoji}: from message ${prInfo.ts}:`, error.message);
            if (error.data) console.error("Slack API Error Data:", error.data);
        }
    }
}