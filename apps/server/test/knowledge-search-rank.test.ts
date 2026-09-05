import { describe, expect, it } from "vitest";

import {
  rankLexical,
  relevanceTokens,
  tokenizeKnowledgeText,
  type LexicalDocument
} from "../src/knowledge-pipeline/search-rank.js";

const doc = (overrides: Partial<LexicalDocument>): LexicalDocument => ({
  display_title: "",
  summary: "",
  ...overrides
});

describe("knowledge query lexical ranking", () => {
  it("tokenizes CJK and ASCII identifiers, dropping stopwords and single characters", () => {
    const tokens = tokenizeKnowledgeText("上报服务地址的配置优先级是什么？engines>=14");
    expect(tokens).toContain("上报");
    expect(tokens).toContain("配置");
    expect(tokens).toContain("优先");
    expect(tokens.some((token) => token === "的" || token === "什么" || token === "是")).toBe(false);
    expect(tokens.every((token) => token.length >= 2)).toBe(true);
    expect(tokens).toContain("14"); // 版本号数字保留为词项
    expect(relevanceTokens("优先 优先 的")).toEqual(["优先"]); // 去重
  });

  it("ranks the matching document first for real natural-language questions", () => {
    const exitCodeDoc = doc({
      display_title: "上报失败不改变业务退出码",
      summary: "事件上报失败时业务命令退出码保持不变，不因遥测失败改变退出码",
      keywords: ["退出码", "上报"]
    });
    const priorityDoc = doc({
      display_title: "上报服务地址配置优先级",
      summary: "config 优先于 kb-state.api，其次 env，最后默认值",
      keywords: ["优先级", "配置"]
    });
    const tearDownDoc = doc({
      display_title: "共享测试库 tearDown 只删除自身行",
      summary: "tearDown 仅清理本测试插入的数据，不触碰其他表内容"
    });
    const docs = [exitCodeDoc, priorityDoc, tearDownDoc];

    expect(rankLexical(relevanceTokens("使用事件上报失败时是否应该改变业务命令的退出码？"), docs)[0]?.doc)
      .toBe(exitCodeDoc);
    expect(rankLexical(relevanceTokens("上报服务地址的配置优先级是什么"), docs)[0]?.doc)
      .toBe(priorityDoc);
  });

  it("returns nothing for unrelated questions instead of a nearest-neighbor guess", () => {
    const docs = [
      doc({ display_title: "上报失败不改变业务退出码", summary: "遥测失败不影响退出码" }),
      doc({ display_title: "共享测试库 tearDown 只删除自身行", summary: "仅清理自身数据" })
    ];
    expect(rankLexical(relevanceTokens("肯尼亚旅行签证需要什么材料"), docs)).toEqual([]);
  });

  it("matches ASCII code identifiers case-insensitively across body and keywords", () => {
    const doc = {
      display_title: "并发追加用量事件的风险",
      summary: "并发追加可能造成本地队列丢失",
      body: "appendPending 竞态导致部分事件未落盘",
      keywords: ["appendPending", "并发"]
    };
    expect(rankLexical(relevanceTokens("appendPending 并发 丢失"), [doc])).toHaveLength(1);
  });

  it("never drops a document that contains the full query string verbatim", () => {
    // 超集约束：整串子串能命中的行，词项路径必须同样能命中。
    const tearDownDoc = doc({
      display_title: "共享测试库 tearDown 行为",
      summary: "共享测试库 tearDown 只删除自身行，不清理其他数据"
    });
    expect(rankLexical(relevanceTokens("共享测试库 tearDown 只删除自身行"), [tearDownDoc])).toHaveLength(1);
  });

  it("requires at least two matched terms for multi-term queries", () => {
    const docs = [
      doc({ display_title: "归档说明", summary: "只有归档一个主题的单薄条目" }),
      doc({ display_title: "归档文件生成流程", summary: "归档与文件生成的步骤" })
    ];
    const ranked = rankLexical(relevanceTokens("归档 生成"), docs);
    // 只命中「归档」一条词项的条目被阈值滤掉，两个词项都命中的排在结果里。
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.doc.display_title).toContain("归档文件");
  });
});
