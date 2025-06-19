import {PullRequestEvent, PullRequestReviewCommentEvent, PullRequestReviewEvent} from "@octokit/webhooks-types";
import {
    getPrMetaData,
    getSlackChannelsForReviewerGroup,
    isPrReadyToMerge,
} from "./utils.js";
import {addSlackReaction, postPrNotification, removeSlackReaction} from "./slack.js";
import {APPROVED, CLOSED, COMMENTED, MERGED, NEEDS_REVIEW, PARTIAL_APPROVAL, READY_TO_MERGE} from "./config.js";
import {messageCache} from "./messageCache.js";
import { logger } from './config.js';

export async function handlePrEvent(data: PullRequestEvent) {
    const action = data.action;
    const prPayload = data.pull_request;

    const {prNumber, repoFullName, prMsgKey} = getPrMetaData(data);

    // TODO: change this to just review requested in the future.
    if (action === "review_requested") {
        const prInfo = messageCache.get(prMsgKey);
        const requestedReviewerTeams = prPayload.requested_teams || [];
        const allChannelIds = getSlackChannelsForReviewerGroup(requestedReviewerTeams);


        if (allChannelIds.length > 0) {
            let channelsToNotify = allChannelIds;
            if (prInfo) {
                // need to do this in case we request a review from more than one team.
                // get the existing channels we have notified, remove those from all the channels we need to notify.
                const existingChannels = new Set(prInfo.slackMessages.map(m => m.channel));
                channelsToNotify = allChannelIds.filter(id => !existingChannels.has(id));
            }

            if (channelsToNotify.length > 0) {
                const newPrInfo = await postPrNotification(
                    channelsToNotify,
                    prPayload.html_url,
                    prPayload.title,
                    prPayload.user.login,
                    prNumber!,
                    prMsgKey,
                    repoFullName!
                );
                if (prInfo && newPrInfo) {
                    // If there was existing info, merge the new message info into the old one
                    prInfo.slackMessages.push(...newPrInfo.slackMessages);
                    messageCache.set(prMsgKey, prInfo);
                }
            } else {
                logger.debug({ prMsgKey }, "PR already tracked in all relevant channels.");
            }
        } else {
            logger.info({
                requestedTeams: requestedReviewerTeams.map(team => team.name),
                prUrl: prPayload.html_url
            }, "No Slack channels found for requested reviewer teams");
        }
    }

    // Handle PR synchronize (new commits pushed)
    else if (action === "synchronize") {
        const prInfo = messageCache.get(prMsgKey);
        if (prInfo) {

            // Clear approvals and changes requested on new commits
            prInfo.approvals.clear();
            prInfo.changesRequested.clear();


            // Remove approval/ready-to-merge reactions
            await removeSlackReaction(prInfo, APPROVED, prMsgKey);
            await removeSlackReaction(prInfo, READY_TO_MERGE, prMsgKey);
            await removeSlackReaction(prInfo, NEEDS_REVIEW, prMsgKey);

            // TODO: Maybe add emoji to signify that needs a recheck?
            // Usually in this case the person just @'s the original reviewer anyways...

            messageCache.set(prMsgKey, prInfo);
            logger.info({
                prUrl: prPayload.html_url,
                prMsgKey
            }, "PR synchronized - approvals and reviews reset");
        } else {
            logger.warn({
                prUrl: prPayload.html_url,
                prMsgKey
            }, "Synchronized PR not found in message cache");
        }
    }
    // Handle PR closed and merged
    else if (action === "closed" && prPayload.merged) {
        const prInfo = messageCache.get(prMsgKey);
        if (prInfo) {

            await addSlackReaction(prInfo, APPROVED, prMsgKey);
            await addSlackReaction(prInfo, MERGED, prMsgKey);
            await removeSlackReaction(prInfo, READY_TO_MERGE, prMsgKey);
            await removeSlackReaction(prInfo, NEEDS_REVIEW, prMsgKey);
            await removeSlackReaction(prInfo, COMMENTED, prMsgKey);

            messageCache.delete(prMsgKey);
            logger.info({
                prUrl: prPayload.html_url,
                prMsgKey
            }, "PR merged successfully - status reflected with emojis");
        } else {
            logger.warn({
                prUrl: prPayload.html_url,
                prMsgKey
            }, "Merged PR not found in message cache");
        }
    }
    // Handle PR closed (unmerged)
    else if (action === "closed" && !prPayload.merged) {
        const prInfo = messageCache.get(prMsgKey);
        if (prInfo) {

            await addSlackReaction(prInfo, CLOSED, prMsgKey);
            await removeSlackReaction(prInfo, APPROVED, prMsgKey);
            await removeSlackReaction(prInfo, READY_TO_MERGE, prMsgKey);
            await removeSlackReaction(prInfo, NEEDS_REVIEW, prMsgKey);
            await removeSlackReaction(prInfo, COMMENTED, prMsgKey);

            messageCache.delete(prMsgKey);
            logger.info({
                prUrl: prPayload.html_url,
                prMsgKey
            }, "PR closed without merging");
        } else {
            logger.warn({
                prUrl: prPayload.html_url,
                prMsgKey
            }, "Closed PR not found in message cache");
        }
    }
}

export async function handlePrReviewComment(data: PullRequestReviewCommentEvent) {
    const {prMsgKey} = getPrMetaData(data);
    // These are inline comments in code review. A general comment emoji might be sufficient.
    const prInfo = messageCache.get(prMsgKey);
    if (prInfo) {
        await addSlackReaction(prInfo, COMMENTED, prMsgKey);
        logger.debug({
            prUrl: data.pull_request.html_url,
            commenter: data.comment.user.login,
            prMsgKey
        }, "Code review comment added - emoji reaction applied");
        // No change to approvals/changesRequested, so no need to save prInfo back
    } else {
        logger.warn({
            prUrl: data.pull_request.html_url,
            commenter: data.comment.user.login,
            prMsgKey
        }, "Code review comment for PR not found in message cache");
    }
}

export async function handlePrReviewEvent(data: PullRequestReviewEvent) {
    const reviewState = data.review.state; // 'approved', 'changes_requested', 'commented'
    const reviewerGithub = data.review.user.login;
    const {prMsgKey} = getPrMetaData(data);

    const prInfo = messageCache.get(prMsgKey);
    if (!prInfo) {
        logger.warn({
            prUrl: data.pull_request.html_url,
            reviewer: reviewerGithub,
            reviewState,
            prMsgKey
        }, "PR review event received but PR not found in message cache");
        return
    }

    if (reviewState === "approved") {
        prInfo.changesRequested.delete(reviewerGithub);
        prInfo.approvals.add(reviewerGithub);

        await addSlackReaction(prInfo, APPROVED, prMsgKey);
        await removeSlackReaction(prInfo, COMMENTED, prMsgKey);
        await removeSlackReaction(prInfo, NEEDS_REVIEW, prMsgKey);

        const isReadyToMerge = isPrReadyToMerge(prInfo.repoFullName, prInfo.approvals, prInfo.changesRequested);
        if (isReadyToMerge) {
            await removeSlackReaction(prInfo, PARTIAL_APPROVAL, prMsgKey);
            await addSlackReaction(prInfo, READY_TO_MERGE, prMsgKey);
        } else if (prInfo.approvals.size > 0) {
            // approved but needs another
            await addSlackReaction(prInfo, PARTIAL_APPROVAL, prMsgKey);
        }

        logger.info({
            prUrl: data.pull_request.html_url,
            reviewer: reviewerGithub,
            approvalCount: prInfo.approvals.size,
            isReadyToMerge,
            prMsgKey
        }, "PR approved by reviewer - Slack message updated");
    } else if (reviewState === "changes_requested") {
        prInfo.approvals.delete(reviewerGithub);
        prInfo.changesRequested.add(reviewerGithub);

        await addSlackReaction(prInfo, NEEDS_REVIEW, prMsgKey);
        await removeSlackReaction(prInfo, READY_TO_MERGE, prMsgKey);
        await removeSlackReaction(prInfo, APPROVED, prMsgKey);

        logger.info({
            prUrl: data.pull_request.html_url,
            reviewer: reviewerGithub,
            changesRequestedCount: prInfo.changesRequested.size,
            prMsgKey
        }, "Changes requested by reviewer - Slack message updated");
    }

    messageCache.set(prMsgKey, prInfo);
}