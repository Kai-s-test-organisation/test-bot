import {PullRequestEvent, PullRequestReviewCommentEvent, PullRequestReviewEvent} from "@octokit/webhooks-types";
import {
    getPrMetaData,
    getSlackChannelForReviewerGroup,
    isPrReadyToMerge,
    parsePrInfo,
    preparePrInfoForStorage, setPrMessageInfo
} from "./utils.js";
import {addSlackReaction, postPrNotification, removeSlackReaction} from "./slack.js";
import {APPROVED, CLOSED, COMMENTED, MERGED, NEEDS_REVIEW, PARTIAL_APPROVAL, READY_TO_MERGE} from "./config.js";
import {redis} from "./index.js";

export async function handlePrEvent(data: PullRequestEvent) {
    const action = data.action;
    const prPayload = data.pull_request; // Direct reference for brevity here

    const {prNumber, repoFullName, redisPrKey} = getPrMetaData(data);

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
                    redisPrKey,
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
            await removeSlackReaction(prInfo, APPROVED, redisPrKey);
            await removeSlackReaction(prInfo, READY_TO_MERGE, redisPrKey);
            await removeSlackReaction(prInfo, NEEDS_REVIEW, redisPrKey);

            await setPrMessageInfo(redisPrKey, prInfo);
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

            await addSlackReaction(prInfo, APPROVED, redisPrKey);
            await addSlackReaction(prInfo, MERGED, redisPrKey);
            await removeSlackReaction(prInfo, READY_TO_MERGE, redisPrKey);
            await removeSlackReaction(prInfo, NEEDS_REVIEW, redisPrKey);
            await removeSlackReaction(prInfo, COMMENTED, redisPrKey);

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

            await addSlackReaction(prInfo, CLOSED, redisPrKey);
            await removeSlackReaction(prInfo, APPROVED, redisPrKey);
            await removeSlackReaction(prInfo, READY_TO_MERGE, redisPrKey);
            await removeSlackReaction(prInfo, NEEDS_REVIEW, redisPrKey);
            await removeSlackReaction(prInfo, COMMENTED, redisPrKey);

            await redis.del(redisPrKey);
            console.log(`PR ${prPayload.html_url} closed (unmerged).`);
        } else {
            console.log(`Closed PR ${prPayload.html_url} not found in Redis map.`);
        }
    }
}

export async function handlePrReviewComment(data: PullRequestReviewCommentEvent) {
    const {redisPrKey} = getPrMetaData(data);
    // These are inline comments in code review. A general comment emoji might be sufficient.
    const existingDataRaw = await redis.get(redisPrKey);
    if (existingDataRaw) {
        const prInfo = parsePrInfo(existingDataRaw);
        await addSlackReaction(prInfo, COMMENTED, redisPrKey);
        console.log(`Code comment on PR ${data.pull_request.html_url}. Emoji added.`);
        // No change to approvals/changesRequested, so no need to save prInfo back
    } else {
        console.log(`Code comment for PR ${data.pull_request.html_url} not found in Redis map.`);
    }
}

export async function handlePrReviewEvent(data: PullRequestReviewEvent) {
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

        await addSlackReaction(prInfo, APPROVED, redisPrKey);
        await removeSlackReaction(prInfo, COMMENTED, redisPrKey);
        await removeSlackReaction(prInfo, NEEDS_REVIEW, redisPrKey);

        if (isPrReadyToMerge(prInfo.repoFullName, prInfo.approvals, prInfo.changesRequested)) {
            await removeSlackReaction(prInfo, PARTIAL_APPROVAL, redisPrKey);
            await addSlackReaction(prInfo, READY_TO_MERGE, redisPrKey);
        } else if (prInfo.approvals.size > 0 && !isPrReadyToMerge(prInfo.repoFullName, prInfo.approvals, prInfo.changesRequested)) {
            // If approved but not enough approvals yet, keep a pending reaction if desired
            await addSlackReaction(prInfo, PARTIAL_APPROVAL, redisPrKey);
        }

        console.log(`PR ${data.pull_request.html_url} approved by ${reviewerGithub}. Slack message updated.`);
    } else if (reviewState === "changes_requested") {
        prInfo.approvals.delete(reviewerGithub); // Remove from approvals if they previously approved
        prInfo.changesRequested.add(reviewerGithub);

        await addSlackReaction(prInfo, NEEDS_REVIEW, redisPrKey);
        await removeSlackReaction(prInfo, READY_TO_MERGE, redisPrKey);
        await removeSlackReaction(prInfo, APPROVED, redisPrKey);

        console.log(`PR ${data.pull_request.html_url} changes requested by ${reviewerGithub}. Slack message updated.`);
    }

    await setPrMessageInfo(redisPrKey, prInfo);
}
