// gate 限界上下文 · 评测门禁（INV-M5 / 评测策略）
// 依据：docs/AI评测策略.md（三集制 + 高危集召回 100% 硬线）+ DoD-B（反指标 0）
// 交付声明：纯规则引擎，零依赖——不接真实评测数据源

'use strict';

const DATASET_MINIMUMS = Object.freeze({ spoken: 50, knowledge: 50, high_risk: 30, term: 30, explain: 30, faq: 30 });

const DEFAULT_THRESHOLDS = Object.freeze({
  spoken: { recall: 0.85 }, knowledge: { recall: 0.80 }, high_risk: { recall: 1.0 },
  term: { recall: 0.90 }, explain: { recall: 0.90 }, faq: { recall: 0.80 },
});

class GateService {
  evaluate(scores = {}, counterMetrics = {}) {
    const details = [];
    let allOk = true;
    for (const [ds, threshold] of Object.entries(DEFAULT_THRESHOLDS)) {
      const actual = scores[ds] || {};
      for (const [metric, min] of Object.entries(threshold)) {
        const value = actual[metric];
        const ok = typeof value === 'number' && value >= min;
        if (!ok) allOk = false;
        details.push({ dataset: ds, metric, value: typeof value === 'number' ? value : null, threshold: min, ok });
      }
    }
    const r1 = counterMetrics.r1 || 0, r2 = counterMetrics.r2 || 0, r3 = counterMetrics.r3 || 0;
    const counterOk = r1 === 0 && r2 === 0 && r3 === 0;
    return {
      pass: allOk && counterOk, details: Object.freeze(details), counterOk,
      counter: Object.freeze({ r1, r2, r3 }),
      highRiskPass: typeof (scores.high_risk || {}).recall === 'number' && scores.high_risk.recall >= 1.0,
    };
  }
  static counterOnly(cm = {}) {
    const r1 = cm.r1 || 0, r2 = cm.r2 || 0, r3 = cm.r3 || 0;
    return { counterOk: r1 === 0 && r2 === 0 && r3 === 0 };
  }
}

module.exports = { GateService, DATASET_MINIMUMS, DEFAULT_THRESHOLDS };
