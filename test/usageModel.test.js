// 개인화 예측 모델(usageModel.js) 회귀 테스트.
//
//   실행: npm test
//
// 의존성 없이 node + assert만 쓴다. usageModel은 electron의 app.getPath로 저장 경로를 정하므로,
// require 캐시에 가짜 electron을 심어 임시 폴더를 쓰게 한 뒤 실제 모듈을 그대로 불러온다.
//
// "모델이 더 정확한가"를 재는 건 이 파일이 아니라 tools/eval-model.js의 몫이다. 여기서는
// 동작이 규약대로인지만 본다(구간을 어디서 자르는지, 언제 예측을 포기하는지 등).

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const PROJECT = path.join(__dirname, '..');
const MODEL_SRC = path.join(PROJECT, 'usageModel.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'claumeter-test-'));

const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: { app: { getPath: () => TMP } },
};

const MODEL_PATH = path.join(TMP, 'usage_model.json');

// 저장된 학습 상태를 지우고 모듈을 새로 불러온다 (모듈이 상태를 메모리에 캐시하므로 재로드가 필요).
function freshModel() {
  delete require.cache[require.resolve(MODEL_SRC)];
  try {
    fs.unlinkSync(MODEL_PATH);
  } catch {
    // 첫 실행이라 파일이 없을 뿐
  }
  return require(MODEL_SRC);
}

const readState = () => JSON.parse(fs.readFileSync(MODEL_PATH, 'utf-8'));

const WEEK = 7 * 86400;
const FIVE_H = 5 * 3600;
const NOW = 1_800_000_000; // 고정 기준 시각 (초) - 테스트가 실제 시계에 의존하지 않도록

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---------------------------------------------------------------------------

test('주간 백필은 초기화 시각 격자에 맞춰 구간을 자른다', () => {
  const m = freshModel();
  const anchor = NOW + 100_000; // 다음 주간 초기화 시각 (미래)
  const events = [];
  for (let k = 1; k <= 3; k++) {
    const start = anchor - (k + 1) * WEEK; // 완료된 과거 3개 칸
    events.push({ ts: start + WEEK * 0.25, cost: 30 });
    events.push({ ts: start + WEEK * 0.75, cost: 70 });
  }

  assert.strictEqual(m.backfillFromEvents('weekly', WEEK, events, NOW, anchor), 3);

  const w = readState().weekly;
  assert.strictEqual(w.completedWindows, 3);
  assert.strictEqual(w.buckets[25].count, 3);
  assert.ok(Math.abs(w.buckets[25].mean - 0.3) < 1e-9, `25% 지점 누적비율 ${w.buckets[25].mean}`);
  assert.ok(Math.abs(w.buckets[50].mean - 0.3) < 1e-9, '50% 지점은 아직 30%만 쓴 상태');
  assert.ok(Math.abs(w.buckets[75].mean - 1.0) < 1e-9, '75% 지점에서 전액 소진');
  assert.ok(Math.abs(w.buckets[100].mean - 1.0) < 1e-9, '구간 끝은 항상 100%');
  assert.strictEqual(w.buckets[100].count, 3, '실시간 폴링과 같게 모든 버킷에 샘플이 남는다');
});

test('격자 없이 자르면 같은 데이터가 엉뚱한 경과율에 학습된다 (구버전 버그)', () => {
  const m = freshModel();
  const anchor = NOW + 100_000;
  const events = [];
  for (let k = 1; k <= 3; k++) {
    const start = anchor - (k + 1) * WEEK;
    events.push({ ts: start + WEEK * 0.25, cost: 30 });
    events.push({ ts: start + WEEK * 0.75, cost: 70 });
  }

  m.backfillFromEvents('weekly', WEEK, events, NOW); // anchor 없이 = 첫 이벤트를 구간 시작으로

  // 정답은 50% 지점에서 30%만 쓴 상태다. 구버전은 구간 전체를 25% 앞으로 당겨버려서
  // 같은 지점을 "이미 다 썼다"로 배운다.
  const w = readState().weekly;
  assert.ok(
    Math.abs(w.buckets[50].mean - 1.0) < 1e-9,
    `구버전은 50% 지점을 100%로 배운다 (정답 30%, 실제 ${(w.buckets[50].mean * 100).toFixed(0)}%)`
  );
});

test('5시간 백필은 구간 밖 첫 이벤트에서 새 구간을 시작하고, 진행 중인 구간은 제외한다', () => {
  const m = freshModel();
  const events = [
    { ts: NOW - 3 * FIVE_H, cost: 10 }, // 구간 A 시작
    { ts: NOW - 3 * FIVE_H + FIVE_H * 0.5, cost: 10 },
    { ts: NOW - 0.5 * FIVE_H, cost: 5 }, // 구간 A 밖 -> 구간 B 시작 (아직 진행 중)
  ];

  assert.strictEqual(m.backfillFromEvents('fiveHour', FIVE_H, events, NOW), 1);

  const f = readState().fiveHour;
  assert.ok(Math.abs(f.buckets[0].mean - 0.5) < 1e-9, '시작 시점에 절반을 썼다');
  assert.ok(Math.abs(f.buckets[50].mean - 1.0) < 1e-9, '50% 지점에 전액 소진');
});

test('백필이 진행 중인 구간의 실시간 샘플 버퍼를 망가뜨리지 않는다', () => {
  const m = freshModel();
  m.recordSample('weekly', 0.4, 40); // 실시간으로 모으던 샘플
  m.recordSample('weekly', 0.6, 60);

  const anchor = NOW + 100_000;
  m.backfillFromEvents('weekly', WEEK, [{ ts: anchor - 2 * WEEK + WEEK * 0.5, cost: 100 }], NOW, anchor);

  const before = readState().weekly;
  assert.ok(Math.abs(before.buckets[40].mean - 0) < 1e-9, '백필된 구간은 40% 시점에 지출이 없었다');

  m.closeWindow('weekly', 100); // 실시간 구간이 끝난 것처럼

  const after = readState().weekly;
  assert.strictEqual(after.completedWindows, before.completedWindows + 1);
  assert.strictEqual(after.buckets[40].count, 2, '백필분 + 실시간분');
  assert.ok(
    Math.abs(after.buckets[40].mean - 0.2) < 1e-9,
    `백필 전에 모아둔 샘플(0.4)이 EMA로 반영되어야 한다 (기대 0.2, 실제 ${after.buckets[40].mean})`
  );
});

test('모델 버전이 다른 저장 파일은 폐기하고 처음부터 다시 배운다', () => {
  freshModel();
  const stale = {
    // version 없음 = v1
    fiveHour: {
      completedWindows: 9,
      buckets: Array.from({ length: 101 }, () => ({ mean: 0.9, count: 9 })),
      history: [{ modelErrorPct: 1, naiveErrorPct: 2 }],
    },
    weekly: { completedWindows: 9, buckets: Array.from({ length: 101 }, () => ({ mean: 0.9, count: 9 })), history: [] },
  };
  fs.writeFileSync(MODEL_PATH, JSON.stringify(stale));

  delete require.cache[require.resolve(MODEL_SRC)];
  const m = require(MODEL_SRC);

  assert.strictEqual(m.predictFinalCost('weekly', 0.5, 10), null, 'v1 학습은 폐기되어 예측 불가');
  assert.strictEqual(m.getAccuracyStats('fiveHour'), null, 'v1 정확도 로그도 폐기');
});

test('주간 격자 위상 판정 - 주 단위 이동은 무시, 분 단위 흔들림은 허용, 하루 차이는 재학습', () => {
  const m = freshModel();
  const W = WEEK * 1000;
  const TOL = 60 * 60 * 1000;
  const base = 1_800_000_000_000;
  const phase = (ms) => m.windowPhaseOf(ms, W);

  assert.strictEqual(m.windowPhaseOf(null, W), null);
  assert.strictEqual(phase(base), phase(base + 5 * W), '몇 주가 밀려도 위상은 같다');
  assert.ok(m.isSameWindowPhase(phase(base), phase(base + 5 * W), W, TOL));
  assert.ok(m.isSameWindowPhase(phase(base), phase(base + 10 * 60_000), W, TOL), '10분 흔들림은 같은 격자');
  assert.ok(m.isSameWindowPhase(phase(base), phase(base - 10 * 60_000), W, TOL), '0과 7일이 맞닿은 경계도 처리');
  assert.ok(!m.isSameWindowPhase(phase(base), phase(base + 86_400_000), W, TOL), '하루 차이는 다른 격자');
  assert.strictEqual(m.isSameWindowPhase(undefined, 123, W, TOL), false, '기록이 없으면 다른 것으로 취급');
});

test('resetKind는 해당 한도의 학습만 폐기한다', () => {
  const m = freshModel();
  const anchor = NOW + 100_000;
  m.backfillFromEvents('weekly', WEEK, [{ ts: anchor - 2 * WEEK + WEEK * 0.5, cost: 100 }], NOW, anchor);
  m.backfillFromEvents('fiveHour', FIVE_H, [{ ts: NOW - 3 * FIVE_H, cost: 10 }], NOW);
  assert.ok(readState().weekly.completedWindows > 0);

  m.resetKind('weekly');

  const s = readState();
  assert.strictEqual(s.weekly.completedWindows, 0);
  assert.strictEqual(s.weekly.buckets[50].count, 0);
  assert.ok(s.fiveHour.completedWindows > 0, '5시간 학습은 보존');
});

test('유휴시간이 길면 구간이 끝난 것으로 보고 예측을 현재값으로 당긴다', () => {
  const m = freshModel();
  const ev = [];
  for (let k = 4; k >= 2; k--) {
    const s = NOW - k * FIVE_H;
    ev.push({ ts: s, cost: 60 }, { ts: s + FIVE_H * 0.3, cost: 40 }); // 전반에 몰아 쓰는 패턴
  }
  m.backfillFromEvents('fiveHour', FIVE_H, ev, NOW);

  const base = m.predictFinalCost('fiveHour', 0.5, 50); // 유휴 정보 없음
  assert.ok(base > 50, '곡선 예측은 현재 비용보다 크다');
  assert.strictEqual(m.predictFinalCost('fiveHour', 0.5, 50, 0), base, '유휴 0이면 기존 동작과 동일');
  assert.strictEqual(m.predictFinalCost('fiveHour', 0.5, 50, 30 * 60), base, '30분까지는 완전 활동 취급');
  assert.strictEqual(m.predictFinalCost('fiveHour', 0.5, 50, 3 * 3600), 50, '2시간 이상이면 최종 = 현재');

  const mid = m.predictFinalCost('fiveHour', 0.5, 50, 75 * 60);
  assert.ok(Math.abs(mid - (50 + 0.5 * (base - 50))) < 1e-9, `75분은 선형 감쇠의 정확히 중간 (${mid})`);
});

test('주간 한도에는 유휴 보정을 적용하지 않는다', () => {
  const m = freshModel();
  const anchor = NOW + 100_000;
  m.backfillFromEvents('weekly', WEEK, [{ ts: anchor - 2 * WEEK + WEEK * 0.5, cost: 100 }], NOW, anchor);

  // 주 단위로 보정할 표본이 없으므로, 몇 시간 쉬었다고 주간 구간이 끝났다고 볼 수 없다.
  assert.strictEqual(m.predictFinalCost('weekly', 0.5, 50, 5 * 3600), m.predictFinalCost('weekly', 0.5, 50));
});

test('구간 초반에는 예측을 내보내지 않는다 (데드존)', () => {
  const m = freshModel();
  assert.strictEqual(m.isProjectionReliable(null), false, '경과율을 모르면 보류');
  assert.strictEqual(m.isProjectionReliable(NaN), false);
  assert.strictEqual(m.isProjectionReliable(0), false);
  assert.strictEqual(m.isProjectionReliable(0.24), false, '구간 1/4 이전은 보류');
  assert.strictEqual(m.isProjectionReliable(0.25), true);
  assert.strictEqual(m.isProjectionReliable(0.9), true);
});

test('최근 검증에서 모델이 지고 있으면 신뢰도를 낮춰 단순 예측 쪽으로 물러선다', () => {
  const m = freshModel();
  const ev = [];
  for (let k = 6; k >= 2; k--) {
    const s = NOW - k * FIVE_H;
    ev.push({ ts: s, cost: 60 }, { ts: s + FIVE_H * 0.3, cost: 40 });
  }
  m.backfillFromEvents('fiveHour', FIVE_H, ev, NOW);

  // history를 직접 심어서 페널티 조건만 바꿔 가며 예측을 비교한다.
  const predictWith = (history) => {
    const st = readState();
    st.fiveHour.history = history;
    fs.writeFileSync(MODEL_PATH, JSON.stringify(st));
    delete require.cache[require.resolve(MODEL_SRC)];
    return require(MODEL_SRC).predictFinalCost('fiveHour', 0.5, 50, 0);
  };
  const entry = (model, naive) => ({ modelErrorPct: model, naiveErrorPct: naive });
  const naivePrediction = 50 / 0.5;

  const winning = predictWith(Array.from({ length: 5 }, () => entry(5, 80)));
  const losing = predictWith(Array.from({ length: 5 }, () => entry(90, 10)));
  const mixed = predictWith([entry(90, 10), entry(90, 10), entry(5, 80), entry(5, 80), entry(5, 80)]);
  const thin = predictWith([entry(90, 10), entry(90, 10)]);

  assert.ok(
    Math.abs(losing - naivePrediction) < Math.abs(winning - naivePrediction),
    `지고 있을 때 단순 예측 쪽으로 물러서야 한다 (이길 때 ${winning.toFixed(1)}, 질 때 ${losing.toFixed(1)}, 단순 ${naivePrediction})`
  );
  assert.strictEqual(mixed, winning, '5회 중 2회만 졌으면 페널티 없음');
  assert.strictEqual(thin, winning, '표본 3개 미만이면 판단하지 않음');
});

// ---------------------------------------------------------------------------

let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
  }
}

console.log(`\n${tests.length - failed}/${tests.length} 통과`);
process.exit(failed === 0 ? 0 : 1);
