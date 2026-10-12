/**
 * 「今天」名言卡片的内置语录（纯本地，不发任何网络请求）。
 *
 * 只收录出处明确、流传稳定的句子；不含需要联网的每日一言服务——本项目
 * 「零遥测、唯一出站是用户配置的模型端点」，氛围文案也遵守这条。
 */

export interface Quote {
  readonly text: string;
  readonly author: string;
}

export const QUOTES: readonly Quote[] = [
  { text: "学而不思则罔，思而不学则殆。", author: "《论语》" },
  { text: "学然后知不足，教然后知困。", author: "《礼记·学记》" },
  { text: "不积跬步，无以至千里；不积小流，无以成江海。", author: "荀子《劝学》" },
  { text: "纸上得来终觉浅，绝知此事要躬行。", author: "陆游" },
  { text: "读书之法，在循序而渐进，熟读而精思。", author: "朱熹" },
  { text: "知是行之始，行是知之成。", author: "王阳明" },
  { text: "闻道有先后，术业有专攻。", author: "韩愈《师说》" },
  { text: "天行健，君子以自强不息。", author: "《周易》" },
  { text: "未经省察的人生不值得过。", author: "苏格拉底" },
  { text: "我唯一知道的，就是我一无所知。", author: "苏格拉底" },
  { text: "想象力比知识更重要。", author: "爱因斯坦" },
  { text: "如果说我看得更远，那是因为我站在巨人的肩膀上。", author: "牛顿" },
  { text: "我不能创造的东西，我就还没有真正理解。", author: "费曼" },
  { text: "我们只能看到前方很近的距离，但那里有许多值得做的事。", author: "图灵" },
  { text: "读史使人明智，读诗使人灵秀，数学使人周密，哲学使人深刻。", author: "培根《论学问》" },
];

/** 本地日期键（YYYY-MM-DD）：同一天内保持同一句，跨天自然更换。 */
export function localDayKey(date: Date = new Date()): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** 由日期键稳定映射到一个下标（纯函数，便于测试与同一天保持一致）。 */
export function quoteIndexForDay(dayKey: string, total: number = QUOTES.length): number {
  if (total <= 0) return 0;
  let hash = 0;
  for (let index = 0; index < dayKey.length; index += 1) {
    hash = (hash * 31 + dayKey.charCodeAt(index)) % 1_000_003;
  }
  return hash % total;
}

/** 手动「换一句」：顺序取下一条（到末尾回到开头）。 */
export function nextQuoteIndex(current: number, total: number = QUOTES.length): number {
  if (total <= 0) return 0;
  return (current + 1) % total;
}
