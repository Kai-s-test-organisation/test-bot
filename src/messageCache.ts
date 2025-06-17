import NodeCache from "node-cache";
import {THREE_DAYS_IN_SECONDS} from "./config.js";
import {PrSlackMessage} from "./types";

// Storage interface -> can't really store a set in js map.
interface PrSlackMessageStorage {
    slackMessages: {
        channel: string;
        ts: string;
    }[]
    repoFullName: string;
    approvals: string[];
    changesRequested: string[];
    botReactions: string[];
}

class PrSlackMessageCache {
    private cache = new NodeCache({ stdTTL: THREE_DAYS_IN_SECONDS });

    set(key: string, value: PrSlackMessage): boolean {
        const storageValue: PrSlackMessageStorage = {
            ...value,
            approvals: Array.from(value.approvals),
            changesRequested: Array.from(value.changesRequested),
            botReactions: Array.from(value.botReactions)
        };
        return this.cache.set(key, storageValue);
    }

    get(key: string): PrSlackMessage | undefined {
        const stored = this.cache.get(key) as PrSlackMessageStorage | undefined;
        if (!stored) return undefined;

        return {
            ...stored,
            approvals: new Set(stored.approvals),
            changesRequested: new Set(stored.changesRequested),
            botReactions: new Set(stored.botReactions)
        };
    }

    has(key: string): boolean {
        return this.cache.has(key);
    }

    delete(key: string): number {
        return this.cache.del(key);
    }
}

export const messageCache = new PrSlackMessageCache();