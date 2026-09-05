/**
 * 知识查询的词项召回与排序（2026-09 审查报告·查询节）。
 *
 * 旧实现对整串查询做子串匹配、按 updated_at 排序，真实项目的自然语言
 * 问题 8/8 零命中。离线对照（Hunter-Harness .cache/knowledge-audit/
 * retrieval-experiment.mjs）显示：中文分词 + 简单词项排序在固定小样本上
 * 能把"目标来源进入前三"从 0/8 提到 3/8。这里是该算法的服务端版本：
 * Intl.Segmenter 分词、停用词过滤、BM25 风格打分（标题/关键词加权）。
 *
 * 语义约束：词项命中集合恒为旧子串匹配的超集——包含完整查询串的行
 * 必然包含全部词项，因此不会丢掉任何旧实现能找到的行，只改变排序与
 * 召回面。词项数上限与取回行数上限保证查询代价有界。
 */

const STOPWORDS = new Set(
  "的 了 在 是 和 与 或 时 应该 是否 什么 如何 为什么 怎样 怎么 吗 呢 会 有 没有 不 不能 需要 进行 使用 可以 用 个 这 其 对 从 后 前 以及 怎么办".split(" ")
);

const MAX_QUERY_TERMS = 24;

const segmenter = new Intl.Segmenter("zh", { granularity: "word" });

/** 查询与文档共用的分词：小写化、词项化、去停用词与单字符碎片。 */
export function tokenizeKnowledgeText(text: string): string[] {
  const tokens: string[] = [];
  for (const part of segmenter.segment(text.toLowerCase())) {
    if (!part.isWordLike) continue;
    const segment = part.segment;
    if (segment.length < 2 || STOPWORDS.has(segment)) continue;
    tokens.push(segment);
  }
  return tokens;
}

/** 查询词项：去重并封顶，保证生成的 SQL 预筛条件有界。 */
export function relevanceTokens(query: string): string[] {
  return [...new Set(tokenizeKnowledgeText(query))].slice(0, MAX_QUERY_TERMS);
}

/** 排序所需的文档字段（pg 行的子集；缺失字段按空处理）。 */
export interface LexicalDocument {
  display_title: string;
  summary: string;
  body?: string | null;
  keywords?: readonly string[] | null;
  reusability_scope?: string | null;
}

/** 词项权重：标题与关键词 2 倍，摘要/正文/适用范围 1 倍。 */
const FIELDS: ReadonlyArray<{ readonly weight: number; readonly pick: (doc: LexicalDocument) => string }> = [
  { weight: 2, pick: (doc) => doc.display_title ?? "" },
  { weight: 2, pick: (doc) => (doc.keywords ?? []).join(" ") },
  { weight: 1, pick: (doc) => doc.summary ?? "" },
  { weight: 1, pick: (doc) => doc.body ?? "" },
  { weight: 1, pick: (doc) => doc.reusability_scope ?? "" }
];

interface PreparedDocument<T> {
  doc: T;
  fields: ReadonlyArray<{ readonly weight: number; readonly tokens: string[] }>;
  length: number;
}

function prepareDocument<T extends LexicalDocument>(doc: T): PreparedDocument<T> {
  const fields = FIELDS.map((field) => ({ weight: field.weight, tokens: tokenizeKnowledgeText(field.pick(doc)) }));
  return { doc, fields, length: fields.reduce((sum, field) => sum + field.tokens.length, 0) };
}

export interface ScoredDocument<T> {
  doc: T;
  score: number;
  matchedTerms: number;
}

/**
 * BM25 风格打分。与离线实验的两点偏差（均为小库修正，非调参）：
 * - 关键词/摘要/适用范围进入打分字段（实验只有标题+正文）；
 * - 不做 score>=1 截断：阈值对极小语料（单条目项目）会把唯一命中滤掉，
 *   多词项噪声由 matchedTerms 下限抑制。
 */
export function rankLexical<T extends LexicalDocument>(
  terms: readonly string[],
  documents: readonly T[]
): Array<ScoredDocument<T>> {
  if (terms.length === 0 || documents.length === 0) return [];
  const prepared = documents.map(prepareDocument);
  const minMatches = Math.min(2, terms.length);
  const documentFrequency = new Map<string, number>();
  for (const term of terms) {
    let count = 0;
    for (const candidate of prepared) {
      if (candidate.fields.some((field) => field.tokens.includes(term))) count += 1;
    }
    documentFrequency.set(term, count);
  }
  const scored: Array<ScoredDocument<T>> = [];
  for (const entry of prepared) {
    let score = 0;
    let matchedTerms = 0;
    for (const term of terms) {
      let tf = 0;
      for (const field of entry.fields) {
        tf += field.weight * field.tokens.filter((token) => token === term).length;
      }
      if (tf === 0) continue;
      matchedTerms += 1;
      const df = documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (prepared.length - df + 0.5) / (df + 0.5));
      const normalization = tf + 1.2 * (0.25 + 0.75 * entry.length / 50);
      score += idf * (tf * 2.2) / normalization;
    }
    if (matchedTerms >= minMatches) scored.push({ doc: entry.doc, score, matchedTerms });
  }
  return scored;
}
