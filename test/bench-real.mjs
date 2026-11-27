// 用本机真实会话做一次对照基准：冷读 / 命中 / 尾部增量
import { collect, stats, resetStats } from "../lib/collect.mjs";

function run(label, opts) {
  resetStats();
  const t = performance.now();
  const r = collect(6, opts || {});
  const ms = performance.now() - t;
  console.log(`${label.padEnd(16)} ${ms.toFixed(1)}ms  cards=${r.cards.length}  ${JSON.stringify(stats)}`);
  return r;
}

const cold = run("cold", { refresh: true });
run("hot");
run("hot2");
console.log("cards:", cold.cards.map((c) => `${c.status}/${c.title}`).join(" | "));
