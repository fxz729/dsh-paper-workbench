// rerank.ts — 语义重排（Jev / TypeSafe System One,不依赖 Cordis)。
//
// 两段式检索的第二段:search.ts 的关键词打分是「快搜」——按词面捞回 shortlist;
// 这里对 shortlist 里每个候选问一个 Noul(「这段能回答学生的问题吗」),
// 按 noul 概率重排。快搜召回、Jev 定序,代码保留排序和截断。
// 参考 https://docs.typesafe.ai/cookbooks/rerank_typesafe.md
//
// 凭据按「设置面板文件 > profile YAML > 环境变量」解析（typesafe-config.ts）,
// 都配不出 apiKey 时 resolveRerankClient 返回 null,调用方退回纯关键词排序
// ——重排是可迭增强,不是硬依赖。
import { TypeSafeClient, noul } from '@typesafe-ai/sdk';
import { patientFetch, resolveTypesafeConfig } from "./typesafe-config.js";
/** 重排超预算（区别于网络/鉴权错误,方便上层区分日志）。 */
export class RerankDeadlineError extends Error {
    deadlineMs;
    constructor(deadlineMs) {
        super(`Jev 重排超过 ${deadlineMs}ms 预算,已放弃`);
        this.deadlineMs = deadlineMs;
        this.name = 'RerankDeadlineError';
    }
}
export function resolveShortlistSize(config) {
    const n = config?.shortlistSize ?? 15;
    return Math.max(1, Math.min(Math.trunc(n), 30));
}
/**
 * 有凭据则建客户端,否则返回 null(调用方走降级路径)。
 * 每次检索都调用:设置面板保存后无需重启即生效(读的是个小 JSON,开销可忽略)。
 */
export async function resolveRerankClient(config) {
    const { cfg } = await resolveTypesafeConfig(config);
    if (!cfg.apiKey?.trim())
        return null;
    return new TypeSafeClient({
        apiKey: cfg.apiKey,
        ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}),
        ...(cfg.model ? { defaultModel: cfg.model } : {}),
        timeout: config?.timeoutMs ?? 60_000,
        fetch: patientFetch,
        logLevel: 'off',
    });
}
/**
 * 用 Jev 对 shortlist 重排,返回 top-k(按原文顺序)。
 * 所有候选放进一份 state、一次请求并行问 N 个 Noul(同 state 的独立问题
 * 官方建议同批发问);任何失败(网络/鉴权/超时)抛给调用方降级。
 * deadlineMs > 0 时到点 abort 在飞请求并抛 RerankDeadlineError。
 */
export async function rerankHits(client, query, shortlist, k, deadlineMs = 1500) {
    // state 与问题:候选按 c1..cN 编号,问题里用反引号路径引用对应候选。
    const candidates = {};
    const questions = {};
    shortlist.forEach((h, i) => {
        const key = `c${i + 1}`;
        candidates[key] = h.chunk.text;
        questions[key] = noul(`Could the passage at \`candidates.${key}\` help answer the student's question at \`question\`?`, {
            true: 'The passage contains facts, reasoning, definitions, or data that directly help answer the question.',
            false: 'The passage is only topically related or shares keywords, without content that actually helps answer the question.',
        });
    });
    const ac = new AbortController();
    const timer = deadlineMs > 0 ? setTimeout(() => ac.abort(new RerankDeadlineError(deadlineMs)), deadlineMs) : null;
    let answers;
    try {
        ;
        ({ answers } = await client.systemOne({ state: { question: query, candidates }, questions }, deadlineMs > 0 ? { signal: ac.signal } : {}));
    }
    catch (e) {
        // abort 触发时 SDK 抛 APIUserAbortError,换成我们带预算信息的错误
        if (ac.signal.aborted)
            throw ac.signal.reason ?? e;
        throw e;
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
    return shortlist
        .map((h, i) => ({ hit: h, noul: answers[`c${i + 1}`].noul }))
        .sort((a, b) => b.noul - a.noul)
        .slice(0, k)
        // 重排后 score 改写为 noul(最终排序分),便于上层/调试脚本展示概率
        .map((e) => ({ ...e.hit, score: Math.round(e.noul * 1000) / 1000 }))
        .sort((a, b) => a.chunk.index - b.chunk.index); // 与 searchChunks 一致:按原文顺序返回
}
