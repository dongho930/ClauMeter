// 개인화 예측 모델 평가 도구. "이 변경이 정말 더 나은가?"를 실제 사용 기록으로 판정한다.
//
//   node tools/eval-model.js            요약 (데이터 현황 + 모델 vs 단순 선형)
//   node tools/eval-model.js curve      경과율별 오차 - 데드존 임계값을 고칠 때
//   node tools/eval-model.js idle       유휴시간 -> 추가 지출 확률 - 활동도 곡선을 고칠 때
//   node tools/eval-model.js shift      패턴 급변 시 신뢰도 페널티 효과 (합성 시나리오)
//
// 평가 방식은 walk-forward다. k번째 구간을 예측할 때는 1~k-1 구간까지만 학습된 상태를 쓴다.
// 이미 본 데이터로 자기 자신을 맞히는 착시를 막기 위함이다.
//
// 주의: 주간 한도는 완료 구간이 1주에 하나씩만 생겨서 이 도구로 유의미하게 평가할 수 없다.
// 그래서 모든 평가는 5시간 한도 기준이다. 주간에 대한 판단은 표본이 쌓인 뒤에 다시 해야 한다.
//
// 이 파일은 앱에 포함되지 않는다 (package.json의 build.files는 명시적 허용 목록이다).

const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT = path.join(__dirname, '..');

// usageModel/costStore는 electron의 app.getPath로 저장 경로를 정한다. 평가가 실제 앱의 학습
// 상태를 건드리지 않도록 임시 폴더를 쓰게 한다 (원본 사용 기록은 읽기만 한다).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'claumeter-eval-'));
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: { app: { getPath: () => TMP } },
};

const costStore = require(path.join(PROJECT, 'costStore.js'));
const usageModel = require(path.join(PROJECT, 'usageModel.js'));

const FIVE_H = 5 * 3600;
const nowSec = Date.now() / 1000;

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pct = (v, w = 5) => (v == null ? '-'.padStart(w) : (v * 100).toFixed(1).padStart(w) + '%');

// 실제 5시간 한도와 같은 규칙(구간 밖 첫 이벤트에서 새 구간 시작)으로 완료된 구간들을 만든다.
function fiveHourWindows(events) {
  const wins = [];
  let cursor = 0;
  while (cursor < events.length) {
    const start = events[cursor].ts;
    const end = start + FIVE_H;
    if (end > nowSec) break; // 아직 진행 중일 수 있는 구간은 평가에서 제외
    let i = cursor;
    const ev = [];
    while (i < events.length && events[i].ts < end) ev.push(events[i++]);
    const total = ev.reduce((s, e) => s + e.cost, 0);
    if (total > 0) wins.push({ start, ev, total });
    cursor = i;
  }
  return wins;
}

// 구간 w의 경과율 t 시점에서의 (지금까지 쓴 금액, 유휴시간).
function observe(w, t) {
  const cut = w.start + t * FIVE_H;
  let spent = 0;
  let lastTs = null;
  for (const e of w.ev) {
    if (e.ts < cut) {
      spent += e.cost;
      lastTs = e.ts;
    }
  }
  return { spent, idleSec: lastTs == null ? null : cut - lastTs };
}

function loadEvents() {
  const events = costStore.getHistoricalEvents();
  if (events.length === 0) {
    console.log('사용 기록이 없다. ~/.claude/metrics/costs.jsonl 을 찾지 못했거나 비어 있다.');
    process.exit(1);
  }
  return events;
}

// ---------------------------------------------------------------------------

function cmdSummary(events, wins) {
  const day = (s) => new Date(s * 1000).toISOString().slice(0, 16).replace('T', ' ');
  const span = (events[events.length - 1].ts - events[0].ts) / 86400;
  console.log(`사용 기록  이벤트 ${events.length}개, ${day(events[0].ts)} ~ ${day(events[events.length - 1].ts)} (${span.toFixed(1)}일)`);
  console.log(`평가 대상  완료된 5시간 구간 ${wins.length}개\n`);

  const TS = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
  const model = { ae: [], under: [], over: [] };
  const naive = { ae: [], under: [], over: [] };

  usageModel.resetKind('fiveHour');
  for (const w of wins) {
    for (const t of TS) {
      const { spent, idleSec } = observe(w, t);
      if (spent <= 0) continue;
      const predModel = usageModel.predictFinalCost('fiveHour', t, spent, idleSec);
      record(naive, spent / t, w.total);
      if (predModel != null) record(model, predModel, w.total);
    }
    usageModel.backfillFromEvents('fiveHour', FIVE_H, w.ev, nowSec); // 실제 앱과 같은 학습 경로
  }

  console.log('  방식        중앙값오차  평균오차   과대예측      과소예측(위험)');
  report('단순 선형', naive);
  report('곡선 모델', model);

  const acc = usageModel.getAccuracyStats('fiveHour');
  if (acc) {
    console.log(`\n상세탭에 표시되는 정확도: 표본 ${acc.sampleCount}  모델 ±${acc.modelMeanAbsErrorPct}%  단순 ±${acc.naiveMeanAbsErrorPct}%`);
  }

  function record(bag, pred, actual) {
    const rel = (pred - actual) / actual;
    bag.ae.push(Math.abs(rel));
    (rel < 0 ? bag.under : bag.over).push(Math.abs(rel));
  }
  function report(label, bag) {
    const worst = bag.under.length ? `최악 ${(Math.max(...bag.under) * 100).toFixed(0)}%` : '없음';
    console.log(
      `  ${label}   ${pct(median(bag.ae), 7)}  ${pct(mean(bag.ae), 7)}   ${String(bag.over.length).padStart(3)}건 ${pct(mean(bag.over), 5)}   ${String(bag.under.length).padStart(3)}건 ${worst}`
    );
  }
}

function cmdCurve(events, wins) {
  console.log('경과율별 예측 오차 (walk-forward). 데드존 임계값은 오차가 꺾이는 지점에서 고른다.\n');
  console.log(`현재 임계값: 경과율 ${(0.25 * 100).toFixed(0)}% 미만은 예측을 내보내지 않음\n`);
  console.log('  경과율   모델 중앙값  모델 평균   단순 중앙값  단순 평균');

  const byT = new Map();
  usageModel.resetKind('fiveHour');
  for (const w of wins) {
    for (let i = 1; i <= 20; i++) {
      const t = Math.round(i * 0.02 * 100) / 100;
      const { spent, idleSec } = observe(w, t);
      if (spent <= 0) continue;
      if (!byT.has(t)) byT.set(t, { m: [], n: [] });
      const pm = usageModel.predictFinalCost('fiveHour', t, spent, idleSec);
      if (pm != null) byT.get(t).m.push(Math.abs(pm - w.total) / w.total);
      byT.get(t).n.push(Math.abs(spent / t - w.total) / w.total);
    }
    usageModel.backfillFromEvents('fiveHour', FIVE_H, w.ev, nowSec);
  }

  for (const [t, v] of [...byT.entries()].sort((a, b) => a[0] - b[0])) {
    const mark = usageModel.isProjectionReliable(t) ? ' ' : '·'; // · = 지금은 화면에 내보내지 않는 구간
    console.log(`  ${mark} ${t.toFixed(2)}   ${pct(median(v.m), 8)}   ${pct(mean(v.m), 8)}  ${pct(median(v.n), 8)}   ${pct(mean(v.n), 8)}`);
  }
}

function cmdIdle(events, wins) {
  console.log('유휴시간(마지막 사용 이후 경과) -> 그 이후 추가 지출이 발생한 비율.\n');
  console.log('활동도 곡선을 고칠 때 쓴다. 곡선은 이 확률보다 항상 보수적이어야(높아야) 한다.\n');

  const BINS = [[0, 10], [10, 20], [20, 30], [30, 45], [45, 60], [60, 120], [120, 300]];
  const stat = BINS.map(() => ({ n: 0, more: 0 }));
  for (const w of wins) {
    for (let t = 0.1; t <= 0.9; t += 0.05) {
      const { spent, idleSec } = observe(w, t);
      if (spent <= 0 || idleSec == null) continue;
      const idleMin = idleSec / 60;
      const bi = BINS.findIndex(([a, b]) => idleMin >= a && idleMin < b);
      if (bi < 0) continue;
      stat[bi].n += 1;
      if (w.total - spent > 1e-9) stat[bi].more += 1;
    }
  }
  console.log('  유휴시간        표본   추가 지출 발생');
  BINS.forEach(([a, b], i) => {
    const s = stat[i];
    if (!s.n) return;
    console.log(`  ${String(a).padStart(3)}~${String(b).padStart(3)}분   ${String(s.n).padStart(5)}   ${((s.more / s.n) * 100).toFixed(0).padStart(3)}%`);
  });
}

// 실 사용 기록에서는 신뢰도 페널티가 발동하지 않는다(모델이 계속 이기고 있어서).
// 그래서 패턴이 급변한 상황을 합성해서 효과를 확인한다.
function cmdShift() {
  console.log('패턴 급변 시 신뢰도 페널티 효과 (합성 시나리오).\n');
  console.log('실 사용 기록에서는 페널티가 발동하지 않으므로 - 모델이 계속 이기고 있다 - 이렇게만 확인할 수 있다.\n');

  const FRONT = [[0.02, 0.3], [0.08, 0.7], [0.15, 1.0]]; // 초반에 몰아 쓰고 끝
  const LINEAR = Array.from({ length: 10 }, (_, i) => [(i + 1) / 10, (i + 1) / 10]); // 단순 예측이 정답
  const BACK = [[0.45, 0.05], [0.6, 0.25], [0.8, 0.6], [0.95, 1.0]];

  const mkWindow = (start, total, shape) => {
    const ev = [];
    let prev = 0;
    for (const [t, cum] of shape) {
      const c = (cum - prev) * total;
      if (c > 0) ev.push({ ts: start + t * FIVE_H, cost: c });
      prev = cum;
    }
    return { start, ev, total };
  };

  for (const [label, phase2] of [['초반몰빵 -> 완전 선형 (단순 예측이 정답)', LINEAR], ['초반몰빵 -> 후반몰빵 (둘 다 틀리는 경우)', BACK]]) {
    const seq = [];
    let s = 1_700_000_000;
    for (let i = 0; i < 12; i++) seq.push(mkWindow(s + i * FIVE_H, 100 + i * 3, FRONT));
    s += 12 * FIVE_H;
    for (let i = 0; i < 12; i++) seq.push(mkWindow(s + i * FIVE_H, 100 + i * 3, phase2));

    usageModel.resetKind('fiveHour');
    const after = [];
    seq.forEach((w, wi) => {
      for (const t of [0.3, 0.4, 0.5, 0.6, 0.7, 0.8]) {
        const { spent, idleSec } = observe(w, t);
        if (spent <= 0) continue;
        const p = usageModel.predictFinalCost('fiveHour', t, spent, idleSec);
        if (p != null && wi >= 12) after.push(Math.abs(p - w.total) / w.total);
      }
      usageModel.backfillFromEvents('fiveHour', FIVE_H, w.ev, w.start + 100 * FIVE_H);
    });
    console.log(`  ${label}`);
    console.log(`    전환 후 중앙값오차 ${pct(median(after), 6)}   평균오차 ${pct(mean(after), 6)}\n`);
  }
  console.log('페널티를 끈 값과 비교하려면 usageModel.js의 LOSING_CONFIDENCE_FACTOR를 1로 두고 다시 실행한다.');
}

// ---------------------------------------------------------------------------

const cmd = process.argv[2] || 'summary';
if (cmd === 'shift') {
  cmdShift();
} else {
  const events = loadEvents();
  const wins = fiveHourWindows(events);
  if (wins.length === 0) {
    console.log('완료된 5시간 구간이 없어 평가할 수 없다.');
    process.exit(1);
  }
  const table = { summary: cmdSummary, curve: cmdCurve, idle: cmdIdle };
  const fn = table[cmd];
  if (!fn) {
    console.log(`알 수 없는 명령: ${cmd}\n사용법: node tools/eval-model.js [summary|curve|idle|shift]`);
    process.exit(1);
  }
  fn(events, wins);
}
