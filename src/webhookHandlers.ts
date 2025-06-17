import {PullRequestEvent, PullRequestReviewCommentEvent, PullRequestReviewEvent} from "@octokit/webhooks-types";
import {
    getPrMetaData,
    getSlackChannelsForReviewerGroup,
    isPrReadyToMerge,
} from "./utils.js";
import {addSlackReaction, postPrNotification, removeSlackReaction} from "./slack.js";
import {APPROVED, CLOSED, COMMENTED, MERGED, NEEDS_REVIEW, PARTIAL_APPROVAL, READY_TO_MERGE} from "./config.js";
import {messageCache} from "./messageCache.js";

export async function handlePrEvent(data: PullRequestEvent) {
    const action = data.action;
    const prPayload = data.pull_request;

    const {prNumber, repoFullName, prMsgKey} = getPrMetaData(data);

    // TODO: change this to just review requested in the future.
    if (action === "review_requested") {
        const requestedReviewerTeams = prPayload.requested_teams || [];
        const channelIds = getSlackChannelsForReviewerGroup(requestedReviewerTeams);

        if (channelIds.length > 0) {
            const prInfo = messageCache.get(prMsgKey);
            if (prInfo) {
                console.log(`PR ${prPayload.html_url} already tracked. Not posting a new message for action: ${action}.`);
            } else {
                await postPrNotification(
                    channelIds,
                    prPayload.html_url,
                    prPayload.title,
                    prPayload.user.login,
                    prNumber!,
                    prMsgKey,
                    repoFullName!
                );
            }
        } else {
            console.log(`No Slack channel found for requested reviewer teams: ${JSON.stringify(requestedReviewerTeams)} for PR ${prPayload.html_url}`);
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
            console.log(`PR ${prPayload.html_url} synchronized. Approvals/Reviews reset.`);
        } else {
            console.log(`Synchronized PR ${prPayload.html_url} not found in Redis map.`);
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
            console.log(`PR ${prPayload.html_url} merged. Status reflected with emojis.`);
        } else {
            console.log(`Merged PR ${prPayload.html_url} not found in Redis map.`);
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
            console.log(`PR ${prPayload.html_url} closed (unmerged).`);
        } else {
            console.log(`Closed PR ${prPayload.html_url} not found in Redis map.`);
        }
    }
}

export async function handlePrReviewComment(data: PullRequestReviewCommentEvent) {
    const {prMsgKey} = getPrMetaData(data);
    // These are inline comments in code review. A general comment emoji might be sufficient.
    const prInfo = messageCache.get(prMsgKey);
    if (prInfo) {
        await addSlackReaction(prInfo, COMMENTED, prMsgKey);
        console.log(`Code comment on PR ${data.pull_request.html_url}. Emoji added.`);
        // No change to approvals/changesRequested, so no need to save prInfo back
    } else {
        console.log(`Code comment for PR ${data.pull_request.html_url} not found in Redis map.`);
    }
}

export async function handlePrReviewEvent(data: PullRequestReviewEvent) {
    const reviewState = data.review.state; // 'approved', 'changes_requested', 'commented'
    const reviewerGithub = data.review.user.login;
    const {prMsgKey} = getPrMetaData(data);

    const prInfo = messageCache.get(prMsgKey);
    if (!prInfo) {
        console.log(`Review for PR ${data.pull_request.html_url} not found in Redis map. Cannot update slack message.`);
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

        console.log(`PR ${data.pull_request.html_url} approved by ${reviewerGithub}. Slack message updated.`);
    } else if (reviewState === "changes_requested") {
        prInfo.approvals.delete(reviewerGithub);
        prInfo.changesRequested.add(reviewerGithub);

        await addSlackReaction(prInfo, NEEDS_REVIEW, prMsgKey);
        await removeSlackReaction(prInfo, READY_TO_MERGE, prMsgKey);
        await removeSlackReaction(prInfo, APPROVED, prMsgKey);

        console.log(`PR ${data.pull_request.html_url} changes requested by ${reviewerGithub}. Slack message updated.`);
    }

    messageCache.set(prMsgKey, prInfo);
}
